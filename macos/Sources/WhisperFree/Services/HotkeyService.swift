import AppKit
import Carbon.HIToolbox
import os
import SwiftUI

let hotkeyLog = Logger(subsystem: "io.github.whisperfree", category: "hotkey")

// MARK: - Auslöser

/// Was das Diktat auslöst: eine Tastenkombination, eine einzelne Modifier-Taste (Fn, rechte ⌥ …)
/// oder eine Maustaste (Mitte, Seitentasten …).
enum Trigger: Codable, Equatable {
    case keys(keyCode: Int64, modifiers: UInt64, name: String)
    case modifier(keyCode: Int64)
    case mouse(button: Int64)

    static let `default` = Trigger.keys(keyCode: Int64(kVK_Space), modifiers: CGEventFlags.maskAlternate.rawValue, name: "Space")

    static let relevantFlags: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl]

    var display: String {
        switch self {
        case .keys(_, let modifiers, let name):
            let flags = CGEventFlags(rawValue: modifiers)
            var s = ""
            if flags.contains(.maskControl) { s += "⌃" }
            if flags.contains(.maskAlternate) { s += "⌥" }
            if flags.contains(.maskShift) { s += "⇧" }
            if flags.contains(.maskCommand) { s += "⌘" }
            return s + name
        case .modifier(let keyCode):
            return ModifierKey(keyCode: keyCode)?.title ?? "Taste \(keyCode)"
        case .mouse(let button):
            switch button {
            case 2: return "Maustaste 3 (Mitte)"
            case 3: return "Maustaste 4 (Zurück)"
            case 4: return "Maustaste 5 (Vor)"
            default: return "Maustaste \(button + 1)"
            }
        }
    }

    /// Carbon-Fallback ohne Bedienungshilfen (nur Tastenkombinationen).
    var carbon: (keyCode: UInt32, modifiers: UInt32)? {
        guard case .keys(let keyCode, let modifiers, _) = self else { return nil }
        let flags = CGEventFlags(rawValue: modifiers)
        var carbon: UInt32 = 0
        if flags.contains(.maskCommand) { carbon |= UInt32(cmdKey) }
        if flags.contains(.maskShift) { carbon |= UInt32(shiftKey) }
        if flags.contains(.maskAlternate) { carbon |= UInt32(optionKey) }
        if flags.contains(.maskControl) { carbon |= UInt32(controlKey) }
        return (UInt32(keyCode), carbon)
    }
}

/// Einzelne Modifier-Tasten mit seitengenauen Gerätemasken (links/rechts unterscheidbar).
struct ModifierKey {
    let keyCode: Int64
    let title: String
    let deviceMask: UInt64

    init?(keyCode: Int64) {
        let table: [Int: (String, UInt64)] = [
            kVK_Function: ("Fn / 🌐", CGEventFlags.maskSecondaryFn.rawValue),
            kVK_RightOption: ("Rechte ⌥ Wahltaste", 0x40),
            kVK_Option: ("Linke ⌥ Wahltaste", 0x20),
            kVK_RightCommand: ("Rechte ⌘ Befehlstaste", 0x10),
            kVK_Command: ("Linke ⌘ Befehlstaste", 0x08),
            kVK_RightControl: ("Rechte ⌃ Control", 0x2000),
            kVK_Control: ("Linke ⌃ Control", 0x01),
            kVK_RightShift: ("Rechte ⇧ Umschalt", 0x04),
            kVK_Shift: ("Linke ⇧ Umschalt", 0x02),
        ]
        guard let (title, mask) = table[Int(keyCode)] else { return nil }
        self.keyCode = keyCode
        self.title = title
        self.deviceMask = mask
    }

    func isDown(_ flags: CGEventFlags) -> Bool { flags.rawValue & deviceMask != 0 }
}

enum KeyNames {
    static let special: [Int: String] = {
        var map: [Int: String] = [
            kVK_Space: "Space", kVK_Return: "↩", kVK_Tab: "⇥", kVK_Delete: "⌫", kVK_ForwardDelete: "⌦",
            kVK_LeftArrow: "←", kVK_RightArrow: "→", kVK_UpArrow: "↑", kVK_DownArrow: "↓",
            kVK_Home: "↖", kVK_End: "↘", kVK_PageUp: "⇞", kVK_PageDown: "⇟", kVK_Escape: "⎋",
        ]
        for (i, key) in functionKeys.enumerated() { map[key] = "F\(i + 1)" }
        return map
    }()

    static let functionKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                               kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]

    /// Name der Taste im aktuellen Layout ohne Modifier (⌥L zeigt "L", nicht "@").
    static func name(for keyCode: Int64) -> String {
        if let special = special[Int(keyCode)] { return special }
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return "#\(keyCode)" }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        var deadKeys: UInt32 = 0
        var chars = [UniChar](repeating: 0, count: 4)
        var length = 0
        let status = data.withUnsafeBytes { buffer -> OSStatus in
            UCKeyTranslate(buffer.bindMemory(to: UCKeyboardLayout.self).baseAddress, UInt16(keyCode),
                           UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                           OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, chars.count, &length, &chars)
        }
        guard status == noErr, length > 0 else { return "#\(keyCode)" }
        return String(utf16CodeUnits: chars, count: length).uppercased()
    }
}

// MARK: - Service

/// Systemweite Auslöser über einen CGEvent-Tap (braucht Bedienungshilfen). Der Tap fängt auch das
/// Aufnehmen eines neuen Kürzels ab – unabhängig davon, welches Fenster gerade den Fokus hat.
/// Ohne Berechtigung bleibt für Tastenkombinationen ein Carbon-Hotkey als Fallback.
@MainActor
final class HotkeyService: ObservableObject {
    static let shared = HotkeyService()

    @Published private(set) var trigger: Trigger?
    @Published private(set) var isRecording = false
    @Published private(set) var tapActive = false
    @Published var recordingHint: String?

    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?
    /// Eine andere Taste wurde gedrückt, während die Modifier-Taste gehalten wurde (z. B. ⌥E für €).
    var onInterrupt: (() -> Void)?

    private let storageKey = "trigger"
    private var eventTap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var retryTimer: Timer?

    private var carbonRef: EventHotKeyRef?
    private var carbonHandlerInstalled = false

    // Laufzeitzustand des Tap-Handlers
    fileprivate var triggerHeld = false
    fileprivate var pendingModifier: Int64?

    private init() {
        if let data = UserDefaults.standard.data(forKey: storageKey) {
            trigger = try? JSONDecoder().decode(Trigger?.self, from: data)
        } else {
            trigger = .default
        }
    }

    func start() {
        installCarbonHandler()
        activate()
    }

    func set(_ newValue: Trigger?) {
        trigger = newValue
        triggerHeld = false
        UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: storageKey)
        hotkeyLog.info("Auslöser gesetzt: \(newValue?.display ?? "keiner", privacy: .public)")
        updateFallbacks()
        if case .modifier = newValue, !tapActive { Permissions.promptAccessibility() }
    }

    // MARK: Aufnehmen

    func beginRecording() {
        guard !isRecording else { return }
        recordingHint = nil
        pendingModifier = nil
        isRecording = true
        unregisterCarbon()
        if !tapActive { installLocalRecorder() }
        hotkeyLog.info("Aufnahme des Auslösers gestartet (Tap aktiv: \(self.tapActive))")
    }

    func endRecording() {
        guard isRecording else { return }
        isRecording = false
        removeLocalRecorder()
        updateFallbacks()
    }

    /// Gemeinsame Logik für Tap und lokalen Monitor. Gibt true zurück, wenn das Event geschluckt werden soll.
    fileprivate func record(type: CGEventType, keyCode: Int64, flags: CGEventFlags, button: Int64) -> Bool {
        let modifiers = flags.intersection(Trigger.relevantFlags)
        switch type {
        case .keyDown:
            pendingModifier = nil
            if modifiers.isEmpty, keyCode == Int64(kVK_Escape) {
                endRecording()
            } else if modifiers.isEmpty, keyCode == Int64(kVK_Delete) || keyCode == Int64(kVK_ForwardDelete) {
                set(nil)
                endRecording()
            } else if modifiers.isEmpty, !KeyNames.functionKeys.contains(Int(keyCode)) {
                // Eine einzelne Buchstabentaste würde global das Tippen blockieren.
                recordingHint = "Einzelne Tasten bitte mit ⌘ ⌥ ⌃ oder ⇧ kombinieren (F-Tasten gehen auch allein)."
                NSSound.beep()
            } else {
                set(.keys(keyCode: keyCode, modifiers: modifiers.rawValue, name: KeyNames.name(for: keyCode)))
                endRecording()
            }
            return true

        case .flagsChanged:
            guard let modifier = ModifierKey(keyCode: keyCode) else { return false }
            if modifier.isDown(flags) {
                pendingModifier = keyCode
            } else if pendingModifier == keyCode {
                // Modifier allein gedrückt und wieder losgelassen → als Einzeltaste übernehmen.
                set(.modifier(keyCode: keyCode))
                endRecording()
            }
            return false

        case .otherMouseDown:
            set(.mouse(button: button))
            endRecording()
            return true

        default:
            return false
        }
    }

    // MARK: Tap

    private func activate() {
        if createTap() { return }
        updateFallbacks()
        // Ohne Bedienungshilfen schlägt der Tap fehl – regelmäßig neu versuchen,
        // damit es nach dem Erteilen der Berechtigung ohne Neustart funktioniert.
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            Task { @MainActor in
                let service = HotkeyService.shared
                if service.createTap() {
                    service.retryTimer?.invalidate()
                    service.retryTimer = nil
                }
            }
        }
    }

    private func createTap() -> Bool {
        guard eventTap == nil else { return true }
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .otherMouseDown, .otherMouseUp]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: { _, type, event, _ in HotkeyService.handleTap(type: type, event: event) },
            userInfo: nil
        ) else {
            if tapActive || retryTimer == nil {
                hotkeyLog.notice("Event-Tap nicht verfügbar – Bedienungshilfen fehlen, nutze Carbon-Fallback")
            }
            tapActive = false
            return false
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        eventTap = tap
        tapSource = source
        tapActive = true
        unregisterCarbon()
        removeGlobalMouseMonitor()
        if isRecording { removeLocalRecorder() }
        hotkeyLog.notice("Event-Tap aktiv")
        return true
    }

    /// Läuft auf dem Main-Runloop (dort hängt die Tap-Quelle).
    private nonisolated static func handleTap(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        MainActor.assumeIsolated {
            let service = HotkeyService.shared
            let pass = Unmanaged.passUnretained(event)

            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let tap = service.eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
                return pass
            }

            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            let button = event.getIntegerValueField(.mouseEventButtonNumber)

            if service.isRecording {
                return service.record(type: type, keyCode: keyCode, flags: event.flags, button: button) ? nil : pass
            }
            guard let trigger = service.trigger else { return pass }

            switch (trigger, type) {
            case (.keys(let code, let modifiers, _), .keyDown) where keyCode == code:
                guard event.flags.intersection(Trigger.relevantFlags).rawValue == modifiers else { break }
                if event.getIntegerValueField(.keyboardEventAutorepeat) == 0, !service.triggerHeld {
                    service.triggerHeld = true
                    service.fire(down: true)
                }
                return nil

            case (.keys(let code, _, _), .keyUp) where keyCode == code && service.triggerHeld:
                service.triggerHeld = false
                service.fire(down: false)
                return nil

            case (.modifier(let code), .flagsChanged) where keyCode == code:
                guard let modifier = ModifierKey(keyCode: code) else { break }
                let down = modifier.isDown(event.flags)
                if down != service.triggerHeld {
                    service.triggerHeld = down
                    service.fire(down: down)
                }

            case (.modifier, .keyDown) where service.triggerHeld:
                DispatchQueue.main.async { service.onInterrupt?() }

            case (.mouse(let wanted), .otherMouseDown) where button == wanted:
                service.triggerHeld = true
                service.fire(down: true)
                return nil // schlucken, damit z. B. „Zurück“ im Browser nicht zusätzlich auslöst

            case (.mouse(let wanted), .otherMouseUp) where button == wanted:
                service.triggerHeld = false
                service.fire(down: false)
                return nil

            default:
                break
            }
            return pass
        }
    }

    private func fire(down: Bool) {
        hotkeyLog.info("Auslöser \(down ? "gedrückt" : "losgelassen", privacy: .public)")
        DispatchQueue.main.async { down ? self.onPress?() : self.onRelease?() }
    }

    // MARK: Lokaler Recorder (ohne Tap)

    private var localMonitor: Any?

    private func installLocalRecorder() {
        guard localMonitor == nil else { return }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged, .otherMouseDown]) { event in
            let service = HotkeyService.shared
            guard service.isRecording, let cg = event.cgEvent else { return event }
            let type: CGEventType = switch event.type {
            case .keyDown: .keyDown
            case .flagsChanged: .flagsChanged
            default: .otherMouseDown
            }
            // keyCode darf bei Maus-Events nicht abgefragt werden (wirft eine Exception).
            let isMouse = event.type == .otherMouseDown
            let swallow = service.record(type: type, keyCode: isMouse ? -1 : Int64(event.keyCode),
                                         flags: cg.flags, button: isMouse ? Int64(event.buttonNumber) : -1)
            return swallow ? nil : event
        }
    }

    private func removeLocalRecorder() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        localMonitor = nil
    }

    // MARK: Maus-Fallback (ohne Tap)

    private var globalMouseMonitor: Any?

    /// Globale Monitore für Maus-Events brauchen keine Bedienungshilfen, können das Event aber
    /// nicht schlucken – die Taste löst also zusätzlich ihre normale Funktion aus.
    private func installGlobalMouseMonitor() {
        guard globalMouseMonitor == nil else { return }
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.otherMouseDown, .otherMouseUp]) { event in
            let service = HotkeyService.shared
            guard case .mouse(let wanted) = service.trigger, Int64(event.buttonNumber) == wanted else { return }
            let down = event.type == .otherMouseDown
            guard down != service.triggerHeld else { return }
            service.triggerHeld = down
            service.fire(down: down)
        }
        hotkeyLog.notice("Maus-Fallback aktiv (ohne Bedienungshilfen)")
    }

    private func removeGlobalMouseMonitor() {
        if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
        globalMouseMonitor = nil
    }

    // MARK: Carbon-Fallback

    private func updateFallbacks() {
        unregisterCarbon()
        removeGlobalMouseMonitor()
        guard !tapActive, !isRecording else { return }
        if case .mouse = trigger { installGlobalMouseMonitor() }
        guard let carbon = trigger?.carbon else { return }
        let id = EventHotKeyID(signature: 0x57465245, id: 1) // "WFRE"
        let status = RegisterEventHotKey(carbon.keyCode, carbon.modifiers, id, GetEventDispatcherTarget(), 0, &carbonRef)
        hotkeyLog.notice("Carbon-Fallback registriert: \(status == noErr ? "ok" : "Fehler \(status)", privacy: .public)")
    }

    private func unregisterCarbon() {
        if let carbonRef { UnregisterEventHotKey(carbonRef) }
        carbonRef = nil
    }

    private func installCarbonHandler() {
        guard !carbonHandlerInstalled else { return }
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let status = InstallEventHandler(GetEventDispatcherTarget(), { _, event, _ in
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            DispatchQueue.main.async { HotkeyService.shared.fire(down: pressed) }
            return noErr
        }, types.count, &types, nil, nil)
        carbonHandlerInstalled = status == noErr
    }
}

// MARK: - Recorder-UI

/// Klick → nächste Taste, Tastenkombination, Fn/Modifier oder Maustaste wird übernommen.
/// Esc bricht ab, ⌫ entfernt den Auslöser.
struct HotkeyRecorder: View {
    @ObservedObject private var service = HotkeyService.shared

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 6) {
                Button {
                    service.isRecording ? service.endRecording() : service.beginRecording()
                } label: {
                    Text(service.isRecording ? "Taste oder Maustaste drücken …" : (service.trigger?.display ?? "Kein Auslöser"))
                        .font(.system(size: 12, weight: .medium).monospaced())
                        .frame(minWidth: 170)
                }
                .tint(service.isRecording ? .accentColor : nil)
                .buttonStyle(.bordered)
                .focusable(false)
                .help("Klicken, dann Kombination (z. B. ⌥Space), Einzeltaste (Fn, rechte ⌥) oder Maustaste drücken. Esc bricht ab, ⌫ entfernt.")
            }
            if let hint = service.recordingHint, service.isRecording {
                Text(hint).font(.caption).foregroundStyle(.orange)
            } else if !service.tapActive {
                Text(Self.missingPermissionHint(for: service.trigger))
                    .font(.caption).foregroundStyle(.orange)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Bedienungshilfen erlauben …") {
                    Permissions.promptAccessibility()
                    Permissions.openAccessibilitySettings()
                }
                .controlSize(.small)
            } else if case .modifier(let code) = service.trigger, code == Int64(kVK_Function) {
                Text("Tipp: Tastatur-Einstellungen → „🌐-Taste drücken für“ → „Keine Aktion“.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .onDisappear { service.endRecording() }
    }

    private static func missingPermissionHint(for trigger: Trigger?) -> String {
        switch trigger {
        case .modifier: "Einzeltasten wie Fn funktionieren erst mit Bedienungshilfen-Berechtigung."
        case .mouse: "Funktioniert, aber die Maustaste löst zusätzlich ihre normale Aktion aus. Mit Bedienungshilfen wird sie abgefangen."
        default: "Ohne Bedienungshilfen: kein automatisches Einfügen, keine Einzeltasten/Maustasten-Abfangen."
        }
    }
}

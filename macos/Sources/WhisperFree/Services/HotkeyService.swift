import AppKit
import Carbon.HIToolbox
import os
import SwiftUI

let hotkeyLog = Logger(subsystem: "io.github.whisperfree", category: "hotkey")

// MARK: - Triggers

/// What triggers dictation: a keyboard shortcut, individual modifier key (Fn, right ⌥, etc.),
/// or a mouse button (middle, side buttons, etc.).
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
            return ModifierKey(keyCode: keyCode)?.title ?? "Key \(keyCode)"
        case .mouse(let button):
            switch button {
            case 2: return "Mouse button 3 (Middle)"
            case 3: return "Mouse button 4 (Back)"
            case 4: return "Mouse button 5 (Forward)"
            default: return "Mouse button \(button + 1)"
            }
        }
    }

    /// Carbon fallback without Accessibility access (keyboard shortcuts only).
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

/// Individual modifier keys with device masks that distinguish left and right.
struct ModifierKey {
    let keyCode: Int64
    let title: String
    let deviceMask: UInt64

    init?(keyCode: Int64) {
        let table: [Int: (String, UInt64)] = [
            kVK_Function: ("Fn / 🌐", CGEventFlags.maskSecondaryFn.rawValue),
            kVK_RightOption: ("Right ⌥ Option", 0x40),
            kVK_Option: ("Left ⌥ Option", 0x20),
            kVK_RightCommand: ("Right ⌘ Command", 0x10),
            kVK_Command: ("Left ⌘ Command", 0x08),
            kVK_RightControl: ("Right ⌃ Control", 0x2000),
            kVK_Control: ("Left ⌃ Control", 0x01),
            kVK_RightShift: ("Right ⇧ Shift", 0x04),
            kVK_Shift: ("Left ⇧ Shift", 0x02),
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

    /// Key name in the current layout without modifiers (⌥L shows "L", not "@" on a German layout).
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

/// System-wide triggers through a CGEvent tap (requires Accessibility access). The tap also
/// captures new shortcuts regardless of which window currently has focus.
/// Without permission, keyboard combinations use a Carbon hotkey fallback.
@MainActor
final class HotkeyService: ObservableObject {
    static let shared = HotkeyService()

    @Published private(set) var trigger: Trigger?
    @Published private(set) var isRecording = false
    @Published private(set) var tapActive = false
    @Published var recordingHint: String?

    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?
    /// Another key was pressed while holding the modifier (e.g. ⌥E for € on a German layout).
    var onInterrupt: (() -> Void)?

    private let storageKey = "trigger"
    private var eventTap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var retryTimer: Timer?

    private var carbonRef: EventHotKeyRef?
    private var carbonHandlerInstalled = false

    // Runtime state of the tap handler
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
        hotkeyLog.info("Trigger set: \(newValue?.display ?? "none", privacy: .public)")
        updateFallbacks()
        if case .modifier = newValue, !tapActive { Permissions.promptAccessibility() }
    }

    // MARK: Capture

    func beginRecording() {
        guard !isRecording else { return }
        recordingHint = nil
        pendingModifier = nil
        isRecording = true
        unregisterCarbon()
        if !tapActive { installLocalRecorder() }
        hotkeyLog.info("Trigger capture started (tap active: \(self.tapActive))")
    }

    func endRecording() {
        guard isRecording else { return }
        isRecording = false
        removeLocalRecorder()
        updateFallbacks()
    }

    /// Shared tap and local monitor logic. Returns true when the event should be consumed.
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
                // A single letter key would block typing system-wide.
                recordingHint = "Combine letter keys with ⌘ ⌥ ⌃ or ⇧. Function keys can be used on their own."
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
                // A modifier pressed and released on its own becomes a single-key trigger.
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
        // Without Accessibility access the tap fails; retry periodically
        // so granting permission takes effect without restarting.
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
                hotkeyLog.notice("Event tap unavailable: no Accessibility access; using Carbon fallback")
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
        hotkeyLog.notice("Event tap active")
        return true
    }

    /// Runs on the main run loop, where the tap source is installed.
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
                return nil // consume to avoid also triggering the button's normal action, such as browser Back

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
        hotkeyLog.info("Trigger \(down ? "pressed" : "released", privacy: .public)")
        DispatchQueue.main.async { down ? self.onPress?() : self.onRelease?() }
    }

    // MARK: Local recorder (without tap)

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
            // Do not read keyCode for mouse events; it throws an exception.
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

    // MARK: Mouse fallback (without tap)

    private var globalMouseMonitor: Any?

    /// Global mouse event monitors do not require Accessibility access, but cannot consume
    /// events, so the button also performs its normal action.
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
        hotkeyLog.notice("Mouse fallback active (without Accessibility access)")
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
        hotkeyLog.notice("Carbon fallback registered: \(status == noErr ? "ok" : "Error \(status)", privacy: .public)")
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

// MARK: - Recorder UI

/// Click to capture the next key, shortcut, Fn/modifier, or mouse button.
/// Esc cancels; ⌫ clears the trigger.
struct HotkeyRecorder: View {
    @ObservedObject private var service = HotkeyService.shared

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 6) {
                Button {
                    service.isRecording ? service.endRecording() : service.beginRecording()
                } label: {
                    Text(service.isRecording ? "Press a key or mouse button …" : (service.trigger?.display ?? "No trigger"))
                        .font(.system(size: 12, weight: .medium).monospaced())
                        .frame(minWidth: 170)
                }
                .tint(service.isRecording ? .accentColor : nil)
                .buttonStyle(.bordered)
                .focusable(false)
                .help("Click, then press a shortcut (e.g. ⌥Space), modifier key (Fn, right ⌥), or mouse button. Esc cancels; ⌫ clears.")
            }
            if let hint = service.recordingHint, service.isRecording {
                Text(hint).font(.caption).foregroundStyle(.orange)
            } else if !service.tapActive {
                Text(Self.missingPermissionHint(for: service.trigger))
                    .font(.caption).foregroundStyle(.orange)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Allow Accessibility access …") {
                    Permissions.promptAccessibility()
                    Permissions.openAccessibilitySettings()
                }
                .controlSize(.small)
            } else if case .modifier(let code) = service.trigger, code == Int64(kVK_Function) {
                Text("Tip: Keyboard settings → “Press 🌐 key to” → “Do Nothing”.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .onDisappear { service.endRecording() }
    }

    private static func missingPermissionHint(for trigger: Trigger?) -> String {
        switch trigger {
        case .modifier: "Single modifier keys such as Fn require Accessibility access."
        case .mouse: "Works, but the mouse button also performs its normal action. Accessibility access allows the app to capture it."
        default: "Without Accessibility access: no automatic pasting, individual modifier keys, or mouse button capture."
        }
    }
}

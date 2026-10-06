import AppKit
import Carbon.HIToolbox

enum DeliveryResult {
    case pasted
    case copied
    case opened(String)
    case failed(String)
}

/// Inserts text at the cursor by setting the clipboard and simulating ⌘V.
/// Works across browsers, Electron apps, terminals, and IDEs, unlike setting
/// kAXValueAttribute directly, which many controls do not support.
@MainActor
enum TextInjector {
    static func deliver(_ text: String, mode: OutputMode, restoreClipboard: Bool) async -> DeliveryResult {
        if mode == .editor { return await openInEditor(text) }
        let pasteboard = NSPasteboard.general
        let canPaste = mode == .paste && Permissions.accessibilityGranted
        let previous = (canPaste && restoreClipboard) ? snapshot(pasteboard) : nil

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        guard canPaste else { return .copied }

        let ourChange = pasteboard.changeCount
        try? await Task.sleep(nanoseconds: 40_000_000)
        sendPasteShortcut()

        if let previous {
            // Give the target app time to read, then restore the previous contents,
            // but only if nothing else has been copied in the meantime.
            try? await Task.sleep(nanoseconds: 500_000_000)
            if pasteboard.changeCount == ourChange {
                pasteboard.clearContents()
                if !previous.isEmpty { pasteboard.writeObjects(previous) }
            }
        }
        return .pasted
    }

    static var transcriptsDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        // Keep existing transcript folders accessible; use English names for new installations.
        let legacy = base.appendingPathComponent("WhisperFree/Diktate", isDirectory: true)
        let dir = FileManager.default.fileExists(atPath: legacy.path)
            ? legacy : base.appendingPathComponent("WhisperFree/Transcripts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var editorURL: URL {
        let path = UserDefaults.standard.string(forKey: Prefs.editorAppPath) ?? "/System/Applications/TextEdit.app"
        return URL(fileURLWithPath: path)
    }

    static func appName(at url: URL) -> String {
        FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    }

    /// Writes the dictation to a text file and opens it in the chosen editor.
    private static func openInEditor(_ text: String) async -> DeliveryResult {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH.mm.ss"
        let file = transcriptsDirectory.appendingPathComponent("Dictation \(formatter.string(from: Date())).txt")
        do {
            try text.write(to: file, atomically: true, encoding: .utf8)
            let app = editorURL
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            _ = try await NSWorkspace.shared.open([file], withApplicationAt: app, configuration: configuration)
            return .opened(appName(at: app))
        } catch {
            return .failed("Could not open editor")
        }
    }

    private static func sendPasteShortcut() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let key = CGKeyCode(kVK_ANSI_V)
        let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    private static func snapshot(_ pasteboard: NSPasteboard) -> [NSPasteboardItem] {
        (pasteboard.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
    }
}

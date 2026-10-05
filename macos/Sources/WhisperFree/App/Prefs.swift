import Foundation

enum Prefs {
    static let language = "language"
    static let recordingMode = "recordingMode"
    static let selectedModel = "selectedModel"
    static let outputMode = "outputMode"
    static let editorAppPath = "editorAppPath"
    static let restoreClipboard = "restoreClipboard"
    static let showIdleOverlay = "showIdleOverlay"
    static let playSounds = "playSounds"
    static let vocabulary = "vocabulary"
    static let keepHistory = "keepHistory"
    static let history = "history"
    static let overlayOrigin = "overlayOrigin"
    static let setupShown = "setupShown"
    static let autoCheckUpdates = "autoCheckUpdates"

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [
            language: DictationLanguage.systemDefault,
            recordingMode: RecordingMode.toggle.rawValue,
            outputMode: OutputMode.paste.rawValue,
            editorAppPath: "/System/Applications/TextEdit.app",
            restoreClipboard: true,
            showIdleOverlay: false,
            playSounds: true,
            vocabulary: "",
            keepHistory: true,
            autoCheckUpdates: true,
        ])
    }
}

enum OutputMode: String, CaseIterable, Identifiable {
    case paste
    case clipboard
    case editor

    var id: String { rawValue }

    var title: String {
        switch self {
        case .paste: "Insert at the cursor"
        case .clipboard: "Copy to clipboard only"
        case .editor: "Open in a text editor"
        }
    }

    var detail: String {
        switch self {
        case .paste: "Text appears in the active text field. Requires Accessibility access."
        case .clipboard: "Paste with ⌘V yourself. No additional permission needed."
        case .editor: "Each dictation opens as a text file in your chosen app and is also copied to the clipboard."
        }
    }

    static var current: OutputMode {
        OutputMode(rawValue: UserDefaults.standard.string(forKey: Prefs.outputMode) ?? "") ?? .paste
    }
}

enum RecordingMode: String, CaseIterable, Identifiable {
    case toggle
    case hold

    var id: String { rawValue }

    var title: String {
        switch self {
        case .toggle: "Toggle: press once to start, again to stop"
        case .hold: "Hold to record (push-to-talk)"
        }
    }
}

struct DictationLanguage: Identifiable, Hashable {
    let id: String
    let title: String

    /// Use the system language if supported by Whisper; otherwise detect automatically.
    /// (Automatic detection can mistake short recordings for English.)
    static var systemDefault: String {
        let code = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? ""
        return all.contains { $0.id == code } ? code : "auto"
    }

    static let all: [DictationLanguage] = [
        .init(id: "auto", title: "Detect automatically"),
        .init(id: "de", title: "German"),
        .init(id: "en", title: "English"),
        .init(id: "fr", title: "French"),
        .init(id: "es", title: "Spanish"),
        .init(id: "it", title: "Italian"),
        .init(id: "pt", title: "Portuguese"),
        .init(id: "nl", title: "Dutch"),
        .init(id: "pl", title: "Polish"),
        .init(id: "tr", title: "Turkish"),
        .init(id: "ru", title: "Russian"),
        .init(id: "uk", title: "Ukrainian"),
        .init(id: "zh", title: "Chinese"),
        .init(id: "ja", title: "Japanese"),
        .init(id: "ko", title: "Korean"),
    ]
}

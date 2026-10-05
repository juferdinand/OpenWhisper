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
        case .paste: "An der Cursor-Position einfügen"
        case .clipboard: "Nur in die Zwischenablage kopieren"
        case .editor: "In einem Texteditor öffnen"
        }
    }

    var detail: String {
        switch self {
        case .paste: "Text erscheint direkt im aktiven Textfeld. Braucht die Bedienungshilfen-Berechtigung."
        case .clipboard: "Du fügst selbst mit ⌘V ein. Keine zusätzliche Berechtigung nötig."
        case .editor: "Jedes Diktat wird als Textdatei in der App deiner Wahl geöffnet (und zusätzlich kopiert)."
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
        case .toggle: "Umschalten – einmal drücken startet, nochmal drücken stoppt"
        case .hold: "Gedrückt halten (Push-to-Talk)"
        }
    }
}

struct DictationLanguage: Identifiable, Hashable {
    let id: String
    let title: String

    /// Systemsprache, falls Whisper sie kennt – sonst automatische Erkennung.
    /// (Auto-Erkennung irrt sich bei kurzen Aufnahmen gern Richtung Englisch.)
    static var systemDefault: String {
        let code = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? ""
        return all.contains { $0.id == code } ? code : "auto"
    }

    static let all: [DictationLanguage] = [
        .init(id: "auto", title: "Automatisch erkennen"),
        .init(id: "de", title: "Deutsch"),
        .init(id: "en", title: "Englisch"),
        .init(id: "fr", title: "Französisch"),
        .init(id: "es", title: "Spanisch"),
        .init(id: "it", title: "Italienisch"),
        .init(id: "pt", title: "Portugiesisch"),
        .init(id: "nl", title: "Niederländisch"),
        .init(id: "pl", title: "Polnisch"),
        .init(id: "tr", title: "Türkisch"),
        .init(id: "ru", title: "Russisch"),
        .init(id: "uk", title: "Ukrainisch"),
        .init(id: "zh", title: "Chinesisch"),
        .init(id: "ja", title: "Japanisch"),
        .init(id: "ko", title: "Koreanisch"),
    ]
}

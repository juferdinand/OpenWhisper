import SwiftUI

struct MenuContent: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject private var updates = UpdateService.shared
    @AppStorage(Prefs.uiLanguage) private var uiLanguage = "en"
    let openSettings: () -> Void

    var body: some View {
        Text(statusText).id(uiLanguage)

        Button(NativeStrings.text(state.phase == .recording ? "Stop recording" : "Start recording")) {
            state.toggle()
        }
        .disabled(state.phase == .transcribing || updates.isInstalling)

        if let trigger = HotkeyService.shared.trigger {
            Text(NativeStrings.text("Trigger: {trigger}", ["trigger": trigger.display]))
        }

        if !state.history.isEmpty {
            Divider()
            Menu(NativeStrings.text("Recent dictations")) {
                ForEach(Array(state.history.prefix(10).enumerated()), id: \.offset) { _, text in
                    Button(Self.preview(text)) { state.copyToClipboard(text) }
                }
                Divider()
                Button(NativeStrings.text("Clear history")) { state.clearHistory() }
            }
        }

        if let release = updates.availableRelease {
            Divider()
            Button(NativeStrings.text("Install update to {version}", ["version": release.version])) { updates.install() }
        }

        Divider()
        Button(NativeStrings.text("Settings …")) { openSettings() }
            .keyboardShortcut(",")
        Button(NativeStrings.text("Quit WhisperFree")) { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var statusText: String {
        switch state.phase {
        case .idle: NativeStrings.text(state.models.selectedModelPath == nil ? "No model installed" : "Ready")
        case .recording: NativeStrings.text("Recording …")
        case .transcribing: NativeStrings.text("Transcribing …")
        case .done: NativeStrings.text("Text is ready.")
        case .error(let message): NativeStrings.text("Error: {error}", ["error": NativeStrings.text(message)])
        }
    }

    private static func preview(_ text: String) -> String {
        text.count > 60 ? String(text.prefix(57)) + "…" : text
    }
}

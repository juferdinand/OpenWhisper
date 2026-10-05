import SwiftUI

struct MenuContent: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject private var updates = UpdateService.shared
    let openSettings: () -> Void

    var body: some View {
        Text(statusText)

        Button(state.phase == .recording ? "Stop recording" : "Start recording") {
            state.toggle()
        }
        .disabled(state.phase == .transcribing)

        if let trigger = HotkeyService.shared.trigger {
            Text("Trigger: \(trigger.display)")
        }

        if !state.history.isEmpty {
            Divider()
            Menu("Recent dictations") {
                ForEach(Array(state.history.prefix(10).enumerated()), id: \.offset) { _, text in
                    Button(Self.preview(text)) { state.copyToClipboard(text) }
                }
                Divider()
                Button("Clear history") { state.clearHistory() }
            }
        }

        if let release = updates.availableRelease {
            Divider()
            Button("Install update to \(release.version)") { updates.install() }
        }

        Divider()
        Button("Settings …") { openSettings() }
            .keyboardShortcut(",")
        Button("Quit WhisperFree") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var statusText: String {
        switch state.phase {
        case .idle: state.models.selectedModelPath == nil ? "No model installed" : "Ready"
        case .recording: "Recording …"
        case .transcribing: "Transcribing …"
        case .done(let message): message
        case .error(let message): "Error: \(message)"
        }
    }

    private static func preview(_ text: String) -> String {
        text.count > 60 ? String(text.prefix(57)) + "…" : text
    }
}

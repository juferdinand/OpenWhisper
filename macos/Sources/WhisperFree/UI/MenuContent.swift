import SwiftUI

struct MenuContent: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject private var updates = UpdateService.shared
    let openSettings: () -> Void

    var body: some View {
        Text(statusText)

        Button(state.phase == .recording ? "Aufnahme stoppen" : "Aufnahme starten") {
            state.toggle()
        }
        .disabled(state.phase == .transcribing)

        if let trigger = HotkeyService.shared.trigger {
            Text("Auslöser: \(trigger.display)")
        }

        if !state.history.isEmpty {
            Divider()
            Menu("Letzte Diktate") {
                ForEach(Array(state.history.prefix(10).enumerated()), id: \.offset) { _, text in
                    Button(Self.preview(text)) { state.copyToClipboard(text) }
                }
                Divider()
                Button("Verlauf löschen") { state.clearHistory() }
            }
        }

        if let release = updates.availableRelease {
            Divider()
            Button("Update auf \(release.version) installieren") { updates.install() }
        }

        Divider()
        Button("Einstellungen …") { openSettings() }
            .keyboardShortcut(",")
        Button("WhisperFree beenden") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }

    private var statusText: String {
        switch state.phase {
        case .idle: state.models.selectedModelPath == nil ? "Kein Modell installiert" : "Bereit"
        case .recording: "Nimmt auf …"
        case .transcribing: "Transkribiere …"
        case .done(let message): message
        case .error(let message): "Fehler: \(message)"
        }
    }

    private static func preview(_ text: String) -> String {
        text.count > 60 ? String(text.prefix(57)) + "…" : text
    }
}

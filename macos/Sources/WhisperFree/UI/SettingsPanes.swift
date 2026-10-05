import AVFoundation
import WhisperFreeCore
import SwiftUI

// MARK: - Einrichtung

struct SetupPane: View {
    @EnvironmentObject private var models: ModelManager
    @EnvironmentObject private var router: SettingsRouter
    @State private var micStatus = Permissions.microphone
    @State private var accessibility = Permissions.accessibilityGranted
    @AppStorage(Prefs.language) private var language = DictationLanguage.systemDefault
    @AppStorage(Prefs.outputMode) private var outputMode = OutputMode.paste.rawValue

    private var accessibilityDetail: String {
        outputMode == OutputMode.paste.rawValue
            ? "Nötig, damit der Text automatisch an der Cursor-Position landet und Maustasten/Fn als Auslöser abgefangen werden."
            : "Optional – nur nötig, wenn Fn/Einzeltasten als Auslöser dienen oder Maustasten abgefangen werden sollen."
    }

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Form {
            Section {
                Text("WhisperFree wandelt deine Sprache direkt auf diesem Mac in Text um. Kein Konto, keine Cloud, kein Abo – deine Aufnahmen verlassen nie den Rechner.")
                    .foregroundStyle(.secondary)
            }

            Section("In sechs Schritten startklar") {
                step(1, "Sprachmodell laden", done: models.hasAnyModel,
                     detail: "Einmaliger Download, danach komplett offline. Empfehlung für deinen Mac: \(ModelManager.recommendations[0].model.title) (\(ModelManager.recommendations[0].model.size)).") {
                    Button("Modelle öffnen") { router.tab = .models }
                }

                step(2, "Mikrofon erlauben", done: micStatus == .authorized,
                     detail: "Wir brauchen Mikrofonzugriff, um deine Stimme aufzunehmen. Alles bleibt lokal auf deinem Mac.") {
                    if micStatus == .notDetermined {
                        Button("Erlauben") {
                            Task {
                                _ = await Permissions.requestMicrophone()
                                micStatus = Permissions.microphone
                            }
                        }
                    } else {
                        Button("Systemeinstellungen") { Permissions.openMicrophoneSettings() }
                    }
                }

                step(3, "Sprache wählen", done: language != "auto", alwaysShowAction: true,
                     detail: "In welcher Sprache diktierst du meistens? „Automatisch“ irrt sich bei kurzen Sätzen gern Richtung Englisch.") {
                    Picker("", selection: $language) {
                        ForEach(DictationLanguage.all) { Text($0.title).tag($0.id) }
                    }
                    .labelsHidden()
                    .frame(width: 190)
                }

                VStack(alignment: .leading, spacing: 8) {
                    step(4, "Wohin soll der Text?", done: true, alwaysShowAction: true,
                         detail: OutputMode(rawValue: outputMode)?.detail ?? "") { EmptyView() }
                    OutputSettings()
                        .padding(.leading, 40)
                }

                step(5, "Bedienungshilfen erlauben", done: accessibility,
                     detail: accessibilityDetail) {
                    Button("Erlauben") {
                        Permissions.promptAccessibility()
                        Permissions.openAccessibilitySettings()
                    }
                }

                step(6, "Auslöser festlegen & ausprobieren", done: false, alwaysShowAction: true,
                     detail: "Taste, Kombination oder Maustaste wählen. Dann Cursor in ein Textfeld setzen, auslösen, sprechen, nochmal auslösen.") {
                    HotkeyRecorder()
                }
            }
        }
        .formStyle(.grouped)
        .onReceive(timer) { _ in
            micStatus = Permissions.microphone
            accessibility = Permissions.accessibilityGranted
        }
    }

    private func step<Action: View>(_ number: Int, _ title: String, done: Bool, alwaysShowAction: Bool = false,
                                    detail: String, @ViewBuilder action: () -> Action) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: done ? "checkmark.circle.fill" : "\(number).circle")
                .font(.title2)
                .foregroundStyle(done ? .green : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if !done || alwaysShowAction { action() }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Allgemein

struct GeneralPane: View {
    @EnvironmentObject private var models: ModelManager
    @AppStorage(Prefs.recordingMode) private var mode = RecordingMode.toggle.rawValue
    @AppStorage(Prefs.language) private var language = DictationLanguage.systemDefault
    @AppStorage(Prefs.showIdleOverlay) private var showIdleOverlay = false
    @AppStorage(Prefs.playSounds) private var playSounds = true
    @AppStorage(Prefs.vocabulary) private var vocabulary = ""
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var launchError: String?

    var body: some View {
        Form {
            Section("Aufnahme") {
                LabeledContent("Auslöser") { HotkeyRecorder() }
                Picker("Verhalten", selection: $mode) {
                    ForEach(RecordingMode.allCases) { Text($0.title).tag($0.rawValue) }
                }
                Picker("Sprache", selection: $language) {
                    ForEach(DictationLanguage.all) { Text($0.title).tag($0.id) }
                }
                if models.selectedModel?.family == .parakeet {
                    Text("Das aktive Parakeet-Modell erkennt die Sprache automatisch – die Auswahl gilt nur für Whisper-Modelle.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Toggle("Start- und Stopp-Ton", isOn: $playSounds)
            }

            Section {
                TextField("Vokabular", text: $vocabulary, prompt: Text("z. B. Kubernetes, Jira, SwiftUI, Grafana"), axis: .vertical)
                    .lineLimit(2...4)
            } header: {
                Text("Eigene Begriffe")
            } footer: {
                Text("Namen und Fachbegriffe, kommagetrennt. Nach jeder Erkennung werden ähnlich geschriebene Wörter korrigiert (z. B. „Whisper Free“ → „WhisperFree“) – mit jedem Modell. Whisper-Modelle bekommen die Begriffe zusätzlich schon bei der Erkennung mit.")
            }

            Section("Ausgabe") {
                OutputSettings()
            }

            Section("Darstellung & System") {
                Toggle("Overlay auch im Ruhezustand anzeigen", isOn: $showIdleOverlay)
                Toggle("Beim Anmelden starten", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, enabled in
                        do {
                            try LaunchAtLogin.set(enabled)
                            launchError = nil
                        } catch {
                            launchError = error.localizedDescription
                            launchAtLogin = LaunchAtLogin.isEnabled
                        }
                    }
                if let launchError {
                    Text(launchError).font(.caption).foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Ausgabe

/// Auswahl Einfügen / Zwischenablage / Texteditor – im Onboarding und unter „Allgemein“.
struct OutputSettings: View {
    @AppStorage(Prefs.outputMode) private var outputMode = OutputMode.paste.rawValue
    @AppStorage(Prefs.restoreClipboard) private var restoreClipboard = true
    @AppStorage(Prefs.editorAppPath) private var editorAppPath = "/System/Applications/TextEdit.app"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Ausgabe", selection: $outputMode) {
                ForEach(OutputMode.allCases) { Text($0.title).tag($0.rawValue) }
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()

            switch OutputMode(rawValue: outputMode) ?? .paste {
            case .paste:
                Toggle("Vorherige Zwischenablage danach wiederherstellen", isOn: $restoreClipboard)
                    .padding(.leading, 20)
            case .clipboard:
                EmptyView()
            case .editor:
                HStack(spacing: 8) {
                    let url = URL(fileURLWithPath: editorAppPath)
                    Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                        .resizable().frame(width: 20, height: 20)
                    Text(TextInjector.appName(at: url))
                    Button("Anderen Editor wählen …") { chooseEditor() }
                    Button("Diktate-Ordner") {
                        NSWorkspace.shared.activateFileViewerSelecting([TextInjector.transcriptsDirectory])
                    }
                }
                .padding(.leading, 20)
            }
        }
    }

    private func chooseEditor() {
        let panel = NSOpenPanel()
        panel.title = "Texteditor wählen"
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            editorAppPath = url.path
        }
    }
}

// MARK: - Modelle

struct ModelsPane: View {
    @EnvironmentObject private var models: ModelManager
    @EnvironmentObject private var state: AppState

    var body: some View {
        Form {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Dein Mac: \(MacHardware.current.summary)").font(.headline)
                        Text("Die markierten Modelle passen am besten zu deiner Hardware und Sprache.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "desktopcomputer").font(.title2)
                }
            }

            Section {
                ForEach(ModelManager.catalog.filter { $0.family == .parakeet }) { row($0) }
            } header: {
                Text("NVIDIA Parakeet")
            } footer: {
                Text("25 europäische Sprachen (u. a. Deutsch, Englisch, Französisch, Spanisch, Italienisch, Polnisch, Niederländisch, Ukrainisch). Erkennt die Sprache selbst.")
            }

            Section {
                ForEach(ModelManager.catalog.filter { $0.family == .whisper }) { row($0) }
            } header: {
                Text("OpenAI Whisper")
            } footer: {
                Text("Rund 99 Sprachen inklusive Chinesisch, Japanisch, Koreanisch, Türkisch. Unterstützt feste Sprachwahl und eigenes Vokabular.")
            }

            if !models.importedModels.isEmpty {
                Section("Importiert") {
                    ForEach(models.importedModels) { row($0) }
                }
            }

            if let error = models.lastError {
                Section { Text(error).foregroundStyle(.red) }
            }

            Section {
                HStack {
                    Button("Eigenes Modell importieren …") { models.importModel() }
                    Button("Im Finder zeigen") { models.revealInFinder() }
                }
            } footer: {
                Text("Alle Modelle laufen komplett lokal über whisper.cpp (Metal). Download einmalig von Hugging Face. Eigene ggml-Dateien: Parakeet wird am Dateinamen („parakeet“) erkannt.")
            }
        }
        .formStyle(.grouped)
        .onChange(of: models.selectedID) { _, _ in state.modelSelectionChanged() }
        .onAppear { models.refresh() }
    }

    private func row(_ model: SpeechModel) -> some View {
        let highlight = ModelManager.recommendations.first { $0.model.id == model.id }?.reason
        let installed = models.installed.contains(model.id)
        let selected = models.selectedID == model.id && installed
        return HStack(spacing: 12) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(installed ? Color.accentColor : .secondary)
                .onTapGesture { if installed { models.selectedID = model.id } }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(model.title).font(.headline)
                    if let highlight {
                        Text("Empfohlen: \(highlight)").font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.accentColor.opacity(0.2)))
                    }
                }
                Text([model.size, model.note].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if let progress = models.progress[model.id] {
                ProgressView(value: progress).frame(width: 110)
                Button("Abbrechen") { models.cancelDownload(model) }
            } else if installed {
                if !selected {
                    Button("Verwenden") { models.selectedID = model.id }
                } else {
                    Text("Aktiv").font(.caption.bold()).foregroundStyle(.green)
                }
                Button(role: .destructive) { models.delete(model) } label: { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
                    .help("Löschen")
            } else if !model.repository.isEmpty {
                Button("Laden") { models.download(model) }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Snippets

struct SnippetsPane: View {
    @EnvironmentObject private var store: SnippetStore

    var body: some View {
        Form {
            Section {
                if store.snippets.isEmpty {
                    Text("Noch keine Snippets. Beispiel: Sagst du „mein YouTube Link“, wird stattdessen die URL eingefügt.")
                        .foregroundStyle(.secondary)
                }
                ForEach($store.snippets) { $snippet in
                    HStack(alignment: .top, spacing: 10) {
                        Toggle("", isOn: $snippet.enabled).labelsHidden()
                        TextField("Wenn ich sage …", text: $snippet.trigger)
                            .frame(width: 170)
                        Image(systemName: "arrow.right").foregroundStyle(.secondary).padding(.top, 4)
                        TextField("… füge ein", text: $snippet.expansion, axis: .vertical)
                            .lineLimit(1...5)
                        Button(role: .destructive) { store.remove(snippet.id) } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless)
                    }
                }
            } header: {
                Text("Snippets")
            } footer: {
                Text("Groß-/Kleinschreibung, Bindestriche und Satzzeichen am Ende spielen keine Rolle.")
            }

            Section {
                Button("Snippet hinzufügen") { store.add() }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Verlauf

struct HistoryPane: View {
    @EnvironmentObject private var state: AppState
    @AppStorage(Prefs.keepHistory) private var keepHistory = true

    var body: some View {
        Form {
            Section {
                Toggle("Letzte 20 Diktate lokal speichern", isOn: $keepHistory)
                    .onChange(of: keepHistory) { _, keep in if !keep { state.clearHistory() } }
            }
            Section("Letzte Diktate") {
                if state.history.isEmpty {
                    Text("Noch nichts diktiert.").foregroundStyle(.secondary)
                }
                ForEach(Array(state.history.enumerated()), id: \.offset) { _, text in
                    HStack(alignment: .top) {
                        Text(text).textSelection(.enabled)
                        Spacer()
                        Button { state.copyToClipboard(text) } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.borderless)
                            .help("Kopieren")
                    }
                }
            }
            if !state.history.isEmpty {
                Section { Button("Verlauf löschen", role: .destructive) { state.clearHistory() } }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Über

struct AboutPane: View {
    @ObservedObject private var updates = UpdateService.shared
    @AppStorage(Prefs.autoCheckUpdates) private var autoCheck = true

    var body: some View {
        Form {
            Section {
                HStack(spacing: 14) {
                    Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 64, height: 64)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("WhisperFree").font(.title.bold())
                        Text("Version \(updates.currentVersion)").foregroundStyle(.secondary)
                    }
                }
                Text("Diktieren in jede App – 100 % lokal, 100 % kostenlos, Open Source (MIT).")
                Text("Spracherkennung: whisper.cpp (MIT) mit den Whisper-Modellen von OpenAI (MIT).")
                    .font(.callout).foregroundStyle(.secondary)
            }

            Section {
                if updates.repository == nil {
                    Text("Updates sind in diesem Build nicht konfiguriert.").foregroundStyle(.secondary)
                } else {
                    Toggle("Automatisch nach Updates suchen (einmal täglich)", isOn: $autoCheck)
                    updateRow
                }
            } header: {
                Text("Updates")
            } footer: {
                Text("Fragt nur die öffentliche GitHub-Releases-Seite ab. Updates werden nur installiert, wenn sie mit demselben Zertifikat signiert sind.")
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private var updateRow: some View {
        switch updates.status {
        case .idle, .upToDate, .failed:
            HStack {
                Group {
                    if case .upToDate = updates.status {
                        Label("Du hast die neueste Version.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else if case .failed(let message) = updates.status {
                        Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    } else {
                        Text("Noch nicht geprüft.").foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button("Jetzt prüfen") { Task { await updates.check() } }
            }
        case .checking:
            HStack { ProgressView().controlSize(.small); Text("Suche nach Updates …") }
        case .available(let release):
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Version \(release.version) ist verfügbar", systemImage: "arrow.down.circle.fill")
                        .foregroundStyle(Color.accentColor)
                    Spacer()
                    Link("Details", destination: release.pageURL)
                    Button("Jetzt aktualisieren") { updates.install() }
                        .buttonStyle(.borderedProminent)
                }
                if !release.notes.isEmpty {
                    Text(release.notes).font(.callout).foregroundStyle(.secondary).lineLimit(8)
                }
            }
        case .downloading(let progress):
            HStack { Text("Lade Update …"); ProgressView(value: progress) }
        case .installing:
            HStack { ProgressView().controlSize(.small); Text("Installiere und starte neu …") }
        }
    }
}

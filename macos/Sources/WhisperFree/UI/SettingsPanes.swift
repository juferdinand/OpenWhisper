import AVFoundation
import WhisperFreeCore
import SwiftUI

// MARK: - Setup

struct SetupPane: View {
    @EnvironmentObject private var models: ModelManager
    @EnvironmentObject private var router: SettingsRouter
    @State private var micStatus = Permissions.microphone
    @State private var accessibility = Permissions.accessibilityGranted
    @AppStorage(Prefs.language) private var language = DictationLanguage.systemDefault
    @AppStorage(Prefs.outputMode) private var outputMode = OutputMode.paste.rawValue

    private var accessibilityDetail: String {
        outputMode == OutputMode.paste.rawValue
            ? "Required to insert text at the cursor automatically and capture mouse buttons or Fn as triggers."
            : "Optional: only needed for Fn or individual modifier keys as triggers, or to capture mouse buttons."
    }

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Form {
            Section {
                Text("WhisperFree turns speech into text directly on this Mac. No account, cloud, or subscription. Your recordings never leave your computer.")
                    .foregroundStyle(.secondary)
            }

            Section("Get started in six steps") {
                step(1, "Download a speech model", done: models.hasAnyModel,
                     detail: "Download once, then work offline. Recommended for your Mac: \(ModelManager.recommendations[0].model.title) (\(ModelManager.recommendations[0].model.size)).") {
                    Button("Open models") { router.tab = .models }
                }

                step(2, "Allow microphone access", done: micStatus == .authorized,
                     detail: "Microphone access is needed to record your voice. Everything stays on your Mac.") {
                    if micStatus == .notDetermined {
                        Button("Allow") {
                            Task {
                                _ = await Permissions.requestMicrophone()
                                micStatus = Permissions.microphone
                            }
                        }
                    } else {
                        Button("System Settings") { Permissions.openMicrophoneSettings() }
                    }
                }

                step(3, "Choose a language", done: language != "auto", alwaysShowAction: true,
                     detail: "Which language do you usually dictate in? Automatic detection can mistake short phrases for English.") {
                    Picker("", selection: $language) {
                        ForEach(DictationLanguage.all) { Text($0.title).tag($0.id) }
                    }
                    .labelsHidden()
                    .frame(width: 190)
                }

                VStack(alignment: .leading, spacing: 8) {
                    step(4, "Where should the text go?", done: true, alwaysShowAction: true,
                         detail: OutputMode(rawValue: outputMode)?.detail ?? "") { EmptyView() }
                    OutputSettings()
                        .padding(.leading, 40)
                }

                step(5, "Allow Accessibility access", done: accessibility,
                     detail: accessibilityDetail) {
                    Button("Allow") {
                        Permissions.promptAccessibility()
                        Permissions.openAccessibilitySettings()
                    }
                }

                step(6, "Set a trigger and try it", done: false, alwaysShowAction: true,
                     detail: "Choose a key, shortcut, or mouse button. Place the cursor in a text field, press the trigger, speak, then press it again.") {
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

// MARK: - General

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
            Section("Recording") {
                LabeledContent("Trigger") { HotkeyRecorder() }
                Picker("Mode", selection: $mode) {
                    ForEach(RecordingMode.allCases) { Text($0.title).tag($0.rawValue) }
                }
                Picker("Language", selection: $language) {
                    ForEach(DictationLanguage.all) { Text($0.title).tag($0.id) }
                }
                if models.selectedModel?.family == .parakeet {
                    Text("The active Parakeet model detects the language automatically. This selection only applies to Whisper models.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Toggle("Play start and stop sounds", isOn: $playSounds)
            }

            Section {
                TextField("Vocabulary", text: $vocabulary, prompt: Text("e.g. Kubernetes, Jira, SwiftUI, Grafana"), axis: .vertical)
                    .lineLimit(2...4)
            } header: {
                Text("Custom vocabulary")
            } footer: {
                Text("Names and technical terms, separated by commas. Similar spellings are corrected after recognition (e.g. “Whisper Free” → “WhisperFree”) with any model. Whisper models also receive these terms during recognition.")
            }

            Section("Output") {
                OutputSettings()
            }

            Section("Appearance & system") {
                Toggle("Show overlay when idle", isOn: $showIdleOverlay)
                Toggle("Launch at login", isOn: $launchAtLogin)
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

// MARK: - Output

/// Paste / clipboard / text editor selection in setup and General settings.
struct OutputSettings: View {
    @AppStorage(Prefs.outputMode) private var outputMode = OutputMode.paste.rawValue
    @AppStorage(Prefs.restoreClipboard) private var restoreClipboard = true
    @AppStorage(Prefs.editorAppPath) private var editorAppPath = "/System/Applications/TextEdit.app"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Output", selection: $outputMode) {
                ForEach(OutputMode.allCases) { Text($0.title).tag($0.rawValue) }
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()

            switch OutputMode(rawValue: outputMode) ?? .paste {
            case .paste:
                Toggle("Restore the previous clipboard afterward", isOn: $restoreClipboard)
                    .padding(.leading, 20)
            case .clipboard:
                EmptyView()
            case .editor:
                HStack(spacing: 8) {
                    let url = URL(fileURLWithPath: editorAppPath)
                    Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                        .resizable().frame(width: 20, height: 20)
                    Text(TextInjector.appName(at: url))
                    Button("Choose another editor …") { chooseEditor() }
                    Button("Transcripts folder") {
                        NSWorkspace.shared.activateFileViewerSelecting([TextInjector.transcriptsDirectory])
                    }
                }
                .padding(.leading, 20)
            }
        }
    }

    private func chooseEditor() {
        let panel = NSOpenPanel()
        panel.title = "Choose a text editor"
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url {
            editorAppPath = url.path
        }
    }
}

// MARK: - Models

struct ModelsPane: View {
    @EnvironmentObject private var models: ModelManager
    @EnvironmentObject private var state: AppState

    var body: some View {
        Form {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Your Mac: \(MacHardware.current.summary)").font(.headline)
                        Text("The highlighted models are recommended for your hardware and language.")
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
                Text("25 European languages, including German, English, French, Spanish, Italian, Polish, Dutch, and Ukrainian. Detects the language automatically.")
            }

            Section {
                ForEach(ModelManager.catalog.filter { $0.family == .whisper }) { row($0) }
            } header: {
                Text("OpenAI Whisper")
            } footer: {
                Text("About 99 languages, including Chinese, Japanese, Korean, and Turkish. Supports a fixed language and custom vocabulary.")
            }

            if !models.importedModels.isEmpty {
                Section("Imported") {
                    ForEach(models.importedModels) { row($0) }
                }
            }

            if let error = models.lastError {
                Section { Text(error).foregroundStyle(.red) }
            }

            Section {
                HStack {
                    Button("Import a model …") { models.importModel() }
                    Button("Show in Finder") { models.revealInFinder() }
                }
            } footer: {
                Text("All models run locally using whisper.cpp (Metal). Download once from Hugging Face. For imported ggml files, Parakeet is identified by “parakeet” in the filename.")
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
                        Text("Recommended: \(highlight)").font(.caption2.bold())
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
                Button("Cancel") { models.cancelDownload(model) }
            } else if installed {
                if !selected {
                    Button("Use") { models.selectedID = model.id }
                } else {
                    Text("Active").font(.caption.bold()).foregroundStyle(.green)
                }
                Button(role: .destructive) { models.delete(model) } label: { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
                    .help("Delete")
            } else if !model.repository.isEmpty {
                Button("Download") { models.download(model) }
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
                    Text("No snippets yet. For example, say “my YouTube link” to insert a URL instead.")
                        .foregroundStyle(.secondary)
                }
                ForEach($store.snippets) { $snippet in
                    HStack(alignment: .top, spacing: 10) {
                        Toggle("", isOn: $snippet.enabled).labelsHidden()
                        TextField("When I say …", text: $snippet.trigger)
                            .frame(width: 170)
                        Image(systemName: "arrow.right").foregroundStyle(.secondary).padding(.top, 4)
                        TextField("… insert", text: $snippet.expansion, axis: .vertical)
                            .lineLimit(1...5)
                        Button(role: .destructive) { store.remove(snippet.id) } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless)
                    }
                }
            } header: {
                Text("Snippets")
            } footer: {
                Text("Matching ignores letter case, hyphens, and trailing punctuation.")
            }

            Section {
                Button("Add snippet") { store.add() }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - History

struct HistoryPane: View {
    @EnvironmentObject private var state: AppState
    @AppStorage(Prefs.keepHistory) private var keepHistory = true

    var body: some View {
        Form {
            Section {
                Toggle("Save the last 20 dictations locally", isOn: $keepHistory)
                    .onChange(of: keepHistory) { _, keep in if !keep { state.clearHistory() } }
            }
            Section("Recent dictations") {
                if state.history.isEmpty {
                    Text("No dictations yet.").foregroundStyle(.secondary)
                }
                ForEach(Array(state.history.enumerated()), id: \.offset) { _, text in
                    HStack(alignment: .top) {
                        Text(text).textSelection(.enabled)
                        Spacer()
                        Button { state.copyToClipboard(text) } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.borderless)
                            .help("Copy")
                    }
                }
            }
            if !state.history.isEmpty {
                Section { Button("Clear history", role: .destructive) { state.clearHistory() } }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - About

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
                Text("Dictate into any app. Fully local, free, and open source (MIT).")
                Text("Speech recognition: whisper.cpp (MIT) with OpenAI Whisper and NVIDIA Parakeet models.")
                    .font(.callout).foregroundStyle(.secondary)
            }

            Section {
                if updates.repository == nil {
                    Text("Updates are not configured in this build.").foregroundStyle(.secondary)
                } else {
                    Toggle("Automatically check for updates (once a day)", isOn: $autoCheck)
                    updateRow
                }
            } header: {
                Text("Updates")
            } footer: {
                Text("Checks the public GitHub Releases endpoint. Updates are only installed if signed with the same certificate.")
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
                        Label("You have the latest version.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else if case .failed(let message) = updates.status {
                        Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    } else {
                        Text("Not checked yet.").foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button("Check now") { Task { await updates.check() } }
            }
        case .checking:
            HStack { ProgressView().controlSize(.small); Text("Checking for updates …") }
        case .available(let release):
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Label("Version \(release.version) is available", systemImage: "arrow.down.circle.fill")
                        .foregroundStyle(Color.accentColor)
                    Spacer()
                    Link("Details", destination: release.pageURL)
                    Button("Update now") { updates.install() }
                        .buttonStyle(.borderedProminent)
                }
                if !release.notes.isEmpty {
                    Text(release.notes).font(.callout).foregroundStyle(.secondary).lineLimit(8)
                }
            }
        case .downloading(let progress):
            HStack { Text("Downloading update …"); ProgressView(value: progress) }
        case .installing:
            HStack { ProgressView().controlSize(.small); Text("Installing and restarting …") }
        }
    }
}

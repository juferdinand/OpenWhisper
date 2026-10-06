import AppKit
import AVFoundation
import WebKit
import OpenWhisperCore

private final class SharedWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Hosts exactly the same compiled UI assets used by the Linux app.
/// Audio, input capture, output, model storage, and signature verification remain native.
@MainActor
final class SharedSettingsView: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    let webView: WKWebView
    private let root: URL
    private var timer: Timer?
    private var requestedTab: SettingsTab
    private var lastSnapshot: Data?
    private let isOverlay: Bool
    private var recoveringContent = false
    private var recentContentFailures: [Date] = []
    private var testing: Bool {
        CommandLine.arguments.contains("--ui-smoke-test") || CommandLine.arguments.contains("--overlay-smoke-test")
    }

    init(tab: SettingsTab, overlay: Bool = false) {
        isOverlay = overlay
        requestedTab = tab
        root = Bundle.main.resourceURL!.appendingPathComponent("WebUI", isDirectory: true)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if overlay {
            // WKWebView's macOS transparency setting, also used by Wry/Tauri.
            configuration.setValue(false, forKey: "drawsBackground")
            configuration.userContentController.addUserScript(WKUserScript(
                source: "window.__OPENWHISPER_OVERLAY__ = true;",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        webView = SharedWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "openwhisper")
        webView.navigationDelegate = self
        let index = root.appendingPathComponent("index.html")
        webView.loadFileURL(index, allowingReadAccessTo: root)
        if testing { fputs("Native WebKit load requested.\n", stderr) }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.publish() }
        }
    }

    func show(tab: SettingsTab) {
        requestedTab = tab
        send("navigate", value: tab.rawValue)
        publish(force: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if testing { fputs("Native WebKit navigation finished.\n", stderr) }
        send("navigate", value: requestedTab.rawValue)
        publish(force: true)
        if recoveringContent {
            recoveringContent = false
            AppDiagnostics.shared.record(isOverlay ? "ui.overlay_recovered" : "ui.settings_recovered")
        } else if testing { smokeTest() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        AppDiagnostics.shared.record(isOverlay ? "ui.overlay_process_terminated" : "ui.settings_process_terminated")
        let now = Date()
        recentContentFailures = recentContentFailures.filter { now.timeIntervalSince($0) < 60 }
        guard recentContentFailures.count < 3 else {
            AppDiagnostics.shared.record("ui.recovery_limit_reached")
            return
        }
        recentContentFailures.append(now)
        recoveringContent = true
        lastSnapshot = nil
        // Recover only the trusted bundled document, retaining its document-start overlay flag.
        webView.loadFileURL(root.appendingPathComponent("index.html"), allowingReadAccessTo: root)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("Could not load the bundled interface: \(error.localizedDescription)\n", stderr)
        if testing { exit(1) }
    }

    private func smokeTest() {
        Task { @MainActor in
            do {
                for _ in 0..<100 {
                    if (try await webView.evaluateJavaScript("document.documentElement.dataset.ready === 'true'")) as? Bool == true { break }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                if isOverlay {
                    let valid = try await webView.evaluateJavaScript("""
                        document.documentElement.dataset.ready === 'true' &&
                        document.documentElement.classList.contains('overlay') &&
                        document.querySelectorAll('nav').length === 0 &&
                        document.querySelector('#record-label')?.textContent === 'Start dictation' &&
                        document.documentElement.scrollWidth === 340 &&
                        Array.from(document.fonts).some(font => font.family === 'OpenWhisper Inter' && font.status === 'loaded')
                        """)
                    guard valid as? Bool == true, webView.window?.canBecomeKey == false else {
                        throw UIError.message("Shared recording overlay did not initialize correctly")
                    }
                    try await smokeTestRecovery()
                    if let directory = ProcessInfo.processInfo.environment["WF_UI_SNAPSHOT_DIR"] {
                        let folder = URL(fileURLWithPath: directory, isDirectory: true)
                        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                        try await saveSnapshot(to: folder.appendingPathComponent("macos-overlay.png"))
                    }
                    print("Shared overlay smoke test passed: native bridge, non-activating panel, recording control, and font.")
                    NSApplication.shared.terminate(nil)
                    return
                }
                send("navigate", value: "about")
                try await Task.sleep(nanoseconds: 500_000_000)
                let valid = try await webView.evaluateJavaScript("""
                    document.documentElement.dataset.ready === 'true' &&
                    document.querySelectorAll('nav button').length >= 5 &&
                    document.querySelector('.about-brand img')?.naturalWidth === 256 &&
                    Array.from(document.fonts).some(font => font.family === 'OpenWhisper Inter' && font.status === 'loaded')
                    """)
                guard valid as? Bool == true else { throw UIError.message("Shared UI did not initialize correctly") }
                fputs("Native WebKit UI is ready.\n", stderr)
                try await smokeTestSwitches()
                if let directory = ProcessInfo.processInfo.environment["WF_UI_SNAPSHOT_DIR"] {
                    let folder = URL(fileURLWithPath: directory, isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    for (theme, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
                        webView.window?.appearance = NSAppearance(named: appearance)
                        for tab in SettingsTab.allCases {
                            send("navigate", value: tab.rawValue)
                            try await Task.sleep(nanoseconds: 300_000_000)
                            fputs("Rendering \(theme) \(tab.rawValue).\n", stderr)
                            try await saveSnapshot(to: folder.appendingPathComponent("macos-\(theme)-\(tab.rawValue).png"))
                        }
                    }
                }
                try await webView.evaluateJavaScript("document.querySelector('[data-ui-language=de]').click()")
                try await Task.sleep(nanoseconds: 500_000_000)
                guard UserDefaults.standard.string(forKey: Prefs.uiLanguage) == "de",
                      NativeStrings.text("Settings …") == "Einstellungen …",
                      (try await webView.evaluateJavaScript("document.documentElement.lang")) as? String == "de" else {
                    throw UIError.message("Interface language did not persist or native translations are missing")
                }
                try await webView.evaluateJavaScript("void window.webkit.messageHandlers.openwhisper.postMessage({command: 'complete_setup', args: {}})")
                try await Task.sleep(nanoseconds: 500_000_000)
                guard (try await webView.evaluateJavaScript("document.querySelectorAll('nav button').length")) as? Int == 5 else {
                    throw UIError.message("Completed setup is still visible")
                }
                try await smokeTestRecovery()
                guard (try await webView.evaluateJavaScript("document.documentElement.lang === 'de' && document.querySelectorAll('nav button').length === 5")) as? Bool == true else {
                    throw UIError.message("WebKit recovery lost language or onboarding state")
                }
                UserDefaults.standard.set("en", forKey: Prefs.uiLanguage)
                print("Shared UI smoke test passed: native bridge, onboarding completion, language persistence, icon, and font.")
                NSApplication.shared.terminate(nil)
            } catch {
                fputs("Shared UI smoke test failed: \(error.localizedDescription)\n", stderr)
                exit(1)
            }
        }
    }

    private func smokeTestRecovery() async throws {
        try await webView.evaluateJavaScript("window.__recoverySentinel = true")
        // Exercise the real delegate recovery path without private WebKit process APIs.
        webViewWebContentProcessDidTerminate(webView)
        for _ in 0..<100 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if (try? await webView.evaluateJavaScript("document.documentElement.dataset.ready === 'true' && !window.__recoverySentinel")) as? Bool == true {
                let overlay = (try await webView.evaluateJavaScript("document.documentElement.classList.contains('overlay')")) as? Bool
                guard overlay == isOverlay else { throw UIError.message("WebKit recovery lost the overlay mode") }
                fputs("Native WebKit content recovery passed.\n", stderr)
                return
            }
        }
        throw UIError.message("WebKit content recovery timed out")
    }

    private func smokeTestSwitches() async throws {
        let initialOverlay = UserDefaults.standard.bool(forKey: Prefs.showIdleOverlay)
        let initialLogin = LaunchAtLogin.isEnabled
        send("navigate", value: "general")
        try await Task.sleep(nanoseconds: 200_000_000)
        try await webView.evaluateJavaScript("""
            const idle = document.querySelector('[data-pref="show_idle_overlay"]');
            idle.scrollIntoView({block: 'center'});
            window.__switchY = idle.getBoundingClientRect().y;
            window.__originalSwitch = idle;
            idle.closest('label').click();
            """)
        try await Task.sleep(nanoseconds: 500_000_000)
        let switchDetails = try await webView.evaluateJavaScript("""
            JSON.stringify({connected: window.__originalSwitch.isConnected,
                beforeY: window.__switchY,
                afterY: document.querySelector('[data-pref=show_idle_overlay]').getBoundingClientRect().y,
                checked: document.querySelector('[data-pref=show_idle_overlay]').checked,
                notice: document.querySelector('#notice').textContent})
            """)
        fputs("Native switch state: overlay=\(initialOverlay)->\(UserDefaults.standard.bool(forKey: Prefs.showIdleOverlay)), login=\(initialLogin)->\(LaunchAtLogin.isEnabled), \(String(describing: switchDetails))\n", stderr)
        guard UserDefaults.standard.bool(forKey: Prefs.showIdleOverlay) != initialOverlay,
              LaunchAtLogin.isEnabled == initialLogin,
              (try await webView.evaluateJavaScript("window.__originalSwitch.isConnected && Math.abs(document.querySelector('[data-pref=show_idle_overlay]').getBoundingClientRect().y - window.__switchY) < 1")) as? Bool == true else {
            throw UIError.message("The idle overlay switch changed another setting or moved after saving")
        }
        try await webView.evaluateJavaScript("document.querySelector('[data-pref=show_idle_overlay]').closest('label').click()")
        try await Task.sleep(nanoseconds: 500_000_000)
        guard UserDefaults.standard.bool(forKey: Prefs.showIdleOverlay) == initialOverlay else {
            throw UIError.message("The idle overlay switch could not be disabled again")
        }
        fputs("Native WebKit independent switch and scroll-position test passed.\n", stderr)
        send("navigate", value: "about")
        try await Task.sleep(nanoseconds: 200_000_000)
    }

    private func saveSnapshot(to file: URL) async throws {
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = false
        let image: NSImage = try await withCheckedThrowingContinuation { continuation in
            var completed = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                guard !completed else { return }
                completed = true
                continuation.resume(throwing: UIError.message("Native UI snapshot timed out"))
            }
            webView.takeSnapshot(with: configuration) { image, error in
                guard !completed else { return }
                completed = true
                if let image { continuation.resume(returning: image) }
                else { continuation.resume(throwing: error ?? UIError.message("Native UI snapshot failed")) }
            }
        }
        guard let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
            throw UIError.message("Could not render native UI preview")
        }
        try png.write(to: file)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(LocalUIAccess.allows(navigationAction.request.url, root: root) ? .allow : .cancel)
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame,
              LocalUIAccess.allows(message.frameInfo.request.url, root: root),
              let body = message.body as? [String: Any], let command = body["command"] as? String,
              let args = body["args"] as? [String: Any] else {
            replyHandler(nil, "Untrusted UI request")
            return
        }
        Task { @MainActor in
            do { replyHandler(try await execute(command, args: args), nil); publish(force: true) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }

    private func execute(_ command: String, args: [String: Any]) async throws -> Any {
        let state = AppState.shared
        if UpdateService.shared.isInstalling && ["download_model", "import_model", "delete_model"].contains(command) {
            throw UIError.message("Wait for the update installation to finish")
        }
        switch command {
        case "get_state": return snapshot()
        case "toggle_recording": state.toggle()
        case "cancel_recording": state.cancel()
        case "complete_setup": UserDefaults.standard.set(true, forKey: Prefs.setupCompleted)
        case "open_login_settings": LaunchAtLogin.openSettings()
        case "save_preferences":
            guard let changes = args["changes"] as? [String: Any],
                  var values = snapshot()["preferences"] as? [String: Any],
                  changes.keys.allSatisfy({ values[$0] != nil && $0 != "setup_completed" }) else {
                throw UIError.message("Unknown or read-only preference")
            }
            values.merge(changes) { _, new in new }
            let preferences = try JSONDecoder().decode(UISettings.self, from: JSONSerialization.data(withJSONObject: values))
            try save(preferences)
            return snapshot()
        case "save_settings":
            guard let value = args["preferences"] else { throw UIError.message("Settings are missing") }
            let preferences = try JSONDecoder().decode(UISettings.self, from: JSONSerialization.data(withJSONObject: value))
            try save(preferences)
        case "copy_transcript": state.copyToClipboard(state.latestTranscript)
        case "clear_history", "clear_transcript": state.clearHistory()
        case "copy_history":
            guard let index = args["index"] as? Int, state.history.indices.contains(index) else { throw UIError.message("History item no longer available") }
            state.copyToClipboard(state.history[index])
        case "download_model": state.models.download(try model(args))
        case "cancel_download":
            for id in state.models.progress.keys {
                if let model = state.models.allModels.first(where: { $0.id == id }) { state.models.cancelDownload(model) }
            }
        case "delete_model":
            guard !state.phase.isBusy else { throw UIError.message("Stop dictation before deleting a model") }
            state.models.delete(try model(args)); state.modelSelectionChanged()
        case "import_model": state.models.importModel(); state.modelSelectionChanged()
        case "show_models_folder": state.models.revealInFinder()
        case "enable_shortcut": HotkeyService.shared.beginRecording()
        case "cancel_shortcut": HotkeyService.shared.endRecording()
        case "clear_shortcut": HotkeyService.shared.set(nil)
        case "enable_paste": Permissions.promptAccessibility(); Permissions.openAccessibilitySettings()
        case "disable_paste": Permissions.openAccessibilitySettings()
        case "allow_microphone":
            if Permissions.microphone == .notDetermined { _ = await Permissions.requestMicrophone() }
            else { Permissions.openMicrophoneSettings() }
        case "choose_editor":
            let panel = NSOpenPanel()
            panel.title = NativeStrings.text("Choose a text editor")
            panel.directoryURL = URL(fileURLWithPath: "/Applications")
            panel.allowedContentTypes = [.application]
            panel.canChooseDirectories = false
            if panel.runModal() == .OK, let url = panel.url { UserDefaults.standard.set(url.path, forKey: Prefs.editorAppPath) }
        case "show_transcripts_folder": NSWorkspace.shared.activateFileViewerSelecting([TextInjector.transcriptsDirectory])
        case "check_updates": await UpdateService.shared.check()
        case "install_update": UpdateService.shared.install()
        case "refresh_microphones": break
        default: throw UIError.message("Unknown UI command")
        }
        return NSNull()
    }

    private func model(_ args: [String: Any]) throws -> SpeechModel {
        guard let id = args["id"] as? String,
              let model = AppState.shared.models.allModels.first(where: { $0.id == id }) else {
            throw UIError.message("Unknown model")
        }
        return model
    }

    private func save(_ value: UISettings) throws {
        let state = AppState.shared
        guard state.models.allModels.contains(where: { $0.id == value.model }),
              ["en", "de"].contains(value.ui_language ?? "en"),
              DictationLanguage.all.contains(where: { $0.id == value.language }),
              OutputMode(rawValue: value.output) != nil,
              value.vocabulary.utf8.count <= 8192, value.snippets.count <= 100,
              value.snippets.allSatisfy({ $0.trigger.utf8.count <= 128 && $0.expansion.utf8.count <= 8192 }) else {
            throw UIError.message("Invalid settings")
        }
        if let enabled = value.launch_at_login, enabled != LaunchAtLogin.isEnabled { try LaunchAtLogin.set(enabled) }
        let changedModel = state.models.selectedID != value.model
        state.models.selectedID = value.model
        let defaults = UserDefaults.standard
        defaults.set(value.ui_language ?? "en", forKey: Prefs.uiLanguage)
        defaults.set(value.language, forKey: Prefs.language)
        defaults.set(value.output, forKey: Prefs.outputMode)
        defaults.set(value.hold_to_record ? RecordingMode.hold.rawValue : RecordingMode.toggle.rawValue, forKey: Prefs.recordingMode)
        defaults.set(value.vocabulary, forKey: Prefs.vocabulary)
        let wasKeepingHistory = defaults.bool(forKey: Prefs.keepHistory)
        defaults.set(value.keep_history, forKey: Prefs.keepHistory)
        if wasKeepingHistory && !value.keep_history { state.clearHistory() }
        for (key, enabled) in [(Prefs.restoreClipboard, value.restore_clipboard), (Prefs.playSounds, value.play_sounds),
                               (Prefs.showIdleOverlay, value.show_idle_overlay), (Prefs.autoCheckUpdates, value.auto_check_updates)] {
            if let enabled { defaults.set(enabled, forKey: key) }
        }
        state.snippets.snippets = value.snippets
        if changedModel { state.modelSelectionChanged() }
    }

    private func snapshot() -> [String: Any] {
        let state = AppState.shared, models = state.models, defaults = UserDefaults.standard
        let status: String, message: String
        switch state.phase {
        case .idle: status = "idle"; message = models.lastError ?? "Ready to dictate"
        case .recording: status = "recording"; message = "Listening. Press your trigger again to stop."
        case .transcribing: status = "transcribing"; message = "Transcribing locally …"
        case .done(let text): status = "done"; message = text == state.latestTranscript && !text.isEmpty ? "Text is ready." : text
        case .error(let text): status = "error"; message = text
        }
        let snippets = state.snippets.snippets.map { ["id": $0.id.uuidString, "trigger": $0.trigger, "expansion": $0.expansion, "enabled": $0.enabled] as [String: Any] }
        let preferences: [String: Any] = [
            "ui_language": defaults.string(forKey: Prefs.uiLanguage) ?? "en",
            "setup_completed": defaults.bool(forKey: Prefs.setupCompleted),
            "model": models.selectedID, "language": defaults.string(forKey: Prefs.language) ?? "auto",
            "microphone": "", "vocabulary": defaults.string(forKey: Prefs.vocabulary) ?? "", "snippets": snippets,
            "output": OutputMode.current.rawValue, "hold_to_record": defaults.string(forKey: Prefs.recordingMode) == RecordingMode.hold.rawValue,
            "gpu": MacHardware.current.isAppleSilicon, "keep_history": defaults.bool(forKey: Prefs.keepHistory),
            "restore_clipboard": defaults.bool(forKey: Prefs.restoreClipboard), "play_sounds": defaults.bool(forKey: Prefs.playSounds),
            "show_idle_overlay": defaults.bool(forKey: Prefs.showIdleOverlay), "launch_at_login": LaunchAtLogin.isEnabled,
            "auto_check_updates": defaults.bool(forKey: Prefs.autoCheckUpdates),
        ]
        let download = models.progress.keys.sorted().first
        var updateStatus = "idle"
        var updateVersion: String? = nil
        var updateProgress = 0.0
        var updateError: String? = nil
        switch UpdateService.shared.status {
        case .idle: break
        case .checking: updateStatus = "checking"
        case .upToDate: updateStatus = "current"
        case .available(let release): updateStatus = "available"; updateVersion = release.version
        case .downloading(let progress): updateStatus = "downloading"; updateProgress = progress
        case .installing: updateStatus = "installing"
        case .failed(let message): updateStatus = "error"; updateError = message
        }
        return [
            "updates": ["configured": UpdateService.shared.repository != nil, "status": updateStatus,
                        "version": updateVersion as Any? ?? NSNull(), "progress": updateProgress,
                        "error": updateError as Any? ?? NSNull(), "package": "macos"],
            "platform": "macos", "initial_tab": requestedTab.rawValue, "version": UpdateService.shared.currentVersion, "status": status, "message": message,
            "transcript": state.latestTranscript, "history": state.history, "preferences": preferences,
            "models": models.allModels.map { ["id": $0.id, "title": $0.title, "family": $0.family.rawValue, "size": $0.size, "note": $0.note] },
            "installed": models.installed.sorted(), "microphones": [], "session": "macOS", "desktop": MacHardware.current.summary,
            "clipboard_available": true, "shortcut_portal": true, "paste_portal": true,
            "shortcut": HotkeyService.shared.trigger?.display as Any? ?? NSNull(), "paste_ready": Permissions.accessibilityGranted,
            "gpu_available": false, "download": download as Any? ?? NSNull(), "progress": download.flatMap { models.progress[$0] } ?? 0,
            "elapsed": Int(state.recordingStartedAt.map { Date().timeIntervalSince($0) } ?? 0), "level": Float(state.levels.last ?? 0), "model_directory": models.directory.path,
            "macos": ["microphone_allowed": Permissions.microphone == .authorized, "recording_shortcut": HotkeyService.shared.isRecording,
                      "shortcut_hint": HotkeyService.shared.recordingHint ?? "Press a key, shortcut, or mouse button. Escape cancels.",
                      "editor": TextInjector.appName(at: TextInjector.editorURL), "recommended": ModelManager.recommendations.map { $0.model.id },
                      "updates_configured": UpdateService.shared.repository != nil,
                      "launch_at_login_pending": LaunchAtLogin.requiresApproval],
        ]
    }

    private func publish(force: Bool = false) {
        guard webView.window?.isVisible == true else { return }
        let value = snapshot()
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), force || data != lastSnapshot else { return }
        lastSnapshot = data
        send("state", value: value)
    }

    private func send(_ event: String, value: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["event": "openwhisper:\(event)", "detail": value]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("{ const message = \(json); window.dispatchEvent(new CustomEvent(message.event, { detail: message.detail })); }")
    }
}

private struct UISettings: Decodable {
    let ui_language: String?
    let model, language, vocabulary, output: String
    let snippets: [Snippet]
    let hold_to_record, keep_history: Bool
    let restore_clipboard, play_sounds, show_idle_overlay, launch_at_login, auto_check_updates: Bool?
}
private enum UIError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let message): return message } }
}

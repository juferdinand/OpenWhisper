import AppKit
import os
import WhisperFreeCore

private let stateLog = Logger(subsystem: "io.github.whisperfree", category: "state")

enum Phase: Equatable {
    case idle
    case recording
    case transcribing
    case done(String)
    case error(String)

    var isBusy: Bool { self == .recording || self == .transcribing }
}

/// Central state machine: idle → recording → transcribing → done/error → idle.
@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    static let barCount = 26

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var levels: [Float] = Array(repeating: 0, count: AppState.barCount)
    @Published private(set) var recordingStartedAt: Date?
    @Published private(set) var history: [String] = []
    @Published private(set) var latestTranscript = ""

    let models = ModelManager()
    let snippets = SnippetStore()

    /// Set when the user needs to complete setup (e.g. a missing model).
    var openSettings: ((SettingsTab) -> Void)?

    private let recorder = AudioRecorder()
    private let engine = SpeechEngine()
    private var peakLevel: Float = 0
    private var resetTask: Task<Void, Never>?

    private let minimumDuration: Double = 0.3
    private let silenceThreshold: Float = 0.004
    private let historyLimit = 20

    private var defaults: UserDefaults { .standard }

    init() {
        // AppState is created while constructing the SwiftUI scene, before applicationDidFinishLaunching.
        Prefs.registerDefaults()
        if defaults.bool(forKey: Prefs.keepHistory) {
            history = defaults.stringArray(forKey: Prefs.history) ?? []
        }
        recorder.onLevel = { [weak self] level in
            DispatchQueue.main.async { self?.push(level: level) }
        }
    }

    // MARK: - Controls

    func toggle() {
        switch phase {
        case .recording: stop()
        case .transcribing: break
        case .idle, .done, .error: start()
        }
    }

    func start() {
        guard !phase.isBusy else { return }

        guard let modelPath = models.selectedModelPath else {
            show(.error("No model installed"))
            openSettings?(.models)
            return
        }

        switch Permissions.microphone {
        case .authorized:
            break
        case .notDetermined:
            Task {
                let granted = await Permissions.requestMicrophone()
                show(granted ? .done("Microphone access granted — press again") : .error("No microphone access"))
            }
            return
        default:
            show(.error("No microphone access"))
            Permissions.openMicrophoneSettings()
            return
        }

        do {
            try recorder.start()
        } catch {
            show(.error(error.localizedDescription))
            return
        }

        resetTask?.cancel()
        peakLevel = 0
        levels = Array(repeating: 0, count: Self.barCount)
        recordingStartedAt = Date()
        phase = .recording
        stateLog.info("Recording started")
        playSound("Tink")

        // Start loading the model during recording if it is not already in memory.
        Task { try? await engine.load(modelAt: modelPath) }
    }

    func stop() {
        guard phase == .recording else { return }
        let samples = recorder.stop()
        recordingStartedAt = nil
        playSound("Pop")

        let duration = Double(samples.count) / AudioRecorder.sampleRate
        stateLog.info("Recording stopped: \(duration, format: .fixed(precision: 1))s, level \(self.peakLevel)")
        guard duration >= minimumDuration else {
            phase = .idle
            return
        }
        guard peakLevel >= silenceThreshold else {
            show(.error("No audio detected — check your microphone"))
            return
        }
        guard let modelPath = models.selectedModelPath else {
            show(.error("No model installed"))
            return
        }

        phase = .transcribing
        let language = defaults.string(forKey: Prefs.language) ?? "auto"
        let vocabulary = defaults.string(forKey: Prefs.vocabulary)

        Task {
            do {
                try await engine.load(modelAt: modelPath)
                let raw = try await engine.transcribe(samples, language: language, prompt: vocabulary)
                let corrected = VocabularyCorrector.apply(
                    TranscriptCleaner.clean(raw),
                    terms: VocabularyCorrector.parse(vocabulary ?? "")
                )
                let text = SnippetExpander.apply(corrected, snippets: snippets.snippets)
                guard !text.isEmpty else {
                    show(.error("No speech recognized"))
                    return
                }
                remember(text)
                await deliver(text)
            } catch {
                show(.error(error.localizedDescription))
            }
        }
    }

    /// Discard the recording without transcribing it.
    func cancel() {
        guard phase == .recording else { return }
        _ = recorder.stop()
        recordingStartedAt = nil
        phase = .idle
    }

    func deliver(_ text: String) async {
        let result = await TextInjector.deliver(
            text,
            mode: OutputMode.current,
            restoreClipboard: defaults.bool(forKey: Prefs.restoreClipboard)
        )
        switch result {
        case .pasted:
            show(.done("Inserted"))
        case .copied:
            show(.done(OutputMode.current == .paste ? "Copied — allow Accessibility access to paste automatically" : "Copied to clipboard"))
        case .opened(let app):
            show(.done("Opened in \(app)"))
        case .failed(let message):
            show(.error(message))
        }
    }

    func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func clearHistory() {
        latestTranscript = ""
        history = []
        defaults.removeObject(forKey: Prefs.history)
    }

    func modelSelectionChanged() {
        engine.unload()
        if let path = models.selectedModelPath {
            Task { try? await engine.load(modelAt: path) }
        }
    }

    func shutdown() {
        if phase == .recording { _ = recorder.stop() }
        engine.shutdown()
    }

    func preloadModel() {
        guard let path = models.selectedModelPath else { return }
        Task { try? await engine.load(modelAt: path) }
    }

    // MARK: - Internals

    private func push(level: Float) {
        guard phase == .recording else { return }
        peakLevel = max(peakLevel, level)
        // Typical speech levels are 0.01–0.2 RMS; scale to 0…1.
        let normalized = min(1, (level * 14).squareRoot())
        levels.removeFirst()
        levels.append(normalized)
    }

    private func show(_ newPhase: Phase) {
        if case .error(let message) = newPhase { stateLog.error("\(message, privacy: .public)") }
        resetTask?.cancel()
        phase = newPhase
        let delay: UInt64 = if case .error = newPhase { 2_500_000_000 } else { 1_200_000_000 }
        resetTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled, let self, !self.phase.isBusy else { return }
            self.phase = .idle
        }
    }

    private func remember(_ text: String) {
        latestTranscript = text
        guard defaults.bool(forKey: Prefs.keepHistory) else { return }
        history.insert(text, at: 0)
        if history.count > historyLimit { history.removeLast(history.count - historyLimit) }
        defaults.set(history, forKey: Prefs.history)
    }

    private func playSound(_ name: String) {
        guard defaults.bool(forKey: Prefs.playSounds) else { return }
        NSSound(named: NSSound.Name(name))?.play()
    }
}

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

/// Zentrale Zustandsmaschine: idle → recording → transcribing → done/error → idle.
@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    static let barCount = 26

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var levels: [Float] = Array(repeating: 0, count: AppState.barCount)
    @Published private(set) var recordingStartedAt: Date?
    @Published private(set) var history: [String] = []

    let models = ModelManager()
    let snippets = SnippetStore()

    /// Wird gesetzt, wenn der Nutzer etwas einrichten muss (z. B. Modell fehlt).
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
        // AppState wird schon beim Aufbau der SwiftUI-Scene erzeugt, also vor applicationDidFinishLaunching.
        Prefs.registerDefaults()
        if defaults.bool(forKey: Prefs.keepHistory) {
            history = defaults.stringArray(forKey: Prefs.history) ?? []
        }
        recorder.onLevel = { [weak self] level in
            DispatchQueue.main.async { self?.push(level: level) }
        }
    }

    // MARK: - Steuerung

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
            show(.error("Kein Modell installiert"))
            openSettings?(.models)
            return
        }

        switch Permissions.microphone {
        case .authorized:
            break
        case .notDetermined:
            Task {
                let granted = await Permissions.requestMicrophone()
                show(granted ? .done("Mikrofon erlaubt – nochmal drücken") : .error("Kein Mikrofonzugriff"))
            }
            return
        default:
            show(.error("Kein Mikrofonzugriff"))
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
        stateLog.info("Aufnahme gestartet")
        playSound("Tink")

        // Modell schon während der Aufnahme laden, falls es noch nicht im Speicher ist.
        Task { try? await engine.load(modelAt: modelPath) }
    }

    func stop() {
        guard phase == .recording else { return }
        let samples = recorder.stop()
        recordingStartedAt = nil
        playSound("Pop")

        let duration = Double(samples.count) / AudioRecorder.sampleRate
        stateLog.info("Aufnahme gestoppt: \(duration, format: .fixed(precision: 1))s, Pegel \(self.peakLevel)")
        guard duration >= minimumDuration else {
            phase = .idle
            return
        }
        guard peakLevel >= silenceThreshold else {
            show(.error("Nichts gehört – Mikrofon prüfen"))
            return
        }
        guard let modelPath = models.selectedModelPath else {
            show(.error("Kein Modell installiert"))
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
                    show(.error("Nichts erkannt"))
                    return
                }
                remember(text)
                await deliver(text)
            } catch {
                show(.error(error.localizedDescription))
            }
        }
    }

    /// Aufnahme verwerfen, ohne zu transkribieren.
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
            show(.done("Eingefügt"))
        case .copied:
            show(.done(OutputMode.current == .paste ? "Kopiert – für Auto-Einfügen Bedienungshilfen erlauben" : "In Zwischenablage kopiert"))
        case .opened(let app):
            show(.done("In \(app) geöffnet"))
        case .failed(let message):
            show(.error(message))
        }
    }

    func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func clearHistory() {
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

    // MARK: - Intern

    private func push(level: Float) {
        guard phase == .recording else { return }
        peakLevel = max(peakLevel, level)
        // Sprachpegel liegen typischerweise bei 0.01–0.2 RMS; auf 0…1 strecken.
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

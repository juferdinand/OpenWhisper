import Foundation
import whisper
import WhisperFreeCore

enum SpeechEngineError: LocalizedError {
    case modelLoadFailed(String)
    case notLoaded
    case inferenceFailed(Int32)

    var errorDescription: String? {
        switch self {
        case .modelLoadFailed(let name): "Modell konnte nicht geladen werden (\(name))"
        case .notLoaded: "Kein Modell geladen"
        case .inferenceFailed(let code): "Transkription fehlgeschlagen (Code \(code))"
        }
    }
}

/// Wrapper um die C-APIs von whisper.cpp – sowohl für Whisper- als auch für Parakeet-Modelle.
/// Das Modell bleibt zwischen Diktaten geladen; alle Aufrufe laufen seriell auf einer Queue,
/// weil die Kontexte nicht thread-safe sind.
final class SpeechEngine: @unchecked Sendable {
    private enum Context {
        case whisper(OpaquePointer)
        case parakeet(OpaquePointer)
    }

    private let queue = DispatchQueue(label: "whisperfree.speech", qos: .userInitiated)
    private var context: Context?
    private var loadedPath: String?

    init() {
        // whisper.cpp/ggml loggen sonst jede Menge auf stderr.
        whisper_log_set({ _, _, _ in }, nil)
        parakeet_log_set({ _, _, _ in }, nil)
    }

    deinit {
        free()
    }

    private var threadCount: Int32 {
        Int32(max(1, min(8, ProcessInfo.processInfo.activeProcessorCount - 2)))
    }

    func load(modelAt path: String) async throws {
        try await run {
            if self.loadedPath == path, self.context != nil { return }
            self.free()
            let name = (path as NSString).lastPathComponent
            switch ModelFamily.detect(fileName: name) {
            case .whisper:
                var params = whisper_context_default_params()
                params.use_gpu = true
                params.flash_attn = true
                guard let ctx = whisper_init_from_file_with_params(path, params) else {
                    throw SpeechEngineError.modelLoadFailed(name)
                }
                self.context = .whisper(ctx)
            case .parakeet:
                var params = parakeet_context_default_params()
                params.use_gpu = true
                guard let ctx = parakeet_init_from_file_with_params(path, params) else {
                    throw SpeechEngineError.modelLoadFailed(name)
                }
                self.context = .parakeet(ctx)
            }
            self.loadedPath = path
        }
    }

    /// Muss vor Prozessende aufgerufen werden: ggml-metal bricht sonst in seinen
    /// atexit-Destruktoren ab, wenn noch ein Kontext Metal-Ressourcen hält.
    func shutdown() {
        queue.sync { self.free() }
    }

    func unload() {
        queue.async { self.free() }
    }

    /// - Parameters:
    ///   - language: ISO-Code ("de", "en", …) oder "auto". Parakeet erkennt die Sprache immer selbst.
    ///   - prompt: Optionales Vokabular (nur Whisper), verbessert die Schreibweise von Namen.
    func transcribe(_ samples: [Float], language: String, prompt: String?) async throws -> String {
        try await run {
            switch self.context {
            case .whisper(let ctx):
                return try self.runWhisper(ctx, samples: samples, language: language, prompt: prompt)
            case .parakeet(let ctx):
                return try self.runParakeet(ctx, samples: samples)
            case nil:
                throw SpeechEngineError.notLoaded
            }
        }
    }

    // MARK: - Backends

    private func runWhisper(_ ctx: OpaquePointer, samples: [Float], language: String, prompt: String?) throws -> String {
        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        params.n_threads = threadCount
        params.translate = false
        params.no_context = true
        params.no_timestamps = true
        params.single_segment = false
        params.print_special = false
        params.print_progress = false
        params.print_realtime = false
        params.print_timestamps = false
        params.suppress_blank = true

        let trimmedPrompt = prompt?.trimmingCharacters(in: .whitespacesAndNewlines)
        let code: Int32 = language.withCString { lang in
            params.language = lang
            return Self.withOptionalCString(trimmedPrompt?.isEmpty == false ? trimmedPrompt : nil) { promptPtr in
                params.initial_prompt = promptPtr
                return samples.withUnsafeBufferPointer { buffer in
                    whisper_full(ctx, params, buffer.baseAddress, Int32(buffer.count))
                }
            }
        }
        guard code == 0 else { throw SpeechEngineError.inferenceFailed(code) }

        var text = ""
        for i in 0..<whisper_full_n_segments(ctx) {
            if let segment = whisper_full_get_segment_text(ctx, i) { text += String(cString: segment) }
        }
        return text
    }

    private func runParakeet(_ ctx: OpaquePointer, samples: [Float]) throws -> String {
        var params = parakeet_full_default_params(PARAKEET_SAMPLING_GREEDY)
        params.n_threads = threadCount
        params.no_context = true
        let code = samples.withUnsafeBufferPointer { buffer in
            parakeet_full(ctx, params, buffer.baseAddress, Int32(buffer.count))
        }
        guard code == 0 else { throw SpeechEngineError.inferenceFailed(code) }

        var parts: [String] = []
        for i in 0..<parakeet_full_n_segments(ctx) {
            if let segment = parakeet_full_get_segment_text(ctx, i) {
                parts.append(String(cString: segment).trimmingCharacters(in: .whitespaces))
            }
        }
        return parts.joined(separator: " ")
    }

    // MARK: - Hilfen

    private func free() {
        switch context {
        case .whisper(let ctx): whisper_free(ctx)
        case .parakeet(let ctx): parakeet_free(ctx)
        case nil: break
        }
        context = nil
        loadedPath = nil
    }

    private func run<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try work() })
            }
        }
    }

    private static func withOptionalCString<R>(_ string: String?, _ body: (UnsafePointer<CChar>?) -> R) -> R {
        guard let string else { return body(nil) }
        return string.withCString { body($0) }
    }
}

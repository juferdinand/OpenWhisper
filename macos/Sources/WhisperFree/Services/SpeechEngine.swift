import Foundation
import whisper
import WhisperFreeCore

enum SpeechEngineError: LocalizedError {
    case modelLoadFailed(String)
    case notLoaded
    case inferenceFailed(Int32)

    var errorDescription: String? {
        switch self {
        case .modelLoadFailed(let name): "Could not load model (\(name))"
        case .notLoaded: "No model loaded"
        case .inferenceFailed(let code): "Transcription failed (code \(code))"
        }
    }
}

/// Wrapper around whisper.cpp C APIs for both Whisper and Parakeet models.
/// The model stays loaded between dictations; all calls run serially on a queue
/// because the contexts are not thread-safe.
final class SpeechEngine: @unchecked Sendable {
    private enum Context {
        case whisper(OpaquePointer)
        case parakeet(OpaquePointer)
    }

    private let queue = DispatchQueue(label: "whisperfree.speech", qos: .userInitiated, autoreleaseFrequency: .workItem)
    private var context: Context?
    private var loadedPath: String?

    init() {
        // Suppress verbose whisper.cpp/ggml logging to stderr.
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
            AppDiagnostics.shared.record("speech.loading")
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
            AppDiagnostics.shared.record("speech.loaded")
        }
    }

    /// Call before process exit: ggml-metal can abort in its atexit destructors
    /// if a context still holds Metal resources.
    func shutdown() {
        queue.sync { self.free() }
    }

    func unload() {
        queue.async { self.free() }
    }

    /// - Parameters:
    ///   - language: ISO code ("de", "en", etc.) or "auto". Parakeet always detects the language itself.
    ///   - prompt: Optional vocabulary (Whisper only), improving the spelling of names.
    func transcribe(_ samples: [Float], language: String, prompt: String?) async throws -> String {
        try await run {
            AppDiagnostics.shared.record("speech.transcribing")
            defer { AppDiagnostics.shared.record("speech.inference_returned") }
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

    // MARK: - Helpers

    private func free() {
        guard context != nil else { return }
        AppDiagnostics.shared.record("speech.unloading")
        switch context {
        case .whisper(let ctx): whisper_free(ctx)
        case .parakeet(let ctx): parakeet_free(ctx)
        case nil: break
        }
        context = nil
        loadedPath = nil
        AppDiagnostics.shared.record("speech.unloaded")
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

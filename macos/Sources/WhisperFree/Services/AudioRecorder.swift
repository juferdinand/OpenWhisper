import AVFoundation
import WhisperFreeAudio

/// One capture owns its converter and samples. Late callbacks cannot reach a later recording.
/// The lock covers conversion as well as collection, including the final buffer during stop.
final class AudioCaptureSession: @unchecked Sendable {
    private let lock = NSLock()
    private var closed = false
    private var converter: AVAudioConverter?
    private var samples: [Float] = []
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: AudioRecorder.sampleRate, channels: 1, interleaved: false
    )!

    func process(_ buffer: AVAudioPCMBuffer) -> Float? {
        lock.withLock {
            guard !closed, buffer.frameLength > 0,
                  buffer.format.sampleRate.isFinite, buffer.format.sampleRate > 0,
                  buffer.format.channelCount > 0 else { return nil }
            if converter?.inputFormat != buffer.format {
                converter = AVAudioConverter(from: buffer.format, to: targetFormat)
            }
            guard let converter else { return nil }
            let framesNeeded = Double(buffer.frameLength) * targetFormat.sampleRate / buffer.format.sampleRate + 64
            guard framesNeeded.isFinite, framesNeeded < Double(UInt32.max),
                  let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AVAudioFrameCount(framesNeeded)) else { return nil }
            var consumed = false
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, inputStatus in
                guard !consumed else { inputStatus.pointee = .noDataNow; return nil }
                consumed = true
                inputStatus.pointee = .haveData
                return buffer
            }
            guard status != .error, let channel = output.floatChannelData?[0] else { return nil }
            let frames = UnsafeBufferPointer(start: channel, count: Int(output.frameLength))
            var energy: Float = 0
            for sample in frames { energy += sample * sample }
            samples.append(contentsOf: frames)
            return frames.isEmpty ? 0 : (energy / Float(frames.count)).squareRoot()
        }
    }

    func finish() -> [Float] {
        lock.withLock {
            closed = true
            converter = nil
            let result = samples
            samples = []
            return result
        }
    }
}

/// Records the default microphone in RAM as 16 kHz mono Float32, with no duration limit.
@MainActor
final class AudioRecorder {
    nonisolated static let sampleRate: Double = 16_000
    private var engine: AVAudioEngine?
    private var capture: AudioCaptureSession?
    private var configurationObserver: NSObjectProtocol?
    var onLevel: ((Float) -> Void)?
    var onInterruption: (() -> Void)?

    func start() throws {
        _ = stop()
        let session = AudioCaptureSession()
        // A fresh engine avoids retaining a stale input graph after sleep or device changes.
        let engine = AVAudioEngine()
        self.engine = engine
        capture = session
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { @Sendable [weak self] _ in
            // Never stop the engine from its notification/audio thread.
            DispatchQueue.main.async {
                guard let self, self.capture === session, self.engine?.isRunning == false else { return }
                AppDiagnostics.shared.record("audio.configuration_changed")
                self.onInterruption?()
            }
        }
        var error: NSError?
        let started = WFStartAudioEngine(engine, audioTap(for: session), &error)
        guard started else {
            _ = stop()
            AppDiagnostics.shared.record("audio.start_failed")
            throw error ?? NSError(domain: "io.github.whisperfree.audio", code: 0,
                                   userInfo: [NSLocalizedDescriptionKey: "Microphone unavailable or changed. Check your input device and try again."])
        }
    }

    func audioTap(for session: AudioCaptureSession) -> AVAudioNodeTapBlock {
        // The Objective-C block is not actor-annotated; explicitly opt out of main-actor
        // inheritance because AVAudioEngine invokes it on its realtime audio thread.
        { @Sendable [weak self] buffer, _ in
            guard let level = session.process(buffer) else { return }
            DispatchQueue.main.async {
                guard let self, self.capture === session else { return }
                self.onLevel?(level)
            }
        }
    }

    func stop() -> [Float] {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        let result = capture?.finish() ?? []
        capture = nil
        if let engine {
            var error: NSError?
            if !WFStopAudioEngine(engine, &error) { AppDiagnostics.shared.record("audio.stop_failed") }
        }
        engine = nil
        return result
    }
}

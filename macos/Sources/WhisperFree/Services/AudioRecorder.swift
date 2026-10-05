import AVFoundation

enum RecorderError: LocalizedError {
    case noInputDevice
    case converterUnavailable

    var errorDescription: String? {
        switch self {
        case .noInputDevice: "Kein Mikrofon gefunden"
        case .converterUnavailable: "Audioformat wird nicht unterstützt"
        }
    }
}

/// Nimmt vom Standard-Mikrofon auf und hält das Audio als 16 kHz Mono Float32 im Speicher –
/// genau das Format, das whisper.cpp erwartet. Es wird nie eine Datei geschrieben.
final class AudioRecorder: @unchecked Sendable {
    static let sampleRate: Double = 16_000

    private let engine = AVAudioEngine()
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: AudioRecorder.sampleRate, channels: 1, interleaved: false
    )!
    private var converter: AVAudioConverter?
    private var samples: [Float] = []
    private let lock = NSLock()

    /// Wird vom Audio-Thread mit dem RMS-Pegel jedes Puffers aufgerufen.
    var onLevel: ((Float) -> Void)?

    func start() throws {
        lock.withLock {
            samples.removeAll(keepingCapacity: true)
            samples.reserveCapacity(Int(Self.sampleRate) * 60)
        }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw RecorderError.noInputDevice }
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw RecorderError.converterUnavailable
        }
        self.converter = converter

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    /// Stoppt die Aufnahme und gibt alle gesammelten Samples zurück.
    func stop() -> [Float] {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        return lock.withLock {
            let result = samples
            samples = []
            return result
        }
    }

    private func process(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, let channel = output.floatChannelData?[0] else { return }

        let frames = UnsafeBufferPointer(start: channel, count: Int(output.frameLength))
        var energy: Float = 0
        for sample in frames { energy += sample * sample }
        let rms = frames.isEmpty ? 0 : (energy / Float(frames.count)).squareRoot()

        lock.withLock { samples.append(contentsOf: frames) }
        onLevel?(rms)
    }
}

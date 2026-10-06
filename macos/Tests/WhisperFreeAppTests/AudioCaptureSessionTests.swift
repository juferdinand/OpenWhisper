import AVFoundation
import Testing
import AudioTestSupport
@testable import WhisperFree

struct AudioCaptureSessionTests {
    @Test func nativeAudioExceptionsBecomeErrorsAndCleanupStillRuns() {
        #expect(WFTestAudioStartException())
        #expect(WFTestAudioStopException())
    }

    private func buffer(rate: Double = 16_000, frames: AVAudioFrameCount = 1024) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        for index in 0..<Int(frames) { buffer.floatChannelData![0][index] = 0.25 }
        return buffer
    }

    @Test func stopKeepsSamplesAndRejectsLateCallbacks() {
        let session = AudioCaptureSession()
        #expect(session.process(buffer()) != nil)
        let samples = session.finish()
        #expect(samples.count == 1024)
        #expect(samples.allSatisfy { abs($0 - 0.25) < 0.001 })
        #expect(session.process(buffer()) == nil)
        #expect(session.finish().isEmpty)
        let next = AudioCaptureSession()
        #expect(next.process(buffer()) != nil)
        #expect(next.finish().count == 1024)
    }

    @Test @MainActor func nativeTapCanDeliverSyntheticAudioOffTheMainActor() async {
        let recorder = AudioRecorder()
        let session = AudioCaptureSession()
        let tap = recorder.audioTap(for: session)
        let count = await Task.detached {
            tap(buffer(), AVAudioTime(sampleTime: 0, atRate: 16_000))
            return session.finish().count
        }.value
        #expect(count == 1024)
    }

    @Test func stopCanRaceAnAudioCallbackWithoutReopeningTheSession() {
        for _ in 0..<100 {
            let session = AudioCaptureSession()
            let buffer = buffer()
            let group = DispatchGroup()
            group.enter()
            DispatchQueue.global().async { _ = session.process(buffer); group.leave() }
            let captured = session.finish()
            group.wait()
            #expect(captured.count == 0 || captured.count == 1024)
            #expect(session.process(buffer) == nil)
            #expect(session.finish().isEmpty)
        }
    }

    @Test func convertsChangedInputFormatAndKeepsMoreThanTwoMinutes() {
        let session = AudioCaptureSession()
        // Synthetic audio only; these tests never open an input device.
        for _ in 0..<121 { #expect(session.process(buffer(frames: 16_000)) != nil) }
        #expect(session.process(buffer(rate: 48_000, frames: 48_000)) != nil)
        let samples = session.finish()
        #expect(samples.count >= 121 * 16_000)
        #expect(samples.count <= 122 * 16_000 + 64)
        #expect(samples.allSatisfy(\.isFinite))
    }
}

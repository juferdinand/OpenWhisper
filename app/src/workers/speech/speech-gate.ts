import { setImmediate } from "node:timers/promises";
import type { PreparedAudio, SpeechDisposition, SpeechGate, WorkContext } from "../../core/recording/recording.js";
import { AudioQualityAnalyzer } from "../../core/recording/audio-quality.js";

const minimumSamples = 3200;
const minimumMeanSquare = 0.00000025;
const yieldSamples = 16384;

/** Silence policy for both platforms: recordings shorter than 0.2 s or below the energy floor are
 * discarded without inference. Instantiate only in the capture utilities. */
export class SilenceSpeechGate implements SpeechGate {
  async classify(audio: PreparedAudio, context: WorkContext): Promise<SpeechDisposition> {
    if (audio.sampleRate !== 16000 || !Number.isSafeInteger(audio.sampleCount) || audio.sampleCount < 0
      || audio.generation !== context.generation || audio.attempt !== context.attempt) {
      throw new Error("PREPARATION_FAILED");
    }
    const active = (): void => { if (context.signal.aborted) throw new Error("CANCELLED"); };
    active();
    const quality = new AudioQualityAnalyzer(audio.sampleCount);
    let count = 0; let sum = 0; let budget = 0;
    for (const chunk of audio.chunks) {
      if (!(chunk instanceof Float32Array) || !(chunk.buffer instanceof ArrayBuffer)) {
        throw new Error("PREPARATION_FAILED");
      }
      for (const sample of chunk) {
        if (!Number.isFinite(sample)) throw new Error("PREPARATION_FAILED");
        sum += sample * sample; count++; budget++;
        quality.observe(sample);
        if (budget === yieldSamples) { active(); await setImmediate(); active(); budget = 0; }
      }
    }
    active();
    if (count !== audio.sampleCount || !Number.isFinite(sum)) throw new Error("PREPARATION_FAILED");
    const audioQuality = quality.notice();
    return Object.freeze({ generation: context.generation, attempt: context.attempt,
      ...(audioQuality === undefined ? {} : { audioQuality }),
      hasSpeech: count >= minimumSamples && sum / count >= minimumMeanSquare });
  }
}

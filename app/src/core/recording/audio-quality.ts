import FFT from "fft.js";
import type { AudioQualityNotice } from "../../contracts/recording/audio-quality.js";

const frameSize = 512;
const maximumSpectra = 128;
const window = Float64Array.from({ length: frameSize }, (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (frameSize - 1)));

/** Conservative signal hints, not a speech detector, SNR measurement or recognition-confidence score.
 * Feed the original 16 kHz samples once, in order. Storage and spectral work stay bounded even for
 * unlimited recordings; signal samples are never modified. All thresholds are heuristic. */
export class AudioQualityAnalyzer {
  private readonly fft = new FFT(frameSize);
  private readonly frame = new Float64Array(frameSize);
  private readonly spectrum = new Float64Array(frameSize * 2);
  private readonly levels = new Float64Array(121);
  private readonly spectralStride: number;
  private offset = 0;
  private frames = 0;
  private nonSilentFrames = 0;
  private sum = 0;
  private squareSum = 0;
  private clipped = 0;
  private activeSamples = 0;
  private frameClipped = 0;
  private plateau = 0;
  private previous = 0;
  private spectra = 0;
  private audibleSpectra = 0;
  private noisySpectra = 0;
  private narrowSpectra = 0;

  constructor(private readonly sampleCount: number) {
    this.spectralStride = Math.max(1, Math.ceil(Math.floor(sampleCount / frameSize) / maximumSpectra));
  }

  observe(sample: number): void {
    this.frame[this.offset++] = sample;
    this.sum += sample; this.squareSum += sample * sample;
    if (Math.abs(sample) >= 0.999 && Math.abs(sample - this.previous) < 0.000001) {
      this.plateau += 1;
      if (this.plateau >= 2) this.frameClipped += 1;
    } else this.plateau = 0;
    this.previous = sample;
    if (this.offset === frameSize) this.finishFrame();
  }

  private finishFrame(): void {
    const mean = this.sum / frameSize;
    const energy = Math.max(0, this.squareSum / frameSize - mean * mean);
    // Exclude digital silence/DC from level percentiles: longer pauses must not make good speech quiet.
    if (energy > 1e-12) {
      this.levels[Math.max(0, Math.min(120, Math.floor(10 * Math.log10(energy) + 120)))]! += 1;
      this.nonSilentFrames += 1;
      this.activeSamples += frameSize;
      this.clipped += this.frameClipped;
    }
    if (this.frames % this.spectralStride === 0 && this.spectra < maximumSpectra) {
      this.spectra += 1;
      if (energy >= 0.000016) {
        for (let index = 0; index < frameSize; index += 1) this.frame[index] = (this.frame[index]! - mean) * window[index]!;
        // fft.js 4.0.4 mutates caller-owned output only; its permissive types stay at this numeric boundary.
        this.fft.realTransform(this.spectrum, this.frame);
        let total = 0, logs = 0, middle = 0, texture = 0, textureLogs = 0, textureBins = 0, high = 0, bins = 0;
        for (let bin = 3; bin <= 224; bin += 1) {
          const power = this.spectrum[bin * 2]! ** 2 + this.spectrum[bin * 2 + 1]! ** 2;
          total += power; logs += Math.log(Math.max(1e-20, power)); bins += 1;
          const frequency = bin * 16000 / frameSize;
          if (frequency >= 2800 && frequency <= 3800) middle += power;
          if (frequency >= 2000 && frequency <= 2800) { texture += power; textureLogs += Math.log(Math.max(1e-20, power)); textureBins += 1; }
          if (frequency >= 4500) high += power;
        }
        this.audibleSpectra += 1;
        if (total > 0 && Math.exp(logs / bins) / (total / bins) >= 0.45) this.noisySpectra += 1;
        // A low voice alone has little upper-mid energy and is not evidence of a bandwidth cutoff.
        if (middle > total * 0.02 && high < middle * 0.002 && texture > 0 && Math.exp(textureLogs / textureBins) / (texture / textureBins) >= 0.35) this.narrowSpectra += 1;
      }
    }
    this.frames += 1; this.offset = 0; this.sum = 0; this.squareSum = 0; this.frameClipped = 0;
  }

  private level(percentile: number): number {
    let count = 0;
    for (let bin = 0; bin < this.levels.length; bin += 1) {
      count += this.levels[bin]!;
      if (count >= this.nonSilentFrames * percentile) return 10 ** ((bin - 119) / 20);
    }
    return 0;
  }

  notice(): AudioQualityNotice | undefined {
    // Short taps and tiny trailing fragments are too little evidence for a general quality judgment.
    if (this.sampleCount < 16000) return undefined;
    let supportedFrames = 0, supportedPeak = 0;
    for (let bin = this.levels.length - 1; bin >= 0; bin -= 1) {
      supportedFrames += this.levels[bin]!;
      if (supportedFrames >= 3) { supportedPeak = 10 ** ((bin - 119) / 20); break; }
    }
    const upper = this.nonSilentFrames > 0 ? this.level(0.9) : 0;
    // Quiet room noise may occupy most of a long pause. A short clear phrase still prevents this hint.
    if (supportedPeak < 0.004) return "very_quiet";
    if (this.clipped >= 32 && this.clipped / this.activeSamples >= 0.005) return "clipping";
    if (this.audibleSpectra >= 8) {
      const lower = this.level(0.1);
      if (this.noisySpectra / this.audibleSpectra >= 0.8 && lower >= 0.004 && upper / lower < 2) return "background_noise";
      if (this.narrowSpectra / this.audibleSpectra >= 0.8) return "limited_bandwidth";
    }
    return undefined;
  }
}

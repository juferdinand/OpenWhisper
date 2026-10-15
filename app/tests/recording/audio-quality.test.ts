import assert from "node:assert/strict";
import test from "node:test";
import { SilenceSpeechGate } from "../../src/workers/speech/speech-gate.js";

const rate = 16000;
const tone = (index: number, frequency = 220) => Math.sin(2 * Math.PI * frequency * index / rate);
function noise(seed = 7): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2147483648 - 1; };
}
function samples(seconds: number, signal: (index: number) => number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, index) => signal(index));
}
async function classify(chunks: readonly Float32Array[]) {
  return new SilenceSpeechGate().classify({ generation: 1, attempt: 1, sampleRate: 16000,
    sampleCount: chunks.reduce((total, chunk) => total + chunk.length, 0), chunks },
  { generation: 1, attempt: 1, signal: new AbortController().signal });
}

test("audio quality hints identify sustained quiet signal and silence without changing the speech gate", async () => {
  for (const data of [samples(2, (i) => 0.001 * tone(i)), new Float32Array(32000), new Float32Array(32000).fill(0.2)]) {
    assert.equal((await classify([data])).audioQuality, "very_quiet");
  }
  assert.equal((await classify([new Float32Array(32000)])).hasSpeech, false);
  assert.equal((await classify([samples(2, (i) => 0.001 * tone(i))])).hasSpeech, true);
  assert.equal((await classify([samples(0.1, () => 0)])).audioQuality, undefined);
});

test("clipped plateaus warn while clean full-scale peaks and isolated clicks do not", async () => {
  assert.equal((await classify([samples(2, (i) => Math.max(-1, Math.min(1, 1.8 * tone(i))))])).audioQuality, "clipping");
  assert.equal((await classify([samples(2, (i) => tone(i, 1000))])).audioQuality, undefined);
  const data = samples(2, (i) => 0.15 * tone(i)); data[2000] = 1; data[2001] = 1;
  assert.equal((await classify([data])).audioQuality, undefined);
});

test("stationary broadband noise warns while clear modulated voice-like harmonics do not", async () => {
  const random = noise();
  assert.equal((await classify([samples(4, () => 0.2 * random())])).audioQuality, "background_noise");
  const clean = samples(4, (i) => (0.1 + 0.07 * Math.sin(2 * Math.PI * 3 * i / rate)) * (tone(i) + 0.3 * tone(i, 440) + 0.1 * tone(i, 660)));
  assert.equal((await classify([clean])).audioQuality, undefined);
});

test("a sharp bandwidth cutoff warns only with meaningful upper-mid evidence", async () => {
  // Independent sum of FFT-bin-aligned tones: substantial energy below 3.5 kHz, none above it.
  const limited = samples(3, (i) => 0.004 * Array.from({ length: 47 }, (_, index) => 500 + index * 62.5).reduce((sum, frequency) => sum + tone(i, frequency), 0));
  assert.equal((await classify([limited])).audioQuality, "limited_bandwidth");
  const wide = samples(3, (i) => limited[i]! + 0.03 * tone(i, 5000));
  assert.equal((await classify([wide])).audioQuality, undefined);
  assert.equal((await classify([samples(3, (i) => 0.2 * tone(i, 100))])).audioQuality, undefined);
});

test("quality is independent of chunking, input buffers remain exact and only one category is exposed", async () => {
  const random = noise(); const input = samples(2, () => 0.1 * random()); const copy = input.slice();
  const whole = await classify([input]);
  const split = await classify([input.subarray(0, 1), input.subarray(1, 173), input.subarray(173, 16017), input.subarray(16017)]);
  assert.deepEqual(split, whole); assert.deepEqual(input, copy);
  assert.deepEqual(Object.keys(whole).sort(), ["attempt", "audioQuality", "generation", "hasSpeech"]);
});

test("long pauses and quiet background between clear phrases do not make speech quiet or narrowband", async () => {
  const speech = samples(2, (i) => 0.1 * tone(i));
  const random = noise();
  const silent = samples(1, () => 0.00003 * random());
  assert.equal((await classify([...Array.from({ length: 120 }, () => silent), speech, ...Array.from({ length: 120 }, () => silent)])).audioQuality, undefined);
});

test("natural formant-shaped harmonic spectra without a cutoff do not imply poor bandwidth", async () => {
  const voice = samples(3, (i) => {
    let value = 0;
    for (let harmonic = 1; harmonic <= 70; harmonic += 1) {
      const frequency = harmonic * 100;
      const envelope = Math.exp(-(((frequency - 500) / 180) ** 2)) + 0.6 * Math.exp(-(((frequency - 1500) / 250) ** 2)) + 0.3 * Math.exp(-(((frequency - 3000) / 400) ** 2));
      value += 0.01 * envelope * tone(i, frequency);
    }
    return value;
  });
  assert.equal((await classify([voice])).audioQuality, undefined);
});

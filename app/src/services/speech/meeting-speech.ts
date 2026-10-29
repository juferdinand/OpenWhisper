import type { PreparedAudio, RecordingRequest, SpeechResult, WorkContext } from "../../core/recording/recording.js";
import type { TextProcessingStageEvent } from "../../contracts/text/processing.js";
import { speechTextSchema } from "../../workers/speech/native-speech.js";
import { AdaptiveSpeechBoundary } from "./adaptive-speech.js";

const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 1_600;
const FEATURE_FRAME_SAMPLES = 400;
const MAX_TURN_SAMPLES = 18 * SAMPLE_RATE;
const SPEAKER_LABELS = ["A", "B", "C", "D"] as const;

interface AudioChunk { readonly start: number; readonly end: number; readonly samples: Float32Array }
interface VoiceTurn { readonly start: number; readonly end: number; readonly feature: readonly number[] }
interface LabeledVoiceTurn extends VoiceTurn { readonly speaker: string }
interface SpeakerProfile { readonly values: number[]; count: number }

const dftCos = Array.from({ length: 101 }, (_, bin) => Float64Array.from(
  { length: FEATURE_FRAME_SAMPLES }, (_, sample) => Math.cos(2 * Math.PI * bin * sample / FEATURE_FRAME_SAMPLES),
));
const dftSin = Array.from({ length: 101 }, (_, bin) => Float64Array.from(
  { length: FEATURE_FRAME_SAMPLES }, (_, sample) => Math.sin(2 * Math.PI * bin * sample / FEATURE_FRAME_SAMPLES),
));
const dctCos = Array.from({ length: 13 }, (_, coefficient) => Float64Array.from(
  { length: 16 }, (_, band) => Math.cos(Math.PI * coefficient * (band + 0.5) / 16),
));

function audioChunks(audio: PreparedAudio): readonly AudioChunk[] {
  let start = 0;
  const chunks = audio.chunks.map((samples) => {
    const chunk = { start, end: start + samples.length, samples };
    start = chunk.end;
    return chunk;
  });
  if (start !== audio.sampleCount) throw new Error("MEETING_AUDIO_INVALID");
  return chunks;
}

function readRange(chunks: readonly AudioChunk[], start: number, output: Float32Array, count: number): void {
  let low = 0, high = chunks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), chunk = chunks[middle];
    if (!chunk) throw new Error("MEETING_AUDIO_INVALID");
    if (chunk.end <= start) low = middle + 1;
    else high = middle;
  }
  let cursor = start, written = 0;
  for (let i = low; written < count; i += 1) {
    const chunk = chunks[i];
    if (!chunk || cursor < chunk.start || cursor >= chunk.end) throw new Error("MEETING_AUDIO_INVALID");
    const take = Math.min(count - written, chunk.end - cursor);
    output.set(chunk.samples.subarray(cursor - chunk.start, cursor - chunk.start + take), written);
    cursor += take;
    written += take;
  }
}

function readTurn(chunks: readonly AudioChunk[], start: number, end: number): Float32Array {
  const samples = new Float32Array(end - start);
  readRange(chunks, start, samples, samples.length);
  return samples;
}

function voicedRanges(audio: PreparedAudio, context: WorkContext): readonly { start: number; end: number }[] {
  if (audio.sampleCount === 0) return [];
  const chunks = audioChunks(audio), frame = new Float32Array(FRAME_SAMPLES), levels: number[] = [];
  for (let start = 0; start < audio.sampleCount; start += FRAME_SAMPLES) {
    if (levels.length % 256 === 0 && context.signal.aborted) throw new Error("CANCELLED");
    const count = Math.min(FRAME_SAMPLES, audio.sampleCount - start);
    frame.fill(0); readRange(chunks, start, frame, count);
    let energy = 0;
    for (let index = 0; index < count; index += 1) energy += (frame[index] ?? 0) ** 2;
    levels.push(Math.sqrt(energy / count));
  }
  const sorted = [...levels].sort((left, right) => left - right);
  const noise = sorted[Math.floor(sorted.length * 0.18)] ?? 0;
  const peak = sorted.at(-1) ?? 0;
  if (peak < 0.006) return [];
  const threshold = Math.min(peak * 0.45, Math.max(0.006, noise * 1.8, peak * 0.075));

  const active = levels.map((level) => level >= threshold);
  const ranges: { start: number; end: number; activeFrames: number }[] = [];
  let first = -1, lastActive = -1, activeFrames = 0;
  const close = (): void => {
    if (first < 0 || lastActive < first) return;
    const start = Math.max(0, first * FRAME_SAMPLES - 2_000);
    const end = Math.min(audio.sampleCount, (lastActive + 1) * FRAME_SAMPLES + 2_000);
    if (activeFrames >= 5 && end - start >= SAMPLE_RATE * 0.6) ranges.push({ start, end, activeFrames });
    first = -1; lastActive = -1; activeFrames = 0;
  };
  for (let index = 0; index < active.length; index += 1) {
    if (active[index]) {
      if (first < 0) first = index;
      lastActive = index; activeFrames += 1;
    } else if (first >= 0 && index - lastActive > 5) close();
  }
  close();

  const split: { start: number; end: number }[] = [];
  for (const range of ranges) {
    for (let start = range.start; start < range.end; start += MAX_TURN_SAMPLES) {
      const end = Math.min(range.end, start + MAX_TURN_SAMPLES);
      if (end - start >= SAMPLE_RATE * 0.6) split.push({ start, end });
    }
  }
  return split;
}

function voiceFeature(chunks: readonly AudioChunk[], start: number, end: number, context: WorkContext): readonly number[] {
  const frame = new Float32Array(FEATURE_FRAME_SAMPLES), bands = new Float64Array(16), windowed = new Float64Array(FEATURE_FRAME_SAMPLES);
  const picks = 8;
  for (let pick = 0; pick < picks; pick += 1) {
    if (context.signal.aborted) throw new Error("CANCELLED");
    const center = start + Math.floor((end - start) * (pick + 0.5) / picks);
    const frameStart = Math.max(0, Math.min(end - FEATURE_FRAME_SAMPLES, center - FEATURE_FRAME_SAMPLES / 2));
    frame.fill(0); readRange(chunks, frameStart, frame, FEATURE_FRAME_SAMPLES);
    for (let index = 0; index < FEATURE_FRAME_SAMPLES; index += 1) {
      windowed[index] = (frame[index] ?? 0) * (0.54 - 0.46 * Math.cos(2 * Math.PI * index / (FEATURE_FRAME_SAMPLES - 1)));
    }
    const currentBands = new Float64Array(16);
    for (let bin = 1; bin <= 100; bin += 1) {
      const cosine = dftCos[bin], sine = dftSin[bin];
      if (!cosine || !sine) continue;
      let real = 0, imaginary = 0;
      for (let sample = 0; sample < FEATURE_FRAME_SAMPLES; sample += 1) {
        const value = windowed[sample] ?? 0;
        real += value * (cosine[sample] ?? 0); imaginary += value * (sine[sample] ?? 0);
      }
      const band = Math.min(15, Math.floor((bin - 1) / 6.25));
      currentBands[band] = (currentBands[band] ?? 0) + real * real + imaginary * imaginary;
    }
    const logged = Array.from(currentBands, (power) => Math.log1p(power));
    for (let coefficient = 1; coefficient <= 12; coefficient += 1) {
      const basis = dctCos[coefficient];
      if (!basis) continue;
      let value = 0;
      for (let band = 0; band < 16; band += 1) value += (logged[band] ?? 0) * (basis[band] ?? 0);
      bands[coefficient - 1] = (bands[coefficient - 1] ?? 0) + value / picks;
    }
  }
  const values = Array.from(bands.subarray(0, 12));
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - average);
  const norm = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0)) || 1;
  return centered.map((value) => value / norm);
}

function similarity(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function assignSpeakers(turns: readonly { start: number; end: number; feature: readonly number[] }[]): readonly LabeledVoiceTurn[] {
  const speakers: SpeakerProfile[] = [];
  return turns.map((turn) => {
    let best = -1, score = -1;
    for (let index = 0; index < speakers.length; index += 1) {
      const candidate = speakers[index];
      if (!candidate) continue;
      const similarityScore = similarity(turn.feature, candidate.values);
      if (similarityScore > score) { score = similarityScore; best = index; }
    }
    let selected: number;
    if (speakers.length === 0 || (score < 0.86 && speakers.length < SPEAKER_LABELS.length && turn.end - turn.start >= SAMPLE_RATE * 1.2)) {
      selected = speakers.length;
      speakers.push({ values: [...turn.feature], count: 1 });
    } else {
      selected = Math.max(0, best);
      const profile = speakers[selected];
      if (profile) {
        const count = profile.count;
        for (let index = 0; index < profile.values.length; index += 1) {
          profile.values[index] = ((profile.values[index] ?? 0) * count + (turn.feature[index] ?? 0)) / (count + 1);
        }
        const norm = Math.sqrt(profile.values.reduce((sum, value) => sum + value * value, 0)) || 1;
        for (let index = 0; index < profile.values.length; index += 1) profile.values[index] = (profile.values[index] ?? 0) / norm;
        profile.count += 1;
      }
    }
    return { ...turn, speaker: SPEAKER_LABELS[selected] ?? "A" };
  });
}

function timestamp(sample: number): string {
  const seconds = Math.floor(sample / SAMPLE_RATE);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60;
  const body = [minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${body}` : body;
}

/** Run local transcription on acoustic turns and attach a speaker guess. */
export async function transcribeMeeting(adaptive: AdaptiveSpeechBoundary, audio: PreparedAudio,
  request: RecordingRequest, context: WorkContext,
  onStage?: (event: TextProcessingStageEvent) => void): Promise<SpeechResult> {
  const chunks = audioChunks(audio);
  const spans = voicedRanges(audio, context);
  const guessed = assignSpeakers(spans.map((span) => ({ ...span, feature: voiceFeature(chunks, span.start, span.end, context) })));
  const lines: string[] = [];
  for (const turn of guessed) {
    if (context.signal.aborted) throw new Error("CANCELLED");
    const samples = readTurn(chunks, turn.start, turn.end);
    const segment: PreparedAudio = Object.freeze({ ...audio, sampleCount: samples.length, chunks: Object.freeze([samples]) });
    const result = await adaptive.transcribe(segment, { ...request, mode: "dictation" }, context, onStage);
    const text = speechTextSchema.parse(result.text).trim();
    if (text) lines.push(`[${timestamp(turn.start)}] Speaker ${turn.speaker}: ${text}`);
  }
  return Object.freeze({ generation: audio.generation, attempt: audio.attempt, text: lines.join("\n") });
}

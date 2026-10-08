import { z } from "zod";
import { setImmediate as nextTurn } from "node:timers/promises";
import { recordingRequestSchema,
  type PreparedAudio, type RecordingRequest, type SpeechBoundary, type SpeechResult, type WorkContext,
} from "../core/recording.js";
import { MAX_WINDOW_SAMPLES, MIN_WINDOW_SAMPLES, SAMPLE_RATE, planSpeechWindow, sampleRangeSchema, selectSpeechWindow,
  type SampleRange,
} from "../core/speech-windows.js";
import { processTranscript } from "../core/snippet-expander.js";
import { SpeechWorkerError, type SpeechClient } from "./speech-client.js";
import { speechModelSchema, speechTextSchema, speechVocabularySchema, speechWindowSchema } from "../workers/native-speech.js";

const ownership = { generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
const rangeReplySchema = z.strictObject({ ...ownership, range: sampleRangeSchema });
const windowReplySchema = z.strictObject({ ...ownership, samples: z.instanceof(Float32Array) });
const processedReplySchema = z.strictObject({ ...ownership, text: z.string() });
const contextSchema = z.strictObject({ ...ownership, signal: z.instanceof(AbortSignal) });

export type AdaptiveSpeechFailureCode = "BUSY" | "CANCELLED" | "INVALID_INPUT" | "INVALID_WINDOW"
  | "OWNERSHIP_FAILED" | "EFFECT_FAILED" | "EFFECT_TIMEOUT" | "INFERENCE_FAILED" | "EXHAUSTED";
export class AdaptiveSpeechError extends Error {
  constructor(readonly code: AdaptiveSpeechFailureCode) { super(`Speech pipeline: ${code}.`); }
}
export interface SpeechProgress {
  readonly generation: number;
  readonly attempt: number;
  readonly completedSamples: number;
  readonly gpuFallback: boolean;
}
export interface AdaptiveSpeechEffects {
  /** Detected runtime capability, not a claim that the initial CPU addon supports GPU. */
  readonly gpuAvailable: boolean;
  /** SpeechClient owns disposal and confirmed reap before its next request. */
  readonly infer: Pick<SpeechClient, "transcribeWindow">;
  /** Worker/utility-local effects; do not serialize the whole recording through main. */
  plan(audio: PreparedAudio, start: number, maximum: number, context: WorkContext): Promise<unknown>;
  read(audio: PreparedAudio, range: SampleRange, context: WorkContext): Promise<unknown>;
  process(parts: readonly string[], request: RecordingRequest, context: WorkContext): Promise<unknown>;
  readonly progress?: (progress: SpeechProgress) => void;
}
export interface AdaptiveSpeechOptions { readonly effectTimeoutMs?: number }
export type UtilitySpeechOptions = Pick<AdaptiveSpeechEffects, "gpuAvailable" | "infer" | "progress">;

interface Segment { readonly start: number; readonly end: number; readonly samples: Float32Array }

/** Concrete effects for a capture utility. Original segments stay retained; only bounded
 * copies reach inference. This factory must never be constructed in main or the renderer. */
export function createUtilitySpeechEffects(options: UtilitySpeechOptions): AdaptiveSpeechEffects {
  const indices = new WeakMap<PreparedAudio, readonly Segment[]>();
  const check = (audio: PreparedAudio, context: WorkContext): void => {
    if (context.signal.aborted) throw new AdaptiveSpeechError("CANCELLED");
    if (!contextSchema.safeParse(context).success || !owned(audio, context) ||
        audio.sampleRate !== SAMPLE_RATE || !Number.isSafeInteger(audio.sampleCount) ||
        audio.sampleCount < 0 || !Array.isArray(audio.chunks)) throw new AdaptiveSpeechError("INVALID_INPUT");
  };
  const indexed = async (audio: PreparedAudio, context: WorkContext): Promise<readonly Segment[]> => {
    check(audio, context);
    const previous = indices.get(audio);
    if (previous) return previous;
    const result: Segment[] = [];
    let count = 0;
    for (let i = 0; i < audio.chunks.length; i += 1) {
      if (i % 64 === 0) { await nextTurn(); check(audio, context); }
      const chunk = audio.chunks[i];
      if (!(chunk instanceof Float32Array) || !(chunk.buffer instanceof ArrayBuffer) ||
          !Number.isSafeInteger(count + chunk.length)) throw new AdaptiveSpeechError("INVALID_WINDOW");
      result.push({ start: count, end: count + chunk.length, samples: chunk });
      count += chunk.length;
    }
    if (count !== audio.sampleCount) throw new AdaptiveSpeechError("INVALID_WINDOW");
    indices.set(audio, result);
    return result;
  };
  const read = async (audio: PreparedAudio, input: SampleRange, context: WorkContext): Promise<Float32Array> => {
    check(audio, context);
    const parsed = sampleRangeSchema.safeParse(input);
    if (!parsed.success || parsed.data.end > audio.sampleCount ||
        parsed.data.end - parsed.data.start > MAX_WINDOW_SAMPLES) throw new AdaptiveSpeechError("INVALID_WINDOW");
    const range = parsed.data;
    const segments = await indexed(audio, context);
    let low = 0, high = segments.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const segment = segments[middle];
      if (!segment) throw new AdaptiveSpeechError("INVALID_WINDOW");
      if (segment.end <= range.start) low = middle + 1; else high = middle;
    }
    const samples = new Float32Array(range.end - range.start);
    let cursor = range.start, output = 0;
    for (let i = low; cursor < range.end; i += 1) {
      const segment = segments[i];
      if (!segment || segment.start > cursor) throw new AdaptiveSpeechError("INVALID_WINDOW");
      const end = Math.min(segment.end, range.end);
      while (cursor < end) {
        await nextTurn(); check(audio, context);
        const pieceEnd = Math.min(end, cursor + 16384);
        samples.set(segment.samples.subarray(cursor - segment.start, pieceEnd - segment.start), output);
        output += pieceEnd - cursor;
        cursor = pieceEnd;
      }
    }
    return samples;
  };
  return {
    ...options,
    plan: async (audio, start, maximum, context) => {
      check(audio, context);
      const plan = planSpeechWindow(audio.sampleCount, start, maximum);
      const probe = plan.kind === "search" ? await read(audio, plan.probe, context) : undefined;
      check(audio, context);
      return { generation: context.generation, attempt: context.attempt, range: selectSpeechWindow(plan, probe) };
    },
    read: async (audio, range, context) => ({ generation: context.generation, attempt: context.attempt,
      samples: await read(audio, range, context) }),
    process: async (parts, request, context) => {
      await nextTurn();
      if (context.signal.aborted) throw new AdaptiveSpeechError("CANCELLED");
      const text = processRawSpeechParts(parts, request);
      await nextTurn();
      if (context.signal.aborted) throw new AdaptiveSpeechError("CANCELLED");
      return { generation: context.generation, attempt: context.attempt, text };
    },
  };
}

/** Call only in a utility/worker. Preserve Rust White_Space trim and processing order.
 * Neither raw parts nor final user text are truncated to a transport-sized substring. */
export function processRawSpeechParts(parts: readonly string[], request: RecordingRequest): string {
  const validated = recordingRequestSchema.parse(request);
  const raw = parts.map((part) => speechTextSchema.parse(part)
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")).filter((part) => part.length > 0).join(" ");
  return processTranscript(raw, validated.vocabulary, validated.snippets);
}

function owned(value: { generation: number; attempt: number }, context: WorkContext): boolean {
  return value.generation === context.generation && value.attempt === context.attempt;
}

/** Cancellation rejects promptly, while observing late effects so they cannot publish or reject unhandled.
 * Effects still own bounded cleanup. A SpeechClient retry waits for its disposed native owner. */
function awaitEffect<T>(operation: () => Promise<T>, signal: AbortSignal,
                        timeoutMs?: number): Promise<T> {
  return new Promise<T>((accept, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (effect: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      effect();
    };
    const abort = (): void => finish(() => { reject(new AdaptiveSpeechError("CANCELLED")); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (timeoutMs !== undefined) timer = setTimeout(() => {
      finish(() => { reject(new AdaptiveSpeechError("EFFECT_TIMEOUT")); });
    }, timeoutMs);
    void Promise.resolve().then(() => {
      // A synchronous abort before this microtask must not start another effect.
      if (settled) throw new AdaptiveSpeechError("CANCELLED");
      return operation();
    }).then(
      (value) => { finish(() => { accept(value); }); },
      (error: unknown) => { finish(() => { reject(error); }); },
    );
  });
}

const retryable: ReadonlySet<string> = new Set(["START_FAILED", "WORKER_FAILED", "TIMEOUT", "NATIVE_FAILED"]);

/** Policy only: scans, reads and text processing are injected utility-local effects.
 * Port of transcription.rs adaptive(); recovery/silence/delivery remain coordinator responsibilities. */
export class AdaptiveSpeechBoundary implements SpeechBoundary {
  private active: object | undefined;
  private readonly effectTimeoutMs: number;

  constructor(private readonly effects: AdaptiveSpeechEffects, options: AdaptiveSpeechOptions = {}) {
    this.effectTimeoutMs = options.effectTimeoutMs ?? 600_000;
    if (typeof effects.gpuAvailable !== "boolean" || !Number.isInteger(this.effectTimeoutMs) ||
        this.effectTimeoutMs < 1 || this.effectTimeoutMs > 600_000) {
      throw new AdaptiveSpeechError("INVALID_INPUT");
    }
  }

  async transcribe(audio: PreparedAudio, input: RecordingRequest, inputContext: WorkContext): Promise<SpeechResult> {
    if (this.active) throw new AdaptiveSpeechError("BUSY");
    const parsedContext = contextSchema.safeParse(inputContext);
    const parsedRequest = recordingRequestSchema.safeParse(input);
    if (!parsedContext.success || !parsedRequest.success || audio.sampleRate !== SAMPLE_RATE ||
        !Number.isSafeInteger(audio.sampleCount) || audio.sampleCount < 0 ||
        !owned(audio, parsedContext.data)) throw new AdaptiveSpeechError("INVALID_INPUT");
    const request = parsedRequest.data;
    if (!speechModelSchema.safeParse(request.model).success ||
        !speechVocabularySchema.safeParse(request.vocabulary).success) throw new AdaptiveSpeechError("INVALID_INPUT");
    if (inputContext.signal.aborted) throw new AdaptiveSpeechError("CANCELLED");
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    inputContext.signal.addEventListener("abort", abort, { once: true });
    const context: WorkContext = { generation: inputContext.generation, attempt: inputContext.attempt,
      signal: controller.signal };
    const token = {};
    this.active = token;
    let start = 0;
    let maximum = MAX_WINDOW_SAMPLES;
    let gpu = request.model.gpu && this.effects.gpuAvailable;
    const initiallyGpu = gpu;
    const parts: string[] = [];
    const current = (): void => {
      if (controller.signal.aborted || this.active !== token) throw new AdaptiveSpeechError("CANCELLED");
    };
    const progress = (): void => {
      current();
      this.effects.progress?.(Object.freeze({ generation: context.generation, attempt: context.attempt,
        completedSamples: start, gpuFallback: initiallyGpu && !gpu }));
    };
    try {
      while (start < audio.sampleCount) {
        current();
        const rangeReply = rangeReplySchema.safeParse(await awaitEffect(
          () => this.effects.plan(audio, start, maximum, context), controller.signal, this.effectTimeoutMs));
        current();
        if (!rangeReply.success) throw new AdaptiveSpeechError("INVALID_WINDOW");
        if (!owned(rangeReply.data, context)) throw new AdaptiveSpeechError("OWNERSHIP_FAILED");
        const range = rangeReply.data.range;
        if (range.start !== start || range.end <= start || range.end > audio.sampleCount ||
            range.end - range.start > maximum) throw new AdaptiveSpeechError("INVALID_WINDOW");
        const windowReply = windowReplySchema.safeParse(await awaitEffect(
          () => this.effects.read(audio, range, context), controller.signal, this.effectTimeoutMs));
        current();
        if (!windowReply.success) throw new AdaptiveSpeechError("INVALID_WINDOW");
        if (!owned(windowReply.data, context)) throw new AdaptiveSpeechError("OWNERSHIP_FAILED");
        const samples = windowReply.data.samples;
        if (!speechWindowSchema.safeParse(samples).success || samples.length !== range.end - range.start) {
          throw new AdaptiveSpeechError("INVALID_WINDOW");
        }
        let part: string;
        try {
          // SpeechClient owns its inference watchdog and confirmed disposal before retries.
          part = await awaitEffect(() => this.effects.infer.transcribeWindow(
            { ...request.model, gpu }, samples, request.language,
            request.model.family === "parakeet" ? "" : request.vocabulary, controller.signal), controller.signal);
        } catch (error: unknown) {
          current();
          if (!(error instanceof SpeechWorkerError) || !retryable.has(error.code)) throw error;
          if (maximum > MIN_WINDOW_SAMPLES) maximum = Math.max(MIN_WINDOW_SAMPLES, Math.floor(maximum / 2));
          else if (gpu) { gpu = false; maximum = MAX_WINDOW_SAMPLES; progress(); }
          else throw new AdaptiveSpeechError("EXHAUSTED");
          continue;
        }
        current();
        if (!speechTextSchema.safeParse(part).success) throw new AdaptiveSpeechError("INFERENCE_FAILED");
        parts.push(part);
        start = range.end;
        progress();
      }
      const processed = processedReplySchema.safeParse(await awaitEffect(
        () => this.effects.process(Object.freeze(parts), request, context), controller.signal, this.effectTimeoutMs));
      current();
      if (!processed.success) throw new AdaptiveSpeechError("EFFECT_FAILED");
      if (!owned(processed.data, context)) throw new AdaptiveSpeechError("OWNERSHIP_FAILED");
      return processed.data;
    } catch (error: unknown) {
      if (error instanceof AdaptiveSpeechError) throw error;
      if (error instanceof SpeechWorkerError) {
        throw new AdaptiveSpeechError(error.code === "CANCELLED" ? "CANCELLED" : "INFERENCE_FAILED");
      }
      throw new AdaptiveSpeechError("EFFECT_FAILED");
    } finally {
      controller.abort();
      inputContext.signal.removeEventListener("abort", abort);
      if (this.active === token) this.active = undefined;
    }
  }
}

import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { captureMetadataSchema, preparedMetadataSchema } from "./native-capture.js";
import type { NativeCaptureSession } from "./native-capture.js";

export const macCaptureSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("synthetic"), sampleRate: z.number().int().min(8000).max(192000), channels: z.number().int().min(1).max(8) }),
  z.strictObject({ mode: z.literal("avfoundation") }),
]);
export type MacCaptureSelection = z.infer<typeof macCaptureSelectionSchema>;
export const macCaptureDiagnosticsSchema = z.strictObject({ engineAllocations: z.number().int().nonnegative(),
  inputNodeOperations: z.number().int().nonnegative(), permissionQueries: z.number().int().nonnegative(),
  permissionRequests: z.literal(0), diskOperations: z.literal(0), activeCallbacks: z.number().int().nonnegative(), released: z.boolean() });
const formatSchema = z.strictObject({ sampleRate: z.number().int().min(8000).max(192000), channels: z.number().int().min(1).max(8), interleaved: z.boolean() });
export interface MacCaptureSession extends NativeCaptureSession {
  /** Synthetic-only awaitable feed. This bypasses no ownership/final-sample fences. */
  feedFormat(samples: Float32Array, format: z.infer<typeof formatSchema>): Promise<void>;
  diagnostics(): z.infer<typeof macCaptureDiagnosticsSchema>;
  holdCallback(held: boolean): void;
  failNextCopy(): void;
  failNextQueue(): void;
  reference(): Promise<z.infer<typeof preparedMetadataSchema>>;
  readReferenceChunk(index: number): Float32Array;
}
export interface NativeMacCapture {
  create(generation: number, selection: MacCaptureSelection): MacCaptureSession;
  exceptionProbe(): { startExceptionContained: true; stopExceptionContained: true; stopAttemptedAfterRemovalException: true; engineStopExceptionContained: true };
}
/** Load only in an Apple capture utility. Importing this module has no native/permission effects. */
export function loadNativeMacCapture(binding: string): NativeMacCapture {
  if (process.platform !== "darwin" || !isAbsolute(binding) || !binding.endsWith(".node") || binding.includes("\0")) throw new Error("CAPTURE_FAILED");
  const raw: unknown = createRequire(import.meta.url)(binding);
  if (typeof raw !== "object" || raw === null) throw new Error("CAPTURE_FAILED");
  const names = ["create", "start", "closeAndFence", "prepare", "release", "status", "diagnostics", "feedFormat", "feedSync", "hook", "reference", "readChunk", "abortStart", "exceptionProbe"] as const;
  const functions = new Map<string, (...arguments_: unknown[]) => unknown>();
  for (const name of names) {
    const fn: unknown = Reflect.get(raw, name);
    if (typeof fn !== "function") throw new Error("CAPTURE_FAILED");
    functions.set(name, (...arguments_) => Reflect.apply(fn, raw, arguments_));
  }
  const call = (name: typeof names[number], ...arguments_: unknown[]): unknown => {
    const fn = functions.get(name); if (!fn) throw new Error("CAPTURE_FAILED"); return fn(...arguments_);
  };
  return { create(generation, requested) {
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(generation);
    const selection = macCaptureSelectionSchema.parse(requested), synthetic = selection.mode === "synthetic";
    const rate = synthetic ? selection.sampleRate : 48000, channels = synthetic ? selection.channels : 1;
    const handle = call("create", generation, synthetic, rate, channels);
    const meta = (value: unknown) => {
      const result = captureMetadataSchema.parse(value);
      if (result.generation !== generation) throw new Error("OWNERSHIP_FAILED"); return result;
    };
    const prepared = (value: unknown) => {
      const result = preparedMetadataSchema.parse(value);
      if (result.generation !== generation) throw new Error("OWNERSHIP_FAILED"); return result;
    };
    const feed = async (samples: Float32Array, input: z.infer<typeof formatSchema>) => {
      const format = formatSchema.parse(input);
      if (!synthetic || !(samples instanceof Float32Array) || !(samples.buffer instanceof ArrayBuffer) || samples.length === 0
        || samples.length > 192000 * 8 || samples.length % format.channels || !samples.every(Number.isFinite)) throw new Error("CAPTURE_FAILED");
      meta(await call("feedFormat", handle, samples, format.sampleRate, format.channels, format.interleaved));
    };
    const read = (index: number, reference: boolean): Float32Array => {
      z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(index);
      return z.instanceof(Float32Array).refine((value) => value.buffer instanceof ArrayBuffer && value.length > 0
        && value.length <= 16384 && value.every(Number.isFinite)).parse(call("readChunk", handle, index, reference));
    };
    const hook = (action: number, enabled: boolean): void => {
      if (!synthetic) throw new Error("CAPTURE_FAILED"); z.undefined().parse(call("hook", handle, action, enabled));
    };
    return { generation, start: async () => meta(await call("start", handle)), closeAndFence: async () => meta(await call("closeAndFence", handle)),
      prepare: async () => prepared(await call("prepare", handle)), release: async () => meta(await call("release", handle)), status: () => meta(call("status", handle)),
      readPreparedChunk: (index) => read(index, false), readReferenceChunk: (index) => read(index, true),
      diagnostics: () => macCaptureDiagnosticsSchema.parse(call("diagnostics", handle)), feedFormat: feed,
      feed: (samples) => {
        if (!synthetic || !(samples.buffer instanceof ArrayBuffer) || samples.length === 0 || samples.length > 192000 * 8
          || samples.length % channels || !samples.every(Number.isFinite)) throw new Error("CAPTURE_FAILED");
        z.undefined().parse(call("feedSync", handle, samples, rate, channels, true));
      },
      feedHole: () => { throw new Error("CAPTURE_FAILED"); }, injectError: () => hook(2, true),
      abortStart: () => { z.undefined().parse(call("abortStart", handle)); }, holdCallback: (held) => hook(0, held), failNextCopy: () => hook(1, true),
      failNextQueue: () => hook(4, true),
      reference: async () => {
        if (!synthetic) throw new Error("CAPTURE_FAILED"); return prepared(await call("reference", handle));
      },
    };
  }, exceptionProbe: () => z.strictObject({ startExceptionContained: z.literal(true), stopExceptionContained: z.literal(true),
    stopAttemptedAfterRemovalException: z.literal(true), engineStopExceptionContained: z.literal(true) }).parse(call("exceptionProbe")) };
}

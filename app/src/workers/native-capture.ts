import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { z } from "zod";

const generationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const countSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= 0xffffffffffffffffn);
export const captureMetadataSchema = z.strictObject({
  generation: generationSchema, running: z.boolean(), streamClosed: z.boolean(), finalSamplesFenced: z.boolean(),
  failed: z.boolean(), frameCount: countSchema, sequence: countSchema,
  failureKind: z.enum(["none", "start", "source", "terminal", "backend", "peek", "hole", "format", "drop", "invalid", "allocation", "cancelled", "injected", "suspended", "rerouted", "interrupted"]).optional(),
  sampleRate: z.number().int().min(8000).max(192000), channels: z.number().int().min(1).max(8),
  level: z.number().finite().min(0).max(1),
});
export const preparedMetadataSchema = captureMetadataSchema.extend({
  sampleCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  chunkCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type CaptureMetadata = z.infer<typeof captureMetadataSchema>;
export type PreparedMetadata = z.infer<typeof preparedMetadataSchema>;
export type CaptureSelection =
  | { readonly mode: "pulse"; readonly source: string; readonly server: string }
  | { readonly mode: "synthetic"; readonly sampleRate: number; readonly channels: number };
export interface NativeCaptureSession {
  readonly generation: number;
  start(): Promise<CaptureMetadata>;
  closeAndFence(): Promise<CaptureMetadata>;
  prepare(): Promise<PreparedMetadata>;
  readPreparedChunk(index: number): Float32Array;
  status(): CaptureMetadata;
  release(): Promise<CaptureMetadata>;
  /** Synthetic sessions only. No device or server is opened. */
  feed(samples: Float32Array): void;
  /** Synthetic only: exercise the real bounded Pulse-hole visitor without opening a device. */
  feedHole(bytes: number): void;
  injectError(): void;
  /** Stop accepting callbacks and prevent a late startup from opening the next native phase. */
  abortStart(): void;
}
export interface NativeCapture {
  create(generation: number, selection: CaptureSelection): NativeCaptureSession;
}
export function checkedCaptureSelection(input: CaptureSelection): CaptureSelection {
  if (input.mode === "synthetic") return z.strictObject({ mode: z.literal("synthetic"),
    sampleRate: z.number().int().min(8000).max(192000), channels: z.number().int().min(1).max(8),
  }).parse(input);
  return z.strictObject({ mode: z.literal("pulse"), source: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/),
    // No daemon autospawn, default server, TCP transport, or host-owned socket fallback.
    server: z.string().min(6).max(4096).refine((value) => value.startsWith("unix:") &&
      isAbsolute(value.slice(5)) && !value.includes("\0")),
  }).parse(input);
}

/** Load only in the dedicated capture utility, never main/preload/renderer. */
export function loadNativeCapture(bindingPath: string): NativeCapture {
  if (!isAbsolute(bindingPath) || !bindingPath.endsWith(".node") || bindingPath.includes("\0")) {
    throw new Error("CAPTURE_FAILED");
  }
  const raw: unknown = createRequire(import.meta.url)(bindingPath);
  const names = ["create", "start", "closeAndFence", "prepare", "release", "status", "feed", "feedHole", "injectError", "abortStart", "readPreparedChunk"] as const;
  if (typeof raw !== "object" || raw === null) throw new Error("CAPTURE_FAILED");
  const functions = new Map<string, (...args: unknown[]) => unknown>();
  for (const name of names) {
    if (!(name in raw)) throw new Error("CAPTURE_FAILED");
    const fn: unknown = Reflect.get(raw, name);
    if (typeof fn !== "function") throw new Error("CAPTURE_FAILED");
    functions.set(name, (...args: unknown[]) => Reflect.apply(fn, raw, args));
  }
  const call = (name: typeof names[number], ...args: unknown[]): unknown => {
    const fn = functions.get(name); if (!fn) throw new Error("CAPTURE_FAILED"); return fn(...args);
  };
  return Object.freeze({ create: (generation: number, input: CaptureSelection): NativeCaptureSession => {
    generationSchema.parse(generation);
    const selection = checkedCaptureSelection(input);
    const synthetic = selection.mode === "synthetic";
    const handle = call("create", generation, synthetic,
      selection.mode === "synthetic" ? selection.sampleRate : 48000,
      selection.mode === "synthetic" ? selection.channels : 1);
    const checked = (value: unknown): CaptureMetadata => {
      const meta = captureMetadataSchema.parse(value);
      if (meta.generation !== generation) throw new Error("OWNERSHIP_FAILED"); return meta;
    };
    return Object.freeze({ generation,
      start: async () => checked(await call("start", handle, selection.mode === "pulse" ? selection.source : "synthetic",
        selection.mode === "pulse" ? selection.server : "synthetic")),
      closeAndFence: async () => checked(await call("closeAndFence", handle)),
      prepare: async () => {
        const result = preparedMetadataSchema.parse(await call("prepare", handle));
        if (result.generation !== generation) throw new Error("OWNERSHIP_FAILED"); return result;
      },
      status: () => checked(call("status", handle)),
      release: async () => checked(await call("release", handle)),
      readPreparedChunk: (index: number) => {
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(index);
        const result: unknown = call("readPreparedChunk", handle, index);
        return z.instanceof(Float32Array).refine((samples) => samples.buffer instanceof ArrayBuffer &&
          samples.length > 0 && samples.length <= 16384 && samples.every(Number.isFinite)).parse(result);
      },
      feed: (samples: Float32Array) => {
        if (!synthetic || !(samples.buffer instanceof ArrayBuffer) || samples.length === 0 ||
            samples.length > 192000 * 8 || !samples.every(Number.isFinite)) throw new Error("CAPTURE_FAILED");
        z.undefined().parse(call("feed", handle, samples));
      },
      feedHole: (bytes: number) => {
        if (!synthetic) throw new Error("CAPTURE_FAILED");
        z.number().int().positive().max(192000 * 8 * 4).parse(bytes);
        z.undefined().parse(call("feedHole", handle, bytes));
      },
      injectError: () => { if (!synthetic) throw new Error("CAPTURE_FAILED"); z.undefined().parse(call("injectError", handle)); },
      abortStart: () => { z.undefined().parse(call("abortStart", handle)); },
    });
  } });
}

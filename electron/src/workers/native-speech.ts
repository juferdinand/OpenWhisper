import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { speechLanguageSchema } from "../contracts/speech.js";
export { speechLanguageSchema } from "../contracts/speech.js";

export const SAMPLE_RATE = 16_000;
export const MAX_WINDOW_SAMPLES = 30 * SAMPLE_RATE;
export const MIN_WINDOW_SAMPLES = SAMPLE_RATE;
export const speechModelSchema = z.strictObject({
  path: z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes("\0")),
  family: z.enum(["whisper", "parakeet"]), gpu: z.boolean(),
});
export const speechWindowSchema = z.instanceof(Float32Array).refine((samples) =>
  samples.buffer instanceof ArrayBuffer && samples.byteOffset === 0 && samples.buffer.byteLength === samples.byteLength &&
  samples.length > 0 && samples.length <= MAX_WINDOW_SAMPLES &&
  samples.every(Number.isFinite), "A finite, bounded inference window is required.");
export const speechVocabularySchema = z.string().refine((value) =>
  !value.includes("\0") && new TextEncoder().encode(value).length <= 4 * 1024 * 1024);
export const speechTextSchema = z.string().refine((value) =>
  new TextEncoder().encode(value).length <= 4 * 1024 * 1024);
export type SpeechModel = z.infer<typeof speechModelSchema>;

export interface NativeSpeech {
  gpuDevice(): string | null;
  load(model: SpeechModel): void;
  transcribe(samples: Float32Array, language: string, vocabulary: string): string;
  shutdown(): void;
}

/** Use only inside a disposable process, never main/preload/renderer. */
export function loadNativeSpeech(bindingPath: string): NativeSpeech {
  if (!isAbsolute(bindingPath) || !bindingPath.endsWith(".node") || bindingPath.includes("\0")) {
    throw new Error("A trusted absolute native speech binding is required.");
  }
  const raw: unknown = createRequire(import.meta.url)(bindingPath);
  if (typeof raw !== "object" || raw === null ||
      !("gpuDevice" in raw) || typeof raw.gpuDevice !== "function" ||
      !("load" in raw) || typeof raw.load !== "function" ||
      !("transcribe" in raw) || typeof raw.transcribe !== "function" ||
      !("shutdown" in raw) || typeof raw.shutdown !== "function") {
    throw new Error("The native speech binding has an invalid interface.");
  }
  const { gpuDevice, load, transcribe, shutdown } = raw;
  return Object.freeze({
    gpuDevice: () => {
      const result: unknown = Reflect.apply(gpuDevice, raw, []);
      return z.string().max(4096).nullable().parse(result);
    },
    load: (input: SpeechModel) => {
      const model = speechModelSchema.parse(input);
      const result: unknown = Reflect.apply(load, raw, [model.path, model.family === "parakeet", model.gpu]);
      z.undefined().parse(result);
    },
    transcribe: (input: Float32Array, language: string, vocabulary: string) => {
      const samples = speechWindowSchema.parse(input);
      const result: unknown = Reflect.apply(transcribe, raw, [samples,
        speechLanguageSchema.parse(language), speechVocabularySchema.parse(vocabulary)]);
      return speechTextSchema.parse(result);
    },
    shutdown: () => {
      const result: unknown = Reflect.apply(shutdown, raw, []);
      z.undefined().parse(result);
    },
  });
}

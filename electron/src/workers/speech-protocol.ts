import { z } from "zod";
import {
  speechLanguageSchema, speechModelSchema, speechTextSchema,
  speechVocabularySchema, speechWindowSchema, type NativeSpeech,
} from "./native-speech.js";

const envelope = { version: z.literal(1), id: z.string().uuid() };
export const speechRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...envelope, command: z.literal("discover") }),
  z.strictObject({ ...envelope, command: z.literal("shutdown") }),
  z.strictObject({ ...envelope, command: z.literal("transcribe"), model: speechModelSchema,
    samples: speechWindowSchema, language: speechLanguageSchema, vocabulary: speechVocabularySchema }),
]);
export const speechReadySchema = z.strictObject({ version: z.literal(1), type: z.literal("ready") });
export const speechReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...envelope, ok: z.literal(true), value: z.union([
    z.strictObject({ command: z.literal("discover"), gpu: z.string().max(4096).nullable() }),
    z.strictObject({ command: z.literal("shutdown") }),
    z.strictObject({ command: z.literal("transcribe"), text: speechTextSchema }),
  ]) }),
  z.strictObject({ ...envelope, ok: z.literal(false), code: z.enum(["START_FAILED", "NATIVE_FAILED"]) }),
]);
export type SpeechRequest = z.infer<typeof speechRequestSchema>;
export type SpeechReply = z.infer<typeof speechReplySchema>;

/** Called serially on the disposable process's one owning thread. */
export function executeSpeechRequest(native: NativeSpeech, input: unknown): SpeechReply {
  const request = speechRequestSchema.parse(input);
  try {
    switch (request.command) {
      case "discover":
        return speechReplySchema.parse({ version: 1, id: request.id, ok: true,
          value: { command: "discover", gpu: native.gpuDevice() } });
      case "shutdown":
        native.shutdown();
        return { version: 1, id: request.id, ok: true, value: { command: "shutdown" } };
      case "transcribe": {
        native.load(request.model);
        // Padding is confined to inference; the complete recording is never shortened.
        const samples = request.samples.length < 16_000 ? new Float32Array(16_000) : request.samples;
        if (samples !== request.samples) samples.set(request.samples);
        const text = native.transcribe(samples, request.language, request.vocabulary);
        return speechReplySchema.parse({ version: 1, id: request.id, ok: true,
          value: { command: "transcribe", text } });
      }
    }
  } catch { return { version: 1, id: request.id, ok: false, code: "NATIVE_FAILED" }; }
}

import { z } from "zod";
import { speechLanguageSchema, speechModelSchema, speechTextSchema,
  speechVocabularySchema, speechWindowSchema } from "./native-speech.js";

const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ownership = { generation, attempt: generation };
const envelope = { version: z.literal(1), epoch: z.uuid(), id: z.uuid(), ...ownership };
export const deliveryIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("recovery"), token: z.string().min(1).max(256).refine((value) => !value.includes("\0")) }),
  z.strictObject({ kind: z.literal("memory"), generation }),
]);
export const deliveryReceiptSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ ...ownership, outcome: z.literal("clipboard"), clipboardConfirmed: z.literal(true) }),
  z.strictObject({ ...ownership, outcome: z.literal("paste"), clipboardConfirmed: z.literal(true) }),
  z.strictObject({ ...ownership, outcome: z.literal("editor"), clipboardConfirmed: z.literal(false) }),
  z.strictObject({ ...ownership, outcome: z.literal("failed"), clipboardConfirmed: z.literal(false) }),
]);
export const recordingEffectFailureSchema = z.enum(["INVALID_FRAME", "OWNERSHIP_FAILED", "DELIVERY_FAILED",
  "CANCELLED", "BUSY", "START_FAILED", "TEARDOWN_FAILED", "WORKER_FAILED", "TIMEOUT", "INVALID_REPLY", "NATIVE_FAILED", "CLOSED"]);
export type RecordingEffectFailureCode = z.infer<typeof recordingEffectFailureSchema>;
export class RecordingEffectError extends Error {
  constructor(readonly code: RecordingEffectFailureCode) { super(`Recording effect: ${code}.`); }
}

/** Internal helper protocol only. Complete audio never crosses it; final delivery text is not a window. */
export const recordingEffectRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...envelope, command: z.literal("infer"), model: speechModelSchema,
    samples: speechWindowSchema, language: speechLanguageSchema, vocabulary: speechVocabularySchema }),
  z.strictObject({ ...envelope, command: z.literal("deliver"), identity: deliveryIdentitySchema,
    // The complete processed transcript can exceed a native-window or optional-preview bound.
    text: z.string().min(1) }).refine((value) => value.identity.kind !== "memory"
      || value.identity.generation === value.generation),
  z.strictObject({ ...envelope, command: z.literal("cancel") }),
]);
export const recordingEffectReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("infer"), text: speechTextSchema }),
  z.strictObject({ ...envelope, kind: z.literal("deliver"), receipt: deliveryReceiptSchema }),
  z.strictObject({ ...envelope, kind: z.literal("failed"), code: recordingEffectFailureSchema }),
]);
export type RecordingEffectRequest = z.infer<typeof recordingEffectRequestSchema>;
export type RecordingEffectReply = z.infer<typeof recordingEffectReplySchema>;

export function safeRecordingEffectError(input: unknown): RecordingEffectError {
  if (input instanceof RecordingEffectError) return input;
  if (typeof input === "object" && input !== null) {
    const code: unknown = Reflect.get(input, "code");
    const parsed = recordingEffectFailureSchema.safeParse(code);
    if (parsed.success) return new RecordingEffectError(parsed.data);
  }
  return new RecordingEffectError("WORKER_FAILED");
}

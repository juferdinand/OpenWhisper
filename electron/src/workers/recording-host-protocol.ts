import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { recordingRequestSchema } from "../core/recording.js";
import { preferencesSchema } from "../contracts/ui.js";
import { speechModelSchema, speechVocabularySchema } from "./native-speech.js";

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const absolute = z.string().min(1).max(4096).refine((path) => isAbsolute(path) && resolve(path) === path && !path.includes("\0"));
const server = z.string().min(6).max(4101).refine((value) => value.startsWith("unix:") && absolute.safeParse(value.slice(5)).success);
export const developmentCaptureDescriptorSchema = z.strictObject({ bytes: z.number().int().positive().max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).readonly();
const envelope = { version: z.literal(1), channel: z.literal("recording-host"), epoch: z.uuid() };
const request = { ...envelope, id: z.uuid() };
const commands = z.enum(["configure", "enumerate-sources", "start", "stop", "cancel", "retry", "discard", "status", "close"]);
export const recordingHostErrorSchema = z.enum(["BUSY", "INVALID_REQUEST", "CALLER_INACTIVE", "START_FAILED", "STOP_FAILED",
  "CAPTURE_FAILED", "CAPTURE_RELEASE_FAILED", "OWNERSHIP_FAILED", "PREPARATION_FAILED", "RECOVERY_PENDING", "RECOVERY_READ_FAILED",
  "RECOVERY_SAVE_FAILED", "RECOVERY_REMOVE_FAILED", "SPEECH_FAILED", "EMPTY_TRANSCRIPT", "DELIVERY_FAILED", "CANCELLED", "NO_RECOVERY",
  "INVALID_FRAME", "UNAVAILABLE", "TEARDOWN_FAILED", "CLOSED"]);
export const recordingHostRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...request, command: z.literal("configure"), capture: developmentCaptureDescriptorSchema, server,
    source: z.string().regex(/^(?:[A-Za-z0-9_.:-]{1,255})?$/u), recoveryPath: absolute,
    request: recordingRequestSchema.unwrap().extend({ model: speechModelSchema.refine((model) => !model.gpu),
      vocabulary: speechVocabularySchema, snippets: preferencesSchema.shape.snippets }) }),
  z.strictObject({ ...request, command: z.literal("enumerate-sources"), capture: developmentCaptureDescriptorSchema, server }),
  ...(["start", "stop", "cancel", "retry", "discard", "status", "close"] as const)
    .map((command) => z.strictObject({ ...request, command: z.literal(command) })),
]);
export const recordingSourceSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/u),
  name: z.string().max(1024).refine((value) => !value.includes("\0")), isDefault: z.boolean() }).readonly();
export const recordingSnapshotSchema = z.strictObject({
  phase: z.enum(["idle", "starting", "recording", "stopping", "transcribing", "restoring", "discarding", "done", "error"]),
  generation: sequence, elapsedMs: z.number().finite().nonnegative(), level: z.number().finite().min(0).max(1),
  busy: z.boolean(), recoveryAvailable: z.boolean(), error: recordingHostErrorSchema.nullable(),
  // Complete final output is not an inference window; no recording/text cutoff is introduced.
  transcript: z.string(),
});
const control = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), generation: sequence }),
  z.strictObject({ ok: z.literal(false), generation: sequence, error: recordingHostErrorSchema })]);
export const recordingHostReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelope, kind: z.literal("ready"), pid: z.number().int().positive().max(0x7fffffff) }),
  z.strictObject({ ...envelope, kind: z.literal("snapshot"), snapshot: recordingSnapshotSchema }),
  z.strictObject({ ...envelope, kind: z.literal("progress"), generation: sequence, attempt: sequence,
    completedSamples: sequence, gpuFallback: z.boolean() }),
  z.strictObject({ ...envelope, kind: z.literal("recovery-removed"), token: z.uuid(), generation: sequence, attempt: sequence }),
  z.strictObject({ ...envelope, kind: z.literal("memory-released"), generation: sequence, attempt: sequence }),
  z.strictObject({ ...request, kind: z.literal("control"), command: commands, reply: control }),
  z.strictObject({ ...request, kind: z.literal("devices"), devices: z.array(recordingSourceSchema).max(128).readonly() }),
  z.strictObject({ ...request, kind: z.literal("failed"), code: recordingHostErrorSchema }),
]);
export type RecordingHostRequest = z.infer<typeof recordingHostRequestSchema>;
export type RecordingHostReply = z.infer<typeof recordingHostReplySchema>;
export type RecordingConfiguration = Extract<RecordingHostRequest, { command: "configure" }>;
export type RecordingEnumeration = Extract<RecordingHostRequest, { command: "enumerate-sources" }>;
export type RecordingSource = z.infer<typeof recordingSourceSchema>;

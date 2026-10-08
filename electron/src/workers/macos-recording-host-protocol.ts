import { z } from "zod";
import { preferencesSchema } from "../contracts/ui.js";
import { recordingRequestSchema } from "../core/recording.js";
import { developmentCaptureDescriptorSchema, recordingHostReplySchema } from "./recording-host-protocol.js";
import { speechModelSchema, speechVocabularySchema } from "./native-speech.js";

const request = { version: z.literal(1), channel: z.literal("recording-host"), epoch: z.uuid(), id: z.uuid() };
/** The normal Mac owner has one default AVFoundation source. No native path, TCC request or disk recovery is configurable. */
export const macRecordingHostRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...request, command: z.literal("configure"), capture: developmentCaptureDescriptorSchema,
    request: recordingRequestSchema.unwrap().extend({ model: speechModelSchema.refine((model) => !model.gpu),
      vocabulary: speechVocabularySchema, snippets: preferencesSchema.shape.snippets }) }),
  ...(["start", "stop", "cancel", "retry", "discard", "status", "close"] as const)
    .map((command) => z.strictObject({ ...request, command: z.literal(command) })),
]);
export const macRecordingHostReplySchema = recordingHostReplySchema;
export type MacRecordingHostRequest = z.infer<typeof macRecordingHostRequestSchema>;
export type MacRecordingConfiguration = Extract<MacRecordingHostRequest, { command: "configure" }>;
export type MacRecordingHostReply = z.infer<typeof macRecordingHostReplySchema>;

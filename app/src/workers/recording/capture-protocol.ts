import { z } from "zod";
import { captureMetadataSchema } from "./native-capture.js";

const envelope = { version: z.literal(1), id: z.string().uuid(), generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
/** Metadata/control only. Raw/prepared audio and native handles never cross this protocol. */
export const captureRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...envelope, command: z.literal("status") }),
  z.strictObject({ ...envelope, command: z.literal("stop") }),
  z.strictObject({ ...envelope, command: z.literal("cancel") }),
]);
export const captureReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...envelope, ok: z.literal(true), value: captureMetadataSchema }),
  z.strictObject({ ...envelope, ok: z.literal(false), code: z.enum(["CAPTURE_FAILED", "OWNERSHIP_FAILED"]) }),
]);
export type CaptureRequest = z.infer<typeof captureRequestSchema>;
export type CaptureReply = z.infer<typeof captureReplySchema>;

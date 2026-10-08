import { z } from "zod";
import { failureSchema } from "../owned-bus-opening/diagnostics.js";

export const asyncCallChecks = [
  "one-worker withheld request permits real daemon UID progress and cancellation",
  "same-turn close retires eight calls before a replacement owner",
  "close retires FD response holders while the JS turn is held",
] as const;
export const asyncCallResultSchema = z.strictObject({
  checks: z.tuple([z.literal(asyncCallChecks[0]), z.literal(asyncCallChecks[1]), z.literal(asyncCallChecks[2])]),
  oneWorker: z.literal(true),
  progressWhilePending: z.literal(true),
  outstandingAfterClose: z.literal(0),
  ownedMemfdsAfterClose: z.literal(0),
});
export const asyncCallDiagnosisSchema = z.strictObject({
  checks: z.array(z.enum(asyncCallChecks)).max(3).refine((checks) => checks.every((check, index) => check === asyncCallChecks[index])),
  operationFailure: failureSchema.nullable(), cleanupFailure: failureSchema.nullable(),
});

import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const caseSchema = z.strictObject({ name: z.enum(["identity-tail", "format-transition", "long-ledger",
  "held-callback", "cancel-race", "allocation-failure", "interruption", "start-rollback", "exceptions"]),
  frames: count, samples: count, sha256: hash.nullable(), referenceSamples: count,
  maximumDifference: z.number().finite().nonnegative(), engineAllocations: z.literal(0), inputNodeOperations: z.literal(0),
  permissionQueries: z.literal(0), permissionRequests: z.literal(0), diskOperations: z.literal(0) });
export const resultSchema = z.strictObject({ fixture: z.literal("macos-capture-result"), platform: z.literal("darwin"),
  architecture: z.enum(["arm64", "x64"]), pid: z.number().int().positive(), nativeScope: z.literal("synthetic-pcm-only"),
  cases: z.array(caseSchema).length(9), noEngineOrPermissionOperations: z.literal(true), noMacAudioDiskRetention: z.literal(true),
  durationRepresentedSeconds: z.literal(305), longInputFrames: z.literal(14_640_017) });
export type CaptureCase = z.infer<typeof caseSchema>;
export type CaptureResult = z.infer<typeof resultSchema>;
export const progressSchema = z.strictObject({ fixture: z.literal("macos-capture-progress"), phase: caseSchema.shape.name });
export const failureSchema = z.strictObject({ fixture: z.literal("macos-capture-failure"), code: z.literal("SYNTHETIC_CAPTURE_FAILED"),
  phase: caseSchema.shape.name.nullable() });
export const envelopeSchema = z.discriminatedUnion("fixture", [resultSchema, failureSchema]);

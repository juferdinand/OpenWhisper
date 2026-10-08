import { z } from "zod";

const count = z.number().int().nonnegative().max(100000);
export const probeStateSchema = z.strictObject({ busy: z.boolean(), closing: z.boolean(), closed: z.boolean(), descriptorOpen: z.boolean(),
  barrierEntered: z.boolean(), exitSeen: z.boolean(), zombieSeen: z.boolean(), queries: count, disposals: count, kernelQueries: count, watchAllocations: count, synthetic: z.boolean(), reserved: count });
export const sdkSchema = z.strictObject({ bsdInfoBytes: z.number().int().positive().max(8192), keventBytes: z.number().int().positive().max(1024),
  zombieLookupArgument: z.literal(1), napiVersion: z.literal(8), probeOnly: z.literal(true), reserved: count,
  environmentCleanups: count, suppressedCompletions: count, totalDisposals: count });
export const readySchema = z.strictObject({ kind: z.literal("ready") });
export const nonceRequestSchema = z.strictObject({ kind: z.literal("challenge"), nonce: z.string().uuid(), epoch: z.string().uuid() });
export const nonceReplySchema = z.strictObject({ kind: z.literal("nonce"), nonce: z.string().uuid(), epoch: z.string().uuid() });
export const retireSchema = z.strictObject({ kind: z.literal("retire") });
export const modeSchema = z.enum(["clean", "nonzero", "delayed", "ignore", "early"]);
export const resultSchema = z.strictObject({ fixture: z.literal("macos-retirement-probe"), architecture: z.enum(["arm64", "x64"]), sdk: sdkSchema,
  runtime: z.strictObject({ node: z.string().regex(/^\d+\.\d+\.\d+$/u), electron: z.string().regex(/^\d+\.\d+\.\d+$/u) }),
  cases: z.array(z.strictObject({ name: z.enum(["clean-exit", "nonzero-exit", "utility-kill", "delayed-sigterm", "ignored-sigterm", "early-exit", "held-observation"]),
    admitted: z.boolean(), originalNonceConfirmed: z.boolean(), sameUid: z.boolean().nullable(), directParent: z.boolean().nullable(),
    helperExitObserved: z.literal(true), noteExitObserved: z.boolean(), zombieObserved: z.boolean(), fullReapConfirmed: z.literal(true),
    nativeQueries: count, watchAllocations: count, observerDisposals: z.literal(1), reservedAfterDisposal: z.literal(0),
    deadlineRetainedOwner: z.boolean(), refusedSecondOwner: z.boolean(), retirementMilliseconds: z.number().finite().nonnegative().max(20000) })).length(7),
  workerCleanup: z.strictObject({ syntheticOnly: z.literal(true), kernelQueries: z.literal(0), watchAllocations: z.literal(0),
    barrierEntered: z.literal(true), workerExitObserved: z.literal(true), environmentCleanupObserved: z.literal(true),
    javascriptSettlementSuppressed: z.literal(true), disposalConfirmed: z.literal(true), reservedAfterDisposal: z.literal(0),
    terminateMilliseconds: z.number().finite().nonnegative().max(10000), actualKernelCancellationBound: z.literal(false) }),
  rendererCreated: z.literal(false), microphoneOperations: z.literal(0), permissionOperations: z.literal(0),
  productionFactoriesChanged: z.literal(false), productionArchitectureSelected: z.literal(false), deterministicZombieExercised: z.literal(false) });
export type ProbeResult = z.infer<typeof resultSchema>;

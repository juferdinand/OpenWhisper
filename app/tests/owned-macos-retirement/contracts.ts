import { z } from "zod";

const count = z.number().int().nonnegative().max(100000);
export const probeStateSchema = z.strictObject({ busy: z.boolean(), closing: z.boolean(), closed: z.boolean(), descriptorOpen: z.boolean(),
  barrierEntered: z.boolean(), exitSeen: z.boolean(), zombieSeen: z.boolean(), queries: count, disposals: count, kernelQueries: count, watchAllocations: count, synthetic: z.boolean(), reserved: count });
export const sdkSchema = z.strictObject({ bsdInfoBytes: z.number().int().positive().max(8192), keventBytes: z.number().int().positive().max(1024),
  zombieLookupArgument: z.literal(1), napiVersion: z.literal(8), probeOnly: z.literal(true), reserved: count,
  environmentCleanups: count, suppressedCompletions: count, totalDisposals: count,
  queryCompletions: count, completionsBeforeCleanup: count });
export const completionOrderSchema = z.enum(["drain-before-hook", "hook-flag-suppressed"]);
/** Both measured completion paths retain the exact cleanup/resource gates. */
export function completionOrder(before: z.infer<typeof sdkSchema>, after: z.infer<typeof sdkSchema>, lateFrames: number): z.infer<typeof completionOrderSchema> {
  const completed = after.queryCompletions - before.queryCompletions;
  const preHook = after.completionsBeforeCleanup - before.completionsBeforeCleanup;
  const postHook = after.suppressedCompletions - before.suppressedCompletions;
  if (completed !== 1 || preHook < 0 || postHook < 0 || preHook + postHook !== 1 || lateFrames !== 0 ||
    after.environmentCleanups !== before.environmentCleanups + 1 || after.totalDisposals !== before.totalDisposals + 1 || after.reserved !== 0)
    throw new Error("PROBE_FAILED");
  return preHook === 1 ? "drain-before-hook" : "hook-flag-suppressed";
}
export const workerBarrierSchema = z.strictObject({ kind: z.literal("barrier-entered"), state: probeStateSchema }).refine(({ state }) =>
  state.synthetic && state.busy && state.barrierEntered && !state.closing && !state.closed && !state.descriptorOpen &&
  state.kernelQueries === 0 && state.watchAllocations === 0 && state.queries === 0 && state.disposals === 0 && state.reserved === 1);
/** A continuous observer retains categorical state only. The pinned Worker
 * contract emits every sent message before exit; no late frame is discarded. */
export class WorkerFrames {
  private state: z.infer<typeof probeStateSchema> | undefined;
  private failed = false;
  frameCount = 0; lateFrames = 0;
  receive(input: unknown): "barrier" | "invalid" | "late" {
    this.frameCount = Math.min(16, this.frameCount + 1);
    if (this.state) { this.lateFrames = Math.min(16, this.lateFrames + 1); this.failed = true; return "late"; }
    if (this.failed) return "invalid";
    const parsed = workerBarrierSchema.safeParse(input);
    if (!parsed.success) { this.failed = true; return "invalid"; }
    this.state = parsed.data.state; return "barrier";
  }
  invalidate(): void { this.failed = true; }
  get invalid(): boolean { return this.failed; }
  get barrier(): z.infer<typeof probeStateSchema> | undefined { return this.state; }
  assertClean(): z.infer<typeof probeStateSchema> {
    if (this.failed || !this.state || this.frameCount !== 1 || this.lateFrames !== 0) throw new Error("PROBE_FAILED"); return this.state;
  }
}
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
    completionOrder: completionOrderSchema, lateJavaScriptReplyObserved: z.literal(false), workerFramesObserved: z.literal(1),
    queryCompletionsObserved: z.literal(1), disposalConfirmed: z.literal(true), reservedAfterDisposal: z.literal(0),
    terminateMilliseconds: z.number().finite().nonnegative().max(10000), actualKernelCancellationBound: z.literal(false) }),
  rendererCreated: z.literal(false), microphoneOperations: z.literal(0), permissionOperations: z.literal(0),
  productionFactoriesChanged: z.literal(false), productionArchitectureSelected: z.literal(false), deterministicZombieExercised: z.literal(false) });
export type ProbeResult = z.infer<typeof resultSchema>;

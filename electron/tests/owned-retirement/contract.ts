import { z } from "zod";
import type { InitialRetirementObservation, ProcessRetirementLevel } from "../../src/services/process-retirement.js";

export const EXPECTED_WITNESS_SHA256 = "a282f34645d4f86029a8475a6dde9159e6d7ed559e094211dcceb3d7dac0abda";
export const IMAGE = "sha256:3031f986bb255608939c32b3929435c929efb4ce9be398786e369b1111d73431";
export const SECCOMP_SHA256 = "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e";
export const MAX_FRAME_BYTES = 2048;
export const pidSchema = z.number().int().positive().max(0x7fff_ffff);
export const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const nonceSchema = shaSchema;
export const epochSchema = z.string().uuid();
export const birthSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u).refine((value) => BigInt(value) <= (1n << 64n) - 1n);
export const runtimeSchema = z.enum(["node", "electron"]);
export const suiteSchema = z.enum(["lifecycle", "held-reader"]);
export const childModeSchema = z.enum(["normal", "delayed-term"]);
export const actionSchema = z.enum(["exit", "abort", "schedule-exit"]);
const common = { version: z.literal(1), epoch: epochSchema, nonce: nonceSchema };
export const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("challenge") }),
  z.strictObject({ ...common, kind: z.literal("action"), action: actionSchema }),
]);
export const identitySchema = z.strictObject({ ...common, kind: z.literal("identity"),
  pid: pidSchema, uid: z.literal(1000), parentPid: pidSchema, startTicks: birthSchema, mode: childModeSchema });
export const replySchema = z.discriminatedUnion("kind", [identitySchema,
  z.strictObject({ ...common, kind: z.literal("ack"), action: actionSchema }),
]);
export type Request = z.infer<typeof requestSchema>;
export type Reply = z.infer<typeof replySchema>;
export type IdentityReply = z.infer<typeof identitySchema>;
export type Runtime = z.infer<typeof runtimeSchema>;
export type Suite = z.infer<typeof suiteSchema>;
export type ChildMode = z.infer<typeof childModeSchema>;
export type Action = z.infer<typeof actionSchema>;
export class FixtureError extends Error { constructor() { super("Owned retirement fixture failed."); this.name = "FixtureError"; } }
export const caseNameSchema = z.enum(["self-exit", "owned-term", "self-abort", "delayed-term", "held-close"]);
export type CaseName = z.infer<typeof caseNameSchema>;
export function expectedExitMatches(runtime: Runtime, name: CaseName, code: number | null, signal: string | null): boolean {
  // https://github.com/electron/electron/blob/v44.7.0/shell/browser/api/electron_api_utility_process.cc#L300-L314
  // Electron normalizes owned SIGTERM/SIGKILL to code 0; Node exposes the signal.
  if (name === "self-exit" || name === "delayed-term" || name === "held-close" ||
    (runtime === "electron" && name === "owned-term")) return code === 0 && signal === null;
  return code !== 0 || signal !== null;
}
export const probeStageSchema = z.enum(["case-start", "held-observation", "held-closure", "allocation-refusal",
  "action-challenge", "action-confirmation", "schedule-exit", "termination-request", "child-action",
  "wait-retirement", "wait-runtime-exit", "kernel-retirement", "retirement-fence", "sticky-observation",
  "settle-reads", "exit-validation", "complete-progress"]);
export type ProbeStage = z.infer<typeof probeStageSchema>;
const diagnosticSignalSchema = z.enum(["SIGTERM", "SIGKILL", "SIGABRT", "OTHER"]).nullable();
export function diagnosticSignal(signal: string | null): z.infer<typeof diagnosticSignalSchema> {
  return signal === null || signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGABRT" ? signal : "OTHER";
}
export const probeFailureSchema = z.strictObject({ category: z.literal("PROBE_CASE_FAILED"), runtime: runtimeSchema, suite: suiteSchema,
  case: caseNameSchema, stage: probeStageSchema, level: z.enum(["running", "non-running", "reaped", "ambiguous"]),
  exitObserved: z.boolean(), exitCode: z.number().int().min(-0x8000_0000).max(0xffff_ffff).nullable(), exitSignal: diagnosticSignalSchema });
export class ProbeFailure extends FixtureError {
  readonly metadata: z.infer<typeof probeFailureSchema>;
  constructor(input: unknown) { super(); this.metadata = probeFailureSchema.parse(input); }
}
export function probeFailureMetadata(error: unknown) { return error instanceof ProbeFailure ? error.metadata : {}; }
export function boundedFrame(input: unknown): unknown {
  try { const serialized = JSON.stringify(input); if (!serialized || Buffer.byteLength(serialized) > MAX_FRAME_BYTES) throw new FixtureError(); }
  catch { throw new FixtureError(); } return input;
}
export function parseRequest(input: unknown): Request { return requestSchema.parse(boundedFrame(input)); }
export function parseReply(input: unknown): Reply { return replySchema.parse(boundedFrame(input)); }
export function confirmAdmission(before: IdentityReply, initial: InitialRetirementObservation, after: IdentityReply,
  expected: Readonly<{ pid: number; parentPid: number; epoch: string; mode: ChildMode }>): void {
  const bound = initial.identity;
  if (!initial.canAdmit || initial.level !== "running" || !bound || before.nonce === after.nonce) throw new FixtureError();
  for (const reply of [before, after]) {
    if (reply.epoch !== expected.epoch || reply.pid !== expected.pid || reply.parentPid !== expected.parentPid || reply.uid !== 1000 ||
      reply.mode !== expected.mode || reply.startTicks !== bound.startTicks.toString() || bound.pid !== expected.pid ||
      bound.parentPid !== expected.parentPid || bound.uid !== 1000 || bound.epoch !== expected.epoch) throw new FixtureError();
  }
}

/** Fixture-only continuing parent fence. Failure cannot be reset by a new epoch. */
export class AllocationFence {
  private state: "free" | "live" | "failed" = "free";
  private count = 0;
  reserve(): void { if (this.state !== "free") throw new FixtureError(); this.state = "live"; this.count++; }
  retired(level: ProcessRetirementLevel): void {
    if (this.state !== "live" || level !== "reaped") { this.poison(); throw new FixtureError(); } this.state = "free";
  }
  poison(): void { this.state = "failed"; }
  get spawnCount(): number { return this.count; }
  get failed(): boolean { return this.state === "failed"; }
}

const levelSchema = z.enum(["running", "non-running", "reaped", "ambiguous"]);
export const observationSchema = z.strictObject({ atMs: z.number().finite().nonnegative(), level: levelSchema });
export const caseSchema = z.strictObject({ name: caseNameSchema,
  pid: pidSchema, parentPid: pidSchema, uid: z.literal(1000), epoch: epochSchema, startTicks: birthSchema,
  nonceHashes: z.array(shaSchema).min(2).max(8), admitted: z.literal(true), exitObserved: z.boolean(),
  exitCode: z.number().int().nullable(), exitSignal: z.string().max(20).nullable(),
  exitAtMs: z.number().finite().nonnegative().nullable(),
  observations: z.array(observationSchema).max(2048), zombie: z.enum(["OBSERVED", "NOT_OBSERVED"]),
  kernelAbsentAfterExit: z.boolean(), retiredBy: z.enum(["absence", "different-birth"]).nullable(), poisoned: z.boolean(), replacementRefused: z.boolean(),
  actualDescriptorHeld: z.boolean(), descriptorClosed: z.boolean(), queuedBarrierSettledEarly: z.boolean(),
  spawnCount: z.number().int().nonnegative().max(8), runtimePidUnsetAfterExit: z.boolean() });
export const resultSchema = z.strictObject({ version: z.literal(1), status: z.literal("PASS"), runtime: runtimeSchema, suite: suiteSchema,
  startedAtUtc: z.iso.datetime(), finishedAtUtc: z.iso.datetime(), parentPid: pidSchema, uid: z.literal(1000),
  cases: z.array(caseSchema).min(1).max(4), versions: z.record(z.string().max(64), z.string().max(128)),
  scope: z.literal("Owned inert Linux child/procfs lifetime only; no factory, native, speech, capture, inventory, macOS or device proof.") });
export type CaseResult = z.infer<typeof caseSchema>;
export type ProbeResult = z.infer<typeof resultSchema>;

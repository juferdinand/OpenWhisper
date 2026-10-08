import assert from "node:assert/strict";
import { z } from "zod";
import { speechEntryGraphSchema } from "../../src/services/speech-entry-graph.js";
import { fileInventorySchema, mainIdentitySchema, shaSchema, CPU_SHA256, CPU_BUILD_MANIFEST_SHA256,
  ELECTRON_SHA256, NODE_SHA256, SECCOMP_SHA256, MODEL_SHA256, PCM_SHA256 } from "../owned-supervisor/contract.js";

export { fileInventorySchema, mainIdentitySchema, CPU_SHA256, CPU_BUILD_MANIFEST_SHA256, ELECTRON_SHA256, NODE_SHA256, SECCOMP_SHA256, MODEL_SHA256, PCM_SHA256 };
export const VULKAN_SHA256 = "84797393e5a1efb453945c32a26a7d4158490e53074dcd2fdbacc47b887dff05";
export const VULKAN_MANIFEST_SHA256 = "4e0c262554e1c8b42b1641577cf752760af912cd38f46fd1a2c72fbafffcc8a0";
export const LOADER = Object.freeze({ file: "libvulkan.so.1", bytes: 2483336, sha256: "951c832a600fd72fc0eff1a42b8e251e81ea200a62499e74c86d4aeb3646aa34" });
export const PROFILE_IMAGES = Object.freeze({ "loader-present": "sha256:e2d225c9201932883e976e1f71ce1a9ceaae79ada0b6b60ce48efb93bd4cb6f5",
  "loader-absent": "sha256:e2c352a85dc7813dcb920c94abff62b0edef493a40098db76de032187e819310" });
export const profileSchema = z.enum(["loader-present", "loader-absent"]);
export type Profile = z.infer<typeof profileSchema>;
export const HOME = "/home/tester/supervisor-fallback-home", PROFILE_ROOT = `${HOME}/dev-profile`, MAX_METADATA_BYTES = 512 * 1024;
export class FixtureError extends Error { constructor() { super("Owned supervisor fallback fixture failed."); } }
export const catalog = Object.freeze({ version: 1, platform: "linux", architecture: "x64", napiVersion: 8,
  speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a", speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
  entries: [{ backend: "cpu", bytes: 2389936, sha256: CPU_SHA256 }, { backend: "vulkan", bytes: 58805392, sha256: VULKAN_SHA256 }] });
export const buildManifestSchema = z.strictObject({ version: z.literal(1), mode: z.literal("fallback"), sources: fileInventorySchema, payloadFiles: fileInventorySchema,
  graph: speechEntryGraphSchema, nativeManifests: z.strictObject({ cpu: z.literal(CPU_BUILD_MANIFEST_SHA256), vulkan: z.literal(VULKAN_MANIFEST_SHA256) }),
  originalRuntimeFiles: fileInventorySchema, absentRuntimeFiles: fileInventorySchema,
  packages: z.strictObject({ electron: z.literal("44.7.0"), zod: z.literal("4.6.5"), typescript: z.literal("7.0.2"), esbuild: z.literal("0.28.2") }) });
export type BuildManifest = z.infer<typeof buildManifestSchema>;
export const inputSchema = z.strictObject({ version: z.literal(1), profile: profileSchema, build: buildManifestSchema,
  seccompSha256: z.literal(SECCOMP_SHA256), electronSha256: z.literal(ELECTRON_SHA256), nodeSha256: z.literal(NODE_SHA256) });
export function validateRuntimeDerivative(originalInput: unknown, absentInput: unknown): void {
  const original = fileInventorySchema.parse(originalInput), absent = fileInventorySchema.parse(absentInput);
  assert.deepEqual(original[LOADER.file], { bytes: LOADER.bytes, sha256: LOADER.sha256 });
  assert.equal(original.electron?.sha256, ELECTRON_SHA256);
  const expected = Object.fromEntries(Object.entries(original).filter(([name]) => name !== LOADER.file)); assert.deepEqual(absent, expected);
}
export const eventSchema = z.enum(["verify", "owner-open", "challenge", "bind-running", "observe-running", "observe-non-running", "observe-reaped", "observe-ambiguous",
  "command-discover", "reply-discover-none", "reply-discover-software", "reply-discover-device", "reply-start-failed", "command-transcribe", "command-shutdown", "terminate",
  "wait-retired", "reads-settled", "current-reaped", "job-closed", "lease-released"]);
export type Event = z.infer<typeof eventSchema>;
export const traceSchema = z.strictObject({ order: z.number().int().positive().max(512), job: z.number().int().min(1).max(3), event: eventSchema,
  backend: z.enum(["cpu", "vulkan"]).nullable(), epoch: z.uuid().nullable() });
export type Trace = z.infer<typeof traceSchema>;
// Incidental ordinary listener observation only: SpeechClient may detach it before termination.
// Admission and retirement still require the original nonce/kernel/read/current trace fences below.
export const ownerSchema = z.strictObject({ job: traceSchema.shape.job, backend: z.enum(["cpu", "vulkan"]), pid: mainIdentitySchema.shape.pid, parentPid: mainIdentitySchema.shape.pid,
  uid: z.literal(1000), epoch: z.uuid(), startTicks: mainIdentitySchema.shape.startTicks, nonceHashes: z.array(shaSchema).min(2).max(8), genericExitObserved: z.boolean() });
const selection = z.strictObject({ backend: z.literal("cpu"), requestedGpu: z.boolean(), gpu: z.literal(false), detection: z.enum(["none", "unavailable"]) });
export const jobSchema = z.strictObject({ ordinal: traceSchema.shape.job, selection, outputSha256: shaSchema,
  outputBytes: z.number().int().positive().max(1024 * 1024), modelIdentityHash: shaSchema, leaseReleased: z.literal(true) });
export const preflightSchema = z.discriminatedUnion("profile", [
  z.strictObject({ version: z.literal(1), profile: z.literal("loader-present"), status: z.literal("PASS"), cpuDevices: z.number().int().min(1).max(64), nonCpuDevices: z.literal(0),
    stdoutBytes: z.number().int().positive().max(1024 * 1024), stdoutSha256: shaSchema, stderrBytes: z.number().int().nonnegative().max(1024 * 1024), code: z.literal(0) }),
  z.strictObject({ version: z.literal(1), profile: z.literal("loader-absent"), status: z.literal("PASS"), checkedSystemPaths: z.literal(4), existingSystemPaths: z.literal(0), bundledLoaderPresent: z.literal(false) }),
]);
export const resultSchema = z.strictObject({ version: z.literal(1), status: z.literal("PASS"), profile: profileSchema, main: mainIdentitySchema,
  startedAtUtc: z.iso.datetime(), finishedAtUtc: z.iso.datetime(), owners: z.array(ownerSchema).length(4), jobs: z.array(jobSchema).length(3), trace: z.array(traceSchema).max(512),
  scope: z.literal("Owned Linux automatic pre-inference Vulkan-to-CPU selection only; no physical GPU, capture, delivery, macOS, desktop or release-package parity.") });
export type Result = z.infer<typeof resultSchema>;
export const predicateSchema = z.enum(["RESULT_SCHEMA", "JOB_SEQUENCE", "OWNER_SEQUENCE", "MANUAL_CPU_POLICY", "REQUESTED_GPU_POLICY", "OUTPUT_MODEL_MATCH",
  "OWNER_EPOCH_BIRTH_UNIQUE", "TRACE_SEQUENCE_OWNERSHIP", "GLOBAL_NONCE_UNIQUE", "OWNER_PARENT_NONCES", "OWNER_ADMISSION_ORDER", "OWNER_RETIREMENT_ORDER",
  "OWNER_COMMAND_COUNTS", "OWNER_DISCOVERY_CATEGORY", "GPU_CPU_RETIREMENT_FENCE", "VERIFICATION_SEQUENCE", "JOB_CLOSE_LEASE_FENCE", "NEXT_JOB_FENCE",
  "FINAL_MAIN_OBSERVATION", "FINAL_MAIN_IDENTITY", "DIAGNOSTIC_SCHEMA", "DIAGNOSTIC_SIZE", "DIAGNOSTIC_WRITE"]);
export type Predicate = z.infer<typeof predicateSchema>;
const ownerIndexSchema = z.number().int().min(1).max(4).nullable(), jobIndexSchema = z.number().int().min(1).max(3).nullable();
export const failureMetadataSchema = z.strictObject({ predicate: z.union([predicateSchema, z.literal("COMPOSITION_OR_FIXTURE_FAILED")]), ownerIndex: ownerIndexSchema, jobIndex: jobIndexSchema });
/** Fixed metadata only; no cause, native message, stack or Zod issue is retained. */
export class DiagnosticError extends FixtureError {
  readonly predicate: Predicate; readonly ownerIndex: number | null; readonly jobIndex: number | null;
  constructor(predicate: Predicate, ownerIndex: number | null = null, jobIndex: number | null = null) {
    super(); this.predicate = predicateSchema.parse(predicate); this.ownerIndex = ownerIndexSchema.parse(ownerIndex); this.jobIndex = jobIndexSchema.parse(jobIndex);
  }
}
export function failureMetadata(error: unknown) {
  return failureMetadataSchema.parse(error instanceof DiagnosticError
    ? { predicate: error.predicate, ownerIndex: error.ownerIndex, jobIndex: error.jobIndex }
    : { predicate: "COMPOSITION_OR_FIXTURE_FAILED", ownerIndex: null, jobIndex: null });
}
/** Annotates the existing predicate; never substitutes or accepts a failed check. */
export function checkPredicate<T>(predicate: Predicate, ownerIndex: number | null, jobIndex: number | null, operation: () => T): T {
  try { return operation(); } catch { throw new DiagnosticError(predicate, ownerIndex, jobIndex); }
}
export const mainDiagnosticSchema = z.strictObject({ status: z.literal("CANDIDATE_NOT_ACCEPTED"), main: mainIdentitySchema });
// Candidate persistence never grants PASS or replaces the normal admission/retirement validation.
export const candidateSchema = resultSchema.omit({ status: true }).extend({ status: z.literal("CANDIDATE_NOT_ACCEPTED"),
  owners: z.array(ownerSchema.extend({ genericExitObserved: z.boolean() })).length(4) });
export function boundedDiagnosticJson(serialized: string): string {
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) throw new DiagnosticError("DIAGNOSTIC_SIZE"); return serialized;
}
export function serializeMainDiagnostic(input: unknown): string {
  return boundedDiagnosticJson(JSON.stringify(checkPredicate("DIAGNOSTIC_SCHEMA", null, null, () => mainDiagnosticSchema.parse(input))));
}
export function serializeCandidate(input: unknown): string {
  return boundedDiagnosticJson(JSON.stringify(checkPredicate("DIAGNOSTIC_SCHEMA", null, null, () => candidateSchema.parse(input)), null, 2));
}
export function validateResult(input: unknown): Result {
  const result = checkPredicate("RESULT_SCHEMA", null, null, () => resultSchema.parse(input));
  const { first, middle, last } = checkPredicate("JOB_SEQUENCE", null, null, () => {
    const [first, middle, last] = result.jobs; assert.ok(first && middle && last); return { first, middle, last };
  });
  checkPredicate("JOB_SEQUENCE", null, null, () => { assert.deepEqual(result.jobs.map((job) => job.ordinal), [1, 2, 3]); });
  checkPredicate("OWNER_SEQUENCE", null, null, () => { assert.deepEqual(result.owners.map((owner) => [owner.job, owner.backend]), [[1, "cpu"], [2, "vulkan"], [2, "cpu"], [3, "cpu"]]); });
  checkPredicate("MANUAL_CPU_POLICY", null, null, () => { assert.deepEqual(first.selection, { backend: "cpu", requestedGpu: false, gpu: false, detection: "none" }); assert.deepEqual(last.selection, first.selection); });
  checkPredicate("REQUESTED_GPU_POLICY", null, 2, () => { assert.deepEqual(middle.selection, { backend: "cpu", requestedGpu: true, gpu: false, detection: result.profile === "loader-present" ? "none" : "unavailable" }); });
  checkPredicate("OUTPUT_MODEL_MATCH", null, null, () => { assert.ok(result.jobs.every((job) => job.outputSha256 === first.outputSha256 && job.outputBytes === first.outputBytes && job.modelIdentityHash === first.modelIdentityHash)); });
  checkPredicate("OWNER_EPOCH_BIRTH_UNIQUE", null, null, () => {
    assert.equal(new Set(result.owners.map((owner) => owner.epoch)).size, 4);
    assert.equal(new Set(result.owners.map((owner) => `${owner.pid}\0${owner.startTicks}`)).size, 4);
  });
  checkPredicate("TRACE_SEQUENCE_OWNERSHIP", null, null, () => { result.trace.forEach((entry, index) => {
    assert.equal(entry.order, index + 1); if (entry.epoch) {
      const owner = result.owners.find((candidate) => candidate.epoch === entry.epoch); assert.ok(owner && owner.job === entry.job && owner.backend === entry.backend);
    } else assert.ok(entry.event === "verify" || entry.event === "job-closed" || entry.event === "lease-released");
  }); });
  checkPredicate("GLOBAL_NONCE_UNIQUE", null, null, () => { assert.equal(new Set(result.owners.flatMap((owner) => owner.nonceHashes)).size, result.owners.reduce((sum, owner) => sum + owner.nonceHashes.length, 0)); });
  for (const [index, owner] of result.owners.entries()) {
    checkPredicate("OWNER_PARENT_NONCES", index + 1, owner.job, () => { assert.equal(owner.parentPid, result.main.pid); assert.equal(new Set(owner.nonceHashes).size, owner.nonceHashes.length); });
    const entries = result.trace.filter((entry) => entry.epoch === owner.epoch), events = entries.map((entry) => entry.event);
    const challenge = events.indexOf("challenge"), bind = events.indexOf("bind-running"), second = events.indexOf("challenge", challenge + 1), running = events.indexOf("observe-running", second + 1);
    const work = events.indexOf(owner.backend === "vulkan" ? "command-discover" : "command-transcribe");
    const opened = events.indexOf("owner-open"), verified = result.trace.find((entry) => entry.event === "verify" && entry.job === owner.job && entry.backend === owner.backend);
    checkPredicate("OWNER_ADMISSION_ORDER", index + 1, owner.job, () => {
      assert.ok(verified && entries[opened] && verified.order < entries[opened].order && opened >= 0 && challenge > opened);
      assert.ok(challenge >= 0 && bind > challenge && second > bind && running > second && work > running);
    });
    const retired = events.indexOf("wait-retired"), reaped = events.indexOf("observe-reaped", retired + 1), reads = events.indexOf("reads-settled"), final = events.indexOf("current-reaped");
    checkPredicate("OWNER_RETIREMENT_ORDER", index + 1, owner.job, () => { assert.ok(retired > work && reaped > retired && reads > reaped && final > reads); });
    checkPredicate("OWNER_COMMAND_COUNTS", index + 1, owner.job, () => {
      assert.equal(events.filter((event) => event === "command-discover").length, owner.backend === "vulkan" ? 1 : 0);
      assert.equal(events.filter((event) => event === "command-transcribe").length, owner.backend === "cpu" ? 1 : 0);
    });
    checkPredicate("OWNER_DISCOVERY_CATEGORY", index + 1, owner.job, () => { if (owner.backend === "vulkan") assert.ok(events.includes(result.profile === "loader-present" ? "reply-discover-none" : "reply-start-failed")); });
  }
  const { gpu } = checkPredicate("GPU_CPU_RETIREMENT_FENCE", null, 2, () => {
    const gpu = result.owners[1], cpu = result.owners[2]; assert.ok(gpu && cpu); return { gpu, cpu };
  });
  const gpuFinal = result.trace.find((entry) => entry.epoch === gpu.epoch && entry.event === "current-reaped");
  const cpuVerify = result.trace.find((entry) => entry.job === 2 && entry.backend === "cpu" && entry.event === "verify");
  checkPredicate("GPU_CPU_RETIREMENT_FENCE", null, 2, () => { assert.ok(gpuFinal && cpuVerify && cpuVerify.order > gpuFinal.order); });
  checkPredicate("VERIFICATION_SEQUENCE", null, null, () => { assert.deepEqual(result.trace.filter((entry) => entry.event === "verify").map((entry) => [entry.job, entry.backend]), [[1, "cpu"], [2, "vulkan"], [2, "cpu"], [3, "cpu"]]); });
  for (const job of result.jobs) {
    const closed = result.trace.find((entry) => entry.job === job.ordinal && entry.event === "job-closed"), released = result.trace.find((entry) => entry.job === job.ordinal && entry.event === "lease-released");
    const lastFinal = result.trace.filter((entry) => entry.job === job.ordinal && entry.event === "current-reaped").at(-1);
    const checkedRelease = checkPredicate("JOB_CLOSE_LEASE_FENCE", null, job.ordinal, () => { assert.ok(lastFinal && closed && released && closed.order > lastFinal.order && released.order > closed.order); return released; });
    const next = result.trace.find((entry) => entry.job === job.ordinal + 1);
    checkPredicate("NEXT_JOB_FENCE", null, job.ordinal, () => { if (next) assert.ok(next.order > checkedRelease.order); });
  }
  return result;
}

export function classifyCommandCompletion(input: { end: number; closedAt: number; exitCode: number | null; expired: boolean; overflow: boolean; errored: boolean }) {
  assert.ok(Number.isFinite(input.end) && Number.isFinite(input.closedAt)); const expired = input.expired || input.closedAt >= input.end;
  return { code: expired || input.overflow || input.errored ? 1 : input.exitCode ?? 1, expired, overflow: input.overflow, errored: input.errored };
}
interface OriginalCommandEvents { on(event: "error", listener: () => void): unknown; once(event: "close", listener: (code: number | null) => void): unknown }
/** A categorical error never releases original CLI/stdio ownership before close. */
export function waitForOriginalCommandClose(child: OriginalCommandEvents, end: number,
  flags: () => { expired: boolean; overflow: boolean }, clock: () => number = () => performance.now()) {
  return new Promise<ReturnType<typeof classifyCommandCompletion>>((accept) => {
    let errored = false; child.on("error", () => { errored = true; });
    child.once("close", (exitCode) => { accept(classifyCommandCompletion({ end, closedAt: clock(), exitCode, ...flags(), errored })); });
  });
}

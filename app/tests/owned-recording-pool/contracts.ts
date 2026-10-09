import assert from "node:assert/strict";
import { z } from "zod";
import { speechEntryGraphSchema } from "../../src/services/speech/speech-entry-graph.js";
import { speechModelSchema } from "../../src/workers/speech/native-speech.js";
import { fileInventorySchema, shaSchema, mainIdentitySchema, eventSchema,
  IMAGE, SECCOMP_SHA256, ELECTRON_SHA256, NODE_SHA256, CPU_SHA256, CPU_BUILD_MANIFEST_SHA256,
  MODEL_SHA256, PCM_SHA256, cpuCatalog } from "../owned-supervisor/contract.js";
import { SAMPLE_COUNT, EXPANSION, modeSchema, phaseSchema, resultSchema as workerResultSchema,
  readySchema } from "../owned-recording/contracts.js";

export { IMAGE, SECCOMP_SHA256, ELECTRON_SHA256, NODE_SHA256, CPU_SHA256, CPU_BUILD_MANIFEST_SHA256,
  MODEL_SHA256, PCM_SHA256, cpuCatalog, fileInventorySchema, mainIdentitySchema,
  SAMPLE_COUNT, EXPANSION, modeSchema, phaseSchema, workerResultSchema, readySchema };
export type { FixtureMode, FixturePhase, FixtureResult } from "../owned-recording/contracts.js";
export const HOME = "/home/tester/recording-pool-home";
export const PROFILE = `${HOME}/dev-profile`;
export const RECOVERY = `${PROFILE}/data/recovery`;
export const MODEL = `${PROFILE}/data/models/ggml-tiny.bin`;
export const CAPTURE_SHA256 = "68050249bc5c419f6a20b8715bb8461eafb8f1a90ba751e45adade4a4b71f67c";
export const MAIN_MS = 330_000;
export const EPOCH_MS = 90_000;
export const CLEANUP_MS = 15_000;
export const APPLICATION_MS = 350_000;
export const RECORDING_ENVIRONMENT_KEY = "OPENWHISPER_OWNED_RECORDING_POOL";
/** Electron preserves its leading switches when loading the fixed app entry. */
export function parseElectronFixtureArguments(argv: readonly string[]): string {
  return z.tuple([z.literal("/owned-runtime/electron/electron"), z.literal("--disable-gpu"),
    z.literal("--disable-dev-shm-usage"), z.literal("/payload/main.mjs"), shaSchema]).parse(argv)[4];
}
export const selectionSchema = speechModelSchema.refine((model) => model.path === MODEL && model.family === "whisper" && !model.gpu);
export const runSchema = z.strictObject({ version: z.literal(1), fixture: z.literal("recording-pool-run"),
  epoch: z.uuid(), model: selectionSchema });
export const buildManifestSchema = z.strictObject({ version: z.literal(1), mode: z.literal("recording-pool-cpu"),
  sources: fileInventorySchema, payloadFiles: fileInventorySchema, graph: speechEntryGraphSchema,
  cpuBuildManifestSha256: z.literal(CPU_BUILD_MANIFEST_SHA256), captureSha256: z.literal(CAPTURE_SHA256),
  packages: z.strictObject({ electron: z.literal("44.7.0"), zod: z.literal("4.6.5"), typescript: z.literal("7.0.2"), esbuild: z.literal("0.28.2") }) });
export type BuildManifest = z.infer<typeof buildManifestSchema>;
export const inputSchema = z.strictObject({ version: z.literal(1), mode: z.literal("recording-pool-cpu"), image: z.literal(IMAGE),
  seccompSha256: z.literal(SECCOMP_SHA256), electronSha256: z.literal(ELECTRON_SHA256), nodeSha256: z.literal(NODE_SHA256),
  build: buildManifestSchema, runtimeFiles: fileInventorySchema });
export const processReceiptSchema = z.strictObject({ pid: mainIdentitySchema.shape.pid, parentPid: mainIdentitySchema.shape.pid,
  uid: z.literal(1000), epoch: z.uuid(), startTicks: mainIdentitySchema.shape.startTicks,
  nonceHashes: z.array(shaSchema).min(2).max(8), events: z.array(eventSchema).max(128),
  genericExitObserved: z.boolean(), leaseChecks: z.number().int().min(2).max(32),
  fullReapAndReadsConfirmed: z.literal(true) });
export type ProcessReceipt = z.infer<typeof processReceiptSchema>;
export const epochSchema = z.strictObject({ mode: modeSchema, epoch: z.uuid(), capturePid: mainIdentitySchema.shape.pid,
  captureExitObserved: z.literal(true), captureExitIsKernelReapProof: z.literal(false),
  phases: z.array(phaseSchema).max(128), result: workerResultSchema.nullable(),
  inferenceWindows: z.array(z.number().int().positive().max(480_000)).min(2).max(32), coverage: z.literal(SAMPLE_COUNT),
  brokerCloseConfirmed: z.literal(true), factoryUsesExactInventoryAndSupervisor: z.literal(true),
  process: processReceiptSchema, confirmedReplyDropped: z.boolean(), wireBuffersExclusive: z.literal(true),
  malformedMainViewsRejectedBeforeAcquisition: z.literal(true) });
export type Epoch = z.infer<typeof epochSchema>;
export function validateProcessReceipt(input: unknown, windowCount: number, parentPid: number): ProcessReceipt {
  const receipt = processReceiptSchema.parse(input);
  assert.equal(receipt.parentPid, parentPid); assert.equal(new Set(receipt.nonceHashes).size, receipt.nonceHashes.length);
  const first = receipt.events.indexOf("challenge"), bind = receipt.events.indexOf("bind-running"), second = receipt.events.indexOf("challenge", first + 1);
  const running = receipt.events.indexOf("observe-running", second + 1), infer = receipt.events.indexOf("command-transcribe");
  assert.ok(first >= 0 && bind > first && second > bind && running > second && infer > running);
  assert.equal(receipt.events.filter((event) => event === "command-discover").length, 0);
  assert.equal(receipt.events.filter((event) => event === "command-transcribe").length, windowCount); assert.equal(receipt.leaseChecks, windowCount);
  const retired = receipt.events.indexOf("wait-retired"), reap = receipt.events.indexOf("observe-reaped", retired + 1), reads = receipt.events.indexOf("reads-settled"), current = receipt.events.indexOf("current-reaped");
  assert.ok(retired > receipt.events.lastIndexOf("command-transcribe") && reap > retired && reads > reap && current > reads);
  return receipt;
}
export const resultSchema = z.strictObject({ version: z.literal(1), status: z.literal("PASS"), mode: z.literal("recording-pool-cpu"),
  main: mainIdentitySchema, epochs: z.array(epochSchema).length(3), verificationBackends: z.array(z.literal("cpu")).length(3),
  deliveryCalls: z.literal(2), clipboardCommits: z.literal(1), clipboardExact: z.literal(true), clipboardSha256: shaSchema,
  clipboardCharacters: z.number().int().positive().max(4 * 1024 * 1024), stableToken: z.uuid(),
  recoveryRemovedAfterConfirmation: z.literal(true), modelRemovedAfterAllCloses: z.literal(true),
  supervisorAllocations: z.literal(1), mainNativeCaptureLoaded: z.literal(false), mainNativeSpeechLoaded: z.literal(false),
  runningMainCacheOnly: z.literal(true), ordinaryUIRecordingEnabled: z.literal(false) });
export type Result = z.infer<typeof resultSchema>;
export function validateResult(input: unknown): Result {
  const parsed = resultSchema.parse(input);
  assert.deepEqual(parsed.epochs.map((epoch) => epoch.mode), ["capture-fail", "restore-drop", "restore-confirm"]);
  assert.equal(new Set(parsed.epochs.map((epoch) => epoch.epoch)).size, 3);
  assert.equal(new Set(parsed.epochs.map((epoch) => `${epoch.process.pid}:${epoch.process.startTicks}`)).size, 3);
  for (const epoch of parsed.epochs) {
    validateProcessReceipt(epoch.process, epoch.inferenceWindows.length, parsed.main.pid);
    const receipt = epoch.process;
    assert.equal(receipt.parentPid, parsed.main.pid);
    assert.equal(new Set(receipt.nonceHashes).size, receipt.nonceHashes.length);
    const first = receipt.events.indexOf("challenge"), bind = receipt.events.indexOf("bind-running"), second = receipt.events.indexOf("challenge", first + 1);
    const running = receipt.events.indexOf("observe-running", second + 1), infer = receipt.events.indexOf("command-transcribe");
    assert.ok(first >= 0 && bind > first && second > bind && running > second && infer > running);
    assert.equal(receipt.events.filter((event) => event === "command-discover").length, 0);
    assert.equal(receipt.events.filter((event) => event === "command-transcribe").length, epoch.inferenceWindows.length);
    assert.equal(receipt.leaseChecks, epoch.inferenceWindows.length);
    const retired = receipt.events.indexOf("wait-retired"), reap = receipt.events.indexOf("observe-reaped", retired + 1), reads = receipt.events.indexOf("reads-settled"), current = receipt.events.indexOf("current-reaped");
    assert.ok(retired > receipt.events.lastIndexOf("command-transcribe") && reap > retired && reads > reap && current > reads);
    assert.equal(epoch.inferenceWindows.reduce((sum, count) => sum + count, 0), SAMPLE_COUNT);
    let covered = 0;
    for (const phase of epoch.phases.filter((phase) => phase.phase === "window")) { assert.equal(phase.start, covered); assert.equal(phase.end - phase.start, phase.samples); covered = phase.end; }
    assert.equal(covered, SAMPLE_COUNT);
    assert.equal(epoch.phases.filter((phase) => phase.phase === "progress").at(-1)?.completedSamples, SAMPLE_COUNT);
    assert.equal(epoch.phases.filter((phase) => phase.phase === "overbacked-source").length, 1);
  }
  const [capture, dropped, confirmed] = parsed.epochs; assert.ok(capture && dropped && confirmed);
  assert.ok(capture.result); assert.equal(capture.result.error, "DELIVERY_FAILED"); assert.equal(capture.result.recoveryAvailable, true);
  assert.equal(capture.result.captureCreates, 1); assert.equal(capture.result.nativeCaptureLoaded, true); assert.equal(capture.result.stopAckBeforePrepare, true);
  assert.equal(capture.result.rawLedgerReleased, false);
  assert.equal(capture.confirmedReplyDropped, false); assert.equal(dropped.confirmedReplyDropped, true); assert.equal(dropped.result, null);
  assert.ok(confirmed.result); assert.equal(confirmed.confirmedReplyDropped, false); assert.equal(confirmed.result.phase, "done");
  assert.equal(confirmed.result.captureCreates, 0); assert.equal(confirmed.result.nativeCaptureLoaded, false); assert.equal(confirmed.result.recoveryAvailable, false);
  assert.equal(confirmed.result.transcriptSha256, parsed.clipboardSha256); assert.equal(confirmed.result.transcriptCharacters, parsed.clipboardCharacters);
  return parsed;
}
export async function bounded<T>(operation: Promise<T>, until: number): Promise<T> {
  const remaining = until - performance.now(); if (remaining <= 0) throw new Error("FIXTURE_DEADLINE");
  let timer: NodeJS.Timeout | undefined;
  try { const value = await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("FIXTURE_DEADLINE")), remaining); })]);
    if (performance.now() >= until) throw new Error("FIXTURE_DEADLINE"); return value;
  } finally { if (timer) clearTimeout(timer); }
}

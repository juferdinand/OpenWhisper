import assert from "node:assert/strict";
import { app, clipboard, utilityProcess } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MainRecordingEffects, DeliveryReceiptCache } from "../../src/main/recording-effects.js";
import { createInventoryRecordingSpeechFactory } from "../../src/services/speech/recording-speech.js";
import { ModelInventory } from "../../src/services/models/model-inventory.js";
import { initializeBackendSupervisor } from "../../src/services/speech/backend-supervisor.js";
import { createLinuxSpeechBindings } from "../../src/main/linux-speech-host.js";
import { prepareSpeechResources } from "../../src/services/speech/speech-resources.js";
import { prepareSpeechEntryGraph } from "../../src/services/speech/speech-entry-graph.js";
import { createLinuxProcfsReadProvider, parseLinuxProcStat, parseLinuxProcStatus } from "../../src/services/platform-lifecycle/process-retirement.js";
import { recordingEffectRequestSchema } from "../../src/workers/recording/recording-effects-protocol.js";
import type { DeliveryBoundary } from "../../src/core/recording/recording.js";
import { prepareEnvironment } from "./bootstrap.js";
import { observeBindings } from "./observe.js";
import { boundedJson, describe, type RawFiles } from "../owned-supervisor/files.js";
import { inputSchema, RECOVERY, HOME, RECORDING_ENVIRONMENT_KEY, MAIN_MS, EPOCH_MS, CLEANUP_MS,
  ELECTRON_SHA256, NODE_SHA256, MODEL_SHA256, cpuCatalog, SAMPLE_COUNT, modeSchema, phaseSchema, workerResultSchema,
  readySchema, runSchema, selectionSchema, mainIdentitySchema, validateProcessReceipt, validateResult, bounded,
  parseElectronFixtureArguments } from "./contracts.js";
import type { Epoch, FixtureMode, FixturePhase, FixtureResult } from "./contracts.js";

const watchdog = setTimeout(() => { app.exit(79); }, MAIN_MS);
let stage = "bootstrap", currentMode: FixtureMode | null = null;
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
async function record(next: string, details: Readonly<Record<string, unknown>> = {}): Promise<void> {
  stage = next;
  await writeFile("/evidence/checkpoint.json", JSON.stringify({ stage, mode: currentMode, ...details }), { mode: 0o600 });
}
async function failed(): Promise<void> {
  try { await writeFile("/evidence/failure.json", JSON.stringify({ status: "FAIL", code: "RECORDING_POOL_FAILED", stage, mode: currentMode }), { mode: 0o600 }); } catch {}
  clearTimeout(watchdog); app.exit(1);
}
async function mainIdentity() {
  const reader = createLinuxProcfsReadProvider(), signal = AbortSignal.timeout(8000); await reader.verify(signal);
  const first = parseLinuxProcStat(await reader.read(process.pid, "stat", 4096, signal));
  const status = parseLinuxProcStatus(await reader.read(process.pid, "status", 65536, signal));
  const last = parseLinuxProcStat(await reader.read(process.pid, "stat", 4096, signal));
  assert.equal(first.startTicks, last.startTicks); assert.equal(first.parentPid, process.ppid); assert.equal(last.parentPid, process.ppid);
  assert.equal(status.pid, process.pid); assert.equal(status.parentPid, process.ppid); assert.ok(status.uids.every((uid) => uid === 1000));
  return mainIdentitySchema.parse({ pid: process.pid, parentPid: process.ppid, uid: process.getuid?.(), startTicks: first.startTicks.toString() });
}
function childEnvironment(): NodeJS.ProcessEnv {
  return { HOME, TMPDIR: `${HOME}/tmp`, XDG_CONFIG_HOME: `${HOME}/config`, XDG_DATA_HOME: `${HOME}/data`,
    XDG_CACHE_HOME: `${HOME}/cache`, XDG_RUNTIME_DIR: `${HOME}/runtime`, PATH: "/opt/node/bin:/usr/bin:/bin", LANG: "C.UTF-8",
    DISPLAY: process.env.DISPLAY, [RECORDING_ENVIRONMENT_KEY]: "1" };
}
async function run(profile: ReturnType<typeof prepareEnvironment>): Promise<void> {
  await app.whenReady(); await record("ready");
  await record("arguments"); const expectedInput = parseElectronFixtureArguments(process.argv);
  await record("input-hash"); assert.equal((await describe("/payload/input.json", 512 * 1024)).sha256, expectedInput);
  await record("input-schema");
  const input = inputSchema.parse(await boundedJson("/payload/input.json", 512 * 1024));
  await record("payload-check");
  let payloadIndex = 0;
  for (const [name, expected] of Object.entries(input.build.payloadFiles)) {
    try { assert.deepEqual(await describe(join("/payload", name)), expected); }
    catch { await record("payload-file-mismatch", { index: payloadIndex }); throw new Error("PAYLOAD_FAILED"); }
    payloadIndex++;
  }
  await record("payload-checked");
  await record("runtime");
  const original = await import("original-fs"), io: RawFiles = original.default.promises;
  if (typeof io.lstat !== "function" || typeof io.open !== "function") throw new Error("RUNTIME_FAILED");
  for (const [name, expected] of Object.entries(input.runtimeFiles)) assert.deepEqual(await describe(`/owned-runtime/electron/${name}`, 512 * 1024 * 1024, io), expected);
  assert.equal((await describe(process.execPath, 512 * 1024 * 1024, io)).sha256, ELECTRON_SHA256);
  assert.equal((await describe("/opt/node/bin/node", 256 * 1024 * 1024, io)).sha256, NODE_SHA256);
  const main = await mainIdentity();
  await writeFile("/evidence/runtime.json", JSON.stringify({ main, versions: process.versions, executableSha256: ELECTRON_SHA256,
    nodeSha256: NODE_SHA256, runtimeFileApi: "original-fs", ordinaryUIRecordingEnabled: false }), { mode: 0o600 });
  await record("inventory");
  const inventory = await ModelInventory.open(profile, await boundedJson("/payload/dist/resources/models.json"));
  const imported = await inventory.import("/payload/fixtures/ggml-tiny.bin", { expected: { bytes: 77691713, sha256: MODEL_SHA256 } });
  assert.equal(imported.model.id, "tiny"); assert.equal(imported.copiedSha256, MODEL_SHA256);
  const selected = selectionSchema.parse({ path: join(profile.paths.models, imported.model.file), family: imported.model.family, gpu: false });
  const native = await prepareSpeechResources("/payload", cpuCatalog, { platform: "linux", architecture: "x64" });
  const graph = await prepareSpeechEntryGraph("/payload", input.build.graph);
  const observed = observeBindings(await createLinuxSpeechBindings(native, graph), async () => {
    await assert.rejects(inventory.remove("tiny"), { code: "LEASED" });
  });
  const supervisor = initializeBackendSupervisor(observed.bindings);
  const receipts = new DeliveryReceiptCache(), epochs: Epoch[] = [];
  let deliveryCalls = 0, clipboardCommits = 0, clipboardSha256 = "", clipboardCharacters = 0;
  let stableToken: string | undefined;
  const delivery: DeliveryBoundary = { async deliver(text, context, identity) {
    assert.equal(identity.kind, "recovery"); assert.equal(context.signal.aborted, false);
    if (identity.kind !== "recovery") throw new Error("DELIVERY_FAILED");
    if (!stableToken) stableToken = identity.token; else assert.equal(identity.token, stableToken);
    deliveryCalls++;
    if (deliveryCalls === 1) return { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false };
    assert.equal(deliveryCalls, 2); await clipboard.writeText(text); const copied = await clipboard.readText(); assert.equal(copied, text);
    clipboardCommits++; clipboardSha256 = digest(copied); clipboardCharacters = copied.length;
    return { generation: context.generation, attempt: context.attempt, outcome: "clipboard", clipboardConfirmed: true };
  } };
  for (const mode of modeSchema.options) epochs.push(await runEpoch(mode));
  currentMode = null; await record("all-epochs-closed");
  await observed.settleChecks(); assert.ok(stableToken);
  assert.deepEqual(await readdir(RECOVERY), []); assert.equal(digest(await clipboard.readText()), clipboardSha256);
  await inventory.remove("tiny"); assert.deepEqual(await inventory.installed(), []);
  assert.deepEqual(await mainIdentity(), main);
  const maps = await readFile(`/proc/${process.pid}/maps`, "utf8");
  const result = validateResult({ version: 1, status: "PASS", mode: "recording-pool-cpu", main, epochs,
    verificationBackends: observed.backends, deliveryCalls, clipboardCommits, clipboardExact: true, clipboardSha256, clipboardCharacters,
    stableToken, recoveryRemovedAfterConfirmation: true, modelRemovedAfterAllCloses: true, supervisorAllocations: 1,
    mainNativeCaptureLoaded: maps.includes("openwhisper_capture.node"), mainNativeSpeechLoaded: maps.includes("openwhisper_speech.node"),
    runningMainCacheOnly: true, ordinaryUIRecordingEnabled: false });
  await writeFile("/evidence/result.json", JSON.stringify(result, null, 2), { mode: 0o600 });

  async function runEpoch(mode: FixtureMode): Promise<Epoch> {
    currentMode = mode; await record("epoch-opening", { completedEpochs: epochs.length });
    const ordinal = epochs.length, epoch = randomUUID(), phases: FixturePhase[] = [], inferenceWindows: number[] = [];
    assert.equal(observed.receipts.length, ordinal);
    // Exact real inventory and supervisor; no Proxy, facade or historical seam.
    const factory = createInventoryRecordingSpeechFactory({ inventory, supervisor, selection: { id: "tiny", gpu: false } });
    const broker = new MainRecordingEffects({ epoch, platform: "linux", receipts, delivery, speech: factory });
    for (const samples of [new Float32Array(new ArrayBuffer(16 * 1024 * 1024), 128, 16), new Float32Array(new ArrayBuffer(128), 32, 16)]) {
      await assert.rejects(broker.handle({ version: 1, epoch, id: randomUUID(), generation: 1, attempt: 1,
        command: "infer", model: selected, samples, language: "en", vocabulary: "" }), { code: "INVALID_FRAME" });
      assert.equal(observed.receipts.length, ordinal);
    }
    const child = utilityProcess.fork("/payload/probe.mjs", [epoch, mode, RECOVERY], { serviceName: "OpenWhisper Owned Recording Pool Capture",
      env: childEnvironment(), execArgv: [], stdio: "ignore", allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false });
    const until = performance.now() + EPOCH_MS;
    let pid = 0, finished = false, stopped = false, failedFrame = false, confirmedReplyDropped = false;
    let result: FixtureResult | null = null, accept!: () => void, reject!: () => void, acceptExit!: () => void;
    const completion = new Promise<void>((resolve, refuse) => { accept = resolve; reject = () => { refuse(new Error("EPOCH_FAILED")); }; });
    const exited = new Promise<void>((resolve) => { acceptExit = resolve; });
    let checkpoint: Promise<void> = Promise.resolve();
    const pendingFrames = new Set<Promise<void>>();
    child.once("exit", () => { stopped = true; acceptExit(); if (!finished) { failedFrame = true; reject(); } });
    child.on("error", () => { failedFrame = true; reject(); });
    child.on("message", (value: unknown) => {
      const accepted = receive(value); pendingFrames.add(accepted);
      void accepted.then(() => { pendingFrames.delete(accepted); }, () => { failedFrame = true; reject(); pendingFrames.delete(accepted); });
    });
    try { await bounded(completion, until); }
    finally {
      finished = true;
      const cleanupUntil = performance.now() + CLEANUP_MS;
      let cleanupFailed = false;
      try { if (!stopped && !child.kill()) throw new Error("EXIT_FAILED"); } catch { cleanupFailed = true; }
      try { await bounded(exited, cleanupUntil); } catch { cleanupFailed = true; }
      const close = broker.close();
      try { await bounded(close, cleanupUntil); } catch { cleanupFailed = true; }
      try { await bounded(Promise.all([...pendingFrames]), cleanupUntil); await bounded(checkpoint, cleanupUntil); await bounded(observed.settleChecks(), cleanupUntil); }
      catch { cleanupFailed = true; }
      child.removeAllListeners("message");
      await record("epoch-original-cleanup", { captureExitObserved: stopped, brokerCloseConfirmed: !cleanupFailed,
        frameFailure: failedFrame, captureExitIsKernelReapProof: false });
      if (cleanupFailed || failedFrame) throw new Error("CLEANUP_FAILED");
    }
    assert.equal(observed.receipts.length, ordinal + 1); const observedProcess = observed.receipts[ordinal]; assert.ok(observedProcess);
    const processReceipt = validateProcessReceipt({ ...observedProcess, fullReapAndReadsConfirmed: true }, inferenceWindows.length, process.pid);
    const accepted: Epoch = { mode, epoch, capturePid: pid, captureExitObserved: true as const, captureExitIsKernelReapProof: false as const,
      phases, result, inferenceWindows, coverage: SAMPLE_COUNT, brokerCloseConfirmed: true as const,
      factoryUsesExactInventoryAndSupervisor: true as const, process: processReceipt, confirmedReplyDropped,
      wireBuffersExclusive: true as const, malformedMainViewsRejectedBeforeAcquisition: true as const };
    await writeFile("/evidence/epochs.json", JSON.stringify([...epochs, accepted], null, 2), { mode: 0o600 });
    return accepted;

    async function receive(value: unknown): Promise<void> {
      const ready = readySchema.safeParse(value);
      if (ready.success) { assert.equal(pid, 0); pid = ready.data.pid; assert.equal(child.pid, pid);
        child.postMessage(runSchema.parse({ version: 1, fixture: "recording-pool-run", epoch, model: selected })); return; }
      const phase = phaseSchema.safeParse(value);
      if (phase.success) {
        assert.ok(phases.length < 128); phases.push(phase.data);
        if (phase.data.phase === "recovery") {
          assert.equal(phase.data.restored, mode !== "capture-fail"); assert.equal(phase.data.captureCreates, mode === "capture-fail" ? 1 : 0);
        }
        const snapshot = JSON.stringify({ mode, epoch, pid, phases, inferenceWindows });
        checkpoint = checkpoint.then(() => writeFile("/evidence/pipeline-checkpoint.json", snapshot, { mode: 0o600 }));
        void checkpoint.catch(() => { failedFrame = true; reject(); }); return;
      }
      const final = workerResultSchema.safeParse(value);
      if (final.success) { assert.equal(final.data.pid, pid); assert.equal(final.data.mode, mode); result = final.data; finished = true; accept(); return; }
      const request = recordingEffectRequestSchema.parse(value); assert.equal(request.epoch, epoch);
      if (request.command === "infer") {
        assert.equal(request.samples.byteOffset, 0); assert.equal(request.samples.buffer.byteLength, request.samples.byteLength);
        assert.deepEqual(request.model, selected);
        const recovery = phases.find((phase) => phase.phase === "recovery"); assert.ok(recovery && recovery.phase === "recovery");
        const status = await lstat(join(RECOVERY, `recording-${recovery.token}.wav`));
        assert.ok(status.isFile() && !status.isSymbolicLink()); assert.equal(status.uid, 1000); assert.equal(status.mode & 0o7777, 0o600);
        assert.equal(status.size, SAMPLE_COUNT * 4 + 44); inferenceWindows.push(request.samples.length);
      }
      const operation = broker.handle(request), reply = await operation;
      if (reply && !stopped) {
        if (mode === "restore-drop" && reply.kind === "deliver" && reply.receipt.clipboardConfirmed) {
          confirmedReplyDropped = true; finished = true; accept();
        } else child.postMessage(reply);
      }
    }
  }
}
try {
  const profile = prepareEnvironment(); app.setName("OpenWhisper Owned Recording Pool");
  app.setPath("userData", profile.roots.config); app.setPath("sessionData", profile.paths.session); app.setPath("crashDumps", profile.paths.logs);
  app.disableHardwareAcceleration();
  void run(profile).then(() => { clearTimeout(watchdog); app.exit(0); }, () => failed());
} catch { void failed(); }

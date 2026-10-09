import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MODEL, SAMPLE_COUNT, runSchema, validateResult, IMAGE, parseElectronFixtureArguments } from "./owned-recording-pool/contracts.js";
import { externalProductionImport } from "./owned-recording-pool/build-probe.js";
import { parseExecutionArguments, validateStoppedConfiguration, verifyReviewedBuild } from "./owned-recording-pool/run.js";

function result() {
  const sha = "a".repeat(64), main = { pid: 100, parentPid: 99, uid: 1000, startTicks: "10" };
  const epochs = (["capture-fail", "restore-drop", "restore-confirm"] as const).map((mode, index) => ({
    mode, epoch: randomUUID(), capturePid: 200 + index, captureExitObserved: true, captureExitIsKernelReapProof: false,
    phases: [{ fixture: "recording-phase", phase: "window", start: 0, end: 480000, samples: 480000 },
      { fixture: "recording-phase", phase: "window", start: 480000, end: SAMPLE_COUNT, samples: SAMPLE_COUNT - 480000 },
      { fixture: "recording-phase", phase: "progress", completedSamples: SAMPLE_COUNT },
      { fixture: "recording-phase", phase: "overbacked-source", backingBytes: 16 * 1024 * 1024, byteOffset: 128, samples: 480000, samplesCopiedExactly: true }],
    result: mode === "restore-drop" ? null : { fixture: "recording-result", mode, pid: 200 + index,
      phase: mode === "capture-fail" ? "error" : "done", error: mode === "capture-fail" ? "DELIVERY_FAILED" : null,
      recoveryAvailable: mode === "capture-fail", captureCreates: mode === "capture-fail" ? 1 : 0, sampleCount: SAMPLE_COUNT,
      nativeCaptureLoaded: mode === "capture-fail", nativeSpeechLoaded: false, stopAckBeforePrepare: mode === "capture-fail",
      rawLedgerReleased: false, transcriptSha256: sha, transcriptCharacters: 100 },
    inferenceWindows: [480000, SAMPLE_COUNT - 480000], coverage: SAMPLE_COUNT, brokerCloseConfirmed: true,
    factoryUsesExactInventoryAndSupervisor: true, process: { pid: 300 + index, parentPid: main.pid, uid: 1000, epoch: randomUUID(), startTicks: String(20 + index),
      nonceHashes: [sha, "b".repeat(64)], events: ["challenge", "bind-running", "challenge", "observe-running", "command-transcribe", "command-transcribe",
        "terminate", "wait-retired", "observe-reaped", "reads-settled", "current-reaped"], genericExitObserved: true, leaseChecks: 2, fullReapAndReadsConfirmed: true },
    confirmedReplyDropped: mode === "restore-drop", wireBuffersExclusive: true, malformedMainViewsRejectedBeforeAcquisition: true,
  }));
  return { version: 1, status: "PASS", mode: "recording-pool-cpu", main, epochs, verificationBackends: ["cpu", "cpu", "cpu"],
    deliveryCalls: 2, clipboardCommits: 1, clipboardExact: true, clipboardSha256: sha, clipboardCharacters: 100, stableToken: randomUUID(),
    recoveryRemovedAfterConfirmation: true, modelRemovedAfterAllCloses: true, supervisorAllocations: 1,
    mainNativeCaptureLoaded: false, mainNativeSpeechLoaded: false, runningMainCacheOnly: true, ordinaryUIRecordingEnabled: false };
}
test("owned pool receipts require three distinct genuine lifetimes complete coverage and one running-main clipboard commit", () => {
  assert.equal(validateResult(result()).epochs.length, 3);
  for (const kind of ["reads", "coverage", "parent", "birth", "clipboard", "capture-reap", "close"] as const) {
    const changed = result(), first = changed.epochs[0], second = changed.epochs[1]; assert.ok(first && second);
    if (kind === "reads") first.process.events = first.process.events.filter((event) => event !== "reads-settled");
    else if (kind === "coverage") first.inferenceWindows[1] = 1;
    else if (kind === "parent") first.process.parentPid++;
    else if (kind === "birth") { second.process.pid = first.process.pid; second.process.startTicks = first.process.startTicks; }
    else if (kind === "clipboard") changed.clipboardCommits++;
    else if (kind === "capture-reap") first.captureExitIsKernelReapProof = true;
    else first.brokerCloseConfirmed = false;
    assert.throws(() => validateResult(changed), kind);
  }
});
test("main-owned bootstrap excludes the historical public model GPU changes and unknown fields", () => {
  const frame = { version: 1, fixture: "recording-pool-run", epoch: randomUUID(), model: { path: MODEL, family: "whisper", gpu: false } };
  runSchema.parse(frame);
  for (const model of [{ ...frame.model, path: "/fixtures/ggml-tiny.bin" }, { ...frame.model, gpu: true }, { ...frame.model, family: "parakeet" }])
    assert.equal(runSchema.safeParse({ ...frame, model }).success, false);
  assert.equal(runSchema.safeParse({ ...frame, command: "infer" }).success, false);
});
test("Electron input authority follows the exact launcher vector rather than a switch index", () => {
  const args = ["/owned-runtime/electron/electron", "--disable-gpu", "--disable-dev-shm-usage", "/payload/main.mjs", "a".repeat(64)] as const;
  assert.equal(parseElectronFixtureArguments(args), args[4]);
  assert.equal(args[2], "--disable-dev-shm-usage");
  const changed = [args.slice(0, -1), args.slice(1), [...args, "b".repeat(64)], [...args.slice(0, 1), ...args.slice(2)],
    [args[0], args[1], args[1], args[2], args[3], args[4]], [args[0], args[2], args[1], args[3], args[4]],
    [args[0], args[1], args[2], args[3], args[3], args[4]], args.map((arg) => arg === "/payload/main.mjs" ? "/payload/probe.mjs" : arg),
    args.map((arg) => arg === "/owned-runtime/electron/electron" ? "/usr/bin/electron" : arg),
    args.map((arg) => arg === args[4] ? "--inspect" : arg), args.map((arg) => arg === args[4] ? "A".repeat(64) : arg)];
  for (const invalid of changed) assert.throws(() => parseElectronFixtureArguments(invalid));
});
test("execution consumes an explicit reviewed input hash and refuses path aliases overlaps and extra commands", () => {
  const args = ["--output", "/owned/output", "--build", "/owned/build", "--input-sha256", "a".repeat(64), "--seccomp", "/owned/policy", "--execute-reviewed-owned-recording-pool"];
  assert.equal(parseExecutionArguments(args).inputSha256, "a".repeat(64));
  for (const changed of [args.slice(0, -1), [...args, "--rebuild"], args.map((arg) => arg === "/owned/output" ? "/owned/build/child" : arg),
    args.map((arg) => arg === "/owned/build" ? "/owned/../build" : arg), args.map((arg) => arg === "a".repeat(64) ? "bad" : arg)])
    assert.throws(() => parseExecutionArguments(changed));
});
test("reviewed input drift fails before any Docker command or payload interpretation", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-recording-pool-input-")); await chmod(root, 0o700);
  try { await writeFile(join(root, "input.json"), "inert never executed", { mode: 0o600 }); await assert.rejects(verifyReviewedBuild(root, "0".repeat(64))); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test("container authority is inspected while stopped with exact core limit init and policy", () => {
  const policy = { defaultAction: "SCMP_ACT_ERRNO" }, host = { Init: true, NetworkMode: "none", Privileged: false, CapDrop: ["ALL"], Devices: [], PidMode: "", IpcMode: "private",
    SecurityOpt: ["no-new-privileges", `seccomp=${JSON.stringify(policy)}`], Ulimits: [{ Name: "core", Hard: 0, Soft: 0 }] };
  const good = [{ Image: IMAGE, Config: { User: "1000:1000" }, State: { Running: false }, HostConfig: host, Mounts: [] }];
  validateStoppedConfiguration(good, policy);
  const original = good[0]; assert.ok(original);
  for (const change of [{ State: { Running: true } }, { HostConfig: { ...host, Init: false } }, { HostConfig: { ...host, Ulimits: [] } },
    { HostConfig: { ...host, NetworkMode: "host" } }, { Mounts: [{}] }]) assert.throws(() => validateStoppedConfiguration([{ ...original, ...change }], policy));
});
test("compiled production imports stay external including the new factory and recording worker closure", () => {
  const importer = fileURLToPath(new URL("./owned-recording-pool/entry.ts", import.meta.url));
  for (const name of ["services/speech/recording-speech.js", "services/models/model-inventory.js", "services/speech/backend-supervisor.js", "main/recording-effects.js"])
    assert.equal(externalProductionImport(`../../src/${name}`, importer), `./dist/${name}`);
  assert.equal(externalProductionImport("../../src/main/index.js", importer), undefined);
  assert.equal(externalProductionImport("../../src/services/speech/recording-speech.js?new-main", importer), undefined);
});

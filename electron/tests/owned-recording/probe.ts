import assert from "node:assert/strict";
import { app, BrowserWindow, clipboard, utilityProcess } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MainRecordingEffects, DeliveryReceiptCache } from "../../src/main/recording-effects.js";
import { createFixtureSpeechChannelFactory } from "../fixtures/speech-bootstrap-channel.js";
import { SpeechClient } from "../../src/services/speech-client.js";
import { recordingEffectRequestSchema } from "../../src/workers/recording-effects-protocol.js";
import { MODEL, SAMPLE_COUNT, modeSchema, phaseSchema, probeResultSchema, readySchema, resultSchema } from "./contracts.js";
import type { FixtureMode, FixturePhase, FixtureResult, ProbeResult } from "./contracts.js";

function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned recording deadline failed.")), milliseconds);
    operation.then((value) => { clearTimeout(timer); accept(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}
/** Main brokers only bounded windows and explicit private-Xvfb clipboard delivery. */
export async function runRecordingProbe(recoveryPath: string): Promise<ProbeResult> {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 1000);
  assert.match(recoveryPath, /^\/tmp\/openwhisper-owned-recording-[A-Za-z0-9]+\/dev-profile\/data\/recovery$/);
  assert.match(process.env.DISPLAY ?? "", /^:\d+$/);
  assert.equal((await lstat(recoveryPath)).mode & 0o7777, 0o700);
  const receipts = new DeliveryReceiptCache();
  const epochs: ProbeResult["epochs"] = [];
  let deliveryCalls = 0, clipboardCommits = 0, clipboardSha256 = "", clipboardCharacters = 0;
  let stableToken: string | undefined;
  let checkpoints: Promise<void> = Promise.resolve();
  const delivery = { async deliver(text: string, context: import("../../src/core/recording.js").WorkContext,
    identity: import("../../src/core/recording.js").DeliveryIdentity) {
    assert.equal(identity.kind, "recovery");
    assert.equal(context.signal.aborted, false);
    if (identity.kind !== "recovery") throw new Error("Expected private recovery delivery.");
    if (!stableToken) stableToken = identity.token; else assert.equal(identity.token, stableToken);
    deliveryCalls++;
    if (deliveryCalls === 1) return { generation: context.generation, attempt: context.attempt,
      outcome: "failed" as const, clipboardConfirmed: false as const };
    assert.equal(deliveryCalls, 2);
    await clipboard.writeText(text);
    const copied = await clipboard.readText();
    assert.equal(copied, text);
    clipboardCommits++;
    clipboardCharacters = copied.length;
    clipboardSha256 = createHash("sha256").update(copied).digest("hex");
    return { generation: context.generation, attempt: context.attempt,
      outcome: "clipboard" as const, clipboardConfirmed: true as const };
  } };
  for (const selected of ["capture-fail", "restore-drop", "restore-confirm"]) {
    const mode = modeSchema.parse(selected);
    epochs.push(await runEpoch(mode));
  }
  assert.ok(stableToken);
  assert.equal(deliveryCalls, 2); assert.equal(clipboardCommits, 1);
  assert.equal(createHash("sha256").update(await clipboard.readText()).digest("hex"), clipboardSha256);
  assert.deepEqual(await readdir(recoveryPath), []);
  const maps = await readFile(`/proc/${process.pid}/maps`, "utf8");
  const mainAlive = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed());
  const helpersRemain = app.getAppMetrics().some((metric) => metric.serviceName === "OpenWhisper Speech"
    || metric.serviceName === "OpenWhisper Owned Capture");
  return probeResultSchema.parse({ epochs, deliveryCalls, clipboardCommits, clipboardExact: true,
    clipboardSha256, clipboardCharacters, stableToken, recoveryRemovedAfterConfirmation: true, restoredCaptureCreates: 0,
    mainNativeCaptureLoaded: maps.includes("openwhisper_capture.node"), mainNativeSpeechLoaded: maps.includes("openwhisper_speech.node"),
    mainAlive, runningMainCacheOnly: true, speechHelpersReaped: !helpersRemain });

  async function runEpoch(mode: FixtureMode): Promise<ProbeResult["epochs"][number]> {
    const epoch = randomUUID();
    const phases: FixturePhase[] = [], inferenceWindows: number[] = [];
    let speechCreates = 0;
    const broker = new MainRecordingEffects({ epoch, platform: "linux", receipts, delivery,
      approveModel: (model) => model.path === MODEL && model.family === "whisper" && model.gpu === false,
      createSpeech: () => {
        speechCreates++;
        return new SpeechClient(createFixtureSpeechChannelFactory(), { startupMs: 10000, requestMs: 60000 });
      },
    });
    for (const samples of [new Float32Array(new ArrayBuffer(16 * 1024 * 1024), 128, 16),
      new Float32Array(new ArrayBuffer(128), 32, 16)]) {
      await assert.rejects(broker.handle({ version: 1, epoch, id: randomUUID(), generation: 1, attempt: 1,
        command: "infer", model: { path: MODEL, family: "whisper", gpu: false }, samples, language: "en", vocabulary: "" }),
      { code: "INVALID_FRAME" });
      assert.equal(speechCreates, 0);
    }
    const environment = { ...process.env };
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE",
      "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) delete environment[key];
    const child = utilityProcess.fork("/owned-app/tests/owned-recording/entry.mjs", [epoch, mode, recoveryPath], {
      serviceName: "OpenWhisper Owned Capture", stdio: "ignore", execArgv: [], env: environment,
      allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false,
    });
    let pid = 0, finished = false, stopped = false, confirmedReplyDropped = false;
    let result: FixtureResult | null = null;
    let resolveResult: (() => void) | undefined, rejectResult: ((error: Error) => void) | undefined;
    const completion = new Promise<void>((accept, reject) => { resolveResult = accept; rejectResult = reject; });
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((accept) => { resolveExit = accept; });
    child.once("exit", () => {
      stopped = true; resolveExit?.();
      if (!finished) rejectResult?.(new Error("Owned capture utility exited unexpectedly."));
    });
    child.once("error", () => { rejectResult?.(new Error("Owned capture utility failed.")); });
    child.on("message", (input: unknown) => { void receive(input).catch(() => {
      rejectResult?.(new Error("Owned pipeline invariant failed."));
    }); });
    try {
      await deadline(completion, 180_000);
    } finally {
      finished = true;
      if (!stopped) child.kill();
      await deadline(exited, 10_000);
      await deadline(broker.close(), 15_000);
      child.removeAllListeners("message");
      await checkpoints;
    }
    assert.ok(pid > 0);
    assert.equal(inferenceWindows.reduce((total, count) => total + count, 0), SAMPLE_COUNT);
    const windows = phases.filter((phase) => phase.phase === "window");
    let covered = 0;
    for (const window of windows) {
      assert.equal(window.start, covered); assert.equal(window.end - window.start, window.samples);
      covered = window.end;
    }
    assert.equal(covered, SAMPLE_COUNT);
    const progress = phases.filter((phase) => phase.phase === "progress");
    assert.equal(progress.at(-1)?.completedSamples, SAMPLE_COUNT);
    const completedResult = resultSchema.nullable().parse(result);
    if (mode === "capture-fail") {
      assert.ok(completedResult); assert.equal(completedResult.captureCreates, 1); assert.equal(completedResult.rawLedgerReleased, false);
      assert.equal(completedResult.nativeCaptureLoaded, true); assert.equal(completedResult.stopAckBeforePrepare, true);
    } else if (mode === "restore-confirm") {
      assert.ok(completedResult); assert.equal(completedResult.captureCreates, 0); assert.equal(completedResult.nativeCaptureLoaded, false);
      assert.equal(completedResult.phase, "done"); assert.equal(completedResult.recoveryAvailable, false);
    }
    return { mode, epoch, pid, reaped: true, phases, result: completedResult, inferenceWindows, coverage: SAMPLE_COUNT,
      recoveryBeforeEveryInference: true, confirmedReplyDropped, wireBuffersExclusive: true, malformedMainViewsRejected: true };

    async function receive(input: unknown): Promise<void> {
      const ready = readySchema.safeParse(input);
      if (ready.success) {
        assert.equal(pid, 0); pid = ready.data.pid; assert.equal(child.pid, pid);
        child.postMessage({ fixture: "run" }); return;
      }
      const phase = phaseSchema.safeParse(input);
      if (phase.success) {
        phases.push(phase.data);
        if (phase.data.phase === "recovery") {
          assert.equal(phase.data.restored, mode !== "capture-fail");
          assert.equal(phase.data.captureCreates, mode === "capture-fail" ? 1 : 0);
        }
        const snapshot = JSON.stringify({ mode, epoch, pid, phases, inferenceWindows }, null, 2);
        checkpoints = checkpoints.then(() => writeFile("/evidence/pipeline-checkpoint.json", snapshot, { mode: 0o600 }));
        return;
      }
      const final = resultSchema.safeParse(input);
      if (final.success) {
        assert.equal(final.data.pid, pid); assert.equal(final.data.mode, mode);
        result = final.data; finished = true; resolveResult?.(); return;
      }
      const request = recordingEffectRequestSchema.parse(input);
      assert.equal(request.epoch, epoch);
      if (request.command === "infer") {
        assert.equal(request.samples.byteOffset, 0);
        assert.equal(request.samples.buffer.byteLength, request.samples.byteLength);
        const saved = phases.find((phase) => phase.phase === "recovery");
        assert.ok(saved && saved.phase === "recovery");
        const file = await lstat(join(recoveryPath, `recording-${saved.token}.wav`));
        assert.ok(file.isFile() && !file.isSymbolicLink());
        assert.equal(file.uid, 1000); assert.equal(file.mode & 0o7777, 0o600); assert.equal(file.size, SAMPLE_COUNT * 4 + 44);
        inferenceWindows.push(request.samples.length);
      }
      const reply = await broker.handle(request);
      if (reply && !stopped) {
        if (mode === "restore-drop" && reply.kind === "deliver" && reply.receipt.clipboardConfirmed) {
          confirmedReplyDropped = true; finished = true; resolveResult?.();
        } else child.postMessage(reply);
      }
    }
  }
}

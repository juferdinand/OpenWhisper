import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { app, utilityProcess } from "electron";
import { createFixtureSpeechChannelFactory } from "../fixtures/speech-bootstrap-channel.js";
import { SpeechClient, SpeechWorkerError } from "../../src/services/speech/speech-client.js";
import type { SpeechModel } from "../../src/workers/native-speech.js";

const pause = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((accept) => { setTimeout(accept, milliseconds); });
};
const owners = () => app.getAppMetrics().filter((item) => item.name === "OpenWhisper Speech" || item.serviceName === "OpenWhisper Speech");
const owner = () => {
  const entries = owners();
  assert.equal(entries.length, 1, "There must be one disposable speech owner.");
  const entry = entries[0];
  assert.ok(entry);
  return { pid: entry.pid, creationTime: entry.creationTime };
};
async function noOwners(): Promise<void> {
  const deadline = performance.now() + 2000;
  while (owners().length > 0 && performance.now() < deadline) await pause(10);
  assert.equal(owners().length, 0, "The actual utility process must be reaped.");
}
async function failure(pending: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(pending, (error: unknown) => error instanceof SpeechWorkerError && error.code === code);
}

/** Imported only by the private Electron driver, never by the application main. */
export async function runUtilityProbe(mode: "abi" | "cpu") {
  assert.equal(app.isReady(), true);
  assert.equal(process.getuid?.(), 1000);
  const factory = createFixtureSpeechChannelFactory();
  const checks: string[] = [];
  const client = new SpeechClient(factory, { startupMs: 5000, requestMs: 60_000 });
  try {
    if (mode === "abi") {
      await failure(client.gpuDevice(), "START_FAILED");
      await client.close();
      await noOwners();
      return { result: "ABI_LOAD_FAILED_CONTAINED", mainAlive: true, checks: ["incompatible host addon fails on first ordinary discovery after control handshake; fixture owner removed"], versions: process.versions };
    }
    assert.equal(await client.gpuDevice(), null);
    const firstOwner = owner();
    const maps = await readFile(`/proc/${firstOwner.pid}/maps`, "utf8");
    assert.equal(maps.includes("openwhisper_speech.node"), true);
    assert.equal((await readFile(`/proc/${process.pid}/maps`, "utf8")).includes("openwhisper_speech.node"), false);
    const helperEnvironment = (await readFile(`/proc/${firstOwner.pid}/environ`, "utf8")).split("\0");
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) {
      assert.equal(helperEnvironment.some((item) => item.startsWith(`${name}=`)), false);
    }
    checks.push("actual Electron Node-API8 CPU addon loaded only in utility process; implicit preload aliases cleared");
    const bytes = await readFile("/fixtures/jfk.f32");
    assert.equal(bytes.length % 4, 0);
    const samples = new Float32Array(bytes.length / 4);
    for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readFloatLE(index * 4);
    const model: SpeechModel = { path: "/fixtures/ggml-tiny.bin", family: "whisper", gpu: false };
    const first = await client.transcribeWindow(model, samples, "en", "");
    assert.equal(/ask not what your country can do for you/i.test(first), true, "Public fixture must be recognized.");
    assert.deepEqual(owner(), firstOwner);
    const second = await client.transcribeWindow(model, samples, "en", "");
    assert.equal(first === second, true, "A reused context must retain repeat inference behavior.");
    assert.deepEqual(owner(), firstOwner);
    const transcriptSha = createHash("sha256").update(first).digest("hex");
    checks.push("two complete public fixture inferences, identical result hash, same helper PID/creation time");

    await failure(client.transcribeWindow({ ...model, family: "parakeet" }, samples, "en", ""), "NATIVE_FAILED");
    assert.equal(await client.gpuDevice(), null);
    const familyReplacement = owner();
    assert.equal(familyReplacement.pid === firstOwner.pid && familyReplacement.creationTime === firstOwner.creationTime, false);
    const reloaded = await client.transcribeWindow(model, samples, "en", "");
    assert.equal(createHash("sha256").update(reloaded).digest("hex"), transcriptSha);
    assert.deepEqual(owner(), familyReplacement);
    checks.push("actual wrong-family load rejected without cached Whisper reuse; original family reload returns unchanged fixture hash");

    await failure(client.transcribeWindow({ ...model, path: "/fixtures/missing-model.bin" }, samples, "en", ""), "NATIVE_FAILED");
    assert.equal(await client.gpuDevice(), null);
    const replacement = owner();
    assert.equal(replacement.pid === familyReplacement.pid && replacement.creationTime === familyReplacement.creationTime, false);
    checks.push("actual native model failure contained; failed owner disposed before clean replacement");
    const crashed = failure(client.transcribeWindow(model, samples, "en", ""), "WORKER_FAILED");
    await pause(20);
    assert.deepEqual(owner(), replacement);
    process.kill(replacement.pid, "SIGKILL");
    await crashed;
    assert.equal(await client.gpuDevice(), null);
    const afterCrash = owner();
    assert.equal(afterCrash.pid === replacement.pid && afterCrash.creationTime === replacement.creationTime, false);
    await client.close();
    await noOwners();
    checks.push("actual in-flight native helper crash contained; clean respawn and acknowledged idle shutdown/reap");

    const timed = new SpeechClient(factory, { startupMs: 5000, requestMs: 500 });
    try {
      assert.equal(await timed.gpuDevice(), null);
      const stopped = owner();
      process.kill(stopped.pid, "SIGSTOP");
      const start = performance.now();
      await failure(timed.gpuDevice(), "TIMEOUT");
      assert.equal(await timed.gpuDevice(), null);
      const afterTimeout = owner();
      assert.equal(afterTimeout.pid === stopped.pid && afterTimeout.creationTime === stopped.creationTime, false);
      assert.equal(performance.now() - start < 8000, true, "Frozen helper must be force-killed/reaped before bounded retry.");
      checks.push("actual SIGSTOP watchdog; Electron kill/force-reap escalation confirmed before retry");
    } finally { await timed.close(); }
    await noOwners();

    const controller = new AbortController();
    const early = await factory(controller.signal);
    controller.abort();
    await early.terminate();
    await early.terminate();
    await noOwners();
    checks.push("abort after fixture bootstrap handshake; idempotent generic-exit cleanup");
    const cancelled = new AbortController();
    cancelled.abort();
    await failure(factory(cancelled.signal), "CANCELLED");
    await noOwners();

    const malformed = utilityProcess.fork("/owned-app/dist/workers/speech-entry.js", ["/owned-app/dist/native/openwhisper_speech.node", randomUUID()], {
      serviceName: "OpenWhisper Malformed Probe", stdio: "ignore", execArgv: [],
    });
    const malformedExit = await new Promise<number>((accept, reject) => {
      const timer = setTimeout(() => { malformed.kill(); reject(new Error("Malformed worker did not exit.")); }, 5000);
      malformed.once("message", () => { malformed.postMessage({ version: 1, id: "invalid", command: "discover", extra: true }); });
      malformed.once("exit", (code) => { clearTimeout(timer); accept(code); });
    });
    assert.equal(malformedExit, 1);
    checks.push("actual worker rejects malformed raw frame and exits without diagnostic or native access in main");
    return { result: "PASS", mainAlive: true, checks, firstOwner, familyReplacement, replacement, afterCrash,
      transcriptSha, sampleCount: samples.length, versions: process.versions,
      scope: "CPU Node-API/utility transport only; historical fixture generic-exit cleanup, no supervisor OS admission/retirement proof or GPU/Parakeet/capture/desktop parity" };
  } finally { await client.close(); }
}

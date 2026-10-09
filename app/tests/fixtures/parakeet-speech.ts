import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { app, utilityProcess } from "electron";
import { z } from "zod";
import { createFixtureSpeechChannelFactory } from "./speech-bootstrap-channel.js";
import { SpeechClient, SpeechWorkerError, type SpeechChannelFactory } from "../../src/services/speech/speech-client.js";
import type { SpeechModel } from "../../src/workers/speech/native-speech.js";
import { PARAKEET_FIXTURE } from "./parakeet-model.js";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const pause = async (): Promise<void> => { await new Promise<void>((accept) => setTimeout(accept, 10)); };
const owners = () => app.getAppMetrics().filter((item) => item.name === "OpenWhisper Speech" || item.serviceName === "OpenWhisper Speech");
function owner() {
  const entries = owners();
  assert.equal(entries.length, 1);
  const selected = entries[0];
  assert.ok(selected);
  return { pid: selected.pid, creationTime: selected.creationTime };
}
async function noOwners(): Promise<void> {
  const deadline = performance.now() + 5000;
  while (owners().length && performance.now() < deadline) await pause();
  assert.equal(owners().length, 0, "The native speech owner must be reaped.");
}

async function postprocess(raw: string) {
  const id = randomUUID();
  const worker = utilityProcess.fork("/owned-app/tests/owned-parakeet/processor.mjs", [], {
    serviceName: "OpenWhisper Public Parakeet Processor", stdio: "ignore", execArgv: [], allowLoadingUnsignedLibraries: false,
  });
  const resultSchema = z.strictObject({ version: z.literal(1), id: z.literal(id), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    characters: z.number().int().positive().max(16384), vocabularyThenSnippet: z.literal(true), cleanupApplied: z.literal(true),
    pid: z.number().int().positive(), nativeLoaded: z.literal(false) });
  let expectedExit = false;
  const exited = new Promise<number>((accept) => worker.once("exit", accept));
  try {
    return await new Promise<z.infer<typeof resultSchema>>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Public fixture processing deadline exceeded.")), 10_000);
      const finish = (error?: Error): void => { clearTimeout(timer); if (error) reject(error); };
      worker.once("exit", () => { if (!expectedExit) finish(new Error("Public fixture processor exited.")); });
      let sent = false;
      worker.on("message", (value: unknown) => {
        if (!sent) {
          if (!z.strictObject({ version: z.literal(1), type: z.literal("ready") }).safeParse(value).success) {
            finish(new Error("Invalid public fixture processor readiness.")); return;
          }
          sent = true; worker.postMessage({ version: 1, id, raw }); return;
        }
        const parsed = resultSchema.safeParse(value);
        if (!parsed.success) { finish(new Error("Public fixture processing parity failed.")); return; }
        if (parsed.data.pid !== worker.pid) { finish(new Error("Public fixture processor owner mismatch.")); return; }
        expectedExit = true; finish(); accept(parsed.data);
      });
    });
  } finally {
    expectedExit = true; worker.kill();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Processor reap failed.")), 10_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

/** Fixed public fixtures only, imported by the owned Electron driver after application readiness. */
export async function runParakeetProbe() {
  assert.equal(app.isReady(), true);
  assert.equal(process.getuid?.(), 1000);
  const modelPath = `/fixtures/${PARAKEET_FIXTURE.filename}`;
  assert.equal((await stat(modelPath)).size, PARAKEET_FIXTURE.bytes);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(modelPath)) hash.update(chunk);
  assert.equal(hash.digest("hex"), PARAKEET_FIXTURE.sha256);
  const pcm = await readFile("/fixtures/jfk.f32");
  assert.equal(pcm.length, 704_000);
  assert.equal(createHash("sha256").update(pcm).digest("hex"), "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0");
  const samples = new Float32Array(176_000);
  for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readFloatLE(i * 4);

  let parakeetRequests = 0;
  const actualFactory = createFixtureSpeechChannelFactory();
  const observedFactory: SpeechChannelFactory = async (signal) => {
    const channel = await actualFactory(signal);
    return { ...channel, send(request) {
      if (request.command === "transcribe" && request.model.family === "parakeet") {
        assert.equal(request.model.gpu, false);
        assert.equal(request.vocabulary, "");
        assert.equal(request.samples.length, 176_000);
        parakeetRequests += 1;
      }
      channel.send(request);
    } };
  };
  const client = new SpeechClient(observedFactory, { startupMs: 10_000, requestMs: 120_000 });
  const checks: string[] = [];
  const timings: number[] = [];
  try {
    assert.equal(await client.gpuDevice(), null);
    const original = owner();
    assert.equal((await readFile(`/proc/${original.pid}/maps`, "utf8")).includes("openwhisper_speech.node"), true);
    assert.equal((await readFile(`/proc/${process.pid}/maps`, "utf8")).includes("openwhisper_speech.node"), false);
    const environment = (await readFile(`/proc/${original.pid}/environ`, "utf8")).split("\0");
    for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) {
      assert.equal(environment.some((item) => item.startsWith(`${name}=`)), false);
    }
    checks.push("genuine checksum-pinned Q4_0 model; CPU addon only in disposable Electron utility; implicit preload aliases cleared");
    const model: SpeechModel = { path: modelPath, family: "parakeet", gpu: false };
    const infer = async (): Promise<string> => {
      const start = performance.now();
      const text = await client.transcribeWindow(model, samples, "en", "");
      timings.push((performance.now() - start) / 1000);
      assert.equal(/ask not what your country can do for you/i.test(text), true, "The public English fixture opening must be recognized.");
      assert.equal(/what you can do for your country/i.test(text), true, "The public English fixture ending must be recognized.");
      return text;
    };
    const first = await infer();
    assert.deepEqual(owner(), original);
    const second = await infer();
    assert.equal(digest(second), digest(first));
    assert.deepEqual(owner(), original);
    checks.push("two complete public English fixture inferences; identical hash; same PID/creation time; gpu false and native prompt empty");
    const processed = await postprocess(first);
    checks.push("production cleaner/vocabulary/snippet order in separate utility; synthetic Japanese/ZWJ snippet preserved; native absent there");
    await assert.rejects(client.transcribeWindow({ ...model, family: "whisper" }, samples, "en", ""),
      (error: unknown) => error instanceof SpeechWorkerError && error.code === "NATIVE_FAILED");
    assert.equal(await client.gpuDevice(), null);
    const replacement = owner();
    assert.notDeepEqual(replacement, original);
    const third = await infer();
    assert.equal(digest(third), digest(first));
    assert.deepEqual(owner(), replacement);
    assert.equal(parakeetRequests, 3);
    checks.push("wrong-family load fails without cached Parakeet reuse; confirmed fresh owner reload returns unchanged fixture hash");
    await client.close();
    await noOwners();
    checks.push("acknowledged native shutdown and utility reap; application remains alive");
    return { result: "PASS", mainAlive: true, checks, original, replacement, processed,
      transcriptSha256: digest(first), transcriptCharacters: first.length, sampleCount: samples.length, timings, versions: process.versions,
      scope: "Owned Ubuntu22 x64 Electron utility; genuine Parakeet Q4_0 CPU/public English fixture only. Historical fixture generic-exit cleanup only; no supervisor OS admission/retirement proof, microphone, language override, macOS, GPU or general accuracy proof." };
  } finally { await client.close(); }
}

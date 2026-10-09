import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, readFile, readdir, rename } from "node:fs/promises";
import { app } from "electron";
import { createFixtureSpeechChannelFactory } from "../fixtures/speech-bootstrap-channel.js";
import { SpeechClient, SpeechWorkerError } from "../../src/services/speech/speech-client.js";
import { PARAKEET_FIXTURE } from "../fixtures/parakeet-model.js";
import { ownedGpuInputSchema, ownedGpuResultSchema } from "./contract.js";

const tinySha = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";
const nativePath = "/owned-app/dist/native/openwhisper_speech.node";
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
async function fileSha(path: string): Promise<string> {
  const status = await lstat(path); assert.equal(status.isFile() && !status.isSymbolicLink(), true);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
const activeOwners = () => app.getAppMetrics().filter((item) => item.name === "OpenWhisper Speech" || item.serviceName === "OpenWhisper Speech");
async function noOwners(): Promise<void> {
  const deadline = performance.now() + 5000;
  while (activeOwners().length && performance.now() < deadline) await new Promise<void>((accept) => setTimeout(accept, 10));
  assert.equal(activeOwners().length, 0, "The failed/native owner must be reaped before replacement.");
}
async function owner(expected: string) {
  const active = activeOwners(); assert.equal(active.length, 1);
  const entry = active[0]; assert.ok(entry);
  const maps = await readFile(`/proc/${entry.pid}/maps`, "utf8");
  assert.equal(maps.includes(nativePath), true);
  assert.equal(await fileSha(nativePath), expected);
  assert.equal((await readFile(`/proc/${process.pid}/maps`, "utf8")).includes("openwhisper_speech.node"), false);
  const environment = (await readFile(`/proc/${entry.pid}/environ`, "utf8")).split("\0");
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH",
    "ELECTRON_NO_ASAR", "LD_LIBRARY_PATH", "LD_PRELOAD", "GGML_VK_VISIBLE_DEVICES"]) {
    assert.equal(environment.some((item) => item.startsWith(`${name}=`)), false);
  }
  const loaderPaths = [...new Set(maps.split("\n").map((line) => line.split(/\s+/u).at(-1) ?? "")
    .filter((path) => /\/libvulkan\.so(?:\.|$)/u.test(path)))];
  return { pid: entry.pid, creationTime: entry.creationTime, nativeSha256: expected, loaderPaths };
}

/** Fixed public fixtures. This runs in Electron main only to supervise the native utility. */
export async function runOwnedGpuProbe() {
  assert.equal(app.isReady(), true); assert.equal(process.getuid?.(), 1000);
  const input = ownedGpuInputSchema.parse(JSON.parse(await readFile("/fixtures/backend-input.json", "utf8")));
  assert.equal(await fileSha(nativePath), input.vulkanSha256);
  assert.equal(await fileSha("/fixtures/cpu.node"), input.cpuSha256);
  assert.equal(await fileSha("/owned-app/node_modules/electron/dist/electron"), input.electronSha256);
  assert.equal(await fileSha("/fixtures/ggml-tiny.bin"), tinySha);
  assert.equal((await lstat(`/fixtures/${PARAKEET_FIXTURE.filename}`)).size, PARAKEET_FIXTURE.bytes);
  assert.equal(await fileSha(`/fixtures/${PARAKEET_FIXTURE.filename}`), PARAKEET_FIXTURE.sha256);
  const pcm = await readFile("/fixtures/jfk.f32"); assert.equal(pcm.length, 704_000);
  assert.equal(createHash("sha256").update(pcm).digest("hex"), "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0");
  const samples = new Float32Array(176_000);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readFloatLE(i * 4);
  const checks: string[] = [];
  const owners: zResult["owners"] = [];
  const inference: zResult["inference"] = [];
  let startupFailure: "START_FAILED" | null = null;
  let explicitFixtureCpuReplacement = false;
  let client = new SpeechClient(createFixtureSpeechChannelFactory(), { startupMs: 10_000, requestMs: 120_000 });
  const infer = async (family: "whisper" | "parakeet", gpu: boolean): Promise<string> => {
    const began = performance.now();
    const text = await client.transcribeWindow({ path: family === "whisper" ? "/fixtures/ggml-tiny.bin" : `/fixtures/${PARAKEET_FIXTURE.filename}`,
      family, gpu }, samples, "en", "");
    assert.match(text, /ask not what your country can do for you/iu);
    assert.match(text, /what you can do for your country/iu);
    inference.push({ family, requestedGpu: gpu, sha256: digest(text), characters: text.length, seconds: (performance.now() - began) / 1000 });
    return text;
  };
  try {
    if (input.mode === "loader-absent") {
      for (const directory of ["/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu", "/owned-app/node_modules/electron/dist"]) {
        assert.equal((await readdir(directory)).some((name) => /^libvulkan\.so(?:\.|$)/u.test(name)), false);
      }
      await assert.rejects(client.gpuDevice(), (error: unknown) => error instanceof SpeechWorkerError && error.code === "START_FAILED");
      startupFailure = "START_FAILED";
      await client.close(); await noOwners();
      checks.push("actual Vulkan-linked utility binding load fails after bootstrap control safely with all system/Electron loader copies absent; confirmed reap");
      // Explicit test-owned fallback, not an automatic production worker/factory feature.
      await cp("/fixtures/cpu.node", `${nativePath}.fixture-cpu`);
      assert.equal(await fileSha(`${nativePath}.fixture-cpu`), input.cpuSha256);
      await rename(`${nativePath}.fixture-cpu`, nativePath);
      explicitFixtureCpuReplacement = true;
      client = new SpeechClient(createFixtureSpeechChannelFactory(), { startupMs: 10_000, requestMs: 120_000 });
      assert.equal(await client.gpuDevice(), null);
      const replacement = await owner(input.cpuSha256); assert.equal(replacement.loaderPaths.length, 0); owners.push(replacement);
      await infer("whisper", false);
      assert.deepEqual(await owner(input.cpuSha256), replacement);
      checks.push("separate verified portable CPU addon starts after failed GPU owner reap and recognizes the complete public fixture without any Vulkan loader");
    } else {
      assert.equal(await client.gpuDevice(), null);
      const original = await owner(input.vulkanSha256); assert.ok(original.loaderPaths.length > 0); owners.push(original);
      checks.push("Vulkan addon confined to disposable speech utility; its Vulkan loader mapping verified; no detected hardware GPU or override/preload aliases");
      for (const family of ["whisper", "parakeet"] as const) {
        const manualCpu = await infer(family, false);
        assert.deepEqual(await owner(input.vulkanSha256), original);
        const requestedGpu = await infer(family, true);
        assert.equal(digest(requestedGpu), digest(manualCpu));
        assert.deepEqual(await owner(input.vulkanSha256), original);
        checks.push(`${family}: manual CPU preserved and GPU-requested/no-device fallback returns the identical complete public English fixture hash`);
      }
    }
    await client.close(); await noOwners();
    checks.push("acknowledged native shutdown, confirmed helper reap and main remains alive");
    return ownedGpuResultSchema.parse({ result: "PASS", mode: input.mode, checks, mainAlive: true,
      cpuSha256: input.cpuSha256, vulkanSha256: input.vulkanSha256, owners, inference, nativeDevice: null,
      startupFailure, explicitFixtureCpuReplacement, versions: process.versions,
      scope: "Owned Ubuntu22 x64 Electron utility: compiled Vulkan backend, missing-device/software-only fallback and explicit fixture-only CPU replacement. Historical fixture generic-exit cleanup only; no supervisor OS admission/retirement proof, automatic factory selection, physical GPU, Metal/macOS, microphone or general speech-quality claim." });
  } finally { await client.close(); }
}

type zResult = import("zod").infer<typeof ownedGpuResultSchema>;

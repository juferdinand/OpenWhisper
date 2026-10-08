import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildRecordingProbe } from "./build-probe.js";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const image = "sha256:3031f986bb255608939c32b3929435c929efb4ce9be398786e369b1111d73431";
const addonSha = "e1b4c2c738285eb50cea155e65fc0b1eb4481e80a1849ded23bb2a8a679308c3";
const args = process.argv.slice(2);
if (args.length !== 12 || args[0] !== "--output" || args[2] !== "--model" || args[4] !== "--jfk" || args[6] !== "--baseline" || args[8] !== "--capture" || args[10] !== "--speech-build") {
  throw new Error("Usage: tsx tests/owned-recording/run.ts --output NEW_DIRECTORY --model PINNED_TINY --jfk PINNED_F32 --baseline SPEECH_RUN4 --capture FINAL_CAPTURE_PACKET --speech-build FROZEN_CPU_BUILD_PACKET");
}
const absolutePath = z.string().refine(isAbsolute);
const values = z.tuple([absolutePath, absolutePath, absolutePath, absolutePath, absolutePath, absolutePath]).parse([args[1], args[3], args[5], args[7], args[9], args[11]]);
const [output, model, audio, baseline, capturePacket, speechBuild] = values;
if (!output || !model || !audio || !baseline || !capturePacket || !speechBuild || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) {
  throw new Error("The launcher requires an ordinary x64 Linux owner and explicit absolute fixture paths.");
}
await mkdir(output, { recursive: false, mode: 0o700 });
const container = `openwhisper-owned-recording-${randomUUID()}`;
let sequence = 0;
const commands: { args: string[]; code: number; seconds: number }[] = [];
const started = new Date().toISOString();
let result = "FAIL";
let created = false;
let cleanupConfirmed = false;

async function docker(arguments_: string[], timeout = 60_000): Promise<{ code: number; stdout: string }> {
  const start = performance.now();
  const process_ = spawn("docker", arguments_, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "", log = "", timedOut = false;
  let force: NodeJS.Timeout | undefined;
  const collect = (chunk: Buffer, standard: boolean): void => {
    if (standard && stdout.length < 1024 * 1024) stdout += chunk.toString().slice(0, 1024 * 1024 - stdout.length);
    if (log.length < 1024 * 1024) log += chunk.toString().slice(0, 1024 * 1024 - log.length);
  };
  process_.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
  process_.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
  const timer = setTimeout(() => {
    timedOut = true; process_.kill("SIGTERM");
    force = setTimeout(() => process_.kill("SIGKILL"), 5000);
  }, timeout);
  const code = await new Promise<number>((accept, reject) => {
    process_.once("error", reject); process_.once("close", (status) => accept(timedOut ? 1 : status ?? 1));
  }).finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
  await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
  commands.push({ args: arguments_, code, seconds: (performance.now() - start) / 1000 });
  return { code, stdout };
}
async function required(arguments_: string[], timeout?: number): Promise<string> {
  const executed = await docker(arguments_, timeout);
  if (executed.code !== 0) throw new Error(`Owned fixture command failed; inspect ${output}.`);
  return executed.stdout.trim();
}
async function sha(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function regular(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("Pinned inputs must be regular files.");
}
async function manifest(root: string, prefix = ""): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    const name = join(prefix, item.name);
    if (item.isSymbolicLink()) throw new Error("Frozen distribution cannot contain symlinks.");
    if (item.isDirectory()) Object.assign(entries, await manifest(join(root, item.name), name));
    else if (item.isFile()) entries[name] = await sha(join(root, item.name));
  }
  return entries;
}
const addon = join(speechBuild, "cpu/openwhisper_speech.node");
const seccomp = join(baseline, "electron-seccomp.json");
const captureAddon = join(capturePacket, "run-short-stop-final/openwhisper_capture.node");
const captureSha = "68050249bc5c419f6a20b8715bb8461eafb8f1a90ba751e45adade4a4b71f67c";
try {
  for (const path of [model, audio, addon, seccomp, captureAddon]) await regular(path);
  if ((await lstat(model)).size !== 77_691_713 || await sha(model) !== "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" ||
      (await lstat(audio)).size !== 704_000 || await sha(audio) !== "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0" ||
      await sha(addon) !== addonSha || await sha(captureAddon) !== captureSha || await sha(seccomp) !== "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e") {
    throw new Error("Owned public fixture, CPU addon or security-policy pin did not match.");
  }
  const compiledSpeech = z.object({ version: z.literal(1), backend: z.literal("cpu"), platform: z.literal("linux"),
    architecture: z.literal("x64"), bindingSha256: z.literal(addonSha), compiledCpu: z.literal(true), portableCpu: z.literal(true),
    sourceHashes: z.record(z.string(), z.string()), cmakeCacheSha256: z.string().regex(/^[a-f0-9]{64}$/),
    speech: z.object({ revision: z.literal("927cfce34f31707e17f2bff35c349632fb9e2c3a"),
      sha256: z.literal("41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde") }),
    headers: z.object({ version: z.literal("24.21.0"), napiVersion: z.literal(8),
      sha256: z.literal("57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2") }),
  }).parse(JSON.parse(await readFile(join(speechBuild, "cpu/build-manifest.json"), "utf8")));
  const nativeSource: Record<string, string> = {};
  for (const [name, expected] of Object.entries(compiledSpeech.sourceHashes)) {
    if (name.includes("..") || !/^[A-Za-z0-9_./-]+$/.test(name)) throw new Error("Invalid native build source name.");
    if (await sha(join(speechBuild, "input", name)) !== expected) throw new Error("Compiled graph source hash changed.");
    nativeSource[name] = await sha(join(packageRoot, name));
    // Later build-tool notice refinements are not retroactively attributed to this addon.
    if (name.startsWith("native/") && nativeSource[name] !== expected) throw new Error("Compiled native source differs.");
  }
  for (const pin of ["whisper-source.json", "node-headers.json"]) {
    if (await sha(join(speechBuild, "input/native", pin)) !== await sha(join(packageRoot, "native", pin))) {
      throw new Error("Compiled source/header pins differ.");
    }
  }
  if (await sha(join(speechBuild, "cpu/CMakeCache.txt")) !== compiledSpeech.cmakeCacheSha256) {
    throw new Error("Compiled CMake cache hash changed.");
  }
  await cp(join(speechBuild, "input"), join(output, "speech-build-input"), { recursive: true });
  for (const file of ["build-manifest.json", "CMakeCache.txt", "build.ninja", "elf-versions.txt", "elf-dynamic.txt"]) {
    await cp(join(speechBuild, "cpu", file), join(output, `speech-${file}`));
  }
  const captureManifest = z.object({ status: z.literal("FROZEN"), files: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(join(capturePacket, "source-manifest.json"), "utf8")));
  for (const [name, expected] of Object.entries(captureManifest.files)) {
    if (name.includes("..") || !/^[A-Za-z0-9_./-]+$/.test(name) || await sha(join(packageRoot, name)) !== expected) {
      throw new Error("Final capture artifact source provenance changed.");
    }
  }
  await cp(join(capturePacket, "source-manifest.json"), join(output, "capture-source-manifest.json"));
  const distBefore = await manifest(join(packageRoot, "dist"));
  await cp(join(packageRoot, "dist"), join(output, "frozen-dist"), { recursive: true });
  if (JSON.stringify(distBefore) !== JSON.stringify(await manifest(join(output, "frozen-dist")))) throw new Error("Distribution copy changed.");
  await mkdir(join(output, "frozen-dist/native"), { recursive: true, mode: 0o700 });
  await cp(addon, join(output, "frozen-dist/native/openwhisper_speech.node"));
  await cp(captureAddon, join(output, "frozen-dist/native/openwhisper_capture.node"));
  await cp(join(packageRoot, "native/capture/notices"), join(output, "frozen-dist/native/capture-notices"), { recursive: true });
  await cp(join(packageRoot, "native/capture/miniaudio-source.json"), join(output, "frozen-dist/native/capture-notices/miniaudio-source.json"));
  const actualDist = await manifest(join(output, "frozen-dist"));
  await buildRecordingProbe(output);
  const sources: Record<string, string> = {};
  for (const path of ["tests/owned-recording/run.ts", "tests/owned-recording/build-probe.ts", "tests/owned-recording/entry.ts",
    "tests/owned-recording/probe.ts", "tests/owned-recording/contracts.ts", "tests/owned-recording.test.ts",
    "src/main/recording-effects.ts", "src/workers/recording-effects.ts", "src/workers/recording-effects-protocol.ts",
    "src/main/speech-channel.ts", "src/services/speech-client.ts", "src/services/adaptive-speech.ts", "src/services/capture.ts",
    "src/core/recording.ts", "src/core/speech-windows.ts", "src/core/transcript-cleaner.ts", "src/core/vocabulary-corrector.ts", "src/core/snippet-expander.ts",
    "src/workers/native-capture.ts", "src/workers/recovery.ts", "src/workers/speech-gate.ts", "src/workers/speech-entry.ts",
    "src/workers/speech-protocol.ts", "src/workers/native-speech.ts", "native/whisper-source.json", "native/node-headers.json"]) {
    sources[path] = await sha(join(packageRoot, path));
  }
  const inspectedImage = await required(["image", "inspect", image]);
  await writeFile(join(output, "image-inspect.json"), inspectedImage, { mode: 0o600 });
  await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "4g", "--shm-size", "256m",
    "--entrypoint", "/bin/sleep", image, "1200"]);
  created = true;
  await required(["cp", "-a", join(output, "frozen-dist"), `${container}:/owned-app/dist`]);
  for (const path of ["tests", "node_modules", "package.json", "package-lock.json", "tsconfig.json"]) {
    await required(["cp", "-a", join(packageRoot, path), `${container}:/owned-app/`]);
  }
  for (const file of ["probe.mjs", "entry.mjs"]) await required(["cp", "-a", join(output, file), `${container}:/owned-app/tests/owned-recording/`]);
  await required(["cp", "-a", model, `${container}:/fixtures/ggml-tiny.bin`]);
  await required(["cp", "-a", audio, `${container}:/fixtures/jfk.f32`]);
  const inspected = await required(["inspect", container]);
  await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  z.array(z.object({ Image: z.literal(image), Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1),
      Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private"), }), Mounts: z.array(z.unknown()).length(0),
  })).length(1).parse(JSON.parse(inspected));
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ image, nativeSource, sources, originalDist: distBefore, actualDist,
    compiledBuild: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/), modified: z.boolean() })
      .parse(JSON.parse(await readFile(join(output, "frozen-dist/resources/development-build.json"), "utf8"))),
    modelSha256: await sha(model), audioSha256: await sha(audio), speechAddon: addonSha, compiledSpeech, speechBuild,
    currentBuildToolsNotRetroactiveArtifactInputs: true, captureAddonSha256: captureSha,
    captureManifestSha256: await sha(join(capturePacket, "source-manifest.json")), baseline, capturePacket, electronSha256: await sha(join(packageRoot, "node_modules/electron/dist/electron")),
    packageLockSha256: await sha(join(packageRoot, "package-lock.json")), seccompSha256: await sha(seccomp),
    probeSha256: await sha(join(output, "probe.mjs")), entrySha256: await sha(join(output, "entry.mjs")),
    scope: "Actual Electron synthetic capture/recovery/adaptive/bounded CPU speech broker, private-Xvfb clipboard and running-main receipt cache. Fresh CPU backend-profile speech build graph and final capture graph retained separately. No host audio, services, mounts, stable data, auto-paste or history.",
  }, null, 2), { mode: 0o600 });
  await required(["start", container]);
  await required(["cp", `${container}:/etc/openwhisper-test-packages.txt`, join(output, "distro-packages.txt")]);
  const executed = await docker(["exec", "--user", "1000:1000", "--env", "OPENWHISPER_OWNED_RECORDING_TEST=1",
    "--env", "OPENWHISPER_RECORDING_EVIDENCE=/evidence", container,
    "/opt/node/bin/node", "--import", "tsx", "--test", "tests/owned-recording.test.ts"], 450_000);
  await required(["cp", `${container}:/evidence/.`, output]);
  if (executed.code !== 0) throw new Error("Owned recording pipeline failed; inspect its bounded logs.");
  if (JSON.stringify(actualDist) !== JSON.stringify(await manifest(join(output, "frozen-dist")))) throw new Error("Frozen distribution changed.");
  result = "PASS";
} finally {
  if (created) {
    const removed = await docker(["rm", "--force", container], 30_000);
    const remaining = await docker(["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"], 30_000);
    cleanupConfirmed = removed.code === 0 && remaining.code === 0 && remaining.stdout.trim() === "";
  }
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ result, started, completed: new Date().toISOString(),
    image, container, created, cleanupConfirmed, commands, output }, null, 2), { mode: 0o600 });
  if (created && !cleanupConfirmed) throw new Error("Owned container cleanup was not confirmed.");
}
console.log(`PASS: owned Electron recording pipeline acceptance; evidence ${output}`);

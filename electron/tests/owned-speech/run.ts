import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildOwnedSpeechProbe } from "./build-probe.js";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const fixtureRoot = join(packageRoot, "tests", "owned-speech");
const id = randomUUID();
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1])) {
  throw new Error("Usage: node --import tsx tests/owned-speech/run.ts [--output NEW_DIRECTORY]");
}
if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) {
  throw new Error("Run the owned speech launcher on x86_64 Linux as an ordinary user.");
}
const output = resolve(args[1] ?? join(packageRoot, ".local", "owned-speech", id));
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: false, mode: 0o700 });
const container = `openwhisper-owned-speech-${id}`;
const imageTag = `openwhisper-owned-speech:${id}`;
const commands: { args: string[]; exitCode: number; seconds: number }[] = [];
let sequence = 0;

async function docker(arguments_: string[], timeout = 300_000): Promise<{ code: number; stdout: string }> {
  const start = performance.now();
  const log = join(output, `${String(++sequence).padStart(2, "0")}-docker.log`);
  const child = spawn("docker", arguments_, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "";
  let combined = "";
  let timedOut = false;
  let forceTimer: NodeJS.Timeout | undefined;
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); combined += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { combined += chunk.toString(); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
  }, timeout);
  const code = await new Promise<number>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (value) => { accept(timedOut ? 1 : value ?? 1); });
  }).finally(() => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); });
  await writeFile(log, combined, { mode: 0o600 });
  commands.push({ args: arguments_, exitCode: code, seconds: (performance.now() - start) / 1000 });
  return { code, stdout };
}

async function required(arguments_: string[], timeout?: number): Promise<string> {
  const result = await docker(arguments_, timeout);
  if (result.code !== 0) throw new Error(`Owned speech docker ${arguments_[0]} failed; inspect ${output}.`);
  return result.stdout.trim();
}

async function sha(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileManifest(root: string, prefix = ""): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Frozen application assets must not contain symlinks.");
    if (entry.isDirectory()) Object.assign(hashes, await fileManifest(join(root, entry.name), relative));
    else if (entry.isFile()) hashes[relative] = await sha(join(root, entry.name));
  }
  return hashes;
}

async function pinnedDownload(url: string, expected: string, path: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  if (!response.ok) throw new Error("Pinned owned fixture download failed.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 128 * 1024 * 1024) throw new Error("Owned input exceeds archive limit.");
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Owned input checksum mismatch.");
  await writeFile(path, bytes, { mode: 0o600 });
  return bytes;
}

const policy = z.strictObject({
  upstream: z.strictObject({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), licenseUrl: z.url(), licenseSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  namespaceMask: z.literal(2114060288),
  namespaceFlags: z.tuple([z.literal(268435456), z.literal(805306368), z.literal(1342177280), z.literal(1879048192), z.literal(536870912), z.literal(1073741824), z.literal(1610612736)]),
  allowChroot: z.literal(true), scope: z.string(),
}).parse(JSON.parse(await readFile(join(packageRoot, "tests/owned-ui/seccomp.json"), "utf8")));

let result = "FAIL";
try {
  for (const path of ["dist/main/index.js", "dist/preload/index.cjs", "dist/main/speech-channel.js", "dist/workers/speech-entry.js",
    "dist/services/speech-client.js", "dist/native/openwhisper_speech.node", "node_modules/electron/dist/electron"]) {
    await access(join(packageRoot, path));
  }
  const distBefore = await fileManifest(join(packageRoot, "dist"));
  await cp(join(packageRoot, "dist"), join(output, "frozen-dist"), { recursive: true, errorOnExist: true, force: false });
  if (JSON.stringify(await fileManifest(join(output, "frozen-dist"))) !== JSON.stringify(distBefore) ||
      JSON.stringify(await fileManifest(join(packageRoot, "dist"))) !== JSON.stringify(distBefore)) {
    throw new Error("Application dist changed during frozen source copy.");
  }
  await writeFile(join(output, "frozen-dist.json"), JSON.stringify(distBefore, null, 2), { mode: 0o600 });
  const policyBytes = await pinnedDownload(policy.upstream.url, policy.upstream.sha256, join(output, "moby-default-seccomp.json"));
  await pinnedDownload(policy.upstream.licenseUrl, policy.upstream.licenseSha256, join(output, "LICENSE-moby"));
  const upstream = z.object({
    defaultAction: z.literal("SCMP_ACT_ERRNO"),
    syscalls: z.array(z.object({ names: z.array(z.string()), action: z.string() }).passthrough()),
  }).passthrough().parse(JSON.parse(new TextDecoder().decode(policyBytes)));
  upstream.syscalls.push({ names: ["chroot"], action: "SCMP_ACT_ALLOW" });
  for (const flags of policy.namespaceFlags) {
    upstream.syscalls.push({ names: ["clone"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: policy.namespaceMask, valueTwo: flags, op: "SCMP_CMP_MASKED_EQ" }] });
    upstream.syscalls.push({ names: ["unshare"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: flags, op: "SCMP_CMP_EQ" }] });
  }
  const seccomp = join(output, "electron-seccomp.json");
  await writeFile(seccomp, JSON.stringify(upstream, null, 2), { mode: 0o600 });
  await buildOwnedSpeechProbe(join(output, "probe.mjs"));
  const speechPin = z.strictObject({ repository: z.literal("ggml-org/whisper.cpp"), tag: z.literal("b5130"),
    revision: z.string().regex(/^[a-f0-9]{40}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(JSON.parse(await readFile(join(packageRoot, "native/whisper-source.json"), "utf8")));
  const headerPin = z.strictObject({ version: z.literal("24.21.0"), napiVersion: z.literal(8),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt") })
    .parse(JSON.parse(await readFile(join(packageRoot, "native/node-headers.json"), "utf8")));
  await pinnedDownload(`https://codeload.github.com/${speechPin.repository}/tar.gz/${speechPin.revision}`,
    speechPin.sha256, join(output, "whisper-source.tar.gz"));
  await pinnedDownload(`https://nodejs.org/download/release/v${headerPin.version}/node-v${headerPin.version}-headers.tar.gz`,
    headerPin.sha256, join(output, "node-headers.tar.gz"));
  // The original repository retains the independently pinned public speech fixture.
  const fixtureDirectory = resolve(process.env.OPENWHISPER_PUBLIC_SPEECH_FIXTURES ?? join(packageRoot, "../linux/target/speech-smoke"));
  const fixtureHashes = { "ggml-tiny.bin": "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    "jfk.f32": "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0" };
  for (const [file, expected] of Object.entries(fixtureHashes)) {
    if (await sha(join(fixtureDirectory, file)) !== expected) throw new Error("Public speech fixture checksum mismatch.");
  }
  console.log("Building private Ubuntu 22.04 runtime/compiler image; no application runs during provisioning.");
  await required(["build", "--tag", imageTag, fixtureRoot], 900_000);
  const image = await required(["image", "inspect", imageTag, "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Unexpected owned image identity.");
  await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000",
    "--cap-drop", "ALL", "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "3g", "--shm-size", "256m",
    "--entrypoint", "/bin/sleep", image, "1800"]);
  const nativeSource: Record<string, string> = {};
  for (const file of ["CMakeLists.txt", "speech_bridge.cpp", "speech_binding.cpp", "whisper-source.json", "node-headers.json"]) {
    nativeSource[file] = await sha(join(packageRoot, "native", file));
  }
  await required(["cp", join(output, "frozen-dist"), `${container}:/owned-app/dist`]);
  for (const path of ["tests", "node_modules", "package.json", "package-lock.json", "tsconfig.json"]) {
    await required(["cp", join(packageRoot, path), `${container}:/owned-app/`]);
  }
  await required(["cp", join(output, "probe.mjs"), `${container}:/owned-app/tests/owned-speech/probe.mjs`]);
  for (const file of Object.keys(fixtureHashes)) await required(["cp", join(fixtureDirectory, file), `${container}:/fixtures/`]);
  for (const file of ["whisper-source.tar.gz", "node-headers.tar.gz"]) await required(["cp", join(output, file), `${container}:/fixtures/`]);
  const inspected = await required(["inspect", container]);
  await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  const [configuration] = z.array(z.object({
    Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false),
      CapDrop: z.array(z.literal("ALL")).length(1), Devices: z.array(z.unknown()).length(0),
      PidMode: z.literal(""), IpcMode: z.literal("private"), }),
    Mounts: z.array(z.unknown()).length(0),
  })).length(1).parse(JSON.parse(inspected));
  if (!configuration) throw new Error("Missing owned container configuration.");
  await required(["start", container]);
  await required(["cp", `${container}:/etc/openwhisper-test-packages.txt`, join(output, "distro-packages.txt")]);
  const owned = async (arguments_: string[], timeout?: number): Promise<string> => required(["exec", "--user", "1000:1000", container, ...arguments_], timeout);
  const runMode = async (mode: "abi" | "cpu"): Promise<void> => {
    const run = await docker(["exec", "--user", "1000:1000", "--env", "DEBUG=pw:browser", "--env", "OPENWHISPER_OWNED_SPEECH_TEST=1",
      "--env", "OPENWHISPER_SPEECH_EVIDENCE=/evidence", "--env", `OPENWHISPER_SPEECH_MODE=${mode}`,
      container, "/opt/node/bin/node", "--import", "tsx", "--test", "tests/utility-speech.test.ts"], 210_000);
    await required(["cp", `${container}:/evidence/.`, output]);
    if (run.code !== 0) throw new Error(`Owned Electron speech ${mode} failed; inspect ${output}.`);
  };
  console.log("Proving incompatible host addon is contained in the actual utility process.");
  await owned(["/usr/bin/readelf", "--version-info", "/owned-app/dist/native/openwhisper_speech.node"]);
  await runMode("abi");
  console.log("Rebuilding the same pinned CPU source/header graph inside Ubuntu 22.04 as UID 1000.");
  await owned(["/usr/bin/mkdir", "-p", "/owned-app/native", "/owned-app/vendor/whisper.cpp", "/owned-app/vendor/node-headers"]);
  for (const file of Object.keys(nativeSource)) await required(["cp", join(packageRoot, "native", file), `${container}:/owned-app/native/`]);
  await owned(["/usr/bin/tar", "-xzf", "/fixtures/whisper-source.tar.gz", "--strip-components=1", "--no-same-owner", "-C", "/owned-app/vendor/whisper.cpp"]);
  await owned(["/usr/bin/tar", "-xzf", "/fixtures/node-headers.tar.gz", "--strip-components=1", "--no-same-owner", "-C", "/owned-app/vendor/node-headers"]);
  await owned(["/usr/bin/cmake", "-S", "/owned-app/native", "-B", "/owned-app/native/baseline-build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "-DWHISPER_SOURCE=/owned-app/vendor/whisper.cpp", "-DNODE_HEADERS=/owned-app/vendor/node-headers/include/node"]);
  await owned(["/usr/bin/cmake", "--build", "/owned-app/native/baseline-build", "--target", "openwhisper_speech", "--parallel", "4"], 600_000);
  await owned(["/usr/bin/cp", "/owned-app/native/baseline-build/openwhisper_speech.node", "/owned-app/dist/native/openwhisper_speech.node"]);
  await required(["cp", `${container}:/owned-app/native/baseline-build/openwhisper_speech.node`, join(output, "ubuntu22-openwhisper_speech.node")]);
  for (const file of ["CMakeCache.txt", "compile_commands.json", "build.ninja"]) {
    const copy = await docker(["cp", `${container}:/owned-app/native/baseline-build/${file}`, join(output, file)]);
    if (copy.code !== 0 && file !== "compile_commands.json") throw new Error("Native compile provenance copy failed.");
  }
  await owned(["/usr/bin/readelf", "--version-info", "/owned-app/dist/native/openwhisper_speech.node"]);
  await owned(["/usr/bin/c++", "--version"]);
  console.log("Running actual Electron CPU reuse, failure, crash, watchdog, cancellation and shutdown probes.");
  await runMode("cpu");
  if (JSON.stringify(await fileManifest(join(output, "frozen-dist"))) !== JSON.stringify(distBefore)) {
    throw new Error("Frozen application build changed during owned acceptance.");
  }
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ image, dist: distBefore, nativeSource, speechPin, headerPin, fixtureHashes,
    baselineAddon: await sha(join(output, "ubuntu22-openwhisper_speech.node")),
    electron: await sha(join(packageRoot, "node_modules/electron/dist/electron")),
    test: await sha(join(packageRoot, "tests/utility-speech.test.ts")), probe: await sha(join(fixtureRoot, "probe.ts")),
    launcher: await sha(fileURLToPath(import.meta.url)),
    policy: await sha(join(packageRoot, "tests/owned-ui/seccomp.json")), dockerfile: await sha(join(fixtureRoot, "Dockerfile")),
    nodeVersion: "24.21.0", scope: "Owned CPU utility/native probe only; no GPU/Parakeet/capture/clipboard/trigger parity. Renderer sandbox enabled; utility itself is not an OS sandbox.",
  }, null, 2), { mode: 0o600 });
  result = "PASS";
} finally {
  await docker(["rm", "--force", container], 30_000);
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ result, commands, output }, null, 2), { mode: 0o600 });
}
console.log(`PASS: owned Electron CPU utility transport; evidence ${output}`);

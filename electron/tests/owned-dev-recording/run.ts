import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { buildSpeechEntryGraph } from "../../scripts/build-speech-entry-graph.js";
import { developmentRecordingDescriptorSchema } from "../../src/main/development-recording-descriptor.js";
import { waitForOriginalCommandClose } from "../owned-supervisor/run.js";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const args = process.argv.slice(2);
const absolute = z.string().min(1).max(4096).refine((path) => path === resolve(path) && !path.includes("\0"));
if (args.length !== 6 || args[0] !== "--output" || args[2] !== "--artifacts-root" || args[4] !== "--fixtures"
    || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) throw new Error("INVALID_EXECUTION");
const output = absolute.parse(args[1]), planning = absolute.parse(args[3]), fixtures = absolute.parse(args[5]);
for (const path of [planning, fixtures]) {
  const directory = await lstat(path); assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.ok(output !== path && !output.startsWith(`${path}/`) || (path === planning && output.startsWith(`${planning}/p4-linux-dev-recording/`)));
}
const IMAGE = "sha256:741fe6d91a1dbbb4b371448920d6c02274a28ca3d380e7d71049da5cd666f488";
const capture = join(planning, "p4-linux-dev-recording/native-sources/run-1/openwhisper_capture.node");
const speech = join(planning, "p6-proposal/gpu-build-1/cpu/openwhisper_speech.node");
const bus = join(planning, "p3-bus-opening/async-call-legacy-run-3/package/payload/dist/native/openwhisper_linux_bus.node");
const seccomp = join(planning, "p2-owned-speech/run-4/electron-seccomp.json");
await mkdir(output, { mode: 0o700, recursive: false });
const payload = join(output, "payload"), app = join(payload, "app"); await mkdir(payload, { mode: 0o700 });
const describe = async (path: string) => { const bytes = await readFile(path); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
async function inventory(directory: string, prefix = ""): Promise<Record<string, { bytes: number; sha256: string }>> {
  const values: Record<string, { bytes: number; sha256: string }> = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.equal(entry.isSymbolicLink(), false); const relative = join(prefix, entry.name), path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(values, await inventory(path, relative));
    else { assert.equal(entry.isFile(), true); values[relative] = await describe(path); }
  }
  return values;
}
const distBefore = await inventory(join(root, "dist"));
await cp(join(root, "dist"), join(app, "dist"), { recursive: true, errorOnExist: true, force: false });
await cp(join(root, "package.json"), join(app, "package.json"), { errorOnExist: true, force: false });
await mkdir(join(app, "node_modules"), { mode: 0o700 });
for (const name of ["zod", "electron", "@playwright/test", "playwright", "playwright-core"]) {
  await mkdir(dirname(join(app, "node_modules", name)), { recursive: true, mode: 0o700 });
  await cp(join(root, "node_modules", name), join(app, "node_modules", name), { recursive: true, errorOnExist: true, force: false });
}
assert.deepEqual(await inventory(join(root, "dist")), distBefore);
const captureRecord = await describe(capture), speechRecord = await describe(speech);
const busRecord = await describe(bus);
assert.equal(busRecord.sha256, "0d32cffa96fb5255bb49ec95ca6404c30887b068bf159fdcc966b7ceb7d2d0e1");
assert.equal(captureRecord.sha256, "5a1ddfef8381d750b059f28416279557c50039161f312e3b5d4b31fdbdae3ba2"); assert.equal(captureRecord.bytes, 433280);
assert.equal(speechRecord.sha256, "e1b4c2c738285eb50cea155e65fc0b1eb4481e80a1849ded23bb2a8a679308c3");
assert.equal((await describe(join(planning, "p6-proposal/gpu-build-1/cpu/build-manifest.json"))).sha256, "ed87efb43797a90f8cfa7e0fb594b6237ae4c1a89b2b34e10f29c1d86f92c7bc");
assert.equal((await describe(seccomp)).sha256, "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e");
assert.equal((await describe(join(app, "node_modules/electron/dist/electron"))).sha256, "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564");
await cp(join(planning, "p6-proposal/gpu-build-1/cpu/build-manifest.json"), join(output, "cpu-build-manifest.json"));
await cp(join(planning, "p4-linux-dev-recording/native-sources/run-1/source-manifest.json"), join(output, "capture-source-manifest.json"));
const originalModule: unknown = await import(pathToFileURL(join(root, "dist/main/development-recording-build.js")).href);
const original = z.object({ DEVELOPMENT_RECORDING_BUILD: developmentRecordingDescriptorSchema }).parse(originalModule).DEVELOPMENT_RECORDING_BUILD;
await cp(capture, join(app, "dist/native/capture/openwhisper_capture.node"));
await cp(speech, join(app, "dist/native/speech/cpu/openwhisper_speech.node"));
await cp(bus, join(app, "dist/native/openwhisper_linux_bus.node"));
const graph = await buildSpeechEntryGraph(app);
const descriptor = developmentRecordingDescriptorSchema.parse({ ...original,
  capture: captureRecord, captureEntry: await describe(join(app, "dist/workers/capture-entry.js")), speechEntryGraph: graph.graph,
  platformServices: { entry: await describe(join(app, "dist/workers/platform-entry.js")), bus: busRecord },
  speech: { ...original.speech, entries: [{ backend: "cpu", ...speechRecord }] } });
// Fixed fixture assembly before execution. The normal host consumes this captured
// typed record; runtime never refreshes expected hashes from its current files.
await build({ stdin: { contents: `export const DEVELOPMENT_RECORDING_BUILD: unknown = ${JSON.stringify(descriptor)};`, loader: "ts", resolveDir: root },
  outfile: join(app, "dist/main/development-recording-build.js"), platform: "node", format: "esm", target: "node24", sourcemap: false });
await mkdir(join(payload, "fixtures"), { mode: 0o700 });
for (const name of ["ggml-tiny.bin", "jfk.f32"]) await cp(join(fixtures, name), join(payload, "fixtures", name), { errorOnExist: true, force: false });
const bundled = await build({ entryPoints: [join(root, "tests/owned-dev-recording/driver.ts")], outfile: join(payload, "driver.mjs"),
  platform: "node", format: "esm", target: "node24", bundle: true, external: ["@playwright/test"], metafile: true, sourcemap: false });
// The driver resolves Playwright from its sibling normal application's dependencies.
for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
  await mkdir(dirname(join(payload, "node_modules", name)), { recursive: true, mode: 0o700 });
  await cp(join(app, "node_modules", name), join(payload, "node_modules", name), { recursive: true });
}
const sources: Record<string, { bytes: number; sha256: string }> = {};
for (const name of Object.keys(bundled.metafile.inputs)) sources[name] = await describe(resolve(root, name));
sources["tests/owned-dev-recording/run.ts"] = await describe(fileURLToPath(import.meta.url));
await writeFile(join(output, "assembly.json"), JSON.stringify({ image: IMAGE, sources, originalDescriptor: original, descriptor,
  originalDist: distBefore, payload: await inventory(payload), native: { capture: { path: capture, ...captureRecord }, speech: { path: speech, ...speechRecord }, bus: { path: bus, ...busRecord } },
  seccomp: { path: seccomp, ...await describe(seccomp) },
  scope: "Normal Dev main/preload/shared UI and capture utility; retained Ubuntu22 native inputs assembled before private runtime." }, null, 2), { mode: 0o600 });
const frozen = await inventory(payload);
const container = `openwhisper-owned-dev-recording-${randomUUID()}`;
const dockerConfig = join(output, "docker-config"); await mkdir(dockerConfig, { mode: 0o700 });
const commands: { args: string[]; code: number; expired: boolean; overflow: boolean; errored: boolean; closureObserved: boolean }[] = [];
const outstanding = new Set<Promise<unknown>>(); let sequence = 0, created = false, result = "FAIL", namespaceRemoved = false;
async function docker(args: string[], milliseconds = 30_000) {
  const end = performance.now() + milliseconds;
  const process = spawn("/usr/bin/docker", ["--config", dockerConfig, "--host", "unix:///var/run/docker.sock", ...args],
    { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", log = "", bytes = 0, expired = false, overflow = false, closureObserved = false;
  let force: NodeJS.Timeout | undefined;
  const stop = () => { process.kill("SIGTERM"); force ??= setTimeout(() => { process.kill("SIGKILL"); }, 2000); };
  const collect = (block: Buffer, standard: boolean) => { bytes += block.length;
    if (bytes > 1024 * 1024) { overflow = true; stop(); return; } log += block.toString(); if (standard) stdout += block.toString(); };
  process.stdout.on("data", (block: Buffer) => collect(block, true)); process.stderr.on("data", (block: Buffer) => collect(block, false));
  const timer = setTimeout(() => { expired = true; stop(); }, milliseconds);
  const originalClose = waitForOriginalCommandClose(process, end, () => ({ expired, overflow })); outstanding.add(originalClose);
  void originalClose.then(() => { closureObserved = true; outstanding.delete(originalClose); clearTimeout(timer); if (force) clearTimeout(force); });
  let expiry: NodeJS.Timeout | undefined;
  let observed = { code: 1, expired: true, overflow, errored: true };
  try { observed = await Promise.race([originalClose, new Promise<never>((_, reject) => { expiry = setTimeout(() => reject(new Error("ORIGINAL_CLOSE_MISSING")), milliseconds + 5000); })]); }
  catch { stop(); } finally { if (expiry) clearTimeout(expiry); }
  await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
  commands.push({ args, ...observed, closureObserved }); return { ...observed, stdout, closureObserved };
}
async function required(args: string[], milliseconds?: number) {
  const value = await docker(args, milliseconds); assert.equal(value.code, 0); assert.equal(value.closureObserved, true); return value.stdout.trim();
}
try {
  const image = await required(["image", "inspect", IMAGE]); z.array(z.object({ Id: z.literal(IMAGE) })).length(1).parse(JSON.parse(image));
  created = true;
  await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "4g", "--shm-size", "256m",
    "--ulimit", "core=0:0", "--entrypoint", "/bin/sleep", IMAGE, "500"]);
  await required(["cp", "-a", payload, `${container}:/payload`]);
  const inspected = await required(["inspect", container]); await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  z.array(z.object({ Image: z.literal(IMAGE), State: z.object({ Running: z.literal(false) }), Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1),
      Devices: z.array(z.unknown()).length(0), Binds: z.null(), PidMode: z.literal(""), IpcMode: z.literal("private"),
      SecurityOpt: z.array(z.string()).refine((entries) => entries.includes("no-new-privileges")),
      Ulimits: z.array(z.object({ Name: z.literal("core"), Soft: z.literal(0), Hard: z.literal(0) })).length(1) }), Mounts: z.array(z.unknown()).length(0) })).length(1).parse(JSON.parse(inspected));
  const copied = join(output, "stopped-payload"); await required(["cp", "-a", `${container}:/payload`, copied]); assert.deepEqual(await inventory(copied), frozen);
  await required(["start", container]);
  await required(["exec", "--user", "1000:1000", container, "/usr/bin/chmod", "-R", "a-w", "/payload"]);
  const observed = await docker(["exec", "--user", "1000:1000", container, "/usr/bin/env", "-i", "PATH=/opt/node/bin:/usr/bin:/bin", "LANG=C.UTF-8",
    "OPENWHISPER_OWNED_DEV_RECORDING=1", "/opt/node/bin/node", "/payload/driver.mjs"], 210_000);
  await required(["cp", `${container}:/evidence/.`, output]); assert.equal(observed.code, 0); assert.equal(observed.closureObserved, true);
  z.object({ status: z.literal("PASS"), clipboardConfirmed: z.literal(true), recoveryRemoved: z.literal(true), nativeInMain: z.literal(false) })
    .parse(JSON.parse(await readFile(join(output, "result.json"), "utf8")));
  z.object({ status: z.literal("PASS"), appClosed: z.literal(true), serverClosesObserved: z.literal(true) })
    .parse(JSON.parse(await readFile(join(output, "lifecycle.json"), "utf8")));
  assert.deepEqual(await inventory(payload), frozen); result = "PASS";
} finally {
  if (created) {
    try { await docker(["cp", `${container}:/evidence/.`, output], 10_000); } catch {}
    try { await docker(["rm", "--force", container], 20_000); } catch {}
    try { const absent = await docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`], 10_000);
      namespaceRemoved = absent.code === 0 && absent.closureObserved && absent.stdout.trim() === ""; } catch {}
  }
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ status: namespaceRemoved && outstanding.size === 0 ? result : "FAIL",
    image: IMAGE, container, namespaceRemoved, originalClosesConfirmed: outstanding.size === 0, commands }, null, 2), { mode: 0o600 });
  assert.equal(namespaceRemoved, true); assert.equal(outstanding.size, 0);
}
assert.equal(result, "PASS");

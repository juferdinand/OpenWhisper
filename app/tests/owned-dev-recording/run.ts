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
import { parseApplicationBuildModule, type BuildIdentity } from "../../src/contracts/application/build-identity.js";
import { waitForOriginalCommandClose } from "../owned-supervisor/run.js";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const launcherStarted = performance.now();
const args = process.argv.slice(2);
const absolute = z.string().min(1).max(4096).refine((path) => path === resolve(path) && !path.includes("\0"));
const kdeLifecycle = args[6] === "--stock-kde-lifecycle";
const kdeOverlay = args[6] === "--stock-kde-overlay";
const kdeWaylandOverlay = args[6] === "--stock-kde-wayland-overlay";
const kdeXwaylandPaste = args[6] === "--stock-kde-xwayland-paste";
const kdePaste = args[6] === "--stock-kde-paste" || kdeXwaylandPaste;
const nativeX11 = args[6] === "--native-x11";
const stockKde = args[6] === "--stock-kde" || kdeLifecycle || kdePaste || kdeOverlay || kdeWaylandOverlay;
const portalFixture = !stockKde && !nativeX11;
const copiedNode = stockKde || nativeX11;
const packaged = nativeX11 && args[7] === "--package-directory";
const installPackage = packaged && args[9] === "--install-package";
const stablePackage = packaged && args[9] === "--stable-package";
const installedDebian = stablePackage && args[10] === "--debian-package";
const appImage = stablePackage && args[10] === "--appimage-bundle";
const appImageStartupOnly = appImage && args[12] === "--appimage-startup-only";
const supervisedLaunch = stablePackage && (installedDebian || appImage) && args[12] === "--supervised-launch";
const appImageAdmission = appImage && (args[12] === "--appimage-admission" || supervisedLaunch);
const resourceDiagnostic = supervisedLaunch && installedDebian && args[17] === "--resource-diagnostic";
const updateCheck = supervisedLaunch && installedDebian && args[17] === "--update-check";
if (args.length !== (resourceDiagnostic || updateCheck ? 18 : supervisedLaunch ? 17 : appImageStartupOnly || appImageAdmission ? 13 : installedDebian || appImage ? 12 : packaged ? installPackage || stablePackage ? 10 : 9 : copiedNode ? 7 : 6) || args[0] !== "--output" || args[2] !== "--artifacts-root" || args[4] !== "--fixtures"
    || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) throw new Error("INVALID_EXECUTION");
const output = absolute.parse(args[1]), planning = absolute.parse(args[3]), fixtures = absolute.parse(args[5]);
const packageDirectory = packaged ? absolute.parse(args[8]) : undefined;
const debianPackage = installedDebian ? absolute.parse(args[11]) : undefined;
const appImageBundle = appImage ? absolute.parse(args[11]) : undefined;
const artifactSchema = z.strictObject({ bytes: z.number().int().nonnegative().max(1024 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const updateInputSchema = z.strictObject({ version: z.literal(1), classification: z.literal("CANONICAL_STABLE_VALIDATION_ONLY"),
  source: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) }),
  sourceVersion: z.literal("0.3.0"), files: z.record(z.string(), artifactSchema),
  modes: z.record(z.string(), z.number().int().min(0).max(0o7777)) });
let updateInput: z.infer<typeof updateInputSchema> | undefined;
const supervisorInputSchema = z.strictObject({ version: z.literal(1), classification: z.literal("OWNED_SUPERVISOR_RUNTIME_INPUT"),
  source: z.strictObject({ commit: z.literal("2ce4a2285bf90de15fe9294bfa1c30630d1ab8bc"), modified: z.literal(false) }),
  packageDirectory: absolute, packageFiles: z.record(z.string(), artifactSchema),
  packageModes: z.record(z.string(), z.number().int().min(0).max(0o7777)),
  debian: z.strictObject({ path: absolute, ...artifactSchema.shape }),
  appImage: z.strictObject({ directory: absolute, receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    image: z.strictObject({ path: absolute, ...artifactSchema.shape }), launcher: z.strictObject({ path: absolute, ...artifactSchema.shape }) }) });
let supervisorInput: z.infer<typeof supervisorInputSchema> | undefined, supervisorReceiptBytes: Buffer | undefined;
let supervisorReceiptPath: string | undefined, supervisorReceiptSha256: string | undefined;
if (supervisedLaunch) {
  assert.equal(args[13], "--producer-receipt"); assert.equal(args[15], "--producer-sha256");
  supervisorReceiptPath = absolute.parse(args[14]); supervisorReceiptSha256 = z.string().regex(/^[a-f0-9]{64}$/u).parse(args[16]);
  const file = await lstat(supervisorReceiptPath); assert.ok(file.isFile() && !file.isSymbolicLink() && file.size <= 8 * 1024 * 1024);
  supervisorReceiptBytes = await readFile(supervisorReceiptPath);
  assert.equal(createHash("sha256").update(supervisorReceiptBytes).digest("hex"), supervisorReceiptSha256);
  const receipt: unknown = JSON.parse(supervisorReceiptBytes.toString("utf8"));
  if (updateCheck) {
    updateInput = updateInputSchema.parse(receipt);
    assert.ok(Object.keys(updateInput.files).length <= 20_000 && Object.keys(updateInput.modes).length <= 25_000);
  } else {
    supervisorInput = supervisorInputSchema.parse(receipt);
    assert.equal(supervisorInput.packageDirectory, packageDirectory);
    assert.ok(Object.keys(supervisorInput.packageFiles).length <= 20_000 && Object.keys(supervisorInput.packageModes).length <= 25_000);
  }
}

for (const path of [planning, fixtures]) {
  const directory = await lstat(path); assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.ok(output !== path && !output.startsWith(`${path}/`) || (path === planning &&
    ["p4-linux-dev-recording", "p28-stable-control"].some((namespace) => output.startsWith(`${planning}/${namespace}/`))));
}
const IMAGE = copiedNode ? "sha256:796933aebc81829a07ba245ea7e10b594f032b2b90bcaf70002ce8395f2c2b33"
  : "sha256:741fe6d91a1dbbb4b371448920d6c02274a28ca3d380e7d71049da5cd666f488";
const capture = join(planning, "p4-linux-dev-recording/native-sources/run-1/openwhisper_capture.node");
const speech = join(planning, "p6-proposal/gpu-build-1/cpu/openwhisper_speech.node");
const bus = join(planning, "p3-bus-opening/async-call-legacy-run-3/package/payload/dist/native/openwhisper_linux_bus.node");
const seccomp = join(planning, "p2-owned-speech/run-4/electron-seccomp.json");
await mkdir(output, { mode: 0o700, recursive: false });
const payload = join(output, "payload"), app = packaged ? join(payload, "package/resources/app") : join(payload, "app");
await mkdir(payload, { mode: 0o700 });
const describe = async (path: string) => { const bytes = await readFile(path); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
async function inventory(directory: string, prefix = "", modes?: Record<string, number>): Promise<Record<string, { bytes: number; sha256: string }>> {
  const values: Record<string, { bytes: number; sha256: string }> = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.equal(entry.isSymbolicLink(), false); const relative = join(prefix, entry.name), path = join(directory, entry.name);
    if (modes) modes[relative] = (await lstat(path)).mode & 0o7777;
    if (entry.isDirectory()) Object.assign(values, await inventory(path, relative, modes));
    else { assert.equal(entry.isFile(), true); values[relative] = await describe(path); }
  }
  return values;
}
type Artifact = { bytes: number; sha256: string };
let distBefore: Record<string, Artifact>, original: z.infer<typeof developmentRecordingDescriptorSchema>, descriptor: z.infer<typeof developmentRecordingDescriptorSchema>;
let captureRecord: Artifact, speechRecord: Artifact, busRecord: Artifact;
let packageBefore: Record<string, Artifact> | undefined;
const packageModes: Record<string, number> = {};
let debianBefore: Artifact | undefined, debianVersion: string | undefined;
let applicationBuild: BuildIdentity | undefined;
if (packageDirectory) {
  const directory = await lstat(packageDirectory); assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.ok(output !== packageDirectory && !output.startsWith(`${packageDirectory}/`) && !packageDirectory.startsWith(`${output}/`));
  packageBefore = await inventory(packageDirectory, "", installedDebian || appImage ? packageModes : undefined);
  if (supervisorInput) { assert.deepEqual(packageBefore, supervisorInput.packageFiles); assert.deepEqual(packageModes, supervisorInput.packageModes); }
  await cp(packageDirectory, join(payload, "package"), { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await inventory(join(payload, "package")), packageBefore);
  distBefore = await inventory(join(app, "dist"));
  applicationBuild = parseApplicationBuildModule(await readFile(join(app, "dist/main/application-build.js"), "utf8"));
  assert.equal(applicationBuild.kind, stablePackage ? "stable" : "development");
  if (supervisorInput) assert.deepEqual(JSON.parse(await readFile(join(app, "dist/resources/development-build.json"), "utf8")), supervisorInput.source);
  if (updateInput) assert.deepEqual(JSON.parse(await readFile(join(app, "dist/resources/development-build.json"), "utf8")), updateInput.source);
  const module: unknown = await import(pathToFileURL(join(app, "dist/main/development-recording-build.js")).href);
  original = z.object({ DEVELOPMENT_RECORDING_BUILD: developmentRecordingDescriptorSchema }).parse(module).DEVELOPMENT_RECORDING_BUILD;
  descriptor = original;
  if (descriptor.platform !== "linux") throw new Error("INVALID_PACKAGE_PLATFORM");
  captureRecord = await describe(join(app, "dist/native/capture/openwhisper_capture.node"));
  speechRecord = await describe(join(app, "dist/native/speech/cpu/openwhisper_speech.node"));
  busRecord = await describe(join(app, "dist/native/openwhisper_linux_bus.node"));
  assert.deepEqual(captureRecord, descriptor.capture); assert.deepEqual(busRecord, descriptor.platformServices?.bus);
  const cpu = descriptor.speech.entries.find((entry) => entry.backend === "cpu"); assert.ok(cpu);
  assert.deepEqual(speechRecord, { bytes: cpu.bytes, sha256: cpu.sha256 });
  assert.equal((await describe(join(payload, "package", stablePackage ? "openwhisper" : "openwhisper-dev"))).sha256, "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564");
  if (debianPackage) {
    const archive = await lstat(debianPackage); assert.ok(archive.isFile() && !archive.isSymbolicLink());
    assert.ok(!debianPackage.startsWith(`${output}/`));
    debianBefore = await describe(debianPackage);
    if (supervisorInput) { assert.equal(debianPackage, supervisorInput.debian.path); assert.deepEqual(debianBefore, { bytes: supervisorInput.debian.bytes, sha256: supervisorInput.debian.sha256 }); }
    const source = z.strictObject({ commit: z.union([z.string().regex(/^[a-f0-9]{40}$/u), z.literal("source")]), modified: z.boolean() })
      .parse(JSON.parse(await readFile(join(app, "dist/resources/development-build.json"), "utf8")));
    const version = (await readFile(join(app, "dist/resources/VERSION"), "utf8")).trim();
    assert.match(version, /^\d+\.\d+\.\d+$/u);
    assert.equal(z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(app, "package.json"), "utf8"))).version, version);
    debianVersion = updateInput ? updateInput.sourceVersion : `${version}~dev.${source.commit.slice(0, 12)}${source.modified ? ".modified" : ""}`;
    if (updateInput) {
      assert.equal(version, updateInput.sourceVersion);
      const directory = "OpenWhisper-Linux-x64", artifact = "OpenWhisper-Linux-amd64.deb";
      assert.equal(packageDirectory, join(dirname(packageDirectory), directory));
      assert.equal(debianPackage, join(dirname(debianPackage), artifact));
      assert.deepEqual(updateInput.files, { [artifact]: debianBefore,
        ...Object.fromEntries(Object.entries(packageBefore).map(([name, value]) => [`${directory}/${name}`, value])) });
      assert.deepEqual(updateInput.modes, { [artifact]: archive.mode & 0o7777, [directory]: (await lstat(packageDirectory)).mode & 0o7777,
        ...Object.fromEntries(Object.entries(packageModes).map(([name, mode]) => [`${directory}/${name}`, mode])) });
    }
    await cp(debianPackage, join(payload, "package.deb"), { errorOnExist: true, force: false });
    assert.deepEqual(await describe(join(payload, "package.deb")), debianBefore);
  }
} else {
distBefore = await inventory(join(root, "dist"));
await cp(join(root, "dist"), join(app, "dist"), { recursive: true, errorOnExist: true, force: false });
await cp(join(root, "package.json"), join(app, "package.json"), { errorOnExist: true, force: false });
await mkdir(join(app, "node_modules"), { mode: 0o700 });
for (const name of ["zod", "electron", "@playwright/test", "playwright", "playwright-core", "koffi", "@koromix/koffi-linux-x64"]) {
  await mkdir(dirname(join(app, "node_modules", name)), { recursive: true, mode: 0o700 });
  await cp(join(root, "node_modules", name), join(app, "node_modules", name), { recursive: true, errorOnExist: true, force: false });
}
for (const name of ["koffi", "@koromix/koffi-linux-x64"]) {
  assert.equal(z.object({ version: z.literal("3.3.2") }).parse(JSON.parse(await readFile(join(app, "node_modules", name, "package.json"), "utf8"))).version, "3.3.2");
}
assert.deepEqual(await inventory(join(root, "dist")), distBefore);
captureRecord = await describe(capture); speechRecord = await describe(speech);
busRecord = await describe(bus);
assert.equal(busRecord.sha256, "0d32cffa96fb5255bb49ec95ca6404c30887b068bf159fdcc966b7ceb7d2d0e1");
assert.equal(captureRecord.sha256, "5a1ddfef8381d750b059f28416279557c50039161f312e3b5d4b31fdbdae3ba2"); assert.equal(captureRecord.bytes, 433280);
assert.equal(speechRecord.sha256, "e1b4c2c738285eb50cea155e65fc0b1eb4481e80a1849ded23bb2a8a679308c3");
assert.equal((await describe(join(planning, "p6-proposal/gpu-build-1/cpu/build-manifest.json"))).sha256, "ed87efb43797a90f8cfa7e0fb594b6237ae4c1a89b2b34e10f29c1d86f92c7bc");
assert.equal((await describe(seccomp)).sha256, "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e");
assert.equal((await describe(join(app, "node_modules/electron/dist/electron"))).sha256, "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564");
await cp(join(planning, "p6-proposal/gpu-build-1/cpu/build-manifest.json"), join(output, "cpu-build-manifest.json"));
await cp(join(planning, "p4-linux-dev-recording/native-sources/run-1/source-manifest.json"), join(output, "capture-source-manifest.json"));
const originalModule: unknown = await import(pathToFileURL(join(root, "dist/main/development-recording-build.js")).href);
original = z.object({ DEVELOPMENT_RECORDING_BUILD: developmentRecordingDescriptorSchema }).parse(originalModule).DEVELOPMENT_RECORDING_BUILD;
await cp(capture, join(app, "dist/native/capture/openwhisper_capture.node"));
await cp(speech, join(app, "dist/native/speech/cpu/openwhisper_speech.node"));
await cp(bus, join(app, "dist/native/openwhisper_linux_bus.node"));
const graph = await buildSpeechEntryGraph(app);
descriptor = developmentRecordingDescriptorSchema.parse({ ...original,
  capture: captureRecord, captureEntry: await describe(join(app, "dist/workers/capture-entry.js")), speechEntryGraph: graph.graph,
  platformServices: { entry: await describe(join(app, "dist/workers/platform-entry.js")), bus: busRecord },
  speech: { ...original.speech, entries: [{ backend: "cpu", ...speechRecord }] } });
// Fixed fixture assembly before execution. The normal host consumes this captured
// typed record; runtime never refreshes expected hashes from its current files.
await build({ stdin: { contents: `export const DEVELOPMENT_RECORDING_BUILD: unknown = ${JSON.stringify(descriptor)};`, loader: "ts", resolveDir: root },
  outfile: join(app, "dist/main/development-recording-build.js"), platform: "node", format: "esm", target: "node24", sourcemap: false });
}
let appImageInput: { image: Artifact; launcher: Artifact; producer: { commit: string; modified: boolean } } | undefined;
let appImageFilename: string | undefined;
if (appImageBundle) {
  const directory = await lstat(appImageBundle); assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.ok(!output.startsWith(`${appImageBundle}/`) && !appImageBundle.startsWith(`${output}/`));
  if (supervisorInput) {
    assert.equal(appImageBundle, supervisorInput.appImage.directory);
    assert.equal((await describe(join(appImageBundle, "receipt.json"))).sha256, supervisorInput.appImage.receiptSha256);
  }
  const receipt = z.object({ classification: z.literal("UNSIGNED_CONSTRUCTION_ONLY"), sourceDirectory: z.literal(packageDirectory!),
    applicationProducer: z.strictObject({ commit: z.literal(supervisorInput ? supervisorInput.source.commit : appImageAdmission ? "340dee3fb60cbf5abf6819553d9b575848919305" : "b892d861921fd51c6a1de2e35c987a0bd620ac9b"), modified: z.literal(false) }),
    image: appImageAdmission ? z.object({ bytes: z.number().int().positive().max(512 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
      : z.object({ bytes: z.literal(119441912), sha256: z.literal("5307c99c5d8f603fbf8ed937d8688dc24181509163cdfc365552dd9bd5eb5069") }),
    launcher: z.object({ sha256: z.literal("ea17d105cc470ba5bc23d9e503b2e344b7b78ac2772655a8700d582d84a57fe1") }),
    passiveExtractionMatches: z.literal(true), runtimeAcceptance: z.literal(false), updateAuthority: z.literal(false),
    sourceInventory: z.record(z.string(), z.object({ type: z.enum(["file", "directory"]), mode: z.number(), bytes: z.number(), sha256: z.string() })) })
    .parse(JSON.parse(await readFile(join(appImageBundle, "receipt.json"), "utf8")));
  assert.deepEqual(receipt.applicationProducer, JSON.parse(await readFile(join(app, "dist/resources/development-build.json"), "utf8")));
  appImageFilename = `OpenWhisper-Linux-x86_64_0.3.0~dev.${receipt.applicationProducer.commit.slice(0, 12)}.AppImage`;
  assert.ok(packageBefore);
  assert.deepEqual(Object.fromEntries(Object.entries(receipt.sourceInventory).filter(([, entry]) => entry.type === "file")
    .map(([name, entry]) => [name, { bytes: entry.bytes, sha256: entry.sha256 }])), packageBefore);
  if (supervisorInput) assert.deepEqual(Object.fromEntries(Object.entries(receipt.sourceInventory).map(([name, entry]) => [name, entry.mode])), packageModes);
  await mkdir(join(payload, "appimage"), { mode: 0o700 });
  for (const [source, target, expected] of [
    [appImageFilename, "OpenWhisper.AppImage", receipt.image],
    ["openwhisper-launch", "openwhisper-launch", receipt.launcher],
  ] as const) {
    const path = join(appImageBundle, source), file = await lstat(path);
    if (supervisorInput) { const frozen = target === "OpenWhisper.AppImage" ? supervisorInput.appImage.image : supervisorInput.appImage.launcher;
      assert.equal(path, frozen.path); assert.deepEqual(await describe(path), { bytes: frozen.bytes, sha256: frozen.sha256 }); } assert.ok(file.isFile() && !file.isSymbolicLink());
    assert.equal(file.mode & 0o7777, 0o755); const bytes = await describe(path); assert.equal(bytes.sha256, expected.sha256);
    await cp(path, join(payload, "appimage", target), { errorOnExist: true, force: false });
    assert.deepEqual(await describe(join(payload, "appimage", target)), bytes);
  }
  appImageInput = { image: await describe(join(payload, "appimage/OpenWhisper.AppImage")),
    launcher: await describe(join(payload, "appimage/openwhisper-launch")), producer: receipt.applicationProducer };
}
assert.equal((await describe(seccomp)).sha256, "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e");
await mkdir(join(payload, "fixtures"), { mode: 0o700 });
if (portalFixture) {
  await mkdir(join(payload, "owned-bus"), { mode: 0o700 });
  for (const name of ["portal-service.cpp", "portal-fixture.hpp"]) await cp(join(root, "tests/owned-bus", name), join(payload, "owned-bus", name));
}
for (const name of ["ggml-tiny.bin", "jfk.f32"]) await cp(join(fixtures, name), join(payload, "fixtures", name), { errorOnExist: true, force: false });
const bundled = await build({ entryPoints: [join(root, "tests/owned-dev-recording/driver.ts")], outfile: join(payload, "driver.mjs"),
  platform: "node", format: "esm", target: "node24", bundle: true, external: ["@playwright/test"], metafile: true, sourcemap: false });
if (resourceDiagnostic) await build({ entryPoints: [join(root, "tests/owned-dev-recording/resource-diagnostic.ts")], outfile: join(payload, "resource-diagnostic.mjs"),
  platform: "node", format: "esm", target: "node24", bundle: true, sourcemap: false });
// Test dependencies stay outside the packaged application's production tree.
for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
  await mkdir(dirname(join(payload, "node_modules", name)), { recursive: true, mode: 0o700 });
  await cp(join(root, "node_modules", name), join(payload, "node_modules", name), { recursive: true });
}
const sources: Record<string, { bytes: number; sha256: string }> = {};
for (const name of Object.keys(bundled.metafile.inputs)) sources[name] = await describe(resolve(root, name));
sources["tests/owned-dev-recording/run.ts"] = await describe(fileURLToPath(import.meta.url));
if (stockKde) {
  const launcher = resolve(root, "../linux/scripts/run-owned-desktop.py");
  await cp(launcher, join(payload, "run-owned-desktop.py"));
  sources["linux/scripts/run-owned-desktop.py"] = await describe(launcher);
}
if (kdePaste || kdeWaylandOverlay) {
  const helper = resolve(root, "../linux/scripts/test-owned-portals.py");
  await cp(helper, join(payload, "test-owned-portals.py"));
  sources["linux/scripts/test-owned-portals.py"] = await describe(helper);
  const focus = join(root, "tests/owned-dev-recording/focus-target.ts");
  await build({ entryPoints: [focus], outfile: join(payload, "focus-target.js"),
    platform: "neutral", format: "iife", target: "es2015", bundle: true, sourcemap: false });
  sources["tests/owned-dev-recording/focus-target.ts"] = await describe(focus);
}
if (portalFixture) for (const name of ["portal-service.cpp", "portal-fixture.hpp"]) sources[`tests/owned-bus/${name}`] = await describe(join(root, "tests/owned-bus", name));
let frozen: Awaited<ReturnType<typeof inventory>>;
const container = `openwhisper-owned-dev-recording-${randomUUID()}`;
const compiler = `${container}-compiler`, compilerImage = "sha256:403f066a165681074f19f1977b2b46617d3dd7b072cb7037400dbe01676ed3cb";
let compilerCreated = false;
const dockerConfig = join(output, "docker-config"); await mkdir(dockerConfig, { mode: 0o700 });
const commands: { args: string[]; elapsedMs: number; code: number; expired: boolean; overflow: boolean; errored: boolean; closureObserved: boolean }[] = [];
const outstanding = new Set<Promise<unknown>>(); let sequence = 0, created = false, result = "FAIL", namespaceRemoved = false;
async function docker(args: string[], milliseconds = 30_000) {
  const started = performance.now();
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
  commands.push({ args, elapsedMs: performance.now() - started, ...observed, closureObserved }); return { ...observed, stdout, closureObserved };
}
async function required(args: string[], milliseconds?: number) {
  const value = await docker(args, milliseconds); assert.equal(value.code, 0); assert.equal(value.closureObserved, true); return value.stdout.trim();
}
try {
  const buildImage = await required(["image", "inspect", compilerImage]); z.array(z.object({ Id: z.literal(compilerImage) })).length(1).parse(JSON.parse(buildImage));
  compilerCreated = true;
  await required(["create", "--name", compiler, "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "1g", "--ulimit", "core=0:0", "--entrypoint",
    copiedNode ? "/bin/true" : "/usr/bin/c++", compilerImage, ...(copiedNode ? [] : [
    "-std=c++17", "-Wall", "-Wextra", "-Werror", "/tmp/sources/portal-service.cpp", "-I/usr/include/glib-2.0",
    "-I/usr/lib/x86_64-linux-gnu/glib-2.0/include", "-o", "/tmp/owned-portal", "-lgio-2.0", "-lgobject-2.0", "-lglib-2.0", "-pthread"])]);
  if (copiedNode) {
    // These modes need no synthetic portal; copy Node from the stopped image.
    await required(["cp", "-a", `${compiler}:/opt/node/bin/node`, join(payload, "node")]);
  } else {
    await required(["cp", "-a", join(payload, "owned-bus"), `${compiler}:/tmp/sources`]);
    await required(["start", "--attach", compiler], 60_000);
    z.array(z.object({ State: z.object({ Running: z.literal(false), ExitCode: z.literal(0) }) })).length(1)
      .parse(JSON.parse(await required(["inspect", compiler])));
    await required(["cp", "-a", `${compiler}:/tmp/owned-portal`, join(payload, "owned-bus/owned-portal")]);
  }
  await required(["rm", compiler]); compilerCreated = false;
  frozen = await inventory(payload);
  await writeFile(join(output, "assembly.json"), JSON.stringify({ image: IMAGE, sources, originalDescriptor: original, descriptor,
    originalDist: distBefore, payload: frozen,
    ...(supervisorInput ? { supervisedInput: { receiptPath: supervisorReceiptPath, receiptSha256: supervisorReceiptSha256, source: supervisorInput.source, scope: "ORDINARY_BOOTSTRAP_ONLY_NO_UPDATE_AUTHORITY" } } : {}),
    ...(updateInput ? { updateCheckInput: { receiptPath: supervisorReceiptPath, receiptSha256: supervisorReceiptSha256, source: updateInput.source,
      scope: "ACTUAL_V2_READ_ONLY_CHECK_NETWORK_NONE_NO_INSTALL_OR_REPLACEMENT" } } : {}),
    ...(packageDirectory ? { packageInput: { directory: packageDirectory, files: packageBefore, capturedDescriptorPreserved: true,
      installedRuntime: installPackage, stableRuntime: stablePackage, applicationBuild } } : {}),
    ...(appImageInput ? { appImageInput: { ...appImageInput, directory: appImageBundle, scope: "UNSIGNED_OWNED_RUNTIME_ONLY" } } : {}),
    ...(debianPackage ? { debianInput: { path: debianPackage, ...debianBefore, version: debianVersion, modes: packageModes,
      rootScope: "DISPOSABLE_CONTAINER_PACKAGE_INSTALLATION_ONLY", actualLoginSession: "NOT_TESTED" } } : {}),
    native: { capture: { path: packageDirectory ? join(packageDirectory, "resources/app/dist/native/capture/openwhisper_capture.node") : capture, ...captureRecord },
      speech: { path: packageDirectory ? join(packageDirectory, "resources/app/dist/native/speech/cpu/openwhisper_speech.node") : speech, ...speechRecord },
      bus: { path: packageDirectory ? join(packageDirectory, "resources/app/dist/native/openwhisper_linux_bus.node") : bus, ...busRecord } },
    portalFixture: portalFixture ? { compilerImage, binary: await describe(join(payload, "owned-bus/owned-portal")) } : null,
    ...(copiedNode ? { nodeRuntime: { sourceImage: compilerImage, ...await describe(join(payload, "node")) } } : {}),
    seccomp: { path: seccomp, ...await describe(seccomp) },
    scope: updateCheck ? "Fresh clean captured canonical Debian actual V2/UI update check under network-none; CI producer relation verified separately, no recording, inference, installer, upgrade or public-release acceptance."
      : supervisedLaunch ? "Fresh frozen2ce4 ordinary supervisor/package/CPU/CLI/autostart/PID/fd3 normal-close checks; no update authority or public release claim." : appImage ? appImageAdmission ? "Fresh captured340 AppImage admission and private UI autostart/generated Exec restarts; no FUSE, actual login session, host installation, update authority or public release claim."
      : "Immutable AppImage through its exact private installed launcher; no FUSE, host installation, autostart/update admission or public release claim." : installedDebian ? "Exact Debian installed in disposable container /opt/openwhisper; normal stable UI autostart and generated Exec target restart with private Xvfb/Pulse; no actual login session, host installation or release claim."
      : stablePackage ? "Normal stable package migration/shared UI/CPU recording against private Xvfb/Pulse with actual XTEST native X11 keys; no host profile, installation or release claim."
      : nativeX11 ? "Normal Dev UI against private Xvfb with actual XTEST native X11 keys; no compositor, portal fixture or synthetic signals."
      : stockKde ? "Normal native Wayland Dev UI with retained Ubuntu22 native inputs against stock Kubuntu KDE portal; no synthetic portal signals."
      : "Normal Dev UI/capture/platform utilities with retained Ubuntu22 native inputs and a synthetic portal frontend assembled before private runtime." }, null, 2), { mode: 0o600 });
  const image = await required(["image", "inspect", IMAGE]); z.array(z.object({ Id: z.literal(IMAGE) })).length(1).parse(JSON.parse(image));
  created = true;
  await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "4g", "--shm-size", "256m",
    "--ulimit", "core=0:0", "--entrypoint", "/bin/sleep", IMAGE, "500"]);
  await required(["cp", "-a", payload, `${container}:/payload`]);
  if (copiedNode) {
    const runtimeEvidence = join(output, "runtime-evidence"); await mkdir(runtimeEvidence, { mode: 0o700 });
    await required(["cp", "-a", runtimeEvidence, `${container}:/evidence`]);
  }
  const inspected = await required(["inspect", container]); await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  z.array(z.object({ Image: z.literal(IMAGE), State: z.object({ Running: z.literal(false) }), Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1),
      Devices: z.array(z.unknown()).length(0), Binds: z.null(), PidMode: z.literal(""), IpcMode: z.literal("private"),
      SecurityOpt: z.array(z.string()).refine((entries) => entries.includes("no-new-privileges")),
      Ulimits: z.array(z.object({ Name: z.literal("core"), Soft: z.literal(0), Hard: z.literal(0) })).length(1) }), Mounts: z.array(z.unknown()).length(0) })).length(1).parse(JSON.parse(inspected));
  const copied = join(output, "stopped-payload"); await required(["cp", "-a", `${container}:/payload`, copied]); assert.deepEqual(await inventory(copied), frozen);
  await required(["start", container]);
  if (debianPackage) {
    assert.ok(packageBefore && debianVersion && debianBefore);
    const user = ["exec", "--user", "1000:1000", container];
    const absent = await docker([...user, "/usr/bin/dpkg-query", "-W", "-f=${db:Status-Abbrev}", "io-github-whisperfree"]);
    assert.equal(absent.code, 1); assert.equal(absent.closureObserved, true); assert.equal(absent.stdout, "");
    for (const path of ["/opt/openwhisper", "/usr/share/applications/io.github.whisperfree.desktop",
      "/usr/share/icons/hicolor/256x256/apps/io.github.whisperfree.png", "/usr/share/doc/io-github-whisperfree"]) {
      await required([...user, "/usr/bin/test", "!", "-e", path]); await required([...user, "/usr/bin/test", "!", "-L", path]);
    }
    const extracted = "/tmp/openwhisper-owned-debian-input";
    await required([...user, "/usr/bin/mkdir", "-m", "700", extracted]);
    await required([...user, "/usr/bin/dpkg-deb", "--raw-extract", "/payload/package.deb", extracted], 60_000);
    const archiveRoot = join(output, "debian-input"); await required(["cp", "-a", `${container}:${extracted}`, archiveRoot], 60_000);
    assert.deepEqual((await readdir(join(archiveRoot, "DEBIAN"))).sort(), ["control"]);
    const metadata = await required([...user, "/usr/bin/dpkg-deb", "--field", "/payload/package.deb", "Package", "Version", "Architecture"]);
    assert.equal(metadata, `Package: io-github-whisperfree\nVersion: ${debianVersion}\nArchitecture: amd64`);
    const dependencies = await required([...user, "/usr/bin/dpkg-deb", "--field", "/payload/package.deb", "Depends"]);
    const match = /^libc6 \(>= (\d+\.\d+)\), (libstdc\+\+6, libgcc-s1, libgtk-3-0, libnss3, libnspr4, libasound2, libgbm1, libdrm2, libx11-6, libx11-xcb1, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libxkbcommon0, libdbus-1-3, libatomic1, libpulse0, libsystemd0)$/u.exec(dependencies);
    assert.ok(match);
    const control = await readFile(join(archiveRoot, "DEBIAN/control"), "utf8");
    const installedSize = /^Installed-Size: ([1-9][0-9]{0,9})$/mu.exec(control)?.[1]; assert.ok(installedSize);
    assert.equal(control, ["Package: io-github-whisperfree", `Version: ${debianVersion}`, "Architecture: amd64", "Section: utils", "Priority: optional",
      "Maintainer: OpenWhisper Contributors <noreply@openwhisper.invalid>", `Installed-Size: ${installedSize}`, `Depends: ${dependencies}`,
      "Description: OpenWhisper stable-profile validation package", " Unsigned validation package; no public release or stable update channel.", ""].join("\n"));
    const archiveModes: Record<string, number> = {};
    assert.deepEqual(await inventory(join(archiveRoot, "opt/openwhisper"), "", archiveModes), packageBefore);
    assert.deepEqual(archiveModes, packageModes);
    const expected = Object.fromEntries(Object.entries(packageBefore).map(([path, artifact]) => [`opt/openwhisper/${path}`, artifact]));
    const desktop = "[Desktop Entry]\nType=Application\nName=OpenWhisper\nComment=Local dictation validation package\nExec=/opt/openwhisper/openwhisper\nIcon=io.github.whisperfree\nTerminal=false\nCategories=AudioVideo;Audio;\nStartupWMClass=io.github.whisperfree\n";
    const desktopPath = "usr/share/applications/io.github.whisperfree.desktop";
    const expectedDesktop = supervisedLaunch ? desktop.replace("Exec=/opt/openwhisper/openwhisper\n", "Exec=/opt/openwhisper/openwhisper-launch\n") : desktop;
    assert.equal(await readFile(join(archiveRoot, desktopPath), "utf8"), expectedDesktop);
    expected[desktopPath] = { bytes: Buffer.byteLength(expectedDesktop), sha256: createHash("sha256").update(expectedDesktop).digest("hex") };
    if (supervisedLaunch) {
      const legacy = '#!/bin/sh\nexec /opt/openwhisper/openwhisper-launch "$@"\n';
      assert.equal(await readFile(join(archiveRoot, "usr/bin/openwhisper-desktop"), "utf8"), legacy);
      assert.equal((await lstat(join(archiveRoot, "usr/bin/openwhisper-desktop"))).mode & 0o7777, 0o755);
      expected["usr/bin/openwhisper-desktop"] = { bytes: Buffer.byteLength(legacy), sha256: createHash("sha256").update(legacy).digest("hex") };
    }
    expected["usr/share/icons/hicolor/256x256/apps/io.github.whisperfree.png"] = await describe(join(app, "dist/ui/app-icon.png"));
    expected["usr/share/doc/io-github-whisperfree/copyright"] = packageBefore["notices/OpenWhisper-LICENSE"]!;
    expected["DEBIAN/control"] = await describe(join(archiveRoot, "DEBIAN/control"));
    const allModes: Record<string, number> = {};
    assert.deepEqual(await inventory(archiveRoot, "", allModes), expected);
    for (const mode of Object.values(allModes)) assert.equal(mode & 0o7022, 0, "Archive must contain no special or writable shared entries.");
    // UID0 has no DAC override in this container. Expose only the public archive,
    // while the original UID1000 payload and later profile remain private.
    const installationStage = "/tmp/openwhisper-owned-debian-install", installationArchive = `${installationStage}/package.deb`;
    await required([...user, "/usr/bin/mkdir", "-m", "755", installationStage]);
    await required([...user, "/usr/bin/cp", "/payload/package.deb", installationArchive]);
    await required([...user, "/usr/bin/chmod", "0444", installationArchive]);
    assert.equal(await required([...user, "/usr/bin/ls", "-A", installationStage]), "package.deb");
    assert.equal(await required([...user, "/usr/bin/stat", "-c", "%u:%a", "/payload", installationStage, installationArchive]),
      "1000:700\n1000:755\n1000:444");
    assert.equal(await required([...user, "/usr/bin/sha256sum", installationArchive]), `${debianBefore.sha256}  ${installationArchive}`);
    // Unforced dpkg resolves versioned dependencies and legitimate Provides aliases.
    await required(["exec", "--user", "0:0", container, "/usr/bin/dpkg", "--install", installationArchive], 60_000);
    assert.equal(await required([...user, "/usr/bin/dpkg-query", "-W", "-f=${db:Status-Abbrev} ${Package} ${Version} ${Architecture}", "io-github-whisperfree"]),
      `ii  io-github-whisperfree ${debianVersion} amd64`);
    await writeFile(join(output, "debian-installation.json"), JSON.stringify({ package: debianBefore, version: debianVersion,
      archiveMatchesDirectory: true, controlScriptsAbsent: true, dependenciesPresent: true,
      applicationUid: 1000, packageManagerUid: 0, packageManagerArchive: installationArchive, payloadModePreserved: true,
      permanentExecutable: "/opt/openwhisper/openwhisper", actualLoginSession: "NOT_TESTED" }), { mode: 0o600 });
  }
  await required(["exec", "--user", "1000:1000", container, "/usr/bin/chmod", "-R", "a-w",
    ...(packaged ? ["/payload/driver.mjs", ...(resourceDiagnostic ? ["/payload/resource-diagnostic.mjs"] : []), "/payload/node", "/payload/fixtures", "/payload/node_modules"] : ["/payload"])]);
  if (debianPackage) await required(["exec", "--user", "1000:1000", container, "/usr/bin/chmod", "a-w", "/payload/package.deb"]);
  // Bound software rendering threads in the owned desktop, not application
  // inference. Keep the same process cap and genuine compositor/portal path.
  const command = stockKde ? ["OPENWHISPER_STOCK_KDE=1", ...(kdeLifecycle ? ["OPENWHISPER_KDE_LIFECYCLE=1"] : []),
    ...(kdeOverlay ? ["OPENWHISPER_KDE_OVERLAY=1"] : []),
    ...(kdeWaylandOverlay ? ["OPENWHISPER_KDE_WAYLAND_OVERLAY=1"] : []),
    ...(kdePaste ? [`OPENWHISPER_KDE_PASTE=${kdeXwaylandPaste ? "xwayland" : "wayland"}`] : []), "KWIN_COMPOSE=Q", "LP_NUM_THREADS=2", "/usr/bin/python3", "/payload/run-owned-desktop.py", "--session", "kde-wayland",
    ...(kdeXwaylandPaste || kdeOverlay ? ["--kde-xwayland"] : []),
    "--output", "/tmp/owned-desktop", "--timeout", "180", "--", "/payload/node", "/payload/driver.mjs"]
    : nativeX11 ? ["OPENWHISPER_NATIVE_X11=1", ...(packaged ? ["OPENWHISPER_PACKAGE_DIRECTORY=/payload/package"] : []),
      ...(installPackage ? ["OPENWHISPER_INSTALL_PACKAGE=1"] : []), ...(stablePackage ? ["OPENWHISPER_STABLE_PACKAGE=1"] : []),
      ...(installedDebian ? ["OPENWHISPER_INSTALLED_DEBIAN=1"] : []), ...(supervisedLaunch ? ["OPENWHISPER_SUPERVISED_LAUNCH=1"] : []), ...(resourceDiagnostic ? ["OPENWHISPER_RESOURCE_DIAGNOSTIC=1"] : []), ...(appImage ? ["OPENWHISPER_APPIMAGE=1"] : []),
      ...(updateCheck ? ["OPENWHISPER_UPDATE_CHECK=1"] : []),
      ...(appImageAdmission ? ["OPENWHISPER_APPIMAGE_ADMISSION=1", `OPENWHISPER_APPIMAGE_SHA256=${appImageInput!.image.sha256}`] : []),
      ...(appImageStartupOnly ? ["OPENWHISPER_APPIMAGE_STARTUP_ONLY=1"] : []), "/payload/node", "/payload/driver.mjs"]
    : ["/opt/node/bin/node", "/payload/driver.mjs"];
  const observed = await docker(["exec", "--user", "1000:1000", container, "/usr/bin/env", "-i", "PATH=/opt/node/bin:/usr/bin:/bin", "LANG=C.UTF-8",
    "OPENWHISPER_OWNED_DEV_RECORDING=1", ...command], updateCheck ? 60_000 : stockKde ? 240_000 : 210_000);
  if (stockKde) await required(["cp", `${container}:/tmp/owned-desktop`, join(output, "owned-desktop")]);
  await required(["cp", `${container}:/evidence/.`, output]); assert.equal(observed.code, 0); assert.equal(observed.closureObserved, true);
  (updateCheck ? z.object({ status: z.literal("PASS"), classification: z.literal("DEBIAN_V2_UI_CHECK_ONLY"),
    actualV2Configured: z.literal(true), checkingObserved: z.literal(true), terminalCheckFailure: z.literal(true),
    inheritedHintsConsumed: z.literal(true), originalNormalQuit: z.literal(true), supervisorOriginalsClosed: z.literal(true),
    recordingOrInferenceStarted: z.literal(false), installerInvoked: z.literal(false), upgradeAcceptance: z.literal("NOT_TESTED") })
    : appImageStartupOnly ? z.object({ status: z.literal("PASS"), classification: z.literal("APPIMAGE_STARTUP_DIAGNOSTIC_ONLY"),
    actualOwnerVerified: z.literal(true), initialUiVerified: z.literal(true), originalNormalQuit: z.literal(true),
    allObservedPidsAbsent: z.literal(true), temporaryEmpty: z.literal(true), recordingOrInferenceStarted: z.literal(false),
    autostartAdmission: z.literal("UNAVAILABLE"), updateAuthority: z.literal(false) }) : kdeLifecycle ? z.object({ status: z.literal("PASS"), activeBindingQuit: z.literal(true), crashRecovery: z.literal(true),
    originalApplicationCloses: z.array(z.object({ closed: z.literal(true) })).length(3) })
    : kdeOverlay || kdeWaylandOverlay ? z.object({ status: z.literal("PASS"), defaultHidden: z.literal(true), idlePreferenceVisibility: z.literal(true),
      focusRetained: z.literal(true), preferenceMutationRefused: z.literal(true), overlaySandbox: z.literal(true),
      privateCaptureCancelled: z.literal(true), originalApplicationClosed: z.literal(true), nativeInMain: z.literal(false),
      applicationBackend: z.literal(kdeWaylandOverlay ? "WAYLAND" : "XWAYLAND"),
      ...(kdeWaylandOverlay ? { nativeSurfaceScreenshot: z.literal(true), nativePointerStop: z.literal(true), clipboardConfirmed: z.literal(true),
        foregroundKeyboardDelivery: z.literal(true), editorBackend: z.literal("WAYLAND") } : {}) })
    : nativeX11 ? z.object({ status: z.literal("PASS"), nativeX11: z.literal(true), nativeCapture: z.literal(true), escapePreserved: z.literal(true),
      holdStaleReleaseSafe: z.literal(true), clearedKeyInactive: z.literal(true), clipboardConfirmed: z.literal(true), historyConfirmed: z.literal(true),
      ...(installPackage ? { installedRuntime: z.literal(true), installation: z.object({ embeddedNode: z.literal(true), profileInitiallyAbsent: z.literal(true),
        descriptorPreserved: z.literal(true), existingDestinationRefused: z.literal(true), originalApplicationAlive: z.literal(true), stableSentinelUnchanged: z.literal(true) }) } : {}),
      ...(supervisedLaunch ? { supervisedLaunch: z.literal(true), supervisorOwnersVerified: z.literal(true), supervisorOriginalsClosed: z.literal(true) } : {}),
      ...(stablePackage ? { stableRuntime: z.literal(true), stableMigration: z.object({ legacyRetry: z.literal(true), cpuFallback: z.literal(true),
        editedStateRetained: z.literal(true), discardNotReplayed: z.literal(true), originalsPreserved: z.literal(true), devSentinelUnchanged: z.literal(true), devControlAbsent: z.literal(true) }) } : {}),
      ...(appImage ? { appImageRuntime: z.literal(true), secondaryResourcesSurvived: z.literal(true), appImageAdmission: z.literal(appImageAdmission ? "AVAILABLE" : "UNAVAILABLE"),
        appImageOriginalsClosed: z.literal(true), appImageTemporaryEmpty: z.literal(true) } : {}),
      ...(appImageAdmission ? { installedGeneratedExecRestart: z.literal(true), startupAutostartReadOnly: z.literal(true),
        uiEnableDisableVerified: z.literal(true), actualLoginSession: z.literal("NOT_TESTED") } : {}),
      ...(installedDebian ? { debianInstalled: z.literal(true), installedGeneratedExecRestart: z.literal(true), startupAutostartReadOnly: z.literal(true),
        uiEnableDisableVerified: z.literal(true), actualLoginSession: z.literal("NOT_TESTED") } : {}) })
    : kdePaste ? z.object({ status: z.literal("PASS"), clipboardConfirmed: z.literal(true), recoveryRemoved: z.literal(true),
      nativeInMain: z.literal(false), pasteConfirmed: z.literal(true), permissionRevoked: z.literal(true), targetBackend: z.literal(kdeXwaylandPaste ? "XWAYLAND" : "WAYLAND") })
    : z.object({ status: z.literal("PASS"), clipboardConfirmed: z.literal(true), recoveryRemoved: z.literal(true), nativeInMain: z.literal(false) }))
    .parse(JSON.parse(await readFile(join(output, "result.json"), "utf8")));
  z.object({ status: z.literal("PASS"), appClosed: z.literal(true), serverClosesObserved: z.literal(true),
    ...(updateCheck ? { forcedAppTermination: z.literal(false) } : {}) })
    .parse(JSON.parse(await readFile(join(output, "lifecycle.json"), "utf8")));
  assert.deepEqual(await inventory(payload), frozen);
  if (packageDirectory) {
    const returned = join(output, "returned-package"); await required(["cp", "-a", `${container}:/payload/package`, returned]);
    assert.deepEqual(await inventory(returned), packageBefore); assert.deepEqual(await inventory(packageDirectory), packageBefore);
    if (supervisorReceiptBytes) {
      assert.deepEqual(await readFile(supervisorReceiptPath!), supervisorReceiptBytes);
      const modes: Record<string, number> = {}; assert.deepEqual(await inventory(packageDirectory, "", modes), packageBefore); assert.deepEqual(modes, packageModes);
    }
  }
  if (debianPackage) {
    const installed = join(output, "returned-installed-package"), modes: Record<string, number> = {};
    await required(["cp", "-a", `${container}:/opt/openwhisper`, installed], 60_000);
    assert.deepEqual(await inventory(installed, "", modes), packageBefore); assert.deepEqual(modes, packageModes);
    const returned = join(output, "returned-package.deb"); await required(["cp", "-a", `${container}:/payload/package.deb`, returned], 60_000);
    assert.deepEqual(await describe(returned), debianBefore); assert.deepEqual(await describe(debianPackage), debianBefore);
  }
  if (appImageBundle && appImageInput) {
    assert.ok(appImageFilename); assert.deepEqual(await describe(join(appImageBundle, appImageFilename)), appImageInput.image);
    assert.deepEqual(await describe(join(appImageBundle, "openwhisper-launch")), appImageInput.launcher);
    if (supervisorInput) assert.equal((await describe(join(appImageBundle, "receipt.json"))).sha256, supervisorInput.appImage.receiptSha256);
  }
  result = "PASS";
} finally {
  if (compilerCreated) await docker(["rm", "--force", compiler], 20_000);
  if (created) {
    try { await docker(["cp", `${container}:/evidence/.`, output], 10_000); } catch {}
    try { await docker(["rm", "--force", container], 20_000); } catch {}
    try { const absent = await docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`], 10_000);
      namespaceRemoved = absent.code === 0 && absent.closureObserved && absent.stdout.trim() === ""; } catch {}
  }
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ status: namespaceRemoved && outstanding.size === 0 ? result : "FAIL",
    image: IMAGE, container, namespaceRemoved, originalClosesConfirmed: outstanding.size === 0,
    elapsedMs: performance.now() - launcherStarted, commands }, null, 2), { mode: 0o600 });
  assert.equal(namespaceRemoved, true); assert.equal(outstanding.size, 0);
}
assert.equal(result, "PASS");

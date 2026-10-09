import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { build, type Plugin } from "esbuild";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildSpeechEntryGraph } from "../../scripts/build-speech-entry-graph.js";
import { buildManifestSchema, inputSchema, fileInventorySchema, cpuCatalog, IMAGE, SECCOMP_SHA256, NODE_SHA256, CPU_SHA256, CPU_BUILD_MANIFEST_SHA256, MODEL_SHA256, PCM_SHA256, ELECTRON_SHA256, CAPTURE_SHA256 } from "./contracts.js";
import { describe, inventory, boundedJson } from "../owned-supervisor/files.js";

const source = dirname(fileURLToPath(import.meta.url)), root = resolve(source, "../..");
const absoluteDirectorySchema = z.string().min(1).max(4096)
  .refine((path) => isAbsolute(path) && resolve(path) === path && !path.includes("\0"));
const buildInputsSchema = z.strictObject({ artifactsRoot: absoluteDirectorySchema, fixtures: absoluteDirectorySchema });
export type OwnedRecordingPoolBuildInputs = z.infer<typeof buildInputsSchema>;
export const FIXED_PRODUCTION_IMPORTS = Object.freeze(["main/linux-speech-host.js", "services/speech/backend-supervisor.js", "services/models/model-inventory.js",
  "services/settings/profiles.js", "services/speech/speech-resources.js", "services/speech/speech-entry-graph.js", "services/platform-lifecycle/process-retirement.js", "workers/speech/speech-protocol.js", "workers/speech/native-speech.js", "main/recording-effects.js", "services/speech/recording-speech.js", "core/recording/recording.js",
  "services/speech/adaptive-speech.js", "services/recording/capture.js", "workers/recording/native-capture.js", "workers/recording/recording-effects.js",
  "workers/recording/recording-effects-protocol.js", "workers/recording/recovery.js", "workers/speech/speech-gate.js"]);
export function externalProductionImport(path: string, importer: string): string | undefined {
  const resolved = resolve(dirname(importer), path);
  const name = FIXED_PRODUCTION_IMPORTS.find((candidate) => resolved === join(root, "src", candidate));
  return name ? `./dist/${name}` : undefined;
}
async function sourceRecords(names: readonly string[]) {
  const result: Record<string, Awaited<ReturnType<typeof describe>>> = {};
  for (const name of names) result[name] = await describe(join(root, name), 4 * 1024 * 1024); return result;
}
async function sourceNames(directory = join(root, "src")): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink()); const path = join(directory, entry.name);
    if (entry.isDirectory()) names.push(...await sourceNames(path));
    else if (entry.name.endsWith(".ts")) names.push(relative(root, path));
  }
  assert.ok(names.length <= 256); return names;
}
async function localClosure(directory: string) {
  const pending = [...FIXED_PRODUCTION_IMPORTS, "workers/speech-entry.js"], result = new Set<string>();
  while (pending.length) {
    const name = pending.pop(); assert.ok(name); if (result.has(name)) continue; result.add(name); assert.ok(result.size <= 128);
    const text = await readFile(join(directory, name), "utf8");
    for (const match of text.matchAll(/(?:from\s*|import\s*\()["'](\.[^"']+)["']/gu)) {
      const specifier = match[1]; assert.ok(specifier); const absolute = resolve(dirname(join(directory, name)), specifier), local = relative(directory, absolute);
      assert.ok(!local.startsWith("..") && local.endsWith(".js") && !local.includes("?") && !local.includes("#")); pending.push(local);
    }
  }
  return [...result].sort();
}
export async function buildOwnedRecordingPool(directory: string, inputs: OwnedRecordingPoolBuildInputs) {
  const { artifactsRoot, fixtures } = buildInputsSchema.parse(inputs);
  for (const path of [artifactsRoot, fixtures]) {
    const entry = await lstat(path);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    assert.equal(await realpath(path), path);
  }
  assert.ok(isAbsolute(directory) && resolve(directory) === directory && !directory.includes("\0"));
  assert.equal(await realpath(dirname(directory)), dirname(directory));
  await mkdir(directory, { mode: 0o700, recursive: false });
  const owner = await lstat(directory); assert.ok(owner.isDirectory() && !owner.isSymbolicLink() && owner.uid === process.getuid?.() && (owner.mode & 0o7777) === 0o700);
  const temporary = join(directory, "compiled-source"), payload = join(directory, "payload"); await mkdir(payload, { mode: 0o700 });
  const fixtureSources = (await readdir(source)).filter((name) => name.endsWith(".ts")).map((name) => `tests/owned-recording-pool/${name}`);
  const contexts = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "scripts/build-speech-entry-graph.ts",
    "tests/owned-retirement/bootstrap.ts", "tests/owned-retirement/contract.ts", "tests/owned-supervisor/contract.ts",
    "tests/owned-supervisor/files.ts", "tests/owned-supervisor/run.ts", "tests/owned-supervisor/build-probe.ts",
    "tests/owned-supervisor/verify-main.ts", "tests/owned-recording/contracts.ts", "tests/owned-recording-pool.test.ts",
    "tests/owned-recording-pool-contracts.test.ts"];
  const names = [...new Set([...fixtureSources, ...contexts, ...await sourceNames()])].sort(), before = await sourceRecords(names);
  const compiler = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json", "--outDir", temporary], { cwd: root, encoding: "utf8", shell: false, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  await writeFile(join(directory, "compiler.log"), `${compiler.stdout ?? ""}${compiler.stderr ?? ""}`, { mode: 0o600 });
  assert.ok(!compiler.error && compiler.status === 0);
  const production = await localClosure(temporary); assert.deepEqual(await sourceRecords(names), before);
  for (const name of production) { const destination = join(payload, "dist", name); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await cp(join(temporary, name), destination, { errorOnExist: true, force: false }); }
  await mkdir(join(payload, "node_modules"), { mode: 0o700 }); await cp(join(root, "node_modules/zod"), join(payload, "node_modules/zod"), { recursive: true, errorOnExist: true, force: false });
  await cp(join(root, "package.json"), join(payload, "package.json"), { errorOnExist: true, force: false });
  await mkdir(join(payload, "dist/resources"), { recursive: true, mode: 0o700 });
  await cp(join(root, "data/models.json"), join(payload, "dist/resources/models.json"), { errorOnExist: true, force: false });
  await mkdir(join(payload, "licenses"), { mode: 0o700 });
  for (const [original, name, maximum] of [[resolve(root, "../LICENSE"), "LICENSE", 4 * 1024 * 1024],
    [join(root, "node_modules/electron/dist/LICENSE"), "Electron-LICENSE", 4 * 1024 * 1024],
    [join(root, "node_modules/electron/dist/LICENSES.chromium.html"), "LICENSES.chromium.html", 32 * 1024 * 1024]] as const) {
    const expected = await describe(original, maximum);
    await cp(original, join(payload, "licenses", name), { errorOnExist: true, force: false });
    assert.deepEqual(await describe(original, maximum), expected);
    assert.deepEqual(await describe(join(payload, "licenses", name), maximum), expected);
  }
  const nodeLicense = join(root, "native/NODE-HEADERS-LICENSE");
  assert.equal((await describe(nodeLicense, 4 * 1024 * 1024)).sha256, "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace");
  await cp(nodeLicense, join(payload, "licenses/NODE-HEADERS-LICENSE"), { errorOnExist: true, force: false });
  const nativeRoot = join(artifactsRoot, "p6-proposal/gpu-build-1/cpu");
  assert.deepEqual(await describe(join(nativeRoot, "openwhisper_speech.node")), { bytes: 2389936, sha256: CPU_SHA256 });
  assert.equal((await describe(join(nativeRoot, "build-manifest.json"), 256 * 1024)).sha256, CPU_BUILD_MANIFEST_SHA256);
  const nativeManifest = z.object({ bindingSha256: z.literal(CPU_SHA256), backend: z.literal("cpu"), platform: z.literal("linux"), architecture: z.literal("x64"),
    sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)), headers: z.object({ version: z.literal("24.21.0"), napiVersion: z.literal(8) }) }).parse(await boundedJson(join(nativeRoot, "build-manifest.json")));
  assert.deepEqual(Object.keys(nativeManifest.sourceHashes).sort(), ["native/CMakeLists.txt", "native/speech_binding.cpp", "native/speech_bridge.cpp", "scripts/build-native.ts", "scripts/native-dependencies.ts"].sort());
  for (const [name, sha] of Object.entries(nativeManifest.sourceHashes)) assert.equal((await describe(join(root, name), 4 * 1024 * 1024)).sha256, sha);
  await mkdir(join(payload, "native/speech/cpu"), { mode: 0o700, recursive: true });
  await cp(join(nativeRoot, "openwhisper_speech.node"), join(payload, "native/speech/cpu/openwhisper_speech.node"), { errorOnExist: true, force: false });
  await mkdir(join(payload, "fixtures"), { mode: 0o700 });
  for (const [name, bytes, sha256] of [["ggml-tiny.bin", 77691713, MODEL_SHA256], ["jfk.f32", 704000, PCM_SHA256]] as const) {
    assert.deepEqual(await describe(join(fixtures, name), 128 * 1024 * 1024), { bytes, sha256 });
    await cp(join(fixtures, name), join(payload, "fixtures", name), { errorOnExist: true, force: false });
  }
  await cp(join(nativeRoot, "build-manifest.json"), join(payload, "native/speech/cpu/build-manifest.json"), { errorOnExist: true, force: false });
  assert.equal((await describe(join(payload, "native/speech/cpu/build-manifest.json"), 256 * 1024)).sha256, CPU_BUILD_MANIFEST_SHA256);
  await writeFile(join(payload, "dist/resources/native-catalog.json"), JSON.stringify(cpuCatalog, null, 2), { mode: 0o600 });
  const external: Plugin = { name: "fixed-unbundled-production", setup(context) {
    context.onResolve({ filter: /^\.\.?\// }, (args) => { const mapped = externalProductionImport(args.path, args.importer); return mapped ? { path: mapped, external: true } : undefined; });
  } };
  for (const [entry, output] of [["entry.ts", "main.mjs"], ["probe.ts", "probe.mjs"], ["verify-main.ts", "verify-main.mjs"]] as const) {
    const built = await build({ entryPoints: [join(source, entry)], outfile: join(payload, output), bundle: true, platform: "node", format: "esm", target: "node24",
      external: ["electron", "original-fs"], plugins: [external], metafile: true });
    assert.ok(Object.keys(built.metafile.inputs).every((name) => !name.startsWith("src/") && !name.includes("/src/")));
    await writeFile(join(directory, `${output}.metafile.json`), JSON.stringify(built.metafile, null, 2), { mode: 0o600 });
  }
  const captureRoot = join(artifactsRoot, "native-capture");
  const captureArtifact = join(captureRoot, "run-short-stop-final/openwhisper_capture.node");
  assert.equal((await describe(captureArtifact)).sha256, CAPTURE_SHA256);
  const captureManifest = z.strictObject({ status: z.literal("FROZEN"), files: z.record(z.string(), z.string()), parent_head_at_finalization: z.string() })
    .parse(await boundedJson(join(captureRoot, "source-manifest.json")));
  for (const [name, expected] of Object.entries(captureManifest.files)) {
    assert.ok(!name.includes("..") && /^[A-Za-z0-9_./-]+$/u.test(name));
    assert.equal((await describe(join(root, name), 4 * 1024 * 1024)).sha256, expected);
  }
  await mkdir(join(payload, "native/capture"), { recursive: true, mode: 0o700 });
  await cp(captureArtifact, join(payload, "native/capture/openwhisper_capture.node"), { errorOnExist: true, force: false });
  await cp(join(captureRoot, "source-manifest.json"), join(payload, "native/capture/source-manifest.json"), { errorOnExist: true, force: false });
  await cp(join(root, "native/capture/notices"), join(payload, "native/capture/notices"), { recursive: true, errorOnExist: true, force: false });
  await cp(join(root, "native/capture/miniaudio-source.json"), join(payload, "native/capture/miniaudio-source.json"), { errorOnExist: true, force: false });
  // Historical compiled graph remains separately attributed; no native build.
  await cp(join(nativeRoot, "../input"), join(directory, "cpu-compiled-input"), { recursive: true, errorOnExist: true, force: false });
  for (const name of ["CMakeCache.txt", "build.ninja", "elf-dynamic.txt", "elf-versions.txt"]) {
    const record = await describe(join(nativeRoot, name), 4 * 1024 * 1024);
    await cp(join(nativeRoot, name), join(directory, `cpu-${name}`), { errorOnExist: true, force: false });
    assert.deepEqual(await describe(join(directory, `cpu-${name}`), 4 * 1024 * 1024), record);
  }
  const captured = await buildSpeechEntryGraph(payload);
  await writeFile(join(payload, "dist/resources/speech-entry-graph.json"), JSON.stringify(captured.graph, null, 2), { mode: 0o600 });
  assert.deepEqual(await sourceRecords(names), before);
  const manifest = buildManifestSchema.parse({ version: 1, mode: "recording-pool-cpu", captureSha256: CAPTURE_SHA256, cpuBuildManifestSha256: CPU_BUILD_MANIFEST_SHA256, sources: before, payloadFiles: await inventory(payload), graph: captured.graph,
    packages: { electron: "44.7.0", zod: "4.6.5", typescript: "7.0.2", esbuild: "0.28.2" } });
  await writeFile(join(directory, "build-manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  // The exact retained CPU runtime, independent of dependency-directory aliases
  // and current package installation. No fuse modification or native execution.
  const runtimePacket = join(artifactsRoot, "p2-backend-supervisor-step3c-source/build-3");
  const runtime = join(runtimePacket, "owned-runtime/electron"), runtimeFiles = fileInventorySchema.parse(await boundedJson(join(runtimePacket, "runtime-files.json")));
  assert.deepEqual(await inventory(runtime), runtimeFiles);
  assert.equal(runtimeFiles.electron?.sha256, ELECTRON_SHA256);
  await mkdir(join(directory, "owned-runtime"), { mode: 0o700 });
  await cp(runtime, join(directory, "owned-runtime/electron"), { recursive: true, force: false, errorOnExist: true });
  assert.deepEqual(await inventory(join(directory, "owned-runtime/electron")), runtimeFiles); assert.deepEqual(await inventory(runtime), runtimeFiles);
  await writeFile(join(directory, "runtime-files.json"), JSON.stringify(runtimeFiles, null, 2), { mode: 0o600 });
  await writeFile(join(directory, "input.json"), JSON.stringify(inputSchema.parse({ version: 1, mode: "recording-pool-cpu", image: IMAGE,
    seccompSha256: SECCOMP_SHA256, electronSha256: ELECTRON_SHA256, nodeSha256: NODE_SHA256, build: manifest, runtimeFiles }), null, 2), { mode: 0o600 });
  return manifest;
}
export async function verifyBuiltSources(manifest: z.infer<typeof buildManifestSchema>) {
  assert.deepEqual(await sourceRecords(Object.keys(manifest.sources)), manifest.sources);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 8 || process.argv[2] !== "--output" || !process.argv[3]
      || process.argv[4] !== "--artifacts-root" || !process.argv[5]
      || process.argv[6] !== "--fixtures" || !process.argv[7]) throw new Error("INVALID_SOURCE_BUILD");
  void buildOwnedRecordingPool(process.argv[3], { artifactsRoot: process.argv[5], fixtures: process.argv[7] })
    .catch(() => { process.stderr.write("Owned recording source build failed; retain source-only evidence.\n"); process.exitCode = 1; });
}

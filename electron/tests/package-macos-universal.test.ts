import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inspectUniversalMacBinary, macUniversalFailureDiagnostic, macUniversalToolFailure, stageMacUniversalInputs } from "../scripts/package-macos-universal.js";
import { darwinUniversalRecordingDescriptorSchema, developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { SPEECH_ENTRY_FILES } from "../src/services/speech-entry-graph.js";

const app = "Contents/Resources/app", commit = "0123456789abcdef0123456789abcdef01234567";
const native = ["dist/native/capture/openwhisper_macos_capture.node", "dist/native/openwhisper_macos_capture.node",
  "dist/native/openwhisper_macos_retirement.node", "dist/native/speech/cpu/openwhisper_speech.node", "dist/native/openwhisper_speech.node"];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
test("failed native tool diagnostics retain the exact boundary while redacting private paths and identities", () => {
  const path = "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework", absolute = `/private/owned/${path}`, identity = "a".repeat(40);
  const diagnostic = macUniversalToolFailure("/usr/bin/otool", { status: 1, signal: null, stderr: `otool: ${absolute}: malformed load command ${identity} https://private.invalid/token\u001b` }, ["-l", absolute], path);
  assert.equal(diagnostic.nativePath, path); assert.equal(diagnostic.tool, "/usr/bin/otool"); assert.equal(diagnostic.category, "tool-exit"); assert.equal(diagnostic.exit, 1);
  assert.match(diagnostic.stderr, /malformed load command/u); assert.doesNotMatch(diagnostic.stderr, /private|aaaa|token|\u001b/u);
  const overflow = macUniversalToolFailure("/usr/bin/otool", { status: null, signal: "SIGTERM", stderr: "x".repeat(20_000) }, [], path);
  assert.equal(overflow.category, "tool-signal"); assert.equal(overflow.signal, "SIGTERM"); assert.equal(overflow.stderr.length, 4096); assert.equal(overflow.stderrTruncated, true);
  for (const stderr of [null, undefined]) {
    const failedSpawn = macUniversalToolFailure("/usr/bin/otool", { status: null, signal: null, error: new Error("private spawn path /home/user"), stderr }, [], path);
    assert.equal(failedSpawn.category, "tool-spawn"); assert.equal(failedSpawn.tool, "/usr/bin/otool"); assert.equal(failedSpawn.exit, null);
    assert.equal(failedSpawn.stderr, ""); assert.equal(failedSpawn.stderrTruncated, false); assert.doesNotMatch(JSON.stringify(failedSpawn), /private|home\/user/u);
  }
  assert.throws(() => macUniversalToolFailure("/usr/bin/otool", { status: 1, signal: null, stderr: "" }, [], "Contents/../private"));
  assert.throws(() => macUniversalToolFailure("/usr/bin/otool", { status: 1, signal: null, stderr: "" }, [], "/private/home"));
  assert.deepEqual(macUniversalFailureDiagnostic(new Error("private signing secret /home/user")), { version: 1, status: "FAIL", category: "construction", tool: null,
    nativePath: null, exit: null, signal: null, stderr: "", stderrTruncated: false });
});
function thin(architecture: "arm64" | "x64"): Buffer {
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(architecture === "arm64" ? 0x100000c : 0x1000007, 4); return bytes;
}
function fat(): Buffer {
  const result = Buffer.alloc(112); result.writeUInt32BE(0xcafebabe); result.writeUInt32BE(2, 4);
  for (const [i, architecture] of (["arm64", "x64"] as const).entries()) {
    const at = 8 + 20 * i; result.writeUInt32BE(architecture === "arm64" ? 0x100000c : 0x1000007, at);
    result.writeUInt32BE(48 + 32 * i, at + 8); result.writeUInt32BE(32, at + 12); thin(architecture).copy(result, 48 + 32 * i);
  }
  return result;
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owned-mac-universal-"))); await chmod(root, 0o700);
  const paths = { arm64: join(root, "arm64/OpenWhisper.app"), x64: join(root, "x64/OpenWhisper.app") };
  const write = async (path: string, bytes: string | Buffer) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o644 }); };
  for (const architecture of ["arm64", "x64"] as const) {
    const directory = paths[architecture], application = join(directory, app), koffi = `node_modules/@koromix/koffi-darwin-${architecture}`;
    await write(join(application, "package.json"), JSON.stringify({ version: "0.3.0", type: "module", main: "dist/main/index.js", devDependencies: { electron: "44.7.0" } }));
    await write(join(application, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/koffi": { version: "3.3.2" },
      "node_modules/@koromix/koffi-darwin-arm64": { version: "3.3.2" }, "node_modules/@koromix/koffi-darwin-x64": { version: "3.3.2" } } }));
    await write(join(application, "node_modules/koffi/package.json"), JSON.stringify({ name: "koffi", version: "3.3.2", optionalDependencies: {
      "@koromix/koffi-darwin-arm64": "3.3.2", "@koromix/koffi-darwin-x64": "3.3.2" } }));
    const identity = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" };
    await write(join(application, "dist/main/application-build.js"), `export const APPLICATION_BUILD = ${JSON.stringify(identity)};`);
    await write(join(application, "dist/main/index.js"), "inert common main fixture");
    await write(join(application, "dist/resources/VERSION"), "0.3.0\n");
    await write(join(application, "dist/resources/development-build.json"), JSON.stringify({ commit, modified: false }));
    for (const path of SPEECH_ENTRY_FILES.filter((path) => path !== "package.json")) await write(join(application, path), "inert common worker fixture");
    for (const path of ["node_modules/zod/package.json", "node_modules/zod/index.js", "dist/workers/macos-capture-entry.js"]) await write(join(application, path), "inert common fixture");
    const captured = async (path: string) => { const bytes = await readFile(join(application, path)); return { bytes: bytes.length, sha256: sha(bytes) }; };
    for (const path of native) await write(join(application, path), thin(architecture));
    await write(join(application, koffi, "package.json"), JSON.stringify({ name: `@koromix/koffi-darwin-${architecture}`, version: "3.3.2" }));
    await write(join(application, koffi, `darwin_${architecture}/koffi.node`), thin(architecture));
    const recording = developmentRecordingDescriptorSchema.parse({ version: 1, platform: "darwin", architecture,
      capture: await captured(native[0]!), captureEntry: await captured("dist/workers/macos-capture-entry.js"), retirement: await captured(native[2]!),
      speech: { version: 1, platform: "darwin", architecture, napiVersion: 8, speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
        speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde", entries: [{ backend: "cpu", ...await captured(native[3]!) }] },
      speechEntryGraph: { version: 1, zodVersion: "4.6.5", entries: await Promise.all([...SPEECH_ENTRY_FILES, "node_modules/zod/package.json", "node_modules/zod/index.js"].map(async (path) => ({ path, ...await captured(path) }))) } });
    await write(join(application, "dist/main/development-recording-build.js"), `export const DEVELOPMENT_RECORDING_BUILD = ${JSON.stringify(recording)};`);
    const receipt = { version: 1, architecture, sourceVersion: "0.3.0", source: { commit, modified: false }, runtimeVersion: "44.7.0", applicationBuild: identity,
      unsignedRecording: recording, signedRecording: recording,
      runtimeMachFiles: ["Contents/MacOS/Electron", "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"],
      native: await Promise.all([...native, `${koffi}/darwin_${architecture}/koffi.node`].map(async (path) => ({ path, unsigned: await captured(path), signed: await captured(path) }))) };
    await write(join(directory, "Contents/Resources/notices/mac-stable-validation-package.json"), JSON.stringify(receipt));
    await write(join(directory, "Contents/Resources/notices/speech-cpu-unsigned-build.json"), JSON.stringify({ architecture }));
    for (const kind of ["macos-capture-notices", "macos-retirement-notices"]) await write(join(application, `dist/native/${kind}/build-manifest.json`), JSON.stringify({ architecture }));
    await write(join(directory, "Contents/MacOS/OpenWhisper"), thin(architecture));
    await write(join(directory, "Contents/Info.plist"), "inert common plist fixture");
    await write(join(directory, "Contents/_CodeSignature/CodeResources"), `inert original ${architecture} seal`);
    const framework = join(directory, "Contents/Frameworks/Electron Framework.framework/Versions/A");
    await write(join(framework, "Electron Framework"), thin(architecture));
    await write(join(framework, `Resources/v8_context_snapshot.${architecture === "arm64" ? "arm64" : "x86_64"}.bin`), `owned ${architecture} snapshot`);
    await symlink("A", join(dirname(framework), "Current"));
  }
  return { root, paths, write, output: join(root, "output"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("owned thin fixtures normalize exact V2, both Koffi variants and indexed receipts without changing originals", async () => {
  const f = await fixture();
  try {
    const original = await readFile(join(f.paths.arm64, app, "dist/main/development-recording-build.js"));
    const originalReceipt = await readFile(join(f.paths.arm64, "Contents/Resources/notices/mac-stable-validation-package.json"));
    const staged = await stageMacUniversalInputs({ arm64AppPath: f.paths.arm64, x64AppPath: f.paths.x64, output: f.output });
    assert.deepEqual(await readFile(join(f.paths.arm64, app, "dist/main/development-recording-build.js")), original);
    const modules = await Promise.all([staged.staged.arm64, staged.staged.x64].map((path) => readFile(join(path, app, "dist/main/development-recording-build.js"), "utf8")));
    assert.equal(modules[0], modules[1]); assert.match(modules[0]!, /"version":\s*2/u); darwinUniversalRecordingDescriptorSchema.parse(staged.captured);
    for (const path of [staged.staged.arm64, staged.staged.x64]) {
      assert.deepEqual((await readdir(join(path, app, "node_modules/@koromix"))).sort(), ["koffi-darwin-arm64", "koffi-darwin-x64"]);
      assert.deepEqual(await readFile(join(path, "Contents/Resources/notices/architectures/arm64/Contents/Resources/notices/mac-stable-validation-package.json")), originalReceipt);
      await assert.rejects(lstat(join(path, "Contents/_CodeSignature")), { code: "ENOENT" });
      await assert.rejects(lstat(join(path, "Contents/Resources/app.asar")), { code: "ENOENT" });
      assert.equal(sha(await readFile(join(path, "Contents/Resources/notices/universal-build-tool-LICENSE"))), "edab8abb78d9c5b36944c3e00aebf6a90eb32378993f49ac8a3904007029c629");
    }
    assert.equal(staged.merger.force, false); assert.equal(staged.merger.mergeASARs, false);
    assert.equal(staged.merger.x64ArchFiles, `{${app}/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node,${app}/node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node}`);
  } finally { await f.cleanup(); }
});

test("unexplained common bytes, unsafe application links and native mutation refuse construction", async () => {
  for (const mutation of ["common", "link", "internal-link", "native", "shim", "mode"] as const) {
    const f = await fixture();
    try {
      if (mutation === "common") await f.write(join(f.paths.arm64, app, "dist/main/index.js"), "unexpected architecture-specific main");
      if (mutation === "link") await symlink("/etc/passwd", join(f.paths.arm64, app, "unexpected-link"));
      if (mutation === "internal-link") await symlink("notices", join(f.paths.arm64, "Contents/Resources/unexpected-link"));
      if (mutation === "native") await f.write(join(f.paths.arm64, app, native[0]!), thin("x64"));
      if (mutation === "shim") await f.write(join(f.paths.arm64, "Contents/Resources/app.asar"), "unexpected shim");
      if (mutation === "mode") await chmod(join(f.paths.arm64, app, "dist/main/index.js"), 0o666);
      await assert.rejects(stageMacUniversalInputs({ arm64AppPath: f.paths.arm64, x64AppPath: f.paths.x64, output: f.output }));
    } finally { await f.cleanup(); }
  }
});

test("source provenance, swapped architectures, stale receipts and missing locked Koffi refuse construction", async () => {
  for (const mutation of ["modified", "commit", "receipt", "koffi", "swapped"] as const) {
    const f = await fixture();
    try {
      if (mutation === "modified") await f.write(join(f.paths.arm64, app, "dist/resources/development-build.json"), JSON.stringify({ commit, modified: true }));
      if (mutation === "commit") await f.write(join(f.paths.arm64, app, "dist/resources/development-build.json"), JSON.stringify({ commit: "b".repeat(40), modified: false }));
      if (mutation === "receipt") {
        const path = join(f.paths.arm64, "Contents/Resources/notices/mac-stable-validation-package.json"), value = JSON.parse(await readFile(path, "utf8"));
        value.native[0].signed.sha256 = "c".repeat(64); await f.write(path, JSON.stringify(value));
      }
      if (mutation === "koffi") await rm(join(f.paths.arm64, app, "node_modules/@koromix/koffi-darwin-arm64"), { recursive: true });
      await assert.rejects(stageMacUniversalInputs({ arm64AppPath: mutation === "swapped" ? f.paths.x64 : f.paths.arm64, x64AppPath: f.paths.x64, output: f.output }));
    } finally { await f.cleanup(); }
  }
});

test("persistent validation refuses a missing certificate and output overlap before creating output", async () => {
  const f = await fixture(), certificate = process.env.SIGN_IDENTITY; delete process.env.SIGN_IDENTITY;
  try {
    await assert.rejects(stageMacUniversalInputs({ arm64AppPath: f.paths.arm64, x64AppPath: f.paths.x64, output: f.output, signingMode: "persistent-validation" }));
    await assert.rejects(lstat(f.output), { code: "ENOENT" });
    await assert.rejects(stageMacUniversalInputs({ arm64AppPath: f.paths.arm64, x64AppPath: f.paths.x64, output: join(f.paths.arm64, "nested") }));
  } finally { if (certificate === undefined) delete process.env.SIGN_IDENTITY; else process.env.SIGN_IDENTITY = certificate; await f.cleanup(); }
});

test("universal header validation refuses missing, duplicate, overlapping and truncated native slices", () => {
  // Header fixtures prove parser boundaries only, not actual native execution or Mac signing.
  inspectUniversalMacBinary(fat());
  const count = fat(); count.writeUInt32BE(1, 4);
  const duplicate = fat(); duplicate.writeUInt32BE(0x100000c, 28);
  const overlap = fat(); overlap.writeUInt32BE(48, 36);
  const wrong = fat(); wrong.writeUInt32LE(0x100000c, 84);
  for (const bytes of [thin("arm64"), count, duplicate, overlap, wrong, fat().subarray(0, 100)]) assert.throws(() => inspectUniversalMacBinary(bytes));
});

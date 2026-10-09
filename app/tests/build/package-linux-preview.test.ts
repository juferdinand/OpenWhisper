import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageLinuxPreview } from "../../scripts/package-linux-preview.js";
import { developmentRecordingDescriptorSchema } from "../../src/main/development-recording-descriptor.js";
import { SPEECH_ENTRY_FILES } from "../../src/services/speech/speech-entry-graph.js";

const supportedHost = process.platform === "linux" && process.arch === "x64";
const nobleSource = new URL("../../node_modules/@noble/hashes/", import.meta.url);

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "openwhisper-package-preview-")), root = join(base, "source/app");
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text);
  };
  const metadata = JSON.stringify({ name: "openwhisper-electron", version: "0.3.0", private: true, type: "module",
    main: "dist/main/index.js", dependencies: { fixture: "1.0.0", "@noble/hashes": "2.4.0" }, devDependencies: { electron: "44.7.0" } });
  await write("package.json", metadata);
  await write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {
    "node_modules/fixture": { version: "1.0.0" }, "node_modules/@fixture/linux-x64": { version: "1.0.0" },
    "node_modules/@noble/hashes": { version: "2.4.0" },
  } }));
  await mkdir(join(root, "node_modules/@noble"), { recursive: true });
  await cp(nobleSource, join(root, "node_modules/@noble/hashes"), { recursive: true });
  await write("node_modules/fixture/package.json", JSON.stringify({ name: "fixture", version: "1.0.0",
    optionalDependencies: { "@fixture/linux-x64": "1.0.0", "@fixture/darwin-arm64": "1.0.0" } }));
  await write("node_modules/fixture/LICENSE", "Fixture dependency license");
  await write("node_modules/@fixture/linux-x64/package.json", JSON.stringify({ name: "@fixture/linux-x64", version: "1.0.0" }));
  await write("node_modules/@fixture/linux-x64/inert.node", "Inert fixture addon; never executed");
  await write("node_modules/electron/path.txt", "electron");
  await write("node_modules/electron/dist/version", "44.7.0");
  await write("node_modules/electron/dist/electron", "Inert runtime; never executed");
  await chmod(join(root, "node_modules/electron/dist/electron"), 0o755);
  await write("node_modules/electron/dist/LICENSE", "Fixture runtime license");
  await write("node_modules/electron/dist/LICENSES.chromium.html", "Fixture Chromium notices");
  await write("node_modules/electron/dist/resources/default_app.asar", "Fixture default application");
  await write("dist/main/index.js", "Inert application; never executed");
  await write("dist/main/application-build.js", 'export const APPLICATION_BUILD = {"version":1,"kind":"development","appId":"io.github.whisperfree.dev","productName":"OpenWhisper Dev"};\n');
  await write("dist/main/development-recording-build.js", "export const DEVELOPMENT_RECORDING_BUILD = null;\n");
  const build = '{"commit":"0123456789abcdef0123456789abcdef01234567","modified":true}\n';
  await write("dist/resources/development-build.json", build);
  await write("dist/resources/VERSION", "0.3.0\n");
  await write("dist/ui/app-icon.png", "Fixture existing icon");
  await write("dist/ui/fonts/LICENSE.txt", "Fixture font license");
  await write("../LICENSE", "Fixture OpenWhisper license");
  return { base, root, metadata, build, write, output: join(base, "preview") };
}

async function stableRecording(input: Awaited<ReturnType<typeof fixture>>) {
  await input.write("dist/cli/linux-supervisor-bootstrap.js", "inert compiled supervisor fixture; never executed");
  await input.write("dist/main/application-build.js", 'export const APPLICATION_BUILD = {"version":1,"kind":"stable","appId":"io.github.whisperfree","productName":"OpenWhisper"};\n');
  const metadata: unknown = JSON.parse(input.metadata);
  assert.ok(metadata && typeof metadata === "object");
  await input.write("package.json", JSON.stringify({ ...metadata, dependencies: { fixture: "1.0.0", zod: "4.6.5", "@noble/hashes": "2.4.0" } }));
  const lock: unknown = JSON.parse(await readFile(join(input.root, "package-lock.json"), "utf8"));
  assert.ok(lock && typeof lock === "object");
  await input.write("package-lock.json", JSON.stringify({ ...lock, packages: { "node_modules/fixture": { version: "1.0.0" },
    "node_modules/@fixture/linux-x64": { version: "1.0.0" }, "node_modules/zod": { version: "4.6.5" }, "node_modules/@noble/hashes": { version: "2.4.0" } } }));
  await input.write("node_modules/zod/package.json", JSON.stringify({ name: "zod", version: "4.6.5" }));
  await input.write("node_modules/zod/index.js", "inert locked dependency fixture");
  for (const path of SPEECH_ENTRY_FILES.filter((path) => path !== "package.json")) await input.write(path, "inert speech graph fixture");
  // A tiny real ELF makes the packager's normal ABI inspection meaningful; it is never executed or treated as usable weights/addons.
  const elf = await readFile("/usr/bin/true");
  for (const path of ["dist/native/capture/openwhisper_capture.node", "dist/native/speech/cpu/openwhisper_speech.node", "dist/native/openwhisper_linux_bus.node"]) {
    await mkdir(join(input.root, path, ".."), { recursive: true }); await writeFile(join(input.root, path), elf);
  }
  await input.write("dist/workers/capture-entry.js", "inert capture fixture"); await input.write("dist/workers/platform-entry.js", "inert platform fixture");
  const captured = async (path: string) => { const bytes = await readFile(join(input.root, path));
    return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
  const descriptor = developmentRecordingDescriptorSchema.parse({ version: 1, platform: "linux", architecture: "x64",
    capture: await captured("dist/native/capture/openwhisper_capture.node"), captureEntry: await captured("dist/workers/capture-entry.js"),
    platformServices: { entry: await captured("dist/workers/platform-entry.js"), bus: await captured("dist/native/openwhisper_linux_bus.node") },
    speech: { version: 1, platform: "linux", architecture: "x64", napiVersion: 8, speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
      speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde", entries: [{ backend: "cpu", ...await captured("dist/native/speech/cpu/openwhisper_speech.node") }] },
    speechEntryGraph: { version: 1, zodVersion: "4.6.5", entries: await Promise.all([...SPEECH_ENTRY_FILES, "node_modules/zod/package.json", "node_modules/zod/index.js"].map(async (path) => ({ path, ...await captured(path) }))) } });
  await input.write("dist/main/development-recording-build.js", `export const DEVELOPMENT_RECORDING_BUILD = ${JSON.stringify(descriptor)};\n`);
  await input.write("vendor/whisper.cpp/LICENSE", "inert original source license"); await input.write("native/build-cpu/build-manifest.json", "inert original source provenance");
  if (descriptor.platform !== "linux") throw new Error("The fixture must use the Linux descriptor.");
  return descriptor;
}

test("preview stages the runtime, exact app metadata, installed optional dependency and separate Dev Debian layout", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    const result = await packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true });
    assert.equal(result.version, "0.3.0~dev.0123456789ab.modified");
    assert.equal(result.debianPackage, null);
    const app = join(result.directory, "resources/app");
    assert.equal(await readFile(join(app, "package.json"), "utf8"), input.metadata);
    assert.equal(await readFile(join(app, "dist/resources/development-build.json"), "utf8"), input.build);
    assert.equal(await readFile(join(app, "node_modules/@fixture/linux-x64/inert.node"), "utf8"), "Inert fixture addon; never executed");
    assert.equal((await lstat(join(result.directory, "openwhisper-dev"))).mode & 0o777, 0o755);
    assert.equal((await lstat(join(input.root, "node_modules/electron/dist/electron"))).mode & 0o777, 0o755);
    assert.equal(await readFile(join(input.root, "package.json"), "utf8"), input.metadata);
    const desktop = await readFile(join(result.debianRoot, "usr/share/applications/io.github.whisperfree.dev.desktop"), "utf8");
    assert.match(desktop, /^Exec=\/opt\/openwhisper-dev\/openwhisper-dev --dev$/mu);
    assert.match(desktop, /^Name=OpenWhisper Dev$/mu);
    const control = await readFile(join(result.debianRoot, "DEBIAN/control"), "utf8");
    assert.match(control, /^Package: io-github-whisperfree-dev$/mu);
    assert.match(control, /^Version: 0\.3\.0~dev\./mu);
    assert.equal(await readFile(join(result.directory, "LICENSES.chromium.html"), "utf8"), "Fixture Chromium notices");
    const license = await readFile(new URL("LICENSE", nobleSource));
    assert.equal(createHash("sha256").update(license).digest("hex"), "4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec");
    assert.deepEqual(await readFile(join(result.directory, "notices/noble-hashes-LICENSE")), license);
    assert.deepEqual(await readFile(join(app, "node_modules/@noble/hashes/LICENSE")), license);
    assert.deepEqual(await readFile(join(app, "node_modules/@noble/hashes/blake2.js")), await readFile(new URL("blake2.js", nobleSource)));
    await assert.rejects(lstat(join(app, "node_modules/electron")), { code: "ENOENT" });
    await assert.rejects(lstat(join(result.debianRoot, "usr/share/applications/io.github.whisperfree.desktop")), { code: "ENOENT" });
    await assert.rejects(lstat(join(result.debianRoot, "usr/bin/openwhisper-desktop")), { code: "ENOENT" });
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /fresh directory/);
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("preview refuses a missing noble license before creating package output", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    await rm(join(input.root, "node_modules/@noble/hashes/LICENSE"));
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), { code: "ENOENT" });
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("archive dependency closure ships its original licenses and refuses a missing required notice", { skip: !supportedHost }, async () => {
  const input = await fixture();
  const names = ["tar", "@isaacs/fs-minipass", "chownr", "minipass", "minizlib", "yallist"];
  try {
    const metadata = JSON.parse(input.metadata) as { dependencies: Record<string, string> };
    const lock = JSON.parse(await readFile(join(input.root, "package-lock.json"), "utf8")) as { packages: Record<string, { version: string }> };
    metadata.dependencies["tar"] = "7.5.22";
    for (const name of names) {
      const source = new URL(`../../node_modules/${name}/`, import.meta.url);
      const dependency = JSON.parse(await readFile(new URL("package.json", source), "utf8")) as { name: string; version: string };
      assert.equal(dependency.name, name);
      lock.packages[`node_modules/${name}`] = { version: dependency.version };
      await mkdir(join(input.root, "node_modules", name, ".."), { recursive: true });
      await cp(source, join(input.root, "node_modules", name), { recursive: true });
    }
    await input.write("package.json", JSON.stringify(metadata));
    await input.write("package-lock.json", JSON.stringify(lock));
    const result = await packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true });
    const license = await readFile(new URL("../../node_modules/tar/LICENSE.md", import.meta.url));
    assert.deepEqual(await readFile(join(result.directory, "notices/tar-LICENSE.md")), license);
    for (const name of names) {
      const licenseName = ["@isaacs/fs-minipass", "minizlib"].includes(name) ? "LICENSE" : "LICENSE.md";
      assert.deepEqual(await readFile(join(result.directory, "resources/app/node_modules", name, licenseName)),
        await readFile(new URL(`../../node_modules/${name}/${licenseName}`, import.meta.url)));
    }
    await rm(join(input.root, "node_modules/tar/LICENSE.md"));
    await assert.rejects(packageLinuxPreview({ root: input.root, output: join(input.base, "missing-notice"), directoryOnly: true }));
    await assert.rejects(lstat(join(input.base, "missing-notice")), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("preview refuses source overlap, wrong locked dependency, unsafe symlinks and version mismatch before staging", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    await assert.rejects(packageLinuxPreview({ root: input.root, output: join(input.root, "output"), directoryOnly: true }), /fresh directory/);
    await writeFile(join(input.root, "node_modules/fixture/package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /lockfile/);
    await writeFile(join(input.root, "node_modules/fixture/package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await symlink(join(input.root, "package.json"), join(input.root, "dist/unsafe"));
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /without symlinks/);
    await rm(join(input.root, "dist/unsafe"));
    await writeFile(join(input.root, "dist/resources/VERSION"), "0.2.5\n");
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /versions differ/);
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

const hasDpkg = supportedHost && spawnSync("dpkg-deb", ["--version"], { shell: false, stdio: "ignore" }).status === 0;
test("preview builds and inspects an owned inert Debian archive without installation or app execution", { skip: !hasDpkg }, async () => {
  const input = await fixture();
  try {
    const result = await packageLinuxPreview({ root: input.root, output: input.output });
    assert.ok(result.debianPackage);
    const fields = spawnSync("dpkg-deb", ["--field", result.debianPackage, "Package"], { encoding: "utf8", shell: false });
    assert.equal(fields.status, 0); assert.equal(fields.stdout.trim(), "io-github-whisperfree-dev");
    const extracted = join(input.base, "extracted");
    assert.equal(spawnSync("dpkg-deb", ["--extract", result.debianPackage, extracted], { shell: false }).status, 0);
    assert.equal(await readFile(join(extracted, "opt/openwhisper-dev/resources/app/package.json"), "utf8"), input.metadata);
    assert.equal(await readFile(join(extracted, "opt/openwhisper-dev/resources/app/dist/resources/development-build.json"), "utf8"), input.build);
    await assert.rejects(lstat(join(extracted, "opt/openwhisper")), { code: "ENOENT" });
    await assert.rejects(lstat(join(extracted, "usr/bin/openwhisper-desktop")), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("stable validation package preserves inputs and uses persistent Linux identity without claiming a release", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    await stableRecording(input);
    const metadata = await readFile(join(input.root, "package.json")), descriptor = await readFile(join(input.root, "dist/main/development-recording-build.js"));
    const result = await packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true });
    assert.equal(result.version, "0.3.0~dev.0123456789ab.modified");
    assert.equal(result.directory, join(input.output, "OpenWhisper-Linux-x64"));
    assert.equal((await lstat(join(result.directory, "openwhisper"))).mode & 0o777, 0o755);
    const app = join(result.directory, "resources/app");
    assert.deepEqual(await readFile(join(app, "package.json")), metadata);
    assert.deepEqual(await readFile(join(app, "dist/main/development-recording-build.js")), descriptor);
    assert.equal(await readFile(join(app, "dist/resources/development-build.json"), "utf8"), input.build);
    const desktop = await readFile(join(result.debianRoot, "usr/share/applications/io.github.whisperfree.desktop"), "utf8");
    assert.match(desktop, /^Name=OpenWhisper$/mu); assert.match(desktop, /^Exec=\/opt\/openwhisper\/openwhisper-launch$/mu);
    assert.match(desktop, /^Icon=io\.github\.whisperfree$/mu); assert.match(desktop, /^StartupWMClass=io\.github\.whisperfree$/mu);
    assert.match(await readFile(join(result.debianRoot, "DEBIAN/control"), "utf8"), /^Package: io-github-whisperfree$/mu);
    const legacyEntry = join(result.debianRoot, "usr/bin/openwhisper-desktop"), entryInfo = await lstat(legacyEntry);
    assert.ok(entryInfo.isFile()); assert.equal(entryInfo.isSymbolicLink(), false);
    assert.equal(entryInfo.mode & 0o7777, 0o755);
    assert.equal(await readFile(legacyEntry, "utf8"), '#!/bin/sh\nexec /opt/openwhisper/openwhisper-launch "$@"\n');
    const companion = join(result.debianRoot, "opt/openwhisper/openwhisper-launch");
    assert.equal((await lstat(companion)).mode & 0o7777, 0o755);
    assert.match(await readFile(companion, "utf8"), /^exec \/opt\/openwhisper\/openwhisper \/opt\/openwhisper\/resources\/app\/dist\/cli\/linux-supervisor-bootstrap\.js "\$@"$/mu);
    assert.equal(await readFile(join(app, "dist/cli/linux-supervisor-bootstrap.js"), "utf8"), "inert compiled supervisor fixture; never executed");
    const unexpectedExecution = join(input.base, "unexpected-command"), forwarded = ["--control", "status", "", "two words", "*", "a\\b",
      "line\nbreak", `$(touch ${unexpectedExecution})`, `\`touch ${unexpectedExecution}\``];
    // Override only the fixed shell exec boundary: capture actual argument expansion without launching the app.
    const intercepted = spawnSync("/bin/sh", ["-c", 'capture() { printf "%s\\000" "$@"; return 23; }; alias exec=capture; entry=$1; shift; . "$entry"',
      "owned-legacy-entry", legacyEntry, ...forwarded], { encoding: "utf8", shell: false, timeout: 1_000, maxBuffer: 16 * 1024 });
    assert.ifError(intercepted.error); assert.equal(intercepted.signal, null); assert.equal(intercepted.status, 23);
    assert.equal(intercepted.stderr, "");
    assert.deepEqual(intercepted.stdout.split("\0"), ["/opt/openwhisper/openwhisper-launch", ...forwarded, ""]);
    await assert.rejects(lstat(unexpectedExecution), { code: "ENOENT" });
    assert.match(await readFile(join(result.directory, "notices/README.txt"), "utf8"), /Unsigned; no stable update channel/u);
    assert.deepEqual(await readFile(join(input.root, "dist/main/development-recording-build.js")), descriptor);
    await assert.rejects(lstat(join(result.debianRoot, "opt/openwhisper-dev")), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("stable package refuses absent recording, mismatched identity and missing platform capture before output", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    const stable = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" };
    await input.write("dist/main/application-build.js", `export const APPLICATION_BUILD = ${JSON.stringify(stable)};`);
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /captured recording/);
    await input.write("dist/main/application-build.js", `export const APPLICATION_BUILD = ${JSON.stringify({ ...stable, appId: "io.github.whisperfree.dev" })};`);
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }));
    const descriptor = await stableRecording(input); const { platformServices: _platform, ...incomplete } = descriptor;
    await input.write("dist/main/development-recording-build.js", `export const DEVELOPMENT_RECORDING_BUILD = ${JSON.stringify(incomplete)};`);
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /platform services/);
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});


test("canonical Stable validation derives its exact version without rewriting captured app or native inputs", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    await stableRecording(input); await input.write("../VERSION", "0.3.0\n");
    const cleanBuild = JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", modified: false });
    await input.write("dist/resources/development-build.json", cleanBuild);
    const paths = ["package.json", "dist/resources/VERSION", "dist/resources/development-build.json",
      "dist/main/application-build.js", "dist/main/development-recording-build.js", "dist/native/openwhisper_linux_bus.node"];
    const originals = await Promise.all(paths.map((path) => readFile(join(input.root, path))));
    const result = await packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true, mode: "canonical-stable-validation" });
    assert.equal(result.version, "0.3.0"); assert.equal(result.debianPackage, null);
    assert.match(await readFile(join(result.debianRoot, "DEBIAN/control"), "utf8"), /^Version: 0\.3\.0$/mu);
    assert.match(await readFile(join(result.directory, "notices/README.txt"), "utf8"), /Unsigned; no stable update channel/u);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(result.directory, "resources/app", path)))), originals);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(input.root, path)))), originals);
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("canonical mode refuses Dev, dirty or uncaptured producer, version disagreement and changed native inputs before output", { skip: !supportedHost }, async () => {
  const input = await fixture(), options = { root: input.root, output: input.output, directoryOnly: true, mode: "canonical-stable-validation" as const };
  try {
    await input.write("../VERSION", "0.3.0\n");
    await assert.rejects(packageLinuxPreview(options), /captured clean Stable commit/u);
    await stableRecording(input);
    await assert.rejects(packageLinuxPreview(options), /captured clean Stable commit/u);
    await input.write("dist/resources/development-build.json", JSON.stringify({ commit: "source", modified: false }));
    await assert.rejects(packageLinuxPreview(options), /captured clean Stable commit/u);
    await input.write("dist/resources/development-build.json", JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", modified: false }));
    await input.write("../VERSION", "0.2.5\n");
    await assert.rejects(packageLinuxPreview(options), /Repository and captured package versions differ/u);
    await input.write("../VERSION", "0.3.0\n");
    const metadata = await readFile(join(input.root, "package.json"), "utf8");
    const changed: unknown = JSON.parse(metadata); assert.ok(changed && typeof changed === "object");
    await input.write("package.json", JSON.stringify({ ...changed, version: "0.2.5" }));
    await assert.rejects(packageLinuxPreview(options), /Existing build and package versions differ/u);
    await input.write("package.json", JSON.stringify({ ...changed, version: "00.3.0" }));
    await input.write("dist/resources/VERSION", "00.3.0\n"); await input.write("../VERSION", "00.3.0\n");
    await assert.rejects(packageLinuxPreview(options), (error: unknown) => error instanceof Error && error.message === "INVALID_VERSION");
    await input.write("package.json", metadata); await input.write("dist/resources/VERSION", "0.3.0\n"); await input.write("../VERSION", "0.3.0\n");
    const captured = await readFile(join(input.root, "dist/main/development-recording-build.js"), "utf8");
    await input.write("dist/main/development-recording-build.js", "export const DEVELOPMENT_RECORDING_BUILD = null;\n");
    await assert.rejects(packageLinuxPreview(options), /captured recording build/u);
    await input.write("dist/main/development-recording-build.js", captured);
    await input.write("dist/native/openwhisper_linux_bus.node", "changed inert native input");
    await assert.rejects(packageLinuxPreview(options), /differs from its captured descriptor/u);
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("release construction requires its captured commit to be the exact clean Git source before creating output", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    await stableRecording(input); await input.write("../VERSION", "0.3.0\n");
    await input.write("dist/resources/development-build.json", JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", modified: false }));
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true,
      mode: "canonical-stable-release-construction" }), /Git source verification/u);
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("canonical Stable release construction accepts a clean captured source and keeps release identity and notices", { skip: !supportedHost }, async () => {
  const input = await fixture(), source = join(input.base, "source");
  try {
    await stableRecording(input); await input.write("../VERSION", "0.3.0\n");
    await writeFile(join(source, ".gitignore"), "/app/dist/\n/app/node_modules/\n/app/vendor/\n/app/native/\n/app/ui/node_modules/\n");
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: source, encoding: "utf8", shell: false });
      assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["-c", "user.name=OpenWhisper Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "clean Stable fixture"]);
    const commit = git(["rev-parse", "HEAD"]);
    await input.write("dist/resources/development-build.json", JSON.stringify({ commit, modified: false }));
    const packageBefore = await readFile(join(input.root, "package.json"));
    const descriptorBefore = await readFile(join(input.root, "dist/main/development-recording-build.js"));
    const result = await packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true,
      mode: "canonical-stable-release-construction" });
    const control = await readFile(join(result.debianRoot, "DEBIAN/control"), "utf8");
    const notices = await readFile(join(result.directory, "notices/README.txt"), "utf8");
    assert.equal(result.version, "0.3.0"); assert.equal(result.debianPackage, null);
    assert.match(control, /^Package: io-github-whisperfree$/mu);
    assert.match(control, /^Version: 0\.3\.0$/mu);
    assert.match(control, /^Architecture: amd64$/mu);
    assert.match(control, /^Description: OpenWhisper stable Linux package$/mu);
    assert.match(control, /Stable package construction; release signatures and feed publication are separate steps\./u);
    assert.match(notices, /^OpenWhisper Linux stable package construction\./u);
    assert.match(notices, /release signer adds update signatures separately/u);
    assert.doesNotMatch(notices, /validation package|Unsigned; no stable update channel/u);
    assert.equal(await readFile(join(result.debianRoot, "usr/bin/openwhisper-desktop"), "utf8"),
      '#!/bin/sh\nexec /opt/openwhisper/openwhisper-launch "$@"\n');
    assert.deepEqual(await readFile(join(result.directory, "resources/app/package.json")), packageBefore);
    assert.deepEqual(await readFile(join(result.directory, "resources/app/dist/main/development-recording-build.js")), descriptorBefore);
    assert.equal(git(["status", "--porcelain"]), "");
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("canonical Stable produces the fixed unsigned Debian archive with exact source version and unchanged payload", {
  skip: !hasDpkg ? "Requires the actual dpkg-deb tool; no host installation or unsigned signing fallback." : false,
}, async () => {
  const input = await fixture();
  try {
    await stableRecording(input); await input.write("../VERSION", "0.3.0\n");
    await input.write("dist/resources/development-build.json", JSON.stringify({ commit: "0123456789abcdef0123456789abcdef01234567", modified: false }));
    const descriptor = await readFile(join(input.root, "dist/main/development-recording-build.js")), metadata = await readFile(join(input.root, "package.json"));
    const result = await packageLinuxPreview({ root: input.root, output: input.output, mode: "canonical-stable-validation" });
    assert.equal(result.debianPackage, join(input.output, "OpenWhisper-Linux-amd64.deb")); assert.equal(result.version, "0.3.0");
    const fields = spawnSync("dpkg-deb", ["--field", result.debianPackage!, "Package", "Version", "Architecture"], { encoding: "utf8", shell: false });
    assert.equal(fields.status, 0); assert.equal(fields.stdout.trim(), "Package: io-github-whisperfree\nVersion: 0.3.0\nArchitecture: amd64");
    const extracted = join(input.base, "extracted");
    assert.equal(spawnSync("dpkg-deb", ["--extract", result.debianPackage!, extracted], { shell: false }).status, 0);
    const app = join(extracted, "opt/openwhisper/resources/app");
    assert.deepEqual(await readFile(join(app, "package.json")), metadata);
    assert.deepEqual(await readFile(join(app, "dist/main/development-recording-build.js")), descriptor);
    assert.equal((await lstat(join(extracted, "usr/bin/openwhisper-desktop"))).isFile(), true);
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

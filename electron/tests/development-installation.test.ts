import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { developmentDesktopArgument, installDevelopmentPackage } from "../src/services/development-installation.js";
import { SPEECH_ENTRY_FILES } from "../src/services/speech-entry-graph.js";

const supported = process.platform === "linux" && process.arch === "x64" && process.getuid?.() !== 0;
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-install-"))), home = join(base, "home");
  const source = join(home, "source"), app = join(source, "resources/app");
  const write = async (path: string, value: string | Buffer): Promise<void> => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, value);
  };
  const binary = Buffer.alloc(64); binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); binary.writeUInt16LE(62, 18);
  await write(join(source, "openwhisper-dev"), binary); await chmod(join(source, "openwhisper-dev"), 0o755);
  await write(join(source, "version"), "44.7.0\n"); await write(join(source, "LICENSE"), "inert runtime license");
  await write(join(source, "LICENSES.chromium.html"), "inert chromium notices");
  await write(join(source, "notices/README.txt"), "OpenWhisper Dev Linux preview. Inert owned fixture.");
  await write(join(app, "package.json"), JSON.stringify({ name: "openwhisper-electron", version: "0.3.0", main: "dist/main/index.js", type: "module",
    dependencies: { koffi: "3.3.2", zod: "4.6.5" }, devDependencies: { electron: "44.7.0" } }));
  await write(join(app, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
    "node_modules/koffi": { version: "3.3.2" }, "node_modules/zod": { version: "4.6.5" },
    "node_modules/@koromix/koffi-linux-x64": { version: "3.3.2" } } }));
  await write(join(app, "node_modules/koffi/package.json"), JSON.stringify({ name: "koffi", version: "3.3.2", optionalDependencies: { "@koromix/koffi-linux-x64": "3.3.2" } }));
  await write(join(app, "node_modules/@koromix/koffi-linux-x64/package.json"), JSON.stringify({ name: "@koromix/koffi-linux-x64", version: "3.3.2" }));
  await write(join(app, "node_modules/@koromix/koffi-linux-x64/koffi.node"), binary);
  await write(join(app, "node_modules/zod/package.json"), JSON.stringify({ name: "zod", version: "4.6.5" }));
  await write(join(app, "node_modules/zod/index.js"), "inert dependency; never evaluated");
  for (const path of SPEECH_ENTRY_FILES.filter((path) => path !== "package.json")) await write(join(app, path), "inert speech graph; never evaluated");
  await write(join(app, "dist/main/index.js"), "inert application; never evaluated");
  await write(join(app, "dist/workers/capture-entry.js"), "inert capture; never evaluated");
  for (const path of ["dist/native/capture/openwhisper_capture.node", "dist/native/speech/cpu/openwhisper_speech.node"]) await write(join(app, path), binary);
  const digest = async (path: string) => { const bytes = await readFile(join(app, path)); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
  const descriptor = developmentRecordingDescriptorSchema.parse({ version: 1, platform: "linux", architecture: "x64",
    capture: await digest("dist/native/capture/openwhisper_capture.node"), captureEntry: await digest("dist/workers/capture-entry.js"),
    speech: { version: 1, platform: "linux", architecture: "x64", napiVersion: 8, speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
      speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde", entries: [{ backend: "cpu", ...await digest("dist/native/speech/cpu/openwhisper_speech.node") }] },
    speechEntryGraph: { version: 1, zodVersion: "4.6.5", entries: await Promise.all([...SPEECH_ENTRY_FILES, "node_modules/zod/package.json", "node_modules/zod/index.js"].map(async (path) => ({ path, ...await digest(path) }))) } });
  await write(join(app, "dist/main/development-recording-build.js"), `export const DEVELOPMENT_RECORDING_BUILD = ${JSON.stringify(descriptor)};\n`);
  await write(join(app, "dist/resources/development-build.json"), '{"commit":"0123456789abcdef0123456789abcdef01234567","modified":true}');
  await write(join(app, "dist/resources/VERSION"), "0.3.0\n"); await write(join(app, "dist/ui/app-icon.png"), "inert icon");
  const stable = join(home, ".config/io.github.whisperfree/sentinel"); await write(stable, "stable settings unchanged");
  const installationRoot = join(home, 'Dev build % "quoted" $local'), profile = join(home, "private-dev-profile");
  const desktopFile = join(home, "applications/io.github.whisperfree.dev.desktop"); await mkdir(dirname(desktopFile));
  return { base, home, source, app, stable, descriptor, installationRoot, profile, desktopFile,
    options: { source, home, installationRoot, profile, desktopFile } };
}

test("desktop arguments encode field codes and both desktop/Exec escape layers", () => {
  assert.equal(developmentDesktopArgument("/home/a b"), '"/home/a b"');
  assert.equal(developmentDesktopArgument('/home/a% "quote" $cash\\tail'), String.raw`"/home/a%% \\"quote\\" \\$cash\\\\tail"`);
  assert.equal(developmentDesktopArgument("a`b"), '"a' + "\\\\" + '`b"');
});

test("fresh Dev install preserves exact payload/modes and source metadata without creating profiles or stable data", { skip: !supported }, async () => {
  const input = await fixture();
  try {
    const result = await installDevelopmentPackage(input.options);
    assert.equal(result.version, "0.3.0"); assert.deepEqual(result.source, { commit: "0123456789abcdef0123456789abcdef01234567", modified: true });
    assert.match(result.sourceDigest, /^[a-f0-9]{64}$/u);
    assert.equal((await lstat(input.installationRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(result.executable)).mode & 0o777, 0o755);
    assert.deepEqual(await readFile(result.executable), await readFile(join(input.source, "openwhisper-dev")));
    assert.equal(await readFile(join(result.application, "resources/app/dist/main/development-recording-build.js"), "utf8"), await readFile(join(input.app, "dist/main/development-recording-build.js"), "utf8"));
    const desktop = await readFile(input.desktopFile, "utf8");
    assert.ok(desktop.includes(`Exec=${developmentDesktopArgument(result.executable)} --dev-profile ${developmentDesktopArgument(input.profile)}\n`));
    assert.match(desktop, /^Name=OpenWhisper Dev$/mu); assert.equal(result.desktopFile, input.desktopFile);
    await assert.rejects(lstat(input.profile), { code: "ENOENT" }); await assert.rejects(lstat(join(input.installationRoot, "stage")), { code: "ENOENT" });
    assert.equal(await readFile(input.stable, "utf8"), "stable settings unchanged");
    await assert.rejects(installDevelopmentPackage(input.options), /fresh path/);
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("installer refuses existing/symlink/overlap/stable destinations and used or unsafe profiles before reservation", { skip: !supported }, async () => {
  const input = await fixture();
  try {
    await assert.rejects(installDevelopmentPackage({ ...input.options, installationRoot: input.source }), /overlap/);
    const equalsRoot = join(input.home, "invalid=executable");
    await assert.rejects(installDevelopmentPackage({ ...input.options, installationRoot: equalsRoot }), /must not contain '='/);
    await assert.rejects(lstat(equalsRoot), { code: "ENOENT" });
    await assert.rejects(installDevelopmentPackage({ ...input.options, installationRoot: join(input.home, ".config/io.github.whisperfree/install") }), /stable storage/);
    await mkdir(input.installationRoot); await assert.rejects(installDevelopmentPackage(input.options), /fresh path/);
    assert.equal((await lstat(input.installationRoot)).isDirectory(), true); await rm(input.installationRoot, { recursive: true });
    await symlink(input.source, input.installationRoot);
    await assert.rejects(installDevelopmentPackage(input.options), /fresh path/); await rm(input.installationRoot);
    await mkdir(input.profile, { mode: 0o700 }); await assert.rejects(installDevelopmentPackage(input.options), /fresh path/); await rm(input.profile, { recursive: true });
    await assert.rejects(installDevelopmentPackage({ ...input.options, profile: join(input.home, ".config/io.github.whisperfree.dev/profile") }), /overlap/);
    await assert.rejects(installDevelopmentPackage({ ...input.options, desktopFile: join(input.home, "io.github.whisperfree.desktop") }), /io.github.whisperfree.dev.desktop/);
    await assert.rejects(installDevelopmentPackage({ ...input.options, desktopFile: join(input.home, ".config/autostart/io.github.whisperfree.dev.desktop") }), /autostart/);
    await symlink(input.source, join(input.home, "linked-source"));
    await assert.rejects(installDevelopmentPackage({ ...input.options, source: join(input.home, "linked-source") }), /real standalone/);
    await assert.rejects(lstat(input.installationRoot), { code: "ENOENT" }); assert.equal(await readFile(input.stable, "utf8"), "stable settings unchanged");
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("pure Node CLI installs inert binaries without loading them and rejects duplicate options", { skip: !supported }, async () => {
  const input = await fixture();
  try {
    const cli = fileURLToPath(new URL("../src/cli/install-dev.ts", import.meta.url));
    const arguments_ = ["--import", "tsx", cli, "--source", input.source, "--installation-root", input.installationRoot,
      "--profile", input.profile, "--desktop-file", input.desktopFile];
    const invoke = promisify(execFile), options = { env: { ...process.env, HOME: input.home }, timeout: 10_000 };
    await assert.rejects(invoke(process.execPath, [...arguments_, "--source", input.source], options), /Usage/);
    await assert.rejects(lstat(input.installationRoot), { code: "ENOENT" });
    const result: unknown = JSON.parse((await invoke(process.execPath, arguments_, options)).stdout);
    assert.ok(result && typeof result === "object"); assert.equal(Reflect.get(result, "profile"), input.profile);
    assert.equal(Reflect.get(result, "desktopFile"), input.desktopFile); assert.match(String(Reflect.get(result, "sourceDigest")), /^[a-f0-9]{64}$/u);
    await assert.rejects(lstat(input.profile), { code: "ENOENT" }); assert.equal(await readFile(input.stable, "utf8"), "stable settings unchanged");
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("installer rejects stale captured native bytes, foreign architecture and unsafe payload links before copying", { skip: !supported }, async () => {
  const input = await fixture();
  try {
    const native = join(input.app, "dist/native/capture/openwhisper_capture.node"), original = await readFile(native);
    await writeFile(native, Buffer.concat([original, Buffer.from("tampered")])); await assert.rejects(installDevelopmentPackage(input.options), /Captured package input changed/); await writeFile(native, original);
    const executable = join(input.source, "openwhisper-dev"), binary = await readFile(executable); binary.writeUInt16LE(183, 18); await writeFile(executable, binary);
    await assert.rejects(installDevelopmentPackage(input.options), /architecture differs/); binary.writeUInt16LE(62, 18); await writeFile(executable, binary);
    await symlink(input.stable, join(input.source, "escape")); await assert.rejects(installDevelopmentPackage(input.options), /framework links/);
    await assert.rejects(lstat(input.installationRoot), { code: "ENOENT" }); await assert.rejects(lstat(input.profile), { code: "ENOENT" });
    assert.equal(await readFile(input.stable, "utf8"), "stable settings unchanged");
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("concurrent installs preserve the winning launcher and leave no losing installation", { skip: !supported }, async () => {
  const input = await fixture();
  try {
    const otherRoot = join(input.home, "other-fresh-dev"), otherProfile = join(input.home, "other-fresh-profile");
    const results = await Promise.allSettled([installDevelopmentPackage(input.options),
      installDevelopmentPackage({ ...input.options, installationRoot: otherRoot, profile: otherProfile })]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    const failure = results.find((item) => item.status === "rejected"); assert.ok(failure?.status === "rejected");
    assert.ok(failure.reason instanceof Error && (("code" in failure.reason && failure.reason.code === "EEXIST") ||
      failure.reason.message === `A fresh path is required: ${input.desktopFile}`), "Either preflight or exclusive launcher creation must refuse the loser.");
    const winner = results.find((item) => item.status === "fulfilled"); assert.ok(winner?.status === "fulfilled");
    const losingRoot = winner.value.installationRoot === otherRoot ? input.installationRoot : otherRoot;
    await assert.rejects(lstat(losingRoot), { code: "ENOENT" });
    assert.ok((await readFile(input.desktopFile, "utf8")).includes(developmentDesktopArgument(winner.value.executable)));
    await assert.rejects(lstat(input.profile), { code: "ENOENT" }); await assert.rejects(lstat(otherProfile), { code: "ENOENT" });
    assert.equal(await readFile(input.stable, "utf8"), "stable settings unchanged");
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("rollback preserves an unexpected inner file and reports incomplete cleanup", { skip: !supported }, async () => {
  const input = await fixture(), unexpected = join(input.installationRoot, "stage/resources/app/other-owner-note.txt");
  try {
    const injection = (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { await writeFile(unexpected, "unexpected inner file must survive", { flag: "wx" }); return; }
        catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
        await delay(1);
      }
      throw new Error("Owned staging directory was not observed before the finite deadline.");
    })();
    const [installation, injected] = await Promise.allSettled([installDevelopmentPackage(input.options), injection]);
    assert.equal(injected.status, "fulfilled"); assert.ok(installation.status === "rejected");
    assert.ok(installation.reason instanceof AggregateError); assert.match(installation.reason.message, /cleanup was incomplete/);
    assert.equal(await readFile(unexpected, "utf8"), "unexpected inner file must survive");
    await assert.rejects(lstat(join(input.installationRoot, "stage/openwhisper-dev")), { code: "ENOENT" });
    await assert.rejects(lstat(input.profile), { code: "ENOENT" }); await assert.rejects(lstat(input.desktopFile), { code: "ENOENT" });
    assert.equal(await readFile(input.stable, "utf8"), "stable settings unchanged");
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

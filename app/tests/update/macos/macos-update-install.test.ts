import assert from "node:assert/strict";
import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MacosUpdateInstallError, prepareMacosUpdateInstall, type MacosUpdateInstallEffects } from "../../../src/services/update/macos/macos-update-install.js";
import { retainOwnedUpdateDownload } from "../../../src/services/update/common/update-staging.js";

const supported = process.getuid?.() !== undefined && process.getuid() !== 0;
const failure = (code: MacosUpdateInstallError["code"]) => (error: unknown): boolean => error instanceof MacosUpdateInstallError && error.code === code;
const build = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" } as const;
const metadata = (version: string) => ({ CFBundleIdentifier: build.appId, CFBundleExecutable: build.productName,
  CFBundleName: build.productName, CFBundleDisplayName: build.productName, CFBundleVersion: version, CFBundleShortVersionString: version });
async function bundle(path: string, version: string, text: string): Promise<void> {
  await mkdir(join(path, "Contents/Frameworks/Test.framework/Versions/A"), { recursive: true, mode: 0o755 });
  await mkdir(join(path, "Contents/MacOS"), { mode: 0o755 });
  await writeFile(join(path, "Contents/Info.plist"), JSON.stringify(metadata(version)), { mode: 0o644 });
  await writeFile(join(path, "Contents/MacOS/OpenWhisper"), text, { mode: 0o755 });
  await writeFile(join(path, "Contents/Frameworks/Test.framework/Versions/A/library"), text, { mode: 0o644 });
  await symlink("A", join(path, "Contents/Frameworks/Test.framework/Versions/Current"));
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-install-"))), applications = join(root, "Applications"), stage = join(root, "download");
  await mkdir(applications, { mode: 0o755 }); await mkdir(stage, { mode: 0o700 });
  const currentBundle = join(applications, "OpenWhisper.app"), source = join(stage, "unpacked/OpenWhisper.app");
  await bundle(currentBundle, "0.2.4", "inert predecessor"); await bundle(source, "0.2.5", "inert candidate");
  const file = await open(join(stage, "OpenWhisper-macOS.zip"), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  await file.write(Buffer.from("inert archive"), 0, 13, 0); await file.sync();
  const download = await retainOwnedUpdateDownload({ file, stageDirectory: stage, artifactName: "OpenWhisper-macOS.zip" });
  let authenticates = 0, originalCleanup = 0;
  // Synthetic publisher and no-replace seams exercise real owned filesystem transitions only.
  const effects: MacosUpdateInstallEffects = {
    copy: async (from, to) => { await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }); },
    metadata: async (path) => JSON.parse(await readFile(join(path, "Contents/Info.plist"), "utf8")) as unknown,
    authenticate: () => { authenticates++; },
    moveExclusive: (from, to) => {
      assert.throws(() => lstatSync(to), { code: "ENOENT" }); renameSync(from, to);
    },
  };
  const input = { download, extracted: { bundlePath: source, version: "0.2.5", async cleanup() { originalCleanup++; } },
    build, currentBundle, currentVersion: "0.2.4", expectedVersion: "0.2.5" };
  return { root, applications, currentBundle, source, input, effects, get authenticates() { return authenticates; },
    get originalCleanup() { return originalCleanup; }, async cleanup() { await file.close(); await rm(root, { recursive: true, force: true }); } };
}
const executable = (path: string) => join(path, "Contents/MacOS/OpenWhisper");
async function transactionStage(applications: string): Promise<string> {
  const stages = (await readdir(applications)).filter((name) => name.startsWith(".openwhisper-update-"));
  assert.equal(stages.length, 1); return join(applications, stages[0]!);
}

test("Prepared Mac replacement preserves framework links, retains the predecessor and restores only its own pair", { skip: !supported }, async () => {
  const f = await fixture();
  try {
    const old = await lstat(f.currentBundle, { bigint: true });
    const prepared = await prepareMacosUpdateInstall(f.input, f.effects);
    assert.ok(Object.isFrozen(prepared)); assert.equal(f.authenticates, 2); assert.equal(f.originalCleanup, 0);
    assert.equal(await readFile(executable(f.currentBundle), "utf8"), "inert predecessor");
    assert.throws(prepared.assertForRelaunch, failure("INVALID_STATE"));
    const installing = prepared.install(); assert.equal(prepared.install(), installing);
    await assert.rejects(prepared.discard(), failure("INVALID_STATE")); await installing;
    prepared.assertForRelaunch(); await f.input.download.assertUnchanged();
    const stage = await transactionStage(f.applications), backup = join(stage, "previous.app");
    assert.equal((await lstat(backup, { bigint: true })).ino, old.ino);
    assert.equal(await readFile(executable(f.currentBundle), "utf8"), "inert candidate");
    await prepared.rollback(); assert.equal((await lstat(f.currentBundle, { bigint: true })).ino, old.ino);
    assert.equal(await readFile(executable(f.currentBundle), "utf8"), "inert predecessor");
    assert.throws(prepared.assertForRelaunch, failure("INVALID_STATE")); await prepared.discard();
    assert.deepEqual(await readdir(f.applications), ["OpenWhisper.app"]); assert.equal(f.originalCleanup, 0);
  } finally { await f.cleanup(); }
});

test("Mac candidate authority, copied bytes and exact metadata are checked before any replacement", { skip: !supported }, async () => {
  for (const kind of ["signature", "metadata", "copy", "copy-reject"] as const) {
    const f = await fixture(); let moves = 0;
    try {
      await assert.rejects(prepareMacosUpdateInstall(f.input, { ...f.effects,
        authenticate: (path) => { if (kind === "signature") throw new Error("synthetic authority refusal"); f.effects.authenticate(path); },
        metadata: async (path) => kind === "metadata" ? metadata("0.2.3") : f.effects.metadata(path),
        copy: async (from, to) => {
          await f.effects.copy(from, to);
          if (kind === "copy") await writeFile(executable(to), "foreign copied bytes");
          if (kind === "copy-reject") throw new Error("settled synthetic copy failure");
        }, moveExclusive: () => { moves++; },
      }));
      assert.equal(moves, 0); assert.equal(await readFile(executable(f.currentBundle), "utf8"), "inert predecessor");
      await f.input.download.assertUnchanged(); assert.equal(f.originalCleanup, 0);
    } finally { await f.cleanup(); }
  }
});

test("Exclusive Mac publication failures restore the original even after an effect reports a completed move", { skip: !supported }, async () => {
  for (const kind of ["before", "after-old", "after-new", "foreign"] as const) {
    const f = await fixture(); let moves = 0;
    try {
      const prepared = await prepareMacosUpdateInstall(f.input, { ...f.effects, moveExclusive: (from, to) => {
        moves++;
        if (kind === "before" && moves === 1) throw new Error("inert failure");
        if (kind === "foreign" && moves === 2) { requireDirectory(to); throw new Error("foreign destination"); }
        f.effects.moveExclusive(from, to);
        if ((kind === "after-old" && moves === 1) || (kind === "after-new" && moves === 2)) throw new Error("completed original move");
      } });
      await assert.rejects(prepared.install(), failure(kind === "foreign" ? "ROLLBACK_FAILED" : "INSTALL_FAILED"));
      if (kind === "foreign") {
        assert.equal((await lstat(f.currentBundle)).isDirectory(), true);
        const stage = await transactionStage(f.applications);
        assert.equal(await readFile(executable(join(stage, "previous.app")), "utf8"), "inert predecessor");
        await assert.rejects(prepared.discard(), failure("INVALID_STATE"));
      } else {
        assert.equal(await readFile(executable(f.currentBundle), "utf8"), "inert predecessor"); await prepared.discard();
      }
      await f.input.download.assertUnchanged();
    } finally { await f.cleanup(); }
  }
});

function requireDirectory(path: string): void { mkdirSync(path, { mode: 0o755 }); }

test("Final Mac guard and rollback refuse changed installation, predecessor or foreign stage children", { skip: !supported }, async () => {
  for (const kind of ["installed", "predecessor", "unknown-child"] as const) {
    const f = await fixture();
    try {
      const prepared = await prepareMacosUpdateInstall(f.input, f.effects); await prepared.install(); prepared.assertForRelaunch();
      const stage = await transactionStage(f.applications);
      if (kind === "installed") await writeFile(executable(f.currentBundle), "foreign installation");
      if (kind === "predecessor") await writeFile(executable(join(stage, "previous.app")), "foreign predecessor");
      if (kind === "unknown-child") await writeFile(join(stage, "foreign"), "preserve me", { mode: 0o600 });
      assert.throws(prepared.assertForRelaunch, failure("SOURCE_CHANGED"));
      await assert.rejects(prepared.rollback(), failure("ROLLBACK_FAILED"));
      if (kind === "unknown-child") assert.equal(await readFile(join(stage, "foreign"), "utf8"), "preserve me");
      await f.input.download.assertUnchanged();
    } finally { await f.cleanup(); }
  }
});

test("Prepared Mac discard preserves foreign stage children and the current installation", { skip: !supported }, async () => {
  const f = await fixture();
  try {
    const prepared = await prepareMacosUpdateInstall(f.input, f.effects), stage = await transactionStage(f.applications);
    await writeFile(join(stage, "foreign"), "preserve me", { mode: 0o600 });
    await assert.rejects(prepared.discard(), failure("CLEANUP_FAILED"));
    assert.equal(await readFile(join(stage, "foreign"), "utf8"), "preserve me");
    assert.equal(await readFile(executable(f.currentBundle), "utf8"), "inert predecessor");
  } finally { await f.cleanup(); }
});

import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMacosUpdateCoordinator, handoffMacosUpdate, MacosUpdateCoordinatorError,
  type MacosUpdateCoordinatorEffects } from "../src/main/macos-update-coordinator.js";
import { retainOwnedUpdateDownload } from "../src/services/update-staging.js";
import { projectMacosUpdateRelease } from "../src/services/update-policy.js";
import type { PreparedMacosUpdateInstall } from "../src/services/macos-update-install.js";
import { UpdateDownloadError } from "../src/services/update-download.js";

const repository = "juferdinand/OpenWhisper" as const, currentVersion = "0.3.0", nextVersion = "0.3.1";
const identity = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" } as const;
const admission = { repository, bundle: "/owned/Applications/OpenWhisper.app", executable: "/owned/Applications/OpenWhisper.app/Contents/MacOS/OpenWhisper" };
const candidate = projectMacosUpdateRelease({ repository, currentVersion, release: { tag_name: `v${nextVersion}`,
  html_url: `https://github.com/${repository}/releases/tag/v${nextVersion}`, body: "Owned public metadata", draft: false, prerelease: false,
  assets: [{ name: "OpenWhisper-macOS.zip", browser_download_url: `https://github.com/${repository}/releases/download/v${nextVersion}/OpenWhisper-macOS.zip` }] } });
const failure = (code: MacosUpdateCoordinatorError["code"]) => (error: unknown): boolean => error instanceof MacosUpdateCoordinatorError && error.code === code;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
function transaction(events: string[], overrides: Partial<PreparedMacosUpdateInstall> = {}): Readonly<PreparedMacosUpdateInstall> {
  return Object.freeze({ version: nextVersion, async install() { events.push("install"); },
    assertForRelaunch() { events.push("guard"); }, async rollback() { events.push("rollback"); },
    async discard() { events.push("discard"); }, ...overrides });
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-coordinator-"))), stage = join(root, "download");
  await mkdir(stage, { mode: 0o700 });
  const file = await open(join(stage, "OpenWhisper-macOS.zip"), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  await file.write(Buffer.from("inert owned archive"), 0, 19, 0); await file.sync();
  const download = await retainOwnedUpdateDownload({ file, stageDirectory: stage, artifactName: "OpenWhisper-macOS.zip" });
  const source = join(stage, "unpacked"); await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, "owned.txt"), "inert extracted bytes", { mode: 0o600 });
  const events: string[] = [], prepared = transaction(events);
  // Synthetic extraction and publisher/transaction authority; original file ownership and closure are real.
  const effects: Partial<MacosUpdateCoordinatorEffects> = {
    read: async (input) => { assert.equal(input.package, "macos"); events.push("read"); return candidate; },
    download: async (input) => { assert.equal(input.candidate.version, nextVersion); assert.equal(input.repository, repository); events.push("download"); return download; },
    extract: async (input) => { assert.equal(input.download, download); events.push("extract"); return {
      bundlePath: join(source, "OpenWhisper.app"), version: nextVersion,
      async cleanup() { events.push("extracted-close"); await rm(source, { recursive: true }); },
    }; },
    prepare: async (input) => {
      await input.download.assertUnchanged(); assert.equal(input.currentBundle, admission.bundle);
      assert.equal(input.expectedVersion, nextVersion); assert.deepEqual(input.build, identity); events.push("prepare"); return prepared;
    },
  };
  const create = (overrides: Partial<MacosUpdateCoordinatorEffects> = {}) => createMacosUpdateCoordinator({ admission, identity, currentVersion, cacheDirectory: root }, { ...effects, ...overrides });
  return { root, stage, source, file, download, events, prepared, create, async cleanup() { await file.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Mac preparation settles real original archive owners before yielding an independent handoff", async () => {
  const f = await fixture();
  try {
    const updater = f.create(), signal = new AbortController().signal;
    assert.equal((await updater.check(signal))?.version, nextVersion);
    const prepared = await updater.prepareInstall(signal);
    assert.equal(prepared, f.prepared); assert.ok(Object.isFrozen(updater));
    await assert.rejects(f.file.stat(), { code: "EBADF" }); await assert.rejects(stat(f.stage), { code: "ENOENT" });
    assert.deepEqual(f.events, ["read", "download", "extract", "prepare", "extracted-close"]);
    await assert.rejects(updater.prepareInstall(signal), failure("UNAVAILABLE"));
    const retired = deferred<void>();
    const handoff = handoffMacosUpdate(prepared, { retire: () => { f.events.push("retiring"); return retired.promise; }, relaunch: () => { f.events.push("relaunch"); } });
    await Promise.resolve(); assert.equal(f.events.includes("install"), false);
    retired.resolve(); await handoff;
    assert.deepEqual(f.events.slice(-4), ["retiring", "install", "guard", "relaunch"]);
    assert.equal(f.events.includes("discard"), false); assert.equal(f.events.includes("rollback"), false);
  } finally { await f.cleanup(); }
});

test("Mac checks clear stale candidates, exclude overlap and refuse cancellation before preparing", async () => {
  const f = await fixture();
  try {
    const pending = deferred<typeof candidate | undefined>(), controller = new AbortController();
    const updater = f.create({ read: async () => pending.promise });
    const checking = updater.check(controller.signal);
    await assert.rejects(updater.prepareInstall(controller.signal), failure("BUSY"));
    controller.abort(); pending.resolve(candidate); await assert.rejects(checking, failure("CANCELLED"));
    await assert.rejects(updater.prepareInstall(new AbortController().signal), failure("UNAVAILABLE"));
    const current = f.create({ read: async () => undefined });
    assert.equal(await current.check(new AbortController().signal), undefined);
    await assert.rejects(current.prepareInstall(new AbortController().signal), failure("UNAVAILABLE"));
    assert.equal(f.events.includes("download"), false);
  } finally { await f.cleanup(); }
});

test("Cancellation after a copied Mac candidate settles originals and discards only the prepared transaction", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const updater = f.create({ prepare: async () => { controller.abort(); return f.prepared; } });
    await updater.check(controller.signal); await assert.rejects(updater.prepareInstall(controller.signal), failure("CANCELLED"));
    await assert.rejects(f.file.stat(), { code: "EBADF" }); await assert.rejects(stat(f.stage), { code: "ENOENT" });
    assert.deepEqual(f.events.slice(-2), ["extracted-close", "discard"]); assert.equal(f.events.includes("install"), false);
  } finally { await f.cleanup(); }
});

test("Mac preparation failure still closes the original descriptor, preserving uncertain extraction children", async () => {
  const f = await fixture();
  try {
    const updater = f.create({ extract: async () => ({ bundlePath: join(f.source, "OpenWhisper.app"), version: nextVersion,
      async cleanup() { throw new Error("synthetic owned cleanup refusal"); } }) });
    const signal = new AbortController().signal; await updater.check(signal);
    await assert.rejects(updater.prepareInstall(signal), failure("CLEANUP_FAILED"));
    await assert.rejects(f.file.stat(), { code: "EBADF" }); assert.ok((await stat(f.source)).isDirectory());
    assert.equal(f.events.includes("discard"), true); assert.equal(f.events.includes("install"), false);
  } finally { await f.cleanup(); }
});

test("Failed early download ownership blocks new actions and retains the exact retry until original settlement", async () => {
  const f = await fixture();
  try {
    let attempts = 1, reads = 0, downloads = 0;
    const originalCleanup = async (): Promise<void> => { attempts++; if (attempts < 3) throw new Error("synthetic original close remains uncertain"); };
    const updater = f.create({ read: async () => { reads++; return candidate; }, download: async () => {
      downloads++; throw new UpdateDownloadError("CLEANUP_FAILED", originalCleanup);
    } });
    const signal = new AbortController().signal;
    await updater.check(signal); await assert.rejects(updater.prepareInstall(signal), (error: unknown) =>
      error instanceof UpdateDownloadError && error.cleanup === originalCleanup);
    await assert.rejects(updater.check(signal), failure("CLEANUP_FAILED"));
    await assert.rejects(updater.prepareInstall(signal), failure("CLEANUP_FAILED"));
    assert.equal(reads, 1); assert.equal(downloads, 1); assert.equal(attempts, 1);
    const first = updater.finalize(); assert.equal(updater.finalize(), first);
    await assert.rejects(first); assert.equal(attempts, 2);
    await assert.rejects(updater.check(signal), failure("CLEANUP_FAILED"));
    await updater.finalize(); assert.equal(attempts, 3);
    await updater.check(signal); assert.equal(reads, 2); assert.equal(downloads, 1);
    assert.equal(f.events.includes("install"), false);
  } finally { await f.cleanup(); }
});

test("Ordinary Mac Quit tolerates uncertain files only with the original fulfilled-owner fact", async () => {
  for (const [fact, settled] of [[undefined, false], [() => false, false],
    [() => { throw new Error("synthetic unknown fact"); }, false], [() => true, true]] as const) {
    const f = await fixture();
    try {
      let retries = 0;
      const originalCleanup = async (): Promise<void> => { retries++; throw new Error("synthetic retained cleanup refusal"); };
      const updater = f.create({ download: async () => { throw new UpdateDownloadError("CLEANUP_FAILED", originalCleanup, fact); } });
      const signal = new AbortController().signal; await updater.check(signal);
      await assert.rejects(updater.prepareInstall(signal));
      if (settled) await updater.settleForQuit();
      else await assert.rejects(updater.settleForQuit());
      assert.equal(retries, 1);
      await assert.rejects(updater.check(signal), failure("CLEANUP_FAILED"));
      assert.equal(f.events.includes("install"), false);
    } finally { await f.cleanup(); }
  }
});

test("Mac native retirement failure never swaps or queues a relaunch", async () => {
  const events: string[] = [], prepared = transaction(events), error = new Error("synthetic original owner uncertainty");
  await assert.rejects(handoffMacosUpdate(prepared, { retire: async () => { events.push("retire"); throw error; }, relaunch: () => { events.push("relaunch"); } }), (caught) => caught === error);
  assert.deepEqual(events, ["retire", "discard"]);
});

test("Mac guard or synchronous relaunch failure rolls back the same pair before discarding", async () => {
  for (const stage of ["guard", "relaunch"] as const) {
    const events: string[] = [], error = new Error("synthetic pre-exit failure");
    const prepared = transaction(events, { assertForRelaunch() { events.push("guard"); if (stage === "guard") throw error; } });
    await assert.rejects(handoffMacosUpdate(prepared, { retire: async () => { events.push("retire"); },
      relaunch: () => { events.push("relaunch"); throw error; } }), (caught) => caught === error);
    assert.deepEqual(events, stage === "guard" ? ["retire", "install", "guard", "rollback", "discard"]
      : ["retire", "install", "guard", "relaunch", "rollback", "discard"]);
  }
});

test("A refused Mac rollback retains the predecessor and never discards uncertain state", async () => {
  const events: string[] = [], prepared = transaction(events, {
    assertForRelaunch() { throw new Error("synthetic guard refusal"); },
    async rollback() { events.push("rollback"); throw new Error("synthetic foreign destination"); },
  });
  await assert.rejects(handoffMacosUpdate(prepared, { retire: async () => {}, relaunch: () => { events.push("relaunch"); } }), failure("ROLLBACK_FAILED"));
  assert.deepEqual(events, ["install", "rollback"]);
});

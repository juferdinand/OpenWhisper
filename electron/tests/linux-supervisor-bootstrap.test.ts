import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, lstat, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appImageUpdates, bootstrapLinuxSupervisor, debianUpdates, linuxSupervisorLauncher } from "../src/cli/linux-supervisor-bootstrap.js";
import type { LinuxSupervisorEffects } from "../src/cli/linux-supervisor.js";
import type { OwnedUpdateDownload } from "../src/services/update-staging.js";
import { LINUX_UPDATE_FEED_URL, LINUX_UPDATE_REPOSITORY, type LinuxUpdateCandidate } from "../src/services/update-policy.js";

test("valid and invalid control arguments bypass parent admission and preserve the existing early GUI parser", async () => {
  for (const argv of [["--control", "status"], ["--control", "unknown"], ["--control"]]) {
    let preparations = 0, executions = 0;
    const effects: LinuxSupervisorEffects = {
      launch() { throw new Error("Control must not create a GUI child or receipt pipe."); },
      exec(executable, received, environment): never {
        executions++; assert.equal(executable, process.execPath); assert.deepEqual(received, [process.execPath, ...argv]);
        assert.equal(environment["ELECTRON_RUN_AS_NODE"], undefined); throw new Error("Owned inert exec boundary");
      },
    };
    await assert.rejects(bootstrapLinuxSupervisor(argv, async () => { preparations++; throw new Error("No admission or profile reads allowed."); }, effects), { code: "EXEC_FAILED" });
    assert.equal(preparations, 0); assert.equal(executions, 1);
  }
});

test("an uninstalled image keeps ordinary GUI startup without a fabricated permanent target or restart authority", async () => {
  const argv = ["literal value", ""], effects: LinuxSupervisorEffects = {
    launch() { throw new Error("Unadmitted images must not acquire a restart channel."); },
    exec(executable, received, environment): never {
      assert.equal(executable, process.execPath); assert.deepEqual(received, [process.execPath, ...argv]);
      assert.equal(environment["OPENWHISPER_RESTART_NONCE"], undefined); throw new Error("Owned inert exec boundary");
    },
  };
  await assert.rejects(bootstrapLinuxSupervisor(argv, async (received) => {
    assert.deepEqual(received, argv); return { version: "0.3.0", launch: undefined };
  }, effects), { code: "EXEC_FAILED" });
});

test("both fixed shell bootstraps clear Node injection and preserve literal application arguments", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-supervisor-entry-"));
  try {
    const unexpected = join(root, "unexpected-execution"), argv = ["--control", "status", "", "two words", "*", "a\\b", "line\nbreak",
      `$(touch ${unexpected})`, `\`touch ${unexpected}\``];
    for (const kind of ["debian", "appimage"] as const) {
      const bundle = join(root, "image with spaces"), entry = join(bundle, kind === "debian" ? "openwhisper-launch" : "AppRun");
      await mkdir(bundle, { recursive: true }); await writeFile(entry, linuxSupervisorLauncher(kind), { mode: 0o755 });
      // Read the actual shell entry, but intercept its sole exec before any Electron or app launch.
      const child = spawnSync("/bin/sh", ["-c", 'capture() { printf "%s\\000" "$ELECTRON_RUN_AS_NODE" "${NODE_OPTIONS+x}${NODE_PATH+x}${NODE_V8_COVERAGE+x}${ELECTRON_NO_ASAR+x}" "$@"; return 23; }; alias exec=capture; . "$0"', entry, ...argv],
        { env: { ...process.env, NODE_OPTIONS: "inert injection", NODE_PATH: "/inert", NODE_V8_COVERAGE: "/inert", ELECTRON_NO_ASAR: "1", ELECTRON_RUN_AS_NODE: "0" },
          shell: false, encoding: "utf8", timeout: 1_000, maxBuffer: 16 * 1024 });
      assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 23); assert.equal(child.stderr, "");
      const payload = kind === "debian" ? "/opt/openwhisper" : join(bundle, "usr/lib/openwhisper");
      assert.deepEqual(child.stdout.split("\0"), ["1", "", join(payload, "openwhisper"),
        join(payload, "resources/app/dist/cli/linux-supervisor-bootstrap.js"), ...argv, ""]);
    }
    await assert.rejects(lstat(unexpected), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Debian parent captures host discovery authority and refuses installation without a live candidate", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-debian-parent-")));
  let discoveries = 0;
  const dependencies: NonNullable<Parameters<typeof debianUpdates>[1]> = {
    home: () => home,
    async feed(input) { discoveries++; assert.equal(input.package, "deb"); assert.equal(input.currentVersion, "0.3.0"); return undefined; },
    async download() { assert.fail("No candidate may reach a download."); },
    async prepare() { assert.fail("No candidate may reach package preparation."); },
  };
  try {
    const updates = debianUpdates("0.3.0", dependencies), signal = new AbortController().signal;
    dependencies.feed = async () => { assert.fail("Later callbacks must not replace captured parent authority."); };
    assert.equal(discoveries, 0);
    await assert.rejects(updates.action("install", signal), { code: "INVALID_REQUEST" });
    await assert.rejects(updates.installPrepared("0.3.1"), { code: "INVALID_REQUEST" });
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(updates.action("check", cancelled.signal), { code: "INVALID_REQUEST" });
    assert.equal(discoveries, 0);
    assert.deepEqual(await updates.action("check", signal), { status: "idle" });
    assert.equal(discoveries, 1);
    await assert.rejects(updates.action("install", signal), { code: "INVALID_REQUEST" });
    await updates.discardPrepared();
  } finally { await rm(home, { recursive: true, force: true }); }
});

// Inert host authority only: owned files, no signature verification, feed, installer or process execution.
async function appImageFixture() {
  // Darwin's temporary base can contain /var aliases; production admission requires physical ancestry.
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-appimage-parent-"))), events: string[] = [];
  const file = await open(join(home, "inert-download"), "wx", 0o600);
  const selected: LinuxUpdateCandidate = { package: "appimage", authentication: "unauthenticated", version: "0.3.1", notes: "",
    assetName: "OpenWhisper-Linux-x86_64.AppImage", assetURL: `${LINUX_UPDATE_REPOSITORY}/releases/download/v0.3.1/OpenWhisper-Linux-x86_64.AppImage`,
    pageURL: `${LINUX_UPDATE_REPOSITORY}/releases/tag/v0.3.1`, feedURL: LINUX_UPDATE_FEED_URL, target: "linux-x86_64-appimage", signature: "inert successor signature" };
  let changed = false, local = false, closed = false;
  const guard = { assertUnchanged() { events.push("current-guard"); if (changed) throw new Error("Owned current pair changed."); } };
  const download: OwnedUpdateDownload = { file, stageDirectory: home, artifactName: "OpenWhisper-Linux-x86_64.AppImage", bytes: 0,
    async assertUnchanged() { events.push("source-guard"); }, async cleanup() { events.push("source-close"); if (!closed) { await file.close(); closed = true; } } };
  const continuation = { async assertInstalledForExec() { events.push("full-installed-auth"); },
    assertForExec() { assert.equal(closed, true); events.push("final-guard"); }, async rollbackBeforeExec() { events.push("continuation-rollback"); } };
  const prepared = { version: "0.3.1", bytes: 0, async install() { events.push("replace-pair"); }, async assertInstalled() {},
    async rollback() { events.push("prepared-rollback"); }, async commit() { assert.fail("Parent must retain predecessor through exec."); },
    async discard() { events.push("discard"); }, async prepareExecContinuation() { events.push("settled-continuation"); return continuation; } };
  const dependencies: NonNullable<Parameters<typeof appImageUpdates>[2]> = {
    home: () => home,
    async admit() { events.push("local-current-auth"); if (!local) throw new Error("Owned stale sidecar."); return guard; },
    async signature(input) { events.push("current-signature-fetch"); assert.equal(input.currentVersion, "0.3.0"); return "inert current signature"; },
    async repair(input) { events.push("repair-current"); assert.equal(input.version, "0.3.0"); assert.equal(input.signature, "inert current signature"); return guard; },
    async feed(input) { events.push("feed"); assert.equal(input.package, "appimage"); return selected; },
    async download(input) { events.push("download"); assert.equal(input.candidate, selected); return download; },
    async prepare(input) { events.push("prepare"); assert.equal(input.download, download); assert.equal(input.signature, selected.signature); return prepared; },
  };
  const launch = { kind: "appimage" as const, executable: join(home, ".local/lib/whisperfree/openwhisper-launch"),
    arguments: [join(home, ".local/lib/whisperfree/OpenWhisper.AppImage")] as const, assertUnchanged() {} };
  return { home, events, dependencies, launch, local: () => { local = true; }, change: () => { changed = true; },
    async cleanup() { if (!closed) await file.close(); await rm(home, { recursive: true, force: true }); } };
}

test("AppImage channel grants no install or network authority at startup or after failed current-signature acquisition", async () => {
  const input = await appImageFixture(), signal = new AbortController().signal;
  input.dependencies.signature = async () => { input.events.push("unavailable-current-signature"); throw new Error("Owned network unavailable."); };
  try {
    const updates = appImageUpdates("0.3.0", input.launch, input.dependencies);
    assert.deepEqual(input.events, []);
    await assert.rejects(updates.action("install", signal), { code: "INVALID_REQUEST" });
    await assert.rejects(updates.installPrepared("0.3.1"), { code: "INVALID_REQUEST" });
    await assert.rejects(updates.action("check", signal), /network unavailable/);
    await assert.rejects(updates.action("install", signal), { code: "INVALID_REQUEST" });
    assert.deepEqual(input.events, ["local-current-auth", "unavailable-current-signature"]);
  } finally { await input.cleanup(); }
});

test("explicit AppImage repair authenticates current before discovery and closes the source before the final guard", async () => {
  const input = await appImageFixture(), signal = new AbortController().signal;
  try {
    const updates = appImageUpdates("0.3.0", input.launch, input.dependencies);
    input.dependencies.signature = async () => { assert.fail("Later effects must not replace captured parent authority."); };
    assert.deepEqual(await updates.action("check", signal), { status: "available", updateVersion: "0.3.1" });
    assert.ok(input.events.indexOf("repair-current") < input.events.indexOf("feed"));
    assert.deepEqual(await updates.action("install", signal), { status: "prepared", updateVersion: "0.3.1" });
    const installed = await updates.installPrepared("0.3.1"); installed.assertForExec();
    assert.deepEqual(input.events.slice(-6), ["replace-pair", "settled-continuation", "full-installed-auth", "source-guard", "source-close", "final-guard"]);
    await installed.rollbackBeforeExec?.();
    assert.equal(input.events.at(-1), "continuation-rollback");
    await updates.discardPrepared(); assert.equal(input.events.includes("discard"), false);
  } finally { await input.cleanup(); }
});

test("changed current AppImage refuses replacement and abandons only the uninstalled prepared transaction", async () => {
  const input = await appImageFixture(), signal = new AbortController().signal; input.local();
  try {
    const updates = appImageUpdates("0.3.0", input.launch, input.dependencies);
    await updates.action("check", signal); assert.equal(input.events.includes("current-signature-fetch"), false);
    await updates.action("install", signal); input.change();
    await assert.rejects(updates.installPrepared("0.3.1"), /current pair changed/);
    await updates.discardPrepared();
    assert.equal(input.events.includes("replace-pair"), false);
    assert.deepEqual(input.events.slice(-2), ["discard", "source-close"]);
  } finally { await input.cleanup(); }
});

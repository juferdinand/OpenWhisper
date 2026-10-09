import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { duplexPair, PassThrough } from "node:stream";
import { test } from "node:test";
import { bypassLinuxControl, execLinuxGui, runLinuxSupervisor, type LinuxSupervisorEffects, type LinuxSupervisorUpdates } from "../src/cli/linux-supervisor.js";
import { LINUX_RESTART_NONCE, LINUX_RESTART_VERSION } from "../src/main/linux-restart.js";
import { createLinuxUpdateGuiChannel, LINUX_UPDATE_PROTOCOL } from "../src/main/linux-update-channel.js";
import type { LinuxInstalledLaunch } from "../src/main/linux-installed-launch.js";

const launch: LinuxInstalledLaunch = { kind: "debian", executable: "/opt/openwhisper/openwhisper", arguments: [] };
const turn = (): Promise<void> => new Promise((accept) => setImmediate(accept));
function fixture() {
  const pipe = new PassThrough({ autoDestroy: false }), calls: string[] = [];
  let acceptExit!: (time: number) => void, closeOriginal!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<number>((accept) => { acceptExit = accept; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => { closeOriginal = accept; });
  const acceptClose = (value: { code: number | null; signal: NodeJS.Signals | null }): void => { acceptExit(performance.now()); closeOriginal(value); };
  let environment: NodeJS.ProcessEnv | undefined, argumentsReceived: readonly string[] | undefined;
  let replacement: { executable: string; argv: readonly string[]; environment: NodeJS.ProcessEnv } | undefined;
  const effects: LinuxSupervisorEffects = {
    launch(argv, env) { calls.push("spawn"); environment = env; argumentsReceived = argv; return { pipe, exited, closed }; },
    exec(executable, argv, env): never { calls.push("exec"); replacement = { executable, argv, environment: env }; throw new Error("Owned fixed exec boundary"); },
  };
  const receipt = (version = "0.3.1"): Buffer => {
    assert.ok(environment?.[LINUX_RESTART_NONCE]);
    return Buffer.from(`${JSON.stringify({ version: 1, type: "restart", nonce: environment[LINUX_RESTART_NONCE], installedVersion: version })}\n`);
  };
  const revalidateReplacement = async (version: string): Promise<void> => { calls.push(`revalidate:${version}`); };
  return { pipe, calls, effects, acceptExit, acceptClose, receipt, revalidateReplacement, environment: () => environment, argv: () => argumentsReceived, replacement: () => replacement };
}

test("restart reaches fixed exec only after original close0, complete pipe close and replacement validation", async () => {
  const input = fixture(), original = runLinuxSupervisor({ launch, currentVersion: "0.3.0", argv: [], revalidateReplacement: input.revalidateReplacement }, input.effects);
  void original.catch(() => {});
  input.pipe.end(input.receipt()); await turn(); assert.deepEqual(input.calls, ["spawn"]);
  input.acceptClose({ code: 0, signal: null }); await turn(); assert.deepEqual(input.calls, ["spawn"]);
  input.pipe.destroy(); await assert.rejects(original, { code: "EXEC_FAILED" });
  assert.deepEqual(input.calls, ["spawn", "revalidate:0.3.1", "exec"]);
  assert.deepEqual(input.replacement()?.argv, ["/opt/openwhisper/openwhisper-launch"]);
  assert.equal(input.replacement()?.executable, "/opt/openwhisper/openwhisper-launch");
  assert.equal(input.replacement()?.environment[LINUX_RESTART_NONCE], undefined);
  assert.equal(input.environment()?.[LINUX_RESTART_VERSION], "0.3.0");
});

test("ordinary quit and original crash preserve exit outcome without replacement or restart loops", async () => {
  for (const code of [0, 3]) {
    const input = fixture(), original = runLinuxSupervisor({ launch, currentVersion: "0.3.0", argv: [], revalidateReplacement: input.revalidateReplacement }, input.effects);
    if (code) input.pipe.write(input.receipt());
    input.pipe.end(); input.pipe.destroy(); input.acceptClose({ code, signal: null });
    assert.equal(await original, code); assert.deepEqual(input.calls, ["spawn"]);
  }
});

test("malformed original frame remains refused while supervisor still waits for original child close", async () => {
  const input = fixture(), original = runLinuxSupervisor({ launch, currentVersion: "0.3.0", argv: [], revalidateReplacement: input.revalidateReplacement }, input.effects);
  void original.catch(() => {}); input.pipe.end("not a receipt\n"); await turn(); input.pipe.destroy(); await turn();
  let settled = false; void original.then(() => { settled = true; }, () => { settled = true; }); await turn(); assert.equal(settled, false);
  input.acceptClose({ code: 0, signal: null }); await assert.rejects(original, { code: "CHANNEL_FAILED" }); assert.deepEqual(input.calls, ["spawn"]);
});

test("revalidation failure does not exec, retry, reopen or take installer backup ownership", async () => {
  const input = fixture(), original = runLinuxSupervisor({ launch, currentVersion: "0.3.0", argv: [], revalidateReplacement: async () => { throw new Error("Owned replacement changed"); } }, input.effects);
  void original.catch(() => {}); input.pipe.end(input.receipt()); await turn(); input.pipe.destroy(); input.acceptClose({ code: 0, signal: null });
  await assert.rejects(original, { code: "REVALIDATION_FAILED", message: "REVALIDATION_FAILED" }); assert.deepEqual(input.calls, ["spawn"]);
});

test("AppImage old admission is captured before spawn; replacement uses frozen permanent pair after separate validation", async () => {
  const input = fixture(), image = join(homedir(), ".local/lib/whisperfree/OpenWhisper.AppImage"), launcher = join(homedir(), ".local/lib/whisperfree/openwhisper-launch");
  const argv = ["literal value", ""], appimage: LinuxInstalledLaunch = { kind: "appimage", executable: launcher, arguments: [image], assertUnchanged() { input.calls.push("capture-old"); } };
  const options: { launch: LinuxInstalledLaunch; currentVersion: string; argv: string[]; revalidateReplacement(version: string): Promise<void> } = {
    launch: appimage, currentVersion: "0.3.0", argv, revalidateReplacement: input.revalidateReplacement };
  const original = runLinuxSupervisor(options, input.effects); void original.catch(() => {});
  assert.deepEqual(input.calls, ["capture-old", "spawn"]); argv[0] = "later change"; assert.deepEqual(input.argv(), ["literal value", ""]);
  options.launch = launch; options.currentVersion = "0.2.5"; options.revalidateReplacement = async () => { throw new Error("Later callback must not replace capture"); };
  input.pipe.end(input.receipt()); await turn(); input.pipe.destroy(); input.acceptClose({ code: 0, signal: null });
  await assert.rejects(original, { code: "EXEC_FAILED" }); assert.deepEqual(input.calls, ["capture-old", "spawn", "revalidate:0.3.1", "exec"]);
  assert.deepEqual(input.replacement()?.argv, [launcher, image, "literal value", ""]);
  assert.equal(input.replacement()?.environment.APPDIR, undefined); assert.equal(input.replacement()?.environment.TMPDIR, undefined);
});

test("control bypass preserves literal argv and clears Node injection without child, pipe or admission", () => {
  const input = fixture(), argv = ["--control", "status", "literal value", ""];
  const previousNodeOptions = process.env.NODE_OPTIONS, previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  process.env.NODE_OPTIONS = "owned-injection-never-executed"; process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    assert.throws(() => bypassLinuxControl(argv, input.effects), { code: "EXEC_FAILED" });
    assert.deepEqual(input.calls, ["exec"]); assert.deepEqual(input.replacement()?.argv, [process.execPath, ...argv]);
    assert.equal(input.replacement()?.environment.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(input.replacement()?.environment.NODE_OPTIONS, undefined);
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousNodeOptions;
    if (previousRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
  }
});

test("invalid target, argv or old AppImage guard refuses before spawning an original child", async () => {
  const input = fixture();
  await assert.rejects(runLinuxSupervisor({ launch: { ...launch, executable: "/bin/true" }, currentVersion: "0.3.0", argv: [], revalidateReplacement: input.revalidateReplacement }, input.effects), { code: "INVALID_REQUEST" });
  assert.throws(() => bypassLinuxControl(["\0"], input.effects), { code: "INVALID_REQUEST" });
  const appimage: LinuxInstalledLaunch = { kind: "appimage", executable: join(homedir(), ".local/lib/whisperfree/openwhisper-launch"),
    arguments: [join(homedir(), ".local/lib/whisperfree/OpenWhisper.AppImage")], assertUnchanged() { throw new Error("Owned old identity changed"); } };
  await assert.rejects(runLinuxSupervisor({ launch: appimage, currentVersion: "0.3.0", argv: [], revalidateReplacement: input.revalidateReplacement }, input.effects), { code: "INVALID_REQUEST" });
  assert.deepEqual(input.calls, []);
});

test("only original exit starts the owned pipe watchdog and expiry still waits for actual original close", async (t) => {
  let now = 0; t.mock.method(performance, "now", () => now); t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = fixture(), original = runLinuxSupervisor({ launch, currentVersion: "0.3.0", argv: [], revalidateReplacement: input.revalidateReplacement }, input.effects);
  let settled = false; void original.then(() => { settled = true; }, () => { settled = true; });
  now = 10_000; t.mock.timers.tick(10_000); await turn(); assert.equal(input.pipe.destroyed, false);
  input.acceptExit(now); await turn(); now += 5000; t.mock.timers.tick(5000); await turn();
  assert.equal(input.pipe.destroyed, true); assert.equal(settled, false); assert.deepEqual(input.calls, ["spawn"]);
  input.acceptClose({ code: 0, signal: null }); await assert.rejects(original, { code: "CHANNEL_FAILED" });
  assert.deepEqual(input.calls, ["spawn"]);
});

test("late original close cannot beat the absolute exit deadline when the timer has not run", async (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const input = fixture(), original = runLinuxSupervisor({ launch, currentVersion: "0.3.0", argv: [], revalidateReplacement: input.revalidateReplacement }, input.effects);
  void original.catch(() => {}); input.acceptExit(now); await turn();
  input.pipe.end(input.receipt()); await turn(); input.pipe.destroy(); now = 5000; input.acceptClose({ code: 0, signal: null });
  await assert.rejects(original, { code: "CHANNEL_FAILED" }); assert.deepEqual(input.calls, ["spawn"]);
});

test("late replacement callback cannot beat its absolute deadline when the timer has not run", async (t) => {
  let now = 0, acceptReplacement!: () => void; t.mock.method(performance, "now", () => now);
  const replacement = new Promise<void>((accept) => { acceptReplacement = accept; }), input = fixture();
  const original = runLinuxSupervisor({ launch, currentVersion: "0.3.0", argv: [], revalidateReplacement: () => { input.calls.push("revalidate"); return replacement; } }, input.effects);
  void original.catch(() => {}); input.pipe.end(input.receipt()); await turn(); input.pipe.destroy(); input.acceptClose({ code: 0, signal: null });
  await turn(); assert.deepEqual(input.calls, ["spawn", "revalidate"]); now = 5000; acceptReplacement();
  await assert.rejects(original, { code: "REVALIDATION_FAILED" }); assert.deepEqual(input.calls, ["spawn", "revalidate"]);
});

test("uninstalled GUI fallback executes only the current fixed ELF with no supervisor or installed admission", () => {
  const input = fixture(), argv = ["literal value", ""];
  assert.throws(() => execLinuxGui(argv, input.effects), { code: "EXEC_FAILED" });
  assert.deepEqual(input.calls, ["exec"]); assert.equal(input.replacement()?.executable, process.execPath);
  assert.deepEqual(input.replacement()?.argv, [process.execPath, ...argv]);
  assert.equal(input.replacement()?.environment[LINUX_RESTART_NONCE], undefined);
  assert.equal(input.replacement()?.environment[LINUX_RESTART_VERSION], undefined);
});

test("replacement synchronous work is inside the absolute callback deadline", async (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  const input = fixture(), original = runLinuxSupervisor({ launch, currentVersion: "0.3.0", argv: [], revalidateReplacement: () => {
    input.calls.push("revalidate"); now += 5000; return Promise.resolve();
  } }, input.effects);
  void original.catch(() => {}); input.pipe.end(input.receipt()); await turn(); input.pipe.destroy(); input.acceptClose({ code: 0, signal: null });
  await assert.rejects(original, { code: "REVALIDATION_FAILED" }); assert.deepEqual(input.calls, ["spawn", "revalidate"]);
});

// Inert original-channel composition: no feed, download, installer, process or executable is substituted into production.
function updateFixture(install: LinuxSupervisorUpdates["installPrepared"], target: LinuxInstalledLaunch = launch) {
  const input = fixture(), [parent, peer] = duplexPair(); let retired = false;
  const effects: LinuxSupervisorEffects = { ...input.effects,
    launch(argv, env) { return { ...input.effects.launch(argv, env), pipe: parent }; } };
  const original = runLinuxSupervisor({ launch: target, currentVersion: "0.3.0", argv: ["literal value"],
    revalidateReplacement: async () => { assert.fail("V2 must not invoke the historical V1 validator."); },
    updates: {
      async action(kind) { input.calls.push(kind); return kind === "check"
        ? { status: "available", updateVersion: "0.3.1" } : { status: "prepared", updateVersion: "0.3.1" }; },
      installPrepared: install,
      async discardPrepared() { input.calls.push("discard"); },
    } }, effects);
  void original.catch(() => {});
  const gui = createLinuxUpdateGuiChannel(peer, { currentVersion: "0.3.0", nonce: input.environment()![LINUX_RESTART_NONCE]! }, (response) => {
    if (response.type === "retire") { retired = true; input.calls.push("retire"); }
  });
  const prepare = async (): Promise<void> => {
    await gui.request("install");
    for (let turnCount = 0; turnCount < 100 && !retired; turnCount++) await turn();
    assert.equal(retired, true); assert.equal(input.environment()![LINUX_UPDATE_PROTOCOL], "2");
  };
  const cleanup = async (): Promise<void> => {
    await gui.close(); input.acceptClose({ code: 0, signal: null }); await original.catch(() => {});
  };
  return { ...input, original, gui, prepare, cleanup };
}

test("V2 install waits for original retired duplex and GUI close; long authorization stays outside the final fence", async (t) => {
  let now = 0, release!: () => void, installing = false;
  t.mock.method(performance, "now", () => now); t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = new Promise<void>((accept) => { release = accept; });
  const input = updateFixture(async (version) => {
    assert.equal(version, "0.3.1"); installing = true; input.calls.push("install"); await held;
    return { assertForExec() { input.calls.push("final-check"); } };
  });
  try {
    await input.prepare(); assert.equal(installing, false);
    await input.gui.acknowledgeRetired(); await input.gui.closed; await turn(); assert.equal(installing, false);
    input.acceptClose({ code: 0, signal: null }); await turn(); assert.equal(installing, true);
    now += 60_000; t.mock.timers.tick(60_000); await turn();
    assert.equal(input.calls.includes("exec"), false); release();
    await assert.rejects(input.original, { code: "EXEC_FAILED" });
    assert.deepEqual(input.calls, ["spawn", "install", "retire", "install", "final-check", "exec", "discard"]);
    assert.equal(input.replacement()?.executable, "/opt/openwhisper/openwhisper-launch");
    assert.equal(input.replacement()?.environment[LINUX_UPDATE_PROTOCOL], undefined);
  } finally { release(); await input.cleanup(); }
});

test("V2 crash or missing original retirement never starts the privileged installer", async () => {
  for (const crash of [true, false]) {
    let installations = 0;
    const input = updateFixture(async () => { installations++; return { assertForExec() {} }; });
    try {
      await input.prepare();
      if (crash) { await input.gui.acknowledgeRetired(); await input.gui.closed; }
      else { input.gui.quit(); await input.gui.closed; }
      input.acceptClose({ code: crash ? 3 : 0, signal: null });
      if (crash) assert.equal(await input.original, 3);
      else await assert.rejects(input.original, { code: "CHANNEL_FAILED" });
      assert.equal(installations, 0); assert.equal(input.calls.includes("exec"), false);
      assert.equal(input.calls.at(-1), "discard");
    } finally { await input.cleanup(); }
  }
});

test("V2 final synchronous refusal or deadline prevents fixed exec after the long phase", async (t) => {
  let now = 0; t.mock.method(performance, "now", () => now);
  for (const timeout of [false, true]) {
    const input = updateFixture(async () => ({ assertForExec() {
      if (timeout) now += 5000; else throw new Error("Owned installed identity changed.");
    } }));
    try {
      await input.prepare(); await input.gui.acknowledgeRetired(); await input.gui.closed;
      input.acceptClose({ code: 0, signal: null });
      await assert.rejects(input.original, { code: "REVALIDATION_FAILED" });
      assert.equal(input.calls.includes("exec"), false);
    } finally { await input.cleanup(); }
  }
});

test("AppImage V2 uses its captured permanent pair and rolls back once after final refusal or exec failure", async () => {
  for (const finalRefusal of [false, true]) {
    let rollbacks = 0;
    const image = join(homedir(), ".local/lib/whisperfree/OpenWhisper.AppImage"), launcher = join(homedir(), ".local/lib/whisperfree/openwhisper-launch");
    const input = updateFixture(async () => ({ assertForExec() {
      if (finalRefusal) throw new Error("Owned final observation changed.");
    }, async rollbackBeforeExec() { rollbacks++; } }), { kind: "appimage", executable: launcher, arguments: [image], assertUnchanged() {} });
    try {
      await input.prepare(); await input.gui.acknowledgeRetired(); await input.gui.closed;
      input.acceptClose({ code: 0, signal: null });
      await assert.rejects(input.original, { code: finalRefusal ? "REVALIDATION_FAILED" : "EXEC_FAILED" });
      assert.equal(rollbacks, 1);
      assert.equal(input.calls.includes("exec"), !finalRefusal);
      if (!finalRefusal) {
        assert.deepEqual(input.replacement()?.argv, [launcher, image, "literal value"]);
        assert.equal(input.replacement()?.environment.APPIMAGE, undefined);
        assert.equal(input.replacement()?.environment.TMPDIR, undefined);
      }
    } finally { await input.cleanup(); }
    assert.equal(rollbacks, 1);
  }
});

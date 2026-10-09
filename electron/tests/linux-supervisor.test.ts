import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { bypassLinuxControl, execLinuxGui, runLinuxSupervisor, type LinuxSupervisorEffects } from "../src/cli/linux-supervisor.js";
import { LINUX_RESTART_NONCE, LINUX_RESTART_VERSION } from "../src/main/linux-restart.js";
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

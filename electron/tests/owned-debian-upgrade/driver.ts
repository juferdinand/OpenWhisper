import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { z } from "zod";
import type { DesktopBridge } from "../../src/contracts/bridge.js";
import { appStateSchema } from "../../src/contracts/ui.js";
import { installResponseSchema, resultSchema, upgradeInputSchema } from "./contract.js";

declare global { interface Window { openwhisper?: DesktopBridge } }
assert.equal(process.getuid?.(), 1000); assert.equal(process.env.OPENWHISPER_OWNED_DEBIAN_UPGRADE, "1");
assert.ok((await lstat("/.dockerenv")).isFile());
for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) await assert.rejects(lstat(device), { code: "ENOENT" });
const input = upgradeInputSchema.parse(JSON.parse(await readFile("/payload/input.json", "utf8")) as unknown);
const root = await mkdtemp("/tmp/openwhisper-owned-upgrade-"), home = join(root, "home"), runtime = join(root, "runtime"), evidence = "/evidence";
for (const path of [home, runtime, join(home, "config"), join(home, "cache"), join(home, "data")]) await mkdir(path, { mode: 0o700 });
const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
  XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
  XDG_RUNTIME_DIR: runtime, PIPEWIRE_RUNTIME_DIR: runtime, PULSE_SERVER: `unix:${runtime}/pulse/native`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime}/no-system-bus`,
  XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "Owned X11", LIBGL_ALWAYS_SOFTWARE: "1", LP_NUM_THREADS: "2",
  OPENWHISPER_OWNED_DEBIAN_UPGRADE: "1" };
type Owner = { child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; done: boolean };
const servers: Owner[] = [];
function launch(executable: string, args: string[], environment = env): Owner {
  const child = spawn(executable, args, { shell: false, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.resume(); child.stderr?.resume();
  const owner: Owner = { child, closed: Promise.resolve({ code: 1, signal: null }), done: false };
  owner.closed = new Promise((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => { owner.done = true; accept({ code, signal }); }); });
  void owner.closed.catch(() => {}); return owner;
}
async function until<T>(operation: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const end = performance.now() + timeout;
  while (performance.now() < end) { const result = await operation(); if (result !== undefined) return result; await delay(100); }
  throw new Error("Owned upgrade observation expired.");
}
async function absent(pid: number): Promise<void> { await assert.rejects(lstat(`/proc/${pid}`), { code: "ENOENT" }); }
async function ticks(pid: number): Promise<string> {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8"), value = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/u)[19];
  assert.ok(value && /^\d+$/u.test(value)); return value;
}
async function descendants(parent: number): Promise<number[]> {
  const pending = [parent], result: number[] = [];
  while (pending.length) {
    const pid = pending.pop()!; assert.ok(result.length < 128);
    let text: string; try { text = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8"); } catch { continue; }
    for (const value of text.trim().split(/\s+/u).filter(Boolean)) {
      assert.match(value, /^\d+$/u); const child = Number(value); if (!result.includes(child)) { result.push(child); pending.push(child); }
    }
  }
  return result;
}
async function inspector(expression: string): Promise<unknown> {
  const list = z.array(z.object({ webSocketDebuggerUrl: z.string().startsWith("ws://127.0.0.1:9225/") })).length(1)
    .parse(await (await fetch("http://127.0.0.1:9225/json/list", { signal: AbortSignal.timeout(2000) })).json());
  const socket = new WebSocket(list[0]!.webSocketDebuggerUrl);
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Owned inspector timed out.")); }, 3000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })));
    socket.addEventListener("message", (event) => {
      const reply = z.object({ id: z.number().optional(), result: z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.unknown().optional() }).optional() })
        .parse(JSON.parse(String(event.data)) as unknown);
      if (reply.id !== 1) return;
      clearTimeout(timer); socket.close();
      if (reply.result?.exceptionDetails || !reply.result) reject(new Error("Owned main inspection refused.")); else accept(reply.result.result.value);
    });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Owned inspector unavailable.")); });
  });
}
const appExpression = "process.getBuiltinModule('module').createRequire('/opt/openwhisper/resources/app/package.json')('electron').app";
const mainFacts = () => inspector(`(()=>{const app=${appExpression};return {pid:process.pid,parent:process.ppid,version:app.getVersion(),appPath:app.getAppPath(),executable:process.execPath,socket:process.getBuiltinModule('fs').fstatSync(3).isSocket()}})()`);
const factsSchema = z.object({ pid: z.number().int().positive(), parent: z.number().int().positive(), version: z.string(),
  appPath: z.literal("/opt/openwhisper/resources/app"), executable: z.literal("/opt/openwhisper/openwhisper"), socket: z.literal(true) });
let supervisor: Owner | undefined, browser: Browser | undefined, phase = "services", outcome = "FAIL";
try {
  const wire = join(home, "config/wireplumber");
  for (const directory of ["main.lua.d", "bluetooth.lua.d"]) await mkdir(join(wire, directory), { recursive: true, mode: 0o700 });
  await writeFile(join(wire, "main.lua.d/89-owned-no-devices.lua"), "alsa_monitor.enabled = false\nv4l2_monitor.enabled = false\nlibcamera_monitor.enabled = false\n", { mode: 0o600 });
  await writeFile(join(wire, "bluetooth.lua.d/89-owned-no-devices.lua"), "bluez_monitor.enabled = false\n", { mode: 0o600 });
  for (const [executable, args, socket] of [
    ["/usr/bin/dbus-daemon", ["--session", "--nofork", `--address=${env.DBUS_SESSION_BUS_ADDRESS}`], join(runtime, "bus")],
    ["/usr/bin/pipewire", [], join(runtime, "pipewire-0")],
    ["/usr/bin/pipewire-pulse", [], join(runtime, "pulse/native")],
  ] as const) {
    const owner = launch(executable, [...args]); servers.push(owner);
    await until(async () => { assert.equal(owner.done, false); try { return (await lstat(socket)).isSocket() ? true : undefined; } catch { return undefined; } });
  }
  servers.push(launch("/usr/bin/wireplumber", []));
  const display = ":95"; const x = launch("/usr/bin/Xvfb", [display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"]); servers.push(x);
  await until(async () => { assert.equal(x.done, false); try { return (await lstat("/tmp/.X11-unix/X95")).isSocket() ? true : undefined; } catch { return undefined; } });
  env.DISPLAY = display;
  const legacy = join(home, "config/whisperfree"); await mkdir(legacy, { mode: 0o700 });
  await writeFile(join(legacy, "settings.json"), JSON.stringify({ setup_completed: true, ui_language: "en", model: "tiny", language: "en", output: "clipboard",
    gpu: false, gpu_configured: true, keep_history: true, auto_check_updates: false, launch_at_login: false }), { mode: 0o600 });
  await writeFile(join(legacy, "history.json"), "[]", { mode: 0o600 });
  phase = "older-launch";
  supervisor = launch("/opt/openwhisper/openwhisper", ["/payload/host.mjs", "--inspect=127.0.0.1:9225", "--remote-debugging-port=9224", "--ozone-platform=x11"],
    { ...env, ELECTRON_RUN_AS_NODE: "1" }); assert.ok(supervisor.child.pid);
  const supervisorPid = supervisor.child.pid, originalTicks = await ticks(supervisorPid);
  const connect = async (): Promise<{ browser: Browser; page: Page }> => {
    const connected = await until(async () => { try { return await chromium.connectOverCDP("http://127.0.0.1:9224", { timeout: 1500 }); } catch { return undefined; } });
    const page = await until(async () => connected.contexts()[0]?.pages().find(page => page.url() === "app://openwhisper/index.html"));
    await page.waitForFunction(() => !!window.openwhisper); return { browser: connected, page };
  };
  let connection = await connect(); browser = connection.browser; let page = connection.page;
  const state = () => page.evaluate(() => window.openwhisper!.invoke("get_state", {})).then(value => appStateSchema.parse(value));
  const oldFacts = factsSchema.parse(await mainFacts()); assert.equal(oldFacts.parent, supervisorPid); assert.equal(oldFacts.version, input.older.sourceVersion);
  const initial = await state(); assert.equal(initial.version, input.older.sourceVersion); assert.equal(initial.updates.configured, true);
  assert.equal(initial.preferences.auto_check_updates, false); assert.equal(initial.status, "idle");
  await page.locator('[data-tab="general"]').click();
  await page.locator('[data-pref="language"]').selectOption("de");
  await until(async () => (await state()).preferences.language === "de" ? true : undefined);
  const preferencePath = join(legacy, "electron/settings/preferences.json"), preferencesBefore = await readFile(preferencePath);
  const originalNative = (await descendants(oldFacts.pid)).filter(pid => pid !== oldFacts.pid);
  await writeFile(join(evidence, "original-owners.json"), JSON.stringify({ gui: oldFacts.pid, native: originalNative }), { flag: "wx", mode: 0o600 });
  phase = "check-and-install";
  await page.locator('[data-tab="about"]').click(); await page.locator('[data-command="check_updates"]').click();
  await until(async () => (await state()).updates.status === "available" ? true : undefined);
  await expect(page.locator('[data-command="install_update"]')).toBeEnabled();
  await page.locator('[data-command="install_update"]').click();
  await until(async () => { assert.equal(supervisor!.done, false); try { return JSON.parse(await readFile(join(evidence, "final-exec-guard.json"), "utf8")) as unknown; } catch { return undefined; } }, 90_000);
  assert.equal(supervisor.done, false); assert.equal(await ticks(supervisorPid), originalTicks); await absent(oldFacts.pid);
  for (const pid of originalNative) await absent(pid);
  phase = "successor-launch";
  await until(async () => { try { const value = factsSchema.parse(await mainFacts()); return value.version === input.newer.sourceVersion ? value : undefined; } catch { return undefined; } });
  connection = await connect(); browser = connection.browser; page = connection.page;
  const newerFacts = factsSchema.parse(await mainFacts()); assert.equal(newerFacts.parent, supervisorPid); assert.notEqual(newerFacts.pid, oldFacts.pid);
  assert.equal(newerFacts.version, input.newer.sourceVersion); assert.equal(await ticks(supervisorPid), originalTicks);
  const successor = await state(); assert.equal(successor.version, input.newer.sourceVersion); assert.equal(successor.status, "idle");
  assert.equal(successor.preferences.language, "de"); assert.deepEqual(await readFile(preferencePath), preferencesBefore);
  const appRoot = newerFacts.appPath;
  assert.deepEqual(JSON.parse(await readFile(join(appRoot, "dist/resources/development-build.json"), "utf8")), input.newer.source);
  assert.equal((await readFile(join(appRoot, "dist/resources/VERSION"), "utf8")).trim(), input.newer.sourceVersion);
  assert.equal(z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"))).version, input.newer.sourceVersion);
  installResponseSchema.parse(JSON.parse(await readFile(join(evidence, "install-response.json"), "utf8")));
  phase = "successor-quit";
  const all = await descendants(supervisorPid);
  await inspector(`(()=>{setTimeout(()=>${appExpression}.quit(),0);return true})()`);
  const closed = await supervisor.closed; assert.equal(closed.code, 0); assert.equal(closed.signal, null);
  await absent(supervisorPid); for (const pid of all) await absent(pid);
  await browser.close(); browser = undefined;
  outcome = "PASS";
  await writeFile(join(evidence, "result.json"), JSON.stringify(resultSchema.parse({ status: "PASS", classification: "SIGNED_DEBIAN_GUI_UPGRADE_COMPOSITION",
    fromVersion: input.older.sourceVersion, toVersion: input.newer.sourceVersion, supervisorPid, sameStartTicks: true,
    originalGuiAbsentBeforeInstall: true, originalNativeAbsentBeforeInstall: true, sourceClosedBeforeExec: true, actualFixedExec: true,
    successorVersionAndSource: true, preferencesPreserved: true, originalNormalQuit: true, descendantsAbsent: true,
    scope: "OWNED_OFFLINE_FEED_AND_NAMESPACE_INSTALLER_NO_HTTPS_OR_POLKIT" })), { flag: "wx", mode: 0o600 });
} finally {
  if (supervisor && !supervisor.done) { supervisor.child.kill("SIGTERM"); await Promise.race([supervisor.closed, delay(3000)]); }
  for (const owner of servers.reverse()) { if (!owner.done) owner.child.kill("SIGTERM"); await owner.closed; if (owner.child.pid) await absent(owner.child.pid); }
  await writeFile(join(evidence, "driver-cleanup.json"), JSON.stringify({ outcome, phase, serversClosed: servers.every(owner => owner.done),
    supervisorClosed: supervisor?.done ?? false }), { flag: "wx", mode: 0o600 });
}

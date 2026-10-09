import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { z } from "zod";
import type { DesktopBridge } from "../../src/contracts/bridge.js";
import { appStateSchema } from "../../src/contracts/ui.js";
import { appImageLauncher } from "../../src/services/linux-appimage-launcher.js";
import { resultSchema, updateInputSchema } from "./contract.js";

declare global { interface Window { openwhisper?: DesktopBridge } }
assert.equal(process.getuid?.(), 1000); assert.equal(process.env.OPENWHISPER_OWNED_APPIMAGE_UPGRADE, "1");
assert.ok((await lstat("/.dockerenv")).isFile());
for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri", "/dev/fuse"]) await assert.rejects(lstat(device), { code: "ENOENT" });
const input = updateInputSchema.parse(JSON.parse(await readFile("/payload/input.json", "utf8")) as unknown);
const privateRoot = await mkdtemp("/tmp/owai-"), home = join(privateRoot, "home"), runtime = join(privateRoot, "runtime");
const evidence = "/evidence", appDirectory = join(home, ".local/lib/whisperfree"), temporary = join(privateRoot, "appimage-tmp");
for (const path of [home, runtime, join(home, "config"), join(home, "cache"), join(home, "data"), appDirectory, temporary])
  await mkdir(path, { recursive: true, mode: 0o700 });
const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TMPDIR: temporary,
  XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
  XDG_RUNTIME_DIR: runtime, PIPEWIRE_RUNTIME_DIR: runtime, PIPEWIRE_REMOTE: "pipewire-0", PULSE_SERVER: `unix:${runtime}/pulse/native`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime}/no-system-bus`,
  XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "Owned X11", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe", LP_NUM_THREADS: "2",
  OPENWHISPER_OWNED_APPIMAGE_UPGRADE: "1" };
type Owner = { child: ChildProcess; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; done: boolean };
const services: Owner[] = [];
function launch(executable: string, args: string[], environment = env, capturePath?: string): Owner {
  const child = spawn(executable, args, { shell: false, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let captured = 0, truncated = false; const chunks: Buffer[] = [];
  const collect = (chunk: Buffer): void => {
    const remaining = 256 * 1024 - captured;
    if (remaining > 0) { const part = chunk.subarray(0, remaining); chunks.push(part); captured += part.length; }
    if (chunk.length > remaining) truncated = true;
  };
  if (capturePath) { child.stdout?.on("data", collect); child.stderr?.on("data", collect); }
  else { child.stdout?.resume(); child.stderr?.resume(); }
  const owner: Owner = { child, closed: Promise.resolve({ code: 1, signal: null }), done: false };
  owner.closed = new Promise((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => {
    owner.done = true;
    const result = { code, signal };
    if (capturePath) void writeFile(capturePath, Buffer.concat([...chunks, Buffer.from(`\n[log ${truncated ? "truncated" : "complete"}; captured ${captured} bytes]\n`)]),
      { flag: "wx", mode: 0o600 }).then(() => accept(result), reject);
    else accept(result);
  }); });
  void owner.closed.catch(() => {}); return owner;
}
async function until<T>(operation: () => Promise<T | undefined>, timeout = 20_000): Promise<T> {
  const end = performance.now() + timeout;
  while (performance.now() < end) { const value = await operation(); if (value !== undefined) return value; await delay(100); }
  throw new Error("Owned AppImage upgrade observation expired.");
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
    for (const value of text.trim().split(/\s+/u).filter(Boolean)) { assert.match(value, /^\d+$/u); const child = Number(value);
      if (!result.includes(child)) { result.push(child); pending.push(child); } }
  }
  return result;
}
async function inspector(expression: string): Promise<unknown> {
  const list = z.array(z.object({ webSocketDebuggerUrl: z.string().startsWith("ws://127.0.0.1:9225/") })).length(1)
    .parse(await (await fetch("http://127.0.0.1:9225/json/list", { signal: AbortSignal.timeout(2000) })).json());
  const socket = new WebSocket(list[0]!.webSocketDebuggerUrl);
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("Owned AppImage inspector timed out.")); }, 3000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })));
    socket.addEventListener("message", (event) => {
      const reply = z.object({ id: z.number().optional(), result: z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.unknown().optional() }).optional() })
        .parse(JSON.parse(String(event.data)) as unknown);
      if (reply.id !== 1) return; clearTimeout(timer); socket.close();
      if (reply.result?.exceptionDetails || !reply.result) reject(new Error("Owned AppImage main inspection refused.")); else accept(reply.result.result.value);
    });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Owned AppImage inspector unavailable.")); });
  });
}
const appExpression = "process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(process.getBuiltinModule('path').dirname(process.execPath),'resources/app/package.json'))('electron').app";
const mainFacts = () => inspector(`(()=>{const app=${appExpression};const fs=process.getBuiltinModule('fs');const path=process.getBuiltinModule('path');const read=(name)=>fs.readFileSync(path.join(app.getAppPath(),name),'utf8');return {pid:process.pid,parent:process.ppid,version:app.getVersion(),appPath:app.getAppPath(),executable:process.execPath,socket:fs.fstatSync(3).isSocket(),source:JSON.parse(read('dist/resources/development-build.json')),package:JSON.parse(read('package.json')).version,resourceVersion:read('dist/resources/VERSION').trim()}})()`);
const factsSchema = z.object({ pid: z.number().int().positive(), parent: z.number().int().positive(), version: z.string(), appPath: z.string(),
  executable: z.string(), socket: z.literal(true), source: z.object({ commit: z.string(), modified: z.literal(false) }),
  package: z.string(), resourceVersion: z.string() });
let supervisor: Owner | undefined, browser: Browser | undefined, phase = "services", result = "FAIL";
try {
  const wire = join(home, "config/wireplumber");
  for (const name of ["main.lua.d", "bluetooth.lua.d"]) await mkdir(join(wire, name), { recursive: true, mode: 0o700 });
  await writeFile(join(wire, "main.lua.d/89-owned-no-devices.lua"), "alsa_monitor.enabled = false\nv4l2_monitor.enabled = false\nlibcamera_monitor.enabled = false\n", { mode: 0o600 });
  await writeFile(join(wire, "bluetooth.lua.d/89-owned-no-devices.lua"), "bluez_monitor.enabled = false\n", { mode: 0o600 });
  for (const [executable, args, socket] of [
    ["/usr/bin/dbus-daemon", ["--session", "--nofork", `--address=${env.DBUS_SESSION_BUS_ADDRESS}`], join(runtime, "bus")],
    ["/usr/bin/pipewire", [], join(runtime, "pipewire-0")], ["/usr/bin/pipewire-pulse", [], join(runtime, "pulse/native")],
  ] as const) {
    const owner = launch(executable, [...args]); services.push(owner);
    await until(async () => { assert.equal(owner.done, false); try { return (await lstat(socket)).isSocket() ? true : undefined; } catch { return undefined; } });
  }
  services.push(launch("/usr/bin/wireplumber", []));
  const x = launch("/usr/bin/Xvfb", [":95", "-screen", "0", "1280x900x24", "-nolisten", "tcp"]); services.push(x);
  await until(async () => { assert.equal(x.done, false); try { return (await lstat("/tmp/.X11-unix/X95")).isSocket() ? true : undefined; } catch { return undefined; } });
  env.DISPLAY = ":95";
  const legacy = join(home, "config/whisperfree"); await mkdir(legacy, { mode: 0o700 });
  await writeFile(join(legacy, "settings.json"), JSON.stringify({ setup_completed: true, ui_language: "en", model: "tiny", language: "en", output: "clipboard",
    gpu: false, gpu_configured: true, keep_history: true, auto_check_updates: false, launch_at_login: false }), { mode: 0o600 });
  await writeFile(join(legacy, "history.json"), "[]", { mode: 0o600 });
  for (const version of ["older", "newer"] as const) {
    const bytes = await readFile(`/payload/${version}/${input[version].filename}`);
    assert.equal(bytes.length, input[version].image.bytes); const digest = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex"));
    assert.equal(digest, input[version].image.sha256);
    const signature = await readFile(`/payload/${version}/${input[version].filename}.sig`); assert.equal(signature.length, input[version].signature.bytes);
    if (version === "older") {
      const target = join(appDirectory, "OpenWhisper.AppImage"); await writeFile(target, bytes, { flag: "wx", mode: 0o700 });
      await writeFile(`${target}.sig`, signature, { flag: "wx", mode: 0o600 });
    }
  }
  await writeFile(join(appDirectory, "openwhisper-launch"), appImageLauncher(), { mode: 0o700, flag: "wx" });
  phase = "older-launch";
  const image = join(appDirectory, "OpenWhisper.AppImage"), launcher = join(appDirectory, "openwhisper-launch");
  supervisor = launch(launcher, [image, "--inspect=127.0.0.1:9225", "--remote-debugging-port=9224", "--ozone-platform=x11"], env,
    join(evidence, "supervisor.log")); assert.ok(supervisor.child.pid);
  const connect = async (): Promise<{ browser: Browser; page: Page }> => {
    const connected = await until(async () => { try { return await chromium.connectOverCDP("http://127.0.0.1:9224", { timeout: 1500 }); } catch { return undefined; } });
    const page = await until(async () => connected.contexts()[0]?.pages().find((candidate) => candidate.url() === "app://openwhisper/index.html"));
    await page.waitForFunction(() => !!window.openwhisper); return { browser: connected, page };
  };
  let connection = await connect(); browser = connection.browser; let page = connection.page;
  const state = () => page.evaluate(() => window.openwhisper!.invoke("get_state", {})).then((value) => appStateSchema.parse(value));
  const oldFacts = factsSchema.parse(await mainFacts());
  assert.equal(oldFacts.version, input.older.version); assert.equal(oldFacts.source.commit, input.older.source.commit);
  assert.equal(oldFacts.package, input.older.version); assert.equal(oldFacts.resourceVersion, input.older.version);
  assert.equal((await state()).updates.package, "appimage");
  const supervisorPid = oldFacts.parent, startTicks = await ticks(supervisorPid);
  const originalNative = (await descendants(oldFacts.pid)).filter((pid) => pid !== oldFacts.pid);
  await writeFile(join(evidence, "original-owners.json"), JSON.stringify({ supervisor: supervisorPid, gui: oldFacts.pid, native: originalNative }), { flag: "wx", mode: 0o600 });
  await page.locator('[data-ui-language="de"]').click();
  await until(async () => (await state()).preferences.ui_language === "de" ? true : undefined);
  const preferencePath = join(legacy, "electron/settings/preferences.json"), preferencesBefore = await readFile(preferencePath);
  await page.locator('[data-tab="about"]').click(); await page.locator('[data-command="check_updates"]').click();
  await until(async () => (await state()).updates.status === "available" ? true : undefined);
  await expect(page.locator('[data-command="install_update"]')).toBeEnabled(); await page.locator('[data-command="install_update"]').click();
  const execGuard = z.object({ pid: z.number().int().positive(), version: z.literal("0.3.1"), passed: z.literal(true),
    sourceFdClosed: z.literal(true), sourceStageAbsent: z.literal(true), oldGuiClosed: z.literal(true), oldNativeOwnersClosed: z.literal(true) })
    .strict().parse(await until(async () => {
    assert.equal(supervisor!.done, false); try { return JSON.parse(await readFile(join(evidence, "final-exec-guard.json"), "utf8")) as unknown; }
    catch { return undefined; } }, 90_000));
  assert.equal(execGuard.pid, supervisorPid);
  const closure = z.object({ descriptorClosed: z.literal(true), stageAbsent: z.literal(true), stageDirectory: z.string().startsWith("/") }).strict()
    .parse(JSON.parse(await readFile(join(evidence, "source-closed.json"), "utf8")) as unknown);
  await assert.rejects(lstat(closure.stageDirectory), { code: "ENOENT" });
  assert.equal(await ticks(supervisorPid), startTicks); await absent(oldFacts.pid); for (const pid of originalNative) await absent(pid);
  phase = "successor-launch";
  await until(async () => { try { const value = factsSchema.parse(await mainFacts()); return value.version === input.newer.version ? value : undefined; } catch { return undefined; } }, 90_000);
  connection = await connect(); browser = connection.browser; page = connection.page;
  const newerFacts = factsSchema.parse(await mainFacts());
  assert.notEqual(newerFacts.pid, oldFacts.pid); assert.equal(newerFacts.version, input.newer.version); assert.equal(newerFacts.source.commit, input.newer.source.commit);
  assert.equal(newerFacts.package, input.newer.version); assert.equal(newerFacts.resourceVersion, input.newer.version);
  assert.ok((await descendants(supervisorPid)).includes(newerFacts.parent)); assert.equal(await ticks(supervisorPid), startTicks);
  const successor = await state(); assert.equal(successor.version, input.newer.version); assert.equal(successor.status, "idle");
  assert.equal(successor.preferences.ui_language, "de"); assert.deepEqual(await readFile(preferencePath), preferencesBefore);
  const all = await descendants(supervisor.child.pid!);
  await inspector(`(()=>{setTimeout(()=>${appExpression}.quit(),0);return true})()`);
  const closed = await supervisor.closed; assert.equal(closed.code, 0); assert.equal(closed.signal, null);
  await absent(supervisor.child.pid!); for (const pid of all) await absent(pid);
  await browser.close(); browser = undefined;
  await writeFile(join(evidence, "result.json"), JSON.stringify(resultSchema.parse({ status: "PASS",
    classification: "SIGNED_APPIMAGE_GUI_UPGRADE_WITH_OWNED_OLDER_APPRUN_FIXTURE", fromVersion: input.older.version, toVersion: input.newer.version,
    supervisorPid, sameStartTicks: true, oldGuiClosedBeforeExec: execGuard.oldGuiClosed, oldNativeOwnersClosedBeforeExec: execGuard.oldNativeOwnersClosed,
    sourceFdClosedBeforeExec: execGuard.sourceFdClosed, sourceStageAbsentBeforeExec: execGuard.sourceStageAbsent, sourceClosedBeforeExec: true,
    actualFixedExec: true, successorVersionAndSource: true, preferencesPreserved: true, normalQuit: true, descendantsAbsent: true,
    scope: "OFFLINE_PRIVATE_SIGNED_IMAGES_NO_HOST_DESKTOP_AUDIO_DEVICES_OR_NETWORK" })), { flag: "wx", mode: 0o600 });
  result = "PASS";
} finally {
  if (browser) await browser.close().catch(() => {});
  if (supervisor && !supervisor.done) { supervisor.child.kill("SIGTERM"); await Promise.race([supervisor.closed, delay(3000)]); }
  for (const owner of services.reverse()) { if (!owner.done) owner.child.kill("SIGTERM"); await owner.closed; if (owner.child.pid) await absent(owner.child.pid); }
  await writeFile(join(evidence, "driver-cleanup.json"), JSON.stringify({ outcome: result, phase, servicesClosed: services.every((owner) => owner.done),
    supervisorClosed: supervisor?.done ?? false }), { flag: "wx", mode: 0o600 });
}

import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { z } from "zod";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/profiles.js";
import { validateCommandOutput } from "../../src/contracts/ui.js";
import type { DesktopBridge } from "../../src/contracts/bridge.js";
import { recordingHostErrorSchema } from "../../src/workers/recording-host-protocol.js";
import { kdeJournalSchema } from "../../src/platforms/linux/kde/keyboard.js";

declare global { interface Window { openwhisper?: DesktopBridge } }
const execute = promisify(execFile);
const payload = resolve(fileURLToPath(new URL("./", import.meta.url)));
const packageRoot = join(payload, "app"), evidence = "/evidence";
const stockKde = process.env.OPENWHISPER_STOCK_KDE === "1";
const kdeLifecycle = process.env.OPENWHISPER_KDE_LIFECYCLE === "1";
const kdeOverlay = process.env.OPENWHISPER_KDE_OVERLAY === "1";
const kdeXwaylandPaste = process.env.OPENWHISPER_KDE_PASTE === "xwayland";
const kdePaste = process.env.OPENWHISPER_KDE_PASTE === "wayland" || kdeXwaylandPaste;
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const checks: string[] = [];
let stage = "guard", status = "FAIL", application: ElectronApplication | undefined, page: Page | undefined;
let failure: { name: string; location: string | null } | undefined;
let appCloseObserved = false, appOriginalClose: Promise<void> | undefined;
const appOwners: { original: ChildProcess; closed: Promise<void>; closeObserved: boolean; termination: "quit" | "crash" | null }[] = [];
let lastState: Readonly<{ status: string; recordingAvailable: boolean; recoveryAvailable: boolean; elapsed: number; progress: number;
  messageCategory: "NONE" | "RECORDING_ERROR" | "ACTION_REFUSED" | "OTHER"; recordingError: string | null }> | undefined;
const owners: { child: ChildProcess; closed: Promise<void>; closeObserved: boolean }[] = [];
const diagnostics: { stdoutBytes: number; stderrBytes: number } = { stdoutBytes: 0, stderrBytes: 0 };
async function checkpoint(value: string): Promise<void> {
  stage = value; await writeFile(join(evidence, "checkpoint.json"), JSON.stringify({ stage, checks }), { mode: 0o600 });
}
async function recordResources(name: string): Promise<Record<string, string>> {
  const resources: Record<string, string> = {};
  for (const field of ["pids.current", "pids.max", "pids.peak", "pids.events", "memory.events"]) {
    try { resources[field] = (await readFile(`/sys/fs/cgroup/${field}`, "utf8")).slice(0, 1024); } catch {}
  }
  await writeFile(join(evidence, name), JSON.stringify(resources), { mode: 0o600 }); return resources;
}
function child(command: string, args: string[], env: NodeJS.ProcessEnv, display = false) {
  const process = spawn(command, args, { env, shell: false, stdio: display ? ["ignore", "ignore", "pipe", "pipe"] : "ignore" });
  const owner = { child: process, closeObserved: false, closed: Promise.resolve() };
  let errored = false;
  owner.closed = new Promise<void>((accept, reject) => {
    process.on("error", () => { errored = true; });
    process.once("close", () => { owner.closeObserved = true; if (errored) reject(new Error("OWNED_CHILD_ERROR")); else accept(); });
  });
  void owner.closed.catch(() => {}); owners.push(owner); return owner;
}
async function waitSocket(path: string, owner: ReturnType<typeof child>) {
  const end = performance.now() + 15_000;
  while (performance.now() < end) {
    assert.equal(owner.closeObserved, false);
    try { const value = await lstat(path); if (value.isSocket() && value.uid === 1000) return; } catch {}
    await delay(50);
  }
  throw new Error("OWNED_SOCKET_UNAVAILABLE");
}
async function state() {
  assert.ok(page);
  const value = validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {})));
  const failure = recordingHostErrorSchema.safeParse(/^Recording failed: ([A-Z_]+)\.$/u.exec(value.message)?.[1]);
  lastState = { status: value.status, recordingAvailable: value.recording_available ?? false,
    recoveryAvailable: value.recovery_available ?? false, elapsed: value.elapsed, progress: value.progress,
    messageCategory: failure.success ? "RECORDING_ERROR" : value.message === "The action could not be completed. Stopped recordings are kept for retry."
      ? "ACTION_REFUSED" : value.message ? "OTHER" : "NONE", recordingError: failure.success ? failure.data : null };
  return value;
}
async function until(predicate: () => Promise<boolean>, milliseconds = 20_000) {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { if (await predicate()) return; await delay(100); }
  throw new Error("OWNED_CONDITION_UNMET");
}
async function main(): Promise<void> {
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64"); assert.equal(process.getuid?.(), 1000);
  assert.equal(process.versions.node, "24.21.0");
  assert.equal(sha(await readFile(process.execPath)), "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c");
  assert.equal(sha(await readFile(join(packageRoot, "node_modules/electron/dist/electron"))), "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564");
  assert.equal(process.env.OPENWHISPER_OWNED_DEV_RECORDING, "1");
  if (kdeLifecycle) assert.equal(stockKde, true);
  if (process.env.OPENWHISPER_KDE_PASTE !== undefined) {
    assert.equal(kdePaste, true); assert.equal(stockKde, true); assert.equal(kdeLifecycle, false);
  }
  if (process.env.OPENWHISPER_KDE_OVERLAY !== undefined) {
    assert.equal(kdeOverlay, true); assert.equal(stockKde, true);
    assert.equal(kdeLifecycle, false); assert.equal(kdePaste, false);
  }
  assert.ok((await lstat("/.dockerenv")).isFile());
  for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) await assert.rejects(lstat(device), { code: "ENOENT" });
  for (const key of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) assert.equal(process.env[key], undefined);
  if (stockKde) {
    assert.equal(process.env.WF_OWNED_DESKTOP_TEST, process.env.XDG_RUNTIME_DIR);
    assert.match(process.env.XDG_RUNTIME_DIR ?? "", /^\/tmp\/ow-runtime-[A-Za-z0-9_-]+$/u);
    assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS?.split(",")[0], `unix:path=${process.env.XDG_RUNTIME_DIR}/session-bus`);
    assert.equal(process.env.PULSE_SERVER, `unix:${process.env.XDG_RUNTIME_DIR}/pulse/native`);
    assert.equal((await lstat(process.env.XDG_RUNTIME_DIR!)).uid, 1000);
    assert.equal(process.env.XDG_SESSION_TYPE, "wayland");
  } else for (const key of ["PULSE_SERVER", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) assert.equal(process.env[key], undefined);
  const root = await mkdtemp("/tmp/openwhisper-owned-dev-recording-"); await chmod(root, 0o700);
  const home = join(root, "home"), runtime = join(root, "runtime"), config = join(home, "config");
  for (const path of [home, runtime, config, join(home, "data"), join(home, "cache")]) await mkdir(path, { mode: 0o700 });
  await mkdir(join(config, "wireplumber/main.lua.d"), { recursive: true, mode: 0o700 });
  await mkdir(join(config, "wireplumber/bluetooth.lua.d"), { recursive: true, mode: 0o700 });
  await writeFile(join(config, "wireplumber/main.lua.d/89-owned-no-devices.lua"), "alsa_monitor.enabled = false\nv4l2_monitor.enabled = false\nlibcamera_monitor.enabled = false\n", { mode: 0o600 });
  await writeFile(join(config, "wireplumber/bluetooth.lua.d/89-owned-no-devices.lua"), "bluez_monitor.enabled = false\n", { mode: 0o600 });
  const env: Record<string, string> = stockKde ? Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) : {
    HOME: home, PATH: "/opt/node/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_RUNTIME_DIR: runtime, PIPEWIRE_RUNTIME_DIR: runtime, PIPEWIRE_REMOTE: "pipewire-0",
    PULSE_SERVER: `unix:${runtime}/pulse/native`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime}/disabled-system-bus`,
    XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "Owned X11", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe",
  };
  const profileRoot = join(root, "dev-profile");
  const profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ home, configHome: config, dataHome: env.XDG_DATA_HOME,
    cacheHome: env.XDG_CACHE_HOME, explicitRoot: profileRoot }));
  const model = await readFile(join(payload, "fixtures/ggml-tiny.bin"));
  assert.equal(model.length, 77691713); assert.equal(sha(model), "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21");
  await copyFile(join(payload, "fixtures/ggml-tiny.bin"), join(profile.paths.models, "ggml-tiny.bin"));
  await chmod(join(profile.paths.models, "ggml-tiny.bin"), 0o600);
  const stable = join(env.XDG_DATA_HOME!, "whisperfree"); await mkdir(stable, { mode: 0o700 });
  await writeFile(join(stable, "sentinel"), "Owned stable sentinel", { mode: 0o600 });
  const stableBefore = sha(await readFile(join(stable, "sentinel")));
  await checkpoint("private-session");
  if (stockKde) {
    const config = join(env.XDG_CONFIG_HOME!, "xdg-desktop-portal"); await mkdir(config, { mode: 0o700 });
    await writeFile(join(config, "portals.conf"), "[preferred]\ndefault=none\norg.freedesktop.impl.portal.GlobalShortcuts=kde\norg.freedesktop.impl.portal.Settings=kde\n"
      + (kdePaste ? "org.freedesktop.impl.portal.RemoteDesktop=kde\n" : ""));
    const desktopFiles = join(env.XDG_DATA_HOME!, "applications"); await mkdir(desktopFiles, { mode: 0o700, recursive: true });
    await writeFile(join(desktopFiles, "io.github.whisperfree.dev.desktop"), "[Desktop Entry]\nType=Application\nName=OpenWhisper Dev\nExec=/payload/app/node_modules/electron/dist/electron /payload/app --dev\n");
    env.QT_QPA_PLATFORM = "wayland";
    child("/usr/bin/kglobalaccel5", [], env);
    await until(async () => (await execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
      "--method", "org.freedesktop.DBus.NameHasOwner", "org.kde.kglobalaccel"], { env, timeout: 3000 })).stdout.includes("true"));
    child("/usr/libexec/xdg-permission-store", [], env);
    child("/usr/lib/x86_64-linux-gnu/libexec/xdg-desktop-portal-kde", [], env);
    await until(async () => (await execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
      "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.impl.portal.desktop.kde"], { env, timeout: 3000 })).stdout.includes("true"));
    child("/usr/libexec/xdg-desktop-portal", [], env);
    await until(async () => (await execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
      "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.portal.Desktop"], { env, timeout: 3000 })).stdout.includes("true"));
    const versions = await execute("/usr/bin/dpkg-query", ["-W", "plasma-workspace", "xdg-desktop-portal", "xdg-desktop-portal-kde"], { env, timeout: 3000 });
    await writeFile(join(evidence, "stock-versions.txt"), versions.stdout, { mode: 0o600 });
  } else {
  const bus = child("/usr/bin/dbus-daemon", ["--session", "--nofork", `--address=unix:path=${runtime}/bus`], env); await waitSocket(join(runtime, "bus"), bus);
  const portalBinary = join(payload, "owned-bus/owned-portal");
  const portalOwner = child(portalBinary, [env.DBUS_SESSION_BUS_ADDRESS!], env);
  await until(async () => {
    assert.equal(portalOwner.closeObserved, false);
    return (await execute("/usr/bin/dbus-send", ["--session", "--type=method_call", "--print-reply", "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.portal.Desktop"], { env, timeout: 5000, maxBuffer: 8192 })).stdout.includes("boolean true");
  });
  }
  const portal = async (member: "PortalMode" | "PortalStatus" | "Press" | "Release" | "Unassign" | "End", mode?: "grant" | "pending" | "deny") => {
    assert.equal(stockKde, false, "Stock desktop checks must never inject fixture portal signals.");
    return (await execute("/usr/bin/dbus-send", ["--session", "--type=method_call", "--print-reply", "--dest=org.freedesktop.portal.Desktop",
      "/owned", `org.openwhisper.Owned.${member}`, ...(mode ? [`string:${mode}`] : [])], { env, timeout: 5000, maxBuffer: 8192 })).stdout;
  };
  if (!stockKde) {
  const pipewire = child("/usr/bin/pipewire", [], env); await waitSocket(join(runtime, "pipewire-0"), pipewire);
  child("/usr/bin/wireplumber", [], env);
  const pulse = child("/usr/bin/pipewire-pulse", [], env); await waitSocket(join(runtime, "pulse/native"), pulse);
  }
  const pactl = async (args: string[]) => (await execute("/usr/bin/pactl", args, { env, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;
  const sourceNames = async () => (await pactl(["list", "short", "sources"])).trim().split("\n").filter(Boolean).map((row) => row.split("\t")[1]);
  assert.ok((await sourceNames()).every((name) => name === "auto_null.monitor"));
  const sink = "openwhisper_owned_dev", source = `${sink}.monitor`;
  const module = (await pactl(["load-module", "module-null-sink", `sink_name=${sink}`, "rate=48000", "channels=1"])).trim(); assert.match(module, /^\d+$/u);
  await pactl(["set-default-sink", sink]); await pactl(["set-default-source", source]);
  await until(async () => JSON.stringify(await sourceNames()) === JSON.stringify([source]));
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  if (!stockKde) {
  const xvfb = child("/usr/bin/Xvfb", ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], env, true);
  const display = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("OWNED_DISPLAY_UNAVAILABLE")), 10_000); let value = "";
    xvfb.child.stderr?.on("data", (bytes: Buffer) => { diagnostics.stderrBytes += bytes.length; });
    const pipe = xvfb.child.stdio[3]; assert.ok(pipe && "on" in pipe);
    pipe.on("data", (bytes: Buffer) => { value += bytes.toString(); if (/^\d+\n$/u.test(value)) { clearTimeout(timer); accept(`:${value.trim()}`); } });
  });
  env.DISPLAY = display;
  }
  const ownedInnerXwaylandEnvironment = async () => {
    await checkpoint("owned-inner-xwayland-ownership");
    assert.equal(stockKde, true);
    const environmentFile = env.WF_OWNED_XWAYLAND_ENV_FILE;
    assert.ok(environmentFile && environmentFile === resolve(environmentFile));
    await until(async () => {
      try { const value = await lstat(environmentFile); return value.isFile() && value.size > 0; }
      catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    });
    const fileStat = await lstat(environmentFile), directoryStat = await lstat(dirname(environmentFile));
    assert.ok(fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.size <= 4096);
    assert.equal(fileStat.uid, 1000);
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink());
    assert.equal(directoryStat.uid, 1000); assert.equal(directoryStat.mode & 0o077, 0);
    const inner = z.strictObject({ DISPLAY: z.string().regex(/^:\d+$/u), XAUTHORITY: z.string().max(4096).nullable(),
      WAYLAND_DISPLAY: z.literal("openwhisper-owned") }).parse(JSON.parse(await readFile(environmentFile, "utf8")));
    assert.notEqual(inner.DISPLAY, env.DISPLAY);
    const socket = await lstat(join("/tmp/.X11-unix", `X${inner.DISPLAY.slice(1)}`));
    assert.ok(socket.isSocket()); assert.equal(socket.uid, 1000);
    const authority = inner.XAUTHORITY ?? "";
    if (authority) {
      assert.equal(authority, resolve(authority));
      const authStat = await lstat(authority);
      assert.ok(authStat.isFile() && !authStat.isSymbolicLink()); assert.equal(authStat.uid, 1000);
    }
    const innerEnvironment = { ...env, DISPLAY: inner.DISPLAY, XAUTHORITY: authority };
    // Wake KWin's lazy inner server through an inert connection, never input.
    await execute("/usr/bin/xwininfo", ["-root"], { env: innerEnvironment, timeout: 3000, maxBuffer: 16_384 });
    const daemonCall = async (method: string, argument: string) =>
      (await execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
        "--method", `org.freedesktop.DBus.${method}`, argument], { env, timeout: 3000, maxBuffer: 4096 })).stdout.trim();
    const ownerReply = /^\('(:\d+\.\d+)',\)$/u.exec(await daemonCall("GetNameOwner", "org.kde.KWin"));
    assert.ok(ownerReply); const kwinOwner = ownerReply[1]!;
    const pidReply = /^\((?:uint32 )?([1-9]\d*),\)$/u.exec(await daemonCall("GetConnectionUnixProcessID", kwinOwner));
    assert.ok(pidReply); const kwinPid = Number(pidReply[1]);
    assert.ok(Number.isSafeInteger(kwinPid) && kwinPid <= 2_147_483_647);
    const pending = [kwinPid], seen = new Set<number>();
    let xwayland: { pid: number; argv: string[] } | undefined;
    while (pending.length && seen.size < 64) {
      const current = pending.pop()!; if (seen.has(current)) continue; seen.add(current);
      const proc = `/proc/${current}`;
      try {
        assert.equal((await lstat(proc)).uid, 1000);
        const argv = (await readFile(`${proc}/cmdline`, "utf8")).split("\0");
        assert.equal(argv.pop(), "");
        if (argv[0] && basename(argv[0]) === "Xwayland" && argv.includes(inner.DISPLAY)) {
          xwayland = { pid: current, argv }; break;
        }
        const children = (await readFile(`${proc}/task/${current}/children`, "utf8")).trim();
        for (const value of children ? children.split(/\s+/u) : []) {
          assert.match(value, /^[1-9]\d*$/u); const childPid = Number(value);
          assert.ok(Number.isSafeInteger(childPid) && childPid <= 2_147_483_647); pending.push(childPid);
        }
      } catch (error: unknown) {
        if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ESRCH")) throw error;
      }
    }
    assert.ok(xwayland && xwayland.pid !== kwinPid, "Inner display must belong to an actual owned KWin descendant Xwayland");
    const authFlags = xwayland.argv.map((value, index) => value === "-auth" ? index : -1).filter((index) => index !== -1);
    if (authority) {
      assert.equal(authFlags.length, 1); assert.equal(xwayland.argv[authFlags[0]! + 1], authority);
    } else assert.equal(authFlags.length, 0, "Inner Xwayland must not require an unrecorded cookie");
    assert.equal(await daemonCall("GetNameOwner", "org.kde.KWin"), `('${kwinOwner}',)`);
    await writeFile(join(evidence, "inner-xwayland-ownership.json"), JSON.stringify({ uid: 1000, kwinPid, xwaylandPid: xwayland.pid,
      display: inner.DISPLAY, xauthority: authority, ownerStable: true, descendantsInspected: seen.size }, null, 2), { mode: 0o600 });
    return innerEnvironment;
  };
  // Only the explicit overlay test uses inner Xwayland; owned F8 injection keeps the outer display.
  const applicationEnvironment = kdeOverlay ? await ownedInnerXwaylandEnvironment() : env;
  await checkpoint("launch-normal-application");
  const launchApplication = async () => {
  appCloseObserved = false;
  const startupWatch = setTimeout(() => {
    // Capture only owned process/resource metadata when bootstrap stalls, never argv or content.
    void Promise.all([execute("/bin/ps", ["-eo", "pid,ppid,comm,stat"], { env, timeout: 5000, maxBuffer: 65_536 }),
      readFile("/sys/fs/cgroup/pids.current", "utf8"), readFile("/sys/fs/cgroup/pids.max", "utf8"), readFile("/sys/fs/cgroup/memory.events", "utf8")])
      .then(([processes, pids, maximum, memory]) => writeFile(join(evidence, "startup-resources.json"),
        JSON.stringify({ processes: processes.stdout, pids, maximum, memory }), { mode: 0o600 })).catch(() => {});
  }, 10_000);
  try {
    application = await _electron.launch({ executablePath: join(packageRoot, "node_modules/electron/dist/electron"),
      args: [packageRoot, "--dev", "--dev-profile", profileRoot,
        ...(stockKde ? [kdeOverlay ? "--ozone-platform=x11" : "--ozone-platform=wayland"] : [])],
      env: applicationEnvironment, chromiumSandbox: true, timeout: 30_000 });
  } finally { clearTimeout(startupWatch); }
  const original = application.process();
  const owner = { original, closed: Promise.resolve(), closeObserved: false, termination: null as "quit" | "crash" | null };
  original.stdout?.on("data", (bytes: Buffer) => { diagnostics.stdoutBytes += bytes.length; });
  owner.closed = new Promise<void>((accept) => original.once("close", () => { owner.closeObserved = true; appCloseObserved = true; accept(); }));
  appOwners.push(owner); appOriginalClose = owner.closed;
  original.stderr?.on("data", (bytes: Buffer) => { diagnostics.stderrBytes += bytes.length; });
  page = await application.firstWindow();
  await expect(page.locator(".sidebar-brand strong")).toHaveText("OpenWhisper Dev");
  assert.equal(page.url(), "app://openwhisper/index.html");
  };
  await launchApplication();
  assert.ok(application && page);
  if (stockKde) await writeFile(join(evidence, "window.json"), JSON.stringify(await application.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window?.isVisible(), loading: window?.webContents.isLoading(), gpu: app.getGPUFeatureStatus() };
  })), { mode: 0o600 });
  await expect(page.locator(".sidebar-brand strong")).toHaveText("OpenWhisper Dev");
  assert.equal(page.url(), "app://openwhisper/index.html");
  const firstSources = await state();
  await writeFile(join(evidence, "initial-source-enumeration.json"), JSON.stringify({ count: firstSources.microphones.length,
    fixturePresent: firstSources.microphones.includes(source) }), { mode: 0o600 });
  if (!firstSources.microphones.includes(source)) await page.evaluate(() => window.openwhisper?.invoke("refresh_microphones", {}));
  await until(async () => (await state()).microphones.includes(source));
  await checkpoint("initial-state-and-zero-streams");
  const initial = await state(); assert.equal(initial.profile, "development"); assert.equal(initial.recording_available, true);
  const control = async (action?: "start" | "stop" | "cancel") => {
    const reply = await execute("/usr/bin/dbus-send", ["--session", "--type=method_call", "--print-reply",
      "--dest=io.github.whisperfree.dev.Control", "/io/github/whisperfree/dev/Control",
      `io.github.whisperfree.Control1.${action ? "Execute" : "Status"}`, ...(action ? [`string:${action}`] : [])],
    { env, timeout: 10_000, maxBuffer: 4096 });
    const value = /string "(idle|recording|transcribing|unavailable)"/u.exec(reply.stdout)?.[1];
    assert.ok(value, "Owned control must return only its finite status."); return value;
  };
  assert.equal(await control(), "idle");
  assert.deepEqual(initial.installed, ["tiny"]); assert.equal(initial.preferences.gpu, false); assert.equal(initial.preferences.output, "clipboard");
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "", "Initialization and enumeration must open no recording stream.");
  await checkpoint("actual-ui-complete-setup");
  if (stockKde) await page.screenshot({ path: join(evidence, "initial-ui.png"), timeout: 5000 });
  await page.locator('[data-command="complete_setup"]').click();
  await page.locator('[data-tab="general"]').click();
  await checkpoint("actual-ui-language");
  await page.locator('[data-pref="language"]').selectOption("en");
  await until(async () => (await state()).preferences.language === "en");
  await checkpoint("renderer-security");
  const security = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; if (!window) throw new Error("MISSING_WINDOW");
    const rendererPid = window.webContents.getOSProcessId();
    return { rendererPid, pid: process.pid, uid: process.getuid?.() };
  });
  assert.equal(security.uid, 1000);
  // Electron's ProcessMetric.sandboxed is documented only for Darwin/Windows.
  // Retain the actual Linux renderer process and inspect its kernel isolation.
  const rendererStatus = await readFile(`/proc/${security.rendererPid}/status`, "utf8");
  const rendererArguments = (await readFile(`/proc/${security.rendererPid}/cmdline`, "utf8")).split("\0");
  assert.match(rendererStatus, /^NoNewPrivs:\s+1$/mu); assert.match(rendererStatus, /^Seccomp:\s+2$/mu);
  assert.match(rendererStatus, /^Seccomp_filters:\s+[2-9]\d*$/mu); assert.match(rendererStatus, /^NSpid:\s+\d+\s+\d+/mu);
  assert.match(rendererStatus, /^CapEff:\s+0+$/mu); assert.match(rendererStatus, /^Uid:\s+1000\s+1000\s+1000\s+1000$/mu);
  assert.equal(rendererArguments.some((argument) => argument.includes("no-sandbox")), false);
  assert.match(rendererArguments.join(" "), /(?:^|\s)--type=renderer(?:\s|$)/u);
  assert.match(rendererArguments.join(" "), /(?:^|\s)--enable-sandbox(?:\s|$)/u);
  assert.deepEqual(await page.evaluate(() => ({ process: "process" in globalThis, require: "require" in globalThis,
    bridge: typeof window.openwhisper?.invoke })), { process: false, require: false, bridge: "function" });
  checks.push("normal main/shared UI/preload; private Tiny inventory; enumeration with zero streams; sandboxed renderer");
  await checkpoint("owned-portal-cancel-and-retry");
  assert.equal((await state()).shortcut_portal, true); assert.equal((await state()).shortcut, null);
  const stockKey = async (down: boolean) => {
    assert.equal(stockKde, true); assert.match(env.DISPLAY ?? "", /^:\d+$/u);
    await execute("/usr/bin/xdotool", [down ? "keydown" : "keyup", "F8"], { env, timeout: 3000 });
    await delay(60);
  };
  const stockPress = async () => { await stockKey(true); await stockKey(false); };
  if (stockKde) {
    assert.equal((await state()).native_shortcuts, true);
    await checkpoint("owned-outer-window");
    const tree = (await execute("/usr/bin/xwininfo", ["-root", "-tree"], { env, timeout: 3000 })).stdout;
    await writeFile(join(evidence, "owned-outer-windows.txt"), tree, { mode: 0o600 });
    const windows = [...tree.matchAll(/^\s+(0x[0-9a-f]+)\s+.+\s1100x750[+-]\d+[+-]\d+/gmu)].map((match) => match[1]!);
    assert.equal(windows.length, 1, "The private outer display must contain exactly one nested KWin surface");
    await execute("/usr/bin/xdotool", ["windowfocus", "--sync", windows[0]!], { env, timeout: 3000 });
    assert.ok(tree.includes("Press right control key to grab input"));
    await execute("/usr/bin/xdotool", ["mousemove", "--window", windows[0]!, "550", "375"], { env, timeout: 3000 });
    await execute("/usr/bin/xdotool", ["key", "Control_R"], { env, timeout: 3000 });
    await delay(150);
    await writeFile(join(evidence, "owned-outer-after-grab.txt"),
      (await execute("/usr/bin/xwininfo", ["-root", "-tree"], { env, timeout: 3000 })).stdout, { mode: 0o600 });
    await execute("/usr/bin/xdotool", ["mousemove", "--window", windows[0]!, "550", "35", "click", "1"], { env, timeout: 3000 });
    await writeFile(join(evidence, "owned-app-focus.json"), JSON.stringify(await application.evaluate(({ BrowserWindow }) =>
      ({ focused: BrowserWindow.getAllWindows()[0]?.isFocused() }))), { mode: 0o600 });
    await checkpoint("actual-kde-key-capture");
    await page.locator('[data-portal="enable_shortcut"]').click();
    await until(async () => !!(await state()).recording_shortcut);
    await stockPress();
    const selectedState = await state();
    await writeFile(join(evidence, "owned-key-capture-state.json"), JSON.stringify({ capturing: selectedState.recording_shortcut,
      configuring: selectedState.shortcut_configuring, label: selectedState.shortcut, resultMessage: selectedState.message }), { mode: 0o600 });
    await until(async () => (await state()).shortcut === "F8" && !(await state()).shortcut_configuring);
    await until(async () => (await state()).preferences.native_trigger?.kind === "key");
    assert.equal((await state()).status, "idle");
    await page.screenshot({ path: join(evidence, "stock-shortcut.png") });
    const settled = await state();
    await writeFile(join(evidence, "stock-shortcut.json"), JSON.stringify({ available: settled.shortcut_portal,
      label: settled.shortcut, message: settled.message }), { mode: 0o600 });
    checks.push("explicit normal-UI F8 capture from owned outer XTEST; confirmed stock KGlobalAccel binding; no portal signal injection");
    await page.locator('[data-portal="enable_shortcut"]').click();
    await until(async () => !!(await state()).recording_shortcut);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await until(async () => !(await state()).recording_shortcut);
    assert.equal((await state()).shortcut, "F8");
    if (kdeOverlay) {
      const mainUrl = "app://openwhisper/index.html", overlayUrl = `${mainUrl}?overlay=1`;
      await checkpoint("actual-overlay-default-hidden");
      assert.equal((await state()).overlay_available, true);
      assert.equal((await state()).preferences.show_idle_overlay, false);
      let overlayPage: Page | undefined;
      await until(async () => {
        overlayPage = application!.windows().find((candidate) => candidate.url() === overlayUrl);
        return overlayPage !== undefined;
      });
      assert.ok(overlayPage); const overlay = overlayPage;
      const windowState = () => application!.evaluate(({ BrowserWindow }, urls) => {
        const main = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === urls.main);
        const floating = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === urls.overlay);
        if (!main || !floating) throw new Error("OWNED_OVERLAY_WINDOW_MISSING");
        return { mainFocused: main.isFocused(), mainVisible: main.isVisible(), overlayFocused: floating.isFocused(),
          overlayVisible: floating.isVisible(), overlayFocusable: floating.isFocusable(), overlayRendererPid: floating.webContents.getOSProcessId() };
      }, { main: mainUrl, overlay: overlayUrl });
      await application.evaluate(({ BrowserWindow }, url) => {
        const main = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url);
        if (!main) throw new Error("OWNED_MAIN_WINDOW_MISSING"); main.focus();
      }, mainUrl);
      await until(async () => (await windowState()).mainFocused);
      const hidden = await windowState();
      assert.equal(hidden.mainVisible, true); assert.equal(hidden.overlayVisible, false);
      assert.equal(hidden.overlayFocusable, false); assert.equal(hidden.overlayFocused, false);
      const overlayStatus = await readFile(`/proc/${hidden.overlayRendererPid}/status`, "utf8");
      const overlayArguments = (await readFile(`/proc/${hidden.overlayRendererPid}/cmdline`, "utf8")).split("\0");
      assert.match(overlayStatus, /^NoNewPrivs:\s+1$/mu); assert.match(overlayStatus, /^Seccomp:\s+2$/mu);
      assert.match(overlayStatus, /^Seccomp_filters:\s+[2-9]\d*$/mu); assert.match(overlayStatus, /^NSpid:\s+\d+\s+\d+/mu);
      assert.match(overlayStatus, /^CapEff:\s+0+$/mu); assert.match(overlayStatus, /^Uid:\s+1000\s+1000\s+1000\s+1000$/mu);
      assert.equal(overlayArguments.some((argument) => argument.includes("no-sandbox")), false);
      assert.match(overlayArguments.join(" "), /(?:^|\s)--type=renderer(?:\s|$)/u);
      assert.match(overlayArguments.join(" "), /(?:^|\s)--enable-sandbox(?:\s|$)/u);
      assert.deepEqual(await overlay.evaluate(() => ({ process: "process" in globalThis, require: "require" in globalThis,
        bridge: typeof window.openwhisper?.invoke })), { process: false, require: false, bridge: "function" });
      const overlayState = async () => validateCommandOutput("get_state", await overlay.evaluate(() => window.openwhisper?.invoke("get_state", {})));
      const assertFocusRetained = async () => {
        const current = await windowState();
        assert.equal(current.mainFocused, true); assert.equal(current.overlayFocused, false); assert.equal(current.overlayFocusable, false);
        return current;
      };
      assert.equal((await overlayState()).status, "idle");
      checks.push("trusted actual overlay is hidden by default; sandbox/context isolation and Linux kernel renderer isolation; no renderer Node API");

      await checkpoint("actual-overlay-idle-preference");
      await page.locator('[data-pref="show_idle_overlay"]').check();
      await until(async () => (await state()).preferences.show_idle_overlay === true && (await windowState()).overlayVisible);
      await assertFocusRetained();
      await expect(overlay.locator("#record-control")).toHaveAttribute("data-status", "idle");
      assert.equal(await overlay.evaluate(async () => {
        try { await window.openwhisper?.invoke("save_preferences", { changes: { show_idle_overlay: false } }); return null; }
        catch (error: unknown) { return error instanceof Error ? error.message : null; }
      }), "This action is not available from this window.");
      assert.equal((await state()).preferences.show_idle_overlay, true);
      assert.equal((await windowState()).overlayVisible, true);
      await overlay.screenshot({ path: join(evidence, "overlay-idle.png"), timeout: 5000 });
      checks.push("shared-UI idle-overlay preference shows the real nonfocusable window without taking main focus; overlay preference mutation refused");

      await checkpoint("actual-f8-overlay-cancel");
      await stockPress();
      await until(async () => (await state()).status === "recording" && (await overlayState()).status === "recording");
      await expect(overlay.locator("#record-control")).toHaveAttribute("data-status", "recording");
      await until(async () => (await pactl(["list", "short", "source-outputs"])).trim().split("\n").filter(Boolean).length === 1);
      await assertFocusRetained();
      assert.equal(await control(), "recording");
      await overlay.screenshot({ path: join(evidence, "overlay-recording.png"), timeout: 5000 });
      await expect(overlay.locator("#cancel")).toBeVisible();
      const cancelRect = await overlay.locator("#cancel").evaluate((button) => {
        if (!(button instanceof HTMLButtonElement) || button.disabled || button.hidden) throw new Error("OWNED_OVERLAY_CANCEL_UNAVAILABLE");
        const rect = button.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const overlayBounds = await application.evaluate(({ BrowserWindow }, url) => {
        const floating = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url);
        if (!floating) throw new Error("OWNED_OVERLAY_WINDOW_MISSING"); return floating.getBounds();
      }, overlayUrl);
      assert.ok(Object.values(cancelRect).every(Number.isFinite));
      assert.ok(cancelRect.width > 0 && cancelRect.height > 0 && cancelRect.x >= 0 && cancelRect.y >= 0);
      assert.ok(cancelRect.x + cancelRect.width <= overlayBounds.width && cancelRect.y + cancelRect.height <= overlayBounds.height);
      const cancelPoint = { x: Math.round(overlayBounds.x + cancelRect.x + cancelRect.width / 2),
        y: Math.round(overlayBounds.y + cancelRect.y + cancelRect.height / 2) };
      assert.ok(cancelPoint.x >= 0 && cancelPoint.x < 1100 && cancelPoint.y >= 0 && cancelPoint.y < 750,
        "Overlay Cancel must lie inside the already verified owned KWin viewport");
      await writeFile(join(evidence, "overlay-cancel-pointer.json"), JSON.stringify({ overlayBounds, cancelRect, cancelPoint,
        outerWindow: windows[0]!, route: "OWNED_OUTER_XTEST_CANCEL" }, null, 2), { mode: 0o600 });
      // The unchanged outer DISPLAY routes actual XTEST input through the already grabbed private KWin surface.
      await execute("/usr/bin/xdotool", ["mousemove", "--sync", "--window", windows[0]!, String(cancelPoint.x), String(cancelPoint.y), "click", "1"],
        { env, timeout: 3000, maxBuffer: 4096 });
      await until(async () => (await state()).status === "idle" && (await overlayState()).status === "idle");
      assert.equal(await control(), "idle");
      assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
      assert.deepEqual(await readdir(profile.paths.recovery), []);
      assert.equal((await state()).recovery_available, false);
      await assertFocusRetained();
      checks.push("actual stock F8 opens one private capture; main/control/overlay mirror that owner; actual owned outer XTEST pointer Cancel closes its stream without recovery or focus change");

      await checkpoint("actual-overlay-idle-hidden-again");
      await page.locator('[data-pref="show_idle_overlay"]').uncheck();
      await until(async () => (await state()).preferences.show_idle_overlay === false && !(await windowState()).overlayVisible);
      await assertFocusRetained();
      const maps = await readFile(`/proc/${security.pid}/maps`, "utf8");
      assert.equal(maps.includes("openwhisper_capture.node"), false); assert.equal(maps.includes("openwhisper_speech.node"), false);
      assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
      checks.push("turning off the idle preference hides the actual idle overlay; main remains focused and usable; stable sentinel unchanged");

      await checkpoint("graceful-normal-quit-after-overlay");
      const owner = appOwners.at(-1)!; owner.termination = "quit";
      const closing = application.close().then(() => owner.closed); void closing.catch(() => {});
      let closeTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closing, new Promise<never>((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error("OWNED_APP_CLOSE_TIMEOUT")), 10_000);
        })]);
      } finally { if (closeTimer) clearTimeout(closeTimer); }
      assert.equal(owner.closeObserved, true); assert.equal(overlay.isClosed(), true); application = undefined;
      const resources = await recordResources("resources.json");
      assert.match(resources["pids.events"] ?? "", /(?:^|\n)max 0(?:\n|$)/u);
      assert.equal(resources["pids.max"]?.trim(), "256");
      for (const field of ["oom", "oom_kill"]) assert.match(resources["memory.events"] ?? "", new RegExp(`(?:^|\\n)${field} 0(?:\\n|$)`, "u"));
      await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", checks,
        applicationBackend: "XWAYLAND",
        overlayUrl, defaultHidden: true, idlePreferenceVisibility: true, focusRetained: true, preferenceMutationRefused: true,
        overlaySandbox: true, privateCaptureCancelled: true, originalApplicationClosed: true, nativeInMain: false,
        overlayInput: "OWNED_OUTER_XTEST_CANCEL", hotkeys: "OWNED_STOCK_KDE_KGLOBALACCEL_KEY_EDGES", stableSentinelUnchanged: true,
        physicalMicrophone: "NOT_USED", desktop: "OWNED_STOCK_KDE", recognition: "NOT_TESTED", automaticPaste: "NOT_TESTED" }, null, 2), { mode: 0o600 });
      status = "PASS"; return;
    }
    if (kdePaste) {
      await checkpoint("actual-keyboard-session-allow");
      await until(async () => (await state()).paste_portal);
      assert.equal((await state()).paste_ready, false);
      await page.locator('[data-portal="enable_paste"]').click();
      await until(async () => (await state()).paste_ready && !(await state()).paste_configuring, 20_000);
      await page.evaluate(() => window.openwhisper?.invoke("save_preferences", { changes: { output: "paste" } }));
      await until(async () => (await state()).preferences.output === "paste");
      checks.push("explicit shared-UI Allow grants the actual stock KDE keyboard-only session; legacy immediate grant, dialog denial not established");

      const ownedRuntime = env.XDG_RUNTIME_DIR!;
      assert.equal(env.WF_OWNED_DESKTOP_TEST, ownedRuntime);
      assert.equal(env.PULSE_SERVER, `unix:${ownedRuntime}/pulse/native`);
      assert.ok(env.DBUS_SESSION_BUS_ADDRESS?.startsWith(`unix:path=${ownedRuntime}/session-bus`));
      assert.ok(env.AT_SPI_BUS_ADDRESS?.startsWith(`unix:path=${ownedRuntime}/accessibility-bus`));
      const runtimeStat = await lstat(ownedRuntime);
      assert.equal(runtimeStat.uid, 1000); assert.equal(runtimeStat.mode & 0o077, 0);
      assert.equal(env.WAYLAND_DISPLAY, "openwhisper-owned");
      const targetHelper = join(payload, "test-owned-portals.py"), focusScript = join(payload, "focus-target.js");
      for (const path of [targetHelper, focusScript]) {
        const value = await lstat(path); assert.ok(value.isFile() && !value.isSymbolicLink());
      }
      const targetBackend = kdeXwaylandPaste ? "XWAYLAND" : "WAYLAND";
      let targetEnvironment = { ...env, GDK_BACKEND: "wayland" };
      if (kdeXwaylandPaste) {
        targetEnvironment = { ...await ownedInnerXwaylandEnvironment(), GDK_BACKEND: "x11" };
      }
      const pasted = join(root, kdeXwaylandPaste ? "pasted-xwayland.txt" : "pasted-wayland.txt");
      await checkpoint(kdeXwaylandPaste ? "owned-inner-xwayland-target" : "owned-native-wayland-target");
      const target = child("/usr/bin/python3", [targetHelper, "--typing-target", pasted], targetEnvironment);
      await until(async () => {
        assert.equal(target.closeObserved, false);
        try { const value = await lstat(pasted); return value.isFile() && value.uid === 1000 && !(value.mode & 0o077); }
        catch { return false; }
      });
      assert.equal(await readFile(pasted, "utf8"), "");
      await delay(250);
      const kwinCall = async (objectPath: string, method: string, args: string[] = []) =>
        (await execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.kde.KWin", "--object-path", objectPath,
          "--method", method, ...args], { env, timeout: 3000, maxBuffer: 16_384 })).stdout.trim();
      const scriptName = "openwhisper-owned-paste-focus";
      const loaded = /^\((?:int32 )?(\d+),\)$/u.exec(await kwinCall("/Scripting", "org.kde.kwin.Scripting.loadScript", [focusScript, scriptName]));
      assert.ok(loaded); const scriptNumber = Number(loaded[1]);
      assert.ok(Number.isSafeInteger(scriptNumber) && scriptNumber >= 0 && scriptNumber <= 2_147_483_647);
      try {
        let scriptPath: string | undefined;
        for (const candidate of [`/Scripting/Script${scriptNumber}`, `/${scriptNumber}`]) {
          try {
            const xml = await kwinCall(candidate, "org.freedesktop.DBus.Introspectable.Introspect");
            if (xml.includes('name="org.kde.kwin.Script"')) { scriptPath = candidate; break; }
          } catch (error: unknown) {
            if (!(error instanceof Error) || !error.message.includes("UnknownObject")) throw error;
          }
        }
        assert.ok(scriptPath, "Owned KWin must expose its loaded script");
        await kwinCall(scriptPath, "org.kde.kwin.Script.run");
      } finally { await kwinCall("/Scripting", "org.kde.kwin.Scripting.unloadScript", [scriptName]); }
      await until(async () => {
        assert.equal(target.closeObserved, false);
        return application!.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0]?.isFocused());
      });
      await delay(150);

      await checkpoint("actual-f8-start-with-target-focus");
      await stockPress(); await until(async () => (await state()).status === "recording");
      await until(async () => (await pactl(["list", "short", "source-outputs"])).trim().split("\n").filter(Boolean).length === 1);
      assert.deepEqual(await sourceNames(), [source]);
      const publicSpeech = await readFile(join(payload, "fixtures/jfk.f32"));
      assert.equal(publicSpeech.length, 704000); assert.equal(sha(publicSpeech), "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0");
      const audio = Buffer.alloc(publicSpeech.length * 3);
      for (let index = 0; index < publicSpeech.length / 4; index++) for (let repeat = 0; repeat < 3; repeat++)
        audio.writeFloatLE(publicSpeech.readFloatLE(index * 4), (index * 3 + repeat) * 4);
      const audioPath = join(root, "public-generated.f32"); await writeFile(audioPath, audio, { mode: 0o600 });
      await checkpoint("public-fixture-playback-into-private-source");
      await execute("/usr/bin/paplay", ["--raw", "--format=float32le", "--rate=48000", "--channels=1", `--device=${sink}`, audioPath],
        { env, timeout: 30_000, maxBuffer: 1024 });
      await delay(200);
      await checkpoint("actual-f8-stop-and-portal-target-insertion");
      await stockPress();
      await until(async () => {
        assert.equal(target.closeObserved, false);
        const value = await state(); if (value.status === "error") throw new Error("OWNED_TRANSCRIPTION_FAILED");
        return value.status === "done";
      }, 120_000);
      const result = await state(); assert.match(result.transcript.toLowerCase(), /country/u);
      await checkpoint("actual-target-readback");
      await delay(100);
      const targetText = await readFile(pasted, "utf8"), readbackState = await state();
      const applicationClipboardMatches = await application.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, result.transcript);
      let waylandClipboard: { bytes: number; sha256: string; matches: boolean }
        | { failure: "TIMEOUT" | "OUTPUT_LIMIT" | "UNAVAILABLE" | "FAILED" };
      try {
        const reply = await execute("/usr/bin/wl-paste", ["--no-newline"], { env, timeout: 3000, maxBuffer: 1024 * 1024 });
        waylandClipboard = { bytes: Buffer.byteLength(reply.stdout), sha256: sha(Buffer.from(reply.stdout)), matches: reply.stdout === result.transcript };
      } catch (error: unknown) {
        const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
        const killed = error instanceof Error && "killed" in error && error.killed === true;
        waylandClipboard = { failure: killed || code === "ETIMEDOUT" ? "TIMEOUT"
          : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "OUTPUT_LIMIT" : code === "ENOENT" ? "UNAVAILABLE" : "FAILED" };
      }
      await writeFile(join(evidence, kdeXwaylandPaste ? "paste-readback-xwayland.json" : "paste-readback.json"), JSON.stringify({
        expectedLength: Buffer.byteLength(result.transcript), expectedHash: sha(Buffer.from(result.transcript)),
        targetLength: Buffer.byteLength(targetText), targetHash: sha(Buffer.from(targetText)), targetMatches: targetText === result.transcript,
        historyMatches: readbackState.history[0] === result.transcript,
        applicationFocused: await application.evaluate(({ BrowserWindow }) => !!BrowserWindow.getAllWindows()[0]?.isFocused()),
        applicationClipboardMatches, pasteReady: readbackState.paste_ready, pasteConfiguring: readbackState.paste_configuring ?? false,
        output: readbackState.preferences.output, waylandClipboard,
      }, null, 2), { mode: 0o600 });
      await until(async () => await readFile(pasted, "utf8") === result.transcript, 5000);
      await checkpoint("actual-history-readback");
      await until(async () => (await state()).history[0] === result.transcript, 5000);
      await checkpoint("actual-cross-client-clipboard-readback");
      // Background Wayland publication is proved by another client; Electron's
      // local cache read remains diagnostic and cannot substitute for this check.
      assert.ok("matches" in waylandClipboard && waylandClipboard.matches);
      assert.equal(await readFile(pasted, "utf8"), result.transcript);
      assert.equal(result.gpu_available, false); assert.equal(result.preferences.gpu, false); assert.equal(result.recovery_available, false);
      assert.deepEqual(await readdir(profile.paths.recovery), []);
      assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
      const maps = await readFile(`/proc/${security.pid}/maps`, "utf8");
      assert.equal(maps.includes("openwhisper_capture.node"), false); assert.equal(maps.includes("openwhisper_speech.node"), false);
      assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
      checks.push(`real F8 Start/Stop and CPU Tiny recognition; production portal Ctrl+V into owned GTK ${targetBackend} target equals private Wayland clipboard and history; recovery removed`);

      await checkpoint("actual-keyboard-session-revoke");
      await page.evaluate(() => window.openwhisper?.invoke("disable_paste", {}));
      await until(async () => !(await state()).paste_ready && !(await state()).paste_configuring);
      assert.equal((await state()).paste_ready, false);
      await checkpoint("graceful-normal-quit-after-paste");
      const owner = appOwners.at(-1)!; owner.termination = "quit";
      const closing = application.close().then(() => owner.closed); void closing.catch(() => {});
      let closeTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([closing, new Promise<never>((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error("OWNED_APP_CLOSE_TIMEOUT")), 10_000);
        })]);
      } finally { if (closeTimer) clearTimeout(closeTimer); }
      assert.equal(owner.closeObserved, true); application = undefined;
      const resources = await recordResources("resources.json");
      assert.match(resources["pids.events"] ?? "", /(?:^|\n)max 0(?:\n|$)/u);
      assert.equal(resources["pids.max"]?.trim(), "256");
      for (const field of ["oom", "oom_kill"]) assert.match(resources["memory.events"] ?? "", new RegExp(`(?:^|\\n)${field} 0(?:\\n|$)`, "u"));
      await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", clipboardConfirmed: true, recoveryRemoved: true,
        nativeInMain: false, pasteConfirmed: true, permissionRevoked: true, targetBackend, consentMode: "LEGACY_IMMEDIATE_GRANT" }, null, 2), { mode: 0o600 });
      status = "PASS"; return;
    }
    if (kdeLifecycle) {
      const journalPath = join(profile.paths.settings, "kde-keyboard-lease.json");
      const journal = async () => kdeJournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
      const dbusBoolean = async (destination: string, objectPath: string, method: string, args: string[]) => {
        const reply = (await execute("/usr/bin/gdbus", ["call", "--session", "--dest", destination,
          "--object-path", objectPath, "--method", method, ...args], { env, timeout: 3000, maxBuffer: 4096 })).stdout.trim();
        assert.ok(reply === "(true,)" || reply === "(false,)", "The actual daemon must return one boolean");
        return reply === "(true,)";
      };
      const available = () => dbusBoolean("org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel.globalShortcutAvailable",
        ["([16777271, 0, 0, 0],)", ""]);
      const hasOwner = (connection: string) => dbusBoolean("org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus.NameHasOwner", [connection]);
      const quitActive = async () => {
        assert.ok(application); const owner = appOwners.at(-1)!; owner.termination = "quit";
        await application.close(); await owner.closed; assert.equal(owner.closeObserved, true); application = undefined;
        assert.deepEqual(await journal(), []); assert.equal(await available(), true);
      };
      const bindAfterRestart = async () => {
        assert.ok(application && page);
        await checkpoint(`lifecycle-${appOwners.length}-focus-window`);
        await page.locator('[data-tab="general"]').click();
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
        await until(async () => application!.evaluate(({ BrowserWindow }) => !!BrowserWindow.getAllWindows()[0]?.isFocused()));
        await checkpoint(`lifecycle-${appOwners.length}-capture-key`);
        await page.locator('[data-portal="enable_shortcut"]').click();
        await until(async () => !!(await state()).recording_shortcut);
        await stockPress();
        await checkpoint(`lifecycle-${appOwners.length}-await-confirmation`);
        await until(async () => (await state()).shortcut === "F8" && !(await state()).shortcut_configuring);
      };
      const firstLease = await journal(); assert.equal(firstLease.length, 1);
      assert.equal(await available(), false); assert.equal(await hasOwner(firstLease[0]!.connection), true);
      await checkpoint("active-binding-normal-quit"); await quitActive();
      checks.push("normal Quit with active F8 closes the original app, empties its journal and releases the actual KDE key");
      await checkpoint("restart-without-startup-binding"); await launchApplication();
      assert.ok(application && page);
      assert.equal((await state()).shortcut, null); assert.deepEqual(await journal(), []); assert.equal(await available(), true);
      assert.equal((await state()).preferences.native_trigger?.kind, "key");
      await bindAfterRestart();
      const crashedLease = await journal(); assert.equal(crashedLease.length, 1);
      assert.notEqual(crashedLease[0]!.component, firstLease[0]!.component);
      await checkpoint("kill-original-owned-application");
      const crashedOwner = appOwners.at(-1)!; crashedOwner.termination = "crash";
      assert.equal(crashedOwner.original.kill("SIGKILL"), true);
      await until(async () => crashedOwner.closeObserved, 10_000); await crashedOwner.closed; application = undefined;
      await until(async () => !(await hasOwner(crashedLease[0]!.connection)));
      assert.deepEqual(await journal(), crashedLease);
      const availableAfterCrash = await available();
      await writeFile(join(evidence, "crash-readback.json"), JSON.stringify({ originalMainClosed: crashedOwner.closeObserved,
        originalBusOwnerAbsent: true, journalRetained: true, availableAfterCrash }), { mode: 0o600 });
      await checkpoint("restart-preserves-journal-until-explicit-setup"); await launchApplication();
      assert.ok(application && page);
      assert.equal((await state()).shortcut, null); assert.deepEqual(await journal(), crashedLease);
      await bindAfterRestart();
      const recoveredLease = await journal(); assert.equal(recoveredLease.length, 1);
      assert.notEqual(recoveredLease[0]!.component, crashedLease[0]!.component);
      assert.notEqual(recoveredLease[0]!.connection, crashedLease[0]!.connection);
      assert.equal(await hasOwner(recoveredLease[0]!.connection), true); assert.equal(await available(), false);
      await stockPress(); await until(async () => (await state()).status === "recording");
      await page!.locator("#cancel").click(); await until(async () => (await state()).status === "idle");
      assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
      checks.push("SIGKILL of original owned main closes its D-Bus owner; same-profile startup preserves journal without binding; explicit setup recovers a fresh working F8 binding");
      await checkpoint("recovered-active-binding-normal-quit"); await quitActive();
      assert.equal(appOwners.length, 3); assert.ok(appOwners.every((owner) => owner.closeObserved));
      assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
      const resources = await recordResources("resources.json");
      assert.match(resources["pids.events"] ?? "", /(?:^|\n)max 0(?:\n|$)/u);
      assert.equal(resources["pids.max"]?.trim(), "256");
      await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", checks, activeBindingQuit: true, crashRecovery: true,
        originalApplicationCloses: appOwners.map((owner) => ({ closed: owner.closeObserved, termination: owner.termination })),
        availableAfterCrash, recordingAfterRecovery: true, stableSentinelUnchanged: true,
        physicalMicrophone: "NOT_USED", desktop: "OWNED_STOCK_KDE", recognition: "NOT_TESTED", automaticPaste: "NOT_TESTED" }, null, 2), { mode: 0o600 });
      status = "PASS"; return;
    }
    await checkpoint("actual-kde-hold-stale-release");
    await page.evaluate(() => window.openwhisper?.invoke("save_preferences", { changes: { hold_to_record: true } }));
    await stockKey(true); await until(async () => (await state()).status === "recording");
    await page.locator("#cancel").click(); await until(async () => (await state()).status === "idle");
    await page.locator("#record").click(); await until(async () => (await state()).status === "recording");
    await stockKey(false); await delay(150); assert.equal((await state()).status, "recording");
    assert.equal(await control("cancel"), "idle"); await until(async () => (await state()).status === "idle");
    await page.evaluate(() => window.openwhisper?.invoke("save_preferences", { changes: { hold_to_record: false } }));
    checks.push("actual stock F8 hold acquisition; GUI Cancel; release cannot stop a later GUI recording; command Cancel");
  } else {
  await portal("PortalMode", "pending"); await page.locator('[data-portal="enable_shortcut"]').click();
  await until(async () => !!(await state()).shortcut_configuring);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await until(async () => !(await state()).shortcut_configuring && (await state()).shortcut === null);
  assert.match(await portal("PortalStatus"), /uint32 0/u);
  await portal("PortalMode", "grant"); await page.locator('[data-portal="enable_shortcut"]').click();
  await until(async () => (await state()).shortcut === "Ctrl+Alt+Space");
  await portal("Press"); await until(async () => (await state()).status === "recording");
  await portal("End"); await until(async () => (await state()).status === "idle" && (await state()).shortcut === null && !(await state()).shortcut_configuring);
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), ""); assert.match(await portal("PortalStatus"), /uint32 0/u);
  await page.evaluate(() => window.openwhisper?.invoke("save_preferences", { changes: { hold_to_record: true } }));
  await page.locator('[data-portal="enable_shortcut"]').click(); await until(async () => (await state()).shortcut === "Ctrl+Alt+Space");
  await portal("Press"); await until(async () => (await state()).status === "recording");
  await portal("Unassign"); await until(async () => (await state()).status === "idle" && (await state()).shortcut === null && !(await state()).shortcut_configuring);
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), ""); assert.match(await portal("PortalStatus"), /uint32 0/u);
  await page.evaluate(() => window.openwhisper?.invoke("save_preferences", { changes: { hold_to_record: false } }));
  checks.push("actual native D-Bus portal protocol: cancelled pending consent, explicit retry, granted binding, session loss and hold binding revoke close only the original private capture");
  }
  await checkpoint("actual-ui-cancel");
  await page.locator("#record").click(); await until(async () => (await state()).status === "recording");
  await page.locator("#cancel").click(); await until(async () => (await state()).status === "idle");
  assert.equal((await state()).recovery_available, false); assert.deepEqual(await readdir(profile.paths.recovery), []);
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  checks.push("actual UI Cancel closes the original capture without recovery");
  await checkpoint("actual-command-start-ui-cancel");
  assert.equal(await control("start"), "recording"); await until(async () => (await state()).status === "recording");
  assert.equal(await control(), "recording");
  await page.locator("#cancel").click(); await until(async () => (await state()).status === "idle");
  await page.locator("#record").click(); await until(async () => (await state()).status === "recording");
  assert.equal(await control("cancel"), "idle"); await until(async () => (await state()).status === "idle");
  assert.equal(await control("start"), "recording"); await until(async () => (await state()).status === "recording");
  assert.equal(await control("cancel"), "idle"); await until(async () => (await state()).status === "idle");
  assert.deepEqual(await readdir(profile.paths.recovery), []);
  checks.push("private command Start and GUI Cancel; later GUI Start and command Cancel share exact owners");
  await checkpoint("actual-ui-start");
  if (stockKde) await stockPress();
  else {
    await page.locator('[data-portal="enable_shortcut"]').click(); await until(async () => (await state()).shortcut === "Ctrl+Alt+Space");
    await portal("Press"); await portal("Release");
  }
  await until(async () => (await state()).status === "recording");
  await until(async () => (await pactl(["list", "short", "source-outputs"])).trim().split("\n").filter(Boolean).length === 1);
  assert.deepEqual(await sourceNames(), [source]);
  const publicSpeech = await readFile(join(payload, "fixtures/jfk.f32"));
  assert.equal(publicSpeech.length, 704000); assert.equal(sha(publicSpeech), "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0");
  const audio = Buffer.alloc(publicSpeech.length * 3);
  for (let index = 0; index < publicSpeech.length / 4; index++) for (let repeat = 0; repeat < 3; repeat++) audio.writeFloatLE(publicSpeech.readFloatLE(index * 4), (index * 3 + repeat) * 4);
  const audioPath = join(root, "public-generated.f32"); await writeFile(audioPath, audio, { mode: 0o600 });
  await checkpoint("public-fixture-playback");
  await execute("/usr/bin/paplay", ["--raw", "--format=float32le", "--rate=48000", "--channels=1", `--device=${sink}`, audioPath], { env, timeout: 30_000, maxBuffer: 1024 });
  await delay(200);
  await checkpoint("actual-ui-stop");
  if (stockKde) await stockPress(); else await portal("Press");
  await until(async () => {
    const value = await state();
    if (value.status === "error") throw new Error("OWNED_TRANSCRIPTION_FAILED");
    return value.status === "done";
  }, 120_000);
  const result = await state(); assert.match(result.transcript.toLowerCase(), /country/u);
  assert.equal(result.gpu_available, false); assert.equal(result.preferences.gpu, false); assert.equal(result.recovery_available, false);
  assert.equal(await application.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, result.transcript), true);
  await until(async () => (await state()).history[0] === result.transcript);
  assert.deepEqual(await readdir(profile.paths.recovery), []);
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
  const maps = await readFile(`/proc/${security.pid}/maps`, "utf8");
  assert.equal(maps.includes("openwhisper_capture.node"), false); assert.equal(maps.includes("openwhisper_speech.node"), false);
  checks.push(`${stockKde ? "actual stock KGlobalAccel F8" : "actual owned portal"} Start/Stop; real CPU Tiny recognition; private clipboard exact readback; history confirmation; recovery removal; native capture/speech absent from main`);
  if (stockKde) await page.evaluate(() => window.openwhisper?.invoke("clear_shortcut", {}));
  else await page.locator('[data-portal="clear_shortcut"]').click();
  await until(async () => (await state()).shortcut === null && !(await state()).shortcut_configuring);
  if (stockKde) {
    assert.deepEqual(JSON.parse(await readFile(join(profile.paths.settings, "kde-keyboard-lease.json"), "utf8")), []);
    await stockPress(); await delay(150); assert.equal((await state()).status, "done");
    checks.push("Remove trigger empties the private recovery journal and actual F8 no longer starts capture");
  }
  if (!stockKde) assert.match(await portal("PortalStatus"), /uint32 0/u);
  await checkpoint("actual-source-loss-retry");
  await expect(page.locator("#record-label")).toHaveText("Start dictation");
  await page.locator("#record").click(); await until(async () => (await state()).status === "recording");
  await until(async () => (await pactl(["list", "short", "source-outputs"])).trim().split("\n").filter(Boolean).length === 1);
  await checkpoint("retry-case-second-capture-running");
  await execute("/usr/bin/paplay", ["--raw", "--format=float32le", "--rate=48000", "--channels=1", `--device=${sink}`, audioPath], { env, timeout: 30_000, maxBuffer: 1024 });
  await checkpoint("retry-case-owned-source-loss");
  await pactl(["unload-module", module]); await delay(250);
  // Device loss can already trigger the coordinator's failed stop. Do not
  // accidentally click a newly relabelled Retry button as if it were Stop.
  if ((await state()).status === "recording") {
    await expect(page.locator("#record-label")).toContainText("Recording"); await page.locator("#record").click();
  }
  await checkpoint("retry-case-await-private-backup");
  await until(async () => (await state()).status === "error" && !!(await state()).recovery_available && !(await page!.locator("#record").isDisabled()));
  const retained = (await readdir(profile.paths.recovery)).filter((name) => /^recording-.+\.wav$/u.test(name)); assert.equal(retained.length, 1);
  const retainedName = retained[0]; assert.ok(retainedName);
  const backup = await lstat(join(profile.paths.recovery, retainedName)); assert.equal(backup.uid, 1000); assert.equal(backup.mode & 0o777, 0o600);
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  await expect(page.locator("#record-label")).toHaveText("Retry transcription");
  await checkpoint("retry-case-actual-ui-retry");
  await page.locator("#record").click(); await until(async () => (await state()).status === "done", 120_000);
  const retried = await state(); assert.match(retried.transcript.toLowerCase(), /country/u);
  assert.equal(await application.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, retried.transcript), true);
  assert.deepEqual(await readdir(profile.paths.recovery), []); assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  checks.push("actual selected-source loss; Stop retains private WAV; actual Retry performs real CPU inference without reopening capture and confirms private clipboard before WAV deletion");
  await checkpoint("actual-source-loss-discard");
  const secondModule = (await pactl(["load-module", "module-null-sink", `sink_name=${sink}`, "rate=48000", "channels=1"])).trim(); assert.match(secondModule, /^\d+$/u);
  await pactl(["set-default-sink", sink]); await pactl(["set-default-source", source]);
  await until(async () => JSON.stringify(await sourceNames()) === JSON.stringify([source]));
  await expect(page.locator("#record-label")).toHaveText("Start dictation");
  await page.locator("#record").click(); await until(async () => (await state()).status === "recording");
  await until(async () => (await pactl(["list", "short", "source-outputs"])).trim().split("\n").filter(Boolean).length === 1);
  const fragment = join(root, "public-fragment.f32"); await writeFile(fragment, audio.subarray(0, 48000 * 4), { mode: 0o600 });
  await execute("/usr/bin/paplay", ["--raw", "--format=float32le", "--rate=48000", "--channels=1", `--device=${sink}`, fragment], { env, timeout: 10_000, maxBuffer: 1024 });
  await pactl(["unload-module", secondModule]); await delay(250);
  if ((await state()).status === "recording") {
    await expect(page.locator("#record-label")).toContainText("Recording"); await page.locator("#record").click();
  }
  await until(async () => (await state()).status === "error" && !!(await state()).recovery_available && !(await page!.locator("#cancel").isHidden()));
  assert.equal((await readdir(profile.paths.recovery)).filter((name) => name.endsWith(".wav")).length, 1);
  await page.locator("#cancel").click(); await until(async () => (await state()).status === "idle" && !(await state()).recovery_available);
  assert.deepEqual(await readdir(profile.paths.recovery), []); assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  checks.push("actual Discard removes retained private WAV and releases failed capture ownership");
  if (stockKde) {
    const resources = await recordResources("resources.json");
    assert.match(resources["pids.events"] ?? "", /(?:^|\n)max 0(?:\n|$)/u);
    assert.equal(resources["pids.max"]?.trim(), "256");
  }
  await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", checks, architecture: process.arch, uid: process.getuid?.(),
    transcriptCharacters: result.transcript.length, transcriptSha256: sha(Buffer.from(result.transcript)), countryRecognized: true,
    clipboardConfirmed: true, historyConfirmed: true, recoveryRemoved: true, cancelConfirmed: true, retryConfirmed: true, discardConfirmed: true,
    nativeInMain: false, security,
    sourceScope: "owned-generated-PipeWire-Pulse-monitor-only", fixtureSha256: sha(publicSpeech),
    physicalMicrophone: "NOT_USED", hotkeys: stockKde ? "OWNED_STOCK_KDE_KGLOBALACCEL_KEY_EDGES" : "OWNED_SYNTHETIC_PORTAL_SIGNALS_ONLY", portalResourcesClosed: true,
    automaticPaste: "NOT_TESTED", gpu: "NOT_TESTED", macos: "NOT_TESTED" }, null, 2), { mode: 0o600 });
  await checkpoint("graceful-normal-quit");
  await application.close(); await appOriginalClose; application = undefined; status = "PASS";
}
try { await main(); } catch (error: unknown) {
  failure = { name: error instanceof Error ? error.name : "UNKNOWN",
    location: error instanceof Error ? error.stack?.split("\n").find((line) => line.includes("file:///payload/driver.mjs:"))?.trim() ?? null : null };
  process.exitCode = 1;
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ stage, lastState, failure }), { mode: 0o600 });
  if (stockKde) await recordResources("failure-resources.json");
  if (page && stockKde) {
    try {
      const controls = await page.locator("button").evaluateAll((buttons) => buttons.slice(0, 40).map((button) => ({
        command: button.getAttribute("data-command"), tab: button.getAttribute("data-tab"), label: button.textContent?.slice(0, 80),
        disabled: button instanceof HTMLButtonElement && button.disabled, visible: button.getClientRects().length > 0 })));
      await writeFile(join(evidence, "failure-controls.json"), JSON.stringify(controls), { mode: 0o600 });
      await page.screenshot({ path: join(evidence, "failure.png"), timeout: 5000 });
    } catch { /* Keep teardown independent of renderer diagnostics. */ }
  }
}
finally {
  let appClosed = application === undefined;
  let forcedAppTermination = false;
  if (application) {
    const original = application.process();
    let timer: NodeJS.Timeout | undefined;
    const closing = application.close().then(() => appOriginalClose); void closing.catch(() => {});
    try {
      await Promise.race([closing, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OWNED_APP_CLOSE_TIMEOUT")), 10_000); })]);
      appClosed = appCloseObserved;
    } catch {
      forcedAppTermination = true; original.kill("SIGKILL");
      if (timer) clearTimeout(timer);
      try { await Promise.race([appOriginalClose, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OWNED_APP_EXIT_MISSING")), 5000); })]);
        appClosed = appCloseObserved; } catch {}
    } finally { if (timer) clearTimeout(timer); }
  }
  for (const owner of owners.toReversed()) {
    if (!owner.closeObserved) owner.child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([owner.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => { owner.child.kill("SIGKILL"); reject(new Error("OWNED_CLOSE_TIMEOUT")); }, 5000); })]); } catch { process.exitCode = 1; }
    finally { if (timer) clearTimeout(timer); }
  }
  await writeFile(join(evidence, "lifecycle.json"), JSON.stringify({ status, stage, checks, lastState, failure, appClosed, forcedAppTermination,
    serverClosesObserved: owners.every((owner) => owner.closeObserved), diagnostics }), { mode: 0o600 });
  if (status !== "PASS" || !appClosed || !owners.every((owner) => owner.closeObserved)) process.exitCode = 1;
}

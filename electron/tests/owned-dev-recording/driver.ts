import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { z } from "zod";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/profiles.js";
import { resolveStableProfile } from "../../src/services/stable-profile.js";
import { recoveryWavHeader } from "../../src/workers/recovery.js";
import { validateCommandOutput } from "../../src/contracts/ui.js";
import type { DesktopBridge } from "../../src/contracts/bridge.js";
import { recordingHostErrorSchema } from "../../src/workers/recording-host-protocol.js";
import { kdeJournalSchema } from "../../src/platforms/linux/kde/keyboard.js";
import { parseApplicationBuildModule } from "../../src/contracts/build-identity.js";
import { parseControlStatus, type ControlWireStatus } from "../../src/platforms/linux/shared/control-status.js";
import { controlTarget } from "../../src/platforms/linux/shared/control-identity.js";
import type { ControlCommand, ControlAction } from "../../src/cli/arguments.js";

declare global { interface Window { openwhisper?: DesktopBridge } }
const execute = promisify(execFile);
const payload = resolve(fileURLToPath(new URL("./", import.meta.url)));
const packaged = process.env.OPENWHISPER_PACKAGE_DIRECTORY === "/payload/package";
const stablePackage = process.env.OPENWHISPER_STABLE_PACKAGE === "1";
const installedDebian = process.env.OPENWHISPER_INSTALLED_DEBIAN === "1";
const sourcePackageRoot = packaged ? "/payload/package/resources/app" : join(payload, "app"), evidence = "/evidence";
const sourceExecutable = packaged ? `/payload/package/${stablePackage ? "openwhisper" : "openwhisper-dev"}` : join(sourcePackageRoot, "node_modules/electron/dist/electron");
let packageRoot = installedDebian ? "/opt/openwhisper/resources/app" : sourcePackageRoot;
let executable = installedDebian ? "/opt/openwhisper/openwhisper" : sourceExecutable;
const installPackage = process.env.OPENWHISPER_INSTALL_PACKAGE === "1";
const stockKde = process.env.OPENWHISPER_STOCK_KDE === "1";
const kdeLifecycle = process.env.OPENWHISPER_KDE_LIFECYCLE === "1";
const kdeOverlay = process.env.OPENWHISPER_KDE_OVERLAY === "1";
const kdeWaylandOverlay = process.env.OPENWHISPER_KDE_WAYLAND_OVERLAY === "1";
const kdeXwaylandPaste = process.env.OPENWHISPER_KDE_PASTE === "xwayland";
const kdePaste = process.env.OPENWHISPER_KDE_PASTE === "wayland" || kdeXwaylandPaste;
const nativeX11 = process.env.OPENWHISPER_NATIVE_X11 === "1";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const checks: string[] = [];
let stage = "guard", status = "FAIL", application: ElectronApplication | undefined, page: Page | undefined;
let failure: { name: string; location: string | null } | undefined;
let appCloseObserved = false, appOriginalClose: Promise<void> | undefined;
const appOwners: { original: ChildProcess; closed: Promise<void>; closeObserved: boolean; termination: "quit" | "crash" | null;
  quitEvents: ("before-quit" | "will-quit")[] }[] = [];
let lastState: Readonly<{ status: string; recordingAvailable: boolean; recoveryAvailable: boolean; elapsed: number; progress: number;
  messageCategory: "NONE" | "RECORDING_ERROR" | "ACTION_REFUSED" | "OTHER"; recordingError: string | null }> | undefined;
const owners: { child: ChildProcess; closed: Promise<void>; closeObserved: boolean }[] = [];
const surfaceFailureSchema = z.enum(["startup-timeout", "image-size", "png-size", "invalid-reply", "frame-mismatch", "frame-timeout",
  "renderer-regions", "helper-exit", "helper-error", "native-message", "native-frame", "native-visibility", "native-pump", "native-close"]);
const sourceDiscoveryFailureSchema = z.strictObject({
  stage: z.enum(["checked-pulse", "artifact", "allocation-fork", "spawn-ready", "native-query", "retirement", "discovery"]),
  code: z.union([recordingHostErrorSchema, z.literal("INTEGRITY_FAILED"), z.literal("FAILED")]),
});
const diagnostics: { stdoutBytes: number; stderrBytes: number; surfaceFailures: z.infer<typeof surfaceFailureSchema>[];
  sourceDiscoveryFailures: z.infer<typeof sourceDiscoveryFailureSchema>[];
  surfaceDimensions: { width: number; height: number }[] } =
  { stdoutBytes: 0, stderrBytes: 0, surfaceFailures: [], sourceDiscoveryFailures: [], surfaceDimensions: [] };
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
async function assertInstalledPackage(source = "/payload/package", installed = "/opt/openwhisper"): Promise<void> {
  const expected = await lstat(source), actual = await lstat(installed);
  assert.equal(actual.isSymbolicLink(), false); assert.equal(actual.uid, 0); assert.equal(actual.mode & 0o7777, expected.mode & 0o7777);
  assert.equal(actual.isDirectory(), expected.isDirectory()); assert.equal(actual.isFile(), expected.isFile());
  if (expected.isDirectory()) {
    const entries = (await readdir(source)).sort(); assert.deepEqual((await readdir(installed)).sort(), entries);
    for (const name of entries) await assertInstalledPackage(join(source, name), join(installed, name));
  } else { assert.equal(expected.isFile(), true); assert.equal(sha(await readFile(installed)), sha(await readFile(source))); }
}
async function main(): Promise<void> {
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64"); assert.equal(process.getuid?.(), 1000);
  assert.equal(process.versions.node, "24.21.0");
  assert.equal(sha(await readFile(process.execPath)), "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c");
  assert.equal(sha(await readFile(executable)), "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564");
  assert.equal(process.env.OPENWHISPER_OWNED_DEV_RECORDING, "1");
  if (kdeLifecycle) assert.equal(stockKde, true);
  if (process.env.OPENWHISPER_KDE_PASTE !== undefined) {
    assert.equal(kdePaste, true); assert.equal(stockKde, true); assert.equal(kdeLifecycle, false);
  }
  if (process.env.OPENWHISPER_KDE_OVERLAY !== undefined) {
    assert.equal(kdeOverlay, true); assert.equal(stockKde, true);
    assert.equal(kdeLifecycle, false); assert.equal(kdePaste, false);
  }
  if (process.env.OPENWHISPER_KDE_WAYLAND_OVERLAY !== undefined) {
    assert.equal(kdeWaylandOverlay, true); assert.equal(stockKde, true); assert.equal(kdeOverlay, false);
    assert.equal(kdeLifecycle, false); assert.equal(kdePaste, false);
  }
  if (process.env.OPENWHISPER_NATIVE_X11 !== undefined) {
    assert.equal(nativeX11, true); assert.equal(stockKde, false);
    assert.equal(kdeLifecycle || kdePaste || kdeOverlay || kdeWaylandOverlay, false);
  }
  if (process.env.OPENWHISPER_PACKAGE_DIRECTORY !== undefined) { assert.equal(packaged, true); assert.equal(nativeX11, true); }
  if (process.env.OPENWHISPER_INSTALL_PACKAGE !== undefined) { assert.equal(installPackage, true); assert.equal(packaged, true); assert.equal(nativeX11, true); }
  if (process.env.OPENWHISPER_STABLE_PACKAGE !== undefined) { assert.equal(stablePackage, true); assert.equal(packaged && nativeX11, true); assert.equal(installPackage, false); }
  if (process.env.OPENWHISPER_INSTALLED_DEBIAN !== undefined) {
    assert.equal(installedDebian, true); assert.equal(stablePackage && packaged && nativeX11, true); assert.equal(installPackage, false);
    await assertInstalledPackage();
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
  if (installedDebian) { env.XDG_CONFIG_DIRS = join(home, "system-config"); await mkdir(env.XDG_CONFIG_DIRS, { mode: 0o700 }); }
  const profileRoot = join(installPackage ? home : root, "dev-profile");
  const stable = join(env.XDG_DATA_HOME!, "whisperfree"); await mkdir(stable, { mode: 0o700 });
  await writeFile(join(stable, "sentinel"), "Owned stable sentinel", { mode: 0o600 });
  const stableBefore = sha(await readFile(join(stable, "sentinel")));
  let installation: { installationRoot: string; application: string; executable: string; profile: string; desktopFile: string;
    sourceDigest: string; version: string; source: { commit: string; modified: boolean }; launchArguments: string[];
    embeddedNode: true; profileInitiallyAbsent: true; descriptorPreserved: true; existingDestinationRefused: boolean;
    originalApplicationAlive: boolean; stableSentinelUnchanged: boolean } | undefined;
  const installationRoot = join(home, "Install Slot"), desktopFile = join(env.XDG_DATA_HOME!, "applications/io.github.whisperfree.dev.desktop");
  const installerArguments = [join(sourcePackageRoot, "dist/cli/install-dev.js"), "--source", "/payload/package", "--installation-root", installationRoot,
    "--profile", profileRoot, "--desktop-file", desktopFile];
  const installerEnvironment = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  let installedDescriptor: string | undefined, installedExecutable: string | undefined, installedDesktop: string | undefined;
  if (installPackage) {
    await checkpoint("install-fresh-owned-package");
    await mkdir(dirname(desktopFile), { mode: 0o700 });
    await assert.rejects(lstat(profileRoot), { code: "ENOENT" });
    const installed = await execute(sourceExecutable, installerArguments, { env: installerEnvironment, timeout: 90_000, maxBuffer: 65_536 });
    assert.equal(installed.stderr, "");
    const result = z.object({ installationRoot: z.literal(installationRoot), application: z.literal(join(installationRoot, "OpenWhisper-Dev-Linux-x64")),
      executable: z.literal(join(installationRoot, "OpenWhisper-Dev-Linux-x64/openwhisper-dev")), profile: z.literal(profileRoot), desktopFile: z.literal(desktopFile),
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u), version: z.string().regex(/^\d+\.\d+\.\d+$/u),
      source: z.object({ commit: z.union([z.string().regex(/^[a-f0-9]{40}$/u), z.literal("source")]), modified: z.boolean() }),
      launchArguments: z.tuple([z.literal("--dev-profile"), z.literal(profileRoot)]) }).parse(JSON.parse(installed.stdout));
    await assert.rejects(lstat(profileRoot), { code: "ENOENT" });
    executable = result.executable; packageRoot = join(result.application, "resources/app");
    installedDescriptor = sha(await readFile(join(packageRoot, "dist/main/development-recording-build.js")));
    assert.equal(installedDescriptor, sha(await readFile(join(sourcePackageRoot, "dist/main/development-recording-build.js"))));
    installedExecutable = sha(await readFile(executable)); assert.equal(installedExecutable, sha(await readFile(sourceExecutable)));
    installedDesktop = sha(await readFile(desktopFile));
    assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
    installation = { ...result, embeddedNode: true, profileInitiallyAbsent: true, descriptorPreserved: true,
      existingDestinationRefused: false, originalApplicationAlive: false, stableSentinelUnchanged: false };
    checks.push("packaged embedded Node installs a fresh owned Dev directory and launcher without creating its profile; captured descriptor/source executable preserved");
  }
  const profile = stablePackage ? resolveStableProfile({ home, platform: "linux", configHome: config, dataHome: env.XDG_DATA_HOME, cacheHome: env.XDG_CACHE_HOME })
    : prepareDevelopmentProfile(resolveDevelopmentProfile({ home, configHome: config, dataHome: env.XDG_DATA_HOME, cacheHome: env.XDG_CACHE_HOME, explicitRoot: profileRoot }));
  const model = await readFile(join(payload, "fixtures/ggml-tiny.bin"));
  assert.equal(model.length, 77691713); assert.equal(sha(model), "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21");
  if (stablePackage) await mkdir(profile.paths.models, { recursive: true, mode: 0o755 });
  const modelPath = join(profile.paths.models, "ggml-tiny.bin");
  await copyFile(join(payload, "fixtures/ggml-tiny.bin"), modelPath); await chmod(modelPath, stablePackage ? 0o644 : 0o600);
  const modelIdentity = await lstat(modelPath), legacyHistory = ["Owned legacy history"];
  const devSentinel = join(config, "io.github.whisperfree.dev/sentinel"), originals: Record<string, string> = {};
  if (stablePackage) {
    assert.equal("legacy" in profile, true); if (!("legacy" in profile)) throw new Error("MISSING_STABLE_PROFILE");
    await mkdir(profile.legacy.recovery!, { recursive: true, mode: 0o700 });
    const publicBytes = await readFile(join(payload, "fixtures/jfk.f32"));
    assert.equal(publicBytes.length, 704000); assert.equal(sha(publicBytes), "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0");
    const paths = [profile.legacy.settings, profile.legacy.history, join(profile.legacy.recovery!, "recording-00000001791410537123-12345678-1234-4567-8123-123456789abc.wav")];
    await writeFile(paths[0]!, JSON.stringify({ ui_language: "en", setup_completed: true, model: "tiny", language: "en", output: "clipboard",
      gpu: true, gpu_configured: true, keep_history: true, launch_at_login: installedDebian, auto_check_updates: false }), { mode: 0o600 });
    await writeFile(paths[1]!, JSON.stringify(legacyHistory), { mode: 0o600 });
    await writeFile(paths[2]!, Buffer.concat([recoveryWavHeader(BigInt(publicBytes.length / 4)), publicBytes]), { mode: 0o600 });
    await mkdir(dirname(devSentinel), { recursive: true, mode: 0o700 }); await writeFile(devSentinel, "Owned separate Dev sentinel", { mode: 0o600 });
    for (const path of [...paths, devSentinel]) originals[path] = sha(await readFile(path));
    if (installedDebian) {
      const devAutostart = join(home, "dev-config/autostart/io.github.whisperfree.dev.desktop");
      await mkdir(dirname(devAutostart), { recursive: true, mode: 0o700 });
      await writeFile(devAutostart, "Owned separate Dev autostart sentinel", { mode: 0o600 }); originals[devAutostart] = sha(await readFile(devAutostart));
    }
    await assert.rejects(lstat(dirname(profile.paths.settings)), { code: "ENOENT" });
    checks.push("private legacy settings/history, Tiny0644 and pinned JFK WAV seeded before ordinary stable startup; config/electron remains absent; separate Dev sentinel");
  }
  const assertStableOriginals = async () => {
    for (const [path, expected] of Object.entries(originals)) assert.equal(sha(await readFile(path)), expected);
    const current = await lstat(modelPath); assert.equal(current.dev, modelIdentity.dev); assert.equal(current.ino, modelIdentity.ino);
    assert.equal(current.mode & 0o777, stablePackage ? 0o644 : 0o600); assert.equal(sha(await readFile(modelPath)), sha(model));
  };
  const autostartPath = join(config, "autostart/io.github.whisperfree.desktop");
  const enabledAutostart = "[Desktop Entry]\nType=Application\nName=OpenWhisper\nComment=Free, local dictation\nExec=\"/opt/openwhisper/openwhisper\"\nIcon=io.github.whisperfree\nStartupWMClass=io.github.whisperfree\nTerminal=false\n";
  const disabledAutostart = "[Desktop Entry]\nType=Application\nName=OpenWhisper\nHidden=true\n";
  let enabledAutostartIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  let generatedExecRestart = false, startupAutostartReadOnly = false, uiEnableDisableVerified = false;
  const persistedLogin = async () => z.object({ launch_at_login: z.boolean() })
    .parse(JSON.parse(await readFile(join(profile.paths.settings, "preferences.json"), "utf8"))).launch_at_login;
  const assertAutostart = async (enabled: boolean) => {
    const file = await lstat(autostartPath), parent = await lstat(dirname(autostartPath));
    assert.equal(file.isFile() && !file.isSymbolicLink(), true); assert.equal(file.uid, 1000); assert.equal(file.mode & 0o7777, 0o600);
    assert.equal(parent.isDirectory() && !parent.isSymbolicLink(), true); assert.equal(parent.uid, 1000); assert.equal(parent.mode & 0o7777, 0o700);
    assert.equal(await readFile(autostartPath, "utf8"), enabled ? enabledAutostart : disabledAutostart);
    assert.equal(await persistedLogin(), enabled);
    if (enabled && enabledAutostartIdentity) { assert.equal(file.dev, enabledAutostartIdentity.dev); assert.equal(file.ino, enabledAutostartIdentity.ino);
      assert.equal(file.mtimeMs, enabledAutostartIdentity.mtimeMs); assert.equal(file.ctimeMs, enabledAutostartIdentity.ctimeMs); }
    await assertStableOriginals();
  };
  const focusRefresh = async () => {
    assert.ok(application); await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; if (!window) throw new Error("MISSING_WINDOW"); window.blur(); window.focus();
    }); await delay(200);
  };
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
  if (!nativeX11) {
  const portalBinary = join(payload, "owned-bus/owned-portal");
  const portalOwner = child(portalBinary, [env.DBUS_SESSION_BUS_ADDRESS!], env);
  await until(async () => {
    assert.equal(portalOwner.closeObserved, false);
    return (await execute("/usr/bin/dbus-send", ["--session", "--type=method_call", "--print-reply", "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.portal.Desktop"], { env, timeout: 5000, maxBuffer: 8192 })).stdout.includes("boolean true");
  });
  }
  }
  const portal = async (member: "PortalMode" | "PortalStatus" | "Press" | "Release" | "Unassign" | "End", mode?: "grant" | "pending" | "deny") => {
    assert.equal(stockKde, false, "Stock desktop checks must never inject fixture portal signals.");
    assert.equal(nativeX11, false, "Native X11 checks must never inject fixture portal signals.");
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
    application = await _electron.launch({ executablePath: executable,
      args: [...(packaged ? [] : [packageRoot]), ...(stablePackage ? [] : ["--dev", "--dev-profile", profileRoot]),
        ...(kdeWaylandOverlay ? ["--experimental-wayland-overlay"] : []),
        ...(stockKde ? [kdeOverlay ? "--ozone-platform=x11" : "--ozone-platform=wayland"] : nativeX11 ? ["--ozone-platform=x11"] : [])],
      env: applicationEnvironment, chromiumSandbox: true, timeout: 30_000 });
  } finally { clearTimeout(startupWatch); }
  const original = application.process();
  const owner = { original, closed: Promise.resolve(), closeObserved: false, termination: null as "quit" | "crash" | null,
    quitEvents: [] as ("before-quit" | "will-quit")[] };
  original.stdout?.on("data", (bytes: Buffer) => { diagnostics.stdoutBytes += bytes.length; });
  owner.closed = new Promise<void>((accept) => original.once("close", () => { owner.closeObserved = true; appCloseObserved = true; accept(); }));
  appOwners.push(owner); appOriginalClose = owner.closed;
  let diagnosticLine = "", diagnosticOverflow = false;
  original.stderr?.on("data", (bytes: Buffer) => {
    diagnostics.stderrBytes += bytes.length;
    for (const character of bytes.toString("utf8")) {
      if (character === "\n") {
        const quitEvent = !diagnosticOverflow ? /^OpenWhisper owned quit event: (before-quit|will-quit)\r?$/u.exec(diagnosticLine)?.[1] : undefined;
        if ((quitEvent === "before-quit" || quitEvent === "will-quit") && owner.quitEvents.length < 4) owner.quitEvents.push(quitEvent);
        if (!diagnosticOverflow && diagnostics.sourceDiscoveryFailures.length < 16) {
          const match = /^OpenWhisper capture source discovery failed: stage=([a-z-]+) code=([A-Z_]+)\r?$/u.exec(diagnosticLine);
          const category = sourceDiscoveryFailureSchema.safeParse(match ? { stage: match[1], code: match[2] } : undefined);
          if (category.success) diagnostics.sourceDiscoveryFailures.push(category.data);
        }
        if (!diagnosticOverflow && diagnostics.surfaceFailures.length < 16) {
          const category = surfaceFailureSchema.safeParse(/^OpenWhisper Wayland overlay failed: ([a-z-]+)\r?$/u.exec(diagnosticLine)?.[1]);
          if (category.success) diagnostics.surfaceFailures.push(category.data);
        }
        if (!diagnosticOverflow && diagnostics.surfaceDimensions.length < 4) {
          const dimensions = /^OpenWhisper Wayland overlay image dimensions: (\d{1,4})x(\d{1,4})\r?$/u.exec(diagnosticLine);
          if (dimensions && Number(dimensions[1]) <= 8192 && Number(dimensions[2]) <= 8192) {
            diagnostics.surfaceDimensions.push({ width: Number(dimensions[1]), height: Number(dimensions[2]) });
          }
        }
        diagnosticLine = ""; diagnosticOverflow = false;
      } else if (!diagnosticOverflow) {
        if (diagnosticLine.length >= 256) { diagnosticLine = ""; diagnosticOverflow = true; }
        else diagnosticLine += character;
      }
    }
  });
  await application.evaluate(({ app }) => {
    app.on("before-quit", () => console.error("OpenWhisper owned quit event: before-quit"));
    app.on("will-quit", () => console.error("OpenWhisper owned quit event: will-quit"));
  });
  page = await application.firstWindow();
  await expect(page.locator(".sidebar-brand strong")).toHaveText(stablePackage ? "OpenWhisper" : "OpenWhisper Dev");
  assert.equal(page.url(), "app://openwhisper/index.html");
  if (stablePackage) {
    const actual = await application.evaluate(({ app }) => ({ name: app.getName(), path: app.getAppPath(), executable: process.execPath,
      packaged: app.isPackaged, userData: app.getPath("userData"), session: app.getPath("sessionData"), argv: process.argv }));
    assert.equal(actual.name, "OpenWhisper"); assert.equal(actual.path, packageRoot); assert.equal(actual.executable, executable); assert.equal(actual.packaged, true);
    assert.equal(actual.userData, dirname(profile.paths.settings)); assert.equal(actual.session, profile.paths.session);
    assert.equal(actual.argv.some((argument) => argument === "--dev" || argument.startsWith("--dev-profile")), false);
    await writeFile(join(evidence, "stable-application.json"), JSON.stringify({ ...actual, argv: undefined }), { mode: 0o600 });
  }
  return { application, page };
  };
  await launchApplication();
  assert.ok(application && page);
  if (packaged) {
    const actual = await application.evaluate(({ app }) => ({ path: app.getAppPath(), packaged: app.isPackaged, executable: process.execPath }));
    await writeFile(join(evidence, "packaged-application.json"), JSON.stringify(actual), { mode: 0o600 });
    assert.equal(actual.path, packageRoot); assert.equal(actual.packaged, true); assert.equal(actual.executable, executable);
    checks.push(`actual packaged ${stablePackage ? "openwhisper" : "openwhisper-dev"} executes its own resources/app with unchanged captured descriptor/native inputs; test dependencies separate`);
  }
  if (stockKde) await writeFile(join(evidence, "window.json"), JSON.stringify(await application.evaluate(({ BrowserWindow, app }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window?.isVisible(), loading: window?.webContents.isLoading(), gpu: app.getGPUFeatureStatus() };
  })), { mode: 0o600 });
  await expect(page.locator(".sidebar-brand strong")).toHaveText(stablePackage ? "OpenWhisper" : "OpenWhisper Dev");
  assert.equal(page.url(), "app://openwhisper/index.html");
  const firstSources = await state();
  await writeFile(join(evidence, "initial-source-enumeration.json"), JSON.stringify({ count: firstSources.microphones.length,
    fixturePresent: firstSources.microphones.includes(source) }), { mode: 0o600 });
  if (!firstSources.microphones.includes(source)) await page.evaluate(() => window.openwhisper?.invoke("refresh_microphones", {}));
  await until(async () => (await state()).microphones.includes(source));
  if (stablePackage) await until(async () => !!(await state()).recording_available && !!(await state()).recovery_available);
  await checkpoint("initial-state-and-zero-streams");
  const initial = await state(); assert.equal(initial.profile, stablePackage ? undefined : "development"); assert.equal(initial.recording_available, true);
  if (stablePackage) {
    assert.equal(initial.development_build, undefined); assert.equal(initial.preferences.setup_completed, true);
    assert.deepEqual(initial.history, legacyHistory); assert.equal(initial.recovery_available, true); await assertStableOriginals();
  }
  if (installedDebian) {
    await checkpoint("installed-autostart-read-only-startup");
    assert.equal(initial.launch_at_login_available, true); assert.equal(initial.preferences.launch_at_login, false);
    assert.equal(initial.macos?.launch_at_login_pending ?? false, false); assert.equal(await persistedLogin(), true);
    await assert.rejects(lstat(dirname(autostartPath)), { code: "ENOENT" });
    await focusRefresh(); assert.equal((await state()).preferences.launch_at_login, false); assert.equal(await persistedLogin(), true);
    await assert.rejects(lstat(dirname(autostartPath)), { code: "ENOENT" }); await assertStableOriginals(); startupAutostartReadOnly = true;
    checks.push("installed stable startup/focus exposes actual autostart false while preserving legacy requested true privately; no registration or autostart directory created");
  }
  const capturedControl = packaged ? parseApplicationBuildModule(await readFile(join(packageRoot, "dist/main/application-build.js"), "utf8")) : undefined;
  if (capturedControl) assert.equal(capturedControl.kind, stablePackage ? "stable" : "development");
  const target = controlTarget(capturedControl?.kind ?? "development");
  const controlRoots = ["home", "config", "data", "cache"].map((name) => join(root, `control-${name}`));
  const controlEnvironment: NodeJS.ProcessEnv = { ...env, HOME: controlRoots[0]!, XDG_CONFIG_HOME: controlRoots[1]!,
    XDG_DATA_HOME: controlRoots[2]!, XDG_CACHE_HOME: controlRoots[3]! };
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE",
    "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) delete controlEnvironment[key];
  const commandRecords: { command: ControlCommand; pid: number; seconds: number; exitCode: 0 | 1; closed: true;
    status: string | null; elapsed: string | null; recoveryAvailable: boolean | null }[] = [];
  const assertControlStorage = async () => {
    for (const path of controlRoots.slice(0, 3)) await assert.rejects(lstat(path), { code: "ENOENT" });
    const cachePath = controlRoots[3]!;
    let cache: Awaited<ReturnType<typeof lstat>>;
    try { cache = await lstat(cachePath); } catch (error: unknown) {
      assert.ok(error instanceof Error && "code" in error && error.code === "ENOENT");
      return { protectedProfileAbsent: true, nativeFontCache: "ABSENT", fileCount: 0 } as const;
    }
    assert.ok(cache.isDirectory() && !cache.isSymbolicLink()); assert.equal(cache.uid, 1000); assert.equal(cache.mode & 0o7777, 0o755);
    assert.deepEqual(await readdir(cachePath), ["fontconfig"]);
    const fontsPath = join(cachePath, "fontconfig"), fonts = await lstat(fontsPath);
    assert.ok(fonts.isDirectory() && !fonts.isSymbolicLink()); assert.equal(fonts.uid, 1000); assert.equal(fonts.mode & 0o7777, 0o755);
    const names = await readdir(fontsPath); assert.ok(names.length <= 16);
    for (const name of names) {
      assert.match(name, /^(?:CACHEDIR\.TAG|[a-f0-9]{32}-le64\.cache-11)$/u);
      const file = await lstat(join(fontsPath, name));
      assert.ok(file.isFile() && !file.isSymbolicLink()); assert.equal(file.uid, 1000); assert.equal(file.mode & 0o7777, 0o644);
    }
    return { protectedProfileAbsent: true, nativeFontCache: "OWNED_FONTCONFIG", fileCount: names.length } as const;
  };
  const packageCommand = async (command: ControlCommand, absent = false): Promise<ControlWireStatus | undefined> => {
    assert.ok(packaged && capturedControl);
    assert.equal(basename(executable), capturedControl.kind === "stable" ? "openwhisper" : "openwhisper-dev");
    const before = application ? await application.evaluate(({ BrowserWindow }) => ({ pid: process.pid, windows: BrowserWindow.getAllWindows().length })) : undefined;
    await assertControlStorage();
    const started = performance.now();
    const request = execute(executable, ["--control", command], { env: controlEnvironment, timeout: 8000, maxBuffer: 32 * 1024 });
    const original = request.child, pid = original.pid; assert.ok(pid);
    const owner = { child: original, closed: Promise.resolve(), closeObserved: false };
    owner.closed = new Promise<void>((accept) => original.once("close", () => { owner.closeObserved = true; accept(); })); owners.push(owner);
    const force = setTimeout(() => { original.kill("SIGKILL"); }, 9000);
    let result: ControlWireStatus | undefined;
    try {
      let reply: Awaited<typeof request> | undefined, requestFailure: unknown;
      try { reply = await request; } catch (error: unknown) { requestFailure = error; }
      await owner.closed;
      let pidAbsent = false;
      try { await lstat(`/proc/${pid}`); } catch (error: unknown) {
        pidAbsent = error instanceof Error && "code" in error && error.code === "ENOENT";
      }
      const failedReply = z.object({ stdout: z.string(), stderr: z.string() }).safeParse(requestFailure);
      const stdout = reply?.stdout ?? (failedReply.success ? failedReply.data.stdout : "");
      const stderrText = reply?.stderr ?? (failedReply.success ? failedReply.data.stderr : "");
      let parsed: ControlWireStatus | undefined;
      try { parsed = parseControlStatus(stdout); } catch { /* Record categorical parse outcome, never raw stdout. */ }
      const warnings = [...stderrText.matchAll(/^\[([1-9][0-9]{0,9}):[0-9]{4}\/[0-9]{6}\.[0-9]{6}:ERROR:dbus\/bus\.cc:406\] Failed to connect to the bus: Failed to connect to socket ([^\r\n]{1,4096}): No such file or directory\n/gmu)]
        .filter((warning) => warning[1] === String(pid) && warning[2] === join(runtime, "disabled-system-bus"));
      // Chromium may report our deliberately absent SYSTEM socket before Node;
      // only this original PID, exact owned path and complete fixed line qualify.
      const remainingStderr = warnings.length === 1 ? stderrText.replace(warnings[0]![0], "") : stderrText;
      const stderr = Buffer.from(stderrText), boundedStderr = stderr.subarray(0, 32 * 1024);
      const diagnostic = `cli-diagnostic-${commandRecords.length}-${command}`;
      const storage = await assertControlStorage();
      await writeFile(join(evidence, `${diagnostic}.stderr`), boundedStderr, { mode: 0o600, flag: "wx" });
      await writeFile(join(evidence, `${diagnostic}.json`), JSON.stringify({ command, pid, exitCode: original.exitCode, signal: original.signalCode,
        stderr: { bytes: stderr.length, sha256: sha(stderr), storedBytes: boundedStderr.length, storedSha256: sha(boundedStderr),
          truncated: boundedStderr.length !== stderr.length, file: `${diagnostic}.stderr` },
        allowedSystemBusWarning: { category: warnings.length === 1 ? "OWNED_DISABLED_SYSTEM_BUS" : "NONE",
          count: warnings.length === 1 ? 1 : 0, matchingLines: warnings.length },
        storage,
        strictStdoutParse: parsed !== undefined && stdout.endsWith("\n"), originalCloseObserved: owner.closeObserved, pidAbsent,
        scope: "Private owned container command only; no raw stdout or host inputs." }), { mode: 0o600, flag: "wx" });
      assert.equal(owner.closeObserved, true); assert.equal(pidAbsent, true); assert.ok(warnings.length <= 1);
      if (absent) {
        assert.equal(reply, undefined);
        z.object({ code: z.literal(1), killed: z.literal(false), signal: z.null(), stdout: z.literal(""), stderr: z.string() }).parse(requestFailure);
        assert.equal(remainingStderr, `${capturedControl.productName} is not running in this session. Open the app first.\n`);
      } else {
        assert.ok(reply); assert.equal(remainingStderr, ""); assert.ok(stdout.endsWith("\n")); assert.ok(parsed); result = parsed;
      }
      if (before) {
        assert.ok(application); assert.deepEqual(await application.evaluate(({ BrowserWindow }) => ({ pid: process.pid, windows: BrowserWindow.getAllWindows().length })), before);
        assert.equal(appCloseObserved, false);
      }
      commandRecords.push({ command, pid, seconds: (performance.now() - started) / 1000, exitCode: absent ? 1 : 0, closed: true,
        status: result?.status ?? null, elapsed: result?.elapsed.toString() ?? null, recoveryAvailable: result?.recovery_available ?? null });
      await writeFile(join(evidence, "package-control.json"), JSON.stringify({ identity: capturedControl, executable, endpoint: target, commandRecords,
        noDisplay: true, noNodeModeOrRuntimeOverrides: true, protectedProfileAbsent: true, nativeFontCachePermitted: true,
        scope: "Actual frozen package executable before graphical readiness; private session and virtual audio only." }, null, 2), { mode: 0o600 });
      return result;
    } finally { clearTimeout(force); }
  };
  const control = async (action?: ControlAction) => {
    if (packaged) { const result = await packageCommand(action ?? "status"); assert.ok(result); return result.status; }
    const reply = await execute("/usr/bin/dbus-send", ["--session", "--type=method_call", "--print-reply",
      `--dest=${target.name}`, target.path,
      `io.github.whisperfree.Control1.${action ? "Execute" : "Status"}`, ...(action ? [`string:${action}`] : [])],
    { env, timeout: 10_000, maxBuffer: 4096 });
    const value = /^\s*string "(\{[^\r\n]*\})"\s*$/mu.exec(reply.stdout)?.[1];
    assert.ok(value, "Owned control must return its closed JSON status."); return parseControlStatus(value.replaceAll('\\"', '"')).status;
  };
  const assertNoDevControl = async () => {
    const reply = await execute("/usr/bin/dbus-send", ["--session", "--type=method_call", "--print-reply", "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:io.github.whisperfree.dev.Control"], { env, timeout: 5000, maxBuffer: 4096 });
    assert.match(reply.stdout, /boolean false/u);
  };
  if (stablePackage) { await assertNoDevControl(); assert.equal(await control(), initial.status); }
  else assert.equal(await control(), "idle");
  if (installation) {
    await checkpoint("refuse-existing-owned-installation");
    const original = application.process(), originalPid = original.pid; assert.ok(originalPid);
    await assert.rejects(execute(sourceExecutable, installerArguments, { env: installerEnvironment, timeout: 15_000, maxBuffer: 65_536 }),
      (error: unknown) => z.object({ code: z.literal(1), killed: z.literal(false), signal: z.null(), stdout: z.literal(""),
        stderr: z.string().includes(`A fresh path is required: ${installationRoot}`) }).safeParse(error).success);
    assert.equal(original.exitCode, null); assert.equal(original.signalCode, null); assert.equal(appCloseObserved, false);
    assert.equal(await application.evaluate(() => process.pid), originalPid); assert.equal((await state()).status, "idle");
    assert.equal(await control(), "idle");
    assert.equal(sha(await readFile(executable)), installedExecutable);
    assert.equal(sha(await readFile(join(packageRoot, "dist/main/development-recording-build.js"))), installedDescriptor);
    assert.equal(sha(await readFile(desktopFile)), installedDesktop);
    assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
    installation.existingDestinationRefused = true; installation.originalApplicationAlive = true; installation.stableSentinelUnchanged = true;
    checks.push("repeat installation refuses the existing destination while the original installed app stays idle/alive; installed bytes, launcher and stable sentinel unchanged");
  }
  assert.deepEqual(initial.installed, ["tiny"]); assert.equal(initial.preferences.gpu, stablePackage); assert.equal(initial.preferences.output, "clipboard");
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "", "Initialization and enumeration must open no recording stream.");
  await checkpoint("actual-ui-complete-setup");
  if (stockKde) await page.screenshot({ path: join(evidence, "initial-ui.png"), timeout: 5000 });
  if (!stablePackage) await page.locator('[data-command="complete_setup"]').click();
  await page.locator('[data-tab="general"]').click();
  if (installedDebian) {
    await checkpoint("installed-autostart-ui-enable");
    const checkbox = page.locator('[data-pref="launch_at_login"]'); await expect(checkbox).toBeEnabled(); await expect(checkbox).not.toBeChecked();
    await checkbox.check(); await until(async () => (await state()).preferences.launch_at_login === true && await persistedLogin());
    await assertAutostart(true); enabledAutostartIdentity = await lstat(autostartPath);
    await focusRefresh(); assert.equal((await state()).preferences.launch_at_login, true); await assertAutostart(true);
    checks.push("ordinary shared UI enables the verified private fixed-name desktop entry at the permanent Debian executable; focus/status leave its identity and bytes unchanged");
  }
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
  if (stablePackage) {
    await checkpoint("actual-stable-migrated-recording-retry");
    await expect(page.locator("#record-label")).toHaveText("Retry transcription"); await page.locator("#record").click();
    await until(async () => (await state()).status === "done", 120_000); const retried = await state();
    assert.match(retried.transcript.toLowerCase(), /country/u); assert.equal(retried.preferences.gpu, true); assert.equal(retried.gpu_available, false);
    assert.equal(await application.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, retried.transcript), true);
    assert.equal(retried.history[0], retried.transcript); assert.equal(retried.history.at(-1), legacyHistory[0]);
    assert.equal(retried.recovery_available, false); assert.deepEqual(await readdir(profile.paths.recovery), []);
    assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), ""); await assertStableOriginals(); await assertNoDevControl();
    checks.push("normal stable startup migrates before private paths/services; UI Retry uses in-place Tiny CPU with saved GPU opt-in, clipboard/history and no capture stream; originals retained");
  }
  await checkpoint("owned-portal-cancel-and-retry");
  if (!nativeX11) assert.equal((await state()).shortcut_portal, true);
  assert.equal((await state()).shortcut, null);
  const stockKey = async (down: boolean) => {
    assert.equal(stockKde, true); assert.match(env.DISPLAY ?? "", /^:\d+$/u);
    await execute("/usr/bin/xdotool", [down ? "keydown" : "keyup", "F8"], { env, timeout: 3000 });
    await delay(60);
  };
  const stockPress = async () => { await stockKey(true); await stockKey(false); };
  const nativeKey = async (down: boolean, key: "F8" | "Escape" = "F8") => {
    assert.equal(nativeX11, true); assert.equal(stockKde, false); assert.equal(env.XDG_SESSION_TYPE, "x11");
    assert.match(env.DISPLAY ?? "", /^:\d+$/u); assert.equal(env.WAYLAND_DISPLAY, undefined);
    await execute("/usr/bin/xdotool", [down ? "keydown" : "keyup", key], { env, timeout: 3000, maxBuffer: 4096 });
    await delay(60);
  };
  const nativePress = async (key: "F8" | "Escape" = "F8") => { await nativeKey(true, key); await nativeKey(false, key); };
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
    if (kdeOverlay || kdeWaylandOverlay) {
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
      const outputBounds = kdeWaylandOverlay ? await application.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds) : undefined;
      if (outputBounds) assert.deepEqual(outputBounds, { x: 0, y: 0, width: 1100, height: 750 });
      const surfaceBounds = outputBounds ? { x: outputBounds.x + (outputBounds.width - 360) / 2,
        y: outputBounds.y + outputBounds.height - 24 - 64, width: 360, height: 64 } : undefined;
      let surfacePid: number | undefined;
      if (kdeWaylandOverlay) {
        await until(async () => {
          const metrics = await application!.evaluate(({ app }) => app.getAppMetrics().filter((metric) =>
            metric.type === "Utility" && (metric.name === "OpenWhisper Wayland Recording Surface" || metric.serviceName === "OpenWhisper Wayland Recording Surface")));
          assert.ok(metrics.length <= 1); surfacePid = metrics[0]?.pid; return surfacePid !== undefined;
        });
        assert.ok(surfacePid); assert.equal((await lstat(`/proc/${surfacePid}`)).uid, 1000);
        const maps = await readFile(`/proc/${surfacePid}/maps`, "utf8");
        assert.ok(maps.includes("libgtk-3.so") && maps.includes("libgtk-layer-shell.so"));
        await writeFile(join(evidence, "native-surface-owner.json"), JSON.stringify({ pid: surfacePid, uid: 1000,
          outputBounds, surfaceBounds, serviceName: "OpenWhisper Wayland Recording Surface" }), { mode: 0o600 });
      }
      const nativeScreenshot = async (name: string, matchTrustedFrame = false) => {
        assert.equal(kdeWaylandOverlay, true); assert.ok(outputBounds && surfaceBounds);
        assert.match(env.DISPLAY ?? "", /^:\d+$/u);
        const module: typeof import("koffi") = await import(pathToFileURL(join(packageRoot, "node_modules/koffi/index.js")).href);
        const xlib = module.default.load("libX11.so.6");
        const open: (name: string) => unknown = xlib.func("void *XOpenDisplay(const char *name)");
        const screen: (display: unknown) => number = xlib.func("int XDefaultScreen(void *display)");
        const depth: (display: unknown, screen: number) => number = xlib.func("int XDefaultDepth(void *display, int screen)");
        const get: (display: unknown, window: number, x: number, y: number, width: number, height: number, mask: bigint, format: number) => unknown =
          xlib.func("void *XGetImage(void *display, unsigned long window, int x, int y, unsigned int width, unsigned int height, unsigned long mask, int format)");
        const pixel: (image: unknown, x: number, y: number) => unknown = xlib.func("unsigned long XGetPixel(void *image, int x, int y)");
        const destroy: (image: unknown) => unknown = xlib.func("int XDestroyImage(void *image)");
        const close: (display: unknown) => unknown = xlib.func("int XCloseDisplay(void *display)");
        const display = open(env.DISPLAY!); assert.ok(display);
        let image: unknown;
        try {
          assert.equal(depth(display, screen(display)), 24);
          const window = Number.parseInt(windows[0]!, 16); assert.ok(Number.isSafeInteger(window) && window > 0);
          image = get(display, window, 0, 0, 1100, 750, 0xffffffffffffffffn, 2); assert.ok(image);
          const bitmap = Buffer.alloc(1100 * 750 * 4);
          for (let y = 0; y < 750; y++) for (let x = 0; x < 1100; x++) {
            const value = pixel(image, x, y);
            assert.ok(typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff);
            const offset = (y * 1100 + x) * 4;
            bitmap[offset] = value & 255; bitmap[offset + 1] = value >>> 8 & 255; bitmap[offset + 2] = value >>> 16 & 255; bitmap[offset + 3] = 255;
          }
          const reference = matchTrustedFrame ? await overlay.screenshot({ timeout: 5000 }) : Buffer.alloc(0);
          const rendered = await application!.evaluate(({ nativeImage }, input) => {
            const image = nativeImage.createFromBitmap(Buffer.from(input.bitmap, "base64"), { width: 1100, height: 750 });
            const surface = image.crop(input.bounds);
            return { desktop: Array.from(image.toPNG()), surface: Array.from(surface.toPNG()), bitmap: Array.from(surface.toBitmap()),
              reference: input.reference.length ? Array.from(nativeImage.createFromBuffer(Buffer.from(input.reference, "base64")).toBitmap()) : [] };
          }, { bitmap: bitmap.toString("base64"), bounds: surfaceBounds, reference: reference.toString("base64") });
          await writeFile(join(evidence, name), Buffer.from(rendered.desktop), { mode: 0o600 });
          await writeFile(join(evidence, name.replace(/\.png$/u, "-surface.png")), Buffer.from(rendered.surface), { mode: 0o600 });
          if (matchTrustedFrame) {
            assert.equal(rendered.reference.length, 360 * 64 * 4); assert.equal(rendered.bitmap.length, rendered.reference.length);
            let samples = 0, matched = 0;
            for (let y = 1; y < 63; y++) for (let x = 1; x < 359; x++) {
              const offset = (y * 360 + x) * 4;
              if (rendered.reference[offset + 3] !== 255) continue;
              let solid = true;
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const neighbor = ((y + dy) * 360 + x + dx) * 4;
                for (let channel = 0; channel < 4; channel++) if (rendered.reference[neighbor + channel] !== rendered.reference[offset + channel]) solid = false;
              }
              if (!solid) continue; samples++;
              if ([0, 1, 2].every((channel) => rendered.bitmap[offset + channel] === rendered.reference[offset + channel])) matched++;
            }
            await writeFile(join(evidence, name.replace(/\.png$/u, "-paint-match.json")), JSON.stringify({ samples, matched,
              source: "TRUSTED_OFFSCREEN_RENDERER", target: "ACTUAL_OWNED_KWIN_SURFACE_CROP", minimumRatio: 0.9 }), { mode: 0o600 });
            assert.ok(samples >= 3000 && matched / samples >= 0.9, "Actual native surface must contain the trusted overlay's opaque solid pixels");
          }
          return sha(Buffer.from(rendered.surface));
        } finally {
          try { if (image) destroy(image); } finally { close(display); xlib.unload(); }
        }
      };
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
      let nativeEditor: ReturnType<typeof child> | undefined;
      const editorPath = join(evidence, "native-overlay-editor.txt");
      let expectedEditorText = "";
      const keyboardMarkers = { beforeCancel: "owbeforecancel", afterCancel: "owaftercancel",
        beforeStop: "owbeforestop", afterStop: "owafterstop" } as const;
      const keyboardReceipts: { phase: keyof typeof keyboardMarkers; expectedBytes: number; expectedSha256: string;
        actualBytes: number; actualSha256: string; matches: boolean; mainFocused: boolean; overlayFocused: boolean }[] = [];
      const assertFocusRetained = async () => {
        const current = await windowState();
        // Once the separate editor owns keyboard focus, the main window is
        // expected to be unfocused. Real marker delivery is the decisive gate.
        assert.equal(current.mainFocused, nativeEditor === undefined);
        assert.equal(current.overlayFocused, false); assert.equal(current.overlayFocusable, false);
        return current;
      };
      const verifyEditorKeyboard = async (phase: keyof typeof keyboardMarkers) => {
        assert.ok(nativeEditor); assert.equal(nativeEditor.closeObserved, false);
        await checkpoint(`native-editor-${phase}`);
        const marker = keyboardMarkers[phase]; assert.match(marker, /^[a-z]+$/u);
        expectedEditorText += marker;
        // Control_R above is a complete press/release used only to grab the
        // private outer surface. Clear other modifiers for this fixed marker;
        // never focus a window or send directly to the editor's X11 identity.
        await execute("/usr/bin/xdotool", ["type", "--clearmodifiers", "--delay", "15", "--", marker],
          { env, timeout: 3000, maxBuffer: 4096 });
        try {
          await until(async () => {
            assert.equal(nativeEditor?.closeObserved, false);
            return await readFile(editorPath, "utf8") === expectedEditorText;
          }, 3000);
        } finally {
          const actual = await readFile(editorPath), current = await windowState();
          keyboardReceipts.push({ phase, expectedBytes: Buffer.byteLength(expectedEditorText),
            expectedSha256: sha(Buffer.from(expectedEditorText)), actualBytes: actual.byteLength, actualSha256: sha(actual),
            matches: actual.toString("utf8") === expectedEditorText, mainFocused: current.mainFocused, overlayFocused: current.overlayFocused });
          await writeFile(join(evidence, "native-overlay-editor-keyboard.json"), JSON.stringify({ editorBackend: "WAYLAND",
            markerSource: "FIXED_LOWERCASE_ASCII", route: "OWNED_OUTER_XTEST", refocusedAfterPointer: false,
            editorPid: nativeEditor.child.pid, receipts: keyboardReceipts }, null, 2), { mode: 0o600 });
        }
        await assertFocusRetained();
      };
      assert.equal((await overlayState()).status, "idle");
      const defaultSurface = kdeWaylandOverlay ? await nativeScreenshot("native-overlay-default-hidden.png") : undefined;
      checks.push("trusted actual overlay is hidden by default; sandbox/context isolation and Linux kernel renderer isolation; no renderer Node API");

      await checkpoint("actual-overlay-idle-preference");
      await page.locator('[data-pref="show_idle_overlay"]').check();
      await until(async () => (await state()).preferences.show_idle_overlay === true &&
        (kdeWaylandOverlay || (await windowState()).overlayVisible));
      await assertFocusRetained();
      await expect(overlay.locator("#record-control")).toHaveAttribute("data-status", "idle");
      assert.equal(await overlay.evaluate(async () => {
        try { await window.openwhisper?.invoke("save_preferences", { changes: { show_idle_overlay: false } }); return null; }
        catch (error: unknown) { return error instanceof Error ? error.message : null; }
      }), "This action is not available from this window.");
      assert.equal((await state()).preferences.show_idle_overlay, true);
      assert.equal((await windowState()).overlayVisible, !kdeWaylandOverlay);
      if (kdeWaylandOverlay) {
        await delay(200);
        assert.notEqual(await nativeScreenshot("native-overlay-idle.png", true), defaultSurface);
      }
      await overlay.screenshot({ path: join(evidence, "overlay-idle.png"), timeout: 5000 });
      checks.push("shared-UI idle-overlay preference shows the real nonfocusable window without taking main focus; overlay preference mutation refused");

      if (kdeWaylandOverlay) {
        await checkpoint("native-overlay-owned-wayland-editor");
        assert.equal(env.WF_OWNED_DESKTOP_TEST, env.XDG_RUNTIME_DIR);
        assert.equal(env.WAYLAND_DISPLAY, "openwhisper-owned");
        assert.ok(env.AT_SPI_BUS_ADDRESS?.startsWith(`unix:path=${env.XDG_RUNTIME_DIR}/accessibility-bus`));
        const targetHelper = join(payload, "test-owned-portals.py"), focusScript = join(payload, "focus-target.js");
        for (const path of [targetHelper, focusScript]) {
          const value = await lstat(path); assert.ok(value.isFile() && !value.isSymbolicLink());
        }
        nativeEditor = child("/usr/bin/python3", [targetHelper, "--typing-target", editorPath], { ...env, GDK_BACKEND: "wayland" });
        await until(async () => {
          assert.equal(nativeEditor?.closeObserved, false);
          try { const value = await lstat(editorPath); return value.isFile() && value.uid === 1000 && !(value.mode & 0o077); }
          catch { return false; }
        });
        assert.equal(await readFile(editorPath, "utf8"), "");
        await delay(250);
        const kwinCall = async (path: string, method: string, args: string[] = []) =>
          (await execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.kde.KWin", "--object-path", path,
            "--method", method, ...args], { env, timeout: 3000, maxBuffer: 16_384 })).stdout.trim();
        const scriptName = "openwhisper-owned-overlay-editor-focus";
        const loaded = /^\((?:int32 )?(\d+),\)$/u.exec(await kwinCall("/Scripting", "org.kde.kwin.Scripting.loadScript", [focusScript, scriptName]));
        assert.ok(loaded); const scriptNumber = Number(loaded[1]);
        assert.ok(Number.isSafeInteger(scriptNumber) && scriptNumber >= 0 && scriptNumber <= 2_147_483_647);
        try {
          let scriptPath: string | undefined;
          for (const candidate of [`/Scripting/Script${scriptNumber}`, `/${scriptNumber}`]) {
            try {
              if ((await kwinCall(candidate, "org.freedesktop.DBus.Introspectable.Introspect")).includes('name="org.kde.kwin.Script"')) {
                scriptPath = candidate; break;
              }
            } catch (error: unknown) {
              if (!(error instanceof Error) || !error.message.includes("UnknownObject")) throw error;
            }
          }
          assert.ok(scriptPath); await kwinCall(scriptPath, "org.kde.kwin.Script.run");
        } finally { await kwinCall("/Scripting", "org.kde.kwin.Scripting.unloadScript", [scriptName]); }
        await until(async () => !(await windowState()).mainFocused);
        await verifyEditorKeyboard("beforeCancel");
        checks.push("one original private native Wayland GTK editor focused once by exact caption; actual outer XTEST marker reaches its cursor before Cancel");
      }

      await checkpoint("actual-f8-overlay-cancel");
      await stockPress();
      await until(async () => (await state()).status === "recording" && (await overlayState()).status === "recording");
      await expect(overlay.locator("#record-control")).toHaveAttribute("data-status", "recording");
      await until(async () => (await pactl(["list", "short", "source-outputs"])).trim().split("\n").filter(Boolean).length === 1);
      await assertFocusRetained();
      assert.equal(await control(), "recording");
      await overlay.screenshot({ path: join(evidence, "overlay-recording.png"), timeout: 5000 });
      if (kdeWaylandOverlay) await nativeScreenshot("native-overlay-recording.png", true);
      await expect(overlay.locator("#cancel")).toBeVisible();
      const pointerButton = async (id: "#cancel" | "#record") => {
      const cancelRect = await overlay.locator(id).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement) || button.disabled || button.hidden) throw new Error("OWNED_OVERLAY_CANCEL_UNAVAILABLE");
        const rect = button.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const overlayBounds = surfaceBounds ?? await application!.evaluate(({ BrowserWindow }, url) => {
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
      await writeFile(join(evidence, id === "#cancel" ? "overlay-cancel-pointer.json" : "overlay-stop-pointer.json"), JSON.stringify({ overlayBounds, cancelRect, cancelPoint,
        outerWindow: windows[0]!, route: "OWNED_OUTER_XTEST", control: id }, null, 2), { mode: 0o600 });
      // The unchanged outer DISPLAY routes actual XTEST input through the already grabbed private KWin surface.
      await execute("/usr/bin/xdotool", ["mousemove", "--sync", "--window", windows[0]!, String(cancelPoint.x), String(cancelPoint.y), "click", "1"],
        { env, timeout: 3000, maxBuffer: 4096 });
      };
      await pointerButton("#cancel");
      await until(async () => (await state()).status === "idle" && (await overlayState()).status === "idle");
      if (kdeWaylandOverlay) await verifyEditorKeyboard("afterCancel");
      assert.equal(await control(), "idle");
      assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
      assert.deepEqual(await readdir(profile.paths.recovery), []);
      assert.equal((await state()).recovery_available, false);
      await assertFocusRetained();
      checks.push("actual stock F8 opens one private capture; main/control/overlay mirror that owner; actual owned outer XTEST pointer Cancel closes its stream without recovery or focus change");

      if (kdeWaylandOverlay) {
        await checkpoint("native-wayland-overlay-pointer-stop");
        await verifyEditorKeyboard("beforeStop");
        await stockPress(); await until(async () => (await state()).status === "recording" && (await overlayState()).status === "recording");
        const publicSpeech = await readFile(join(payload, "fixtures/jfk.f32"));
        assert.equal(publicSpeech.length, 704000); assert.equal(sha(publicSpeech), "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0");
        const audio = Buffer.alloc(publicSpeech.length * 3);
        for (let index = 0; index < publicSpeech.length / 4; index++) for (let repeat = 0; repeat < 3; repeat++)
          audio.writeFloatLE(publicSpeech.readFloatLE(index * 4), (index * 3 + repeat) * 4);
        const audioPath = join(root, "overlay-public-generated.f32"); await writeFile(audioPath, audio, { mode: 0o600 });
        await execute("/usr/bin/paplay", ["--raw", "--format=float32le", "--rate=48000", "--channels=1", `--device=${sink}`, audioPath],
          { env, timeout: 30_000, maxBuffer: 1024 });
        await delay(200); await assertFocusRetained();
        await pointerButton("#record");
        await until(async () => {
          const value = await state(); if (value.status === "error") throw new Error("OWNED_TRANSCRIPTION_FAILED");
          return value.status === "transcribing" || value.status === "done";
        });
        assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
        await verifyEditorKeyboard("afterStop");
        await until(async () => {
          const value = await state(); if (value.status === "error") throw new Error("OWNED_TRANSCRIPTION_FAILED");
          return value.status === "done";
        }, 120_000);
        const result = await state(); assert.match(result.transcript.toLowerCase(), /country/u);
        const clipboard = await execute("/usr/bin/wl-paste", ["--no-newline"], { env, timeout: 3000, maxBuffer: 1024 * 1024 });
        assert.equal(clipboard.stdout, result.transcript); assert.equal(result.history[0], result.transcript);
        assert.equal(result.recovery_available, false); assert.deepEqual(await readdir(profile.paths.recovery), []);
        assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
        await assertFocusRetained();
        checks.push("native GTK layer-shell pointer Stop reaches the same trusted offscreen renderer; real CPU Tiny recognition equals independent Wayland clipboard/history; focus retained and recovery removed");
      }

      await checkpoint("actual-overlay-idle-hidden-again");
      await page.locator('[data-pref="show_idle_overlay"]').uncheck();
      await until(async () => (await state()).preferences.show_idle_overlay === false && !(await windowState()).overlayVisible);
      if (!kdeWaylandOverlay) await assertFocusRetained();
      else {
        // This explicit main-settings action follows all four keyboard gates;
        // it is not a refocus used to repair an overlay pointer transition.
        const current = await windowState(); assert.equal(current.overlayFocused, false); assert.equal(current.overlayFocusable, false);
      }
      if (kdeWaylandOverlay) {
        await delay(200); await nativeScreenshot("native-overlay-hidden-again.png");
        assert.equal((await windowState()).overlayVisible, false);
      }
      const maps = await readFile(`/proc/${security.pid}/maps`, "utf8");
      assert.equal(maps.includes("openwhisper_capture.node"), false); assert.equal(maps.includes("openwhisper_speech.node"), false);
      assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
      checks.push("turning off the idle preference hides the actual idle overlay; normal settings remain usable; stable sentinel unchanged");

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
      if (surfacePid) await until(async () => {
        try { await lstat(`/proc/${surfacePid}`); return false; }
        catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return true; throw error; }
      }, 5000);
      const resources = await recordResources("resources.json");
      assert.match(resources["pids.events"] ?? "", /(?:^|\n)max 0(?:\n|$)/u);
      assert.equal(resources["pids.max"]?.trim(), "256");
      for (const field of ["oom", "oom_kill"]) assert.match(resources["memory.events"] ?? "", new RegExp(`(?:^|\\n)${field} 0(?:\\n|$)`, "u"));
      await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", checks,
        applicationBackend: kdeWaylandOverlay ? "WAYLAND" : "XWAYLAND",
        ...(kdeWaylandOverlay ? { nativeSurfaceScreenshot: true, nativePointerStop: true, clipboardConfirmed: true, surfaceProcessAbsentAfterQuit: true,
          foregroundKeyboardDelivery: true, editorBackend: "WAYLAND", editorMarkers: keyboardReceipts.length } : {}),
        overlayUrl, defaultHidden: true, idlePreferenceVisibility: true, focusRetained: true, preferenceMutationRefused: true,
        overlaySandbox: true, privateCaptureCancelled: true, originalApplicationClosed: true, nativeInMain: false,
        overlayInput: "OWNED_OUTER_XTEST_CANCEL", hotkeys: "OWNED_STOCK_KDE_KGLOBALACCEL_KEY_EDGES", stableSentinelUnchanged: true,
        physicalMicrophone: "NOT_USED", desktop: "OWNED_STOCK_KDE", recognition: kdeWaylandOverlay ? "CPU_TINY_PUBLIC_FIXTURE" : "NOT_TESTED", automaticPaste: "NOT_TESTED" }, null, 2), { mode: 0o600 });
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
  } else if (nativeX11) {
    await checkpoint("actual-x11-native-key-capture");
    assert.equal((await state()).native_x11, true); assert.equal((await state()).native_shortcuts, true);
    const nativeWindow = await application.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === "app://openwhisper/index.html");
      if (!main) throw new Error("MISSING_OWNED_MAIN_WINDOW");
      const handle = main.getNativeWindowHandle(); return handle.length === 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE();
    });
    assert.ok(Number.isSafeInteger(nativeWindow) && nativeWindow > 1 && nativeWindow <= 0xffffffff);
    if (stablePackage) {
      const property = await execute("/usr/bin/xprop", ["-id", String(nativeWindow), "WM_CLASS"], { env, timeout: 3000, maxBuffer: 4096 });
      const names = /^WM_CLASS\(STRING\) = "([^"]*)", "([^"]*)"\s*$/u.exec(property.stdout); assert.ok(names);
      const classes = names.slice(1); await writeFile(join(evidence, "stable-desktop-identity.json"),
        JSON.stringify({ executable: "openwhisper", desktopFile: "io.github.whisperfree.desktop", startupWMClass: "io.github.whisperfree", actualWMClass: classes }), { mode: 0o600 });
      assert.ok(classes.includes("io.github.whisperfree"), "Stable X11 WM_CLASS must match the package desktop StartupWMClass.");
    }
    // Bare private Xvfb has no EWMH window manager. Focus only the original
    // owned main XID before explicit capture, never a foreign target/window.
    await execute("/usr/bin/xdotool", ["windowfocus", "--sync", String(nativeWindow)], { env, timeout: 3000, maxBuffer: 4096 });
    await checkpoint("actual-x11-owned-main-focus");
    const serverFocus = Number((await execute("/usr/bin/xdotool", ["getwindowfocus"], { env, timeout: 3000, maxBuffer: 4096 })).stdout.trim());
    assert.equal(serverFocus, nativeWindow);
    await writeFile(join(evidence, "native-x11-focus.json"), JSON.stringify({ ownedWindow: nativeWindow, serverFocus,
      electronFocused: await application.evaluate(({ BrowserWindow }) => !!BrowserWindow.getAllWindows()[0]?.isFocused()) }), { mode: 0o600 });
    await page.locator('[data-portal="enable_shortcut"]').click();
    await checkpoint("actual-x11-native-capture-started");
    await until(async () => !!(await state()).recording_shortcut);
    await nativePress();
    await checkpoint("actual-x11-native-profile-commit");
    await delay(150);
    const captureOutcome = await state();
    const knownSetupMessages = ["", "Shortcut setup was cancelled. Window recording remains usable.",
      "Shortcut session ended. Enable it again in Settings.", "This trigger conflicts with an existing desktop shortcut. Choose another trigger.",
      "Shortcut setup or recording failed. Window recording remains usable."];
    await writeFile(join(evidence, "native-x11-capture-outcome.json"), JSON.stringify({
      capturing: captureOutcome.recording_shortcut, configuring: captureOutcome.shortcut_configuring,
      label: captureOutcome.shortcut === "F8" ? "F8" : captureOutcome.shortcut === null ? "NONE" : "OTHER",
      profile: captureOutcome.preferences.x11_trigger ?? null,
      setupMessage: knownSetupMessages.indexOf(captureOutcome.message),
    }), { mode: 0o600 });
    await until(async () => (await state()).shortcut === "F8" && !(await state()).recording_shortcut && !(await state()).shortcut_configuring &&
      (await state()).preferences.x11_trigger?.keysym === 0xffc5);
    const trigger = (await state()).preferences.x11_trigger; assert.ok(trigger);
    assert.equal(trigger.modifiers, 0); assert.equal(trigger.group, 0); assert.equal((await state()).preferences.native_trigger ?? null, null);
    assert.equal((await state()).status, stablePackage ? "done" : "idle"); assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
    await writeFile(join(evidence, "native-x11-capture.json"), JSON.stringify({ display: env.DISPLAY, profile: trigger,
      source: "ACTUAL_PRIVATE_XTEST", platform: "X11", portalSignals: false }), { mode: 0o600 });
    await page.locator('[data-portal="enable_shortcut"]').click(); await until(async () => !!(await state()).recording_shortcut);
    await nativePress("Escape");
    await until(async () => !(await state()).recording_shortcut && !(await state()).shortcut_configuring);
    assert.equal((await state()).shortcut, "F8"); assert.deepEqual((await state()).preferences.x11_trigger, trigger);
    checks.push("native X11 setup captures actual F8 keycode/keysym/group into legacy x11_trigger; real Escape preserves its original binding without recording");
    await checkpoint("actual-x11-repeat-hold-stale-release");
    await page.evaluate(() => window.openwhisper?.invoke("save_preferences", { changes: { hold_to_record: true } }));
    await nativeKey(true); await until(async () => (await state()).status === "recording");
    for (let repeat = 0; repeat < 3; repeat++) await nativeKey(true);
    await delay(750); assert.equal((await state()).status, "recording");
    assert.equal((await pactl(["list", "short", "source-outputs"])).trim().split("\n").filter(Boolean).length, 1);
    await page.locator("#cancel").click(); await until(async () => (await state()).status === "idle");
    await page.locator("#record").click(); await until(async () => (await state()).status === "recording");
    await nativeKey(false); await delay(150); assert.equal((await state()).status, "recording");
    await page.locator("#cancel").click(); await until(async () => (await state()).status === "idle");
    await page.evaluate(() => window.openwhisper?.invoke("save_preferences", { changes: { hold_to_record: false } }));
    checks.push("actual native X11 held/repeated F8 owns one capture; GUI Cancel then later GUI Start; stale key release cannot stop the later owner");
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
  if (!stablePackage || packaged) {
  await checkpoint("actual-command-start-ui-cancel");
  assert.equal(await control("start"), "recording"); await until(async () => (await state()).status === "recording");
  assert.equal(await control(), "recording");
  await page.locator("#cancel").click(); await until(async () => (await state()).status === "idle");
  await page.locator("#record").click(); await until(async () => (await state()).status === "recording");
  assert.equal(await control("cancel"), "idle"); await until(async () => (await state()).status === "idle");
  if (packaged) {
    assert.equal(await control("toggle"), "recording"); await until(async () => (await state()).status === "recording");
    assert.equal(await control("cancel"), "idle"); await until(async () => (await state()).status === "idle");
  }
  assert.equal(await control("start"), "recording"); await until(async () => (await state()).status === "recording");
  assert.equal(await control("cancel"), "idle"); await until(async () => (await state()).status === "idle");
  assert.deepEqual(await readdir(profile.paths.recovery), []);
  checks.push(`${packaged ? "actual no-display package CLI" : "private command"} Start/Status/Cancel${packaged ? "/Toggle" : ""} and GUI cancellation share exact owners${packaged ? "; package CLI creates no profile or window" : ""}`);
  } else await assertNoDevControl();
  await checkpoint("actual-ui-start");
  if (stockKde) await stockPress();
  else if (nativeX11) await nativePress();
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
  if (packaged) {
    const stopped = await control("stop"); assert.ok(stopped === "transcribing" || stopped === "done");
    assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
    checks.push("actual no-display package CLI Stop returns after private capture closure; recognition and delivery are checked separately");
  } else if (stockKde) await stockPress(); else if (nativeX11) await nativePress(); else await portal("Press");
  await until(async () => {
    const value = await state();
    if (value.status === "error") throw new Error("OWNED_TRANSCRIPTION_FAILED");
    return value.status === "done";
  }, 120_000);
  const result = await state(); assert.match(result.transcript.toLowerCase(), /country/u);
  assert.equal(result.gpu_available, false); assert.equal(result.preferences.gpu, stablePackage); assert.equal(result.recovery_available, false);
  assert.equal(await application.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, result.transcript), true);
  await until(async () => (await state()).history[0] === result.transcript);
  assert.deepEqual(await readdir(profile.paths.recovery), []);
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
  const maps = await readFile(`/proc/${security.pid}/maps`, "utf8");
  assert.equal(maps.includes("openwhisper_capture.node"), false); assert.equal(maps.includes("openwhisper_speech.node"), false);
  checks.push(`${stockKde ? "actual stock KGlobalAccel F8" : nativeX11 ? "actual native X11 F8" : "actual owned portal"} Start${packaged ? "; no-display package CLI Stop" : "/Stop"}; real CPU Tiny recognition; private clipboard exact readback; history confirmation; recovery removal; native capture/speech absent from main`);
  if (stockKde || nativeX11) await page.evaluate(() => window.openwhisper?.invoke("clear_shortcut", {}));
  else await page.locator('[data-portal="clear_shortcut"]').click();
  await until(async () => (await state()).shortcut === null && !(await state()).shortcut_configuring);
  if (stockKde) {
    assert.deepEqual(JSON.parse(await readFile(join(profile.paths.settings, "kde-keyboard-lease.json"), "utf8")), []);
    await stockPress(); await delay(150); assert.equal((await state()).status, "done");
    checks.push("Remove trigger empties the private recovery journal and actual F8 no longer starts capture");
  }
  if (nativeX11) {
    await nativePress(); await delay(150); assert.equal((await state()).status, "done");
    assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
    checks.push("clear releases the actual X11 F8 grab; the later real key cannot start another capture");
  }
  if (!stockKde && !nativeX11) assert.match(await portal("PortalStatus"), /uint32 0/u);
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
  if (stablePackage) {
    await checkpoint("stable-edited-state-discard-restart");
    await page.evaluate(() => window.openwhisper?.invoke("save_preferences", { changes: { vocabulary: "Owned edited stable setting" } }));
    await until(async () => (await state()).preferences.vocabulary === "Owned edited stable setting");
    const historyBeforeRestart = (await state()).history;
    appOwners.at(-1)!.termination = "quit"; await application.close(); await appOriginalClose;
    assert.equal(appOwners.at(-1)!.closeObserved, true); application = undefined; page = undefined;
    if (installedDebian) {
      await assertAutostart(true);
      // Closed fixture form only: do not execute a shell or reuse production parsing.
      const lines = (await readFile(autostartPath, "utf8")).split("\n").filter((line) => line.startsWith("Exec="));
      assert.equal(lines.length, 1); const target = /^Exec="(\/opt\/openwhisper\/openwhisper)"$/u.exec(lines[0]!);
      assert.ok(target); executable = target[1]!; generatedExecRestart = true;
    }
    const reopened = await launchApplication(); application = reopened.application; page = reopened.page;
    await until(async () => !!(await state()).recording_available); const restarted = await state();
    assert.equal(restarted.profile, undefined); assert.equal(restarted.preferences.vocabulary, "Owned edited stable setting");
    assert.equal(restarted.preferences.gpu, true); assert.deepEqual(restarted.history, historyBeforeRestart);
    assert.equal(restarted.recovery_available, false); assert.deepEqual(await readdir(profile.paths.recovery), []);
    assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), ""); await assertStableOriginals(); await assertNoDevControl();
    assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
    const restartedPid = await application.evaluate(() => process.pid), restartedMaps = await readFile(`/proc/${restartedPid}/maps`, "utf8");
    assert.equal(restartedMaps.includes("openwhisper_capture.node"), false); assert.equal(restartedMaps.includes("openwhisper_speech.node"), false);
    if (installedDebian) {
      assert.equal(restarted.launch_at_login_available, true); assert.equal(restarted.preferences.launch_at_login, true); await assertAutostart(true);
      await page.locator('[data-tab="general"]').click(); await checkpoint("installed-autostart-ui-disable");
      const checkbox = page.locator('[data-pref="launch_at_login"]'); await expect(checkbox).toBeEnabled(); await expect(checkbox).toBeChecked();
      await checkbox.uncheck(); await until(async () => !(await state()).preferences.launch_at_login && !(await persistedLogin()));
      await assertAutostart(false); const disabledIdentity = await lstat(autostartPath);
      await focusRefresh(); assert.equal((await state()).preferences.launch_at_login, false); await assertAutostart(false);
      const unchanged = await lstat(autostartPath); assert.equal(unchanged.dev, disabledIdentity.dev); assert.equal(unchanged.ino, disabledIdentity.ino);
      assert.equal(unchanged.mtimeMs, disabledIdentity.mtimeMs); assert.equal(unchanged.ctimeMs, disabledIdentity.ctimeMs);
      await assertInstalledPackage(); uiEnableDisableVerified = true;
      checks.push("generated fixed Exec target restarts the exact installed stable package and private edited profile; ordinary UI disable verifies Hidden=true and read-only refresh; actual login-session launch not tested");
    }
    checks.push("original stable app quits and normal package restarts with edited settings/history and no replay after Discard; legacy originals/in-place model/Dev sentinel retained; no Dev control owner");
  }
  if (stockKde) {
    const resources = await recordResources("resources.json");
    assert.match(resources["pids.events"] ?? "", /(?:^|\n)max 0(?:\n|$)/u);
    assert.equal(resources["pids.max"]?.trim(), "256");
  }
  await checkpoint("graceful-normal-quit");
  const quitOwner = appOwners.at(-1)!; assert.equal(quitOwner.original, application.process());
  const quitPid = quitOwner.original.pid; assert.ok(quitPid); quitOwner.termination = "quit";
  let quitPhase: "playwright-close" | "original-close" | "complete" = "playwright-close";
  let quitOutcome: "closed" | "failed" = "failed", quitExpired = false, quitTimer: NodeJS.Timeout | undefined;
  await checkpoint("graceful-playwright-close");
  const closing = (async () => {
    await application!.close(); quitPhase = "original-close"; if (!quitExpired) await checkpoint("graceful-playwright-close-complete");
    await quitOwner.closed; quitPhase = "complete"; if (!quitExpired) await checkpoint("graceful-original-close-complete");
  })(); void closing.catch(() => {});
  try {
    await Promise.race([closing, new Promise<never>((_, reject) => { quitTimer = setTimeout(() => {
      quitExpired = true; reject(new Error("OWNED_APP_CLOSE_TIMEOUT"));
    }, 10_000); })]); quitOutcome = "closed";
  } finally {
    if (quitTimer) clearTimeout(quitTimer);
    let pidExists: boolean | "unknown" = "unknown";
    try { await lstat(`/proc/${quitPid}`); pidExists = true; } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") pidExists = false;
    }
    await writeFile(join(evidence, "quit-observation.json"), JSON.stringify({ outcome: quitExpired ? "expired" : quitOutcome, phase: quitPhase, pid: quitPid,
      exitCode: quitOwner.original.exitCode, signalCode: quitOwner.original.signalCode, closeObserved: quitOwner.closeObserved,
      pidExists, quitEvents: quitOwner.quitEvents, ownerIndex: appOwners.length - 1 }), { mode: 0o600 });
    if (quitExpired) {
      await recordResources("quit-timeout-resources.json");
      const processes = await execute("/bin/ps", ["-eo", "pid,ppid,comm,stat"], { env, timeout: 5000, maxBuffer: 65_536 }).catch(() => undefined);
      await writeFile(join(evidence, "quit-timeout-processes.json"), JSON.stringify({ processes: processes?.stdout ?? null }), { mode: 0o600 });
    }
  }
  application = undefined;
  if (packaged) { await packageCommand("status", true); checks.push("absent package owner refuses no-display CLI without activation, profile creation or residual process"); }
  await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", checks, architecture: process.arch, uid: process.getuid?.(),
    transcriptCharacters: result.transcript.length, transcriptSha256: sha(Buffer.from(result.transcript)), countryRecognized: true,
    clipboardConfirmed: true, historyConfirmed: true, recoveryRemoved: true, cancelConfirmed: true, retryConfirmed: true, discardConfirmed: true,
    nativeInMain: false, security,
    sourceScope: "owned-generated-PipeWire-Pulse-monitor-only", fixtureSha256: sha(publicSpeech),
    ...(nativeX11 ? { nativeX11: true, nativeCapture: true, escapePreserved: true, holdStaleReleaseSafe: true, clearedKeyInactive: true } : {}),
    ...(packaged ? { packagedApplication: true, packageAppPath: packageRoot, executable, packageControl: { allCommands: true, noDisplay: true,
      profileAbsent: true, absentOwnerRefused: true, processesClosed: true } } : {}),
    ...(installation ? { installedRuntime: true, installation } : {}),
    ...(installedDebian ? { debianInstalled: true, installedGeneratedExecRestart: generatedExecRestart, startupAutostartReadOnly,
      uiEnableDisableVerified, actualLoginSession: "NOT_TESTED" } : {}),
    ...(stablePackage ? { stableRuntime: true, stableMigration: { legacyRetry: true, cpuFallback: true, editedStateRetained: true,
      discardNotReplayed: true, originalsPreserved: true, devSentinelUnchanged: true, devControlAbsent: true } } : {}),
    physicalMicrophone: "NOT_USED", hotkeys: stockKde ? "OWNED_STOCK_KDE_KGLOBALACCEL_KEY_EDGES" : nativeX11 ? "OWNED_XVFB_NATIVE_XTEST_KEYS" : "OWNED_SYNTHETIC_PORTAL_SIGNALS_ONLY", portalResourcesClosed: true,
    automaticPaste: "NOT_TESTED", gpu: "NOT_TESTED", macos: "NOT_TESTED" }, null, 2), { mode: 0o600 });
  status = "PASS";
}
try { await main(); } catch (error: unknown) {
  // Installation precedes model/profile creation and capture; retain only its bounded metadata error.
  if (stage === "install-fresh-owned-package" && error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
    await writeFile(join(evidence, "installer-failure.txt"), error.stderr.slice(-8192), { mode: 0o600 });
  }
  failure = { name: error instanceof Error ? error.name : "UNKNOWN",
    location: error instanceof Error ? error.stack?.split("\n").find((line) => line.includes("file:///payload/driver.mjs:"))?.trim() ?? null : null };
  process.exitCode = 1;
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ stage, lastState, failure }), { mode: 0o600 });
  await recordResources("failure-resources.json");
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

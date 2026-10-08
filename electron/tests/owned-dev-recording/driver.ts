import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/profiles.js";
import { validateCommandOutput } from "../../src/contracts/ui.js";
import type { DesktopBridge } from "../../src/contracts/bridge.js";
import { recordingHostErrorSchema } from "../../src/workers/recording-host-protocol.js";

declare global { interface Window { openwhisper?: DesktopBridge } }
const execute = promisify(execFile);
const payload = resolve(fileURLToPath(new URL("./", import.meta.url)));
const packageRoot = join(payload, "app"), evidence = "/evidence";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const checks: string[] = [];
let stage = "guard", status = "FAIL", application: ElectronApplication | undefined, page: Page | undefined;
let lastState: Readonly<{ status: string; recordingAvailable: boolean; recoveryAvailable: boolean; elapsed: number; progress: number;
  messageCategory: "NONE" | "RECORDING_ERROR" | "ACTION_REFUSED" | "OTHER"; recordingError: string | null }> | undefined;
const owners: { child: ChildProcess; closed: Promise<void>; closeObserved: boolean }[] = [];
const diagnostics: { stdoutBytes: number; stderrBytes: number } = { stdoutBytes: 0, stderrBytes: 0 };
async function checkpoint(value: string): Promise<void> {
  stage = value; await writeFile(join(evidence, "checkpoint.json"), JSON.stringify({ stage, checks }), { mode: 0o600 });
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
  assert.ok((await lstat("/.dockerenv")).isFile());
  for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) await assert.rejects(lstat(device), { code: "ENOENT" });
  for (const key of ["PULSE_SERVER", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) assert.equal(process.env[key], undefined);
  const root = await mkdtemp("/tmp/openwhisper-owned-dev-recording-"); await chmod(root, 0o700);
  const home = join(root, "home"), runtime = join(root, "runtime"), config = join(home, "config");
  for (const path of [home, runtime, config, join(home, "data"), join(home, "cache")]) await mkdir(path, { mode: 0o700 });
  await mkdir(join(config, "wireplumber/main.lua.d"), { recursive: true, mode: 0o700 });
  await mkdir(join(config, "wireplumber/bluetooth.lua.d"), { recursive: true, mode: 0o700 });
  await writeFile(join(config, "wireplumber/main.lua.d/89-owned-no-devices.lua"), "alsa_monitor.enabled = false\nv4l2_monitor.enabled = false\nlibcamera_monitor.enabled = false\n", { mode: 0o600 });
  await writeFile(join(config, "wireplumber/bluetooth.lua.d/89-owned-no-devices.lua"), "bluez_monitor.enabled = false\n", { mode: 0o600 });
  const env: Record<string, string> = {
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
  const stable = join(home, "data", "whisperfree"); await mkdir(stable, { mode: 0o700 });
  await writeFile(join(stable, "sentinel"), "Owned stable sentinel", { mode: 0o600 });
  const stableBefore = sha(await readFile(join(stable, "sentinel")));
  await checkpoint("private-session");
  const bus = child("/usr/bin/dbus-daemon", ["--session", "--nofork", `--address=unix:path=${runtime}/bus`], env); await waitSocket(join(runtime, "bus"), bus);
  const portalBinary = join(payload, "owned-bus/owned-portal");
  const portalOwner = child(portalBinary, [env.DBUS_SESSION_BUS_ADDRESS!], env);
  await until(async () => {
    assert.equal(portalOwner.closeObserved, false);
    return (await execute("/usr/bin/dbus-send", ["--session", "--type=method_call", "--print-reply", "--dest=org.freedesktop.DBus",
      "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.portal.Desktop"], { env, timeout: 5000, maxBuffer: 8192 })).stdout.includes("boolean true");
  });
  const portal = async (member: "PortalMode" | "PortalStatus" | "Press" | "Release" | "Unassign" | "End", mode?: "grant" | "pending" | "deny") => {
    return (await execute("/usr/bin/dbus-send", ["--session", "--type=method_call", "--print-reply", "--dest=org.freedesktop.portal.Desktop",
      "/owned", `org.openwhisper.Owned.${member}`, ...(mode ? [`string:${mode}`] : [])], { env, timeout: 5000, maxBuffer: 8192 })).stdout;
  };
  const pipewire = child("/usr/bin/pipewire", [], env); await waitSocket(join(runtime, "pipewire-0"), pipewire);
  child("/usr/bin/wireplumber", [], env);
  const pulse = child("/usr/bin/pipewire-pulse", [], env); await waitSocket(join(runtime, "pulse/native"), pulse);
  const pactl = async (args: string[]) => (await execute("/usr/bin/pactl", args, { env, timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;
  const sourceNames = async () => (await pactl(["list", "short", "sources"])).trim().split("\n").filter(Boolean).map((row) => row.split("\t")[1]);
  assert.ok((await sourceNames()).every((name) => name === "auto_null.monitor"));
  const sink = "openwhisper_owned_dev", source = `${sink}.monitor`;
  const module = (await pactl(["load-module", "module-null-sink", `sink_name=${sink}`, "rate=48000", "channels=1"])).trim(); assert.match(module, /^\d+$/u);
  await pactl(["set-default-sink", sink]); await pactl(["set-default-source", source]);
  await until(async () => JSON.stringify(await sourceNames()) === JSON.stringify([source]));
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  const xvfb = child("/usr/bin/Xvfb", ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], env, true);
  const display = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("OWNED_DISPLAY_UNAVAILABLE")), 10_000); let value = "";
    xvfb.child.stderr?.on("data", (bytes: Buffer) => { diagnostics.stderrBytes += bytes.length; });
    const pipe = xvfb.child.stdio[3]; assert.ok(pipe && "on" in pipe);
    pipe.on("data", (bytes: Buffer) => { value += bytes.toString(); if (/^\d+\n$/u.test(value)) { clearTimeout(timer); accept(`:${value.trim()}`); } });
  });
  env.DISPLAY = display;
  await checkpoint("launch-normal-application");
  const startupWatch = setTimeout(() => {
    // Capture only owned process/resource metadata when bootstrap stalls, never argv or content.
    void Promise.all([execute("/bin/ps", ["-eo", "pid,ppid,comm,stat"], { env, timeout: 5000, maxBuffer: 65_536 }),
      readFile("/sys/fs/cgroup/pids.current", "utf8"), readFile("/sys/fs/cgroup/pids.max", "utf8"), readFile("/sys/fs/cgroup/memory.events", "utf8")])
      .then(([processes, pids, maximum, memory]) => writeFile(join(evidence, "startup-resources.json"),
        JSON.stringify({ processes: processes.stdout, pids, maximum, memory }), { mode: 0o600 })).catch(() => {});
  }, 10_000);
  try {
    application = await _electron.launch({ executablePath: join(packageRoot, "node_modules/electron/dist/electron"),
      args: [packageRoot, "--dev", "--dev-profile", profileRoot], env, chromiumSandbox: true, timeout: 30_000 });
  } finally { clearTimeout(startupWatch); }
  application.process().stdout?.on("data", (bytes: Buffer) => { diagnostics.stdoutBytes += bytes.length; });
  application.process().stderr?.on("data", (bytes: Buffer) => { diagnostics.stderrBytes += bytes.length; });
  page = await application.firstWindow();
  await expect(page.locator(".sidebar-brand strong")).toHaveText("OpenWhisper Dev");
  assert.equal(page.url(), "app://openwhisper/index.html");
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
  await page.locator('[data-portal="enable_shortcut"]').click(); await until(async () => (await state()).shortcut === "Ctrl+Alt+Space");
  await portal("Press"); await portal("Release"); await until(async () => (await state()).status === "recording");
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
  await portal("Press");
  await until(async () => (await state()).status === "done", 120_000);
  const result = await state(); assert.match(result.transcript.toLowerCase(), /country/u);
  assert.equal(result.gpu_available, false); assert.equal(result.preferences.gpu, false); assert.equal(result.recovery_available, false);
  assert.equal(await application.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, result.transcript), true);
  await until(async () => (await state()).history[0] === result.transcript);
  assert.deepEqual(await readdir(profile.paths.recovery), []);
  assert.equal((await pactl(["list", "short", "source-outputs"])).trim(), "");
  assert.equal(sha(await readFile(join(stable, "sentinel"))), stableBefore);
  const maps = await readFile(`/proc/${security.pid}/maps`, "utf8");
  assert.equal(maps.includes("openwhisper_capture.node"), false); assert.equal(maps.includes("openwhisper_speech.node"), false);
  checks.push("actual owned portal Start/Stop; real CPU Tiny recognition; private clipboard exact readback; history confirmation; recovery removal; native capture/speech absent from main");
  await page.locator('[data-portal="clear_shortcut"]').click(); await until(async () => (await state()).shortcut === null && !(await state()).shortcut_configuring);
  assert.match(await portal("PortalStatus"), /uint32 0/u);
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
  await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", checks, architecture: process.arch, uid: process.getuid?.(),
    transcriptCharacters: result.transcript.length, transcriptSha256: sha(Buffer.from(result.transcript)), countryRecognized: true,
    clipboardConfirmed: true, historyConfirmed: true, recoveryRemoved: true, cancelConfirmed: true, retryConfirmed: true, discardConfirmed: true,
    nativeInMain: false, security,
    sourceScope: "owned-generated-PipeWire-Pulse-monitor-only", fixtureSha256: sha(publicSpeech),
    physicalMicrophone: "NOT_USED", hotkeys: "OWNED_SYNTHETIC_PORTAL_SIGNALS_ONLY", portalResourcesClosed: true,
    automaticPaste: "NOT_TESTED", gpu: "NOT_TESTED", macos: "NOT_TESTED" }, null, 2), { mode: 0o600 });
  await checkpoint("graceful-normal-quit");
  await application.close(); application = undefined; status = "PASS";
}
try { await main(); } catch { process.exitCode = 1; }
finally {
  let appClosed = application === undefined;
  if (application) { try { await application.close(); appClosed = true; } catch {} }
  for (const owner of owners.toReversed()) {
    if (!owner.closeObserved) owner.child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([owner.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => { owner.child.kill("SIGKILL"); reject(new Error("OWNED_CLOSE_TIMEOUT")); }, 5000); })]); } catch { process.exitCode = 1; }
    finally { if (timer) clearTimeout(timer); }
  }
  await writeFile(join(evidence, "lifecycle.json"), JSON.stringify({ status, stage, checks, lastState, appClosed,
    serverClosesObserved: owners.every((owner) => owner.closeObserved), diagnostics }), { mode: 0o600 });
  if (status !== "PASS" || !appClosed || !owners.every((owner) => owner.closeObserved)) process.exitCode = 1;
}

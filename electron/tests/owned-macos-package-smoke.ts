import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { appStateSchema } from "../src/contracts/ui.js";
import { pinnedRuntimeEnvironment } from "../scripts/runtime.js";

// This script launches only an explicitly supplied Dev package inside the owned Mac CI VM.
if (process.platform !== "darwin" || process.getuid?.() === 0 || process.env["GITHUB_ACTIONS"] !== "true" ||
  process.env["OPENWHISPER_OWNED_MAC_PACKAGE_SMOKE"] !== "1") throw new Error("Mac package smoke requires explicit owned non-root Mac CI execution.");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--package" || args[2] !== "--evidence" || !args[1] || !args[3] ||
  ![args[1], args[3]].every((path) => isAbsolute(path) && !path.includes("\0"))) throw new Error("Usage: owned-macos-package-smoke.ts --package /absolute/Dev.app --evidence /absolute/fresh/evidence");
const bundle = resolve(args[1]), evidence = resolve(args[3]);
if (await realpath(bundle) !== bundle || !bundle.endsWith("/OpenWhisper Dev.app") || evidence.startsWith(`${bundle}/`)) throw new Error("An existing real Dev app and separate fresh evidence directory are required.");
await mkdir(evidence, { mode: 0o700 });
const profile = await realpath(await mkdtemp(join(evidence, "profile-")));
await chmod(profile, 0o700);
const executable = join(bundle, "Contents/MacOS/OpenWhisper Dev"), appPath = join(bundle, "Contents/Resources/app");
assert.equal((await lstat(executable)).isSymbolicLink(), false);
const packageMetadata: unknown = JSON.parse(await readFile(join(bundle, "Contents/Resources/notices/mac-dev-package.json"), "utf8"));
assert.ok(typeof packageMetadata === "object" && packageMetadata !== null && Reflect.get(packageMetadata, "architecture") === process.arch);

let application: ElectronApplication | undefined, page: Page | undefined;
let identity: { executable: string; appPath: string; packaged: boolean; name: string;
  userData: string; sessionData: string; sandbox: boolean | undefined } | undefined;
let stage = "launch", passed = false;
let failure: { name: string; message?: string } | undefined;
let nativeUtilityLoading: unknown;
const checks: string[] = [];
try {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(pinnedRuntimeEnvironment(process.env))) if (value !== undefined) environment[key] = value;
  for (const key of Object.keys(environment)) if (key.startsWith("DYLD_") || key.startsWith("OPENWHISPER_") ||
    ["ELECTRON_FORCE_IS_PACKAGED", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "PULSE_SERVER", "PIPEWIRE_REMOTE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"].includes(key)) delete environment[key];
  application = await _electron.launch({ executablePath: executable, args: ["--dev-profile", profile],
    env: environment, chromiumSandbox: true, timeout: 30_000 });
  const original = application.process();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => original.once("close", (code, signal) => accept({ code, signal })));
  page = await application.firstWindow();
  await expect(page.locator(".sidebar-brand strong")).toHaveText("OpenWhisper Dev", { timeout: 15_000 });
  assert.equal(page.url(), "app://openwhisper/index.html");
  stage = "package-identity";
  identity = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === "app://openwhisper/index.html");
    if (!window) throw new Error("Owned main window is missing.");
    const renderer = app.getAppMetrics().find((item) => item.pid === window.webContents.getOSProcessId());
    return { executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged, name: app.getName(),
      userData: app.getPath("userData"), sessionData: app.getPath("sessionData"),
      sandbox: renderer?.sandboxed };
  });
  assert.equal(identity.executable, executable, "The actual Dev executable must run.");
  assert.equal(identity.appPath, appPath, "The package must use its own Resources/app.");
  assert.equal(identity.packaged, true, "Electron must recognize the renamed packaged executable.");
  assert.equal(identity.name, "OpenWhisper Dev", "The app must retain the separate Dev name.");
  assert.equal(identity.sandbox, true, "The actual Mac renderer must have its OS sandbox enabled.");
  assert.deepEqual(await page.evaluate(() => ({ node: typeof Reflect.get(window, "process"), require: typeof Reflect.get(window, "require") })),
    { node: "undefined", require: "undefined" });
  assert.ok(identity.userData.startsWith(`${profile}/`) && identity.sessionData.startsWith(`${profile}/`));
  checks.push("Actual packaged executable and Resources/app; isolated Dev profile; sandboxed shared UI");
  stage = "native-composition";
  const state = async () => appStateSchema.parse(await page!.evaluate(() => window.openwhisper!.invoke("get_state", {})));
  const initial = await state();
  assert.equal(initial.profile, "development"); assert.equal(initial.platform, "macos");
  assert.equal(initial.native_shortcuts, true, "The packaged normal main must enable Mac keyboard controls.");
  assert.equal(initial.macos?.shortcut_toggle_only, true, "The Mac recording descriptor must be active.");
  assert.equal(initial.status, "idle"); assert.equal(initial.installed.length, 0); assert.equal(initial.microphones.length, 0);
  assert.equal(initial.preferences.macos_shortcut ?? null, null);
  checks.push("Normal production main factory initializes from signed packaged retirement/native descriptors");
  stage = "signed-native-utility-loading";
  nativeUtilityLoading = await application.evaluate(async ({ app, utilityProcess, session }) => {
    const path = process.getBuiltinModule("path"), modules = process.getBuiltinModule("module"), crypto = process.getBuiltinModule("crypto");
    if (!path || !modules || !crypto || !app.isPackaged) throw new Error("Packaged utility inputs unavailable.");
    const root = app.getAppPath(), deadline = Date.now() + 45_000;
    let phase = "packaged-inputs";
    // Object methods avoid tsx's external function-name helper in Playwright's serialized callback.
    const bounded = { async call<T>(operation: Promise<T>, until = deadline): Promise<T> {
      let timer: NodeJS.Timeout | undefined;
      try { return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase}: deadline`)), Math.max(1, Math.min(8000, until - Date.now())));
      })]); } finally { if (timer) clearTimeout(timer); }
    } }.call;
    const requireCondition = { call(value: unknown, message: string): void { if (!value) throw new Error(`${phase}: ${message}`); } }.call;
    const mainInventory = { call(): boolean {
      if (process.report) { process.report.excludeEnv = true; Reflect.set(process.report, "excludeNetwork", true); }
      const report: unknown = process.report?.getReport();
      const objects: unknown = report && typeof report === "object" ? Reflect.get(report, "sharedObjects") : undefined;
      requireCondition(Array.isArray(objects) && objects.every((item: unknown) => typeof item === "string"), "main native inventory unavailable");
      return (objects as string[]).some((item) => /openwhisper_(?:macos_capture|speech)\.node$/u.test(item));
    } }.call;
    type Owner = { child: ReturnType<typeof utilityProcess.fork>; spawned: Promise<number>; exit: Promise<number>;
      exited: boolean; failed: boolean; frames: unknown[]; wake: (() => void) | undefined; pid: number | undefined };
    const owners: Owner[] = [];
    let capture: { pid: number; generation: number; exitCode: number } | undefined;
    let speech: { pid: number; gpu: null; exitCode: number } | undefined;
    let error: string | undefined;
    try {
      requireCondition(!mainInventory(), "capture/speech loaded in main before utility test");
      // Inspector eval has no dynamic-import callback; require the packaged synchronous ESM graph.
      const packagedRequire = modules.createRequire(path.join(root, "package.json"));
      const build = packagedRequire(path.join(root, "dist/main/development-recording-build.js")) as { DEVELOPMENT_RECORDING_BUILD: unknown };
      const schema = packagedRequire(path.join(root, "dist/main/development-recording-descriptor.js")) as typeof import("../src/main/development-recording-descriptor.js");
      const artifacts = packagedRequire(path.join(root, "dist/services/development-artifact.js")) as typeof import("../src/services/development-artifact.js");
      const recording = packagedRequire(path.join(root, "dist/workers/macos-recording-host-protocol.js")) as typeof import("../src/workers/macos-recording-host-protocol.js");
      const resources = packagedRequire(path.join(root, "dist/services/speech-resources.js")) as typeof import("../src/services/speech-resources.js");
      const graph = packagedRequire(path.join(root, "dist/services/speech-entry-graph.js")) as typeof import("../src/services/speech-entry-graph.js");
      const control = packagedRequire(path.join(root, "dist/workers/speech-control.js")) as typeof import("../src/workers/speech-control.js");
      const protocol = packagedRequire(path.join(root, "dist/workers/speech-protocol.js")) as typeof import("../src/workers/speech-protocol.js");
      const mac = packagedRequire(path.join(root, "dist/main/macos-speech-host.js")) as typeof import("../src/main/macos-speech-host.js");
      const descriptor = schema.developmentRecordingDescriptorSchema.parse(build.DEVELOPMENT_RECORDING_BUILD);
      requireCondition(descriptor.platform === "darwin" && descriptor.architecture === process.arch, "descriptor platform/architecture");
      const spawn = { call(entry: string, arguments_: string[], serviceName: string): Owner {
        const child = utilityProcess.fork(entry, arguments_, { serviceName, stdio: "ignore", execArgv: [], session: session.defaultSession,
          allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false, env: mac.macSpeechEnvironment(process.env) });
        let acceptSpawn!: (pid: number) => void, rejectSpawn!: (error: Error) => void, acceptExit!: (code: number) => void;
        const owner: Owner = { child, spawned: new Promise((accept, reject) => { acceptSpawn = accept; rejectSpawn = reject; }),
          exit: new Promise((accept) => { acceptExit = accept; }), exited: false, failed: false, frames: [], wake: undefined, pid: undefined };
        owners.push(owner); void owner.spawned.catch(() => {});
        child.once("spawn", () => { const pid = child.pid;
          if (!pid) { owner.failed = true; rejectSpawn(new Error("Original utility PID missing")); }
          else { owner.pid = pid; acceptSpawn(pid); } owner.wake?.(); });
        child.on("message", (input: unknown) => { if (owner.frames.length >= 64) owner.failed = true; else owner.frames.push(input); owner.wake?.(); });
        child.on("error", () => { owner.failed = true; rejectSpawn(new Error("Original utility error")); owner.wake?.(); });
        child.once("exit", (code) => { owner.exited = true; acceptExit(code); rejectSpawn(new Error("Original utility exited")); owner.wake?.(); });
        return owner;
      } }.call;
      const next = { async call(owner: Owner): Promise<unknown> {
        while (!owner.frames.length) {
          requireCondition(!owner.failed && !owner.exited, "original utility failed/exited before reply");
          await bounded(new Promise<void>((accept) => { owner.wake = accept; })); owner.wake = undefined;
        }
        requireCondition(!owner.failed, "original utility channel failed"); return owner.frames.shift();
      } }.call;
      phase = "capture-entry";
      const captureEntry = await bounded(artifacts.verifyDevelopmentMacCaptureEntry(root, descriptor.captureEntry));
      const epoch = crypto.randomUUID(), captureOwner = spawn(captureEntry, [epoch], "OpenWhisper Dev Capture Load Check");
      const capturePid = await bounded(captureOwner.spawned);
      const captureReady = recording.macRecordingHostReplySchema.parse(await next(captureOwner));
      requireCondition(captureReady.kind === "ready" && captureReady.epoch === epoch && captureReady.pid === capturePid, "original capture ready identity");
      const captureControl = { async call(command: "configure" | "close") {
        const id = crypto.randomUUID();
        const request = recording.macRecordingHostRequestSchema.parse({ version: 1, channel: "recording-host", epoch, id, command,
          ...(command === "configure" ? { capture: descriptor.capture, request: {
            model: { path: path.join(app.getPath("userData"), "unused-native-loading-model.bin"), family: "whisper", gpu: false },
            language: "auto", vocabulary: "", snippets: [] } } : {}) });
        captureOwner.child.postMessage(request);
        for (;;) {
          const reply = recording.macRecordingHostReplySchema.parse(await next(captureOwner));
          requireCondition(reply.epoch === epoch, "capture reply epoch");
          if (reply.kind === "snapshot") { requireCondition(reply.snapshot.phase === "idle" && reply.snapshot.generation === 0 && !reply.snapshot.busy, "capture must remain idle without Start"); continue; }
          requireCondition(reply.kind === "control" && reply.id === id && reply.command === command && reply.reply.ok && reply.reply.generation === 0, "capture control identity/result");
          break;
        }
      } }.call;
      phase = "capture-configure-native-load"; await captureControl("configure");
      phase = "capture-close"; await captureControl("close");
      const captureExit = await bounded(captureOwner.exit); requireCondition(captureExit === 0, "capture original exit");
      capture = { pid: capturePid, generation: 0, exitCode: captureExit };
      phase = "speech-entry";
      const catalog = await bounded(resources.prepareSpeechResources(path.join(root, "dist"), descriptor.speech));
      const preparedGraph = await bounded(graph.prepareSpeechEntryGraph(root, descriptor.speechEntryGraph));
      const entry = await bounded(graph.verifySpeechEntryGraph(preparedGraph)), resource = await bounded(resources.verifySpeechResource(catalog, "cpu"));
      const speechEpoch = crypto.randomUUID(), speechOwner = spawn(entry.entry, [resource.path, speechEpoch], "OpenWhisper Dev Speech Load Check");
      const speechPid = await bounded(speechOwner.spawned);
      protocol.speechReadySchema.parse(await next(speechOwner));
      phase = "speech-challenges";
      for (let index = 0; index < 2; index++) {
        const nonce = crypto.randomUUID(); speechOwner.child.postMessage(control.speechChallengeRequestSchema.parse({ version: 1, type: "challenge", epoch: speechEpoch, nonce }));
        const reply = control.speechChallengeReplySchema.parse(await next(speechOwner));
        requireCondition(reply.pid === speechPid && reply.epoch === speechEpoch && reply.nonce === nonce, "original speech challenge identity");
      }
      const speechRequest = { async call(command: "discover" | "shutdown") {
        const id = crypto.randomUUID(); speechOwner.child.postMessage(protocol.speechRequestSchema.parse({ version: 1, id, command }));
        const reply = protocol.speechReplySchema.parse(await next(speechOwner));
        requireCondition(reply.id === id && reply.ok && reply.value.command === command, "speech reply identity/result");
        if (reply.ok && reply.value.command === "discover") requireCondition(reply.value.gpu === null, "CPU package capability");
      } }.call;
      phase = "speech-discover-native-load"; await speechRequest("discover");
      phase = "speech-shutdown"; await speechRequest("shutdown");
      requireCondition(speechOwner.child.kill(), "original speech termination request");
      const speechExit = await bounded(speechOwner.exit); requireCondition(speechExit === 0, "speech original exit");
      speech = { pid: speechPid, gpu: null, exitCode: speechExit };
      requireCondition(!mainInventory(), "capture/speech loaded in main after utility test");
    } catch (failure: unknown) { error = failure instanceof Error ? failure.message.slice(0, 1000) : "Unknown utility failure"; }
    const cleanupDeadline = Date.now() + 8000;
    const cleanup = await Promise.allSettled(owners.map(async (owner) => {
      if (!owner.exited && !owner.child.kill()) throw new Error("Original utility cleanup request refused");
      await bounded(owner.exit, cleanupDeadline);
      if (owner.failed) throw new Error("Original utility error/channel failure retained through exit");
    }));
    const cleanupPassed = cleanup.every((item) => item.status === "fulfilled");
    let mainCaptureSpeechFree = false;
    try { mainCaptureSpeechFree = !mainInventory(); }
    catch (failure: unknown) { error ??= failure instanceof Error ? failure.message.slice(0, 1000) : "Main inventory unavailable after cleanup"; }
    return { status: error || !cleanupPassed || !mainCaptureSpeechFree ? "FAIL" : "PASS", phase, error, capture, speech, cleanupPassed, mainCaptureSpeechFree,
      cleanupErrors: cleanup.filter((item) => item.status === "rejected").map((item) => item.reason instanceof Error ? item.reason.message : "Original exit not observed"),
      originalExitsObserved: owners.map((owner) => ({ pid: owner.pid, exited: owner.exited })),
      scope: "Signed production capture configure + CPU speech discovery only; no Start, TCC, model load, audio or full retirement claim" };
  });
  assert.ok(typeof nativeUtilityLoading === "object" && nativeUtilityLoading !== null);
  assert.equal(Reflect.get(nativeUtilityLoading, "status"), "PASS", JSON.stringify(nativeUtilityLoading));
  checks.push("Signed production capture configure and CPU speech discovery load in original utilities; original cleanup exits observed; no main capture/speech addon");
  const accelerator = "Command+Shift+F8";
  assert.equal(await application.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), accelerator), false);
  stage = "shortcut-setup";
  await page.locator('[data-ui-language="en"]').click();
  await page.locator('[data-tab="general"]').click();
  await application.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === "app://openwhisper/index.html"); window?.show(); window?.focus(); });
  await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) =>
    item.webContents.getURL() === "app://openwhisper/index.html" && item.isFocused())), { timeout: 10_000 }).toBe(true);
  await page.locator('[data-portal="enable_shortcut"]').click();
  await expect.poll(async () => (await state()).macos?.recording_shortcut, { timeout: 10_000 }).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  // Electron emits before-input-event for rawKeyDown/keyUp, not CDP's distinct keyDown type.
  // Dispatch only to this window's Chromium session, never the OS/global input queue.
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F8", code: "F8", modifiers: 12,
    windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 100, autoRepeat: false });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "F8", code: "F8", modifiers: 12,
    windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 100 });
  await cdp.detach();
  await expect.poll(async () => (await state()).preferences.macos_shortcut, { timeout: 10_000 }).toBe(accelerator);
  assert.equal(await application.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), accelerator), true);
  assert.equal((await state()).status, "idle");
  checks.push("Owned-window CDP Command+Shift+F8 input commits through normal setup; actual globalShortcut registration");
  stage = "shortcut-remove";
  await page.locator('[data-portal="clear_shortcut"]').click();
  await expect.poll(async () => (await state()).preferences.macos_shortcut, { timeout: 10_000 }).toBe(null);
  assert.equal(await application.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), accelerator), false);
  checks.push("Normal Remove trigger unregisters the actual shortcut");
  stage = "original-quit";
  await application.close();
  const exit = await closed; application = undefined;
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  checks.push("Original packaged process exits cleanly through normal Quit and application cleanup");
  await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", architecture: process.arch, identity, checks,
    input: "CDP to owned window only; no OS global input injection", microphone: "No request, Start or audio operation",
    nativeUtilityLoading, tccAttribution: "Permission and real microphone behavior remain pending", exit }, null, 2), { mode: 0o600 });
  passed = true;
} catch (error: unknown) {
  failure = error instanceof Error ? { name: error.name, message: error.message.slice(0, 2000) } : { name: "UNKNOWN" };
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "FAIL", stage, identity, checks, nativeUtilityLoading,
    error: failure }, null, 2), { mode: 0o600 });
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
}
console.log(JSON.stringify({ status: passed ? "PASS" : "FAIL", stage, evidence, architecture: process.arch, error: failure }));

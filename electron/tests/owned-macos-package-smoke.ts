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
const executable = join(bundle, "Contents/MacOS/Electron"), appPath = join(bundle, "Contents/Resources/app");
assert.equal((await lstat(executable)).isSymbolicLink(), false);
const packageMetadata: unknown = JSON.parse(await readFile(join(bundle, "Contents/Resources/notices/mac-dev-package.json"), "utf8"));
assert.ok(typeof packageMetadata === "object" && packageMetadata !== null && Reflect.get(packageMetadata, "architecture") === process.arch);

let application: ElectronApplication | undefined, page: Page | undefined;
let stage = "launch", passed = false;
const checks: string[] = [];
try {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(pinnedRuntimeEnvironment(process.env))) if (value !== undefined) environment[key] = value;
  for (const key of Object.keys(environment)) if (key.startsWith("DYLD_") || key.startsWith("OPENWHISPER_") ||
    ["DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "PULSE_SERVER", "PIPEWIRE_REMOTE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"].includes(key)) delete environment[key];
  application = await _electron.launch({ executablePath: executable, args: ["--dev-profile", profile],
    env: environment, chromiumSandbox: true, timeout: 30_000 });
  const original = application.process();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => original.once("close", (code, signal) => accept({ code, signal })));
  page = await application.firstWindow();
  await expect(page.locator(".sidebar-brand strong")).toHaveText("OpenWhisper Dev", { timeout: 15_000 });
  assert.equal(page.url(), "app://openwhisper/index.html");
  const identity = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === "app://openwhisper/index.html");
    if (!window) throw new Error("Owned main window is missing.");
    const renderer = app.getAppMetrics().find((item) => item.pid === window.webContents.getOSProcessId());
    return { executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged, name: app.getName(),
      userData: app.getPath("userData"), sessionData: app.getPath("sessionData"),
      sandbox: renderer?.sandboxed };
  });
  assert.equal(identity.executable, executable); assert.equal(identity.appPath, appPath); assert.equal(identity.packaged, true);
  assert.equal(identity.name, "OpenWhisper Dev"); assert.equal(identity.sandbox, true);
  assert.deepEqual(await page.evaluate(() => ({ node: typeof Reflect.get(window, "process"), require: typeof Reflect.get(window, "require") })),
    { node: "undefined", require: "undefined" });
  assert.ok(identity.userData.startsWith(`${profile}/`) && identity.sessionData.startsWith(`${profile}/`));
  checks.push("Actual packaged executable and Resources/app; isolated Dev profile; sandboxed shared UI");
  const state = async () => appStateSchema.parse(await page!.evaluate(() => window.openwhisper!.invoke("get_state", {})));
  const initial = await state();
  assert.equal(initial.profile, "development"); assert.equal(initial.platform, "macos");
  assert.equal(initial.native_shortcuts, true); assert.equal(initial.macos?.shortcut_toggle_only, true);
  assert.equal(initial.status, "idle"); assert.equal(initial.installed.length, 0); assert.equal(initial.microphones.length, 0);
  assert.equal(initial.preferences.macos_shortcut ?? null, null);
  checks.push("Normal production main factory initializes from signed packaged retirement/native descriptors");
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
  // Dispatch only to this window's Chromium session, never the OS/global input queue.
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "F8", code: "F8", modifiers: 12,
    windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 100, autoRepeat: false });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "F8", code: "F8", modifiers: 12,
    windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 100 });
  await cdp.detach();
  await expect.poll(async () => (await state()).preferences.macos_shortcut, { timeout: 10_000 }).toBe(accelerator);
  assert.equal(await application.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), accelerator), true);
  assert.equal((await state()).status, "idle");
  checks.push("Owned-window CDP Command+Shift+F8 press/release commits through normal setup; actual globalShortcut registration");
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
    nativeUtilityLoading: "Capture/speech utility loading and TCC attribution remain pending", exit }, null, 2), { mode: 0o600 });
  passed = true;
} catch (error: unknown) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "FAIL", stage, checks,
    error: error instanceof Error ? { name: error.name, message: error.message.slice(0, 2000) } : { name: "UNKNOWN" } }, null, 2), { mode: 0o600 });
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
}
console.log(JSON.stringify({ status: passed ? "PASS" : "FAIL", evidence, architecture: process.arch }));

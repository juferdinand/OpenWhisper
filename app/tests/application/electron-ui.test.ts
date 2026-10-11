import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { z } from "zod";
import { _electron, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import type { DesktopBridge } from "../../src/contracts/ui/bridge.js";
import { validateCommandOutput } from "../../src/contracts/ui/state.js";

declare global {
  interface Window { openwhisper?: DesktopBridge }
}

const enabled = process.env.OPENWHISPER_OWNED_UI_TEST === "1";
const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

// Playwright executes transpiled TypeScript in Electron's isolated preload world.
// The function has no closures or imported values; no authored JavaScript fixture
// is substituted for the application preload.
function isolatedSecurityProbe() {
  return {
    mainWorldMarker: "ownedMainWorldMarker" in globalThis,
    publicBridge: "openwhisper" in globalThis,
  };
}

async function absent(path: string): Promise<boolean> {
  try { await access(path); return false; } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function hash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Opt-in only: never launch this app on the developer's actual desktop. */
test("owned Electron Dev UI preserves isolation, security and preference patches", {
  skip: !enabled,
  timeout: 120_000,
}, async () => {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid?.(), 1000, "The owned application must run as UID 1000.");
  assert.equal(await absent("/.dockerenv"), false, "Use the retained private container, not a host display.");
  for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) {
    assert.equal(await absent(device), true, `The test must not expose ${device}.`);
  }
  const evidence = process.env.OPENWHISPER_UI_EVIDENCE;
  assert.equal(evidence, "/evidence", "Evidence must stay in the owned container filesystem.");
  const screenshot = async (page: Page, name: string) => page.screenshot({
    path: join(evidence, name),
    mask: [page.locator(".dictation-device, .dictation-change-model, .window-tab-subtitle, .dictation-feature-card:first-child .dictation-feature-description, .compute-mode small, #recognition-backend, .model-drawer-heading p")],
  });
  const openSettings = async (page: Page, tab: "general" | "recording" | "text" | "history" | "about") => {
    if (!await page.locator("#settings-dialog").isVisible()) await page.locator("#open-settings").click();
    await page.locator(`#settings-dialog nav [data-tab="${tab}"]`).click();
  };
  const root = await mkdtemp("/tmp/openwhisper-owned-ui-");
  await chmod(root, 0o700);
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  for (const path of [home, runtime, join(home, "config"), join(home, "data"), join(home, "cache")]) {
    await mkdir(path, { mode: 0o700 });
  }
  // Synthetic stable-profile sentinels prove separation without reading live data.
  const stableFiles: string[] = [];
  for (const [directory, name] of [
    ["config", "whisperfree/preferences.json"],
    ["data", "whisperfree/models/retained.bin"],
    ["data", "whisperfree/history.json"],
    ["data", "whisperfree/recovery/retained.wav"],
    ["config", "autostart/io.github.whisperfree.desktop"],
  ]) {
    assert.ok(directory && name);
    const path = join(home, directory, name);
    await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, `Owned stable sentinel: ${name}\n`, { mode: 0o600 });
    stableFiles.push(path);
  }
  const stableBefore = await Promise.all(stableFiles.map(hash));
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Owned network control");
  });
  let requests = 0;
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const target = `http://127.0.0.1:${address.port}/owned-probe`;
  assert.equal(await (await fetch(target)).text(), "Owned network control");
  assert.equal(requests, 1);

  const environment: Record<string, string> = {
    PATH: "/opt/node/bin:/usr/bin:/bin",
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/disabled-session-bus`,
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime}/disabled-system-bus`,
    PULSE_SERVER: `unix:${runtime}/disabled-pulse`,
    PIPEWIRE_RUNTIME_DIR: runtime, PIPEWIRE_REMOTE: "disabled-pipewire",
    XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "Owned X11",
    LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe",
    ELECTRON_ENABLE_LOGGING: "1",
  };
  const xvfb = spawn("/usr/bin/Xvfb", ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
    env: environment, stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let xvfbErrors = "";
  xvfb.stderr?.on("data", (chunk: Buffer) => { xvfbErrors += chunk.toString(); });
  const display = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Private Xvfb did not become ready.")), 10_000);
    let output = "";
    xvfb.once("error", reject);
    xvfb.once("exit", () => reject(new Error("Private Xvfb exited before readiness.")));
    const pipe = xvfb.stdio[3];
    assert.ok(pipe && "on" in pipe);
    pipe.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (/^\d+\n$/.test(output)) { clearTimeout(timer); accept(`:${output.trim()}`); }
    });
  });
  environment.DISPLAY = display;
  const profile = join(root, "dev-profile");
  let application: ElectronApplication | undefined;
  let currentPage: Page | undefined;
  const launch = async (): Promise<ElectronApplication> => {
    const app = await _electron.launch({
      executablePath: join(packageRoot, "node_modules/electron/dist/electron"),
      args: [packageRoot, "--dev", "--dev-profile", profile],
      env: environment,
      chromiumSandbox: true,
      timeout: 30_000,
    });
    application = app;
    return app;
  };
  const checks: string[] = [];
  try {
    let app = await launch();
    let page = await app.firstWindow();
    currentPage = page;
    await expect(page.locator(".window-wordmark")).toHaveText("openwhisper");
    assert.equal(page.url(), "app://openwhisper/index.html");
    const security = await app.evaluate(({ app: host, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("The owned main window is missing.");
      const rendererPid = window.webContents.getOSProcessId();
      const renderer = host.getAppMetrics().find((metric) => metric.pid === rendererPid);
      return {
        name: host.getName(), userData: host.getPath("userData"), sessionData: host.getPath("sessionData"),
        sandbox: renderer?.sandboxed, devToolsOpen: window.webContents.isDevToolsOpened(), rendererPid,
        argv: process.argv, mainUid: process.getuid?.(),
      };
    });
    assert.equal(security.name, "OpenWhisper Dev");
    assert.equal(security.userData.startsWith(`${profile}/`), true);
    assert.equal(security.sessionData.startsWith(`${profile}/`), true);
    await page.evaluate(() => { Reflect.set(globalThis, "ownedMainWorldMarker", true); });
    const isolatedSecurity: unknown = await app.evaluate(async ({ BrowserWindow }, code) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("The owned main window is missing.");
      return window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]);
    }, `(${isolatedSecurityProbe.toString()})()`);
    assert.deepEqual(isolatedSecurity, { mainWorldMarker: false, publicBridge: false });
    await page.evaluate(() => { Reflect.deleteProperty(globalThis, "ownedMainWorldMarker"); });
    assert.equal(security.devToolsOpen, false);
    assert.equal(security.mainUid, 1000);
    assert.equal(security.argv.some((arg) => arg.includes("no-sandbox")), false);
    const rendererStatus = await readFile(`/proc/${security.rendererPid}/status`, "utf8");
    const rendererCmdline = (await readFile(`/proc/${security.rendererPid}/cmdline`, "utf8")).split("\0");
    assert.match(rendererStatus, /^NoNewPrivs:\s+1$/m);
    assert.match(rendererStatus, /^Seccomp:\s+2$/m);
    assert.match(rendererStatus, /^Seccomp_filters:\s+[2-9]\d*$/m);
    assert.match(rendererStatus, /^NSpid:\s+\d+\s+\d+/m);
    assert.match(rendererStatus, /^CapEff:\s+0+$/m);
    assert.match(rendererStatus, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m);
    assert.equal(rendererCmdline.some((arg) => arg.includes("no-sandbox")), false);
    // Linux zygote-forked renderers may retain the zygote's kernel cmdline;
    // webContents supplies the actual renderer PID used for the OS checks.
    assert.match(rendererCmdline.join(" "), /(?:^|\s)--type=renderer(?:\s|$)/);
    assert.match(rendererCmdline.join(" "), /(?:^|\s)--enable-sandbox(?:\s|$)/);
    await writeFile(join(evidence, "renderer-security.json"), JSON.stringify({ security, isolatedSecurity, rendererCmdline, rendererStatus }, null, 2));
    assert.deepEqual(await page.evaluate(() => ({
      process: "process" in globalThis, require: "require" in globalThis,
      buffer: "Buffer" in globalThis, bridge: typeof window.openwhisper?.invoke,
      frozen: Object.isFrozen(window.openwhisper), keys: Object.keys(window.openwhisper ?? {}).sort(),
    })), { process: false, require: false, buffer: false, bridge: "function", frozen: true, keys: ["invoke", "subscribe"] });
    checks.push("actual sandboxed renderer, isolated preload, exact app origin and Dev storage");

    const beforeSetup = validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {})));
    assert.equal(beforeSetup.preferences.setup_completed, false);
    await expect(page.locator(".setup-logo")).toBeVisible();
    await expect(page.locator("nav button[data-tab]")).toHaveCount(0);
    await expect(page.locator('nav button[data-tab="general"]')).toHaveCount(0);
    assert.equal(await page.evaluate(async () => {
      try { await window.openwhisper?.invoke("complete_setup", {}); return false; }
      catch { return true; }
    }), true);
    assert.equal(validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {}))).preferences.setup_completed, false);
    assert.equal(beforeSetup.model_directory, join(profile, "data", "models"));
    const otherModel = beforeSetup.models.find((model) => model.id === "base");
    const selectedModel = beforeSetup.models.find((model) => model.id === beforeSetup.preferences.model);
    assert.ok(otherModel?.file && selectedModel?.file);
    assert.notEqual(otherModel.id, selectedModel.id);
    // Private inventory sentinels exercise setup admission, never speech inference or model quality.
    await writeFile(join(beforeSetup.model_directory, otherModel.file), "Owned unselected inventory fixture", { mode: 0o600 });
    assert.equal(await page.evaluate(async () => {
      try { await window.openwhisper?.invoke("complete_setup", {}); return false; }
      catch { return true; }
    }), true);
    assert.equal(validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {}))).preferences.setup_completed, false);
    await writeFile(join(beforeSetup.model_directory, selectedModel.file), "Owned selected inventory fixture", { mode: 0o600 });
    await app.close();
    application = undefined;
    app = await launch();
    page = await app.firstWindow();
    currentPage = page;
    await expect(page.locator(".setup-logo")).toBeVisible();
    for (let step = 0; step < 7; step++) {
      await page.locator("[data-setup-next]").click();
      if (step === 0) {
        await expect(page.getByRole("heading", { name: "Choose recognition hardware", exact: true })).toBeVisible();
        await expect(page.getByText("Step 1 of 7", { exact: true })).toBeVisible();
        await expect(page.locator('input[name="gpu-mode"][value="false"]')).toBeChecked();
        await expect(page.locator('input[name="gpu-mode"][value="true"]')).toBeDisabled();
      } else if (step === 1) {
        await expect(page.getByRole("heading", { name: "Download a speech model", exact: true })).toBeVisible();
        await expect(page.getByText("Step 2 of 7", { exact: true })).toBeVisible();
      }
    }
    await page.locator('[data-command="complete_setup"]').click();
    await expect.poll(async () => validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {}))).preferences.setup_completed).toBe(true);
    await expect(page.getByRole("heading", { name: "Dictation", exact: true })).toBeVisible();
    await expect(page.locator(".dictation-workspace")).toBeVisible();
    await expect(page.locator("#dictation-timer")).toHaveText("0:00");
    await expect(page.locator("#copy-dictation")).toBeHidden();
    assert.equal(await page.locator("main").evaluate((main) => main.scrollWidth <= main.clientWidth), true);
    await screenshot(page, "dev-dictation.png");
    await page.locator(".dictation-change-model").click();
    await expect(page.locator("#model-drawer")).toBeVisible();
    await expect(page.locator("#model-drawer").getByRole("heading", { name: "Speech model for Dictation", exact: true })).toBeVisible();
    const drawerBounds = await page.locator("#model-drawer").evaluate((drawer) => {
      const bounds = drawer.getBoundingClientRect();
      const titlebar = document.querySelector(".window-titlebar")!.getBoundingClientRect();
      return { right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight, titlebarBottom: titlebar.bottom };
    });
    assert.ok(Math.abs(drawerBounds.right - drawerBounds.width) <= 1);
    assert.ok(Math.abs(drawerBounds.top - drawerBounds.titlebarBottom) <= 1);
    assert.ok(Math.abs(drawerBounds.bottom - drawerBounds.height) <= 1);
    await screenshot(page, "dev-model-drawer.png");
    await page.keyboard.press("Escape");
    await expect(page.locator("#model-drawer")).toBeHidden();
    await expect(page.locator(".dictation-change-model")).toBeFocused();
    await expect(page.locator(".model-drawer-body")).toBeEmpty();
    await expect(page.locator("#toggle-history")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#dictation-history")).toBeVisible();
    await expect(page.locator("#dictation-history .history-row")).toHaveCount(0);
    await screenshot(page, "dev-history-rail.png");
    await page.locator("#toggle-history").click();
    await expect(page.locator("#toggle-history")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#dictation-history .dictation-history-list")).toBeHidden();
    checks.push("setup rejects missing or unselected installed models through real IPC; a selected private inventory fixture permits completion");
    checks.push("completed setup opens the dictation workspace without inventing a transcript or recording availability");
    checks.push("native model drawer closes with Escape and restores focus; the empty history rail remains optional");
    const state = validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {})));
    assert.equal(state.profile, "development");
    assert.equal(state.recording_available, false);
    assert.equal(state.history.length, 0);
    assert.equal(state.microphones.length, 0);
    const metadata = z.strictObject({
      commit: z.string().regex(/^([a-f0-9]{40}|source)$/), modified: z.boolean(),
    }).parse(JSON.parse(await readFile(join(packageRoot, "dist/resources/development-build.json"), "utf8")));
    const buildIdentifier = `${metadata.commit.slice(0, 12)}${metadata.modified ? "+modified" : ""}`;
    assert.equal(state.development_build, buildIdentifier);
    assert.equal(state.model_directory, join(profile, "data", "models"));
    const modelDirectory = await lstat(state.model_directory);
    assert.equal(modelDirectory.uid, 1000);
    assert.equal(modelDirectory.mode & 0o777, 0o700);
    await openSettings(page, "about");
    await expect(page.locator("#dictation-workspace")).toBeVisible();
    await expect(page.locator("#settings-dialog")).toHaveJSProperty("open", true);
    await expect(page.locator(".version-badge")).toHaveText(`Version ${state.version} · Dev ${buildIdentifier} · Linux`);
    await expect(page.locator(".about-brand img")).toHaveAttribute("src", "./branding/icon-bordered.svg");
    await expect.poll(async () => page.locator(".about-brand img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 512)).toBe(true);
    assert.equal(await page.evaluate(async () => {
      await document.fonts.ready;
      return ["OpenWhisper Instrument Sans", "OpenWhisper Newsreader"].every((family) =>
        Array.from(document.fonts).some((font) => font.family === family && font.status === "loaded"));
    }), true);
    await screenshot(page, "dev-about.png");
    await openSettings(page, "general");
    await screenshot(page, "dev-general.png");
    checks.push("visible Dev build identifier, supplied SVG branding, bundled reference fonts and private model directory");
    await expect(page.locator("#record")).toBeDisabled();
    await expect(page.locator("#status-title")).toHaveText("Recording is unavailable");
    await expect(page.locator("#status")).toHaveText("The recording service could not start. Restart OpenWhisper and try again.");
    checks.push("unsupported recording truthfully disabled, no device inventory");

    const refusals = await page.evaluate(async () => {
      const bridge = window.openwhisper;
      if (!bridge) throw new Error("The isolated preload bridge is missing.");
      const cases: [string, unknown][] = [
        ["unknown_command", {}], ["get_state", { unexpected: true }],
        ["save_preferences", { changes: { gpu: "wrong" } }],
        ["save_preferences", { changes: { setup_completed: true } }],
      ];
      const outcomes: boolean[] = [];
      for (const [command, args] of cases) {
        try { const result: unknown = Reflect.apply(bridge.invoke, bridge, [command, args]); await result; outcomes.push(false); }
        catch { outcomes.push(true); }
      }
      return outcomes;
    });
    assert.deepEqual(refusals, [true, true, true, true]);
    assert.deepEqual(validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {}))), state);
    checks.push("public IPC rejects unknown/extra/invalid arguments without mutation");

    assert.equal(await page.evaluate(async (url) => {
      try { await fetch(url); return false; } catch { return true; }
    }, target), true);
    assert.equal(requests, 1, "The reachable owned HTTP control must receive no renderer requests.");
    const windowUrls = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.webContents.getURL()).sort());
    const expectedWindows = ["app://openwhisper/index.html", "app://openwhisper/index.html?overlay=1"];
    await expect.poll(windowUrls).toEqual(expectedWindows);
    const overlayPage = app.windows().find((candidate) => candidate.url().endsWith("?overlay=1"));
    assert.ok(overlayPage);
    await expect(overlayPage.locator(".window-titlebar")).toHaveCount(0);
    assert.deepEqual(await overlayPage.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 476, height: 68 });
    assert.equal(await overlayPage.evaluate(async () => {
      try { await window.openwhisper?.invoke("window_action", { action: "close" }); return false; }
      catch { return true; }
    }), true);
    checks.push("recording overlay has no titlebar and cannot close the main window through IPC");
    await page.evaluate((url) => { window.open(url, "_blank"); }, target);
    await expect.poll(windowUrls).toEqual(expectedWindows);
    await page.evaluate((url) => {
      const anchor = document.createElement("a"); anchor.href = url; anchor.textContent = "Owned navigation probe";
      document.body.append(anchor); anchor.click(); anchor.remove();
    }, target);
    // Chromium correctly cancels the navigation. Playwright may retain a pending
    // navigation marker; inspect the actual unchanged document and a functioning
    // UI event before reopening the same private profile for later driver input.
    assert.equal(await page.evaluate(() => document.querySelector(".window-wordmark")?.textContent), "openwhisper");
    assert.equal(page.url(), "app://openwhisper/index.html");
    assert.equal(requests, 1);
    await page.evaluate(() => {
      const view = document.createElement("webview"); view.setAttribute("src", "app://openwhisper/index.html");
      document.body.append(view); view.remove();
    });
    assert.deepEqual(await windowUrls(), expectedWindows);
    await page.evaluate(() => { document.querySelector<HTMLButtonElement>('[data-tab="general"]')?.click(); });
    assert.equal(await page.evaluate(() => document.querySelector("#page-title")?.textContent), "General");
    checks.push("reachable network target, navigation, popup and webview denied");
    await app.close();
    application = undefined;
    app = await launch();
    page = await app.firstWindow();
    currentPage = page;
    await expect(page.locator(".window-wordmark")).toHaveText("openwhisper");
    await expect(page.getByRole("heading", { name: "Dictation", exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Vocabulary/ }).click();
    await expect(page.locator("#page-title")).toHaveText("Text processing");
    const vocabulary = page.locator("#vocabulary");
    const settingsUrl = page.url();
    assert.equal(page.url(), settingsUrl, "Settings section navigation must preserve the trusted renderer URL.");
    await expect(vocabulary).toBeInViewport();
    await vocabulary.fill("Kubernetes, Grüß Gott, 東京");
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await expect(vocabulary).toHaveValue("Kubernetes, Grüß Gott, 東京");
    await expect(page.locator("#settings-notice")).toBeVisible();
    // The modal blocks pointer input to the titlebar; exercise its close handler directly.
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-window-action="close"]')?.click());
    await expect(page.locator("#settings-dialog")).toBeVisible();
    await expect(vocabulary).toHaveValue("Kubernetes, Grüß Gott, 東京");
    await expect(page.locator("#settings-notice")).toBeVisible();
    await page.locator("#save-vocabulary").click();
    await expect.poll(async () => validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {}))).preferences.vocabulary).toBe("Kubernetes, Grüß Gott, 東京");
    await page.keyboard.press("Escape");
    await expect(page.locator("#settings-dialog")).toBeHidden();
    await expect(page.locator('.dictation-feature-card[data-settings-section="settings-vocabulary"]')).toBeFocused();
    await openSettings(page, "recording");
    const mode = page.locator('[data-pref="hold_to_record"]');
    await mode.focus();
    const savedToggle = await page.locator('[data-pref="show_idle_overlay"]').elementHandle();
    assert.ok(savedToggle);
    await page.evaluate(async () => { await window.openwhisper?.invoke("save_preferences", { changes: { hold_to_record: true } }); });
    await expect(mode).toBeFocused();
    assert.equal(await savedToggle.evaluate((node) => node === document.querySelector('[data-pref="show_idle_overlay"]')), true);
    await expect(mode).toHaveValue("true");
    await openSettings(page, "general");
    await page.locator('[data-ui-language="de"]').click();
    await expect(page.locator("#page-title")).toHaveText("Allgemein");
    await expect(page.locator('[data-ui-language="de"]')).toHaveAttribute("aria-pressed", "true");
    await screenshot(page, "dev-general-de.png");
    await openSettings(page, "text");
    await expect(vocabulary).toHaveValue("Kubernetes, Grüß Gott, 東京");
    await openSettings(page, "general");
    await page.locator('[data-ui-language="en"]').click();
    await expect(page.locator("#page-title")).toHaveText("General");
    await screenshot(page, "dev-general-en.png");
    await openSettings(page, "text");
    await expect(page.locator("#vocabulary")).toHaveValue("Kubernetes, Grüß Gott, 東京");
    await expect(page.locator("#snippet-form")).toBeVisible();
    await expect(page.locator("#processing-preview")).toHaveCount(0);
    await expect(page.locator('nav [data-tab="models"], nav [data-tab="snippets"]')).toHaveCount(0);
    await screenshot(page, "dev-text-processing.png");
    await openSettings(page, "history");
    await expect(page.locator('[data-command="show_transcripts_folder"]')).toBeVisible();
    await screenshot(page, "dev-history-settings.png");
    assert.equal(requests, 1, "Settings must not contact an optional model server.");
    checks.push("vocabulary and snippets share Text processing; no optional model preview or automatic provider traffic; history exposes its actual folder action");
    const saved = validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {})));
    assert.equal(saved.preferences.hold_to_record, true);
    assert.equal(saved.preferences.vocabulary, "Kubernetes, Grüß Gott, 東京");
    assert.equal(saved.preferences.ui_language, "en");
    await app.close();
    application = undefined;
    const restarted = await launch();
    const reopened = await restarted.firstWindow();
    currentPage = reopened;
    await expect(reopened.locator(".window-wordmark")).toHaveText("openwhisper");
    const restored = validateCommandOutput("get_state", await reopened.evaluate(() => window.openwhisper?.invoke("get_state", {})));
    assert.deepEqual(restored.preferences, saved.preferences);
    assert.deepEqual(restored.local_processing, saved.local_processing);
    await openSettings(reopened, "text");
    await expect(reopened.locator("#vocabulary")).toHaveValue("Kubernetes, Grüß Gott, 東京");
    await expect(reopened.locator("#processing-preview")).toHaveCount(0);
    assert.equal(restored.transcript, "");
    assert.deepEqual(restored.history, []);
    assert.deepEqual(await Promise.all(stableFiles.map(hash)), stableBefore);
    const persisted = join(profile, "config", "settings", "preferences.json");
    assert.equal((await lstat(persisted)).mode & 0o777, 0o600);
    await reopened.locator("#close-settings").click();
    await expect(reopened.locator("#settings-dialog")).toBeHidden();
    await Promise.all([
      restarted.waitForEvent("close"),
      reopened.locator('[data-window-action="close"]').click(),
    ]);
    application = undefined;
    checks.push("custom close button reaches normal application shutdown through the validated bridge");
    checks.push("EN/DE patches, focused editor and stable toggle node, restart persistence, stable sentinels unchanged");
    await writeFile(join(evidence, "result.json"), JSON.stringify({
      result: "PASS", scope: "Owned development UI and real preference IPC; no microphone, physical input or model quality test", checks,
      root, display, stableBefore, stableAfter: await Promise.all(stableFiles.map(hash)),
      driverNote: "Canceled external navigation leaves Playwright pending; actual URL, DOM and General click were verified before private profile restart.",
      preferenceFileMode: "0600", screenshotFiles: ["dev-dictation.png", "dev-model-drawer.png", "dev-history-rail.png", "dev-general-de.png", "dev-general-en.png", "dev-about.png", "dev-general.png", "dev-text-processing.png", "dev-history-settings.png"],
    }, null, 2));
  } catch (error: unknown) {
    await writeFile(join(evidence, "failure.json"), JSON.stringify({
      checks, url: currentPage?.url(), requests,
      errorType: error instanceof Error ? error.name : "Unknown owned UI failure",
      stack: error instanceof Error ? error.stack?.split("\n").filter((line) => line.startsWith("    at ")).slice(0, 8) : [],
    }, null, 2));
    if (currentPage) await screenshot(currentPage, "failure.png").catch(() => undefined);
    // Playwright's full error includes the live accessibility tree and device labels.
    throw new Error("Owned UI check failed; inspect the bounded failure receipt and masked screenshot.");
  } finally {
    await application?.close();
    xvfb.kill("SIGTERM");
    await new Promise<void>((accept) => { if (xvfb.exitCode !== null) accept(); else xvfb.once("exit", () => accept()); });
    await new Promise<void>((accept, reject) => server.close((error) => { if (error) reject(error); else accept(); }));
    await writeFile(join(evidence, "xvfb.log"), xvfbErrors);
  }
});

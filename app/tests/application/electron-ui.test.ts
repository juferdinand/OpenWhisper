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
  let previewMode: "normal" | "hold" | "reject" = "normal";
  let previewRequests = 0;
  const previewText = "Owned Deutsch 👩‍💻 العربية 日本語 <img src=x onerror=alert(1)>";
  const previewResult = "Owned structured plan: Deutsch 👩‍💻 العربية 日本語 <script>fixture</script>";
  const previewBodies: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      previewRequests += 1;
      const blocks: Buffer[] = [];
      request.on("data", (block: Buffer) => { blocks.push(block); });
      request.on("end", () => {
        const input: unknown = JSON.parse(Buffer.concat(blocks).toString("utf8"));
        previewBodies.push(input);
        if (previewMode === "hold") return;
        if (previewMode === "reject") {
          response.writeHead(401); response.end("Owned private diagnostic must never appear in the UI"); return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop",
          message: { role: "assistant", content: previewResult } }] }));
      });
      return;
    }
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
    for (let step = 0; step < 6; step++) {
      await page.locator("[data-setup-next]").click();
    }
    await page.locator('[data-command="complete_setup"]').click();
    await expect.poll(async () => validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {}))).preferences.setup_completed).toBe(true);
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
    await page.locator('[data-tab="about"]').click();
    await expect(page.locator(".version-badge")).toHaveText(`Version ${state.version} · Dev ${buildIdentifier} · Linux`);
    assert.equal(await page.locator(".about-brand img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 256), true);
    assert.equal(await page.evaluate(async () => {
      await document.fonts.ready;
      return Array.from(document.fonts).some((font) => font.family === "OpenWhisper Inter" && font.status === "loaded");
    }), true);
    await page.screenshot({ path: join(evidence, "dev-about.png") });
    await page.locator('[data-tab="models"]').click();
    await expect(page.locator("#development-model-directory")).toHaveText(state.model_directory);
    await page.screenshot({ path: join(evidence, "dev-models.png") });
    checks.push("visible Dev build identifier, original 256px icon/Inter assets and private model directory");
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

    await page.locator('[data-tab="general"]').click();
    const vocabulary = page.locator("#vocabulary");
    await vocabulary.fill("Kubernetes, Grüß Gott, 東京");
    await page.locator("#save-vocabulary").click();
    await expect.poll(async () => validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {}))).preferences.vocabulary).toBe("Kubernetes, Grüß Gott, 東京");
    await vocabulary.focus();
    const savedToggle = await page.locator('[data-pref="launch_at_login"]').elementHandle();
    assert.ok(savedToggle);
    await page.evaluate(async () => { await window.openwhisper?.invoke("save_preferences", { changes: { hold_to_record: true } }); });
    await expect(vocabulary).toBeFocused();
    assert.equal(await savedToggle.evaluate((node) => node === document.querySelector('[data-pref="launch_at_login"]')), true);
    await expect(page.locator('[data-pref="hold_to_record"]')).toHaveValue("true");
    await page.locator('[data-ui-language="de"]').click();
    await expect(page.locator("#page-title")).toHaveText("Allgemein");
    await expect(page.locator('[data-ui-language="de"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#vocabulary")).toHaveValue("Kubernetes, Grüß Gott, 東京");
    await page.screenshot({ path: join(evidence, "dev-general-de.png") });
    await page.locator('[data-ui-language="en"]').click();
    await expect(page.locator("#page-title")).toHaveText("General");
    await page.screenshot({ path: join(evidence, "dev-general-en.png") });
    await page.locator('[data-tab="models"]').click();
    await expect(page.locator("#processing-preview h2")).toHaveText("Text processing preview");
    await expect(page.locator("#processing-enabled")).not.toBeChecked();
    assert.equal(previewRequests, 0, "Opening optional controls must not contact a model server.");
    await page.locator("#processing-endpoint").fill(`http://127.0.0.1:${address.port}/v1`);
    await page.locator("#processing-model").fill("owned-model 日本語");
    await page.locator("#processing-enabled").check();
    await expect.poll(async () => {
      const value = validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {})));
      return value.local_processing;
    }).toMatchObject({ enabled: true, model: "owned-model 日本語", endpoint: `http://127.0.0.1:${address.port}/v1` });
    const enabledNode = await page.locator("#processing-enabled").elementHandle();
    assert.ok(enabledNode);
    await page.locator("#processing-input").fill(previewText);
    await page.locator("#processing-send").click();
    await expect(page.locator("#processing-result")).toHaveValue(previewResult);
    await expect(page.locator("#processing-feedback")).toHaveText("Preview ready. Review it before using it.");
    assert.equal(await enabledNode.evaluate((node) => node === document.querySelector("#processing-enabled")), true);
    const body = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string(), content: z.string() })) }).parse(previewBodies[0]);
    assert.equal(body.model, "owned-model 日本語");
    assert.equal(body.messages.find((message) => message.role === "user")?.content, previewText);
    assert.equal(await page.locator("#processing-preview script").count(), 0);
    assert.equal(await page.locator("#processing-preview img").count(), 0);
    const previewState = validateCommandOutput("get_state", await page.evaluate(() => window.openwhisper?.invoke("get_state", {})));
    assert.equal(previewState.transcript, "");
    assert.deepEqual(previewState.history, []);
    const featureFile = join(profile, "config", "settings", "local-processing.json");
    assert.equal((await lstat(featureFile)).mode & 0o777, 0o600);
    assert.equal((await readFile(featureFile, "utf8")).includes(previewText), false);
    assert.equal((await readFile(featureFile, "utf8")).includes(previewResult), false);
    previewMode = "hold";
    await page.locator("#processing-send").click();
    await expect.poll(() => previewRequests).toBe(2);
    await page.locator("#processing-cancel").click();
    await expect(page.locator("#processing-feedback")).toHaveText("Text processing cancelled; your dictation is unchanged");
    await expect(page.locator("#processing-input")).toHaveValue(previewText);
    previewMode = "normal";
    await page.locator("#processing-send").click();
    await expect(page.locator("#processing-result")).toHaveValue(previewResult);
    await expect.poll(() => previewRequests).toBe(3);
    previewMode = "reject";
    await page.locator("#processing-send").click();
    await expect(page.locator("#processing-feedback")).toHaveText("The local server rejected the request; check its model and authentication settings");
    await expect(page.locator("#processing-input")).toHaveValue(previewText);
    assert.equal((await page.locator("body").textContent())?.includes("Owned private diagnostic"), false);
    await page.locator('[data-ui-language="de"]').click();
    await expect(page.locator("#processing-preview h2")).toHaveText("Textverarbeitung ausprobieren");
    await expect(page.locator("#processing-input")).toHaveValue(previewText);
    await page.locator("#processing-preview h2").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, "dev-processing-profile-de.png") });
    await page.locator("#processing-result").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, "dev-processing-de.png") });
    await page.locator('[data-ui-language="en"]').click();
    await expect(page.locator("#processing-preview h2")).toHaveText("Text processing preview");
    await page.locator("#processing-preview h2").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, "dev-processing-profile-en.png") });
    await page.locator("#processing-result").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, "dev-processing-en.png") });
    assert.equal(await page.locator("main").evaluate((main) => main.scrollWidth <= main.clientWidth + 1), true);
    checks.push("actual Dev model-preview IPC, intact multilingual request, escaped renderer-only result, manual cancel/retry, categorical HTTP error, private 0600 profile and EN/DE");
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
    await reopened.locator('[data-tab="models"]').click();
    await expect(reopened.locator("#processing-enabled")).toBeChecked();
    await expect(reopened.locator("#processing-input")).toHaveValue("");
    await expect(reopened.locator("#processing-result")).toHaveValue("");
    assert.equal(restored.transcript, "");
    assert.deepEqual(restored.history, []);
    await restarted.close();
    application = undefined;
    await writeFile(featureFile, "{owned invalid optional profile", { mode: 0o600 });
    const recoveredApp = await launch();
    const recoveredPage = await recoveredApp.firstWindow();
    currentPage = recoveredPage;
    await expect(recoveredPage.locator(".window-wordmark")).toHaveText("openwhisper");
    const recovered = validateCommandOutput("get_state", await recoveredPage.evaluate(() => window.openwhisper?.invoke("get_state", {})));
    assert.deepEqual(recovered.preferences, saved.preferences);
    assert.equal(recovered.local_processing?.enabled, false);
    assert.equal(recovered.local_processing_invalid_profile, true);
    assert.equal(await readFile(featureFile, "utf8"), "{owned invalid optional profile");
    await recoveredPage.locator('[data-tab="models"]').click();
    await expect(recoveredPage.locator("#processing-profile-warning")).toBeVisible();
    await expect(recoveredPage.locator("#processing-enabled")).not.toBeChecked();
    await recoveredPage.locator("#processing-model").fill("owned repaired profile");
    await recoveredPage.locator("#processing-model").press("Tab");
    await expect(recoveredPage.locator("#processing-profile-warning")).toBeHidden();
    assert.equal((await readFile(featureFile, "utf8")).includes("owned repaired profile"), true);
    assert.equal(previewRequests, 4, "Corrupt profile recovery must not silently send any text.");
    checks.push("actual Dev startup preserves invalid optional bytes with disabled defaults; explicit edit repairs only its profile");
    assert.deepEqual(await Promise.all(stableFiles.map(hash)), stableBefore);
    const persisted = join(profile, "config", "settings", "preferences.json");
    assert.equal((await lstat(persisted)).mode & 0o777, 0o600);
    await Promise.all([
      recoveredApp.waitForEvent("close"),
      recoveredPage.locator('[data-window-action="close"]').click(),
    ]);
    application = undefined;
    checks.push("custom close button reaches normal application shutdown through the validated bridge");
    checks.push("EN/DE patches, focused editor and stable toggle node, restart persistence, stable sentinels unchanged");
    await writeFile(join(evidence, "result.json"), JSON.stringify({
      result: "PASS", scope: "P1/P5 owned development UI with fake model protocol; no dictation or real model quality parity", checks,
      root, display, stableBefore, stableAfter: await Promise.all(stableFiles.map(hash)),
      driverNote: "Canceled external navigation leaves Playwright pending; actual URL, DOM and General click were verified before private profile restart.",
      preferenceFileMode: "0600", screenshotFiles: ["dev-general-de.png", "dev-general-en.png", "dev-about.png", "dev-models.png", "dev-processing-profile-de.png", "dev-processing-profile-en.png", "dev-processing-de.png", "dev-processing-en.png"],
    }, null, 2));
  } catch (error: unknown) {
    await writeFile(join(evidence, "failure.json"), JSON.stringify({
      checks, url: currentPage?.url(), requests,
      body: await currentPage?.locator("body").textContent({ timeout: 1000 }).catch(() => "unavailable"),
      message: error instanceof Error ? error.message : "Unknown owned UI failure",
    }, null, 2));
    await currentPage?.screenshot({ path: join(evidence, "failure.png"), timeout: 1000 }).catch(() => undefined);
    throw error;
  } finally {
    await application?.close();
    xvfb.kill("SIGTERM");
    await new Promise<void>((accept) => { if (xvfb.exitCode !== null) accept(); else xvfb.once("exit", () => accept()); });
    await new Promise<void>((accept, reject) => server.close((error) => { if (error) reject(error); else accept(); }));
    await writeFile(join(evidence, "xvfb.log"), xvfbErrors);
  }
});

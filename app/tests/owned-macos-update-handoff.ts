import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { appStateSchema, preferencesSchema } from "../src/contracts/ui/state.js";
import { parseApplicationBuildModule } from "../src/contracts/application/build-identity.js";
import { pinnedRuntimeEnvironment } from "../scripts/runtime.js";
import { validateMacBundleMetadata } from "../src/main/build-selection.js";
import { MAIN_URL, OVERLAY_URL } from "../src/main/assets.js";
import { validateUniversalMacPackageMetadata } from "./fixtures/mac-package-metadata.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

function canonical(path: string): string { assert.ok(path.startsWith("/") && resolve(path) === path && !/[\u0000-\u001f\u007f]/u.test(path)); return path; }
const args = process.argv.slice(2); assert.equal(args.length, 10); assert.equal(args[0], "--package"); assert.equal(args[2], "--successor");
assert.equal(args[4], "--evidence"); assert.equal(args[6], "--source-commit"); assert.equal(args[8], "--successor-commit");
assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64"); assert.equal(process.getuid?.() === 0, false);
assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.equal(process.env["RUNNER_ENVIRONMENT"], "github-hosted");
assert.equal(process.env["OPENWHISPER_OWNED_MAC_UPDATE_TEST"], "1");
const sourceBundle = canonical(args[1] ?? ""), successorArchive = canonical(args[3] ?? ""), evidence = canonical(args[5] ?? "");
const expectedSourceCommit = z.string().regex(/^[a-f0-9]{40}$/u).parse(args[7]);
const expectedSuccessorCommit = z.string().regex(/^[a-f0-9]{40}$/u).parse(args[9]);
const harnessCommit = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env["GITHUB_SHA"]);
const checkedOutCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", shell: false });
assert.equal(checkedOutCommit.status, 0); assert.equal(checkedOutCommit.stdout.trim(), harnessCommit);
const runnerTemp = canonical(process.env["RUNNER_TEMP"] ?? "");
assert.ok([sourceBundle, successorArchive, evidence].every((path) => path.startsWith(`${runnerTemp}/`)));
const forbiddenRuntimeArgument = /^--(?:owned-macos-update-fixture|inspect(?:-|=|$)|remote-debugging(?:-|=|$)|debug(?:-|=|$)|test(?:-|=|$))/u;
assert.equal(await realpath(sourceBundle), sourceBundle); assert.equal((await lstat(sourceBundle)).isDirectory(), true);
await mkdir(evidence, { mode: 0o700 }); assert.equal(await realpath(evidence), evidence);
const run = (command: string, argv: readonly string[], timeout = 15_000): string => {
  const result = spawnSync(command, [...argv], { encoding: "utf8", shell: false, timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.signal !== null || result.status !== 0) throw new Error(`Owned Mac update command failed: ${command}.`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};
const versionFrom = (bundle: string): string => run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(bundle, "Contents/Info.plist")]).trim();
const currentVersion = versionFrom(sourceBundle); assert.equal(currentVersion, "0.3.1");
const source = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) });
const sourceInfo = source.parse(JSON.parse(await readFile(join(sourceBundle, "Contents/Resources/app/dist/resources/development-build.json"), "utf8")) as unknown);
assert.equal(sourceInfo.commit, expectedSourceCommit);
const currentBuild = parseApplicationBuildModule(await readFile(join(sourceBundle, "Contents/Resources/app/dist/main/application-build.js"), "utf8"));
assert.deepEqual(currentBuild, { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" });
const currentPlist: unknown = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(sourceBundle, "Contents/Info.plist")]));
validateMacBundleMetadata(currentBuild, currentVersion, currentPlist);
const currentDist = join(sourceBundle, "Contents/Resources/app/dist");
const currentSource = sourceInfo;
const currentMetadata = validateUniversalMacPackageMetadata({
  receipt: JSON.parse(await readFile(join(sourceBundle, "Contents/Resources/notices/mac-universal-validation-package.json"), "utf8")) as unknown,
  thinReceipts: { arm64: JSON.parse(await readFile(join(sourceBundle, "Contents/Resources/notices/architectures/arm64/Contents/Resources/notices/mac-stable-validation-package.json"), "utf8")) as unknown,
    x64: JSON.parse(await readFile(join(sourceBundle, "Contents/Resources/notices/architectures/x64/Contents/Resources/notices/mac-stable-validation-package.json"), "utf8")) as unknown },
  applicationBuild: currentBuild, source: currentSource,
  recordingModule: await readFile(join(currentDist, "main/development-recording-build.js"), "utf8"),
  host: { platform: "darwin", architecture: "arm64" },
});
assert.equal(currentMetadata.sourceVersion, currentVersion); assert.equal(currentMetadata.signingMode, "persistent-validation");
assert.equal(currentMetadata.updateConfigured, true);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", sourceBundle], 30_000);
const successorRoot = join(evidence, "successor-check"); await mkdir(successorRoot, { mode: 0o700 });
run("/usr/bin/ditto", ["-x", "-k", successorArchive, successorRoot], 120_000);
const successorBundle = join(successorRoot, "OpenWhisper.app"); assert.equal(versionFrom(successorBundle), "0.3.2");
const successorSource = source.parse(JSON.parse(await readFile(join(successorBundle, "Contents/Resources/app/dist/resources/development-build.json"), "utf8")) as unknown);
assert.match(successorSource.commit, /^[a-f0-9]{40}$/u); assert.notEqual(successorSource.commit, sourceInfo.commit);
assert.equal(successorSource.commit, expectedSuccessorCommit);
assert.equal((await readFile(join(successorBundle, "Contents/Resources/app/dist/resources/VERSION"), "utf8")).trim(), "0.3.2");
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", successorBundle], 30_000);
const installationRoot = join(evidence, "Installation Slot"), bundle = join(installationRoot, "OpenWhisper.app");
await mkdir(installationRoot, { mode: 0o700 }); run("/usr/bin/ditto", [sourceBundle, bundle], 120_000);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], 30_000);
const ownedHome = join(evidence, "home"), cacheDirectory = join(ownedHome, "Library/Caches/io.github.whisperfree/electron/cache");
await mkdir(ownedHome, { mode: 0o700 });
const legacySnippets = join(ownedHome, "Library/Application Support/WhisperFree/snippets.json");
await mkdir(join(ownedHome, "Library/Application Support/WhisperFree"), { recursive: true, mode: 0o700 });
await writeFile(legacySnippets, "[]\n", { flag: "wx", mode: 0o600 });
const executable = join(bundle, "Contents/MacOS/OpenWhisper"); assert.equal((await lstat(executable)).isFile(), true);
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(pinnedRuntimeEnvironment(process.env))) if (value !== undefined) environment[key] = value;
for (const key of Object.keys(environment)) if (key.startsWith("DYLD_") || key.startsWith("OPENWHISPER_") || key.startsWith("ELECTRON_FORCE_IS_PACKAGED") ||
  ["DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "PULSE_SERVER", "PIPEWIRE_REMOTE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"].includes(key)) delete environment[key];
environment["HOME"] = ownedHome; environment["TMPDIR"] = evidence;
let application: ElectronApplication | undefined, page: Page | undefined;
let stage = "launch-original", result: Record<string, unknown> = { status: "FAIL", harnessCommit, producerCommit: expectedSourceCommit };
try {
  application = await _electron.launch({ executablePath: executable, args: ["--owned-macos-update-fixture"], env: environment,
    chromiumSandbox: true, timeout: 30_000 });
  const originalProcess = application.process(), originalPid = originalProcess.pid;
  assert.ok(typeof originalPid === "number" && originalPid > 0);
  const originalClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => originalProcess.once("close", (code, signal) => accept({ code, signal })));
  page = await application.firstWindow(); await expect(page.locator(".sidebar-brand strong")).toHaveText("OpenWhisper", { timeout: 20_000 });
  assert.equal(page.url(), "app://openwhisper/index.html");
  const state = async () => appStateSchema.parse(await page!.evaluate(() => window.openwhisper!.invoke("get_state", {})));
  const before = await state(); assert.equal(before.version, "0.3.1"); assert.equal(before.updates.configured, true);
  assert.equal(before.macos?.updates_configured, true); assert.equal(before.preferences.setup_completed, false);
  await page.evaluate(() => window.openwhisper!.invoke("complete_setup", {}));
  await page.evaluate(() => window.openwhisper!.invoke("save_preferences", { changes: {
    ui_language: "en", vocabulary: "OwnedMacUpdatePreservationFixture", auto_check_updates: false } }));
  assert.equal((await state()).preferences.vocabulary, "OwnedMacUpdatePreservationFixture");
  const preferencesPath = join(ownedHome, "Library/Application Support/io.github.whisperfree/electron/settings/preferences.json");
  const preferenceBytes = await readFile(preferencesPath); const preferences = preferencesSchema.parse(JSON.parse(preferenceBytes.toString("utf8")) as unknown);
  assert.equal(preferences.setup_completed, true); assert.equal(preferences.vocabulary, "OwnedMacUpdatePreservationFixture");
  const migrationPaths = [join(ownedHome, "Library/Application Support/io.github.whisperfree/electron/migration.json"),
    join(ownedHome, "Library/Application Support/io.github.whisperfree/electron/legacy/snippets.json"),
    join(ownedHome, "Library/Application Support/io.github.whisperfree/electron/legacy/decoded.json"),
    join(ownedHome, "Library/Application Support/io.github.whisperfree/electron/legacy/conversion.json")];
  const migrationBefore = await Promise.all(migrationPaths.map(async (path) => {
    const bytes = await readFile(path); return createHash("sha256").update(bytes).digest("hex");
  }));
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const archiveBytes = await readFile(successorArchive), fixturePath = join(cacheDirectory, "owned-macos-successor.zip");
  await writeFile(fixturePath, archiveBytes, { flag: "wx", mode: 0o600 }); await chmod(fixturePath, 0o600);
  const originalPids = await application.evaluate(({ app }) => app.getAppMetrics().map((entry) => entry.pid));
  const originalOwnedPids = [...new Set([originalPid, ...originalPids])];
  stage = "normal-main-install-request";
  const started = await application.evaluate(({ app }) => {
    const operation: unknown = Reflect.get(app, "openWhisperRunOwnedMacUpdateFixture");
    if (typeof operation !== "function") throw new Error("Owned updater composition hook unavailable.");
    void (operation as () => Promise<void>)(); return true;
  });
  assert.equal(started, true);
  let updateTimer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_accept, reject) => { updateTimer = setTimeout(() => reject(new Error("Owned Mac updater did not close the original process.")), 120_000); });
  const exit = await Promise.race([originalClosed, timeout]); if (updateTimer) clearTimeout(updateTimer);
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  application = undefined;
  for (const pid of originalOwnedPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
  const successorExecutable = join(bundle, "Contents/MacOS/OpenWhisper");
  const successorPid = await waitForSuccessor(successorExecutable, originalPid);
  assert.notEqual(successorPid, originalPid);
  const installedVersion = versionFrom(bundle); assert.equal(installedVersion, "0.3.2");
  const installedBuild = source.parse(JSON.parse(await readFile(join(bundle, "Contents/Resources/app/dist/resources/development-build.json"), "utf8")) as unknown);
  assert.deepEqual(installedBuild, successorSource);
  const installedIdentity = parseApplicationBuildModule(await readFile(join(bundle, "Contents/Resources/app/dist/main/application-build.js"), "utf8"));
  validateMacBundleMetadata(installedIdentity, installedVersion, JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(bundle, "Contents/Info.plist")])) as unknown);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], 30_000);
  assert.deepEqual(await readFile(preferencesPath), preferenceBytes);
  const retainedPreferences = preferencesSchema.parse(JSON.parse((await readFile(preferencesPath)).toString("utf8")) as unknown);
  assert.equal(retainedPreferences.setup_completed, true); assert.equal(retainedPreferences.vocabulary, preferences.vocabulary);
  const migrationAfter = await Promise.all(migrationPaths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
  assert.deepEqual(migrationAfter, migrationBefore);
  const successorPids = await waitForProcessTree(successorPid);
  const quitReceipt = join(evidence, "successor-quit.json"), quitNonce = randomUUID();
  stage = "normal-successor-inspector-start";
  await assertInspectorPortVacant(); process.kill(successorPid, "SIGUSR1");
  const observedSuccessor = await waitForInspectorSuccessor({ executable: successorExecutable, appPath: join(bundle, "Contents/Resources/app"),
    sourceCommit: successorSource.commit, version: "0.3.2", expectedPid: successorPid, uid: process.getuid!(), quitReceipt, quitNonce,
    vocabulary: preferences.vocabulary }, (nextStage) => { stage = nextStage; });
  assert.equal(observedSuccessor.pid, successorPid); assert.equal(observedSuccessor.executable, successorExecutable);
  assert.equal(observedSuccessor.uid, process.getuid!()); assert.equal(observedSuccessor.argv.some((argument) => forbiddenRuntimeArgument.test(argument)), false);
  assert.equal(observedSuccessor.appPath, join(bundle, "Contents/Resources/app")); assert.equal(observedSuccessor.version, "0.3.2");
  assert.equal(observedSuccessor.sourceCommit, successorSource.commit);
  assert.equal(observedSuccessor.state.preferences.setup_completed, true);
  assert.equal(observedSuccessor.state.preferences.vocabulary, preferences.vocabulary);
  assert.equal(observedSuccessor.state.updates.configured, true); assert.equal(observedSuccessor.state.version, "0.3.2");
  await waitForPidExit(successorPid);
  const quit = z.object({ pid: z.int().positive(), exitCode: z.int(), nonce: z.string().uuid() })
    .parse(JSON.parse(await readFile(quitReceipt, "utf8")) as unknown);
  assert.deepEqual(quit, { pid: successorPid, exitCode: 0, nonce: quitNonce });
  for (const pid of successorPids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(await readFile(preferencesPath), preferenceBytes);
  result = { status: "PASS", stage, harnessCommit, producerCommit: expectedSourceCommit, oldVersion: "0.3.1", successorVersion: installedVersion,
    oldSourceCommit: sourceInfo.commit, successorSourceCommit: installedBuild.commit,
    originalMainPid: originalPid, originalOwnedPids, successorPid, successorOwnedPids: successorPids,
    originalProcessExit: exit, preferences: { setupCompleted: retainedPreferences.setup_completed,
      vocabularySha256: createHash("sha256").update(retainedPreferences.vocabulary).digest("hex"), byteIdentical: true },
    migrationFilesByteIdentical: true, ordinarySuccessorQuit: "Electron app.quit() receipt exit code 0; all recorded PIDs absent",
    scope: "Actual persistent same-identity Universal 0.3.1 predecessor to private arm64 0.3.2 successor install on an Apple Silicon runner through the normal main coordinator, real native-owner retirement, filesystem transaction and fixed-path relaunch; successor is arm64 thin only; 0.2.5 is publisher-continuity oracle only; offline fixture feed/download, no microphone, physical input, notarization, production HTTPS feed or release." };
} finally {
  if (application) await application.close().catch(() => {});
  await writeFile(join(evidence, "result.json"), `${JSON.stringify({ ...result, stage }, null, 2)}\n`, { mode: 0o600 });
}
async function assertInspectorPortVacant(): Promise<void> {
  let occupied = false;
  try { const response = await fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(1000) }); occupied = true; await response.body?.cancel(); }
  catch { /* A closed local inspector port is expected before successor observation. */ }
  assert.equal(occupied, false, "The owned runner inspector port must be vacant before signalling the successor.");
}
async function waitForInspectorSuccessor(
  input: Readonly<{ executable: string; appPath: string; sourceCommit: string; version: string;
    expectedPid: number; uid: number; quitReceipt: string; quitNonce: string; vocabulary: string }>,
  setStage: (stage: "normal-successor-identity" | "normal-successor-state" | "normal-successor-quit") => void,
): Promise<{ pid: number; uid: number; executable: string; argv: string[]; appPath: string; version: string;
  sourceCommit: string; state: ReturnType<typeof appStateSchema.parse> }> {
  const deadline = Date.now() + 30_000;
  let targetUrl: string | undefined;
  while (Date.now() < deadline) {
    let targets: unknown;
    try { const response = await fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(1000) });
      if (response.ok) targets = await response.json() as unknown; }
    catch { /* SIGUSR1 inspector startup is asynchronous. */ }
    if (Array.isArray(targets)) {
      const nodeTargets = z.array(z.object({ type: z.string(), webSocketDebuggerUrl: z.string() })).parse(targets)
        .filter((entry) => entry.type === "node");
      if (nodeTargets.length > 1) throw new Error("Owned successor inspector exposed multiple Node targets.");
      if (nodeTargets.length === 1) { targetUrl = nodeTargets[0]!.webSocketDebuggerUrl; break; }
    }
    await new Promise((accept) => setTimeout(accept, 250));
  }
  if (!targetUrl) throw new Error("The fixed-path successor inspector was unavailable.");
  setStage("normal-successor-identity");
  const identitySchema = z.object({ pid: z.int().positive(), uid: z.int().nonnegative(), executable: z.string(), argv: z.array(z.string()),
    appPath: z.string(), version: z.string(), sourceCommit: z.string() });
  const identity = identitySchema.parse(await inspectorEvaluate(targetUrl, `(async()=>{
    const app = process.getBuiltinModule("module").createRequire(${JSON.stringify(join(input.appPath, "package.json"))})("electron").app;
    const fs = process.getBuiltinModule("fs");
    return { pid: process.pid, uid: process.getuid(), executable: process.execPath, argv: process.argv,
      appPath: app.getAppPath(), version: app.getVersion(),
      sourceCommit: JSON.parse(fs.readFileSync(${JSON.stringify(join(input.appPath, "dist/resources/development-build.json"))}, "utf8")).commit };
  })()`));
  const matchesIdentity = (value: typeof identity) => value.pid === input.expectedPid && value.uid === input.uid && value.executable === input.executable &&
    value.appPath === input.appPath && value.version === input.version && value.sourceCommit === input.sourceCommit &&
    !value.argv.some((argument) => forbiddenRuntimeArgument.test(argument));
  if (!matchesIdentity(identity)) throw new Error("Owned successor identity check failed.");

  const readinessSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pending"), reason: z.enum(["app-not-ready", "window-absent", "window-loading", "preload-not-ready"]) }),
    z.object({ kind: z.literal("failure"), reason: z.enum(["identity-mismatch", "multiple-main-windows", "unexpected-main-url", "state-query-failed"]) }),
    z.object({ kind: z.literal("ready"), identity: identitySchema, state: z.unknown() }),
  ]);
  setStage("normal-successor-state");
  while (Date.now() < deadline) {
    const observed = readinessSchema.parse(await inspectorEvaluate(targetUrl, `(async()=>{
      const { app, BrowserWindow } = process.getBuiltinModule("module").createRequire(${JSON.stringify(join(input.appPath, "package.json"))})("electron");
      const fs = process.getBuiltinModule("fs");
      const sourceCommit = JSON.parse(fs.readFileSync(${JSON.stringify(join(input.appPath, "dist/resources/development-build.json"))}, "utf8")).commit;
      const identity = { pid: process.pid, uid: process.getuid(), executable: process.execPath, argv: process.argv,
        appPath: app.getAppPath(), version: app.getVersion(), sourceCommit };
      if (process.pid !== ${input.expectedPid} || process.getuid() !== ${input.uid} || process.execPath !== ${JSON.stringify(input.executable)} ||
        app.getAppPath() !== ${JSON.stringify(input.appPath)} || app.getVersion() !== ${JSON.stringify(input.version)} ||
        sourceCommit !== ${JSON.stringify(input.sourceCommit)} || process.argv.some((argument) => ${forbiddenRuntimeArgument}.test(argument))) {
        return { kind: "failure", reason: "identity-mismatch" };
      }
      if (!app.isReady()) return { kind: "pending", reason: "app-not-ready" };
      const windows = BrowserWindow.getAllWindows();
      const mainWindows = [];
      let notLoaded = false;
      for (const candidate of windows) {
        const url = candidate.webContents.getURL();
        if (url === ${JSON.stringify(OVERLAY_URL)}) continue;
        if (candidate.webContents.isLoading() || !url || url === "about:blank") { notLoaded = true; continue; }
        if (url === ${JSON.stringify(MAIN_URL)}) mainWindows.push(candidate);
        else return { kind: "failure", reason: "unexpected-main-url" };
      }
      if (mainWindows.length > 1) return { kind: "failure", reason: "multiple-main-windows" };
      if (notLoaded) return { kind: "pending", reason: "window-loading" };
      if (mainWindows.length === 0) return { kind: "pending", reason: "window-absent" };
      const window = mainWindows[0];
      let rendererReady;
      try {
        rendererReady = await window.webContents.executeJavaScript("({ loaded: document.readyState === 'complete', bridge: typeof window.openwhisper?.invoke === 'function' })");
      } catch {
        return { kind: "failure", reason: "state-query-failed" };
      }
      if (!rendererReady.loaded) return { kind: "pending", reason: "window-loading" };
      if (!rendererReady.bridge) return { kind: "pending", reason: "preload-not-ready" };
      let state;
      try { state = await window.webContents.executeJavaScript("window.openwhisper.invoke('get_state', {})"); }
      catch { return { kind: "failure", reason: "state-query-failed" }; }
      return { kind: "ready", identity, state };
    })()`));
    if (Date.now() >= deadline) throw new Error("Owned successor readiness deadline expired.");
    if (observed.kind === "pending") {
      await new Promise((accept) => setTimeout(accept, 250));
      continue;
    }
    if (observed.kind === "failure") throw new Error(`Owned successor ${observed.reason} check failed.`);
    if (!matchesIdentity(observed.identity)) throw new Error("Owned successor identity changed during readiness check.");
    const state = appStateSchema.safeParse(observed.state);
    if (!state.success || !state.data.preferences.setup_completed || state.data.preferences.vocabulary !== input.vocabulary ||
      !state.data.updates.configured || state.data.version !== input.version) throw new Error("Owned successor state validation failed.");
    const value = { ...observed.identity, state: state.data };
    setStage("normal-successor-quit");
    const final = await inspectorEvaluate(targetUrl, `(async()=>{
      const { app } = process.getBuiltinModule("module").createRequire(${JSON.stringify(join(input.appPath, "package.json"))})("electron");
      const fs = process.getBuiltinModule("fs");
      const sourceCommit = JSON.parse(fs.readFileSync(${JSON.stringify(join(input.appPath, "dist/resources/development-build.json"))}, "utf8")).commit;
      if (process.pid !== ${input.expectedPid} || process.getuid() !== ${input.uid} || process.execPath !== ${JSON.stringify(input.executable)} ||
        app.getAppPath() !== ${JSON.stringify(input.appPath)} || app.getVersion() !== ${JSON.stringify(input.version)} ||
        sourceCommit !== ${JSON.stringify(input.sourceCommit)} || process.argv.some((argument) => ${forbiddenRuntimeArgument}.test(argument))) {
        throw new Error("OWNED_SUCCESSOR_IDENTITY_CHANGED");
      }
      app.once("quit", (_event, exitCode) => fs.writeFileSync(${JSON.stringify(input.quitReceipt)},
        JSON.stringify({ pid: process.pid, exitCode, nonce: ${JSON.stringify(input.quitNonce)} }), { flag: "wx", mode: 0o600 }));
      setTimeout(() => app.quit(), 1000);
      return true;
    })()`);
    if (final !== true) throw new Error("Owned successor quit scheduling failed.");
    return { ...value, state: state.data };
  }
  throw new Error("Owned successor readiness deadline expired.");
}
async function inspectorEvaluate(url: string, expression: string): Promise<unknown> {
  const parsed = new URL(url); assert.equal(parsed.protocol, "ws:"); assert.equal(parsed.hostname, "127.0.0.1"); assert.equal(parsed.port, "9229");
  const socket = new WebSocket(parsed.href); await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("Owned inspector connection timed out.")), 3000);
    socket.addEventListener("open", () => { clearTimeout(timer); accept(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Owned inspector connection failed.")); }, { once: true });
  });
  try {
    const response = await new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned inspector evaluation timed out.")), 10_000);
      socket.addEventListener("message", (event) => {
        const value: unknown = JSON.parse(String(event.data));
        if (typeof value === "object" && value !== null && Reflect.get(value, "id") === 1) { clearTimeout(timer); accept(value); }
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    const result = z.object({ result: z.object({ result: z.object({ value: z.unknown() }), exceptionDetails: z.unknown().optional() }) }).parse(response).result;
    if (result.exceptionDetails !== undefined) throw new Error("Owned successor inspector evaluation failed.");
    return result.result.value;
  } finally { socket.close(); }
}
console.log(JSON.stringify(result));

async function waitForSuccessor(executable: string, previous: number): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const pids = processIds(executable).filter((pid) => pid !== previous);
    if (pids.length === 1) return pids[0]!;
    if (pids.length > 1) throw new Error("More than one owned successor process is running.");
    await new Promise((accept) => setTimeout(accept, 250));
  }
  throw new Error("The fixed-path successor process did not start.");
}
async function waitForProcessTree(root: number): Promise<number[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const records = processTable(), children = new Set<number>([root]); let changed = true;
    while (changed) { changed = false; for (const [pid, parent] of records) if (children.has(parent) && !children.has(pid)) { children.add(pid); changed = true; } }
    if (children.size > 1) return [...children];
    await new Promise((accept) => setTimeout(accept, 100));
  }
  return [root];
}
async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return; throw error; }
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error("The successor did not exit after normal Quit.");
}
function processTable(): Map<number, number> {
  const output = run("/bin/ps", ["-axo", "pid=,ppid="]); const result = new Map<number, number>();
  for (const line of output.split("\n")) { const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line); if (match) result.set(Number(match[1]), Number(match[2])); }
  return result;
}
function processIds(executable: string): number[] {
  const output = run("/bin/ps", ["-axo", "pid=,command="]);
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    return match && (match[2] === executable || match[2]!.startsWith(`${executable} `)) ? [Number(match[1])] : [];
  });
}

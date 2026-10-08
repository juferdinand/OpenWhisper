import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, screen, session, shell, systemPreferences, Tray } from "electron";
import { deliverClipboard } from "../services/clipboard-output.js";
import { WaylandClipboard } from "../services/wayland-clipboard.js";
import { portalPasteStateSchema } from "../platforms/linux/shared/portal-paste.js";
import type { IpcMainInvokeEvent } from "electron";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  appStateSchema, modelSchema, preferencesSchema, validateEvent, MAX_USER_TEXT_BYTES, MAX_UI_REQUEST_BYTES,
  type AppState, type EventName, type EventPayload,
} from "../contracts/ui.js";
import { PreferenceStore } from "../services/preferences.js";
import type { HostProfile } from "../services/host-profile.js";
import type { BuildIdentity } from "../contracts/build-identity.js";
import { APPLICATION_BUILD } from "./application-build.js";
import { selectApplicationBuild } from "./build-selection.js";
import { initializeStableLinuxProfile, initializeStableMacosProfile } from "./stable-profile-startup.js";
import { verifyMacApplicationBundle, macosMigrationContext } from "./macos-stable-admission.js";
import { StableMigrationError } from "../contracts/stable-migration.js";
import { PrivateStateStore } from "../services/private-state.js";
import { LocalProcessingService, LocalProcessingError } from "../services/local-processing.js";
import {
  localProcessingProfileSchema, defaultLocalProcessingProfile, applyLocalProcessingProfilePatch,
} from "../contracts/local-processing.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../services/profiles.js";
import { CONTENT_SECURITY_POLICY, MAIN_URL, OVERLAY_URL, readApplicationAsset } from "./assets.js";
import { createUiDispatcher, uiFailure, type UiSender } from "./ipc.js";
import { ModelInventory, type InstalledModel } from "../services/model-inventory.js";
import { ModelDownloads } from "../services/model-download.js";
import { recordingRequestSchema } from "../core/recording.js";
import type { RecordingSource } from "../workers/recording-host-protocol.js";
import { recordingSnapshotSchema } from "../workers/recording-host-protocol.js";
import { DEVELOPMENT_RECORDING_BUILD } from "./development-recording-build.js";
import { developmentRecordingDescriptorSchema, type DevelopmentRecordingDescriptor } from "./development-recording-descriptor.js";
import { DevelopmentRecordingHost, developmentPulseServer } from "./development-recording-host.js";
import { saveTranscript } from "../services/development-transcripts.js";
import { DevelopmentPlatformHost } from "./development-platform-host.js";
import { createRecordingControlPort } from "./recording-control.js";
import { portalShortcutStateSchema } from "../platforms/linux/shared/portal-shortcuts.js";
import { KdeKeyCapture } from "../platforms/linux/kde/key-capture.js";
import { modifierOnly } from "../platforms/linux/kde/keyboard.js";
import { buildTrayMenu } from "./tray-menu.js";
import { overlayWindowOptions, shouldShowRecordingOverlay, supportsInactiveRecordingOverlay, waylandOverlayWindowOptions } from "./recording-overlay.js";
import { WaylandRecordingOverlay } from "./wayland-recording-overlay.js";
import { MacosShortcut } from "./macos-shortcut.js";
import { MacosPaste } from "./macos-paste.js";
import { MacosAutostart } from "./macos-autostart.js";
import { LinuxAutostart, selectLinuxAutostartExecutable } from "../services/linux-autostart.js";
import { createRequire } from "node:module";
import { routeControlStartup } from "./control-startup.js";
import { createControlAdapter } from "../platforms/linux/shared/control-adapter.js";
import { LinuxBus } from "../platforms/linux/shared/bus.js";
import { verifyDevelopmentLinuxBusArtifact } from "../services/development-artifact.js";

const distribution = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let window: BrowserWindow | undefined;

function selectedProfile(): string | undefined {
  const index = process.argv.indexOf("--dev-profile");
  if (index < 0) return undefined;
  const path = process.argv[index + 1];
  if (!path || path.startsWith("--") || process.argv.indexOf("--dev-profile", index + 1) >= 0) {
    throw new Error("A single explicit development profile path is required.");
  }
  return path;
}

function sender(event: IpcMainInvokeEvent): UiSender {
  return {
    webContentsId: event.sender.id,
    mainFrame: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
    url: event.senderFrame?.url ?? "",
  };
}

interface ApplicationBootstrap {
  readonly identity: BuildIdentity;
  readonly profile: HostProfile;
  readonly version: string;
  readonly build: { readonly commit: string; readonly modified: boolean };
  readonly descriptor: DevelopmentRecordingDescriptor | null;
}

/** Awaited at module scope so profile migration and path setup finish before Electron becomes ready. */
async function prepareApplication(): Promise<ApplicationBootstrap> {
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  const version = (await readFile(join(distribution, "resources/VERSION"), "utf8")).trim();
  const appPath = await realpath(app.getAppPath());
  const manifest: unknown = JSON.parse(await readFile(join(appPath, "package.json"), "utf8"));
  const packageVersion = z.object({ version: z.string() }).parse(manifest).version;
  const identity = selectApplicationBuild({ build: APPLICATION_BUILD, argv: process.argv,
    platform: process.platform, architecture: process.arch, packaged: app.isPackaged,
    executable: await realpath(process.execPath), appPath, resourcesPath: await realpath(process.resourcesPath),
    distribution: await realpath(distribution), projectVersion: version, packageVersion });
  const descriptor = DEVELOPMENT_RECORDING_BUILD === null ? null : developmentRecordingDescriptorSchema.parse(DEVELOPMENT_RECORDING_BUILD);
  if (descriptor && (descriptor.platform !== process.platform || descriptor.architecture !== process.arch)) {
    throw new Error("The recording build does not match this runtime.");
  }
  if (identity.kind === "stable" && (!descriptor || descriptor.platform === "linux" && !descriptor.platformServices)) {
    throw new Error("The stable build requires its matching recording services.");
  }
  const buildRaw: unknown = JSON.parse(await readFile(join(distribution, "resources/development-build.json"), "utf8"));
  const build = z.strictObject({ commit: z.string().regex(/^([a-f0-9]{40}|source)$/), modified: z.boolean() }).parse(buildRaw);
  const storage = {
    home: homedir(),
    ...(process.env["XDG_CONFIG_HOME"] ? { configHome: process.env["XDG_CONFIG_HOME"] } : {}),
    ...(process.env["XDG_DATA_HOME"] ? { dataHome: process.env["XDG_DATA_HOME"] } : {}),
    ...(process.env["XDG_CACHE_HOME"] ? { cacheHome: process.env["XDG_CACHE_HOME"] } : {}),
  };
  let profile: HostProfile;
  if (identity.kind === "stable" && process.platform === "darwin") {
    verifyMacApplicationBundle(identity, version, await realpath(process.execPath));
    let loginStatus: unknown;
    try { loginStatus = app.getLoginItemSettings({ type: "mainAppService" }).status; }
    catch { /* Preserve an unknown service fact instead of treating it as disabled. */ }
    let context: unknown;
    try {
      context = macosMigrationContext({ languages: app.getPreferredSystemLanguages(), architecture: process.arch,
        loginStatus,
        catalog: JSON.parse(await readFile(join(distribution, "resources/models.json"), "utf8")) as unknown });
    } catch (error: unknown) {
      // A completed migration can retain edited state without querying unavailable initial login facts.
      if (!(error instanceof StableMigrationError && error.code === "LOGIN_STATE_UNKNOWN")) throw error;
    }
    profile = await initializeStableMacosProfile({ home: storage.home, platform: "darwin" }, context);
  } else if (identity.kind === "stable") {
    profile = await initializeStableLinuxProfile({ ...storage, platform: "linux" });
  } else {
    const explicitRoot = selectedProfile();
    profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ ...storage, ...(explicitRoot ? { explicitRoot } : {}) }));
  }
  if (app.isReady()) throw new Error("Application profile setup must precede Electron readiness.");
  app.setName(profile.productName);
  app.setPath("userData", identity.kind === "stable" ? dirname(profile.paths.settings) : profile.roots.config);
  app.setPath("sessionData", profile.paths.session);
  app.setAppLogsPath(profile.paths.logs);
  app.commandLine.appendSwitch("disk-cache-dir", profile.paths.cache);
  if (process.platform === "linux") app.setDesktopName(`${profile.appId}.desktop`);
  return { identity, profile, version, build, descriptor };
}

async function start({ identity, profile, version, build, descriptor }: ApplicationBootstrap): Promise<void> {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); }
  });
  app.on("activate", () => {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); }
  });
  app.on("window-all-closed", () => { app.quit(); });
  await app.whenReady();
  const preferences = await PreferenceStore.open(profile);
  const processingProfile = await PrivateStateStore.open(
    join(profile.paths.settings, "local-processing.json"), localProcessingProfileSchema, defaultLocalProcessingProfile(),
    1024 * 1024, { invalidContent: "preserve-and-default" },
  );
  const processing = new LocalProcessingService();
  const rawCatalog: unknown = JSON.parse(await readFile(join(distribution, "resources/models.json"), "utf8"));
  const catalog = z.object({ models: z.array(modelSchema).min(1).max(128) }).parse(rawCatalog);
  const inventory = await ModelInventory.open(profile, rawCatalog);
  let installed: readonly InstalledModel[] = await inventory.installed();
  let sources: readonly RecordingSource[] = [];
  let audioServer: string | undefined;
  let host: DevelopmentRecordingHost | undefined;
  let configured = false;
  let recordingControl = false, cancelRequested = false;
  let recordingOperation: Promise<unknown> | undefined;
  let shutdownInProgress = false, shutdownComplete = false;
  let overlay: BrowserWindow | undefined, overlayReady = false;
  let waylandOverlay: WaylandRecordingOverlay | undefined;
  let tray: Tray | undefined, trayKey = "";
  let macShortcut: MacosShortcut | undefined;
  let recording = recordingSnapshotSchema.parse({ phase: "idle", generation: 0, elapsedMs: 0, level: 0,
    busy: false, recoveryAvailable: false, error: null, transcript: "" });
  let message = "", inferenceProgress = 0;
  let download: string | null = null, downloadProgress = 0;
  let downloading: Promise<void> | undefined, downloadAbort: AbortController | undefined;
  const history = await PrivateStateStore.open(join(profile.paths.history, "history.json"),
    z.array(z.string().max(MAX_USER_TEXT_BYTES)).max(20), [], 8 * 1024 * 1024, { invalidContent: "preserve-and-default" });
  let notify = (): void => {};
  let autostart: LinuxAutostart | MacosAutostart | undefined;
  let loginFact: { readonly requested: boolean; readonly pending?: boolean } | undefined;
  let loginRefresh = 0;
  const refreshLogin = async (): Promise<void> => {
    const generation = ++loginRefresh;
    try { const fact = await autostart?.status(); if (generation === loginRefresh) loginFact = fact; }
    catch { if (generation === loginRefresh) loginFact = undefined; }
  };
  if (identity.kind === "stable") {
    try {
      if (process.platform === "darwin") autostart = MacosAutostart.open({ appId: profile.appId, app });
      else if (process.platform === "linux") {
        const executable = selectLinuxAutostartExecutable({ build: identity, packaged: app.isPackaged,
          executable: await realpath(process.execPath), appPath: await realpath(app.getAppPath()) });
        if (executable) autostart = await LinuxAutostart.open({ appId: profile.appId,
          configHome: dirname(profile.roots.config),
          configDirs: (process.env["XDG_CONFIG_DIRS"] || "/etc/xdg").split(":").filter(Boolean), executable });
      }
    } catch { /* Keep persisted requests intact when installation or OS facts are unavailable. */ }
    await refreshLogin();
  }
  const downloads = await ModelDownloads.open(profile, inventory, { progress: (value) => {
    downloadProgress = value.total > 0 ? Math.min(1, value.received / value.total) : 0; notify();
  } });
  const refreshModels = async (): Promise<void> => { installed = await inventory.installed(); };
  const macRecording = descriptor?.platform === "darwin";
  if (macRecording && identity.kind === "development" && preferences.snapshot().hold_to_record) await preferences.patch({ hold_to_record: false });
  const waylandClipboard = descriptor?.platform === "linux" && process.env["XDG_SESSION_TYPE"] === "wayland"
    ? new WaylandClipboard() : undefined;
  const clipboardOutput = waylandClipboard ?? clipboard;
  let microphoneAllowed = macRecording && systemPreferences.getMediaAccessStatus("microphone") === "granted";
  let accessibilityAllowed = macRecording && systemPreferences.isTrustedAccessibilityClient(false);
  const macPaste = macRecording ? MacosPaste.create({
    accessibilityGranted: () => systemPreferences.isTrustedAccessibilityClient(false),
    targetAllowed: () => !shutdownInProgress && !!window && !window.isDestroyed() && !window.isFocused() && !overlay?.isFocused(),
  }) : undefined;
  let platformHost: DevelopmentPlatformHost | undefined;
  let shortcut = portalShortcutStateSchema.parse({ available: false, configuring: false, label: null, result: "NONE" });
  let pasteState = portalPasteStateSchema.parse({ available: false, configuring: false, ready: false, result: "NONE" });
  let keyCapture: KdeKeyCapture | undefined;
  let deliveryNotice = "";
  if (descriptor) {
    host = await DevelopmentRecordingHost.open(resolve(distribution, ".."), descriptor, inventory, {
      recoveryPath: profile.paths.recovery,
      snapshot: (value) => { recording = value; if (value.phase !== "error") message = "";
        if (value.phase === "starting" || value.phase === "recording") deliveryNotice = ""; notify(); },
      progress: (value) => { inferenceProgress = recording.elapsedMs > 0
        ? Math.min(1, value.completedSamples / (recording.elapsedMs * 16)) : 0; notify(); },
      delivery: { deliver: async (text, context) => {
        if (context.signal.aborted) return { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false };
        const oversized = Buffer.byteLength(text, "utf8") > MAX_USER_TEXT_BYTES;
        if (oversized && preferences.snapshot().keep_history) {
          try { await saveTranscript(profile, text); }
          catch { return { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false }; }
        }
        if (context.signal.aborted) return { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false };
        const wantsPaste = preferences.snapshot().output === "paste";
        const delivered = await deliverClipboard(text, context, { writeText: (text) => clipboardOutput.writeText(text), readText: () => clipboardOutput.readText(),
          ...(wantsPaste ? { paste: async () => {
            try {
              if (macPaste) { accessibilityAllowed = systemPreferences.isTrustedAccessibilityClient(false); return await macPaste.paste(); }
              return await platformHost?.paste() ?? false;
            }
            catch { pasteState = { ...pasteState, ready: false, available: false, result: "FAILED" }; notify(); return false; }
          } } : {}) });
        if (!delivered.clipboardConfirmed) return delivered;
        if (wantsPaste && delivered.outcome === "clipboard") deliveryNotice = "Text copied; automatic paste is unavailable. Paste it from the clipboard.";
        if (!oversized && preferences.snapshot().keep_history) {
          // History is secondary to the already confirmed clipboard commit.
          void history.update((current) => {
            const next = [text, ...current].slice(0, 20);
            while (next.length > 1 && Buffer.byteLength(JSON.stringify(next), "utf8") > 6 * 1024 * 1024) next.pop();
            if (Buffer.byteLength(JSON.stringify(next), "utf8") > 8 * 1024 * 1024) return current;
            return next;
          }).then(notify, () => { message = "Text copied; history could not be saved."; notify(); });
        }
        return delivered;
      } },
    });
    if (descriptor.platform === "linux") {
      try { audioServer = await developmentPulseServer(); sources = await host.enumerate(audioServer); }
      catch { message = "A local audio server is not available."; }
    }
  }
  const platform = process.platform === "darwin" ? "macos" : "linux";
  const localeSchema = z.record(z.string(), z.string());
  const trayLocales = {
    en: localeSchema.parse(JSON.parse(await readFile(join(distribution, "resources/locales/en.json"), "utf8")) as unknown),
    de: localeSchema.parse(JSON.parse(await readFile(join(distribution, "resources/locales/de.json"), "utf8")) as unknown),
  };
  const state = (): AppState => appStateSchema.parse({
    updates: { configured: false, status: "idle", version: null, progress: 0, error: null, package: identity.kind === "stable" ? platform === "macos" ? "macos" : "deb" : "development" },
    launch_at_login_available: !!autostart && loginFact !== undefined,
    platform,
    ...(platform === "macos" ? { macos: {
      microphone_allowed: microphoneAllowed, recording_shortcut: macShortcut?.state().configuring ?? false,
      shortcut_toggle_only: macRecording, clipboard_restore_available: false,
      shortcut_hint: "Press and release a keyboard key. Escape cancels.",
      editor: "", recommended: [], updates_configured: false, launch_at_login_pending: loginFact?.pending ?? false,
    } } : {}),
    version, status: recording.phase === "starting" ? "recording"
      : ["stopping", "restoring", "discarding"].includes(recording.phase) ? "transcribing" : recording.phase,
    message: message || deliveryNotice || (Buffer.byteLength(recording.transcript, "utf8") > MAX_USER_TEXT_BYTES
      ? "The complete transcript exceeds the preview size. Use Copy to retrieve the full text."
      : recording.error ? `Recording failed: ${recording.error}.` : descriptor ? "" : "Recording is not available in this development preview."),
    transcript: Buffer.byteLength(recording.transcript, "utf8") <= MAX_USER_TEXT_BYTES ? recording.transcript : "",
    transcript_preview_omitted: Buffer.byteLength(recording.transcript, "utf8") > MAX_USER_TEXT_BYTES,
    history: history.snapshot().filter((text) => Buffer.byteLength(text, "utf8") <= MAX_USER_TEXT_BYTES),
    preferences: { ...preferences.snapshot(), ...(loginFact ? { launch_at_login: loginFact.requested } : {}) },
    models: [...catalog.models, ...installed.filter((item) => !catalog.models.some((model) => model.id === item.model.id)).map((item) => item.model)],
    installed: installed.map((item) => item.model.id), microphones: sources.map((source) => source.id),
    session: process.env["XDG_SESSION_TYPE"] ?? "unknown",
    desktop: process.env["XDG_CURRENT_DESKTOP"] ?? "unknown", clipboard_available: descriptor !== null,
    shortcut_portal: shortcut.available, paste_portal: pasteState.available, shortcut: macShortcut?.state().label ?? shortcut.label,
    native_shortcuts: macShortcut?.state().available ?? shortcut.nativeAvailable,
    shortcut_configuring: shortcut.configuring && !shortcut.nativeX11,
    native_x11: shortcut.nativeX11 ?? false, native_paste: !!macPaste, native_mouse: false, native_middle_mouse: false,
    recording_shortcut: (macShortcut?.state().configuring ?? false) || !!keyCapture || !!shortcut.nativeX11 && shortcut.configuring,
    paste_ready: macPaste ? accessibilityAllowed : pasteState.ready, paste_configuring: pasteState.configuring, gpu_available: false, gpu_supported: false,
    gpu_device: null, gpu_fallback: identity.kind === "stable" && preferences.snapshot().gpu, recovery_available: recording.recoveryAvailable,
    overlay_available: !!overlay && !overlay.isDestroyed() && (!waylandOverlay || waylandOverlay.available),
    download, progress: download ? downloadProgress : inferenceProgress,
    elapsed: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(recording.elapsedMs / 1000)), level: recording.level,
    model_directory: profile.paths.models,
    ...(identity.kind === "development" ? { profile: "development", development_build: `${build.commit.slice(0, 12)}${build.modified ? "+modified" : ""}` } : {}),
    recording_available: !!host && (macRecording ? microphoneAllowed || recording.busy : !!audioServer || recording.busy) &&
      (recording.busy || installed.some((item) => item.model.id === preferences.snapshot().model)),
    local_processing: processingProfile.snapshot(),
    local_processing_invalid_profile: processingProfile.invalidContent,
  });

  const uiSession = session.defaultSession;
  uiSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false); });
  uiSession.setPermissionCheckHandler(() => false);
  uiSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith("app://openwhisper/") });
  });
  await protocol.handle("app", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    try {
      const asset = await readApplicationAsset(request.url, join(distribution, "ui"));
      return new Response(request.method === "HEAD" ? null : asset.bytes, {
        headers: {
          "Content-Type": asset.mediaType,
          "Content-Security-Policy": CONTENT_SECURITY_POLICY,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch { return new Response(null, { status: 404 }); }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: profile.productName, submenu: [{ role: "quit" }] },
    { role: "editMenu" },
  ]));
  window = new BrowserWindow({
    title: profile.productName,
    width: 980, height: 740, minWidth: 740, minHeight: 560,
    backgroundColor: "#141a21", show: false,
    webPreferences: {
      preload: join(distribution, "preload/index.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, devTools: false,
    },
  });
  const contents = window.webContents;
  const inactiveOverlay = supportsInactiveRecordingOverlay({ platform: process.platform,
    ...(process.env["XDG_SESSION_TYPE"] ? { sessionType: process.env["XDG_SESSION_TYPE"] } : {}),
    ...(process.env["WAYLAND_DISPLAY"] ? { waylandDisplay: process.env["WAYLAND_DISPLAY"] } : {}),
    ozonePlatform: app.commandLine.getSwitchValue("ozone-platform"),
  });
  // The owned prototype still fails post-click focus retention on stock KWin.
  const nativeWaylandOverlay = app.commandLine.hasSwitch("experimental-wayland-overlay") && process.platform === "linux" && !inactiveOverlay &&
    (!!process.env["WAYLAND_DISPLAY"] || process.env["XDG_SESSION_TYPE"] === "wayland" ||
      app.commandLine.getSwitchValue("ozone-platform") === "wayland");
  if (inactiveOverlay || nativeWaylandOverlay) {
    try {
      const options = (nativeWaylandOverlay ? waylandOverlayWindowOptions : overlayWindowOptions)(
        { title: `${profile.productName} Recording`, preloadPath: join(distribution, "preload/index.cjs") });
      const area = screen.getPrimaryDisplay().workArea;
      overlay = new BrowserWindow({ ...options,
        x: Math.floor(area.x + (area.width - 360) / 2), y: Math.floor(area.y + area.height - 88),
        webPreferences: { ...options.webPreferences, webSecurity: true, devTools: false },
      });
      overlay.on("closed", () => {
        overlayReady = false; overlay = undefined;
        void waylandOverlay?.close().catch(() => {}); notify();
      });
      if (nativeWaylandOverlay) {
        waylandOverlay = new WaylandRecordingOverlay(overlay, join(distribution, "workers/wayland-surface-entry.js"), () => notify());
        if (!await waylandOverlay.start()) overlay.destroy();
      }
    } catch {
      if (overlay && !overlay.isDestroyed()) overlay.destroy();
      console.error("OpenWhisper Dev could not create its recording overlay.");
    }
  }
  const emit = <N extends EventName>(name: N, payload: EventPayload<N>): void => {
    const validated = validateEvent(name, payload);
    for (const [target, url] of [[contents, MAIN_URL], [overlay?.webContents, OVERLAY_URL]] as const) {
      if (target && !target.isDestroyed() && target.mainFrame.url === url) {
        target.send(`openwhisper:event:${name}`, validated);
      }
    }
  };
  const showSettings = (): void => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } };
  let updateTray = (_state: AppState): void => {};
  notify = () => {
    try {
      const snapshot = state(); emit("state", snapshot); updateTray(snapshot);
      if (overlayReady && overlay && !overlay.isDestroyed()) {
        const visible = shouldShowRecordingOverlay(snapshot);
        if (waylandOverlay) waylandOverlay.setVisible(visible);
        else if (visible && !overlay.isVisible()) overlay.showInactive();
        else if (!visible && overlay.isVisible()) overlay.hide();
      }
    }
    catch { console.error("OpenWhisper Dev could not publish its UI state."); }
  };
  const action = async (operation: () => Promise<void>): Promise<void> => {
    try { await operation(); }
    catch { message = "The action could not be completed. Stopped recordings are kept for retry."; }
    notify();
  };
  const withRecordingControl = <T>(operation: () => Promise<T>, duringShutdown = false): Promise<T> => {
    if (recordingControl || (shutdownInProgress && !duringShutdown)) return Promise.reject(new Error("Recording control is busy."));
    // Reserve before the first await so configuration and request changes cannot overlap.
    recordingControl = true; cancelRequested = false;
    const task = Promise.resolve().then(operation).finally(() => {
      recordingControl = false; if (recordingOperation === task) recordingOperation = undefined; notify();
    });
    recordingOperation = task; return task;
  };
  const recordingAction = (operation: () => Promise<void>): Promise<void> => action(() => withRecordingControl(operation));
  const configureRecording = async (): Promise<void> => {
    if (configured && host?.isConfigured()) return;
    if (!host) throw new Error("Recording unavailable.");
    const selected = preferences.snapshot(), model = installed.find((item) => item.model.id === selected.model);
    if (!model || selected.output !== "clipboard" && !(selected.output === "paste" && (descriptor?.platform === "linux" || macPaste)) || selected.gpu && identity.kind === "development") {
      throw new Error("Choose an installed model and supported output.");
    }
    // Recovery may be transcribed with the microphone disconnected; resolve sources only on Start.
    const request = recordingRequestSchema.parse({ model: { path: join(profile.paths.models, model.model.file), family: model.model.family, gpu: false },
      language: selected.language, vocabulary: selected.vocabulary, snippets: selected.snippets });
    await host.configure({ id: model.model.id, request,
      ...(macRecording ? {} : { server: audioServer ?? `unix:${join(process.env.XDG_RUNTIME_DIR ?? profile.paths.locks, "pulse/native")}`,
        source: selected.microphone }) }); configured = true;
  };
  const toggleRecording = (): Promise<void> => recordingAction(async () => {
    if (!host) throw new Error("Recording unavailable.");
    if (recording.phase === "recording" || recording.phase === "starting") await host.command("stop");
    else { await configureRecording(); if (cancelRequested) return; inferenceProgress = 0; await host.command("start"); }
  });
  const cancelRecording = (): Promise<void> => action(async () => {
    cancelRequested = true; if (host?.isConfigured()) await host.command("cancel");
  });
  if (host && macRecording && process.platform === "darwin") {
    macShortcut = new MacosShortcut({ shortcuts: globalShortcut,
      allowed: () => !shutdownInProgress && !recordingControl && !recording.recoveryAvailable &&
        !["stopping", "transcribing", "restoring", "discarding"].includes(recording.phase),
      capture: createRecordingControlPort({ owner: host, snapshot: () => recording, configure: configureRecording,
        available: () => !shutdownInProgress && state().recording_available === true,
        serialize: withRecordingControl, cleanupSerialize: (operation) => withRecordingControl(operation, true) }),
      changed: (value) => {
        contents.setIgnoreMenuShortcuts(value.configuring);
        const messages = { NONE: "", ENABLED: "", CANCELLED: "Shortcut setup was cancelled. Window recording remains usable.",
          UNSUPPORTED: "Use a regular key or shortcut. Fn and mouse triggers are not available in this build.",
          CONFLICT: "This trigger conflicts with an existing desktop shortcut. Choose another trigger.",
          FAILED: "Shortcut setup or recording failed. Window recording remains usable." };
        message = messages[value.result];
        if (value.result === "ENABLED" && value.accelerator && preferences.snapshot().macos_shortcut !== value.accelerator) {
          void preferences.saveMacShortcut(value.accelerator).then(notify,
            () => { message = "The action could not be completed. Stopped recordings are kept for retry."; notify(); });
        }
        notify();
      } });
    notify();
  }
  if (host && descriptor?.platform === "linux" && descriptor.platformServices) {
    try {
      platformHost = await DevelopmentPlatformHost.open({
        descriptor: { root: resolve(distribution, ".."), ...descriptor.platformServices },
        address: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
        appId: profile.appId,
        kdeLeasePath: join(profile.paths.settings, "kde-keyboard-lease.json"),
        paste: (value) => {
          pasteState = value;
          const messages = { NONE: "", ENABLED: "Automatic paste enabled for this session. No screen capture is requested.",
            CANCELLED: "Keyboard permission setup was cancelled. Clipboard output remains available.",
            DENIED: "Keyboard permission was denied. Clipboard output remains available.",
            ENDED: "Keyboard permission ended. Clipboard output remains available.",
            FAILED: "Keyboard permission failed. Clipboard output remains available." };
          if (value.result !== "NONE") message = messages[value.result]; notify();
        },
        shortcuts: (value) => {
          shortcut = value;
          const messages = { NONE: "", ENABLED: "Global shortcut enabled. Your desktop controls its key binding.",
            UNASSIGNED: "No shortcut assigned. Choose a key combination in your desktop's shortcut settings.",
            CANCELLED: "Shortcut setup was cancelled. Window recording remains usable.",
            ENDED: "Shortcut session ended. Enable it again in Settings.",
            CONFLICT: "This trigger conflicts with an existing desktop shortcut. Choose another trigger.",
            CONFIGURE_UNAVAILABLE: "Change this shortcut in your desktop's settings. Its current binding remains active.",
            FAILED: "Shortcut setup or recording failed. Window recording remains usable." };
          message = (value.nativeKey !== null || value.x11Trigger) && value.result === "ENABLED" ? "" : messages[value.result];
          const savedTrigger = preferences.snapshot().native_trigger;
          if (value.nativeKey !== null && value.result === "ENABLED" &&
              (savedTrigger?.kind !== "key" || savedTrigger.key !== value.nativeKey)) {
            void preferences.saveNativeTrigger({ kind: "key", key: value.nativeKey }).then(notify,
              () => { message = "The action could not be completed. Stopped recordings are kept for retry."; notify(); });
          }
          if (value.x11Trigger && value.result === "ENABLED" &&
              JSON.stringify(preferences.snapshot().x11_trigger) !== JSON.stringify(value.x11Trigger)) {
            void preferences.saveX11Trigger(value.x11Trigger).then(notify,
              () => { message = "The action could not be completed. Stopped recordings are kept for retry."; notify(); });
          }
          notify();
        },
        capture: createRecordingControlPort({ owner: host, snapshot: () => recording, configure: configureRecording,
          serialize: withRecordingControl,
          cleanupSerialize: <T>(operation: () => Promise<T>) => withRecordingControl(operation, true),
          available: () => !shutdownInProgress && !keyCapture && !!audioServer && installed.some((item) => item.model.id === preferences.snapshot().model) }),
      }, new AbortController().signal);
    } catch { message = "Desktop command control is not available. Window recording remains usable."; }
  }
  const shortcutAction = (command: "enable" | "configure" | "clear" | "cancel"): Promise<void> => action(async () => {
    if (macShortcut) {
      if (shutdownInProgress || (recording.busy || recording.recoveryAvailable) && command !== "cancel") throw new Error("Shortcut setup is unavailable.");
      if (command === "enable") {
        if (!window?.isFocused()) throw new Error("Shortcut setup is unavailable.");
        macShortcut.prepareCapture();
      } else if (command === "cancel") macShortcut.cancelSetup();
      else if (command === "clear") { macShortcut.clear(); await preferences.saveMacShortcut(null); }
      else throw new Error("Shortcut setup is unavailable.");
      return;
    }
    if (!platformHost || ((recording.busy || recording.recoveryAvailable) && command !== "cancel")) throw new Error("Shortcut setup is unavailable.");
    if (command === "enable" && shortcut.nativeAvailable) {
      if (shortcut.nativeX11) {
        // The native adapter verifies actual X11 focus ancestry before its grab.
        // Electron's activation flag can remain false on a genuine bare X server.
        if (!window) throw new Error("Shortcut setup is unavailable.");
        const handle = window.getNativeWindowHandle();
        const xid = handle.length === 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE();
        await platformHost.prepareKeyCapture(xid, preferences.snapshot().hold_to_record); return;
      }
      await platformHost.prepareKeyCapture();
      if (shutdownInProgress || !window?.isFocused()) throw new Error("Shortcut setup is unavailable.");
      keyCapture = new KdeKeyCapture(); contents.setIgnoreMenuShortcuts(true); message = ""; notify(); return;
    }
    if (command === "cancel" && keyCapture) { keyCapture = undefined; contents.setIgnoreMenuShortcuts(false); notify(); return; }
    keyCapture = undefined; contents.setIgnoreMenuShortcuts(false);
    await platformHost.shortcut(command, preferences.snapshot().hold_to_record);
    if (command === "clear") {
      if (shortcut.nativeX11) await preferences.saveX11Trigger(null);
      else await preferences.saveNativeTrigger(null);
    }
  });
  contents.on("before-input-event", (event, input) => {
    if (macShortcut?.state().configuring) {
      // Preserve Chromium key tracking; the shared UI suppresses setup defaults.
      if (input.type === "keyUp" || input.key === "Escape") event.preventDefault();
      macShortcut.consume(input); return;
    }
    if (!keyCapture) return;
    // Let key-down reach Chromium's key tracking; the shared UI suppresses its
    // default actions while capturing. Consume the matching release in main.
    if (input.type === "keyUp" || input.key === "Escape") event.preventDefault();
    const result = keyCapture.consume(input);
    if (result.kind === "pending") return;
    keyCapture = undefined; contents.setIgnoreMenuShortcuts(false);
    if (result.kind === "key") {
      if (preferences.snapshot().hold_to_record && modifierOnly(result.key)) {
        message = "Modifier-only triggers use toggle mode. Use a regular key or mouse button for push to talk."; notify(); return;
      }
      void action(async () => { await platformHost?.bindKey(result.key, preferences.snapshot().hold_to_record); });
    } else { notify(); }
  });
  window.on("blur", () => { macShortcut?.focusLost(); if (keyCapture) { keyCapture = undefined; contents.setIgnoreMenuShortcuts(false); notify(); } });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownInProgress) return;
    if (macRecording && recording.recoveryAvailable) {
      message = "Retry or discard the stopped recording before quitting. Its audio is kept in memory."; showSettings(); notify(); return;
    }
    shutdownInProgress = true; cancelRequested = true; processing.close(); downloadAbort?.abort();
    keyCapture = undefined; contents.setIgnoreMenuShortcuts(false);
    void (async () => { await recordingOperation?.catch(() => {}); await downloading; await downloads.finalize();
      await macShortcut?.close(); macPaste?.close(); await platformHost?.close(); await host?.close(); await waylandClipboard?.close(); await waylandOverlay?.close(); })().then(() => {
      shutdownComplete = true; tray?.destroy(); tray = undefined;
      overlay?.destroy(); app.quit();
    }, () => {
      // Preserve uncertain owners and the private recovery files for explicit review.
      shutdownInProgress = false; message = "Recording cleanup could not finish. Recording data and uncertain processes are kept."; notify();
    });
  });
  const dispatcher = createUiDispatcher({
    windows: [{ webContentsId: contents.id, role: "main" }, ...(overlay ? [{ webContentsId: overlay.webContents.id, role: "overlay" as const }] : [])],
    handlers: {
      get_state: () => state(),
      save_preferences: ({ changes }) => withRecordingControl(async () => {
        if (changes.auto_check_updates === true) throw new Error("Update services are not configured in this build.");
        if (changes.launch_at_login !== undefined && (!autostart || !loginFact)) throw new Error("Login services are unavailable in this installation.");
        if (changes.model && !catalog.models.some((model) => model.id === changes.model) && !installed.some((item) => item.model.id === changes.model)) {
          throw new Error("Unknown catalog model.");
        }
        if ((recording.busy || recording.recoveryAvailable) &&
          ["model", "language", "microphone", "vocabulary", "snippets", "gpu", "output", "hold_to_record"].some((key) => Object.hasOwn(changes, key))) {
          throw new Error("Finish or discard the current recording before changing its request.");
        }
        if (changes.output && changes.output !== "clipboard" && !(changes.output === "paste" && (descriptor?.platform === "linux" || macPaste))) {
          throw new Error("The recording build does not support this output.");
        }
        if (changes.gpu) throw new Error("The recording build uses CPU inference.");
        if (macRecording && changes.hold_to_record) throw new Error("Regular keyboard shortcuts use toggle mode in this build.");
        if (changes.hold_to_record && shortcut.nativeKey !== null && modifierOnly(shortcut.nativeKey)) {
          throw new Error("Modifier-only KDE triggers use toggle mode.");
        }
        const candidate = preferencesSchema.parse({ ...preferences.snapshot(), ...changes });
        if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_UI_REQUEST_BYTES) throw new Error("Preferences exceed their size limit.");
        if (changes.launch_at_login !== undefined) {
          try { await autostart!.set(changes.launch_at_login); }
          finally { await refreshLogin(); notify(); }
        }
        try { await preferences.patch(changes); }
        catch (error: unknown) {
          if (changes.launch_at_login !== undefined) {
            message = "The login setting may have changed; preferences could not be saved.";
            await refreshLogin(); notify();
          }
          throw error;
        }
        if (changes.hold_to_record !== undefined) await platformHost?.shortcut("mode", changes.hold_to_record);
        if (["model", "language", "microphone", "vocabulary", "snippets", "gpu"].some((key) => Object.hasOwn(changes, key))) configured = false;
        const current = state();
        emit("state", current);
        return current;
      }),
      complete_setup: async () => {
        await preferences.completeSetup();
        emit("state", state());
      },
      open_login_settings: () => {
        if (!(autostart instanceof MacosAutostart)) throw new Error("Login settings are unavailable in this installation.");
        autostart.openSettings();
      },
      save_local_processing: async ({ changes }) => {
        await processingProfile.update((current) => applyLocalProcessingProfilePatch(current, changes));
        const current = state();
        emit("state", current);
        return current;
      },
      preview_local_processing: async (input) => {
        try { return { ok: true, text: await processing.preview(input, processingProfile.snapshot()) }; }
        catch (error: unknown) {
          if (error instanceof LocalProcessingError) return { ok: false, code: error.code };
          throw error;
        }
      },
      cancel_local_processing: ({ requestId }) => { processing.cancel(requestId); },
      enable_shortcut: () => shortcutAction("enable"),
      desktop_shortcut: () => shortcutAction("configure"),
      clear_shortcut: () => shortcutAction("clear"),
      cancel_shortcut: () => shortcutAction("cancel"),
      enable_paste: () => action(async () => {
        if (macPaste) {
          accessibilityAllowed = systemPreferences.isTrustedAccessibilityClient(true);
          if (!accessibilityAllowed) await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
          return;
        }
        if (!platformHost) throw new Error("Keyboard permission unavailable."); await platformHost.pastePermission("enable");
      }),
      disable_paste: () => action(async () => {
        if (macPaste) { await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"); return; }
        if (!platformHost) throw new Error("Keyboard permission unavailable."); await platformHost.pastePermission("clear");
      }),
      toggle_recording: toggleRecording,
      cancel_recording: cancelRecording,
      retry_transcription: () => recordingAction(async () => { await configureRecording(); if (cancelRequested) return; inferenceProgress = 0; await host?.command("retry"); }),
      discard_recovery: () => recordingAction(async () => { await configureRecording(); if (!cancelRequested) await host?.command("discard"); }),
      refresh_microphones: () => recordingAction(async () => { if (!host) throw new Error("Recording unavailable.");
        if (macRecording) { microphoneAllowed = systemPreferences.getMediaAccessStatus("microphone") === "granted"; return; }
        audioServer = await developmentPulseServer(); sources = await host.enumerate(audioServer); }),
      allow_microphone: () => action(async () => {
        if (!macRecording) throw new Error("Microphone permission is unavailable.");
        const permission = systemPreferences.getMediaAccessStatus("microphone");
        if (permission === "not-determined") microphoneAllowed = await systemPreferences.askForMediaAccess("microphone");
        else {
          microphoneAllowed = permission === "granted";
          if (!microphoneAllowed) await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
        }
      }),
      import_model: () => recordingAction(async () => {
        if (recording.busy || recording.recoveryAvailable) throw new Error("Finish the current recording first.");
        if (!window) return;
        const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Local speech model", extensions: ["bin"] }] });
        if (recording.busy || recording.recoveryAvailable || shutdownInProgress) throw new Error("Finish the current recording first.");
        if (!result.canceled && result.filePaths.length === 1) { const source = result.filePaths[0];
          if (source) { const imported = await inventory.import(source); await refreshModels(); await preferences.patch({ model: imported.model.id }); configured = false; } }
      }),
      delete_model: ({ id }) => recordingAction(async () => {
        if (id === preferences.snapshot().model && (recording.busy || recording.recoveryAvailable)) {
          throw new Error("Finish or discard the current recording before removing its model.");
        }
        await inventory.remove(id); await refreshModels();
      }),
      download_model: ({ id }) => {
        if (downloading) throw new Error("A model download is already running.");
        if (id === preferences.snapshot().model && (recordingControl || recording.busy || recording.recoveryAvailable)) {
          throw new Error("Finish or discard the current recording before replacing its model.");
        }
        download = id; downloadProgress = 0; downloadAbort = new AbortController();
        downloading = action(async () => { await downloads.download(id, downloadAbort?.signal); await downloads.finalize();
          await refreshModels(); if (!recordingControl && !recording.busy && !recording.recoveryAvailable && !shutdownInProgress) {
            await withRecordingControl(async () => { await preferences.patch({ model: id }); configured = false; });
          }
        }).finally(() => { download = null; downloading = undefined; downloadAbort = undefined; notify(); });
        notify();
      },
      cancel_download: () => { downloadAbort?.abort(); },
      copy_transcript: async () => { await clipboardOutput.writeText(recording.transcript); },
      copy_history: async ({ index }) => { const text = history.snapshot().filter((item) => Buffer.byteLength(item, "utf8") <= MAX_USER_TEXT_BYTES)[index]; if (text !== undefined) await clipboardOutput.writeText(text); },
      clear_history: () => action(async () => { await history.update(() => []); }),
      show_models_folder: () => action(async () => { if (await shell.openPath(profile.paths.models)) throw new Error("Folder unavailable."); }),
      show_transcripts_folder: () => action(async () => { if (await shell.openPath(profile.paths.transcripts)) throw new Error("Folder unavailable."); }),
    },
  });
  try {
    const icon = nativeImage.createFromPath(join(distribution, "ui/app-icon.png")).resize({ width: 18, height: 18 });
    if (icon.isEmpty()) throw new Error("Tray icon unavailable.");
    if (process.platform === "darwin") icon.setTemplateImage(true);
    tray = new Tray(icon); tray.setToolTip(profile.productName); tray.on("click", showSettings);
    updateTray = (snapshot) => {
      if (!tray || tray.isDestroyed()) return;
      const key = JSON.stringify([snapshot.status, snapshot.recording_available, snapshot.recovery_available, snapshot.preferences.ui_language]);
      if (key === trayKey) return;
      trayKey = key;
      const labels = trayLocales[snapshot.preferences.ui_language];
      tray.setContextMenu(Menu.buildFromTemplate([...buildTrayMenu(snapshot, {
        settings: showSettings,
        toggleRecording: () => { if (!shutdownInProgress) void toggleRecording(); },
        cancelRecording: () => { if (!shutdownInProgress) void cancelRecording(); },
        quit: () => { app.quit(); },
      }, (label) => labels[label] ?? label)]));
    };
  } catch {
    tray?.destroy(); tray = undefined;
    console.error("OpenWhisper Dev could not create its tray control.");
  }
  ipcMain.handle("openwhisper:invoke", async (event, request: unknown) => {
    if (shutdownInProgress) return uiFailure("UNAVAILABLE_COMMAND");
    if (contents.isDestroyed() || event.sender.isDestroyed()) return uiFailure("UNTRUSTED_SENDER");
    const result = await dispatcher.dispatch({ sender: sender(event), serializedRequest: request });
    if (contents.isDestroyed() || event.sender.isDestroyed() || !dispatcher.isTrustedSender(sender(event))) {
      return uiFailure("UNTRUSTED_SENDER");
    }
    return result;
  });
  for (const target of [contents, ...(overlay ? [overlay.webContents] : [])]) {
    target.setWindowOpenHandler(() => ({ action: "deny" }));
    target.on("will-navigate", (event) => { event.preventDefault(); });
    target.on("will-attach-webview", (event) => { event.preventDefault(); });
  }
  window.on("close", (event) => { if (!shutdownComplete) { event.preventDefault(); app.quit(); } });
  window.on("closed", () => { processing.close(); ipcMain.removeHandler("openwhisper:invoke"); window = undefined; });
  window.once("ready-to-show", () => { window?.show(); });
  if (macRecording) window.on("focus", () => {
    microphoneAllowed = systemPreferences.getMediaAccessStatus("microphone") === "granted";
    accessibilityAllowed = systemPreferences.isTrustedAccessibilityClient(false); notify();
  });
  if (autostart) window.on("focus", () => { void refreshLogin().then(notify); });
  // Configure the saved request to discover private stopped audio before showing
  // the controls. Source resolution, capture and inference remain explicit actions.
  if (host && descriptor?.platform === "linux" && installed.some((item) => item.model.id === preferences.snapshot().model)) {
    await action(() => withRecordingControl(configureRecording));
  }
  await window.loadURL(MAIN_URL);
  // A hidden Wayland surface may wait for mapping before producing its first
  // frame. Do not make initial visibility depend only on ready-to-show.
  if (window && !window.isDestroyed() && !window.isVisible()) window.show();
  const loadingOverlay = overlay;
  if (loadingOverlay && !loadingOverlay.isDestroyed()) {
    try {
      await loadingOverlay.loadURL(OVERLAY_URL);
      if (overlay === loadingOverlay && !loadingOverlay.isDestroyed()) overlayReady = true;
    } catch {
      if (!loadingOverlay.isDestroyed()) loadingOverlay.destroy();
      if (overlay === loadingOverlay) overlay = undefined;
    }
  }
  notify();
}

const control = await routeControlStartup({ argv: process.argv,
  layout: app.isPackaged ? { kind: "packaged", executable: process.execPath } :
    { kind: "development", executable: process.execPath, application: app.getAppPath() },
  platform: process.platform, build: APPLICATION_BUILD,
  prepare: async (captured) => {
    const appPath = await realpath(app.getAppPath());
    const version = (await readFile(join(distribution, "resources/VERSION"), "utf8")).trim();
    const manifest: unknown = JSON.parse(await readFile(join(appPath, "package.json"), "utf8"));
    const identity = selectApplicationBuild({ build: captured, purpose: "control", argv: process.argv,
      platform: process.platform, architecture: process.arch, packaged: app.isPackaged,
      executable: await realpath(process.execPath), appPath, resourcesPath: await realpath(process.resourcesPath),
      distribution: await realpath(distribution), projectVersion: version, packageVersion: z.object({ version: z.string() }).parse(manifest).version });
    const descriptor = developmentRecordingDescriptorSchema.parse(DEVELOPMENT_RECORDING_BUILD);
    if (descriptor.platform !== "linux" || descriptor.architecture !== process.arch || !descriptor.platformServices || !process.getuid) {
      throw new Error("Command control requires its matching Linux platform services.");
    }
    const artifact = descriptor.platformServices.bus;
    return { uid: process.getuid(), factory: createControlAdapter({ kind: identity.kind,
      address: process.env["DBUS_SESSION_BUS_ADDRESS"], open: async (address, context) => {
        const path = await verifyDevelopmentLinuxBusArtifact(appPath, artifact);
        if (context.signal.aborted) throw new Error("Command control was cancelled.");
        // The pre-ready client loads only its verified fixed package addon; no
        // capture, portal, FD access or graphical utility process is initialized.
        const binding: unknown = createRequire(import.meta.url)(path);
        return LinuxBus.open(binding, address, context.signal, { expiresAtUs: context.expiresAtUs });
      } }) };
  },
});
if (control) {
  process.stdout.write(control.stdout); process.stderr.write(control.stderr); app.exit(control.exitCode);
} else {
  const bootstrap = await prepareApplication().catch(() => {
    // Startup diagnostics are categorical: no preferences, paths, audio or user text.
    console.error("OpenWhisper could not initialize its application profile.");
    app.exit(1);
    return undefined;
  });
  if (bootstrap) void start(bootstrap).catch(() => {
    console.error("OpenWhisper could not initialize its application services or UI.");
    app.exit(1);
  });
}

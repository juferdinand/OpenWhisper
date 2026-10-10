import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, screen, session, shell, systemPreferences, Tray } from "electron";
import { deliverClipboard } from "../services/recording/clipboard-output.js";
import { WaylandClipboard } from "../services/platforms/linux/wayland-clipboard.js";
import { portalPasteStateSchema } from "../platforms/linux/shared/portal-paste.js";
import type { IpcMainInvokeEvent } from "electron";
import { readFile, realpath } from "node:fs/promises";
import { cpus, homedir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  appStateSchema, hardwareDeviceNameSchema, preferencesSchema, validateEvent, isSteadyRecordingUpdate,
  MAX_USER_TEXT_BYTES, MAX_UI_REQUEST_BYTES,
  type AppState, type EventName, type EventPayload, type UpdateState,
} from "../contracts/ui/state.js";
import { PreferenceStore } from "../services/settings/preferences.js";
import type { HostProfile } from "../services/settings/host-profile.js";
import type { BuildIdentity } from "../contracts/application/build-identity.js";
import { APPLICATION_BUILD } from "./application-build.js";
import { selectApplicationBuild } from "./build-selection.js";
import { formatBootstrapFailure, initializeStableLinuxProfile, initializeStableMacosProfile, observeBootstrapLoginStatus,
  type ApplicationBootstrapStage, type ApplicationBootstrapLoginStatus } from "./stable-profile-startup.js";
import { verifyMacApplicationBundle, macosMigrationContext } from "./macos-stable-admission.js";
import { StableMigrationError } from "../contracts/migration/stable-migration.js";
import { PrivateStateStore } from "../services/settings/private-state.js";
import { LocalProcessingService, LocalProcessingError } from "../services/speech/local-processing.js";
import {
  localProcessingProfileSchema, defaultLocalProcessingProfile, applyLocalProcessingProfilePatch,
} from "../contracts/speech/local-processing.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../services/settings/profiles.js";
import { CONTENT_SECURITY_POLICY, MAIN_URL, OVERLAY_URL, readApplicationAsset } from "./assets.js";
import { createUiDispatcher, performWindowAction, uiFailure, type UiSender } from "./ipc.js";
import { ModelInventory, type InstalledModel } from "../services/models/model-inventory.js";
import { ModelDownloads } from "../services/models/model-download.js";
import { recordingRequestSchema } from "../core/recording/recording.js";
import type { RecordingSource } from "../workers/recording/recording-host-protocol.js";
import { recordingSnapshotSchema } from "../workers/recording/recording-host-protocol.js";
import { DEVELOPMENT_RECORDING_BUILD } from "./development-recording-build.js";
import { developmentRecordingDescriptorSchema, selectDevelopmentRecordingDescriptor, type DevelopmentRecordingDescriptor } from "./development-recording-descriptor.js";
import { DevelopmentRecordingHost, developmentPulseServer, formatSourceDiscoveryFailure } from "./development-recording-host.js";
import { saveTranscript } from "../services/development/development-transcripts.js";
import { DevelopmentPlatformHost } from "./development-platform-host.js";
import { createRecordingControlPort, recordingUnavailableReason } from "./recording-control.js";
import { portalShortcutStateSchema } from "../platforms/linux/shared/portal-shortcuts.js";
import { KdeKeyCapture } from "../platforms/linux/kde/key-capture.js";
import { modifierOnly } from "../platforms/linux/kde/keyboard.js";
import { buildTrayMenu } from "./tray-menu.js";
import { overlayWindowOptions, shouldShowRecordingOverlay, supportsInactiveRecordingOverlay, waylandOverlayWindowOptions } from "./recording-overlay.js";
import { WaylandRecordingOverlay } from "./wayland-recording-overlay.js";
import type { SurfaceUnavailableReason } from "../contracts/platforms/wayland-surface.js";
import { MacosShortcut } from "./macos-shortcut.js";
import { MacosPaste } from "./macos-paste.js";
import { MacosAutostart } from "./macos-autostart.js";
import { APPLICATION_MACOS_UPDATE_BUILD } from "./macos-update-build.js";
import { admitMacosUpdates, type MacosUpdateAdmission } from "./macos-update-admission.js";
import { createMacosUpdateCoordinator, handoffMacosUpdate } from "./macos-update-coordinator.js";
import { ownedMacosUpdateFixtureEffects } from "./owned-macos-update-fixture.js";
import type { PreparedMacosUpdateInstall } from "../services/update/macos/macos-update-install.js";
import { LinuxAutostart } from "../services/platforms/linux/linux-autostart.js";
import { admitLinuxInstalledLaunch } from "./linux-installed-launch.js";
import { admitLinuxDevelopmentAutostart } from "./linux-development-autostart.js";
import { openLinuxUpdateGuiChannel, LINUX_UPDATE_PROTOCOL, type LinuxUpdateGuiChannel, type LinuxUpdateResponse } from "./linux-update-channel.js";
import { LINUX_RESTART_NONCE, LINUX_RESTART_VERSION } from "./linux-restart.js";
import { createRequire } from "node:module";
import { routeControlStartup } from "./control-startup.js";
import { createControlAdapter } from "../platforms/linux/shared/control-adapter.js";
import { LinuxBus } from "../platforms/linux/shared/bus.js";
import { verifyDevelopmentLinuxBusArtifact } from "../services/development/development-artifact.js";
import { parseModelCatalog, recommendationsFor, recommendationTier } from "../core/models/catalog.js";

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

let bootstrapStage: ApplicationBootstrapStage = "package-identity";
let bootstrapLoginStatus: ApplicationBootstrapLoginStatus = "not-observed";
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
  const descriptor = DEVELOPMENT_RECORDING_BUILD === null ? null : selectDevelopmentRecordingDescriptor(DEVELOPMENT_RECORDING_BUILD);
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
    bootstrapStage = "mac-bundle";
    verifyMacApplicationBundle(identity, version, await realpath(process.execPath));
    bootstrapStage = "mac-context";
    let loginStatus: unknown;
    bootstrapLoginStatus = "unavailable";
    try {
      loginStatus = app.getLoginItemSettings({ type: "mainAppService" }).status;
      bootstrapLoginStatus = observeBootstrapLoginStatus(loginStatus);
    }
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
    bootstrapStage = "stable-migration";
    profile = await initializeStableMacosProfile({ home: storage.home, platform: "darwin" }, context);
  } else if (identity.kind === "stable") {
    bootstrapStage = "stable-migration";
    profile = await initializeStableLinuxProfile({ ...storage, platform: "linux" });
  } else {
    bootstrapStage = "development-profile";
    const explicitRoot = selectedProfile();
    profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ ...storage, ...(explicitRoot ? { explicitRoot } : {}) }));
  }
  bootstrapStage = "pre-ready";
  if (app.isReady()) throw new Error("Application profile setup must precede Electron readiness.");
  bootstrapStage = "private-paths";
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
  const devAutostart = process.platform === "linux" && identity.kind === "development" && app.isPackaged
    ? admitLinuxDevelopmentAutostart({ build: identity, platform: process.platform, packaged: app.isPackaged,
      executable: await realpath(process.execPath), appPath: await realpath(app.getAppPath()),
      resourcesPath: await realpath(process.resourcesPath), argv: process.argv, profile }) : undefined;
  const preferences = await PreferenceStore.open(profile, { allowDevelopmentAutostart: devAutostart !== undefined });
  const processingProfile = await PrivateStateStore.open(
    join(profile.paths.settings, "local-processing.json"), localProcessingProfileSchema, defaultLocalProcessingProfile(),
    1024 * 1024, { invalidContent: "preserve-and-default" },
  );
  const processing = new LocalProcessingService();
  const rawCatalog: unknown = JSON.parse(await readFile(join(distribution, "resources/models.json"), "utf8"));
  const catalog = parseModelCatalog(rawCatalog);
  const inventory = await ModelInventory.open(profile, rawCatalog);
  let installed: readonly InstalledModel[] = await inventory.installed();
  let sources: readonly RecordingSource[] = [];
  let audioServer: string | undefined;
  const checkedAudioServer = async (): Promise<string> => {
    try { return await developmentPulseServer(); }
    catch (error: unknown) { console.error(formatSourceDiscoveryFailure({ stage: "checked-pulse", code: "FAILED" })); throw error; }
  };
  let host: DevelopmentRecordingHost | undefined;
  let gpuSelection = {
    supported: descriptor?.platform === "linux" && descriptor.speech.entries.some((entry) => entry.backend === "vulkan"),
    checked: false, available: false, fallback: false, device: null as string | null,
  };
  const cpuName = hardwareDeviceNameSchema.safeParse(cpus()[0]?.model.trim());
  let configured = false;
  let recordingControl = false, cancelRequested = false;
  let recordingOperation: Promise<unknown> | undefined;
  let shutdownInProgress = false, shutdownComplete = false;
  let shutdownTask: Promise<void> | undefined;
  let updateReserved: "check" | "install" | undefined;
  let updateChannel: LinuxUpdateGuiChannel | undefined;
  let macUpdateAdmission: MacosUpdateAdmission | undefined;
  let macUpdates: ReturnType<typeof createMacosUpdateCoordinator> | undefined;
  let macUpdateAbort: AbortController | undefined, macUpdateOperation: Promise<unknown> | undefined;
  let macPrepared: Readonly<PreparedMacosUpdateInstall> | undefined;
  let recordingRetired = false;
  let autoCheckTimer: ReturnType<typeof setTimeout> | undefined;
  let updates: UpdateState = { configured: false, status: "idle", version: null, progress: 0, error: null,
    package: identity.kind === "stable" ? process.platform === "darwin" ? "macos" : "deb" : "development" };
  let overlay: BrowserWindow | undefined, overlayReady = false;
  let waylandOverlay: WaylandRecordingOverlay | undefined;
  let overlayUnavailableReason: SurfaceUnavailableReason | undefined;
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
  let updateAdmitted = false;
  let automaticUpdateCheckAllowed = true;
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
        const launch = await admitLinuxInstalledLaunch({ build: identity, packaged: app.isPackaged, home: homedir(), pid: process.pid,
          executable: await realpath(process.execPath), appPath: await realpath(app.getAppPath()),
          resourcesPath: await realpath(process.resourcesPath), environment: process.env });
        updateAdmitted = launch !== undefined;
        if (launch?.kind === "appimage") {
          updates = { ...updates, package: "appimage" };
          // A migrated preference must not silently fetch a missing/stale current-image signature.
          automaticUpdateCheckAllowed = false;
        }
        if (launch) autostart = await LinuxAutostart.open({ appId: profile.appId,
          configHome: dirname(profile.roots.config),
          configDirs: (process.env["XDG_CONFIG_DIRS"] || "/etc/xdg").split(":").filter(Boolean),
          executable: launch.kind === "debian" ? "/opt/openwhisper/openwhisper-launch" : launch.executable,
          ...(launch.kind === "appimage" ? { appImage: { image: launch.arguments[0], assertUnchanged: launch.assertUnchanged } } : {}) });
      }
    } catch { /* Keep persisted requests intact when installation or OS facts are unavailable. */ }
    await refreshLogin();
  } else if (devAutostart) {
    try {
      autostart = await LinuxAutostart.open({ appId: profile.appId,
        configHome: process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"),
        configDirs: (process.env["XDG_CONFIG_DIRS"] || "/etc/xdg").split(":").filter(Boolean),
        executable: devAutostart.executable, launchArguments: devAutostart.launchArguments });
    } catch { /* Source and unsafe Dev installations keep automatic startup unavailable. */ }
    await refreshLogin();
  }
  if (process.platform === "darwin" && identity.kind === "stable") {
    try {
      macUpdateAdmission = admitMacosUpdates({ policy: APPLICATION_MACOS_UPDATE_BUILD, identity,
        packaged: app.isPackaged, currentVersion: version, executable: await realpath(process.execPath) });
      if (macUpdateAdmission) {
        macUpdates = createMacosUpdateCoordinator({ admission: macUpdateAdmission, identity,
          currentVersion: version, cacheDirectory: profile.paths.cache });
        updates = { ...updates, configured: true };
      }
    } catch { updates = { ...updates, status: "error", error: "Update services are unavailable in this installation." }; }
  }
  if (updateAdmitted) {
    try { updateChannel = openLinuxUpdateGuiChannel(version, receiveUpdate); }
    catch { updates = { ...updates, status: "error", error: "Update services are unavailable in this installation." }; }
    updates = { ...updates, configured: updateChannel !== undefined };
    const disconnected = (): void => {
      updates = { ...updates, configured: false, status: "error", error: "The update connection ended unexpectedly." };
      updateReserved = undefined; notify();
    };
    void updateChannel?.closed.then(() => { if (!shutdownInProgress) disconnected(); }, disconnected);
  }
  // Unadmitted packages must not forward a parent's V2 hints to their workers.
  if (process.env[LINUX_UPDATE_PROTOCOL] !== undefined) {
    delete process.env[LINUX_UPDATE_PROTOCOL]; delete process.env[LINUX_RESTART_NONCE]; delete process.env[LINUX_RESTART_VERSION];
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
      gpuSelection: (selection) => { gpuSelection = selection; notify(); },
      sourceDiscoveryFailure: (failure) => { console.error(formatSourceDiscoveryFailure(failure)); },
      snapshot: (value) => {
        const previous = recording;
        const hadMessage = message !== "";
        const hadDeliveryNotice = (value.phase === "starting" || value.phase === "recording") && deliveryNotice !== "";
        recording = value;
        if (value.phase !== "error") message = "";
        if (value.phase === "starting" || value.phase === "recording") deliveryNotice = "";
        if (isSteadyRecordingUpdate(previous, value) && !hadMessage && !hadDeliveryNotice) {
          emit("recording_telemetry", {
            generation: value.generation,
            elapsed: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value.elapsedMs / 1000)),
            level: value.level,
          });
        } else notify();
      },
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
      try { audioServer = await checkedAudioServer(); sources = await host.enumerate(audioServer); }
      catch { message = "A local audio server is not available."; }
      // Complete the no-model probe before enabling recording; it shares the supervised speech allocation.
      if (gpuSelection.supported) {
        try { await host.discoverGpu(); }
        catch {
          // Eligible loader/device failures already return safe CPU fallback after cleanup.
          // A rejected probe may have poisoned ownership; never advertise this host as ready.
          recordingRetired = true;
        }
      }
    }
  }
  const platform = process.platform === "darwin" ? "macos" : "linux";
  const localeSchema = z.record(z.string(), z.string());
  const trayLocales = {
    en: localeSchema.parse(JSON.parse(await readFile(join(distribution, "resources/locales/en.json"), "utf8")) as unknown),
    de: localeSchema.parse(JSON.parse(await readFile(join(distribution, "resources/locales/de.json"), "utf8")) as unknown),
  };
  const state = (): AppState => {
    const preferenceSnapshot = preferences.snapshot();
    const macShortcutState = macShortcut?.state();
    const gpuName = hardwareDeviceNameSchema.safeParse(gpuSelection.device);
    const unavailable = recordingUnavailableReason({ host: !recordingRetired && !!host,
      model: installed.some((item) => item.model.id === preferenceSnapshot.model), busy: recording.busy,
      recovery: recording.recoveryAvailable, mac: macRecording, microphoneAllowed, audioServer: !!audioServer });
    return appStateSchema.parse({
      updates,
      launch_at_login_available: !!autostart && loginFact !== undefined,
      platform,
      ...(platform === "macos" ? { macos: {
        microphone_allowed: microphoneAllowed, recording_shortcut: macShortcutState?.configuring ?? false,
        shortcut_toggle_only: macRecording, clipboard_restore_available: false,
        shortcut_hint: "Press and release a keyboard key. Escape cancels.",
        editor: "", recommended: [], updates_configured: updates.configured, launch_at_login_pending: loginFact?.pending ?? false,
      } } : {}),
      version, status: recording.phase === "starting" ? "recording"
        : ["stopping", "restoring", "discarding"].includes(recording.phase) ? "transcribing" : recording.phase,
      message: message || deliveryNotice || (Buffer.byteLength(recording.transcript, "utf8") > MAX_USER_TEXT_BYTES
        ? "The complete transcript exceeds the preview size. Use Copy to retrieve the full text."
        : recording.error ? `Recording failed: ${recording.error}.` : descriptor ? "" : "Recording is not available in this development preview."),
      transcript: Buffer.byteLength(recording.transcript, "utf8") <= MAX_USER_TEXT_BYTES ? recording.transcript : "",
      transcript_preview_omitted: Buffer.byteLength(recording.transcript, "utf8") > MAX_USER_TEXT_BYTES,
      history: history.snapshot().filter((text) => Buffer.byteLength(text, "utf8") <= MAX_USER_TEXT_BYTES),
      preferences: { ...preferenceSnapshot, ...(loginFact ? { launch_at_login: loginFact.requested } : {}) },
      models: [...catalog.models, ...installed.filter((item) => !catalog.models.some((model) => model.id === item.model.id)).map((item) => item.model)],
      installed: installed.map((item) => item.model.id), microphones: sources.map((source) => source.id),
      microphone_labels: sources.map((source) => ({ id: source.id, name: source.name })),
      recommended_models: recommendationsFor(catalog, recommendationTier({
        gpuAvailable: gpuSelection.available && gpuSelection.supported,
        gpuEnabled: preferenceSnapshot.gpu,
        gpuFallback: gpuSelection.fallback,
        memoryBytes: totalmem(),
      }), preferenceSnapshot.language === "auto" ? preferenceSnapshot.ui_language : preferenceSnapshot.language).map((model) => model.id),
      session: process.env["XDG_SESSION_TYPE"] ?? "unknown",
      desktop: process.env["XDG_CURRENT_DESKTOP"] ?? "unknown", clipboard_available: descriptor !== null,
      shortcut_portal: shortcut.available, paste_portal: pasteState.available, shortcut: macShortcutState?.label ?? shortcut.label,
      native_shortcuts: macShortcutState?.available ?? shortcut.nativeAvailable,
      shortcut_configuring: shortcut.configuring && !shortcut.nativeX11,
      native_x11: shortcut.nativeX11 ?? false, native_paste: !!macPaste,
      native_mouse: shortcut.nativeMouse ?? false, native_middle_mouse: shortcut.nativeMiddleMouse ?? false,
      recording_shortcut: (macShortcutState?.configuring ?? false) || !!keyCapture || !!shortcut.nativeX11 && shortcut.configuring,
      paste_ready: macPaste ? accessibilityAllowed : pasteState.ready, paste_configuring: pasteState.configuring,
      gpu_available: gpuSelection.available, gpu_supported: gpuSelection.supported, gpu_checked: gpuSelection.checked,
      cpu_device: cpuName.success ? cpuName.data : null, gpu_device: gpuName.success ? gpuName.data : null,
      gpu_fallback: preferenceSnapshot.gpu && gpuSelection.fallback, recovery_available: recording.recoveryAvailable,
      overlay_available: !!overlay && !overlay.isDestroyed() && (!waylandOverlay || waylandOverlay.available),
      ...(overlayUnavailableReason ? { overlay_unavailable_reason: overlayUnavailableReason } : {}),
      download, progress: download ? downloadProgress : inferenceProgress,
      elapsed: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(recording.elapsedMs / 1000)), level: recording.level,
      recording_generation: recording.generation,
      model_directory: profile.paths.models,
      ...(identity.kind === "development" ? { profile: "development", development_build: `${build.commit.slice(0, 12)}${build.modified ? "+modified" : ""}` } : {}),
      recording_available: updateReserved !== "install" && unavailable === undefined,
      ...(unavailable ? { recording_unavailable_reason: unavailable } : {}),
      local_processing: processingProfile.snapshot(),
      local_processing_invalid_profile: processingProfile.invalidContent,
    });
  };

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
    frame: false,
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
  const nativeWaylandOverlay = process.platform === "linux" && !inactiveOverlay &&
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
        waylandOverlay = new WaylandRecordingOverlay(overlay, join(distribution, "workers/wayland-surface-entry.js"), () => {
          overlayUnavailableReason = waylandOverlay?.unavailableReason ?? "runtime"; notify();
        });
        if (!await waylandOverlay.start()) {
          overlayUnavailableReason = waylandOverlay.unavailableReason ?? "runtime"; overlay.destroy();
        }
      }
    } catch {
      if (nativeWaylandOverlay) overlayUnavailableReason = waylandOverlay?.unavailableReason ?? "runtime";
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
    if (recordingControl || (!duringShutdown && (recordingRetired || shutdownInProgress || updateReserved === "install"))) return Promise.reject(new Error("Recording control is busy."));
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
    if (!model || selected.output !== "clipboard" && !(selected.output === "paste" && (descriptor?.platform === "linux" || macPaste))) {
      throw new Error("Choose an installed model and supported output.");
    }
    // Recovery may be transcribed with the microphone disconnected; resolve sources only on Start.
    const request = recordingRequestSchema.parse({ model: { path: join(profile.paths.models, model.model.file), family: model.model.family,
      gpu: selected.gpu && gpuSelection.supported },
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
    if (recordingRetired) throw new Error("Recording is unavailable until the app restarts.");
    cancelRequested = true; if (host?.isConfigured()) await host.command("cancel");
  });
  if (host && macRecording && process.platform === "darwin") {
    macShortcut = new MacosShortcut({ shortcuts: globalShortcut,
      allowed: () => !shutdownInProgress && updateReserved !== "install" && !recordingControl && !recording.recoveryAvailable &&
        !["stopping", "transcribing", "restoring", "discarding"].includes(recording.phase),
      setupAllowed: () => !shutdownInProgress && updateReserved !== "install" && !recording.busy && !recording.recoveryAvailable,
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
          message = (value.nativeKey !== null || value.nativeMouseButton !== null && value.nativeMouseButton !== undefined || value.x11Trigger) && value.result === "ENABLED" ? "" : messages[value.result];
          const savedTrigger = preferences.snapshot().native_trigger;
          if (value.nativeKey !== null && value.result === "ENABLED" && !value.configuring &&
              (savedTrigger?.kind !== "key" || savedTrigger.key !== value.nativeKey)) {
            void preferences.saveNativeTrigger({ kind: "key", key: value.nativeKey }).then(notify,
              () => { message = "The action could not be completed. Stopped recordings are kept for retry."; notify(); });
          }
          if (value.nativeMouseButton !== null && value.nativeMouseButton !== undefined && value.result === "ENABLED" && !value.configuring &&
              (savedTrigger?.kind !== "mouse" || savedTrigger.button !== value.nativeMouseButton)) {
            void preferences.saveNativeTrigger({ kind: "mouse", button: value.nativeMouseButton }).then(notify,
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
          available: () => !shutdownInProgress && updateReserved !== "install" && !keyCapture && !!audioServer && installed.some((item) => item.model.id === preferences.snapshot().model) }),
      }, new AbortController().signal);
      const savedTrigger = preferences.snapshot().native_trigger;
      if (preferences.snapshot().setup_completed && !shortcut.nativeX11 && savedTrigger) {
        try {
          if (savedTrigger.kind === "key" && shortcut.nativeAvailable) {
            await platformHost.bindKey(savedTrigger.key, preferences.snapshot().hold_to_record);
          } else if (savedTrigger.kind === "mouse" && shortcut.nativeMouse) {
            await platformHost.bindMouse(savedTrigger.button, preferences.snapshot().hold_to_record);
          }
        } catch { message = "Shortcut setup or recording failed. Window recording remains usable."; }
      }
    } catch { message = "Desktop command control is not available. Window recording remains usable."; }
  }
  const shortcutAction = (command: "enable" | "configure" | "clear" | "cancel"): Promise<void> => recordingAction(async () => {
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
      void recordingAction(async () => { await platformHost?.bindKey(result.key, preferences.snapshot().hold_to_record); });
    } else { notify(); }
  });
  window.on("blur", () => { macShortcut?.focusLost(); if (keyCapture) { keyCapture = undefined; contents.setIgnoreMenuShortcuts(false); notify(); } });
  function finishShutdown(retiring: boolean, macHandoff?: Readonly<PreparedMacosUpdateInstall>): Promise<void> {
    if (shutdownTask) return retiring || macHandoff ? Promise.reject(new Error("Shutdown already started.")) : shutdownTask;
    shutdownInProgress = true; cancelRequested = true; processing.close(); downloadAbort?.abort();
    if (!macHandoff) macUpdateAbort?.abort();
    clearTimeout(autoCheckTimer); autoCheckTimer = undefined;
    keyCapture = undefined; contents.setIgnoreMenuShortcuts(false);
    let nativeCleanupStarted = false;
    const closeOwners = async (): Promise<void> => {
      await recordingOperation?.catch(() => {}); await downloading; await downloads.finalize();
      nativeCleanupStarted = true;
      await macShortcut?.close(); macPaste?.close(); await platformHost?.close(); await host?.close(); await waylandClipboard?.close(); await waylandOverlay?.close();
      if (macRecording) { recordingRetired = true; host = undefined; configured = false; }
    };
    shutdownTask = (async () => {
      if (!macHandoff) {
        await macUpdateOperation?.catch(() => {});
        await macUpdates?.settleForQuit();
        if (macPrepared) {
          const prepared = macPrepared; macPrepared = undefined;
          // A refused optional-update cleanup retains its stage, without trapping ordinary Quit.
          await prepared.discard().catch(() => {});
        }
        await closeOwners();
      } else {
        const executable = macUpdateAdmission?.executable;
        if (!executable) throw new Error("Update relaunch is unavailable.");
        await handoffMacosUpdate(macHandoff, { retire: closeOwners,
          relaunch: () => app.relaunch({ execPath: executable, args: [] }) });
        macPrepared = undefined;
      }
      if (updateChannel) {
        if (retiring) { await updateChannel.acknowledgeRetired(); await updateChannel.closed; }
        else {
          updateChannel.quit();
          // A failed optional updater must not trap ordinary Quit. Original closure still must settle.
          await updateChannel.closed.catch(() => {});
        }
      }
      shutdownComplete = true; tray?.destroy(); tray = undefined;
      overlay?.destroy(); app.quit();
    })().catch(async (error: unknown) => {
      await updateChannel?.close();
      // Preserve uncertain owners and the private recovery files for explicit review.
      shutdownInProgress = false; shutdownTask = undefined;
      if (macRecording && nativeCleanupStarted) recordingRetired = true;
      if (macHandoff) {
        macPrepared = undefined; updateReserved = undefined;
        updates = { ...updates, configured: false, status: "error", error: "The update could not be completed." };
      }
      message = recordingRetired ? "Restart the app before recording again. Update backups and uncertain processes are kept."
        : "Recording cleanup could not finish. Recording data and uncertain processes are kept.";
      notify(); throw error;
    });
    return shutdownTask;
  }
  function receiveUpdate(response: LinuxUpdateResponse): void {
    if (response.type === "retire") {
      if (updateReserved !== "install" || shutdownInProgress) { void updateChannel?.close(); return; }
      void finishShutdown(true).catch(() => {}); return;
    }
    const value = response.state;
    if (updateReserved === "check" && (value.status === "idle" || value.status === "available")) automaticUpdateCheckAllowed = true;
    updates = { ...updates, error: null, progress: 0,
      status: value.status === "idle" ? "current" : value.status === "checking" ? "checking"
        : value.status === "available" ? "available" : value.status === "failed" ? "error" : "installing",
      version: "updateVersion" in value ? value.updateVersion : null,
      ...(value.status === "failed" ? { error: value.code === "CANCELLED" ? "The update was cancelled." : "The update could not be completed." } : {}) };
    if (!["checking", "preparing", "prepared"].includes(value.status)) updateReserved = undefined;
    notify();
  }
  const requestUpdate = async (kind: "check" | "install"): Promise<void> => {
    if ((!updateChannel && !macUpdates) || !updates.configured || updateReserved || shutdownInProgress) throw new Error("Update services are unavailable or busy.");
    if (kind === "install" && (updates.status !== "available" || recordingControl || recording.busy || recording.recoveryAvailable || downloading ||
        keyCapture || shortcut.configuring || pasteState.configuring || macShortcut?.state().configuring || !preferences.snapshot().setup_completed)) {
      throw new Error("Finish the current recording, download or setup before installing an update.");
    }
    // A request resolves after its write, not its terminal response. Keep the reservation until that response or retirement.
    updateReserved = kind; updates = { ...updates, status: kind === "check" ? "checking" : "installing", error: null, progress: 0 }; notify();
    if (macUpdates) {
      const controller = new AbortController(); macUpdateAbort = controller;
      try {
        if (kind === "check") {
          const task = macUpdates.check(controller.signal); macUpdateOperation = task;
          const candidate = await task;
          if (macUpdateOperation === task) macUpdateOperation = undefined;
          if (shutdownInProgress) return;
          updates = { ...updates, status: candidate ? "available" : "current", version: candidate?.version ?? null, error: null };
          updateReserved = undefined; notify();
        } else {
          const task = macUpdates.prepareInstall(controller.signal).then((prepared) => { macPrepared = prepared; return prepared; });
          macUpdateOperation = task;
          const prepared = await task;
          if (macUpdateOperation === task) macUpdateOperation = undefined;
          if (shutdownInProgress) return;
          await finishShutdown(false, prepared);
        }
      } catch {
        if (!shutdownInProgress) {
          updateReserved = undefined; updates = { ...updates, status: "error", error: "The update could not be completed." }; notify();
        }
        throw new Error("The update could not be completed.");
      } finally {
        macUpdateOperation = undefined;
        if (macUpdateAbort === controller) macUpdateAbort = undefined;
      }
      return;
    }
    const channel = updateChannel;
    if (!channel) { updateReserved = undefined; throw new Error("Update services are unavailable."); }
    try { await channel.request(kind); }
    catch { await channel.close(); throw new Error("The update connection failed."); }
  };
  const ownedMacUpdateFixture = "--owned-macos-update-fixture";
  if (process.argv.filter((argument) => argument === ownedMacUpdateFixture).length > 1) throw new Error("Invalid owned Mac updater test mode.");
  if (process.argv.includes(ownedMacUpdateFixture)) {
    if (process.platform !== "darwin" || identity.kind !== "stable" || !app.isPackaged || !macUpdateAdmission || !macUpdates ||
      version !== "0.3.1" || macUpdateAdmission.repository !== "juferdinand/OpenWhisper") throw new Error("Owned Mac updater test mode is unavailable.");
    let invoked = false;
    Object.defineProperty(app, "openWhisperRunOwnedMacUpdateFixture", { configurable: false, enumerable: false, value: async (): Promise<void> => {
      if (invoked || shutdownInProgress || !preferences.snapshot().setup_completed) throw new Error("Owned Mac updater fixture is not ready.");
      invoked = true;
      macUpdates = createMacosUpdateCoordinator({ admission: macUpdateAdmission!, identity, currentVersion: version,
        cacheDirectory: profile.paths.cache }, ownedMacosUpdateFixtureEffects({ archive: join(profile.paths.cache, "owned-macos-successor.zip"),
        repository: macUpdateAdmission!.repository, currentVersion: version, expectedVersion: "0.3.2" }));
      const candidate = await macUpdates.check(new AbortController().signal);
      if (!candidate || candidate.version !== "0.3.2") throw new Error("Owned Mac updater fixture was not admitted.");
      updates = { ...updates, status: "available", version: candidate.version, error: null, progress: 0 }; notify();
      await requestUpdate("install");
    } });
  }
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownInProgress) return;
    if (macRecording && recording.recoveryAvailable) {
      message = "Retry or discard the stopped recording before quitting. Its audio is kept in memory."; showSettings(); notify(); return;
    }
    void finishShutdown(false).catch(() => {});
  });
  const dispatcher = createUiDispatcher({
    windows: [{ webContentsId: contents.id, role: "main" }, ...(overlay ? [{ webContentsId: overlay.webContents.id, role: "overlay" as const }] : [])],
    handlers: {
      get_state: () => state(),
      window_action: ({ action: windowAction }) => performWindowAction(window, windowAction),
      check_updates: () => requestUpdate("check"),
      install_update: () => requestUpdate("install"),
      save_preferences: ({ changes }) => withRecordingControl(async () => {
        if (changes.auto_check_updates === true && !updates.configured) throw new Error("Update services are not configured in this build.");
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
        if (changes.gpu && !gpuSelection.supported) throw new Error("GPU support is not included in this build.");
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
      complete_setup: () => withRecordingControl(async () => {
        await refreshModels();
        if (!installed.some((item) => item.model.id === preferences.snapshot().model)) {
          throw new Error("Download and select an installed speech model before completing setup.");
        }
        await preferences.completeSetup();
        emit("state", state());
      }),
      open_login_settings: () => {
        if (!(autostart instanceof MacosAutostart)) throw new Error("Login settings are unavailable in this installation.");
        autostart.openSettings();
      },
      save_local_processing: ({ changes }) => withRecordingControl(async () => {
        await processingProfile.update((current) => applyLocalProcessingProfilePatch(current, changes));
        const current = state();
        emit("state", current);
        return current;
      }),
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
      capture_mouse_trigger: ({ button }) => recordingAction(async () => {
        if (!keyCapture || !shortcut.nativeMouse || !platformHost || !window?.isFocused() ||
            recording.busy || recording.recoveryAvailable || shutdownInProgress) {
          throw new Error("Mouse trigger setup is unavailable.");
        }
        if (button === 2 && !shortcut.nativeMiddleMouse) throw new Error("Middle mouse triggers require KDE Plasma 6.3 or newer.");
        keyCapture = undefined; contents.setIgnoreMenuShortcuts(false);
        await platformHost.bindMouse(button, preferences.snapshot().hold_to_record);
      }),
      enable_paste: () => recordingAction(async () => {
        if (macPaste) {
          accessibilityAllowed = systemPreferences.isTrustedAccessibilityClient(true);
          if (!accessibilityAllowed) await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
          return;
        }
        if (!platformHost) throw new Error("Keyboard permission unavailable."); await platformHost.pastePermission("enable");
      }),
      disable_paste: () => recordingAction(async () => {
        if (macPaste) { await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"); return; }
        if (!platformHost) throw new Error("Keyboard permission unavailable."); await platformHost.pastePermission("clear");
      }),
      toggle_recording: toggleRecording,
      cancel_recording: cancelRecording,
      retry_transcription: () => recordingAction(async () => { await configureRecording(); if (cancelRequested) return; inferenceProgress = 0; await host?.command("retry"); }),
      discard_recovery: () => recordingAction(async () => { await configureRecording(); if (!cancelRequested) await host?.command("discard"); }),
      refresh_microphones: () => recordingAction(async () => { if (!host) throw new Error("Recording unavailable.");
        if (macRecording) { microphoneAllowed = systemPreferences.getMediaAccessStatus("microphone") === "granted"; return; }
        audioServer = await checkedAudioServer(); sources = await host.enumerate(audioServer); }),
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
        if (shutdownInProgress || updateReserved === "install") throw new Error("An update is being prepared.");
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
  if (updateChannel || macUpdates) {
    const autoCheck = (): void => {
      if (shutdownInProgress) return;
      if (automaticUpdateCheckAllowed && updates.configured && preferences.snapshot().auto_check_updates && !updateReserved) void requestUpdate("check").catch(() => {});
      autoCheckTimer = setTimeout(autoCheck, 24 * 60 * 60 * 1000);
    };
    autoCheckTimer = setTimeout(autoCheck, 10_000);
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
  const bootstrap = await prepareApplication().catch((error: unknown) => {
    // Startup diagnostics are categorical: no preferences, paths, audio or user text.
    console.error(formatBootstrapFailure(bootstrapStage, error, bootstrapLoginStatus));
    app.exit(1);
    return undefined;
  });
  if (bootstrap) void start(bootstrap).catch(() => {
    console.error("OpenWhisper could not initialize its application services or UI.");
    app.exit(1);
  });
}

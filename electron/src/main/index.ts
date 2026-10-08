import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session, shell, systemPreferences } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  appStateSchema, modelSchema, validateEvent, MAX_USER_TEXT_BYTES,
  type AppState, type EventName, type EventPayload,
} from "../contracts/ui.js";
import { DevelopmentPreferenceStore } from "../services/preferences.js";
import { PrivateStateStore } from "../services/private-state.js";
import { LocalProcessingService, LocalProcessingError } from "../services/local-processing.js";
import {
  localProcessingProfileSchema, defaultLocalProcessingProfile, applyLocalProcessingProfilePatch,
} from "../contracts/local-processing.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../services/profiles.js";
import { CONTENT_SECURITY_POLICY, MAIN_URL, readApplicationAsset } from "./assets.js";
import { createUiDispatcher, uiFailure, type UiSender } from "./ipc.js";
import { ModelInventory, type InstalledModel } from "../services/model-inventory.js";
import { ModelDownloads } from "../services/model-download.js";
import { recordingRequestSchema } from "../core/recording.js";
import type { RecordingSource } from "../workers/recording-host-protocol.js";
import { recordingSnapshotSchema } from "../workers/recording-host-protocol.js";
import { DEVELOPMENT_RECORDING_BUILD } from "./development-recording-build.js";
import { developmentRecordingDescriptorSchema } from "./development-recording-descriptor.js";
import { DevelopmentRecordingHost, developmentPulseServer } from "./development-recording-host.js";
import { saveDevelopmentTranscript } from "../services/development-transcripts.js";
import { DevelopmentPlatformHost } from "./development-platform-host.js";
import { createRecordingControlPort } from "./recording-control.js";
import { portalShortcutStateSchema } from "../platforms/linux/shared/portal-shortcuts.js";

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

async function start(): Promise<void> {
  // This first slice can only start an isolated Dev host, never the stable profile.
  if (process.argv.includes("--production") || process.argv.includes("--stable")) {
    throw new Error("The production host is not implemented yet.");
  }
  const explicitRoot = selectedProfile();
  const profile = resolveDevelopmentProfile({
    home: homedir(),
    ...(process.env["XDG_CONFIG_HOME"] ? { configHome: process.env["XDG_CONFIG_HOME"] } : {}),
    ...(process.env["XDG_DATA_HOME"] ? { dataHome: process.env["XDG_DATA_HOME"] } : {}),
    ...(process.env["XDG_CACHE_HOME"] ? { cacheHome: process.env["XDG_CACHE_HOME"] } : {}),
    ...(explicitRoot ? { explicitRoot } : {}),
  });
  prepareDevelopmentProfile(profile);
  app.setName(profile.productName);
  app.setPath("userData", profile.roots.config);
  app.setPath("sessionData", profile.paths.session);
  app.setAppLogsPath(profile.paths.logs);
  app.commandLine.appendSwitch("disk-cache-dir", profile.paths.cache);
  if (process.platform === "linux") app.setDesktopName(`${profile.appId}.desktop`);
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); }
  });
  app.on("window-all-closed", () => { app.quit(); });
  await app.whenReady();
  const preferences = await DevelopmentPreferenceStore.open(profile);
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
  let recording = recordingSnapshotSchema.parse({ phase: "idle", generation: 0, elapsedMs: 0, level: 0,
    busy: false, recoveryAvailable: false, error: null, transcript: "" });
  let message = "", inferenceProgress = 0;
  let download: string | null = null, downloadProgress = 0;
  let downloading: Promise<void> | undefined, downloadAbort: AbortController | undefined;
  const history = await PrivateStateStore.open(join(profile.paths.history, "history.json"),
    z.array(z.string().max(MAX_USER_TEXT_BYTES)).max(20), [], 8 * 1024 * 1024, { invalidContent: "preserve-and-default" });
  let notify = (): void => {};
  const downloads = await ModelDownloads.open(profile, inventory, { progress: (value) => {
    downloadProgress = value.total > 0 ? Math.min(1, value.received / value.total) : 0; notify();
  } });
  const refreshModels = async (): Promise<void> => { installed = await inventory.installed(); };
  const descriptor = DEVELOPMENT_RECORDING_BUILD === null ? null : developmentRecordingDescriptorSchema.parse(DEVELOPMENT_RECORDING_BUILD);
  const macRecording = descriptor?.platform === "darwin";
  let microphoneAllowed = macRecording && systemPreferences.getMediaAccessStatus("microphone") === "granted";
  let platformHost: DevelopmentPlatformHost | undefined;
  let shortcut = portalShortcutStateSchema.parse({ available: false, configuring: false, label: null, result: "NONE" });
  if (descriptor) {
    host = await DevelopmentRecordingHost.open(resolve(distribution, ".."), descriptor, inventory, {
      recoveryPath: profile.paths.recovery,
      snapshot: (value) => { recording = value; if (value.phase !== "error") message = ""; notify(); },
      progress: (value) => { inferenceProgress = recording.elapsedMs > 0
        ? Math.min(1, value.completedSamples / (recording.elapsedMs * 16)) : 0; notify(); },
      delivery: { deliver: async (text, context) => {
        if (context.signal.aborted) return { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false };
        const oversized = Buffer.byteLength(text, "utf8") > MAX_USER_TEXT_BYTES;
        if (oversized && preferences.snapshot().keep_history) {
          try { await saveDevelopmentTranscript(profile, text); }
          catch { return { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false }; }
        }
        if (context.signal.aborted) return { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false };
        await clipboard.writeText(text);
        if (await clipboard.readText() !== text) return { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false };
        if (!oversized && preferences.snapshot().keep_history) {
          // History is secondary to the already confirmed clipboard commit.
          void history.update((current) => {
            const next = [text, ...current].slice(0, 20);
            while (next.length > 1 && Buffer.byteLength(JSON.stringify(next), "utf8") > 6 * 1024 * 1024) next.pop();
            if (Buffer.byteLength(JSON.stringify(next), "utf8") > 8 * 1024 * 1024) return current;
            return next;
          }).then(notify, () => { message = "Text copied; history could not be saved."; notify(); });
        }
        return { generation: context.generation, attempt: context.attempt, outcome: "clipboard", clipboardConfirmed: true };
      } },
    });
    if (descriptor.platform === "linux") {
      try { audioServer = await developmentPulseServer(); sources = await host.enumerate(audioServer); }
      catch { message = "A local audio server is not available."; }
    }
  }
  const version = (await readFile(join(distribution, "resources/VERSION"), "utf8")).trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("The development build has an invalid project version.");
  }
  const buildRaw: unknown = JSON.parse(await readFile(join(distribution, "resources/development-build.json"), "utf8"));
  const build = z.strictObject({ commit: z.string().regex(/^([a-f0-9]{40}|source)$/), modified: z.boolean() }).parse(buildRaw);
  const platform = process.platform === "darwin" ? "macos" : "linux";
  const state = (): AppState => appStateSchema.parse({
    updates: { configured: false, status: "idle", version: null, progress: 0, error: null, package: "development" },
    platform,
    ...(platform === "macos" ? { macos: {
      microphone_allowed: microphoneAllowed, recording_shortcut: false, shortcut_hint: "Not configured",
      editor: "", recommended: [], updates_configured: false, launch_at_login_pending: false,
    } } : {}),
    version, status: recording.phase === "starting" ? "recording"
      : ["stopping", "restoring", "discarding"].includes(recording.phase) ? "transcribing" : recording.phase,
    message: message || (Buffer.byteLength(recording.transcript, "utf8") > MAX_USER_TEXT_BYTES
      ? "The complete transcript exceeds the preview size. Use Copy to retrieve the full text."
      : recording.error ? `Recording failed: ${recording.error}.` : descriptor ? "" : "Recording is not available in this development preview."),
    transcript: Buffer.byteLength(recording.transcript, "utf8") <= MAX_USER_TEXT_BYTES ? recording.transcript : "",
    transcript_preview_omitted: Buffer.byteLength(recording.transcript, "utf8") > MAX_USER_TEXT_BYTES,
    history: history.snapshot().filter((text) => Buffer.byteLength(text, "utf8") <= MAX_USER_TEXT_BYTES), preferences: preferences.snapshot(),
    models: [...catalog.models, ...installed.filter((item) => !catalog.models.some((model) => model.id === item.model.id)).map((item) => item.model)],
    installed: installed.map((item) => item.model.id), microphones: sources.map((source) => source.id),
    session: process.env["XDG_SESSION_TYPE"] ?? "unknown",
    desktop: process.env["XDG_CURRENT_DESKTOP"] ?? "unknown", clipboard_available: descriptor !== null,
    shortcut_portal: shortcut.available, paste_portal: false, shortcut: shortcut.label, native_shortcuts: false,
    shortcut_configuring: shortcut.configuring,
    native_x11: false, native_paste: false, native_mouse: false, native_middle_mouse: false,
    recording_shortcut: false, paste_ready: false, gpu_available: false, gpu_supported: false,
    gpu_device: null, gpu_fallback: false, recovery_available: recording.recoveryAvailable, overlay_available: false,
    download, progress: download ? downloadProgress : inferenceProgress,
    elapsed: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(recording.elapsedMs / 1000)), level: recording.level,
    model_directory: profile.paths.models,
    profile: "development", recording_available: !!host && (macRecording ? microphoneAllowed || recording.busy : !!audioServer || recording.busy) &&
      (recording.busy || installed.some((item) => item.model.id === preferences.snapshot().model)),
    development_build: `${build.commit.slice(0, 12)}${build.modified ? "+modified" : ""}`,
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
  const emit = <N extends EventName>(name: N, payload: EventPayload<N>): void => {
    if (!contents.isDestroyed() && contents.mainFrame.url === MAIN_URL) {
      contents.send(`openwhisper:event:${name}`, validateEvent(name, payload));
    }
  };
  notify = () => {
    try { emit("state", state()); }
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
    if (!model || selected.output !== "clipboard" || selected.gpu) throw new Error("Choose an installed model and CPU clipboard output.");
    // Recovery may be transcribed with the microphone disconnected; resolve sources only on Start.
    const request = recordingRequestSchema.parse({ model: { path: join(profile.paths.models, model.model.file), family: model.model.family, gpu: false },
      language: selected.language, vocabulary: selected.vocabulary, snippets: selected.snippets });
    await host.configure({ id: model.model.id, request,
      ...(macRecording ? {} : { server: audioServer ?? `unix:${join(process.env.XDG_RUNTIME_DIR ?? profile.paths.locks, "pulse/native")}`,
        source: selected.microphone }) }); configured = true;
  };
  if (host && descriptor?.platform === "linux" && descriptor.platformServices) {
    try {
      platformHost = await DevelopmentPlatformHost.open({
        descriptor: { root: resolve(distribution, ".."), ...descriptor.platformServices },
        address: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
        shortcuts: (value) => {
          shortcut = value;
          const messages = { NONE: "", ENABLED: "Global shortcut enabled. Your desktop controls its key binding.",
            UNASSIGNED: "No shortcut assigned. Choose a key combination in your desktop's shortcut settings.",
            CANCELLED: "Shortcut setup was cancelled. Window recording remains usable.",
            ENDED: "Shortcut session ended. Enable it again in Settings.",
            CONFIGURE_UNAVAILABLE: "Change this shortcut in your desktop's settings. Its current binding remains active.",
            FAILED: "Shortcut setup or recording failed. Window recording remains usable." };
          message = messages[value.result]; notify();
        },
        capture: createRecordingControlPort({ owner: host, snapshot: () => recording, configure: configureRecording,
          serialize: withRecordingControl,
          cleanupSerialize: <T>(operation: () => Promise<T>) => withRecordingControl(operation, true),
          available: () => !shutdownInProgress && !!audioServer && installed.some((item) => item.model.id === preferences.snapshot().model) }),
      }, new AbortController().signal);
    } catch { message = "Desktop command control is not available. Window recording remains usable."; }
  }
  const shortcutAction = (command: "enable" | "configure" | "clear" | "cancel"): Promise<void> => action(async () => {
    if (!platformHost || ((recording.busy || recording.recoveryAvailable) && command !== "cancel")) throw new Error("Shortcut setup is unavailable.");
    await platformHost.shortcut(command, preferences.snapshot().hold_to_record);
  });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownInProgress) return;
    if (macRecording && recording.recoveryAvailable) {
      message = "Retry or discard the stopped recording before quitting. Its audio is kept in memory."; notify(); return;
    }
    shutdownInProgress = true; cancelRequested = true; processing.close(); downloadAbort?.abort();
    void (async () => { await recordingOperation?.catch(() => {}); await downloading; await downloads.finalize();
      await platformHost?.close(); await host?.close(); })().then(() => {
      shutdownComplete = true; app.quit();
    }, () => {
      // Preserve uncertain owners and the private recovery files for explicit review.
      shutdownInProgress = false; message = "Recording cleanup could not finish. Recording data and uncertain processes are kept."; notify();
    });
  });
  const dispatcher = createUiDispatcher({
    windows: [{ webContentsId: contents.id, role: "main" }],
    handlers: {
      get_state: () => state(),
      save_preferences: ({ changes }) => withRecordingControl(async () => {
        if (changes.model && !catalog.models.some((model) => model.id === changes.model) && !installed.some((item) => item.model.id === changes.model)) {
          throw new Error("Unknown catalog model.");
        }
        if ((recording.busy || recording.recoveryAvailable) &&
          ["model", "language", "microphone", "vocabulary", "snippets", "gpu", "output", "hold_to_record"].some((key) => Object.hasOwn(changes, key))) {
          throw new Error("Finish or discard the current recording before changing its request.");
        }
        if (changes.output && changes.output !== "clipboard") throw new Error("The recording Dev build supports clipboard output.");
        if (changes.gpu) throw new Error("The recording Dev build uses CPU inference.");
        await preferences.patch(changes);
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
      toggle_recording: () => recordingAction(async () => {
        if (!host) throw new Error("Recording unavailable.");
        if (recording.phase === "recording" || recording.phase === "starting") await host.command("stop");
        else { await configureRecording(); if (cancelRequested) return; inferenceProgress = 0; await host.command("start"); }
      }),
      cancel_recording: () => action(async () => { cancelRequested = true; if (host?.isConfigured()) await host.command("cancel"); }),
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
      copy_transcript: async () => { await clipboard.writeText(recording.transcript); },
      copy_history: async ({ index }) => { const text = history.snapshot().filter((item) => Buffer.byteLength(item, "utf8") <= MAX_USER_TEXT_BYTES)[index]; if (text !== undefined) await clipboard.writeText(text); },
      clear_history: () => action(async () => { await history.update(() => []); }),
      show_models_folder: () => action(async () => { if (await shell.openPath(profile.paths.models)) throw new Error("Folder unavailable."); }),
      show_transcripts_folder: () => action(async () => { if (await shell.openPath(profile.paths.transcripts)) throw new Error("Folder unavailable."); }),
    },
  });
  ipcMain.handle("openwhisper:invoke", async (event, request: unknown) => {
    if (shutdownInProgress) return uiFailure("UNAVAILABLE_COMMAND");
    if (contents.isDestroyed()) return uiFailure("UNTRUSTED_SENDER");
    const result = await dispatcher.dispatch({ sender: sender(event), serializedRequest: request });
    if (contents.isDestroyed() || !dispatcher.isTrustedSender(sender(event))) {
      return uiFailure("UNTRUSTED_SENDER");
    }
    return result;
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => { event.preventDefault(); });
  contents.on("will-attach-webview", (event) => { event.preventDefault(); });
  window.on("close", (event) => { if (!shutdownComplete) { event.preventDefault(); app.quit(); } });
  window.on("closed", () => { processing.close(); ipcMain.removeHandler("openwhisper:invoke"); window = undefined; });
  window.once("ready-to-show", () => { window?.show(); });
  if (macRecording) window.on("focus", () => {
    microphoneAllowed = systemPreferences.getMediaAccessStatus("microphone") === "granted"; notify();
  });
  await window.loadURL(MAIN_URL);
  // A hidden Wayland surface may wait for mapping before producing its first
  // frame. Do not make initial visibility depend only on ready-to-show.
  if (window && !window.isDestroyed() && !window.isVisible()) window.show();
}

void start().catch(() => {
  // Startup diagnostics are categorical: no preferences, paths, audio or user text.
  console.error("OpenWhisper Dev could not initialize its isolated profile or UI.");
  app.exit(1);
});

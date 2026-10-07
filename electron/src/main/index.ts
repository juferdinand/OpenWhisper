import { app, BrowserWindow, ipcMain, Menu, protocol, session } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  appStateSchema, modelSchema, validateEvent,
  type AppState, type EventName, type EventPayload,
} from "../contracts/ui.js";
import { DevelopmentPreferenceStore } from "../services/preferences.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../services/profiles.js";
import { CONTENT_SECURITY_POLICY, MAIN_URL, readApplicationAsset } from "./assets.js";
import { createUiDispatcher, uiFailure, type UiSender } from "./ipc.js";

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
  const rawCatalog: unknown = JSON.parse(await readFile(join(distribution, "resources/models.json"), "utf8"));
  const catalog = z.object({ models: z.array(modelSchema).min(1).max(128) }).parse(rawCatalog);
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
      microphone_allowed: false, recording_shortcut: false, shortcut_hint: "Not configured",
      editor: "", recommended: [], updates_configured: false, launch_at_login_pending: false,
    } } : {}),
    version, status: "idle", message: "Recording is not available in this development preview.",
    transcript: "", history: [], preferences: preferences.snapshot(), models: catalog.models,
    installed: [], microphones: [], session: process.env["XDG_SESSION_TYPE"] ?? "unknown",
    desktop: process.env["XDG_CURRENT_DESKTOP"] ?? "unknown", clipboard_available: false,
    shortcut_portal: false, paste_portal: false, shortcut: null, native_shortcuts: false,
    native_x11: false, native_paste: false, native_mouse: false, native_middle_mouse: false,
    recording_shortcut: false, paste_ready: false, gpu_available: false, gpu_supported: false,
    gpu_device: null, gpu_fallback: false, recovery_available: false, overlay_available: false,
    download: null, progress: 0, elapsed: 0, level: 0, model_directory: profile.paths.models,
    profile: "development", recording_available: false,
    development_build: `${build.commit.slice(0, 12)}${build.modified ? "+modified" : ""}`,
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
  const dispatcher = createUiDispatcher({
    windows: [{ webContentsId: contents.id, role: "main" }],
    handlers: {
      get_state: () => state(),
      save_preferences: async ({ changes }) => {
        if (changes.model && !catalog.models.some((model) => model.id === changes.model)) {
          throw new Error("Unknown catalog model.");
        }
        await preferences.patch(changes);
        const current = state();
        emit("state", current);
        return current;
      },
      complete_setup: async () => {
        await preferences.completeSetup();
        emit("state", state());
      },
    },
  });
  ipcMain.handle("openwhisper:invoke", async (event, request: unknown) => {
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
  window.on("closed", () => { ipcMain.removeHandler("openwhisper:invoke"); window = undefined; });
  window.once("ready-to-show", () => { window?.show(); });
  await window.loadURL(MAIN_URL);
}

void start().catch(() => {
  // Startup diagnostics are categorical: no preferences, paths, audio or user text.
  console.error("OpenWhisper Dev could not initialize its isolated profile or UI.");
  app.exit(1);
});

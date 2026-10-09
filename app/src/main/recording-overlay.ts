import type { BrowserWindowConstructorOptions } from "electron";
import type { AppState } from "../contracts/ui/state.js";

export function supportsInactiveRecordingOverlay({ platform, sessionType, ozonePlatform, waylandDisplay }: Readonly<{
  platform: string; sessionType?: string; ozonePlatform?: string; waylandDisplay?: string;
}>): boolean {
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  if (ozonePlatform === "x11") return true;
  // Native Wayland needs a compositor-aware overlay to preserve keyboard focus.
  return ozonePlatform !== "wayland" && sessionType !== "wayland" && !waylandDisplay;
}

export function overlayWindowOptions({ title, preloadPath }: Readonly<{ title: string; preloadPath: string }>): BrowserWindowConstructorOptions {
  return {
    title, width: 360, height: 64,
    transparent: true, frame: false, show: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, resizable: false, hasShadow: false,
    webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false },
  };
}

export function waylandOverlayWindowOptions(options: Readonly<{ title: string; preloadPath: string }>): BrowserWindowConstructorOptions {
  const base = overlayWindowOptions(options);
  return { ...base, webPreferences: { ...base.webPreferences,
    offscreen: { useSharedTexture: false, deviceScaleFactor: 1 }, backgroundThrottling: false,
  } };
}

export function shouldShowRecordingOverlay(state: AppState): boolean {
  return state.status === "recording" || state.status === "transcribing" ||
    state.recovery_available === true || state.preferences.show_idle_overlay === true;
}

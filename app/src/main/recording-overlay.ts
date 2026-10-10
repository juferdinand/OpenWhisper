import type { BrowserWindowConstructorOptions, Rectangle } from "electron";
import type { AppState } from "../contracts/ui/state.js";
import { HEIGHT, WIDTH } from "../contracts/platforms/wayland-surface.js";

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
    title, width: WIDTH, height: HEIGHT,
    transparent: true, frame: false, show: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, resizable: false, hasShadow: false,
    webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false },
  };
}

export function overlayWindowBounds(area: Readonly<Rectangle>): Rectangle {
  return { x: Math.floor(area.x + (area.width - WIDTH) / 2),
    y: Math.floor(area.y + area.height - HEIGHT - 24), width: WIDTH, height: HEIGHT };
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

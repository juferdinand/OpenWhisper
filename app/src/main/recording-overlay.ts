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

export function overlayWindowOptions({ title, preloadPath, platform = process.platform }: Readonly<{
  title: string; preloadPath: string; platform?: string;
}>): BrowserWindowConstructorOptions {
  return {
    title, width: WIDTH, height: HEIGHT,
    transparent: true, frame: false, show: false, focusable: false,
    // A click on a normal window first activates OpenWhisper, which brought the main window forward
    // and swallowed the click. A non-activating panel lets Cancel and Stop act directly.
    ...(platform === "darwin" ? { type: "panel", acceptFirstMouse: true } : {}),
    skipTaskbar: true, alwaysOnTop: true, resizable: false, hasShadow: false,
    webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false },
  };
}

export function overlayWindowBounds(area: Readonly<Rectangle>): Rectangle {
  return { x: Math.floor(area.x + (area.width - WIDTH) / 2),
    y: Math.floor(area.y + area.height - HEIGHT - 24), width: WIDTH, height: HEIGHT };
}

/** Linux/X11 can pass clicks through the transparent corners of the capsule. */
export function overlayInputShape(): Rectangle[] {
  const radius = HEIGHT / 2;
  return Array.from({ length: HEIGHT }, (_, y) => {
    const distance = Math.abs(y + 0.5 - radius);
    const inset = Math.max(0, Math.ceil(radius - Math.sqrt(radius * radius - distance * distance) - 0.5));
    return { x: inset, y, width: WIDTH - inset * 2, height: 1 };
  });
}

export function waylandOverlayWindowOptions(options: Readonly<{ title: string; preloadPath: string }>): BrowserWindowConstructorOptions {
  const base = overlayWindowOptions(options);
  return { ...base, webPreferences: { ...base.webPreferences,
    offscreen: { useSharedTexture: false, deviceScaleFactor: 1 }, backgroundThrottling: false,
  } };
}

export function shouldShowRecordingOverlay(state: AppState, foreground: boolean): boolean {
  if (foreground) return false;
  return state.status === "recording" || state.status === "transcribing" ||
    state.recovery_available === true || state.preferences.show_idle_overlay === true;
}

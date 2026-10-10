import assert from "node:assert/strict";
import test from "node:test";
import type { AppState } from "../../src/contracts/ui/state.js";
import { overlayWindowBounds, overlayWindowOptions, shouldShowRecordingOverlay, supportsInactiveRecordingOverlay, waylandOverlayWindowOptions } from "../../src/main/recording-overlay.js";

function state(): AppState {
  return {
    updates: { configured: false, status: "idle", version: null, progress: 0, error: null, package: "development" },
    platform: "linux", version: "0.3.0", status: "idle", message: "", transcript: "", history: [],
    preferences: {
      ui_language: "en", setup_completed: true, model: "tiny", language: "auto", microphone: "",
      vocabulary: "", snippets: [], output: "clipboard", hold_to_record: false, gpu: false, keep_history: true,
    },
    models: [], installed: [], microphones: [], session: "Wayland", desktop: "Owned fixture", clipboard_available: true,
    shortcut_portal: false, paste_portal: false, shortcut: null, paste_ready: false, gpu_available: false,
    download: null, progress: 0, elapsed: 0, model_directory: "", recording_available: true,
  };
}

test("inactive overlay capability permits the existing macOS and plain X11 paths", () => {
  assert.equal(supportsInactiveRecordingOverlay({ platform: "darwin" }), true);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", sessionType: "x11" }), true);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux" }), true);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", sessionType: "x11", waylandDisplay: "" }), true);
});

test("native Wayland capability guard prevents the observed BrowserWindow focus regression", () => {
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", sessionType: "wayland" }), false);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", waylandDisplay: "openwhisper-owned" }), false);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", sessionType: "wayland", ozonePlatform: "auto" }), false);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", sessionType: "x11", ozonePlatform: "wayland" }), false);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", ozonePlatform: "wayland" }), false);
});

test("an explicit X11 compatibility backend permits its overlay inside a Wayland session", () => {
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", sessionType: "wayland", ozonePlatform: "x11",
    waylandDisplay: "openwhisper-owned" }), true);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "linux", ozonePlatform: "x11" }), true);
});

test("overlay capability does not claim unimplemented platforms even with an X11 option", () => {
  assert.equal(supportsInactiveRecordingOverlay({ platform: "win32", ozonePlatform: "x11" }), false);
  assert.equal(supportsInactiveRecordingOverlay({ platform: "freebsd" }), false);
});

test("overlay uses its trusted preload with sandbox isolation and no renderer Node integration", () => {
  const options = overlayWindowOptions({ title: "OpenWhisper Dev Recording", preloadPath: "/owned/preload.cjs" });
  assert.equal(options.title, "OpenWhisper Dev Recording");
  assert.equal(options.webPreferences?.preload, "/owned/preload.cjs");
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(options.webPreferences?.contextIsolation, true);
  assert.equal(options.webPreferences?.nodeIntegration, false);
});

test("overlay starts hidden and cannot activate or resize the transparent floating controls", () => {
  const options = overlayWindowOptions({ title: "Recording", preloadPath: "/owned/preload.cjs" });
  assert.equal(options.show, false); assert.equal(options.focusable, false);
  assert.equal(options.transparent, true); assert.equal(options.frame, false);
  assert.equal(options.skipTaskbar, true); assert.equal(options.alwaysOnTop, true);
  assert.equal(options.resizable, false); assert.equal(options.hasShadow, false);
  assert.equal(options.width, 476); assert.equal(options.height, 68);
});

test("native Wayland renders the shared controls offscreen without mapping a BrowserWindow", () => {
  const options = waylandOverlayWindowOptions({ title: "Recording", preloadPath: "/owned/preload.cjs" });
  assert.equal(options.show, false); assert.equal(options.focusable, false);
  assert.deepEqual(options.webPreferences?.offscreen, { useSharedTexture: false, deviceScaleFactor: 1 });
  assert.equal(options.webPreferences?.backgroundThrottling, false);
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(options.webPreferences?.nodeIntegration, false);
});

test("overlay stays centered with a 24-pixel bottom inset on offset displays", () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1080 },
    { x: -1920, y: -100, width: 1920, height: 1080 }]) {
    const bounds = overlayWindowBounds(area);
    assert.equal(bounds.x + bounds.width / 2, area.x + area.width / 2);
    assert.equal(area.y + area.height - bounds.y - bounds.height, 24);
  }
});

test("overlay follows active recording and transcription then hides completed or failed phases", () => {
  const current = state(), visible: boolean[] = [];
  for (const status of ["idle", "recording", "transcribing", "done", "idle", "recording", "error"] as const) {
    current.status = status; visible.push(shouldShowRecordingOverlay(current));
  }
  assert.deepEqual(visible, [false, true, true, false, false, true, false]);
});

test("saved recovery keeps retry controls visible until delivery or explicit discard", () => {
  const current = state(); current.status = "error"; current.recovery_available = true;
  assert.equal(shouldShowRecordingOverlay(current), true);
  current.status = "idle"; assert.equal(shouldShowRecordingOverlay(current), true);
  current.status = "transcribing"; assert.equal(shouldShowRecordingOverlay(current), true);
  current.status = "done"; current.recovery_available = false;
  assert.equal(shouldShowRecordingOverlay(current), false);
  current.status = "error"; current.recovery_available = true;
  assert.equal(shouldShowRecordingOverlay(current), true);
  current.recovery_available = false; assert.equal(shouldShowRecordingOverlay(current), false);
});

test("idle overlay preference applies immediately without hiding active or recoverable work", () => {
  const current = state(); assert.equal(shouldShowRecordingOverlay(current), false);
  current.preferences.show_idle_overlay = true;
  for (const status of ["idle", "done", "error"] as const) {
    current.status = status; assert.equal(shouldShowRecordingOverlay(current), true);
  }
  current.preferences.show_idle_overlay = false; assert.equal(shouldShowRecordingOverlay(current), false);
  current.status = "recording"; assert.equal(shouldShowRecordingOverlay(current), true);
  current.status = "transcribing"; assert.equal(shouldShowRecordingOverlay(current), true);
  current.status = "error"; current.recovery_available = true;
  assert.equal(shouldShowRecordingOverlay(current), true);
});

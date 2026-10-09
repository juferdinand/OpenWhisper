import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import { z } from "zod";
import type { AppState } from "../../../src/contracts/ui/state.js";
import { buildTrayMenu, type TrayMenuActions } from "../../../src/main/tray-menu.js";

function state(changes: Partial<AppState> = {}): AppState {
  return {
    updates: { configured: false, status: "idle", version: null, progress: 0, error: null, package: "development" },
    platform: "linux", version: "0.3.0", status: "idle", message: "", transcript: "", history: [],
    preferences: { ui_language: "en", setup_completed: true, model: "tiny", language: "auto", microphone: "",
      vocabulary: "", snippets: [], output: "clipboard", hold_to_record: false, gpu: false, keep_history: true },
    models: [], installed: [], microphones: [], session: "wayland", desktop: "Owned fixture", clipboard_available: true,
    shortcut_portal: false, paste_portal: false, shortcut: null, paste_ready: false, gpu_available: false,
    download: null, progress: 0, elapsed: 0, model_directory: "", recording_available: true, recovery_available: false,
    ...changes,
  };
}

function routed() {
  const calls: string[] = [];
  const actions: TrayMenuActions = {
    settings: () => { calls.push("settings"); }, toggleRecording: () => { calls.push("toggle"); },
    cancelRecording: () => { calls.push("cancel"); }, quit: () => { calls.push("quit"); },
  };
  return { calls, actions };
}

function item(menu: readonly MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  const value = menu.find((entry) => entry.id === id); assert.ok(value); return value;
}

function click(value: MenuItemConstructorOptions): void {
  assert.ok(value.click);
  // These callbacks ignore native event arguments; no Electron runtime is needed.
  Reflect.apply(value.click, undefined, []);
}

test("tray starts only an available idle or completed recording without recovery", () => {
  for (const status of ["idle", "done"] as const) {
    const { actions, calls } = routed();
    const toggle = item(buildTrayMenu(state({ status }), actions, (key) => key), "toggle-recording");
    assert.equal(toggle.label, "Start dictation"); assert.equal(toggle.enabled, true);
    click(toggle); assert.deepEqual(calls, ["toggle"]);
  }
});

test("tray cannot start unavailable, missing-capability, transcribing, error or recovery states", () => {
  const refused = [
    state({ recording_available: false }), state({ status: "done", recording_available: false }),
    state({ status: "transcribing" }), state({ status: "error" }),
    state({ recovery_available: true }), state({ status: "done", recovery_available: true }),
    state({ status: "error", recovery_available: true }),
  ];
  const absent = state(); delete absent.recording_available; refused.push(absent);
  for (const snapshot of refused) {
    const { actions, calls } = routed();
    const toggle = item(buildTrayMenu(snapshot, actions, (key) => key), "toggle-recording");
    assert.equal(toggle.label, "Start dictation"); assert.equal(toggle.enabled, false);
    click(toggle); assert.deepEqual(calls, []);
  }
});

test("tray stops an active recording even after capability loss and routes cancellation", () => {
  const { actions, calls } = routed();
  const menu = buildTrayMenu(state({ status: "recording", recording_available: false }), actions, (key) => key);
  const toggle = item(menu, "toggle-recording"), cancel = item(menu, "cancel-recording");
  assert.equal(toggle.label, "Stop recording"); assert.equal(toggle.enabled, true); assert.equal(cancel.enabled, true);
  click(toggle); click(cancel); assert.deepEqual(calls, ["toggle", "cancel"]);
});

test("tray cancellation remains available during transcription but cannot discard recovery", () => {
  const { actions, calls } = routed();
  const cancel = item(buildTrayMenu(state({ status: "transcribing", recording_available: false }), actions, (key) => key), "cancel-recording");
  assert.equal(cancel.enabled, true); click(cancel); assert.deepEqual(calls, ["cancel"]);
  for (const status of ["idle", "done", "error"] as const) {
    for (const recovery_available of [false, true]) {
      const inactive = item(buildTrayMenu(state({ status, recovery_available }), actions, (key) => key), "cancel-recording");
      assert.equal(inactive.enabled, false); click(inactive);
    }
  }
  assert.deepEqual(calls, ["cancel"]);
});

test("tray settings and quit preserve their routes in every recording state", () => {
  for (const status of ["idle", "recording", "transcribing", "done", "error"] as const) {
    const { actions, calls } = routed();
    const menu = buildTrayMenu(state({ status, recording_available: false, recovery_available: true }), actions, (key) => key);
    const settings = item(menu, "settings"), quit = item(menu, "quit");
    assert.equal(settings.enabled, true); assert.equal(quit.enabled, true);
    click(settings); click(quit); assert.deepEqual(calls, ["settings", "quit"]);
  }
});

test("tray labels use the supplied English or German translator and existing shared keys", async () => {
  for (const language of ["en", "de"] as const) {
    const translations = z.record(z.string(), z.string()).parse(JSON.parse(await readFile(new URL(`../../../ui/locales/${language}.json`, import.meta.url), "utf8")));
    for (const status of ["idle", "recording"] as const) {
      const keys: string[] = [];
      const menu = buildTrayMenu(state({ status }), routed().actions, (key) => {
        keys.push(key); const translated = translations[key]; assert.ok(translated); return translated;
      });
      const expectedKeys = ["Settings …", status === "recording" ? "Stop recording" : "Start dictation", "Cancel", "Quit OpenWhisper"];
      assert.deepEqual(keys, expectedKeys);
      assert.deepEqual(menu.filter((entry) => entry.type !== "separator").map((entry) => entry.label), expectedKeys.map((key) => translations[key]));
      assert.equal(item(menu, "settings").label, language === "de" ? "Einstellungen …" : "Settings …");
    }
  }
});

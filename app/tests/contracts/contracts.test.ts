import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  appStateSchema, commandInputSchemas, commandOutputSchemas, MAX_UI_STATE_BYTES,
  MAX_USER_TEXT_BYTES, nonEmptySnippetSchema, preferencesSchema, preferencePatchSchema, snippetSchema,
  validateCommandInput, validateCommandName, validateCommandOutput, validateEvent,
  validateEventName, type AppState, type CommandInput, type CommandOutput,
} from "../../src/contracts/ui/state.js";
import { defaultLocalProcessingProfile } from "../../src/contracts/speech/local-processing.js";

function state(): AppState {
  return {
    updates: { configured: false, status: "idle", version: null, progress: 0, error: null, package: "development" },
    platform: "linux", version: "0.2.5", status: "idle", message: "Ready", transcript: "", history: [],
    preferences: {
      ui_language: "en", setup_completed: false, model: "tiny", language: "auto", microphone: "",
      vocabulary: "", snippets: [], output: "clipboard", hold_to_record: false, gpu: false, keep_history: true,
    },
    models: [{ id: "tiny", title: "Whisper Tiny", family: "whisper", size: "75 MB", note: "Fastest" }],
    installed: [], microphones: [], session: "X11", desktop: "Owned fixture", clipboard_available: false,
    shortcut_portal: false, paste_portal: false, shortcut: null, paste_ready: false, gpu_available: false,
    download: null, progress: 0, elapsed: 0, model_directory: "", profile: "development", recording_available: false,
  };
}

test("legacy Linux catalog and macOS capability snapshots remain valid without adding defaults", () => {
  const linux = state();
  delete linux.profile;
  delete linux.recording_available;
  linux.preferences.gpu_configured = true;
  linux.preferences.native_trigger = { kind: "mouse", button: 8 };
  linux.preferences.x11_trigger = { keycode: 74, keysym: 65477, modifiers: 12, group: 0 };
  linux.models[0] = {
    id: "tiny", title: "Whisper Tiny", family: "whisper", size: "75 MB", note: "Fastest",
    file: "ggml-tiny.bin", repository: "ggerganov/whisper.cpp",
  };
  assert.deepEqual(appStateSchema.parse(linux), linux);
  const mac = {
    ...state(), platform: "macos", initial_tab: "general",
    updates: { ...state().updates, package: "macos" },
    macos: {
      microphone_allowed: false, recording_shortcut: false, shortcut_hint: "Press a key", editor: "TextEdit",
      recommended: ["tiny"], updates_configured: false, launch_at_login_pending: true,
    },
  };
  assert.deepEqual(appStateSchema.parse(mac), mac);
  const imported = { id: "Whisper Deutsch 日本語", title: "Whisper Deutsch 日本語", family: "whisper", size: "", note: "Imported" };
  assert.equal(appStateSchema.safeParse({ ...mac, models: [imported], installed: [imported.id], preferences: { ...mac.preferences, model: imported.id } }).success, true);
  assert.deepEqual(validateCommandInput("delete_model", { id: imported.id }), { id: imported.id });
  assert.equal(appStateSchema.safeParse({ ...state(), platform: "macos" }).success, false);
});

test("schema-derived command maps cover all current renderer actions", async () => {
  const renderer = await readFile(new URL("../../ui/src/main.ts", import.meta.url), "utf8");
  const literalCommands = [
    ...renderer.matchAll(/(?:command|invoke(?:<[^>]+>)?)\(\s*"([a-z_]+)"/g),
    ...renderer.matchAll(/data-(?:command|portal)="([a-z_]+)"/g),
  ];
  for (const match of literalCommands) assert.doesNotThrow(() => validateCommandName(match[1]));
  // Conditional attributes/recording branches are part of the fixed contract as well.
  for (const name of [
    "enable_paste", "disable_paste", "enable_shortcut", "desktop_shortcut", "clear_shortcut",
    "retry_transcription", "discard_recovery", "toggle_recording", "cancel_recording", "check_updates", "install_update",
  ]) assert.doesNotThrow(() => validateCommandName(name));
  assert.equal(Object.keys(commandInputSchemas).length, 31);
  assert.deepEqual(Object.keys(commandOutputSchemas).sort(), Object.keys(commandInputSchemas).sort());
});

test("unknown commands, shell/path authority and extra arguments are rejected", () => {
  for (const name of ["exec", "open_path", "save_settings", "__proto__", "constructor", "get_state; rm", null, 3]) {
    assert.throws(() => validateCommandName(name));
  }
  assert.deepEqual(validateCommandInput("get_state", {}), {});
  for (const value of [{ path: "/tmp/file" }, { command: "shell" }, [], null, undefined]) {
    assert.throws(() => validateCommandInput("get_state", value));
  }
  assert.throws(() => validateCommandInput("download_model", { id: "tiny", path: "/tmp/model" }));
  assert.throws(() => validateCommandInput("download_model", { id: "../../model" }));
  assert.throws(() => validateCommandInput("download_model", { id: "..\\model" }));
  assert.throws(() => validateCommandInput("download_model", { id: "" }));
});

test("validated preference patches preserve text and reject host-owned fields", () => {
  const text = "  Deutsch 👩‍💻 العربية\u200f\n日本語  ";
  const patch = { ui_language: "de", vocabulary: text, keep_history: false, output: "clipboard" };
  assert.deepEqual(validateCommandInput("save_preferences", { changes: patch }), { changes: patch });
  assert.deepEqual(preferencePatchSchema.parse({}), {});
  for (const language of ["auto", "de", "zh", "ja", "ko", "ar", "cs", "uk", "yue"]) {
    assert.deepEqual(preferencePatchSchema.parse({ language }), { language });
  }
  for (const field of ["setup_completed", "gpu_configured", "native_trigger", "x11_trigger", "macos_shortcut", "unknown"]) {
    assert.throws(() => validateCommandInput("save_preferences", { changes: { [field]: true } }));
  }
  for (const changes of [{ gpu: "false" }, { ui_language: "fr" }, { language: "EN" }, { output: "shell" }, { model: undefined }]) {
    assert.throws(() => validateCommandInput("save_preferences", { changes }));
  }
  assert.throws(() => validateCommandInput("save_preferences", { changes: patch, preferences: state().preferences }));
});

test("optional preview commands validate a separate profile and fixed categorical results", () => {
  const profile = defaultLocalProcessingProfile();
  assert.deepEqual(appStateSchema.parse({ ...state(), local_processing: profile }).local_processing, profile);
  assert.throws(() => validateCommandInput("save_preferences", { changes: { local_processing: profile } }));
  assert.deepEqual(validateCommandInput("save_local_processing", { changes: { model: "owned 日本語" } }),
    { changes: { model: "owned 日本語" } });
  assert.throws(() => validateCommandInput("save_local_processing", { changes: { api_key: "private" } }));
  assert.throws(() => validateCommandInput("preview_local_processing", { requestId: "owned", text: "", endpoint: "https://example.com" }));
  assert.deepEqual(validateCommandOutput("preview_local_processing", { ok: true, text: "Café 日本語" }),
    { ok: true, text: "Café 日本語" });
  assert.deepEqual(validateCommandOutput("preview_local_processing", { ok: false, code: "CONNECTION_FAILED" }),
    { ok: false, code: "CONNECTION_FAILED" });
  for (const value of ["text", { ok: true, text: "" }, { ok: false, code: "private server diagnostic" },
    { ok: false, code: "HTTP_REJECTED", detail: "private body" }]) {
    assert.throws(() => validateCommandOutput("preview_local_processing", value));
  }
});

test("legacy Mac blank and whitespace snippet drafts survive snapshots and saves unchanged", () => {
  const snippets = [
    { id: "mac-draft", trigger: "", expansion: "", enabled: true },
    { id: "mac-whitespace", trigger: "  \t", expansion: "Unchanged 日本語 👩‍💻", enabled: false },
    { id: "", trigger: "legacy Linux trigger", expansion: "legacy ID", enabled: true },
  ];
  const mac = {
    ...state(), platform: "macos", preferences: { ...state().preferences, snippets },
    macos: { microphone_allowed: false, recording_shortcut: false, shortcut_hint: "", editor: "", recommended: [], updates_configured: false },
  };
  assert.deepEqual(appStateSchema.parse(mac), mac);
  assert.deepEqual(validateCommandInput("save_preferences", { changes: { snippets } }), { changes: { snippets } });
  for (const snippet of snippets.slice(0, 2)) assert.equal(nonEmptySnippetSchema.safeParse(snippet).success, false);
});

test("existing UTF-8 preference/snippet limits reject oversize without normalization", () => {
  const snippet = { id: "fixture", trigger: "术".repeat(42) + "ab", expansion: "🧑‍💻", enabled: true };
  assert.deepEqual(snippetSchema.parse(snippet), snippet);
  assert.equal(snippetSchema.safeParse({ ...snippet, trigger: "术".repeat(43) }).success, false);
  assert.equal(nonEmptySnippetSchema.safeParse({ ...snippet, trigger: "  \t" }).success, false);
  assert.equal(snippetSchema.safeParse({ ...snippet, expansion: "é".repeat(4097) }).success, false);
  assert.equal(preferencesSchema.safeParse({ ...state().preferences, vocabulary: "é".repeat(4096) }).success, true);
  assert.equal(preferencesSchema.safeParse({ ...state().preferences, vocabulary: "é".repeat(4097) }).success, false);
  assert.equal(preferencesSchema.safeParse({ ...state().preferences, snippets: Array.from({ length: 101 }, () => snippet) }).success, false);
});

test("malformed states, nested extra fields and nonfinite/out-of-range numbers are rejected", () => {
  for (const invalid of [
    {}, { ...state(), extra: true }, { ...state(), platform: "windows" }, { ...state(), status: "shell" },
    { ...state(), preferences: { ...state().preferences, unknown: true } },
    { ...state(), updates: { ...state().updates, executable: "/tmp/file" } },
    { ...state(), models: [{ ...state().models[0], endpoint: "https://example.com" }] },
    { ...state(), history: Array.from({ length: 21 }, () => "text") },
  ]) assert.equal(appStateSchema.safeParse(invalid).success, false);
  for (const value of [NaN, Infinity, -Infinity, -1, 1.01]) {
    assert.equal(appStateSchema.safeParse({ ...state(), progress: value }).success, false);
    assert.equal(appStateSchema.safeParse({ ...state(), level: value }).success, false);
    assert.equal(appStateSchema.safeParse({ ...state(), updates: { ...state().updates, progress: value } }).success, false);
  }
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(appStateSchema.safeParse({ ...state(), elapsed: value }).success, false);
  }
  assert.equal(appStateSchema.safeParse({ ...state(), elapsed: 3601 }).success, true);
  assert.equal(appStateSchema.safeParse({ ...state(), profile: "stable" }).success, false);
  assert.equal(appStateSchema.safeParse({ ...state(), recording_available: "false" }).success, false);
});

test("state-returning outputs validate complete snapshots while actions accept only void or null", () => {
  assert.deepEqual(validateCommandOutput("get_state", state()), state());
  assert.deepEqual(validateCommandOutput("save_preferences", state()), state());
  for (const name of ["get_state", "save_preferences"] as const) {
    for (const result of [null, undefined, true, {}, { ...state(), status: "invalid" }]) {
      assert.throws(() => validateCommandOutput(name, result));
    }
  }
  assert.equal(validateCommandOutput("cancel_recording", null), null);
  assert.equal(validateCommandOutput("cancel_recording", undefined), undefined);
  for (const result of [true, "success", { ok: true }, state()]) {
    assert.throws(() => validateCommandOutput("cancel_recording", result));
  }
});

test("history indices and serialized native trigger profiles have finite integer bounds", () => {
  for (const index of [-1, 20, 1.1, NaN, Infinity, "0"]) {
    assert.throws(() => validateCommandInput("copy_history", { index }));
  }
  assert.deepEqual(validateCommandInput("copy_history", { index: 19 }), { index: 19 });
  for (const trigger of [
    { kind: "mouse", button: 1 }, { kind: "key", key: Infinity }, { kind: "key", key: -1 },
    { kind: "key", key: 65, path: "/tmp/input" },
  ]) assert.equal(preferencesSchema.safeParse({ ...state().preferences, native_trigger: trigger }).success, false);
  for (const trigger of [
    { keycode: 7, keysym: 65477, modifiers: 0, group: 0 },
    { keycode: 74, keysym: 65477, modifiers: 256, group: 0 },
    { keycode: 74, keysym: 65477, modifiers: 0, group: 4 },
  ]) assert.equal(preferencesSchema.safeParse({ ...state().preferences, x11_trigger: trigger }).success, false);
});

test("only fixed state, recording telemetry, and navigation events are accepted", () => {
  assert.equal(validateEventName("state"), "state");
  assert.equal(validateEventName("recording_telemetry"), "recording_telemetry");
  assert.equal(validateEventName("navigate"), "navigate");
  assert.deepEqual(validateEvent("state", state()), state());
  assert.equal(validateEvent("navigate", "models"), "models");
  assert.throws(() => validateEventName("shell"));
  assert.throws(() => validateEvent("navigate", "../../page"));
  assert.throws(() => validateEvent("navigate", { tab: "models" }));
  assert.throws(() => validateEvent("state", { ...state(), progress: NaN }));
});

test("transport bounds preserve a long multilingual transcript and reject oversized frames", () => {
  const text = "Deutsch 👩‍💻 العربية\u200f 日本語\n".repeat(1000);
  const snapshot = { ...state(), transcript: text, history: [text] };
  assert.deepEqual(validateCommandOutput("get_state", snapshot), snapshot);
  assert.equal(appStateSchema.safeParse({ ...state(), transcript: "x".repeat(MAX_USER_TEXT_BYTES + 1) }).success, false);
  const escaped = "\u0000".repeat(MAX_USER_TEXT_BYTES);
  const large = { ...state(), history: [escaped, escaped] };
  assert.ok(new TextEncoder().encode(JSON.stringify(large)).byteLength > MAX_UI_STATE_BYTES);
  assert.equal(appStateSchema.safeParse(large).success, false);
});

test("command types are inferred from the same runtime schemas", () => {
  const input: CommandInput<"copy_history"> = validateCommandInput("copy_history", { index: 0 });
  const output: CommandOutput<"get_state"> = validateCommandOutput("get_state", state());
  assert.equal(input.index, 0);
  assert.equal(output.preferences.ui_language, "en");
  // @ts-expect-error A schema-derived history command does not accept model arguments.
  const invalid: CommandInput<"copy_history"> = { id: "tiny" };
  assert.equal("id" in invalid, true);
});

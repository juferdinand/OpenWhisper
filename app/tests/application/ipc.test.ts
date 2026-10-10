import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { MAX_USER_TEXT_BYTES } from "../../src/contracts/ui/state.js";
import type { AppState, PreferencePatch } from "../../src/contracts/ui/state.js";
import {
  createUiDispatcher,
  MAX_UI_REQUEST_BYTES,
  TRUSTED_UI_URLS,
} from "../../src/main/ipc.js";
import type { CommandHandlers, UiDispatchResult, UiErrorCode, UiSender } from "../../src/main/ipc.js";

const main: UiSender = { webContentsId: 7, mainFrame: true, url: TRUSTED_UI_URLS.main };
const overlay: UiSender = { webContentsId: 8, mainFrame: true, url: TRUSTED_UI_URLS.overlay };

function state(): AppState {
  return {
    updates: { configured: false, status: "idle", version: null, progress: 0, error: null, package: "development" },
    platform: "linux",
    version: "0.2.5",
    status: "idle",
    message: "Ready",
    transcript: "Public fixture text",
    history: ["Public fixture text"],
    preferences: {
      ui_language: "en", setup_completed: false, model: "tiny", language: "auto",
      microphone: "", vocabulary: "", snippets: [], output: "clipboard",
      hold_to_record: false, gpu: false, keep_history: true,
    },
    models: [], installed: [], microphones: [], session: "Owned fixture", desktop: "Owned fixture",
    clipboard_available: true, shortcut_portal: false, paste_portal: false, shortcut: null,
    paste_ready: false, gpu_available: false, download: null, progress: 0, elapsed: 0,
    model_directory: "/fixture/models",
  };
}

function dispatcher(handlers: CommandHandlers = {}) {
  return createUiDispatcher({
    windows: [{ webContentsId: main.webContentsId, role: "main" }, { webContentsId: overlay.webContentsId, role: "overlay" }],
    handlers,
  });
}

function request(command: string, args: unknown = {}): string {
  return JSON.stringify({ command, args });
}

function failure(result: UiDispatchResult, code: UiErrorCode) {
  if (result.ok) assert.fail("Expected a safe bridge failure");
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, "string");
  return result;
}

test("authorized main command validates the request and response", async () => {
  let calls = 0;
  const expected = state();
  const bridge = dispatcher({ get_state: (args) => { assert.deepEqual(args, {}); calls++; return expected; } });
  const result = await bridge.dispatch({ sender: main, serializedRequest: request("get_state") });
  assert.deepEqual(result, { ok: true, value: expected });
  assert.equal(calls, 1);
});

test("mouse capture is bounded and cannot be invoked by the recording overlay", async () => {
  const buttons: number[] = [];
  const bridge = dispatcher({ capture_mouse_trigger: ({ button }) => { buttons.push(button); } });
  failure(await bridge.dispatch({ sender: overlay, serializedRequest: request("capture_mouse_trigger", { button: 8 }) }), "FORBIDDEN_COMMAND");
  failure(await bridge.dispatch({ sender: main, serializedRequest: request("capture_mouse_trigger", { button: 0 }) }), "INVALID_REQUEST");
  assert.deepEqual(buttons, []);
  assert.deepEqual(await bridge.dispatch({ sender: main, serializedRequest: request("capture_mouse_trigger", { button: 8 }) }), { ok: true, value: null });
  assert.deepEqual(buttons, [8]);
});

test("typed preference handler receives only the validated patch", async () => {
  let received: PreferencePatch | undefined;
  const bridge = dispatcher({ save_preferences: ({ changes }) => {
    received = changes;
    const current = state();
    return { ...current, preferences: { ...current.preferences, ...changes } };
  } });
  const result = await bridge.dispatch({ sender: main, serializedRequest: request("save_preferences", { changes: { ui_language: "de" } }) });
  assert.equal(result.ok, true);
  assert.deepEqual(received, { ui_language: "de" });
});

test("wrong origin URL query hash ID or subframe rejects before parsing or handler", async () => {
  let calls = 0;
  const bridge = dispatcher({ get_state: () => { calls++; return state(); } });
  const invalid: unknown[] = [
    { ...main, url: "https://openwhisper/index.html" },
    { ...main, url: "app://other/index.html" },
    { ...main, url: "app://openwhisper@evil/index.html" },
    { ...main, url: "app://openwhisper/index.html/" },
    { ...main, url: "app://openwhisper/%69ndex.html" },
    { ...main, url: "app://openwhisper/index.html?" },
    { ...main, url: "app://openwhisper/index.html#fragment" },
    { ...main, url: TRUSTED_UI_URLS.overlay },
    { ...overlay, url: TRUSTED_UI_URLS.main },
    { ...overlay, url: "app://openwhisper/index.html?overlay" },
    { ...overlay, url: "app://openwhisper/index.html?overlay=1&extra=1" },
    { ...main, mainFrame: false },
    { ...main, webContentsId: 9 },
    { ...main, webContentsId: "7" },
    { ...main, webContentsId: NaN },
    { ...main, role: "overlay" },
    null,
    {},
    [],
  ];
  for (const sender of invalid) {
    failure(await bridge.dispatch({ sender, serializedRequest: "invalid JSON" }), "UNTRUSTED_SENDER");
    assert.equal(bridge.isTrustedSender(sender), false);
  }
  assert.equal(bridge.isTrustedSender(main), true);
  assert.equal(bridge.isTrustedSender(overlay), true);
  assert.equal(calls, 0);
});

test("sender getters cannot leak exceptions", async () => {
  const sender = { webContentsId: 7, mainFrame: true, get url() { throw new Error("Synthetic sensitive exception"); } };
  const result = await dispatcher().dispatch({ sender, serializedRequest: request("get_state") });
  failure(result, "UNTRUSTED_SENDER");
  assert.equal(JSON.stringify(result).includes("Synthetic sensitive exception"), false);
});

test("unknown commands envelopes and non-string input reject without handler", async () => {
  let calls = 0;
  const bridge = dispatcher({ get_state: () => { calls++; return state(); } });
  const invalid: unknown[] = [
    request("execute_shell", { command: "synthetic command" }),
    request("save_settings", { settings: {} }),
    request("__proto__"),
    request("constructor"),
    "{broken",
    "null",
    "[]",
    JSON.stringify({ command: "get_state" }),
    JSON.stringify({ command: 1, args: {} }),
    JSON.stringify({ command: "get_state", args: {}, role: "main" }),
    JSON.stringify({ command: "get_state", args: {}, extra: "Synthetic private text" }),
    {},
    null,
  ];
  for (const serializedRequest of invalid) {
    const result = failure(await bridge.dispatch({ sender: main, serializedRequest }), "INVALID_REQUEST");
    assert.equal(JSON.stringify(result).includes("Synthetic private text"), false);
  }
  assert.equal(calls, 0);
});

test("extra malformed and host-owned arguments reject before typed handlers", async () => {
  let calls = 0;
  const bridge = dispatcher({
    get_state: () => { calls++; return state(); },
    save_preferences: () => { calls++; return state(); },
    download_model: () => { calls++; return null; },
    copy_history: () => { calls++; return null; },
  });
  const invalid = [
    request("get_state", { extra: "Synthetic private text" }),
    request("get_state", null),
    request("get_state", []),
    request("save_preferences", { changes: { setup_completed: true } }),
    request("save_preferences", { changes: { native_trigger: { kind: "mouse", button: 8 } } }),
    request("save_preferences", { changes: { ui_language: "fr" } }),
    request("save_preferences", { changes: { gpu: "true" } }),
    request("download_model", { id: "../model" }),
    request("download_model", { id: "tiny", path: "/synthetic/path" }),
    request("copy_history", { index: -1 }),
    request("copy_history", { index: 20 }),
    request("copy_history", { index: 1.5 }),
  ];
  for (const serializedRequest of invalid) {
    failure(await bridge.dispatch({ sender: main, serializedRequest }), "INVALID_REQUEST");
  }
  assert.equal(calls, 0);
});

test("overlay permits only state recording and recovery actions", async () => {
  const called: string[] = [];
  const bridge = dispatcher({
    get_state: () => { called.push("get_state"); return state(); },
    toggle_recording: () => { called.push("toggle_recording"); return null; },
    cancel_recording: () => { called.push("cancel_recording"); return null; },
    retry_transcription: () => { called.push("retry_transcription"); return null; },
    discard_recovery: () => { called.push("discard_recovery"); return null; },
    save_preferences: () => { called.push("save_preferences"); return state(); },
    install_update: () => { called.push("install_update"); return null; },
    enable_paste: () => { called.push("enable_paste"); return null; },
  });
  const allowed = ["get_state", "toggle_recording", "cancel_recording", "retry_transcription", "discard_recovery"];
  for (const command of allowed) {
    const result = await bridge.dispatch({ sender: overlay, serializedRequest: request(command) });
    assert.equal(result.ok, true);
  }
  for (const command of ["save_preferences", "install_update", "enable_paste", "complete_setup", "copy_history"]) {
    // Even invalid arguments or absent handlers cannot bypass the role policy.
    failure(await bridge.dispatch({ sender: overlay, serializedRequest: request(command) }), "FORBIDDEN_COMMAND");
  }
  assert.deepEqual(called, allowed);
});

test("oversize ASCII and multibyte requests reject before JSON parsing", async () => {
  let calls = 0;
  const bridge = dispatcher({ get_state: () => { calls++; return state(); } });
  for (const serializedRequest of [" ".repeat(MAX_UI_REQUEST_BYTES + 1), "é".repeat(MAX_UI_REQUEST_BYTES / 2 + 1)]) {
    failure(await bridge.dispatch({ sender: main, serializedRequest }), "REQUEST_TOO_LARGE");
  }
  assert.equal(calls, 0);
});

test("valid request at the exact UTF-8 byte bound remains accepted", async () => {
  const bridge = dispatcher({ get_state: () => state() });
  const minimal = request("get_state");
  const serializedRequest = minimal + " ".repeat(MAX_UI_REQUEST_BYTES - Buffer.byteLength(minimal, "utf8"));
  assert.equal(Buffer.byteLength(serializedRequest, "utf8"), MAX_UI_REQUEST_BYTES);
  assert.equal((await bridge.dispatch({ sender: main, serializedRequest })).ok, true);
});

test("existing maximum escaped snippets are preserved beyond a one MiB frame", async () => {
  const expansion = "\u0000".repeat(8192);
  const snippets = Array.from({ length: 100 }, (_, index) => ({ id: `snippet-${index}`, trigger: `trigger-${index}`, expansion, enabled: true }));
  let received: PreferencePatch | undefined;
  const bridge = dispatcher({ save_preferences: ({ changes }) => { received = changes; return state(); } });
  const serializedRequest = request("save_preferences", { changes: { snippets } });
  assert.ok(Buffer.byteLength(serializedRequest, "utf8") > 1024 * 1024);
  assert.ok(Buffer.byteLength(serializedRequest, "utf8") < MAX_UI_REQUEST_BYTES);
  assert.equal((await bridge.dispatch({ sender: main, serializedRequest })).ok, true);
  assert.deepEqual(received?.snippets, snippets);
});

test("malformed handler responses are rejected without sensitive diagnostics", async () => {
  for (const { bridge, command } of [
    { bridge: dispatcher({ get_state: () => ({ transcript: "Synthetic private response" }) }), command: "get_state" },
    { bridge: dispatcher({ cancel_recording: () => "Synthetic private response" }), command: "cancel_recording" },
  ]) {
    const result = failure(await bridge.dispatch({ sender: main, serializedRequest: request(command) }), "INVALID_RESPONSE");
    assert.equal(JSON.stringify(result).includes("Synthetic private response"), false);
  }
});

test("large valid UTF-8 transcript is returned without shortening", async () => {
  const expected = state();
  expected.transcript = "é".repeat(MAX_USER_TEXT_BYTES / 2);
  assert.equal(Buffer.byteLength(expected.transcript, "utf8"), MAX_USER_TEXT_BYTES);
  const result = await dispatcher({ get_state: () => expected }).dispatch({ sender: main, serializedRequest: request("get_state") });
  assert.deepEqual(result, { ok: true, value: expected });
});

test("oversize individual and aggregate state fail without mutating original text", async () => {
  const oversizedText = "x".repeat(MAX_USER_TEXT_BYTES + 1);
  const individual = state();
  individual.transcript = oversizedText;
  const aggregate = state();
  aggregate.history = Array.from({ length: 9 }, () => "x".repeat(MAX_USER_TEXT_BYTES));
  for (const original of [individual, aggregate]) {
    failure(await dispatcher({ get_state: () => original }).dispatch({ sender: main, serializedRequest: request("get_state") }), "INVALID_RESPONSE");
  }
  assert.equal(individual.transcript, oversizedText);
  assert.equal(aggregate.history.length, 9);
  assert.ok(aggregate.history.every((text) => text.length === MAX_USER_TEXT_BYTES));
});

test("thrown and rejected handler failures return only fixed safe messages", async () => {
  const handlers: CommandHandlers[] = [
    { cancel_recording: () => { throw new Error("Synthetic private exception"); } },
    { cancel_recording: async () => { throw new Error("Synthetic private exception"); } },
  ];
  for (const handler of handlers) {
    const result = failure(await dispatcher(handler).dispatch({ sender: main, serializedRequest: request("cancel_recording") }), "HANDLER_FAILED");
    assert.equal(JSON.stringify(result).includes("Synthetic private exception"), false);
    assert.equal(Object.keys(result).length, 2);
    assert.deepEqual(Object.keys(result.error), ["code", "message"]);
  }
});

test("unavailable handlers fail safely and void actions have explicit null replies", async () => {
  failure(await dispatcher().dispatch({ sender: main, serializedRequest: request("complete_setup") }), "UNAVAILABLE_COMMAND");
  for (const result of [null, undefined]) {
    const response = await dispatcher({ complete_setup: () => result }).dispatch({ sender: main, serializedRequest: request("complete_setup") });
    assert.deepEqual(response, { ok: true, value: null });
    assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true, value: null });
  }
});

test("invalid duplicate or unsafe trusted window IDs fail at configuration", () => {
  for (const webContentsId of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createUiDispatcher({ windows: [{ webContentsId, role: "main" }], handlers: {} }));
  }
  assert.throws(() => createUiDispatcher({ windows: [{ webContentsId: 7, role: "main" }, { webContentsId: 7, role: "overlay" }], handlers: {} }));
});

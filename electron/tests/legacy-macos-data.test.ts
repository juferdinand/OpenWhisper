import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_UI_REQUEST_BYTES, MAX_USER_TEXT_BYTES, preferencesSchema } from "../src/contracts/ui.js";
import { convertLegacyMacosData } from "../src/services/legacy-macos-data.js";

// Synthetic projections of native v0.2.5 Prefs/UserDefaults and Snippet JSON.
const context = { systemLanguage: "de-DE", defaults: { recommendedModel: "parakeet-v3-q8", appleSilicon: false, launchAtLogin: true } };
const id = "ABCDEF12-1234-4567-9123-123456789ABC";
const snippets = [{ id, trigger: "Signatur", expansion: "Viele Grüße\nSynthetic User", enabled: true },
  { id: "00000000-0000-0000-0000-000000000000", trigger: "", expansion: "", enabled: false }];
const trigger = Buffer.from(JSON.stringify({ keys: { keyCode: 49, modifiers: 524288, name: "Space" } })).toString("base64");
const plist = {
  uiLanguage: "de", setupCompleted: true, setupShown: false, selectedModel: "local 日本語 model", language: "ja",
  recordingMode: "hold", outputMode: "editor", editorAppPath: "/Applications/Owned Editor.app",
  restoreClipboard: false, playSounds: false, showIdleOverlay: true, vocabulary: "café, İstanbul, 東京",
  keepHistory: true, autoCheckUpdates: false, history: ["Ein vollständiger Satz.", "東京 café 👩‍💻"],
  trigger, overlayOrigin: "{120, 300}", microphoneUID: "owned-synthetic-device", laterFeature: { enabled: true, value: [123, null, "世界"] },
};

test("saved Mac settings retain ordinary values and unsupported native/editor/device data without an invented shortcut", () => {
  const input = { ...context, plist: structuredClone(plist), snippets: structuredClone(snippets) }, before = structuredClone(input);
  const converted = convertLegacyMacosData(input);
  assert.deepEqual(converted.preferences, {
    ui_language: "de", setup_completed: true, model: plist.selectedModel, language: "ja", microphone: "", vocabulary: plist.vocabulary,
    snippets, output: "editor", hold_to_record: true, gpu: false, keep_history: true, restore_clipboard: false, play_sounds: false,
    show_idle_overlay: true, launch_at_login: true, auto_check_updates: false, macos_shortcut: null,
  });
  assert.deepEqual(preferencesSchema.parse(converted.preferences), converted.preferences);
  assert.deepEqual(converted.history, plist.history); assert.deepEqual(converted.preserved, { plist, snippets, history: plist.history });
  assert.deepEqual(converted.legacy, { editorAppPath: plist.editorAppPath, trigger: { present: true, value: trigger } });
  assert.deepEqual(converted.review, ["MAC_NATIVE_TRIGGER", "MAC_EDITOR_OUTPUT", "MAC_EDITOR_PATH", "MAC_HOLD_MODE", "MAC_UNMAPPED_PREFERENCES"]);
  converted.preferences.vocabulary = "Changed converted copy"; converted.preserved.history.push("Changed preserved copy");
  assert.deepEqual(input, before);
});

test("absent plist follows exact Prefs defaults with explicit hardware/model/login facts", () => {
  const converted = convertLegacyMacosData(context);
  assert.deepEqual(converted.preferences, {
    ui_language: "en", setup_completed: false, model: "parakeet-v3-q8", language: "de", microphone: "", vocabulary: "", snippets: [],
    output: "paste", hold_to_record: false, gpu: false, keep_history: true, restore_clipboard: true, play_sounds: true,
    show_idle_overlay: false, launch_at_login: true, auto_check_updates: true, macos_shortcut: null,
  });
  assert.deepEqual(converted.preserved, { plist: null, snippets: null, history: [] });
  assert.deepEqual(converted.legacy, { editorAppPath: "/System/Applications/TextEdit.app", trigger: { present: false, value: null } });
  assert.deepEqual(converted.review, ["MAC_DEFAULT_TRIGGER"]);
  const appleSilicon = convertLegacyMacosData({ ...context, defaults: { recommendedModel: "large-v3-turbo-q5_0", appleSilicon: true, launchAtLogin: false } });
  assert.equal(appleSilicon.preferences.model, "large-v3-turbo-q5_0"); assert.equal(appleSilicon.preferences.gpu, true);
  assert.equal(appleSilicon.preferences.launch_at_login, false); assert.deepEqual(appleSilicon.review, ["MAC_DEFAULT_TRIGGER", "MAC_HARDWARE_GPU"]);
});

test("Mac onboarding upgrade depends on setupShown and never overrides an explicit completion value", () => {
  assert.equal(convertLegacyMacosData({ ...context, plist: {} }).preferences.setup_completed, false);
  assert.equal(convertLegacyMacosData({ ...context, plist: { setupShown: true } }).preferences.setup_completed, true);
  assert.equal(convertLegacyMacosData({ ...context, plist: { setupShown: false } }).preferences.setup_completed, false);
  assert.equal(convertLegacyMacosData({ ...context, plist: { setupShown: true, setupCompleted: false } }).preferences.setup_completed, false);
  assert.equal(convertLegacyMacosData({ ...context, plist: { setupCompleted: true } }).preferences.setup_completed, true);
});

test("missing dictation language uses the legacy supported first-two-character rule without changing saved language", () => {
  for (const [systemLanguage, expected] of [["ja-JP", "ja"], ["en-US", "en"], ["xx-Test", "auto"], ["DE-DE", "auto"], ["yue-HK", "auto"], ["", "auto"]]) {
    assert.equal(convertLegacyMacosData({ ...context, systemLanguage }).preferences.language, expected);
    assert.equal(convertLegacyMacosData({ ...context, systemLanguage, plist: { language: "fr" } }).preferences.language, "fr");
  }
});

test("native trigger projections retain modifier, mouse, empty and opaque data with present-vs-absent distinction", () => {
  for (const savedTrigger of [{ modifier: { keyCode: 63 } }, { mouse: { button: 3 } }, null, "bnVsbA==", "not-decodable-data", { data: trigger }]) {
    const converted = convertLegacyMacosData({ ...context, plist: { trigger: savedTrigger, recordingMode: "hold" } });
    assert.deepEqual(converted.legacy.trigger, { present: true, value: savedTrigger });
    assert.deepEqual(converted.preserved.plist, { trigger: savedTrigger, recordingMode: "hold" });
    assert.equal(converted.preferences.macos_shortcut, null); assert.equal(converted.preferences.hold_to_record, true);
    assert.deepEqual(converted.review, ["MAC_NATIVE_TRIGGER", "MAC_HOLD_MODE"]);
  }
});

test("editable empty Mac snippets and unknown snippet JSON remain preserved with UUID spelling", () => {
  const originals = [...snippets, { id: "12345678-1234-4567-8123-123456789abc", trigger: "  ", expansion: "Draft", enabled: true, later: "retained" }];
  const converted = convertLegacyMacosData({ ...context, snippets: originals });
  assert.equal(converted.preferences.snippets[0]?.id, id);
  assert.deepEqual(converted.preferences.snippets[1], snippets[1]);
  assert.deepEqual(converted.preferences.snippets[2], { id: originals[2]?.id, trigger: "  ", expansion: "Draft", enabled: true });
  assert.deepEqual(converted.preserved.snippets, originals);
});

test("saved history follows keepHistory visibility and retains every original entry beyond the current host view", () => {
  const history = Array.from({ length: 24 }, (_, index) => `Synthetic history ${index}`);
  const active = convertLegacyMacosData({ ...context, plist: { history } });
  assert.deepEqual(active.history, history.slice(0, 20)); assert.deepEqual(active.preserved.history, history);
  assert.deepEqual(active.preserved.plist, { history }); assert.ok(active.review.includes("MAC_HISTORY_OVERFLOW"));
  const disabled = convertLegacyMacosData({ ...context, plist: { history, keepHistory: false } });
  assert.deepEqual(disabled.history, []); assert.deepEqual(disabled.preserved.history, history);
  assert.deepEqual(disabled.review, ["MAC_DEFAULT_TRIGGER", "MAC_HISTORY_DISABLED"]);
});

test("malformed Mac ordinary settings, snippets and context fail categorically without exposing values", () => {
  const invalid = [null, [], {}, { ...context, extra: true }, { ...context, plist: null }, { ...context, systemLanguage: true },
    { ...context, defaults: { ...context.defaults, appleSilicon: "true" } },
    { ...context, defaults: { ...context.defaults, recommendedModel: "../PRIVATE_CONTENT" } },
    { ...context, defaults: { ...context.defaults, launchAtLogin: 1 } },
    { ...context, defaults: { ...context.defaults, extra: true } },
    ...[{ uiLanguage: "PRIVATE_CONTENT" }, { language: "yue" }, { setupCompleted: 1 }, { setupShown: null },
      { recordingMode: "unsupported" }, { outputMode: "unknown" }, { selectedModel: "../PRIVATE_CONTENT" },
      { vocabulary: "界".repeat(2731) }, { history: [true] }, { editorAppPath: {} }, { autoCheckUpdates: "false" },
      { laterFeature: undefined }, { history: ["a".repeat(MAX_USER_TEXT_BYTES + 1)] },
      { laterFeature: "a".repeat(MAX_UI_REQUEST_BYTES) }].map((badPlist) => ({ ...context, plist: badPlist })),
    ...[[{ id: "not-a-uuid", trigger: "", expansion: "", enabled: true }], [{ trigger: "", expansion: "", enabled: true }],
      [{ ...snippets[0], enabled: "true" }], [{ ...snippets[0], trigger: "界".repeat(43) }], Array.from({ length: 101 }, () => snippets[0])]
      .map((badSnippets) => ({ ...context, snippets: badSnippets }))];
  for (const input of invalid) assert.throws(() => convertLegacyMacosData(input), { name: "LegacyMacosDataError", message: "INVALID_DATA" });
});

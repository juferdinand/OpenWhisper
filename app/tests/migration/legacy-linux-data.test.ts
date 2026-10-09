import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_UI_REQUEST_BYTES, MAX_USER_TEXT_BYTES, preferencesSchema } from "../../src/contracts/ui/state.js";
import { convertLegacyLinuxData, convertLegacyLinuxRecoveryNames } from "../../src/services/migration/legacy-linux-data.js";
import { kdeKeySchema } from "../../src/platforms/linux/kde/keyboard.js";

// Synthetic storage shapes from v0.2.5 settings.rs, core::Snippet and Trigger.
const legacy = {
  ui_language: "de", setup_completed: true, auto_check_updates: true, model: "base", language: "de",
  microphone: "Owned synthetic source", vocabulary: "café, İstanbul, 東京, OpenWhisper",
  snippets: [{ id: "saved-id", trigger: "Signatur", expansion: "Viele Grüße\nSynthetic User", enabled: true },
    { trigger: "東京", expansion: "Mehrsprachig: 日本語", enabled: false }],
  output: "paste", hold_to_record: true, native_trigger: { kind: "key", key: 0x04000000 | 0x01000037 },
  x11_trigger: { keycode: 74, keysym: 65477, modifiers: 4, group: 2 },
  gpu: false, gpu_configured: true, keep_history: true, show_idle_overlay: true, launch_at_login: true,
};

test("legacy stable preferences retain ordinary values, both independent profiles and enabled service preferences", () => {
  const input = { settings: structuredClone(legacy), history: ["Ein vollständiger Satz.", "東京 café 👩‍💻"] };
  const before = structuredClone(input), converted = convertLegacyLinuxData(input);
  assert.deepEqual(converted.preferences, { ...legacy, snippets: [legacy.snippets[0], { ...legacy.snippets[1], id: "" }] });
  assert.equal(converted.preferences.auto_check_updates, true); assert.equal(converted.preferences.launch_at_login, true);
  assert.equal(converted.preferences.gpu, false); assert.equal(converted.preferences.hold_to_record, true);
  assert.deepEqual(preferencesSchema.parse(converted.preferences), converted.preferences);
  assert.deepEqual(converted.history, input.history); assert.deepEqual(converted.preserved, input); assert.deepEqual(converted.triggerReview, []);
  converted.preferences.vocabulary = "Edited converted text"; converted.preserved.history.push("Later edited copy");
  assert.deepEqual(input, before);
});

test("fresh absence and old missing onboarding markers follow the exact v0.2.5 loader", () => {
  const fresh = convertLegacyLinuxData({});
  assert.equal(fresh.preferences.setup_completed, false); assert.equal(fresh.preferences.model, "base");
  assert.equal(fresh.preferences.gpu, true); assert.equal(fresh.preferences.gpu_configured, true);
  assert.equal(fresh.preferences.auto_check_updates, true); assert.equal(fresh.preferences.launch_at_login, false);
  assert.equal(fresh.preserved.settings, null); assert.deepEqual(fresh.history, []);
  const existing = convertLegacyLinuxData({ settings: {} });
  assert.equal(existing.preferences.setup_completed, true); assert.deepEqual(existing.preserved.settings, {});
  assert.equal(convertLegacyLinuxData({ settings: { setup_completed: false } }).preferences.setup_completed, false);
});

test("legacy pre-GPU marker upgrade retains original choice while normalized values match Paths::load", () => {
  // The old loader checks presence, not the truth value of gpu_configured.
  const upgraded = convertLegacyLinuxData({ settings: { gpu: false } });
  assert.equal(upgraded.preferences.gpu, true); assert.equal(upgraded.preferences.gpu_configured, true);
  assert.deepEqual(upgraded.preserved.settings, { gpu: false });
  const manualCpu = convertLegacyLinuxData({ settings: { gpu: false, gpu_configured: false } });
  assert.equal(manualCpu.preferences.gpu, false); assert.equal(manualCpu.preferences.gpu_configured, false);
});

test("valid legacy mouse, modifier and omitted current special-key support are preserved for adapter review", () => {
  for (const [trigger, category] of [
    [{ kind: "mouse", button: 8 }, "KDE_MOUSE_TRIGGER"],
    [{ kind: "key", key: 0x01000021 }, "KDE_MODIFIER_TRIGGER"],
    [{ kind: "key", key: 0x0100000a }, "KDE_LEGACY_SPECIAL_KEY"],
    [{ kind: "key", key: 0x0100000b }, "KDE_LEGACY_SPECIAL_KEY"],
  ] as const) {
    const converted = convertLegacyLinuxData({ settings: { ...legacy, native_trigger: trigger } });
    assert.deepEqual(converted.preferences.native_trigger, trigger); assert.equal(converted.preferences.hold_to_record, true);
    assert.deepEqual(converted.preferences.x11_trigger, legacy.x11_trigger); assert.deepEqual(converted.triggerReview, [category]);
  }
});

test("legacy scalar keys rejected by the current KDE policy retain bindings and hold mode with review", () => {
  for (const key of [0x200d, 0xe000, 0x04000000 | 0x200d, 0x08000000 | 0xe000]) {
    assert.equal(kdeKeySchema.safeParse(key).success, false);
    const trigger = { kind: "key", key }, settings = { ...legacy, native_trigger: trigger };
    const converted = convertLegacyLinuxData({ settings });
    assert.deepEqual(converted.preferences.native_trigger, trigger); assert.equal(converted.preferences.hold_to_record, true);
    assert.deepEqual(converted.preferences.x11_trigger, legacy.x11_trigger); assert.deepEqual(converted.preserved.settings, settings);
    assert.deepEqual(converted.triggerReview, ["KDE_LEGACY_SPECIAL_KEY"]);
  }
  const supported = convertLegacyLinuxData({ settings: { ...legacy, native_trigger: { kind: "key", key: 0x6771 } } });
  assert.deepEqual(supported.triggerReview, []);
});

test("malformed optional X11 bindings preserve their source instead of resetting ordinary preferences", () => {
  for (const trigger of [
    { ...legacy.x11_trigger, keycode: 7 }, { ...legacy.x11_trigger, keysym: 0xff1b },
    { ...legacy.x11_trigger, keysym: 0xffe1 }, { ...legacy.x11_trigger, keysym: 0 },
    { ...legacy.x11_trigger, group: 4 }, { ...legacy.x11_trigger, extra: true }, "malformed",
  ]) {
    const settings = { ...legacy, x11_trigger: trigger }, converted = convertLegacyLinuxData({ settings });
    assert.equal(converted.preferences.x11_trigger, null); assert.deepEqual(converted.preferences.native_trigger, legacy.native_trigger);
    assert.equal(converted.preferences.vocabulary, legacy.vocabulary); assert.equal(converted.preferences.ui_language, "de");
    assert.deepEqual(converted.preserved.settings?.["x11_trigger"], trigger); assert.deepEqual(converted.triggerReview, ["INVALID_X11_TRIGGER"]);
    assert.deepEqual(settings.x11_trigger, trigger);
  }
});

test("unknown JSON and full history survive preservation while active history matches the legacy first20", () => {
  const history = Array.from({ length: 23 }, (_, index) => `Synthetic history ${index}`);
  const settings = { ...legacy, later_feature: { enabled: true, labels: ["東京", null, 123] },
    snippets: [{ ...legacy.snippets[0], later_snippet_field: "retained" }] };
  const converted = convertLegacyLinuxData({ settings, history });
  assert.deepEqual(converted.history, history.slice(0, 20)); assert.deepEqual(converted.preserved.history, history);
  assert.deepEqual(converted.preserved.settings, settings);
  assert.deepEqual(converted.preferences.snippets, [legacy.snippets[0]]);
});

test("invalid ordinary data is rejected without coercion, trimming or error text containing source values", () => {
  const invalid = [null, [], "PRIVATE_CONTENT", { settings: null }, { history: [true] }, { extra: true },
    { settings: { ...legacy, ui_language: "PRIVATE_CONTENT" } }, { settings: { ...legacy, language: "DE" } },
    { settings: { ...legacy, vocabulary: "界".repeat(2731) } }, { settings: { ...legacy, model: "../model" } },
    { settings: { ...legacy, setup_completed: "false" } }, { settings: { ...legacy, native_trigger: { kind: "mouse", button: 1 } } },
    { settings: { ...legacy, native_trigger: { kind: "key", key: 0x01000000 } } },
    { settings: { ...legacy, snippets: [{ trigger: "  ", expansion: "PRIVATE_CONTENT", enabled: true }] } },
    { settings: { ...legacy, later_feature: undefined } }, { history: ["a".repeat(MAX_USER_TEXT_BYTES + 1)] },
    { settings: { ...legacy, later_feature: "a".repeat(MAX_UI_REQUEST_BYTES) } }];
  for (const input of invalid) assert.throws(() => convertLegacyLinuxData(input), { name: "LegacyLinuxDataError", message: "INVALID_DATA" });
});

const id1 = "12345678-1234-4567-8123-123456789abc", id2 = "abcdef12-1234-4567-9123-123456789abc";
const name = (timestamp: string, id = id1): string => `recording-${timestamp}-${id}.wav`;
test("legacy recovery names retain UUID identity and exact decimal chronology without unsafe numeric conversion", () => {
  const names = [name("00000001791410537000"), name("99999999999999999999", id2)];
  assert.deepEqual(convertLegacyLinuxRecoveryNames(names), [
    { source: names[0], target: `recording-${id1}.wav`, id: id1, timestampMs: "00000001791410537000" },
    { source: names[1], target: `recording-${id2}.wav`, id: id2, timestampMs: "99999999999999999999" },
  ]);
  assert.deepEqual(convertLegacyLinuxRecoveryNames(names), convertLegacyLinuxRecoveryNames(names));
  assert.deepEqual(convertLegacyLinuxRecoveryNames([]), []);
});

test("recovery conversion rejects malformed paths, non-v4 UUIDs and ambiguous destination mappings", () => {
  const valid = name("00000001791410537000");
  for (const input of [null, {}, [1], [valid, valid], [valid, name("00000001791410537001")],
    [`../${valid}`], [`/tmp/${valid}`], [valid.replace(".wav", ".WAV")], [valid.replace(".wav", ".wav\n")],
    [name("1791410537000")], [name("00000000000001791410537000")], [name("00000001791410537000", id1.toUpperCase())],
    [name("00000001791410537000", id1.replace("-4567-", "-5567-"))], [`recording-${id1}.wav`], [valid.replace("recording-", "PRIVATE_CONTENT-")]]) {
    assert.throws(() => convertLegacyLinuxRecoveryNames(input), { name: "LegacyLinuxDataError", message: "INVALID_RECOVERY_NAMES" });
  }
});

import { z } from "zod";
import {
  MAX_UI_REQUEST_BYTES, MAX_USER_TEXT_BYTES, nativeTriggerSchema, preferencesSchema,
  snippetSchema, x11TriggerSchema, type Preferences,
} from "../../contracts/ui/state.js";
import { kdeKeySchema } from "../../platforms/linux/kde/keyboard.js";

class LegacyLinuxDataError extends Error {
  constructor(readonly code: "INVALID_DATA" | "INVALID_RECOVERY_NAMES") {
    super(code); this.name = "LegacyLinuxDataError";
  }
}

const originalSettingsSchema = z.record(z.string(), z.json());
const inputSchema = z.strictObject({ settings: originalSettingsSchema.optional(), history: z.array(z.string()).optional() });
const modifiers = 0x3e000000;
const specialKeys = new Set([0x20, 0x01000001, 0x01000002, 0x01000003, 0x01000004, 0x01000005,
  0x01000006, 0x01000007, 0x01000008, 0x01000009, 0x0100000a, 0x0100000b,
  0x01000010, 0x01000011, 0x01000012, 0x01000013, 0x01000014, 0x01000015, 0x01000016, 0x01000017,
  0x01000020, 0x01000021, 0x01000022, 0x01000023, 0x01000024, 0x01000025, 0x01000026,
  0x01000055, 0x01000058, 0x01000070, 0x01000071, 0x01000072, 0x01000080, 0x01000081, 0x01000082, 0x01000083]);
function legacyKey(key: number): boolean {
  const base = key & ~modifiers;
  return specialKeys.has(base) || (base >= 0x01000030 && base <= 0x01000052) ||
    (base <= 0x10ffff && !(base >= 0xd800 && base <= 0xdfff) && !/[\p{Cc}\p{White_Space}]/u.test(String.fromCodePoint(base)));
}
const legacyNativeTriggerSchema = nativeTriggerSchema.refine((trigger) => trigger.kind === "mouse" || legacyKey(trigger.key));
const legacySnippetSchema = snippetSchema.extend({ id: snippetSchema.shape.id.default("") }).strip()
  .refine((snippet) => snippet.trigger.trim().length > 0);
const legacyPreferencesSchema = preferencesSchema.pick({ ui_language: true, model: true, language: true, microphone: true,
  vocabulary: true, output: true, hold_to_record: true, gpu: true, keep_history: true, show_idle_overlay: true,
  launch_at_login: true, auto_check_updates: true }).extend({
  ui_language: preferencesSchema.shape.ui_language.default("en"), model: preferencesSchema.shape.model.default("base"),
  language: z.string().regex(/^(?:auto|[a-z]{2})$/u).default("auto"), microphone: preferencesSchema.shape.microphone.default(""),
  vocabulary: preferencesSchema.shape.vocabulary.default(""), snippets: z.array(legacySnippetSchema).max(100).default([]),
  output: z.enum(["clipboard", "paste"]).default("clipboard"), hold_to_record: z.boolean().default(false),
  native_trigger: legacyNativeTriggerSchema.nullable().default(null),
  gpu: z.boolean().default(true), gpu_configured: z.boolean().optional(), keep_history: z.boolean().default(true),
  setup_completed: z.boolean().optional(), show_idle_overlay: z.boolean().default(false),
  launch_at_login: z.boolean().default(false), auto_check_updates: z.boolean().default(true),
}).strip();
// GDK/Xlib name and current-layout checks still belong to explicit native binding,
// not data conversion. Reject its known forbidden symbols without opening a display.
const legacyX11TriggerSchema = x11TriggerSchema.refine((trigger) => {
  const symbol = trigger.keysym;
  if (symbol === 0xff1b || (symbol >= 0xffe1 && symbol <= 0xffee) || [0xff7f, 0xff14, 0xfe03, 0xfe11].includes(symbol)) return false;
  const unicode = symbol < 0x100 ? symbol : (symbol >= 0x01000000 && symbol <= 0x0110ffff ? symbol - 0x01000000 : undefined);
  return unicode === undefined || (!(unicode >= 0xd800 && unicode <= 0xdfff) && !/\p{Cc}/u.test(String.fromCodePoint(unicode)));
});
const activeHistorySchema = z.array(z.string().max(MAX_USER_TEXT_BYTES).refine((text) => Buffer.byteLength(text, "utf8") <= MAX_USER_TEXT_BYTES)).max(20);
type TriggerReview = "KDE_MOUSE_TRIGGER" | "KDE_MODIFIER_TRIGGER" | "KDE_LEGACY_SPECIAL_KEY" | "INVALID_X11_TRIGGER";
export interface LegacyLinuxData {
  readonly preferences: Preferences;
  readonly history: string[];
  readonly preserved: { readonly settings: z.infer<typeof originalSettingsSchema> | null; readonly history: string[] };
  readonly triggerReview: TriggerReview[];
}

/** Pure conversion of v0.2.5 storage; never enables bindings, updates or autostart. */
export function convertLegacyLinuxData(input: unknown): LegacyLinuxData {
  try {
    const checked = inputSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(checked), "utf8") > MAX_UI_REQUEST_BYTES) throw new LegacyLinuxDataError("INVALID_DATA");
    const original = checked.settings, parsed = legacyPreferencesSchema.parse(original ?? {});
    const triggerReview: TriggerReview[] = [];
    const x11 = original?.["x11_trigger"];
    const convertedX11 = x11 === undefined || x11 === null ? null : legacyX11TriggerSchema.safeParse(x11);
    if (convertedX11 && !convertedX11.success) triggerReview.push("INVALID_X11_TRIGGER");
    const native = parsed.native_trigger;
    if (native?.kind === "mouse") triggerReview.push("KDE_MOUSE_TRIGGER");
    if (native?.kind === "key") {
      const base = native.key & ~modifiers;
      if (base >= 0x01000020 && base <= 0x01000023) triggerReview.push("KDE_MODIFIER_TRIGGER");
      if (!kdeKeySchema.safeParse(native.key).success) triggerReview.push("KDE_LEGACY_SPECIAL_KEY");
    }
    // These two upgrades are exactly Paths::load at v0.2.5. Absence of a settings
    // file differs from an existing file missing the onboarding/GPU markers.
    const preferences = preferencesSchema.parse({ ...parsed,
      setup_completed: parsed.setup_completed ?? (original !== undefined),
      gpu: original !== undefined && parsed.gpu_configured === undefined ? true : parsed.gpu,
      gpu_configured: parsed.gpu_configured ?? true,
      x11_trigger: convertedX11 && convertedX11.success ? convertedX11.data : null,
    });
    const history = checked.history ?? [];
    return { preferences, history: activeHistorySchema.parse(history.slice(0, 20)),
      preserved: { settings: original ?? null, history }, triggerReview };
  } catch { throw new LegacyLinuxDataError("INVALID_DATA"); }
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const recoveryName = new RegExp(`^recording-([0-9]{20})-(${uuid})\\.wav$`, "u");
export interface LegacyLinuxRecoveryName { readonly source: string; readonly target: string; readonly id: string; readonly timestampMs: string }

/** Preserve UUID/audio identity; the filesystem migration must retain chronological metadata. */
export function convertLegacyLinuxRecoveryNames(input: unknown): LegacyLinuxRecoveryName[] {
  try {
    const names = z.array(z.string().max(128)).max(100_000).parse(input), sources = new Set<string>(), targets = new Set<string>();
    if (Buffer.byteLength(JSON.stringify(names), "utf8") > MAX_UI_REQUEST_BYTES) throw new LegacyLinuxDataError("INVALID_RECOVERY_NAMES");
    return names.map((source) => {
      const match = recoveryName.exec(source), timestampMs = match?.[1], id = match?.[2];
      if (!timestampMs || !id || sources.has(source)) throw new LegacyLinuxDataError("INVALID_RECOVERY_NAMES");
      const target = `recording-${id}.wav`;
      if (targets.has(target)) throw new LegacyLinuxDataError("INVALID_RECOVERY_NAMES");
      sources.add(source); targets.add(target); return { source, target, id, timestampMs };
    });
  } catch { throw new LegacyLinuxDataError("INVALID_RECOVERY_NAMES"); }
}

import { z } from "zod";
import { MAX_UI_REQUEST_BYTES, MAX_USER_TEXT_BYTES, preferencesSchema, snippetSchema, type Preferences } from "../contracts/ui.js";

export class LegacyMacosDataError extends Error {
  constructor() { super("INVALID_DATA"); this.name = "LegacyMacosDataError"; }
}

const jsonObjectSchema = z.record(z.string(), z.json());
const text = (maximum: number) => z.string().max(maximum).refine((value) => Buffer.byteLength(value, "utf8") <= maximum);
const languages = ["auto", "de", "en", "fr", "es", "it", "pt", "nl", "pl", "tr", "ru", "uk", "zh", "ja", "ko"] as const;
const persistedSchema = z.object({
  uiLanguage: preferencesSchema.shape.ui_language.default("en"),
  setupCompleted: z.boolean().optional(), setupShown: z.boolean().default(false),
  language: z.enum(languages).optional(), recordingMode: z.enum(["toggle", "hold"]).default("toggle"),
  selectedModel: preferencesSchema.shape.model.optional(), outputMode: z.enum(["paste", "clipboard", "editor"]).default("paste"),
  editorAppPath: text(4096).default("/System/Applications/TextEdit.app"),
  restoreClipboard: z.boolean().default(true), playSounds: z.boolean().default(true), showIdleOverlay: z.boolean().default(false),
  vocabulary: preferencesSchema.shape.vocabulary.default(""), keepHistory: z.boolean().default(true),
  autoCheckUpdates: z.boolean().default(true), history: z.array(z.string()).default([]),
}).strip();
const legacySnippetSchema = snippetSchema.extend({
  // Foundation UUID decoding accepts uppercase and nil UUIDs; preserve spelling.
  id: snippetSchema.shape.id.regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu),
}).strip();
const inputSchema = z.strictObject({
  plist: jsonObjectSchema.optional(), snippets: z.array(jsonObjectSchema).max(100).optional(),
  systemLanguage: text(128),
  // These are native facts, not UserDefaults: ModelManager recommendations,
  // MacHardware.isAppleSilicon and SMAppService requested/pending login state.
  defaults: z.strictObject({ recommendedModel: preferencesSchema.shape.model, appleSilicon: z.boolean(), launchAtLogin: z.boolean() }),
});
export const legacyMacosContextSchema = inputSchema.pick({ systemLanguage: true, defaults: true });
export type LegacyMacosContext = z.infer<typeof legacyMacosContextSchema>;
export const legacyMacosMigrationContextSchema = legacyMacosContextSchema.extend({
  loginStatus: z.enum(["enabled", "requires-approval", "not-registered", "not-found"]),
}).refine((context) => context.defaults.launchAtLogin === (context.loginStatus === "enabled" || context.loginStatus === "requires-approval"));
export type LegacyMacosMigrationContext = z.infer<typeof legacyMacosMigrationContextSchema>;
const activeHistorySchema = z.array(text(MAX_USER_TEXT_BYTES)).max(20);
const knownPlistKeys = new Set([...Object.keys(persistedSchema.shape), "overlayOrigin", "trigger"]);
type MacosReview = "MAC_NATIVE_TRIGGER" | "MAC_DEFAULT_TRIGGER" | "MAC_EDITOR_OUTPUT" | "MAC_EDITOR_PATH" |
  "MAC_HOLD_MODE" | "MAC_HARDWARE_GPU" | "MAC_HISTORY_OVERFLOW" | "MAC_HISTORY_DISABLED" | "MAC_UNMAPPED_PREFERENCES";
export interface LegacyMacosData {
  readonly preferences: Preferences;
  readonly history: string[];
  readonly preserved: { readonly plist: z.infer<typeof jsonObjectSchema> | null;
    readonly snippets: z.infer<typeof jsonObjectSchema>[] | null; readonly history: string[] };
  readonly legacy: { readonly editorAppPath: string;
    readonly trigger: { readonly present: boolean; readonly value: z.infer<ReturnType<typeof z.json>> } };
  readonly review: MacosReview[];
}

/** Pure v0.2.5 plist projection conversion; no plist/Data decoding or platform effects. */
export function convertLegacyMacosData(input: unknown): LegacyMacosData {
  try {
    const checked = inputSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(checked), "utf8") > MAX_UI_REQUEST_BYTES) throw new LegacyMacosDataError();
    const plist = checked.plist, persisted = persistedSchema.parse(plist ?? {});
    const prefix = Array.from(checked.systemLanguage).slice(0, 2).join("");
    const systemDefault = z.enum(languages).safeParse(prefix);
    const snippets = z.array(legacySnippetSchema).max(100).parse(checked.snippets ?? []);
    const preferences = preferencesSchema.parse({
      ui_language: persisted.uiLanguage, setup_completed: persisted.setupCompleted ?? persisted.setupShown,
      model: persisted.selectedModel ?? checked.defaults.recommendedModel,
      language: persisted.language ?? (systemDefault.success ? systemDefault.data : "auto"),
      microphone: "", vocabulary: persisted.vocabulary, snippets, output: persisted.outputMode,
      hold_to_record: persisted.recordingMode === "hold", gpu: checked.defaults.appleSilicon,
      keep_history: persisted.keepHistory, restore_clipboard: persisted.restoreClipboard, play_sounds: persisted.playSounds,
      show_idle_overlay: persisted.showIdleOverlay, launch_at_login: checked.defaults.launchAtLogin,
      auto_check_updates: persisted.autoCheckUpdates,
      // A saved native keyCode/layout/CGEvent binding is not an Electron accelerator.
      macos_shortcut: null,
    });
    const present = plist !== undefined && Object.hasOwn(plist, "trigger"), review: MacosReview[] = [present ? "MAC_NATIVE_TRIGGER" : "MAC_DEFAULT_TRIGGER"];
    if (preferences.output === "editor") review.push("MAC_EDITOR_OUTPUT");
    if (plist !== undefined && Object.hasOwn(plist, "editorAppPath")) review.push("MAC_EDITOR_PATH");
    if (preferences.hold_to_record) review.push("MAC_HOLD_MODE");
    if (preferences.gpu) review.push("MAC_HARDWARE_GPU");
    if (plist !== undefined && Object.keys(plist).some((key) => !knownPlistKeys.has(key))) review.push("MAC_UNMAPPED_PREFERENCES");
    // AppState hides saved history when keepHistory is false. Its startup does
    // not truncate; the current host's 20-item view needs an explicit overflow
    // review while every original entry remains available to the migration.
    if (persisted.keepHistory && persisted.history.length > 20) review.push("MAC_HISTORY_OVERFLOW");
    if (!persisted.keepHistory && persisted.history.length > 0) review.push("MAC_HISTORY_DISABLED");
    return { preferences, history: activeHistorySchema.parse(persisted.keepHistory ? persisted.history.slice(0, 20) : []),
      preserved: { plist: plist ?? null, snippets: checked.snippets ?? null, history: persisted.history },
      legacy: { editorAppPath: persisted.editorAppPath, trigger: { present, value: present ? plist?.["trigger"] ?? null : null } }, review };
  } catch { throw new LegacyMacosDataError(); }
}

import { z } from "zod";
import { updateDownloadProgressSchema } from "../update/update-download-progress.js";
import { speechLanguageSchema } from "../speech/speech.js";
import {
  defaultTextConnectionAvailability, defaultTextConnectionSettings, emptyTextConversation, idleTextConnectionProcessing,
  customCliConnectionSchema, textConnectionSettingsSchema, textConnectionsStateSchema,
} from "../text/connections.js";
import { textProcessingStageEventSchema } from "../text/processing.js";
import { snippetSchema } from "../text/snippets.js";
import {
  localProcessingProfileSchema, localProcessingProfilePatchSchema, localProcessingOutputSchema,
  previewLocalProcessingInputSchema, cancelLocalProcessingInputSchema,
} from "../speech/local-processing.js";

// Transport limits reject oversized messages; they never shorten user text or limit recording.
export const MAX_UI_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_UI_STATE_BYTES = 32 * 1024 * 1024;
export const MAX_USER_TEXT_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const utf8 = (limit: number) => z.string().max(limit).refine(
  (value) => encoder.encode(value).byteLength <= limit,
  { message: "String exceeds the supported UTF-8 byte length" },
);
const label = utf8(1024);
/**
 * Recording source identifiers: PulseAudio source names on Linux and CoreAudio device UIDs on
 * macOS. CoreAudio UIDs may contain spaces, so printable ASCII is allowed without outer spaces.
 */
export const recordingSourceIdSchema = z.string().regex(/^[!-~](?:[ -~]{0,253}[!-~])?$/u);
export const hardwareDeviceNameSchema = utf8(256).refine(
  (value) => value.length > 0 && value === value.trim() && !/\p{Cc}/u.test(value),
);
// Imported macOS models retain their file's Unicode/space-containing basename. Hosts resolve
// identifiers against their model inventory; the renderer cannot supply an arbitrary path.
const modelId = utf8(1024).min(1).refine(
  (value) => value !== "." && value !== ".." && !/[\/\\\u0000-\u001f\u007f-\u009f]/u.test(value),
  { message: "Model identifier must be a basename" },
);
const fraction = z.number().finite().min(0).max(1);
const userText = utf8(MAX_USER_TEXT_BYTES);
export const historyEntrySchema = z.strictObject({
  text: userText,
  created_at: z.string().datetime(),
  duration_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export const updateDetailsSchema = z.strictObject({ highlights: z.array(utf8(512)).max(5),
  localized_highlights: z.strictObject({ en: z.array(utf8(512)).max(5).optional(), de: z.array(utf8(512)).max(5).optional() }).optional(),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
export type UpdateDetails = z.infer<typeof updateDetailsSchema>;

const tabSchema = z.enum(["setup", "general", "models", "snippets", "history", "about"]);
export type Tab = z.infer<typeof tabSchema>;
const uiLanguageSchema = z.enum(["en", "de"]);

export { snippetSchema };
export type { Snippet } from "../text/snippets.js";
const vocabularyText = utf8(8192).refine(
  (value) => value.length > 0 && value === value.trim() && !/\p{Cc}/u.test(value.replace(/\t/gu, "")),
  { message: "Vocabulary entries must contain trimmed text" },
);
const vocabularyEntrySchema = z.strictObject({
  spelling: vocabularyText,
  misheard: z.array(vocabularyText).max(4096),
});
export type VocabEntry = z.infer<typeof vocabularyEntrySchema>;
function refineVocabularyEntries(
  entries: VocabEntry[],
  context: z.RefinementCtx,
  allowDuplicateSpellings: boolean,
  allowDuplicateCorrections: boolean,
): void {
  const spellings = new Set<string>();
  const aliasOwners = new Map<string, string>();
  let textBytes = 0;
  let promptBytes = 0;
  for (const [index, entry] of entries.entries()) {
    const spelling = vocabularyEntryKey(entry.spelling);
    if (!allowDuplicateSpellings && spellings.has(spelling)) {
      context.addIssue({ code: "custom", path: [index, "spelling"], message: "Duplicate spelling" });
    }
    spellings.add(spelling);
    textBytes += encoder.encode(entry.spelling).byteLength;
    promptBytes += encoder.encode(entry.spelling).byteLength + (index > 0 ? 1 : 0);
    const aliases = new Set<string>();
    for (const [aliasIndex, alias] of entry.misheard.entries()) {
      const key = vocabularyEntryKey(alias);
      if (!allowDuplicateCorrections && aliases.has(key)) {
        context.addIssue({ code: "custom", path: [index, "misheard", aliasIndex], message: "Duplicate correction" });
      }
      aliases.add(key);
      const matchKey = vocabularyMatchKey(alias);
      const owner = aliasOwners.get(matchKey);
      if (matchKey && owner !== undefined && owner !== spelling) {
        context.addIssue({ code: "custom", path: [index, "misheard", aliasIndex], message: "Correction is assigned to another spelling" });
      } else if (matchKey && owner === undefined) aliasOwners.set(matchKey, spelling);
      textBytes += encoder.encode(alias).byteLength;
    }
  }
  if (textBytes > 8192 || promptBytes > 8192) {
    context.addIssue({ code: "custom", message: "Vocabulary exceeds the supported size" });
  }
}
const vocabularyEntriesSchema = z.array(vocabularyEntrySchema).max(4096)
  .superRefine((entries, context) => refineVocabularyEntries(entries, context, true, true));
const editableVocabularyEntriesSchema = z.array(vocabularyEntrySchema).max(4096)
  .superRefine((entries, context) => refineVocabularyEntries(entries, context, false, false));
const preferenceVocabularyPatchSchema = z.array(vocabularyEntrySchema).max(4096)
  .superRefine((entries, context) => refineVocabularyEntries(entries, context, true, false));
function migrateVocabulary(input: unknown): unknown {
  if (typeof input !== "string") return input;
  return input.split(/[,;\n\r]/u)
    .map((term) => term.replace(/^[\p{White_Space}\uFEFF]+|[\p{White_Space}\uFEFF]+$/gu, ""))
    .filter(Boolean)
    .map((spelling) => ({ spelling, misheard: [] }));
}
export const vocabularySchema = z.preprocess(migrateVocabulary, vocabularyEntriesSchema);
export function vocabularyEditAllowed(current: readonly VocabEntry[], candidate: unknown): boolean {
  const editable = editableVocabularyEntriesSchema.safeParse(candidate);
  if (editable.success) return true;
  if (editable.error.issues.some((issue) => issue.message !== "Duplicate spelling")) return false;
  const parsed = vocabularyEntriesSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const previousCounts = new Map<string, number>();
  for (const entry of current) {
    const key = vocabularyEntryKey(entry.spelling);
    previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
  }
  const candidateCounts = new Map<string, number>();
  for (const entry of parsed.data) {
    const key = vocabularyEntryKey(entry.spelling);
    candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
  }
  return Array.from(candidateCounts).every(([key, count]) =>
    count <= 1 || count <= (previousCounts.get(key) ?? 0));
}
export function vocabularyMatchKey(value: string): string {
  return Array.from(value.normalize("NFKD").replace(/\p{Mark}/gu, ""))
    .flatMap((scalar) => Array.from(scalar.toLowerCase()))
    .filter((scalar) => /^[\p{Alphabetic}\p{Number}]$/u.test(scalar))
    .join("");
}
export function vocabularyEntryKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}
// Native Linux's new-write policy is stricter than macOS's saved editable drafts.
// Keep it separate so validating a snapshot/legacy Mac patch cannot hide the whole UI.
export const nonEmptySnippetSchema = snippetSchema.refine(
  (snippet) => snippet.trigger.trim().length > 0,
  { message: "Snippet trigger is empty", path: ["trigger"] },
);

export const nativeMouseButtonSchema = z.number().int().refine(
  (value) => value === 2 || (value >= 8 && value <= 31),
);
// These are host-owned serialized profiles, not renderer authority to bind native input.
export const nativeTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("key"), key: z.number().int().min(1).max(0x3fffffff) }),
  z.strictObject({ kind: z.literal("mouse"), button: nativeMouseButtonSchema }),
]);
export type NativeTrigger = z.infer<typeof nativeTriggerSchema>;
export const x11TriggerSchema = z.strictObject({
  keycode: z.number().int().min(8).max(255),
  keysym: z.number().int().min(1).max(0x1fffffff),
  modifiers: z.number().int().min(0).max(255),
  group: z.number().int().min(0).max(3),
});
export type X11Trigger = z.infer<typeof x11TriggerSchema>;

export const preferencesSchema = z.strictObject({
  ui_language: uiLanguageSchema,
  setup_completed: z.boolean(),
  model: modelId,
  language: speechLanguageSchema,
  microphone: utf8(1024),
  vocabulary: vocabularySchema,
  cleanup_enabled: z.boolean().default(true),
  snippets: z.array(snippetSchema).max(100),
  output: z.enum(["paste", "clipboard", "editor"]),
  hold_to_record: z.boolean(),
  native_trigger: nativeTriggerSchema.nullable().optional(),
  x11_trigger: x11TriggerSchema.nullable().optional(),
  macos_shortcut: utf8(128).min(1).nullable().optional(),
  gpu: z.boolean(),
  gpu_configured: z.boolean().optional(),
  keep_history: z.boolean(),
  restore_clipboard: z.boolean().optional(),
  play_sounds: z.boolean().optional(),
  show_idle_overlay: z.boolean().optional(),
  launch_at_login: z.boolean().optional(),
  auto_check_updates: z.boolean().optional(),
});
export type Preferences = z.infer<typeof preferencesSchema>;

// Match save_preferences: setup and captured trigger profiles have separate host commands.
export const preferencePatchSchema = preferencesSchema.omit({
  setup_completed: true,
  cleanup_enabled: true,
  gpu_configured: true,
  native_trigger: true,
  x11_trigger: true,
  macos_shortcut: true,
}).partial().extend({
  cleanup_enabled: z.boolean().optional(),
  vocabulary: preferenceVocabularyPatchSchema.optional(),
}).refine(
  (patch) => Object.values(patch).every((value) => value !== undefined),
  { message: "Preference patch values must be defined" },
);
export type PreferencePatch = z.infer<typeof preferencePatchSchema>;

export const modelSchema = z.strictObject({
  id: modelId,
  title: label,
  family: z.enum(["whisper", "parakeet"]),
  size: utf8(128),
  note: utf8(8192),
  // Rust catalog snapshots include these; macOS snapshots expose display fields only.
  file: utf8(1024).optional(),
  repository: utf8(1024).optional(),
});
export type Model = z.infer<typeof modelSchema>;

const macStateSchema = z.strictObject({
  microphone_allowed: z.boolean(),
  microphone_permission: z.enum(["not-determined", "granted", "denied", "restricted", "unknown"]).optional(),
  recording_shortcut: z.boolean(),
  shortcut_toggle_only: z.boolean().optional(),
  clipboard_restore_available: z.boolean().optional(),
  shortcut_hint: utf8(8192),
  editor: label,
  recommended: z.array(modelId).max(128),
  updates_configured: z.boolean(),
  launch_at_login_pending: z.boolean().optional(),
});
const updateStateSchema = z.strictObject({
  configured: z.boolean(),
  status: z.enum(["idle", "checking", "current", "available", "downloading", "verifying", "ready", "installing", "error"]),
  version: utf8(128).nullable(),
  progress: fraction,
  download: updateDownloadProgressSchema.optional(),
  error: utf8(65536).nullable(),
  package: z.enum(["macos", "deb", "appimage", "development"]),
  details: updateDetailsSchema.optional(),
});
export type UpdateState = z.infer<typeof updateStateSchema>;

export const appStateSchema = z.strictObject({
  updates: updateStateSchema,
  initial_tab: tabSchema.optional(),
  platform: z.enum(["macos", "linux"]),
  macos: macStateSchema.optional(),
  version: utf8(128).min(1),
  development_build: utf8(128).optional(),
  launch_at_login_available: z.boolean().optional(),
  status: z.enum(["idle", "recording", "transcribing", "done", "error"]),
  message: userText,
  transcript: userText,
  raw_transcript: userText.optional(),
  raw_transcript_preview_omitted: z.boolean().optional(),
  text_processing_preview_omitted: z.boolean().optional(),
  transcript_preview_omitted: z.boolean().optional(),
  history: z.array(historyEntrySchema).max(20),
  preferences: preferencesSchema,
  models: z.array(modelSchema).max(128),
  installed: z.array(modelId).max(128),
  microphones: z.array(label).max(256),
  microphone_labels: z.array(z.strictObject({ id: recordingSourceIdSchema, name: label })).max(256).optional(),
  recommended_models: z.array(modelId).max(128).optional(),
  session: label,
  desktop: label,
  clipboard_available: z.boolean(),
  shortcut_portal: z.boolean(),
  paste_portal: z.boolean(),
  shortcut: label.nullable(),
  native_shortcuts: z.boolean().optional(),
  native_x11: z.boolean().optional(),
  native_paste: z.boolean().optional(),
  native_mouse: z.boolean().optional(),
  native_middle_mouse: z.boolean().optional(),
  recording_shortcut: z.boolean().optional(),
  shortcut_configuring: z.boolean().optional(),
  paste_ready: z.boolean(),
  paste_configuring: z.boolean().optional(),
  gpu_available: z.boolean(),
  gpu_checked: z.boolean().optional(),
  gpu_supported: z.boolean().optional(),
  cpu_device: hardwareDeviceNameSchema.nullable().optional(),
  gpu_device: hardwareDeviceNameSchema.nullable().optional(),
  gpu_fallback: z.boolean().optional(),
  recovery_available: z.boolean().optional(),
  overlay_available: z.boolean().optional(),
  overlay_unavailable_reason: z.enum(["unsupported", "runtime"]).optional(),
  download: modelId.nullable(),
  progress: fraction,
  // A finite safe integer is a wire constraint, not an automatic recording cutoff.
  elapsed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  level: fraction.optional(),
  recording_generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  model_directory: utf8(4096),
  profile: z.literal("development").optional(),
  recording_available: z.boolean().optional(),
  recording_unavailable_reason: z.enum(["host", "audio", "model", "permission"]).optional(),
  local_processing: localProcessingProfileSchema.optional(),
  local_processing_invalid_profile: z.boolean().optional(),
  text_connections: textConnectionsStateSchema.default(() => ({ settings: defaultTextConnectionSettings(),
    available: defaultTextConnectionAvailability(), scanning: false,
    processing: idleTextConnectionProcessing(), conversation: emptyTextConversation() })),
  text_processing: textProcessingStageEventSchema.nullable().default(null),
}).refine(
  (state) => state.platform !== "macos" || state.macos !== undefined,
  { message: "macOS state requires its capability snapshot", path: ["macos"] },
).refine(
  (state) => encoder.encode(JSON.stringify(state)).byteLength <= MAX_UI_STATE_BYTES,
  { message: "State exceeds the supported transport size" },
);
export type AppState = z.infer<typeof appStateSchema>;

const recordingTelemetrySchema = z.strictObject({
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  elapsed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  level: fraction,
});
export type RecordingTelemetry = z.infer<typeof recordingTelemetrySchema>;

interface RecordingSnapshotProjection {
  readonly phase: string;
  readonly generation: number;
  readonly elapsedMs: number;
  readonly busy: boolean;
  readonly recoveryAvailable: boolean;
  readonly error: string | null;
  readonly transcript: string;
}

export function isSteadyRecordingUpdate(
  previous: RecordingSnapshotProjection,
  next: RecordingSnapshotProjection,
): boolean {
  return previous.phase === "recording" && next.phase === "recording" &&
    previous.generation === next.generation && next.elapsedMs >= previous.elapsedMs &&
    previous.busy === next.busy && previous.recoveryAvailable === next.recoveryAvailable &&
    previous.error === next.error && previous.transcript === next.transcript;
}

export function isCurrentRecordingTelemetry(
  state: Pick<AppState, "status" | "recording_generation" | "elapsed">,
  telemetry: RecordingTelemetry,
): boolean {
  return state.status === "recording" && state.recording_generation !== undefined &&
    telemetry.generation === state.recording_generation && telemetry.elapsed >= state.elapsed;
}

const noArgs = z.strictObject({});
const modelArgs = z.strictObject({ id: modelId });
const actionResult = z.union([z.null(), z.undefined()]);
const localProcessingFailureSchema = z.enum([
  "INVALID_REQUEST", "INVALID_PROFILE", "DISABLED", "MODEL_REQUIRED", "BUSY", "CANCELLED", "CLOSED",
  "TIMEOUT", "CONNECTION_FAILED", "HTTP_REJECTED", "RESPONSE_TOO_LARGE", "RESPONSE_READ_FAILED", "INVALID_RESPONSE",
]);
const localProcessingPreviewResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), text: localProcessingOutputSchema }),
  z.strictObject({ ok: z.literal(false), code: localProcessingFailureSchema }),
]);

/** Fixed renderer capabilities. Host-only bulk settings and arbitrary paths are not commands. */
export const commandInputSchemas = {
  get_state: noArgs,
  save_preferences: z.strictObject({ changes: preferencePatchSchema }),
  save_local_processing: z.strictObject({ changes: localProcessingProfilePatchSchema }),
  preview_local_processing: previewLocalProcessingInputSchema,
  cancel_local_processing: cancelLocalProcessingInputSchema,
  scan_connections: noArgs,
  start_lm_studio_server: noArgs,
  save_connections: z.strictObject({ settings: textConnectionSettingsSchema }),
  test_custom_cli_connection: z.strictObject({ connection: customCliConnectionSchema }),
  new_conversation: noArgs,
  cancel_text_processing: noArgs,
  toggle_recording: noArgs,
  cancel_recording: noArgs,
  retry_transcription: noArgs,
  discard_recovery: noArgs,
  complete_setup: noArgs,
  refresh_microphones: noArgs,
  copy_transcript: noArgs,
  copy_history: z.strictObject({ index: z.number().int().min(0).max(19) }),
  clear_history: noArgs,
  show_models_folder: noArgs,
  download_model: modelArgs,
  cancel_download: noArgs,
  delete_model: modelArgs,
  import_model: noArgs,
  enable_shortcut: noArgs,
  cancel_shortcut: noArgs,
  clear_shortcut: noArgs,
  desktop_shortcut: noArgs,
  capture_mouse_trigger: z.strictObject({ button: nativeMouseButtonSchema }),
  enable_paste: noArgs,
  disable_paste: noArgs,
  allow_microphone: noArgs,
  choose_editor: noArgs,
  show_transcripts_folder: noArgs,
  open_login_settings: noArgs,
  check_updates: noArgs,
  download_update: noArgs,
  install_update: noArgs,
  open_project_link: z.strictObject({ target: z.enum(["repository", "issues", "license", "release"]) }),
  window_action: z.strictObject({ action: z.enum(["minimize", "maximize", "close"]) }),
};
const commandNameSchema = z.strictObject(commandInputSchemas).keyof();
export type CommandName = z.infer<typeof commandNameSchema>;
export const commandOutputSchemas = {
  get_state: appStateSchema,
  save_preferences: appStateSchema,
  save_local_processing: appStateSchema,
  preview_local_processing: localProcessingPreviewResultSchema,
  cancel_local_processing: actionResult,
  scan_connections: appStateSchema,
  start_lm_studio_server: appStateSchema,
  save_connections: appStateSchema,
  test_custom_cli_connection: z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), elapsed_ms: z.number().int().min(0).max(15_000) }),
    z.strictObject({ ok: z.literal(false), code: z.enum(["UNAVAILABLE", "TIMEOUT", "CANCELLED", "FAILED", "INVALID_RESPONSE", "BUSY"]) }),
  ]),
  new_conversation: appStateSchema,
  cancel_text_processing: actionResult,
  toggle_recording: actionResult,
  cancel_recording: actionResult,
  retry_transcription: actionResult,
  discard_recovery: actionResult,
  complete_setup: actionResult,
  refresh_microphones: actionResult,
  copy_transcript: actionResult,
  copy_history: actionResult,
  clear_history: actionResult,
  show_models_folder: actionResult,
  download_model: actionResult,
  cancel_download: actionResult,
  delete_model: actionResult,
  import_model: actionResult,
  enable_shortcut: actionResult,
  cancel_shortcut: actionResult,
  clear_shortcut: actionResult,
  desktop_shortcut: actionResult,
  capture_mouse_trigger: actionResult,
  enable_paste: actionResult,
  disable_paste: actionResult,
  allow_microphone: actionResult,
  choose_editor: actionResult,
  show_transcripts_folder: actionResult,
  open_login_settings: actionResult,
  check_updates: actionResult,
  download_update: actionResult,
  install_update: actionResult,
  open_project_link: actionResult,
  window_action: actionResult,
} satisfies Record<CommandName, z.ZodType>;
export type CommandInput<N extends CommandName> = z.infer<(typeof commandInputSchemas)[N]>;
export type CommandOutput<N extends CommandName> = z.infer<(typeof commandOutputSchemas)[N]>;

export function validateCommandName(value: unknown): CommandName {
  return commandNameSchema.parse(value);
}
// The overload preserves the selected schema's output type; the implementation parses that exact entry.
export function validateCommandInput<N extends CommandName>(name: N, value: unknown): CommandInput<N>;
export function validateCommandInput(name: CommandName, value: unknown) {
  return commandInputSchemas[name].parse(value);
}
export function validateCommandOutput<N extends CommandName>(name: N, value: unknown): CommandOutput<N>;
export function validateCommandOutput(name: CommandName, value: unknown) {
  return commandOutputSchemas[name].parse(value);
}

const eventSchemas = { state: appStateSchema, recording_telemetry: recordingTelemetrySchema, navigate: tabSchema };
const eventNameSchema = z.strictObject(eventSchemas).keyof();
export type EventName = z.infer<typeof eventNameSchema>;
export type EventPayload<N extends EventName> = z.infer<(typeof eventSchemas)[N]>;
export function validateEventName(value: unknown): EventName {
  return eventNameSchema.parse(value);
}
export function validateEvent<N extends EventName>(name: N, value: unknown): EventPayload<N>;
export function validateEvent(name: EventName, value: unknown) {
  return eventSchemas[name].parse(value);
}

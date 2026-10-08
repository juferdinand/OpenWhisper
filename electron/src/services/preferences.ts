import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MAX_UI_REQUEST_BYTES, preferencePatchSchema, preferencesSchema,
  nativeTriggerSchema, type NativeTrigger, x11TriggerSchema, type X11Trigger,
  type PreferencePatch, type Preferences,
} from "../contracts/ui.js";
import type { DevelopmentProfile } from "./profiles.js";

export function developmentPreferences(): Preferences {
  return preferencesSchema.parse({
    ui_language: "en", setup_completed: false, model: "tiny", language: "auto",
    microphone: "", vocabulary: "", snippets: [], output: "clipboard",
    hold_to_record: false, gpu: false, keep_history: true,
    restore_clipboard: false, play_sounds: false, show_idle_overlay: false,
    launch_at_login: false, auto_check_updates: false,
  });
}

function enforceDevelopmentPolicy(preferences: Preferences): void {
  if (preferences.launch_at_login || preferences.auto_check_updates) {
    throw new Error("Automatic startup and stable updates are unavailable in development.");
  }
}

async function readPrivatePreferences(path: string): Promise<Preferences | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Development preferences could not be opened safely.");
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.uid !== process.getuid?.() || (stats.mode & 0o777) !== 0o600 ||
        stats.size > MAX_UI_REQUEST_BYTES) throw new Error("Development preferences are unsafe.");
    const bytes = Buffer.alloc(MAX_UI_REQUEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, Math.min(65536, bytes.length - length), null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_UI_REQUEST_BYTES) throw new Error("Development preferences exceed their size limit.");
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    const preferences = preferencesSchema.parse(raw);
    enforceDevelopmentPolicy(preferences);
    return preferences;
  } finally { await file.close(); }
}

/** Patches are serialized against the latest saved state, never a stale renderer snapshot. */
export class DevelopmentPreferenceStore {
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string, private preferences: Preferences) {}

  static async open(profile: DevelopmentProfile): Promise<DevelopmentPreferenceStore> {
    const path = join(profile.paths.settings, "preferences.json");
    return new DevelopmentPreferenceStore(path, await readPrivatePreferences(path) ?? developmentPreferences());
  }

  snapshot(): Preferences { return structuredClone(this.preferences); }

  patch(changes: PreferencePatch): Promise<Preferences> {
    const checked = preferencePatchSchema.parse(changes);
    return this.update(checked);
  }

  completeSetup(): Promise<Preferences> { return this.update({ setup_completed: true }); }
  saveNativeTrigger(trigger: NativeTrigger | null): Promise<Preferences> {
    return this.update({ native_trigger: trigger === null ? null : nativeTriggerSchema.parse(trigger) });
  }
  saveX11Trigger(trigger: X11Trigger | null): Promise<Preferences> {
    return this.update({ x11_trigger: trigger === null ? null : x11TriggerSchema.parse(trigger) });
  }

  private update(changes: PreferencePatch | Pick<Preferences, "setup_completed"> | Pick<Preferences, "native_trigger"> | Pick<Preferences, "x11_trigger">): Promise<Preferences> {
    const updated = this.queue.then(async () => {
      const preferences = preferencesSchema.parse({ ...this.preferences, ...changes });
      enforceDevelopmentPolicy(preferences);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await file.writeFile(JSON.stringify(preferences), "utf8");
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, this.path);
        this.preferences = preferences;
        return this.snapshot();
      } finally {
        await file?.close();
        await rm(temporary, { force: true });
      }
    });
    this.queue = updated.then(() => {}, () => {});
    return updated;
  }
}

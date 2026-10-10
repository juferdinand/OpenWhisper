import { join } from "node:path";
import {
  MAX_UI_REQUEST_BYTES, preferencePatchSchema, preferencesSchema,
  nativeTriggerSchema, type NativeTrigger, x11TriggerSchema, type X11Trigger,
  type PreferencePatch, type Preferences,
} from "../../contracts/ui/state.js";
import { prepareHostProfile, type HostProfile } from "./host-profile.js";
import { validateStableProfile } from "./stable-profile.js";
import { PrivateStateStore } from "./private-state.js";

function developmentPreferences(): Preferences {
  return preferencesSchema.parse({
    ui_language: "en", setup_completed: false, model: "tiny", language: "auto",
    microphone: "", vocabulary: "", snippets: [], output: "clipboard",
    hold_to_record: false, gpu: false, keep_history: true,
    restore_clipboard: false, play_sounds: false, show_idle_overlay: false,
    launch_at_login: false, auto_check_updates: false,
  });
}

function enforcePolicy(preferences: Preferences, development: boolean, allowDevelopmentAutostart: boolean): void {
  if (development && (preferences.auto_check_updates || (preferences.launch_at_login && !allowDevelopmentAutostart))) {
    throw new Error("Automatic startup and stable updates are unavailable in development.");
  }
}

export interface PreferenceStoreOptions { readonly allowDevelopmentAutostart?: boolean }

/** Serialized patches retain the latest host state. Saving opt-ins never starts services. */
export class PreferenceStore {
  private constructor(private readonly state: PrivateStateStore<Preferences>, private readonly development: boolean,
    private readonly allowDevelopmentAutostart: boolean) {}

  static async open(profile: HostProfile, options: PreferenceStoreOptions = {}): Promise<PreferenceStore> {
    const development = profile.appId === "io.github.whisperfree.dev";
    const allowDevelopmentAutostart = options.allowDevelopmentAutostart === true;
    if (options.allowDevelopmentAutostart !== undefined && typeof options.allowDevelopmentAutostart !== "boolean") {
      throw new Error("Preferences are unsafe, invalid or unavailable.");
    }
    if (allowDevelopmentAutostart && !development) throw new Error("Development autostart is unavailable for this profile.");
    if (development) prepareHostProfile(profile);
    else validateStableProfile(profile);
    let state: PrivateStateStore<Preferences>;
    try {
      // Stable defaults are written by the platform migration. Absence must never
      // silently adopt Dev defaults or initialize a partial stable destination.
      state = await PrivateStateStore.open(join(profile.paths.settings, "preferences.json"),
        preferencesSchema, developmentPreferences(), MAX_UI_REQUEST_BYTES, { requireExisting: !development });
    } catch { throw new Error("Preferences are unsafe, invalid or unavailable."); }
    enforcePolicy(state.snapshot(), development, allowDevelopmentAutostart);
    return new PreferenceStore(state, development, allowDevelopmentAutostart);
  }

  snapshot(): Preferences { return this.state.snapshot(); }

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
  saveMacShortcut(accelerator: string | null): Promise<Preferences> {
    return this.update({ macos_shortcut: preferencesSchema.shape.macos_shortcut.parse(accelerator) });
  }

  private update(changes: PreferencePatch | Pick<Preferences, "setup_completed"> | Pick<Preferences, "native_trigger"> | Pick<Preferences, "x11_trigger"> | Pick<Preferences, "macos_shortcut">): Promise<Preferences> {
    return this.state.update((current) => {
      const preferences = preferencesSchema.parse({ ...current, ...changes });
      enforcePolicy(preferences, this.development, this.allowDevelopmentAutostart);
      return preferences;
    });
  }
}

// Keep existing Dev consumers on the same implementation while stable bootstrap is wired.
export { PreferenceStore as DevelopmentPreferenceStore };

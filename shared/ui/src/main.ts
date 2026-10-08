import { invoke, listen } from "./bridge";
import { setLocale, t, type UILanguage } from "./i18n";
import "./style.css";
import { mountProcessingPreview } from "./local-processing";
import type { LocalProcessingProfilePatch } from "../../../electron/src/contracts/local-processing";

import {
  preferencePatchSchema, validateCommandName, validateCommandInput,
  type AppState as State, type Preferences, type PreferencePatch, type Tab, type Model, type Snippet,
} from "../../../electron/src/contracts/ui";

let state: State;
let tab: Tab = "general";
let dirty = false;
let portalBusy = false;
let contentKey = "";
let shellKey = "";
let renderedTab: Tab | undefined;
let preferenceQueue = Promise.resolve();
let pendingPreferences = 0;
let processingQueue = Promise.resolve();
const app = document.querySelector<HTMLDivElement>("#app")!;
const overlay =
  new URLSearchParams(location.search).has("overlay") ||
  (window as Window & { __OPENWHISPER_OVERLAY__?: boolean })
    .__OPENWHISPER_OVERLAY__ === true;
document.documentElement.classList.toggle("overlay", overlay);
app.innerHTML = '<div id="notice" role="alert" hidden></div>';
const esc = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const option = (value: string, label: string, selected: string) =>
  `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
const tabs: [Tab, string, string][] = [
  ["setup", "Setup", "M4 5h2m4 0h10M4 12h2m4 0h10M4 19h2m4 0h10"],
  [
    "general",
    "General",
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
  ],
  [
    "models",
    "Models",
    "M6 6h12v12H6zM9 9h6v6H9zM8 2v4m8-4v4M8 18v4m8-4v4M2 8h4m-4 8h4M18 8h4m-4 8h4",
  ],
  ["snippets", "Snippets", "M3 5h18M3 10h12M3 15h9M3 20h9m6-6v8m-4-4h8"],
  ["history", "History", "M4 8a9 9 0 1 1-1 7M4 3v5h5m3-1v5l4 2"],
  ["about", "About", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6m0-10v1"],
];
const symbol = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const section = (title: string, body: string, note = "") =>
  `<section>${title ? `<h2>${title}</h2>` : ""}<div class="group">${body}</div>${note ? `<p class="section-note">${note}</p>` : ""}</section>`;
const row = (label: string, control: string) =>
  `<div class="row"><span>${label}</span><div class="control">${control}</div></div>`;
const toggle = (label: string, name: string, checked: boolean, disabled = false) =>
  `<label class="row"><span>${label}</span><input class="switch" type="checkbox" data-pref="${name}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}></label>`;
const languages = () => {
  const choices: readonly (readonly [string, string])[] = [
    ["auto", t("Detect automatically")],
    ["en", t("English")],
    ["de", t("German")],
    ["es", t("Spanish")],
    ["fr", t("French")],
    ["it", t("Italian")],
    ["nl", t("Dutch")],
    ["pt", t("Portuguese")],
    ["pl", t("Polish")],
    ["uk", t("Ukrainian")],
    ["ja", t("Japanese")],
    ["zh", t("Chinese")],
    ["tr", t("Turkish")],
    ["ru", t("Russian")],
    ["ko", t("Korean")],
  ];
  return `<select data-pref="language" aria-label="${esc(t("Language"))}">${choices
    .map(([v, l]) => option(v, l, state.preferences.language))
    .join("")}</select>`;
};
const isMac = () => state.platform === "macos";
const macToggleOnly = () => isMac() && state.macos?.shortcut_toggle_only === true;
const outputs = () =>
  `<div class="radio-group">${[["paste", t("Paste at the cursor")], ["clipboard", t("Copy to clipboard only")], ...(isMac() ? [["editor", t("Open in a text editor")]] : [])].map(([v, l]) => `<label><input type="radio" name="output" data-pref="output" value="${v}" ${state.preferences.output === v ? "checked" : ""}>${l}</label>`).join("")}</div>`;

function notice(text: string) {
  const el = document.querySelector<HTMLElement>("#notice")!;
  el.textContent = t(text);
  el.hidden = false;
}
async function command(
  name: string,
  args?: Record<string, unknown>,
): Promise<boolean> {
  try {
    const command = validateCommandName(name);
    await invoke(command, validateCommandInput(command, args ?? {}));
    return true;
  } catch (error) {
    notice(String(error));
    return false;
  }
}
// Send only the edited fields. Serializing writes also keeps delayed host replies in order.
async function savePreferences(changes: PreferencePatch): Promise<boolean> {
  pendingPreferences++;
  const saved = preferenceQueue.then(async () => {
    try {
      state = await invoke("save_preferences", { changes });
      return true;
    } catch (error) {
      notice(String(error));
      try { state = await invoke("get_state"); } catch { /* Keep the last confirmed state. */ }
      return false;
    } finally {
      pendingPreferences--;
      if (!pendingPreferences) render();
    }
  });
  preferenceQueue = saved.then(() => {});
  return saved;
}
async function preference(name: string, value: unknown) {
  return savePreferences(preferencePatchSchema.parse({ [name]: value }));
}
async function saveProcessingProfile(changes: LocalProcessingProfilePatch): Promise<boolean> {
  const saved = processingQueue.then(async () => {
    try {
      state = await invoke("save_local_processing", { changes });
      render();
      return true;
    } catch {
      notice("Invalid text processing profile");
      try { state = await invoke("get_state"); render(); } catch { /* Retain the last confirmed state. */ }
      return false;
    }
  });
  processingQueue = saved.then(() => {});
  return saved;
}
function syncProcessingPreview() {
  const root = document.querySelector<HTMLElement>("#processing-preview");
  if (root && state.local_processing) {
    mountProcessingPreview(root, state.local_processing, state.transcript, saveProcessingProfile,
      state.local_processing_invalid_profile ?? false);
  }
}
function syncPreferenceControls() {
  if (pendingPreferences) return;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-pref]").forEach((input) => {
    const value = state.preferences[input.dataset.pref as keyof Preferences];
    if (input instanceof HTMLInputElement && input.type === "checkbox") input.checked = !!value;
    else if (input instanceof HTMLInputElement && input.type === "radio") input.checked = input.value === value;
    else input.value = String(value ?? "");
  });
  const vocabulary = document.querySelector<HTMLTextAreaElement>("#vocabulary");
  if (vocabulary && !dirty) vocabulary.value = state.preferences.vocabulary;
  const recognition = document.querySelector("#recognition-backend");
  if (recognition) recognition.textContent = recognitionBackend();
}
function recognitionBackend() {
  return state.gpu_available && state.preferences.gpu && !state.gpu_fallback
    ? `GPU · ${state.gpu_device ?? "Vulkan"}` : "CPU";
}

const microphoneIcon =
  "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8";
const pageDescriptions: Record<Tab, string> = {
  setup: "A few small steps. Then just speak your mind.",
  general: "Choose how you record and where your words go.",
  models: "Find the right balance of speed, size, and accuracy.",
  snippets: "Turn a few spoken words into something longer.",
  history: "Your recent words, saved only on this device.",
  about: "A little more freedom for your voice.",
};
function renderShell() {
  const key = `${state.preferences.ui_language}:${state.preferences.setup_completed}:${state.profile ?? "stable"}`;
  if (shellKey === key) return;
  shellKey = key;
  contentKey = "";
app.innerHTML = `<aside><div class="sidebar-brand"><img src="./app-icon.png" width="38" height="38" alt=""><div><strong>OpenWhisper${state.profile === "development" ? " Dev" : ""}</strong><span>${esc(t("Make yourself heard."))}</span></div></div><div class="nav-caption">${esc(t("WORKSPACE"))}</div><nav aria-label="${esc(t("Settings"))}">${tabs.filter(([id]) => id !== "setup" || !state.preferences.setup_completed).map(([id, title, path]) => `<button data-tab="${id}">${symbol(path)}<span>${esc(t(title))}</span></button>`).join("")}</nav><div class="language-switch" role="group" aria-label="${esc(t("Interface language"))}"><button data-ui-language="en" aria-pressed="${state.preferences.ui_language === "en"}">${esc(t("English"))}</button><button data-ui-language="de" aria-pressed="${state.preferences.ui_language === "de"}">Deutsch</button></div><div class="sidebar-foot">${symbol("M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6l-8-3m-4 9 3 3 5-6")}<div><strong>${esc(t("Private by design"))}</strong><span>${esc(t("Your voice stays here."))}</span></div></div></aside><main><header class="page-header"><div class="page-eyebrow">${esc(t("YOUR SPACE, YOUR PACE"))}</div><h1 id="page-title"></h1><p id="page-description"></p></header><div id="notice" role="alert" hidden></div><div id="content"></div></main><div id="record-control"></div>`;
if (overlay)
  app.innerHTML =
    '<div id="notice" role="alert" hidden></div><div id="record-control"></div>';
}
app.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tab], [data-ui-language]");
  if (!button) return;
  if (dirty) {
    notice(t("Save or discard your changes before switching tabs or language."));
    return;
  }
  if (button.dataset.uiLanguage) {
    void preference("ui_language", button.dataset.uiLanguage);
    return;
  }
  tab = button.dataset.tab as Tab;
  render();
});

function recordControl() {
  const recording = state.status === "recording",
    busy = state.status === "transcribing",
    recovery = !!state.recovery_available && !recording && !busy;
  const text = recording
    ? t("Recording · {time}", { time: `${Math.floor(state.elapsed / 60)}:${String(state.elapsed % 60).padStart(2, "0")}` })
    : busy
      ? t("Transcribing …")
      : recovery ? t("Retry transcription") : t("Start dictation");
  const controls = document.querySelector<HTMLDivElement>("#record-control")!;
  if (!controls.childElementCount) {
    controls.innerHTML = `<div class="record-status"><div class="audio-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div><strong id="status-title"></strong><span id="status" role="status"></span></div></div><div class="record-actions"><button id="cancel" aria-label="${esc(t("Discard recording"))}" hidden>${esc(t("Cancel"))}</button><button id="record" class="capsule"><span id="record-symbol"></span><span id="record-label"></span></button></div>`;
    document
      .querySelector("#record")!
      .addEventListener("click", () => void command(state.recovery_available ? "retry_transcription" : "toggle_recording"));
    document
      .querySelector("#cancel")!
      .addEventListener("click", () => void command(state.recovery_available && state.status !== "recording" ? "discard_recovery" : "cancel_recording"));
  }
  const button = document.querySelector<HTMLButtonElement>("#record")!;
  button.disabled = state.recording_available === false || busy || !!state.recording_shortcut || ["downloading", "installing"].includes(state.updates.status);
  button.classList.toggle("recording", recording);
  button.title = t(state.message);
  document.querySelector("#record-symbol")!.innerHTML = symbol(
    recording ? "M6 6h12v12H6z" : busy ? "M12 3a9 9 0 1 1-9 9" : microphoneIcon,
  );
  controls.dataset.status = state.status;
  controls.style.setProperty(
    "--voice-level",
    String(0.2 + (state.level ?? 0) * 0.8),
  );
  document.querySelector("#status-title")!.textContent = recording
    ? t("Listening to you")
    : busy
      ? t("Finding your words")
      : state.status === "error"
        ? t("Something needs attention")
        : state.recording_available === false ? t("Development preview") : t("Ready when you are");
  document.querySelector("#record-label")!.textContent = text;
  const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
  cancel.hidden = !recording && !recovery;
  cancel.setAttribute("aria-label", t(recovery ? "Discard saved recording" : "Discard recording"));
  cancel.textContent = t(recovery ? "Discard" : "Cancel");
  document.querySelector("#status")!.textContent = t(state.message);
}

function render() {
  if (!state) return;
  setLocale(state.preferences.ui_language ?? "en");
  if (tab === "setup" && state.preferences.setup_completed) tab = "general";
  renderShell();
  recordControl();
  if (overlay) return;
  document
    .querySelectorAll<HTMLButtonElement>("[data-tab]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.tab === tab));
  syncPreferenceControls();
  syncProcessingPreview();
  const triggerBusy = portalBusy || state.shortcut_configuring || ["recording", "transcribing"].includes(state.status) || ["downloading", "installing"].includes(state.updates.status);
  document.querySelectorAll<HTMLButtonElement>('[data-portal="enable_shortcut"], [data-portal="clear_shortcut"], [data-portal="desktop_shortcut"]').forEach(button => {
    button.disabled = triggerBusy || (button.dataset.portal === "enable_shortcut" && !state.native_shortcuts && !state.shortcut_portal);
  });
  if (dirty) {
    contentKey = "";
    return;
  }
  if (pendingPreferences) return;
  const nextKey = JSON.stringify([
    tab,
    tab === "general" ? null : state.status,
    // Checkbox changes must not replace the focused row or move its click target.
    tab === "general"
      ? { ui_language: state.preferences.ui_language, setup_completed: state.preferences.setup_completed,
          model: state.preferences.model, output: state.preferences.output }
      : state.preferences,
    state.installed,
    state.microphones,
    state.shortcut_portal,
    state.paste_portal,
    state.shortcut,
    state.shortcut_configuring,
    state.native_shortcuts, state.native_x11, state.native_paste, state.native_mouse, state.native_middle_mouse, state.recording_shortcut, state.preferences.native_trigger, state.preferences.x11_trigger,
    state.paste_ready,
    state.paste_configuring,
    state.download,
    Math.round(state.progress * 100),
    state.history,
    state.transcript,
    state.macos,
    state.updates,
    state.overlay_available,
    state.gpu_supported, state.gpu_available, state.gpu_device, state.gpu_fallback,
    state.launch_at_login_available,
    state.local_processing !== undefined,
    portalBusy,
  ], (_key, value) => {
    // Native bridge replies and state events may serialize dictionaries in different orders.
    // Compare their values so unchanged controls retain focus and their click targets.
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value;
  });
  if (contentKey === nextKey) return;
  contentKey = nextKey;
  document.querySelector("#page-title")!.textContent = t(tabs.find(
    ([id]) => id === tab,
  )![1]);
  document.querySelector("#page-description")!.textContent =
    t(pageDescriptions[tab]);
  document.querySelector<HTMLElement>(".page-header")!.hidden = tab === "about";
  document
    .querySelectorAll("[data-tab]")
    .forEach((button) =>
      button.setAttribute(
        "aria-current",
        button.getAttribute("data-tab") === tab ? "page" : "false",
      ),
    );
  const content = document.querySelector<HTMLDivElement>("#content")!;
  const main = document.querySelector<HTMLElement>("main")!;
  const scrollTop = renderedTab === tab ? main.scrollTop : 0;
  renderedTab = tab;
  const p = state.preferences;
  if (tab === "setup") {
    const step = (
      n: number,
      title: string,
      detail: string,
      done: boolean,
      action: string,
    ) =>
      `<div class="step"><span class="step-number ${done ? "complete" : ""}">${done ? "✓" : n}</span><div class="step-text"><strong>${title}</strong><p>${detail}</p>${action}</div></div>`;
    content.innerHTML =
      section(
        "",
        `<p class="secondary">${esc(t("OpenWhisper turns speech into text directly on this computer. No account, cloud, or subscription. Your recordings never leave your computer."))}</p>`,
      ) +
      section(
        t("Get started in six steps"),
        step(
          1,
          t("Download a speech model"),
          t("Download once, then work offline. Start with Whisper Base (142 MB) for CPU recognition."),
          state.installed.length > 0,
          `<button data-goto="models">${esc(t("Open models"))}</button>`,
        ) +
          step(
            2,
            isMac() ? t("Allow microphone access") : t("Choose a microphone"),
            t("Microphone access is needed to record your voice. Everything stays on your computer."),
            isMac()
              ? state.macos!.microphone_allowed
              : state.microphones.length > 0,
            isMac()
              ? `<button data-command="allow_microphone">${esc(t("Allow"))}</button>`
              : `<button data-goto="general">${esc(t("Microphone settings"))}</button>`,
          ) +
          step(
            3,
            t("Choose a language"),
            t("Which language do you usually dictate in? Automatic detection can mistake short phrases for English."),
            p.language !== "auto",
            languages(),
          ) +
          step(
            4,
            t("Where should the text go?"),
            t("Choose automatic pasting or copy your text to the clipboard."),
            true,
            outputs(),
          ) +
          step(
            5,
            isMac() ? t("Allow Accessibility access") : nativePaste() ? t("Allow automatic X11 paste") : t("Allow keyboard access"),
            isMac()
              ? t("Required for automatic insertion and advanced triggers. Clipboard-only output remains available.")
              : nativePaste() ? t("Enable Ctrl+V pasting into the focused application for this X11 session. No screen capture is requested.") : t("Optional permission for automatic pasting. Only keyboard access is requested; no screen capture."),
            state.paste_ready,
            `${permissionButton()}${!pasteAvailable() ? `<p class="secondary">${esc(t("Your desktop does not expose this portal. Clipboard output remains available."))}</p>` : ""}`,
          ) +
          step(
            6,
            t("Set a trigger and try it"),
            (isMac() && !macToggleOnly()) || state.native_mouse
              ? t("Choose a key, shortcut, or mouse button. Place the cursor in a text field, press the trigger, speak, then press it again.")
              : state.native_x11 || macToggleOnly() ? t("Choose a keyboard key or shortcut. Place the cursor in a text field, press the trigger, speak, then press it again.") : t("Choose a shortcut in your desktop’s dialog. Place the cursor in a text field, press the trigger, speak, then press it again."),
            !!state.shortcut,
            shortcutButton(),
          ),
      ) + section("", `<button data-command="complete_setup">${esc(t("Finish setup"))}</button>`, t("You can change permissions, shortcuts, and recording preferences in General at any time."));
  } else if (tab === "general") {
    content.innerHTML =
      section(
        t("Recording"),
        row(t("Trigger"), shortcutButton()) +
          (!isMac() || macToggleOnly()
            ? `<p class="secondary">${esc(triggerHelp())}</p>`
            : "") +
          row(
            t("Mode"),
            `<select data-pref="hold_to_record" aria-label="${esc(t("Recording mode"))}" ${modifierOnlyTrigger() || macToggleOnly() ? "disabled" : ""}>${option("false", t("Toggle"), String(p.hold_to_record))}${option("true", t("Push to talk"), String(p.hold_to_record))}</select>`,
          ) +
          (modifierOnlyTrigger() ? `<p class="secondary">${esc(t("Modifier-only triggers use toggle mode. Use a regular key or mouse button for push to talk."))}</p>` : "") +
          (macToggleOnly() ? `<p class="secondary">${esc(t("Regular keyboard shortcuts use toggle mode in this build."))}</p>` : "") +
          row(t("Language"), languages()) +
          (p.model.startsWith("parakeet")
            ? `<p class="secondary">${esc(t("The active Parakeet model detects the language automatically. This selection only applies to Whisper models."))}</p>`
            : "") +
          row(
            t("Microphone"),
            isMac()
              ? `<span class="secondary">${esc(t("System default"))}</span>`
              : `<select data-pref="microphone" aria-label="${esc(t("Microphone"))}">${option("", t("System default"), p.microphone)}${state.microphones.map((m) => option(m, m, p.microphone)).join("")}</select>`,
          ) +
          (isMac()
            ? toggle(
                t("Play start and stop sounds"),
                "play_sounds",
                !!p.play_sounds,
              )
            : ""),
        isMac()
          ? ""
          : t("Start and stop sounds are not yet available on Linux."),
      ) +
      section(
        t("Permissions"),
        (isMac() ? row(t("Microphone access"), `<button data-command="allow_microphone">${esc(t("System Settings"))}</button>`) : "") +
        row(isMac() ? t("Accessibility access") : nativePaste() ? t("Automatic X11 paste") : t("Keyboard access"), permissionButton()),
        isMac() ? t("Accessibility access enables automatic pasting and advanced triggers.")
          : nativePaste() ? t("Enable Ctrl+V pasting into the focused application for this X11 session. No screen capture is requested.") : t("Keyboard access is needed for automatic pasting. Portal permission may need to be enabled again after restarting the app."),
      ) +
      section(
        t("Custom vocabulary"),
        `<textarea id="vocabulary" rows="3" maxlength="8192" aria-label="${esc(t("Custom vocabulary"))}" placeholder="${esc(t("e.g. Kubernetes, Jira, SwiftUI, Grafana"))}">${esc(p.vocabulary)}</textarea><div class="edit-actions" id="vocabulary-actions" hidden><button id="save-vocabulary">${esc(t("Save"))}</button><button data-discard>${esc(t("Discard"))}</button></div>`,
        t("Names and technical terms, separated by commas. Similar spellings are corrected after recognition with any model. Whisper models also receive these terms during recognition."),
      ) +
      section(
        t("Output"),
        outputs() +
          (isMac() && state.macos?.clipboard_restore_available !== false && p.output === "paste"
            ? toggle(
                t("Restore the previous clipboard afterward"),
                "restore_clipboard",
                !!p.restore_clipboard,
              )
            : "") +
          (isMac() && p.output === "editor"
            ? row(
                esc(state.macos!.editor),
                `<button data-command="choose_editor">${esc(t("Choose another editor …"))}</button>`,
              ) +
              `<button data-command="show_transcripts_folder">${esc(t("Transcripts folder"))}</button>`
            : ""),
        isMac()
          ? ""
          : t("Automatic pasting requires keyboard permission. Clipboard restoration and text editor output are not yet available on Linux."),
      ) +
      section(
        t("Appearance & system"),
        (isMac() || state.overlay_available
              ? toggle(
                  t("Show overlay when idle"),
                  "show_idle_overlay",
                  !!p.show_idle_overlay,
                )
              : row(
                  t("Floating recording indicator"),
                  `<span class="warning">${esc(t("Not supported by this desktop"))}</span>`,
                )) +
          toggle(t("Launch at login"), "launch_at_login", !!p.launch_at_login, state.launch_at_login_available === false) +
          (state.macos?.launch_at_login_pending
            ? `<div class="row approval"><span>${esc(t("Allow OpenWhisper in System Settings to finish enabling launch at login."))}</span><button data-command="open_login_settings">${esc(t("System Settings"))}</button></div>`
            : "") +
          (isMac()
            ? row(t("System"), `<span class="secondary">${esc(state.desktop)} · macOS</span>`) +
              row(t("Recognition"), t("Metal GPU acceleration (CPU fallback)"))
            : (state.native_x11 ? row(t("Native X11 triggers"), t("Available")) : "") +
              (state.native_paste ? row(t("Native X11 paste"), t("Available")) : "") +
              row(
                t("Desktop"),
                `<span class="secondary">${esc(state.desktop)} · ${esc(state.session)}</span>`,
              ) +
              row(
                t("Clipboard helper"),
                state.clipboard_available
                  ? `<span class="success">${esc(t("Available"))}</span>`
                  : `<span class="warning">${esc(t("Install wl-clipboard (Wayland) or xclip (X11)"))}</span>`,
              ) +
              row(
                t("Global shortcuts portal"),
                state.shortcut_portal ? t("Available") : t("Unavailable"),
              ) +
              row(
                t("Keyboard portal"),
                state.paste_portal ? t("Available") : t("Unavailable"),
              ) +
              row(t("Recognition"), `<span id="recognition-backend">${esc(recognitionBackend())}</span>`) +
              toggle(t("Use GPU acceleration when available"), "gpu", p.gpu, !state.gpu_supported) +
              `<p class="secondary">${esc(t(!state.gpu_supported
                ? "GPU support is not included in this build. Install a current Linux package."
                : state.gpu_fallback
                  ? "The GPU could not complete recognition. The recording was processed on the CPU."
                  : !state.gpu_available
                    ? "No compatible GPU detected. CPU recognition remains available. Check your Vulkan driver and restart the app."
                    : "Vulkan acceleration is available. Recoverable GPU errors fall back to the CPU."))}</p>`),
        isMac()
          ? ""
          : t("There is no fixed recording limit. Stop or cancel when you are finished."),
      );
    const vocabulary =
      document.querySelector<HTMLTextAreaElement>("#vocabulary")!;
    vocabulary.oninput = () => {
      dirty = true;
      document.querySelector<HTMLElement>("#vocabulary-actions")!.hidden =
        false;
    };
    document
      .querySelector("#save-vocabulary")!
      .addEventListener("click", async () => {
        if (
          await savePreferences({ vocabulary: vocabulary.value })
        ) {
          dirty = false;
          render();
        }
      });
  } else if (tab === "models") {
    const modelRow = (m: Model) => {
      const installed = state.installed.includes(m.id),
        selected = p.model === m.id && installed,
        downloading = state.download === m.id;
      return `<div class="model-row ${selected ? "active-model" : ""}"><button class="model-radio" aria-label="${esc(t("Use {model}", { model: m.title }))}" aria-pressed="${selected}" data-select="${esc(m.id)}" ${!installed ? "disabled" : ""}><span></span></button><div class="model-description"><strong>${esc(m.title)}</strong>${(isMac() ? state.macos!.recommended.includes(m.id) : m.id === "base") ? `<span class="recommendation">${esc(t("Recommended"))}</span>` : ""}<p>${esc(m.size)} · ${esc(t(m.note))}</p></div><div class="model-buttons">${downloading ? `<progress aria-label="${esc(t("Download progress"))}" value="${state.progress}" max="1"></progress><button data-cancel-download>${esc(t("Cancel"))}</button>` : installed ? `${selected ? `<span class="success">${esc(t("Active"))}</span>` : `<button data-select="${esc(m.id)}">${esc(t("Use"))}</button>`}` : `<button data-download="${esc(m.id)}" ${state.download || ["downloading", "installing"].includes(state.updates.status) ? "disabled" : ""}>${esc(t("Download"))}</button>`}${installed && isMac() ? `<button data-delete="${esc(m.id)}" aria-label="${esc(t("Delete {model}", { model: m.title }))}" class="destructive">×</button>` : ""}</div></div>`;
    };
    content.innerHTML =
      section(
        "",
        `<strong>${esc(t("Your computer:"))} ${esc(state.desktop)} · ${esc(state.session)} · ${isMac() ? t("Native speech engine") : state.gpu_available ? "CPU / Vulkan" : "CPU"}</strong><p class="secondary">${esc(t("Highlighted models are recommended for your device."))}</p>`,
      ) +
      (state.profile === "development" ? section(t("Development model directory"),
        `<p class="secondary" id="development-model-directory" style="overflow-wrap:anywhere">${esc(state.model_directory)}</p>`) : "") +
      section(
        "NVIDIA Parakeet",
        state.models
          .filter((m) => m.family === "parakeet")
          .map(modelRow)
          .join(""),
        t("25 European languages, including German, English, French, Spanish, Italian, Polish, Dutch, and Ukrainian. Detects the language automatically."),
      ) +
      section(
        "OpenAI Whisper",
        state.models
          .filter((m) => m.family === "whisper")
          .map(modelRow)
          .join(""),
        t("About 99 languages, including Chinese, Japanese, Korean, and Turkish. Supports a fixed language and custom vocabulary."),
      ) +
      section(
        "",
        (isMac()
          ? `<button data-command="import_model">${esc(t("Import a model …"))}</button> `
          : "") + `<button id="show-models">${esc(t("Show in file manager"))}</button>`,
        isMac()
          ? t("All models run locally using whisper.cpp. Download once from Hugging Face or import a compatible ggml file.")
          : t("All models run locally using whisper.cpp. Download once from Hugging Face; downloads are checked against its SHA-256 metadata. Custom model import is not yet available on Linux."),
      ) + (state.local_processing ? '<section id="processing-preview"></section>' : "");
    syncProcessingPreview();
    content
      .querySelectorAll<HTMLButtonElement>("[data-delete]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            void command("delete_model", { id: b.dataset.delete })),
      );
    content
      .querySelectorAll<HTMLButtonElement>("[data-download]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            void command("download_model", { id: b.dataset.download })),
      );
    content
      .querySelectorAll<HTMLButtonElement>("[data-select]")
      .forEach(
        (b) => (b.onclick = () => void preference("model", b.dataset.select)),
      );
    content
      .querySelector("[data-cancel-download]")
      ?.addEventListener("click", () => void command("cancel_download"));
    content
      .querySelector("#show-models")!
      .addEventListener("click", () => void command("show_models_folder"));
  } else if (tab === "snippets") {
    content.innerHTML = `<form id="snippet-form">${section(t("Snippets"), `<div id="snippets">${p.snippets.length ? p.snippets.map(snippetRow).join("") : `<p id="empty-snippets" class="secondary">${esc(t("No snippets yet. For example, say “my YouTube link” to insert a URL instead."))}</p>`}</div>`, t("Matching ignores letter case, hyphens, and trailing punctuation."))}${section("", `<button type="button" id="add-snippet">${esc(t("Add snippet"))}</button><div class="edit-actions" id="snippet-actions" hidden><button type="submit">${esc(t("Save snippets"))}</button><button type="button" data-discard>${esc(t("Discard"))}</button></div>`)}</form>`;
    const mark = () => {
      dirty = true;
      document.querySelector<HTMLElement>("#snippet-actions")!.hidden = false;
    };
    const bindRemove = () =>
      document.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach(
        (b) =>
          (b.onclick = () => {
            b.closest(".snippet-row")!.remove();
            mark();
          }),
      );
    bindRemove();
    const form = document.querySelector<HTMLFormElement>("#snippet-form")!;
    form.oninput = mark;
    document.querySelector("#add-snippet")!.addEventListener("click", () => {
      document.querySelector("#empty-snippets")?.remove();
      document
        .querySelector("#snippets")!
        .insertAdjacentHTML("beforeend", snippetRow());
      bindRemove();
      mark();
    });
    form.onsubmit = async (event) => {
      event.preventDefault();
      const snippets = Array.from(
        form.querySelectorAll<HTMLElement>(".snippet-row"),
      ).map((r) => ({
        id: r.dataset.id!,
        trigger: r.querySelector<HTMLInputElement>("[name=trigger]")!.value,
        expansion:
          r.querySelector<HTMLTextAreaElement>("[name=expansion]")!.value,
        enabled: r.querySelector<HTMLInputElement>("[name=enabled]")!.checked,
      }));
      if (
        await savePreferences({ snippets })
      ) {
        dirty = false;
        render();
      }
    };
  } else if (tab === "history") {
    content.innerHTML =
      section(
        "",
        toggle(
          t("Save the last 20 dictations locally"),
          "keep_history",
          p.keep_history,
        ),
      ) +
      section(
        t("Recent dictations"),
        state.history.length
          ? state.history
              .map(
                (text, i) =>
                  `<div class="history-row"><p>${esc(text)}</p><button data-copy="${i}" aria-label="${esc(t("Copy dictation"))}">${esc(t("Copy"))}</button></div>`,
              )
              .join("")
          : `<div class="empty-state">${symbol(microphoneIcon)}<strong>${esc(t("Your next thought belongs here."))}</strong><p>${esc(t("Start a dictation and your words will appear here."))}</p></div>`,
      ) +
      (state.transcript_preview_omitted || (!p.keep_history && state.transcript)
        ? section(
            t("Latest transcript"),
            `<p class="transcript">${esc(state.transcript_preview_omitted ? t("The complete transcript is available with Copy; its preview is too large.") : state.transcript)}</p><button id="copy-latest">${esc(t("Copy"))}</button>`,
            p.keep_history ? t("Saved in the transcripts folder.") : t("Kept in memory only while this app is running."),
          )
        : "") +
      (state.history.length || state.transcript
        ? section(
            "",
            `<button id="clear-history" class="destructive">${esc(t("Clear history"))}</button>`,
          )
        : "");
    content
      .querySelectorAll<HTMLButtonElement>("[data-copy]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            void command("copy_history", { index: Number(b.dataset.copy) })),
      );
    content
      .querySelector("#copy-latest")
      ?.addEventListener("click", () => void command("copy_transcript"));
    content
      .querySelector("#clear-history")
      ?.addEventListener("click", () => void command("clear_history"));
  } else {
    content.innerHTML =
      section(
        "",
        `<div class="about-brand"><img src="./app-icon.png" width="88" height="88" alt="${esc(t("OpenWhisper app icon"))}"><div><span class="page-eyebrow">${esc(t("LESS TYPING. MORE YOU."))}</span><h1>OpenWhisper</h1><p class="version-badge">Version ` +
          esc(state.version) + (state.profile === "development" && state.development_build ? ` · Dev ${esc(state.development_build)}` : "") +
          (isMac() ? "" : " · " + t("Linux")) +
          `</p></div></div><p class="about-intro">${esc(t("A little more freedom for your voice."))}</p><p class="secondary">${esc(t("Turn your thoughts into text, right on your computer."))}</p><div class="about-values"><span>${esc(t("On-device recognition"))}</span><span>${esc(t("No subscription"))}</span><span>${esc(t("Open source · MIT"))}</span></div><p class="engine-credit">${esc(t("Powered by whisper.cpp, OpenAI Whisper, and NVIDIA Parakeet."))}</p>`,
      ) +
      section(
        t("Updates"),
        state.updates.configured
          ? toggle(t("Automatically check for updates (once a day)"), "auto_check_updates", !!p.auto_check_updates) +
            row(updateStatus(), `<button data-command="${state.updates.status === "available" ? "install_update" : "check_updates"}" ${["checking", "downloading", "installing"].includes(state.updates.status) || (state.updates.status === "available" && (["recording", "transcribing"].includes(state.status) || !!state.download || !!state.recovery_available)) ? "disabled" : ""}>${state.updates.status === "available" ? t("Download & install") : t("Check now")}</button>`)
          : `<p class="secondary">${esc(t("Updates are not configured in this build."))}</p>`,
        state.updates.package === "deb"
          ? t("Updates are verified before installation. Your system asks for administrator permission. OpenWhisper restarts afterward.")
          : t("Updates are verified before installation. OpenWhisper restarts afterward; your settings and models are kept."),
      ) +
      (isMac()
        ? ""
        : section(
            t("Linux support"),
            `<p>${esc(state.desktop)} · ${esc(state.session)}</p><p class="secondary">${esc(t("CachyOS with KDE Plasma on Wayland is the first test target. Other distributions and desktops require separate validation. See the README support matrix."))}</p>`,
          ));
  }
  main.scrollTop = scrollTop;
  content
    .querySelectorAll<HTMLButtonElement>("[data-command]")
    .forEach((b) => (b.onclick = () => void command(b.dataset.command!)));
  content.querySelectorAll<HTMLButtonElement>("[data-goto]").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.goto as Tab;
        render();
      }),
  );
  content
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-pref]")
    .forEach(
      (input) =>
        (input.onchange = () => {
          const value =
            input instanceof HTMLInputElement && input.type === "checkbox"
              ? input.checked
              : input.dataset.pref === "hold_to_record"
                ? input.value === "true"
                : input.value;
          void preference(input.dataset.pref!, value);
        }),
    );
  content.querySelectorAll<HTMLButtonElement>("[data-portal]").forEach(
    (button) =>
      (button.onclick = async () => {
        const action = button.dataset.portal!;
        portalBusy = true;
        render();
        try {
          await command(action);
        } finally {
          portalBusy = false;
          render();
        }
      }),
  );
  content.querySelectorAll("[data-discard]").forEach((b) =>
    b.addEventListener("click", () => {
      dirty = false;
      render();
    }),
  );
}
function nativePaste() { return !isMac() && !!state.native_paste && !state.paste_portal; }
function pasteAvailable() { return state.paste_portal || !!state.native_paste; }
function permissionButton() {
  const pending = !isMac() && state.paste_configuring;
  return `<button data-portal="${state.paste_ready || pending ? "disable_paste" : "enable_paste"}" ${!pasteAvailable() || portalBusy ? "disabled" : ""}>${pending ? t("Cancel") : state.paste_ready ? (isMac() ? t("System Settings") : t("Revoke")) : t("Allow")}</button>`;
}
function updateStatus() {
  const u = state.updates;
  switch (u.status) {
    case "checking": return t("Checking for updates …");
    case "current": return t("You have the latest version.");
    case "available": return t("Version {version} is available.", { version: u.version ?? "" });
    case "downloading": return t("Downloading update: {progress}%", { progress: Math.round(u.progress * 100) });
    case "installing": return t("Verifying and installing update …");
    case "error": return esc(t("Update failed: {error}", { error: t(u.error ?? "Unknown error") }));
    default: return t("Not checked yet.");
  }
}

function modifierOnlyTrigger() {
  const trigger = state.preferences.native_trigger;
  return !isMac() && !state.native_x11 && !!state.native_shortcuts && trigger?.kind === "key" && (trigger.key & 0x01ffffff) >= 0x01000020 && (trigger.key & 0x01ffffff) <= 0x01000023;
}
function triggerLabel() {
  const trigger = state.preferences.native_trigger;
  if (!isMac() && !state.native_x11 && state.native_shortcuts && trigger?.kind === "mouse") {
    if (trigger.button === 2) return t("Middle mouse button");
    if (trigger.button === 8) return t("Mouse back button");
    if (trigger.button === 9) return t("Mouse forward button");
    return t("Mouse button {number}", { number: String(trigger.button - 4) });
  }
  return state.shortcut ?? t("Set trigger …");
}
function triggerHelp() {
  if (macToggleOnly()) return t("Use a regular key or shortcut. Fn and mouse triggers are not available in this build.");
  if (state.native_x11) return t("Choose a regular keyboard key or shortcut. X11 reserves the selected key while OpenWhisper is running. Existing shortcuts are not replaced.");
  if (state.native_mouse) return t("Choose a single key, shortcut, or mouse button. The selected trigger is reserved for dictation while OpenWhisper is running.");
  if (state.native_shortcuts) return t("Choose a single key or shortcut. Direct mouse triggers require KDE Plasma 6 on Wayland.");
  return t("Your desktop controls which shortcuts are allowed. Direct mouse triggers currently require KDE Plasma 6 on Wayland.");
}

function shortcutButton() {
  if (state.shortcut_configuring)
    return `<span class="secondary" role="status">${esc(t("Choose a shortcut in your desktop’s dialog."))}</span> <button data-command="cancel_shortcut">${esc(t("Cancel"))}</button>`;
  if (isMac() && state.macos!.recording_shortcut)
    return `<span class="secondary">${esc(t(state.macos!.shortcut_hint))}</span> <button data-command="cancel_shortcut">${esc(t("Cancel"))}</button>`;
  if (!isMac() && state.recording_shortcut)
    return `<span class="secondary" role="status">${esc(t(state.native_x11 || !state.native_mouse ? "Press and release a keyboard key. Escape cancels." : "Press and release a key or mouse button. Escape cancels."))}</span> <button data-command="cancel_shortcut">${esc(t("Cancel"))}</button>`;
  const busy = portalBusy || ["recording", "transcribing"].includes(state.status) || ["downloading", "installing"].includes(state.updates.status);
  const select = `<button data-portal="enable_shortcut" ${(!state.shortcut_portal && !state.native_shortcuts) || busy ? "disabled" : ""}>${state.shortcut ? esc(triggerLabel()) : t("Set trigger …")}</button>`;
  if (isMac() && !macToggleOnly()) return select;
  return `<div class="trigger-controls">${select}${state.shortcut || state.preferences.native_trigger || state.preferences.x11_trigger || state.preferences.macos_shortcut ? ` <button data-portal="clear_shortcut" ${busy ? "disabled" : ""}>${esc(t("Remove trigger"))}</button>` : ""}${state.native_shortcuts && state.shortcut_portal ? ` <button class="quiet" data-portal="desktop_shortcut" ${busy ? "disabled" : ""}>${esc(t("Desktop shortcut dialog"))}</button>` : ""}</div>`;
}

// Explicit native setup must not activate focused buttons or edit settings.
for (const name of ["keydown", "keyup"] as const) window.addEventListener(name, (event) => {
  if (state?.recording_shortcut) event.preventDefault();
}, { capture: true });
function snippetRow(s?: Snippet) {
  return `<div class="snippet-row" data-id="${esc(s?.id ?? crypto.randomUUID())}"><input class="switch" type="checkbox" name="enabled" aria-label="${esc(t("Enable snippet"))}" ${!s || s.enabled ? "checked" : ""}><input name="trigger" aria-label="${esc(t("When I say"))}" placeholder="${esc(t("When I say …"))}" value="${esc(s?.trigger ?? "")}" maxlength="128"><span>→</span><textarea name="expansion" aria-label="${esc(t("Insert"))}" placeholder="${esc(t("… insert"))}" rows="2">${esc(s?.expansion ?? "")}</textarea><button type="button" data-remove aria-label="${esc(t("Remove snippet"))}">×</button></div>`;
}

async function start() {
  try {
    await listen("navigate", (event) => {
      if (tabs.some(([id]) => id === event.payload)) {
        tab = event.payload;
        dirty = false;
        contentKey = "";
        render();
      }
    });
    await listen("state", (event) => {
      state = event.payload;
      render();
    });
    state = await invoke("get_state");
    if (!state.preferences.setup_completed) tab = "setup";
    else if (state.initial_tab && tabs.some(([id]) => id === state.initial_tab))
      tab = state.initial_tab === "setup" ? "general" : state.initial_tab;
    render();
    document.documentElement.dataset.ready = "true";
  } catch (error) {
    notice(t("Could not connect to the desktop backend: {error}", { error: String(error) }));
  }
}
void start();

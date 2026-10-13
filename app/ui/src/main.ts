import { recordingUnavailableTitle } from "../../src/contracts/ui/recording-guidance.js";
import { invoke, listen } from "./bridge";
import { setLocale, t } from "./i18n";
import { escapeHtml as esc } from "./escape-html";
import { LiveWaveform } from "./live-waveform";
import "./style.css";
import {
  preferencePatchSchema,
  isCurrentRecordingTelemetry,
  validateCommandName,
  validateCommandInput,
  type AppState as State,
  type Preferences,
  type PreferencePatch,
  type Tab,
  type Model,
  type Snippet,
  type VocabEntry,
  vocabularyEntryKey,
  vocabularyMatchKey,
} from "../../src/contracts/ui/state.js";
import type {
  BuiltinTextProvider,
  CustomCliConnection,
  TextConnectionSettings,
} from "../../src/contracts/text/connections.js";
import { SettingsAutosave, type SettingsSaveStatus } from "./settings-autosave";
import { createAiModelsSettings } from "./settings/ai-models";
import { aiRevisionMarkup, bindAiRevision } from "./settings/ai-revision";

let state: State;
type View =
  Tab | "dictation" | "recording" | "text" | "connections" | "permissions";
let tab: View = "dictation";
let snippetDraft: Snippet[] | undefined;
let snippetRevision = 0;
let portalBusy = false;
let pendingInsertOutput = false;
let insertPermissionActionPending = false;
let insertPermissionSawConfiguring = false;
let contentKey = "";
let workspaceKey = "";
let shellKey = "";
let renderedTab: View | undefined;
// The setup card body scrolls; keep its position when the same step re-renders (for example on download progress).
let renderedSetupStep: number | undefined;
let historyRailOpen = true;
let mainWaveform: LiveWaveform | undefined;
let overlayWaveform: LiveWaveform | undefined;
let selectedHistoryIndex: number | null = null;
let observedHistorySnapshot: string | undefined;
let observedTranscript: string | undefined;
let dismissedTranscriptValue: string | undefined;
let dismissedTranscriptGeneration: number | undefined;
let modelDrawerFamily: "parakeet" | "whisper" = "parakeet";
let modelDialogOpener: HTMLElement | null = null;
let settingsDialogOpener: HTMLElement | null = null;
let updateDialogOpener: HTMLElement | null = null;
let pendingSettingsSection = "";
let modelDialogKey = "";
let modelFocusRestorePending = false;
let setupStep = -1;
// Apple Silicon builds offer Metal; Intel Macs recognize on the CPU only, so there is nothing to choose.
const setupHasHardwareStep = () =>
  state.platform !== "macos" || state.gpu_supported === true;
const setupStepCount = () => (setupHasHardwareStep() ? 7 : 6);
const setupModelStep = () => (setupHasHardwareStep() ? 1 : 0);
let focusSetupTitle = false;
const expandedModelFamilies = new Set<string>();
let preferenceQueue = Promise.resolve();
let pendingPreferences = 0;
let conversationInstructionDraft: string | undefined;
let pendingConnectionSettings: TextConnectionSettings | undefined;
let connectionScanStarted = false;
let mouseTriggerCandidate: number | undefined;
let settingsSaveStatus: SettingsSaveStatus = "idle";
const settingsAutosave = new SettingsAutosave({
  onState: ({ status }) => {
    settingsSaveStatus = status;
    updateSettingsSaveStatus();
    if (status === "saved" || status === "idle") render();
  },
});
const aiModelsSettings = createAiModelsSettings({
  getSnapshot: () => ({
    available: state.text_connections.available,
    scanning: state.text_connections.scanning,
    busy:
      state.status === "recording" ||
      state.status === "transcribing" ||
      state.text_connections.processing.status === "processing",
  }),
  getSettings: latestConnectionSettings,
  saveSettings: saveConnections,
  scan: () => void scanConnections(),
  startLmStudio: () => void startLmStudioServer(),
  requestRender: () => {
    contentKey = "";
    render();
  },
  notice,
});
const app = document.querySelector<HTMLDivElement>("#app")!;
const overlay =
  new URLSearchParams(location.search).has("overlay") ||
  (window as Window & { __OPENWHISPER_OVERLAY__?: boolean })
    .__OPENWHISPER_OVERLAY__ === true;
document.documentElement.classList.toggle("overlay", overlay);
app.innerHTML = '<div id="notice" role="alert" hidden></div>';
const option = (value: string, label: string, selected: string) =>
  `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
const modelRecommendations = () =>
  state.recommended_models ?? state.macos?.recommended ?? [];
const hasInstalledSelectedModel = () =>
  state.installed.includes(state.preferences.model);
const tabs: [View, string, string][] = [
  ["dictation", "Dictation", "M12 3v10m0 0 4-4m-4 4-4-4M5 19h14"],
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
  ["text", "Text processing", "M3 5h18M3 10h12M3 15h9M3 20h9m6-6v8m-4-4h8"],
  ["connections", "AI models", "M4 7h16M4 12h16M4 17h16M8 4v6m8 0v4m-8 0v6"],
  ["history", "History", "M4 8a9 9 0 1 1-1 7M4 3v5h5m3-1v5l4 2"],
  ["about", "About", "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6m0-10v1"],
];
const symbol = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const wordmark = () =>
  `<span class="window-wordmark"><span>open</span><span>whisper</span></span>`;
function windowTitlebar(): string {
  if (overlay) return "";
  const dev =
    state.profile === "development"
      ? `<span class="window-dev-badge">Dev</span>`
      : "";
  const setup = !state.preferences.setup_completed;
  const model = state.models.find(
    (candidate) => candidate.id === state.preferences.model,
  );
  const dotState = windowTabStatus();
  const tabChrome = setup
    ? `<span class="window-dictation-title">${esc(t("Setup"))}</span>`
    : `<div class="window-titlebar-tabs"><div class="window-active-tab" aria-current="page"><span class="window-tab-status ${dotState}" aria-hidden="true"></span><span class="window-tab-copy"><span class="window-tab-title">${esc(t("Dictation"))}</span><span class="window-tab-subtitle">${esc(model?.title ?? t("Choose a model"))}</span></span></div></div>`;
  return `<header class="window-titlebar"><div class="window-titlebar-brand"><img src="./branding/icon-bordered.svg" width="24" height="24" alt="">${wordmark()}${dev}</div>${tabChrome}${setup ? "" : `<div class="window-titlebar-actions"><span class="local-recognition-badge">${esc(t("Local recognition"))}</span><button type="button" id="header-update" aria-live="polite" hidden></button><button type="button" id="open-settings">${symbol("M12 8a4 4 0 1 0 0 8 4 4 0 0 0-4-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2")}${esc(t("Settings"))}</button></div>`}<div class="window-actions"><button data-window-action="minimize" aria-label="${esc(t("Minimize window"))}" title="${esc(t("Minimize window"))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11.5h10"/></svg></button><button data-window-action="maximize" aria-label="${esc(t("Maximize or restore window"))}" title="${esc(t("Maximize or restore window"))}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg></button><button class="window-close" data-window-action="close" aria-label="${esc(t("Close window"))}" title="${esc(t("Close window"))}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></div></header>`;
}
function windowTabStatus(): string {
  return state.status === "recording"
    ? "recording"
    : state.status === "transcribing"
      ? "processing"
      : state.recording_available === false
        ? "unavailable"
        : "ready";
}
function syncWindowTitlebar() {
  const dot = document.querySelector<HTMLElement>(".window-tab-status");
  const subtitle = document.querySelector<HTMLElement>(".window-tab-subtitle");
  if (dot && subtitle) {
    dot.className = `window-tab-status ${windowTabStatus()}`;
    const model = state.models.find(
      (candidate) => candidate.id === state.preferences.model,
    );
    subtitle.textContent = model?.title ?? t("Choose a model");
  }
  const updateButton =
    document.querySelector<HTMLButtonElement>("#header-update");
  if (updateButton) {
    updateButton.hidden =
      !state.updates.configured ||
      (![
        "available",
        "downloading",
        "verifying",
        "ready",
        "installing",
      ].includes(state.updates.status) &&
        !(state.updates.status === "checking" && !!state.updates.version) &&
        !(state.updates.status === "error" && !!state.updates.version));
    if (!state.updates.configured) return;
    updateButton.dataset.status = state.updates.status;
    updateButton.innerHTML = `${symbol("M12 3v12m0 0 5-5m-5 5-5-5M5 21h14")}<span>${esc(updateButtonLabel())}</span>`;
    updateButton.title = updateStatus();
    updateButton.setAttribute(
      "aria-label",
      t("Updates: {status}", { status: updateStatus() }),
    );
    updateButton.disabled = false;
    updateButton.onclick = () => openUpdateDialog(updateButton);
  }
}
function updateKicker() {
  switch (state.updates.status) {
    case "available":
      return t("Update available");
    case "checking":
      return t("Checking for updates …");
    case "current":
      return t("Up to date");
    case "downloading":
      return t("Downloading update");
    case "verifying":
      return t("Verifying update …");
    case "ready":
      return t("Update ready to install");
    case "installing":
      return t("Installing update");
    case "error":
      return t("Update error");
    default:
      return t("Updates");
  }
}
function updateInstallBlockReason(): string {
  if (settingsSaveStatus === "saving" || settingsSaveStatus === "error")
    return t("Finish saving settings before installing an update.");
  if (!state.preferences.setup_completed)
    return t("Finish setup before installing an update.");
  if (state.recovery_available)
    return t(
      "Resolve or discard the saved recording before installing an update.",
    );
  if (["recording", "transcribing"].includes(state.status))
    return t("Finish the current recording before installing an update.");
  if (state.download)
    return t(
      "Wait for the model download to finish before installing an update.",
    );
  if (
    state.shortcut_configuring ||
    state.recording_shortcut ||
    state.macos?.recording_shortcut === true ||
    state.paste_configuring ||
    portalBusy
  )
    return t(
      "Finish the permission or shortcut setup before installing an update.",
    );
  return "";
}
function canInstallUpdate() {
  return (
    state.updates.configured &&
    state.updates.status === "ready" &&
    !!state.updates.version &&
    !updateInstallBlockReason()
  );
}
function openUpdateDialog(opener: HTMLElement) {
  const dialog = document.querySelector<HTMLDialogElement>("#update-dialog");
  if (!dialog || !state.updates.configured) return;
  updateDialogOpener = opener;
  syncUpdateDialog();
  if (!dialog.open) dialog.showModal();
  const action = dialog.querySelector<HTMLButtonElement>("#update-main-action");
  if (action && !action.hidden && !action.disabled) action.focus();
  else dialog.querySelector<HTMLButtonElement>("#update-later")?.focus();
}
function formatUpdateSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const locale = state.preferences.ui_language === "de" ? "de-DE" : "en-US";
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}
function syncUpdateDialog() {
  const dialog = document.querySelector<HTMLDialogElement>("#update-dialog");
  if (!dialog) return;
  const update = state.updates;
  dialog.dataset.status = update.status;
  dialog.setAttribute(
    "aria-busy",
    String(
      ["checking", "downloading", "verifying", "installing"].includes(
        update.status,
      ),
    ),
  );
  const status = dialog.querySelector<HTMLElement>("#update-dialog-status");
  const version = dialog.querySelector<HTMLElement>("#update-dialog-version");
  const installed = dialog.querySelector<HTMLElement>(
    "#update-dialog-installed",
  );
  const message = dialog.querySelector<HTMLElement>("#update-dialog-message");
  const notes = dialog.querySelector<HTMLElement>("#update-dialog-highlights");
  const notesLanguage = dialog.querySelector<HTMLElement>(
    "#update-dialog-notes-language",
  );
  const releaseLink = dialog.querySelector<HTMLButtonElement>(
    "#update-release-link",
  );
  const progress = dialog.querySelector<HTMLElement>("#update-dialog-progress");
  const progressBar = dialog.querySelector<HTMLProgressElement>(
    "#update-progress-bar",
  );
  const progressLabel = dialog.querySelector<HTMLElement>(
    "#update-progress-label",
  );
  const hint = dialog.querySelector<HTMLElement>("#update-dialog-hint");
  const action = dialog.querySelector<HTMLButtonElement>("#update-main-action");
  if (status) status.textContent = updateKicker();
  if (version)
    version.textContent = update.version
      ? t("Version {version}", { version: update.version })
      : t("Updates");
  if (installed) {
    installed.textContent = `${t("Installed: {version}", { version: state.version })}${update.details?.size ? ` · ${t("Download size: {size}", { size: formatUpdateSize(update.details.size) })}` : ""}`;
  }
  if (message) {
    message.textContent = updateStatus();
    message.className =
      update.status === "error" ? "update-dialog-message" : "visually-hidden";
  }
  if (notes) {
    const language = state.preferences.ui_language;
    const localized = update.details?.localized_highlights?.[language];
    const highlights = localized?.length
      ? localized
      : (update.details?.highlights ?? []);
    if (notesLanguage) {
      const usingEnglishFallback =
        language === "de" && !localized?.length && highlights.length > 0;
      notesLanguage.textContent = usingEnglishFallback
        ? t("Release notes are shown in English.")
        : "";
      notesLanguage.hidden = !usingEnglishFallback;
    }
    notes.replaceChildren(
      ...(highlights.length
        ? highlights.map((text) => {
            const item = document.createElement("li");
            item.textContent = text;
            return item;
          })
        : [
            (() => {
              const item = document.createElement("li");
              item.textContent = t(
                "No release notes are available for this version.",
              );
              return item;
            })(),
          ]),
    );
  }
  if (releaseLink)
    releaseLink.hidden =
      !update.version ||
      ![
        "available",
        "downloading",
        "verifying",
        "ready",
        "installing",
        "error",
      ].includes(update.status);
  const downloading = update.status === "downloading";
  const showingProgress = downloading || update.status === "verifying";
  if (progress) progress.hidden = !showingProgress;
  if (progressBar) {
    const transfer = update.download;
    if (downloading && transfer?.total && transfer.total > 0) {
      progressBar.max = transfer.total;
      progressBar.value = Math.min(transfer.received, transfer.total);
    } else if (showingProgress) {
      progressBar.removeAttribute("value");
    } else {
      progressBar.max = 1;
      progressBar.value = 0;
    }
    progressBar.setAttribute(
      "aria-label",
      t(downloading ? "Downloading update" : "Verifying update …"),
    );
  }
  if (progressLabel) {
    if (downloading) {
      const received = formatUpdateSize(update.download?.received ?? 0);
      const total = update.download?.total;
      progressLabel.textContent =
        total && total > 0
          ? t("Downloaded {received} of {total}", {
              received,
              total: formatUpdateSize(total),
            })
          : t("Downloaded {received}", { received });
    } else if (update.status === "verifying") {
      progressLabel.textContent = t("Verifying update …");
    } else {
      progressLabel.textContent = "";
    }
  }
  if (hint) {
    hint.textContent =
      update.status === "available"
        ? t("Ready to download this update.")
        : update.status === "ready"
          ? updateInstallBlockReason() ||
            t("Install the downloaded update and restart now, or choose Later.")
          : ["downloading", "verifying", "installing"].includes(update.status)
            ? t("The update continues when you close this window.")
            : "";
  }
  if (action) {
    const actionWasFocused = document.activeElement === action;
    const available =
      update.status === "available" ||
      (update.status === "error" && !!update.version && update.configured);
    const ready = update.status === "ready";
    action.hidden = !available && !ready;
    action.disabled =
      (available && !update.configured) || (ready && !canInstallUpdate());
    action.textContent = ready ? t("Restart now") : t("Download");
    action.setAttribute(
      "aria-label",
      ready ? t("Install and restart now") : t("Download"),
    );
    if (actionWasFocused && (action.hidden || action.disabled))
      dialog.querySelector<HTMLButtonElement>("#update-later")?.focus();
  }
}
function syncAboutUpdates() {
  const status = document.querySelector<HTMLElement>("#about-update-status");
  if (!status) return;
  status.dataset.status = state.updates.status;
  status.textContent = state.updates.configured
    ? updateStatus()
    : t("Updates are not configured in this installation.");
  const dot = document.querySelector<HTMLElement>("#about-update-dot");
  if (dot) dot.dataset.status = state.updates.status;
  const summary = document.querySelector<HTMLElement>("#about-update-summary");
  if (summary) {
    const text =
      ["available", "ready"].includes(state.updates.status) &&
      state.updates.details?.size
        ? t("Download size: {size}", {
            size: formatUpdateSize(state.updates.details.size),
          })
        : "";
    summary.textContent = text;
    summary.hidden = !text;
  }
  const action = document.querySelector<HTMLButtonElement>(
    "#about-update-action",
  );
  const automatic = document.querySelector<HTMLElement>("#about-auto-updates");
  if (action) {
    action.hidden = !state.updates.configured;
    action.dataset.status = state.updates.status;
    const detailState =
      ["available", "downloading", "verifying", "ready", "installing"].includes(
        state.updates.status,
      ) ||
      (state.updates.status === "checking" && !!state.updates.version) ||
      (state.updates.status === "error" && !!state.updates.version);
    action.textContent =
      state.updates.status === "checking"
        ? t("Checking")
        : detailState
          ? t("Details")
          : t("Check for updates");
    action.disabled = state.updates.status === "checking";
  }
  if (automatic) automatic.hidden = !state.updates.configured;
}
const section = (title: string, body: string, note = "", id = "") =>
  `<section${id ? ` id="${id}"` : ""}>${title ? `<h2>${title}</h2>` : ""}<div class="group">${body}</div>${note ? `<p class="section-note">${note}</p>` : ""}</section>`;
const row = (label: string, control: string) =>
  `<div class="row"><span>${label}</span><div class="control">${control}</div></div>`;
const toggle = (
  label: string,
  name: string,
  checked: boolean,
  disabled = false,
) =>
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
/** GPU wording follows the platform API: Vulkan on Linux, Metal on Apple Silicon. */
const gpuText = (key: string) =>
  isMac() ? key.replaceAll("Vulkan", "Metal") : key;
/** Intel Macs (and builds without Metal) only recognize on the CPU; there is no mode to choose. */
const macCpuOnly = () => isMac() && state.gpu_supported !== true;
const macToggleOnly = () =>
  isMac() && state.macos?.shortcut_toggle_only === true;
const microphoneControl = () => {
  const labels = new Map(
    (state.microphone_labels ?? []).map(({ id, name }) => [id, name]),
  );
  return `<select class="microphone-select" data-pref="microphone" aria-label="${esc(t("Microphone"))}">${option("", t("System default"), state.preferences.microphone)}${state.microphones.map((id) => option(id, labels.get(id) ?? id, state.preferences.microphone)).join("")}</select>`;
};
function modelRow(m: Model, compact = false): string {
  const installed = state.installed.includes(m.id),
    selected = state.preferences.model === m.id && installed,
    downloading = state.download === m.id;
  const recommended = modelRecommendations().includes(m.id);
  return `<div class="model-row ${selected ? "active-model" : ""}" data-model-id="${esc(m.id)}" title="${esc(t(m.note))}"${compact ? ' data-compact="true"' : ""}><button class="model-radio" aria-label="${esc(t("Use {model}", { model: m.title }))}" aria-pressed="${selected}" data-select="${esc(m.id)}" ${!installed ? "disabled" : ""}><span></span></button><div class="model-description"><div class="model-title-row"><strong>${esc(m.title)}</strong>${recommended ? `<span class="recommendation">${esc(t("Starting recommendation"))}</span>` : ""}</div><span class="model-size">${esc(m.size)}</span><p class="model-note">${esc(t(m.note))}</p></div><div class="model-buttons">${downloading ? `<progress aria-label="${esc(t("Download progress"))}" value="${state.progress}" max="1"></progress><button data-cancel-download>${esc(t("Cancel"))}</button>` : installed ? `${selected ? `<span class="success">${esc(t("Active"))}</span>` : `<button data-select="${esc(m.id)}">${esc(t("Use"))}</button>`}` : `<button data-download="${esc(m.id)}" ${state.download || ["downloading", "installing"].includes(state.updates.status) ? "disabled" : ""}>${esc(t("Download"))}</button>`}${installed && isMac() ? `<button data-delete="${esc(m.id)}" aria-label="${esc(t("Delete {model}", { model: m.title }))}" class="destructive">×</button>` : ""}</div></div>`;
}
function modelDialogMarkup(): string {
  const families = [
    ["parakeet", "Parakeet"],
    ["whisper", "Whisper"],
  ] as const;
  const models = state.models.filter(
    (model) => model.family === modelDrawerFamily,
  );
  return `<div class="model-drawer-shell"><header class="model-drawer-heading" title="${esc(t("Current recognition device: {device}", { device: recognitionHardwareStatus() }))}"><div class="model-drawer-heading-top"><div><h2 id="model-drawer-title">${esc(t("Speech model for Dictation"))}</h2><p class="model-drawer-subtitle">${esc(t("Dictation"))}</p></div><button type="button" id="close-model-drawer" class="settings-close" data-close-model-drawer aria-label="${esc(t("Close"))}">${symbol("M6 6l12 12M18 6 6 18")}</button></div><div class="model-drawer-families" role="group" aria-label="${esc(t("Model family"))}">${families.map(([family, label]) => `<button type="button" aria-pressed="${modelDrawerFamily === family}" data-drawer-family="${family}">${esc(t(label))}</button>`).join("")}</div></header><div id="model-drawer-notice" role="alert" hidden></div><div class="model-drawer-body">${models.map((model) => modelRow(model, true)).join("")}</div><footer class="model-drawer-footer">${isMac() ? `<button type="button" data-model-command="import_model">${esc(t("Import a model …"))}</button>` : ""}<button type="button" data-model-command="show_models_folder">${esc(t("Show in file manager"))}</button></footer></div>`;
}
function modelDialogSemanticKey(): string {
  return JSON.stringify([
    state.models,
    modelRecommendations(),
    state.installed,
    state.preferences.model,
    state.download,
    state.updates.status,
    state.preferences.gpu,
    state.gpu_supported,
    state.gpu_checked,
    state.gpu_available,
    state.gpu_device,
    state.cpu_device,
    state.gpu_fallback,
    modelDrawerFamily,
  ]);
}
function updateDialogProgress() {
  const progress = document.querySelector<HTMLProgressElement>(
    "#model-drawer progress",
  );
  if (progress) progress.value = state.progress;
}
function syncModelDialog(force = false) {
  const dialog = document.querySelector<HTMLDialogElement>("#model-drawer");
  if (!dialog || (!dialog.open && !force)) return;
  const key = modelDialogSemanticKey();
  if (!force && key === modelDialogKey) {
    updateDialogProgress();
    return;
  }
  const active = document.activeElement;
  const activeButton =
    active instanceof HTMLButtonElement && dialog.contains(active)
      ? active
      : null;
  const modelRow = activeButton?.closest<HTMLElement>(".model-row");
  const modelId = activeButton?.dataset.select ?? modelRow?.dataset.modelId;
  const wasRadio = activeButton?.classList.contains("model-radio") ?? false;
  const commandName = activeButton?.dataset.modelCommand;
  const wasClose = activeButton?.id === "close-model-drawer";
  const family = activeButton?.dataset.drawerFamily;
  modelDialogKey = key;
  dialog.innerHTML = modelDialogMarkup();
  bindModelActions(dialog, true);
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-drawer-family]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        modelDrawerFamily = button.dataset.drawerFamily as
          "parakeet" | "whisper";
        modelDialogKey = "";
        syncModelDialog();
      }),
    );
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-close-model-drawer]")
    .forEach((button) =>
      button.addEventListener("click", () => void requestCloseModelDialog()),
    );
  let restore: HTMLButtonElement | undefined;
  if (wasClose)
    restore =
      dialog.querySelector<HTMLButtonElement>("#close-model-drawer") ??
      undefined;
  else if (family)
    restore =
      dialog.querySelector<HTMLButtonElement>(
        `[data-drawer-family="${family}"]`,
      ) ?? undefined;
  else if (commandName) {
    restore = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("[data-model-command]"),
    ).find((button) => button.dataset.modelCommand === commandName);
  } else if (modelId) {
    const row = Array.from(
      dialog.querySelectorAll<HTMLElement>(".model-row"),
    ).find((candidate) => candidate.dataset.modelId === modelId);
    restore = wasRadio
      ? (row?.querySelector<HTMLButtonElement>(".model-radio") ?? undefined)
      : (row?.querySelector<HTMLButtonElement>(
          "[data-cancel-download], [data-download]",
        ) ??
        Array.from(
          row?.querySelectorAll<HTMLButtonElement>("[data-select]") ?? [],
        ).find((button) => !button.classList.contains("model-radio")) ??
        row?.querySelector<HTMLButtonElement>(".model-radio") ??
        undefined);
  }
  if (!restore || restore.disabled || restore.getClientRects().length === 0) {
    restore =
      dialog.querySelector<HTMLButtonElement>("#close-model-drawer") ??
      undefined;
  }
  if (restore && !restore.disabled) restore.focus();
}
function openModelDialog(opener: HTMLElement) {
  const dialog = document.querySelector<HTMLDialogElement>("#model-drawer");
  if (!dialog) return;
  modelDialogOpener = opener;
  const activeModel = state.models.find(
    (model) => model.id === state.preferences.model,
  );
  if (activeModel?.family === "parakeet" || activeModel?.family === "whisper")
    modelDrawerFamily = activeModel.family;
  modelDialogKey = "";
  syncModelDialog(true);
  if (!dialog.open) dialog.showModal();
  dialog.querySelector<HTMLButtonElement>("#close-model-drawer")?.focus();
}
function closeModelDialog() {
  const dialog = document.querySelector<HTMLDialogElement>("#model-drawer");
  if (dialog?.open) dialog.close();
}
async function requestCloseModelDialog() {
  if (await flushSettings()) closeModelDialog();
}
function restoreModelDialogFocus(dialog: HTMLDialogElement) {
  if (!dialog.isConnected || dialog.open) return;
  const opener = modelDialogOpener?.isConnected
    ? modelDialogOpener
    : document.querySelector<HTMLElement>(".dictation-change-model");
  if (!modelFocusRestorePending) opener?.focus();
  modelDialogOpener = null;
  modelDialogKey = "";
  const body = dialog.querySelector<HTMLElement>(".model-drawer-body");
  if (body) body.replaceChildren();
}
function historyRows(): string {
  return state.history
    .map((text, i) => {
      const selected = selectedHistoryIndex === i;
      return `<div class="history-row ${selected ? "selected" : ""}"><button type="button" class="history-entry" data-history-select="${i}" aria-pressed="${selected}" title="${esc(text)}"><span class="history-entry-text">${esc(text)}</span></button></div>`;
    })
    .join("");
}
function bindHistoryActions(root: ParentNode) {
  root
    .querySelector<HTMLButtonElement>("[data-clear-history]")
    ?.addEventListener("click", () => void command("clear_history"));
}
function bindModelActions(root: ParentNode, inDrawer = false) {
  const errorTarget = inDrawer
    ? () => {
        const dialog =
          document.querySelector<HTMLDialogElement>("#model-drawer");
        return dialog?.open
          ? dialog.querySelector<HTMLElement>("#model-drawer-notice")
          : null;
      }
    : undefined;
  root
    .querySelectorAll<HTMLButtonElement>("[data-delete]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          void command(
            "delete_model",
            { id: button.dataset.delete },
            errorTarget,
          )),
    );
  root
    .querySelectorAll<HTMLButtonElement>("[data-download]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          void command(
            "download_model",
            { id: button.dataset.download },
            errorTarget,
          )),
    );
  root
    .querySelectorAll<HTMLButtonElement>("[data-select]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          void savePreferences(
            preferencePatchSchema.parse({ model: button.dataset.select }),
            errorTarget,
          )),
    );
  root
    .querySelectorAll<HTMLButtonElement>("[data-cancel-download]")
    .forEach((button) =>
      button.addEventListener(
        "click",
        () => void command("cancel_download", undefined, errorTarget),
      ),
    );
  root
    .querySelectorAll<HTMLButtonElement>("[data-model-command]")
    .forEach((button) =>
      button.addEventListener(
        "click",
        () =>
          void command(button.dataset.modelCommand!, undefined, errorTarget),
      ),
    );
}
function recognitionHardwareStatus(): string {
  if (macCpuOnly()) return t("Native speech engine");
  const cpu = state.cpu_device ?? t("CPU");
  const gpu = state.gpu_device;
  if (state.gpu_fallback)
    return t("CPU selected after GPU fallback: {device}", { device: cpu });
  if (state.preferences.gpu && state.gpu_checked === false)
    return t("Checking GPU hardware …");
  if (state.preferences.gpu && state.gpu_supported === false)
    return t("GPU is selected, but this build uses the CPU: {device}", {
      device: cpu,
    });
  if (
    state.preferences.gpu &&
    state.gpu_available &&
    state.gpu_supported !== false
  )
    return t(gpuText("Vulkan GPU selected: {device}"), {
      device: gpu ?? t(gpuText("Vulkan GPU")),
    });
  if (state.preferences.gpu && !state.gpu_available)
    return t("GPU unavailable; using CPU: {device}", { device: cpu });
  if (state.gpu_available && gpu)
    return t(gpuText("CPU selected; Vulkan GPU available: {device}"), {
      device: gpu,
    });
  return t("CPU selected: {device}", { device: cpu });
}
function setupModelGroups(): string {
  return `<div class="setup-model-families">${(
    [
      ["whisper", "OpenAI Whisper"],
      ["parakeet", "NVIDIA Parakeet"],
    ] as const
  )
    .map(([family, label]) => {
      const models = state.models.filter((model) => model.family === family);
      const recommended = models.find((model) =>
        modelRecommendations().includes(model.id),
      );
      return `<details class="setup-model-family" data-model-family="${family}" ${expandedModelFamilies.has(family) ? "open" : ""}><summary><span class="setup-family-name">${esc(t(label))}<small>${esc(recognitionHardwareStatus())}</small>${recommended ? `<small>${esc(t("Starting recommendation: {model}", { model: recommended.title }))}</small>` : `<small>${esc(t("No starting recommendation is available."))}</small>`}</span><span class="setup-family-chevron" aria-hidden="true">⌄</span></summary><div class="setup-family-models">${models.map((model) => modelRow(model)).join("")}</div></details>`;
    })
    .join("")}</div>`;
}
const outputs = () =>
  `<div class="radio-group">${[
    ["paste", t("Paste at the cursor")],
    ["clipboard", t("Copy to clipboard only")],
  ]
    .map(
      ([v, l]) =>
        `<label><input type="radio" name="output" data-pref="output" value="${v}" ${effectiveOutput() === v ? "checked" : ""} ${v === "paste" && !accessibilityPermissionGranted() ? "disabled" : ""}>${l}</label>`,
    )
    .join("")}</div>`;
const settingOutputs = () => {
  const modes: [string, string, string][] = [
    ["paste", "Insert", "Paste at the cursor"],
    ["clipboard", "Copy", "Copy to clipboard only"],
  ];
  return `<fieldset class="settings-output-segment" aria-label="${esc(t("Output"))}">${modes.map(([value, label, fullLabel]) => `<label><input type="radio" name="settings-output" data-pref="output" value="${value}" aria-label="${esc(t(fullLabel))}" ${effectiveOutput() === value ? "checked" : ""} ><span>${esc(t(label))}</span></label>`).join("")}</fieldset>`;
};

function effectiveOutput(): string {
  return state.preferences.output === "paste" &&
    !accessibilityPermissionGranted()
    ? "clipboard"
    : state.preferences.output;
}
function microphonePermissionGranted(): boolean {
  if (isMac()) return state.macos?.microphone_allowed === true;
  return true;
}

function accessibilityPermissionGranted(): boolean {
  return state.paste_ready === true;
}

function missingPermissionCount(): number {
  return (
    Number(!microphonePermissionGranted()) +
    Number(pasteAvailable() && !accessibilityPermissionGranted())
  );
}

function microphonePermissionDetail(): string {
  if (state.macos?.microphone_permission === "not-determined")
    return t(
      "Microphone access has not been requested yet. Allow access to record.",
    );
  return t(
    "Allow microphone access in System Settings. If OpenWhisper is already enabled, remove it and allow it again.",
  );
}

function permissionBanner(): string {
  const banners: string[] = [];
  const reason =
    state.recording_available === false
      ? state.recording_unavailable_reason
      : undefined;
  if (reason || !microphonePermissionGranted()) {
    const microphone =
      reason === "permission" || (!reason && !microphonePermissionGranted());
    const title = microphone
      ? t("Microphone access is not allowed.")
      : recordingUnavailableMessage();
    const detail = microphone
      ? `<p>${esc(microphonePermissionDetail())}</p>`
      : "";
    const action = microphone
      ? `<button type="button" data-command="allow_microphone">${esc(t(state.macos?.microphone_permission === "not-determined" ? "Allow microphone access" : "System Settings"))}</button>`
      : reason === "model"
        ? `<button type="button" data-open-model-drawer>${esc(t("Open models"))}</button>`
        : reason === "audio"
          ? `<button type="button" data-settings-view="recording" data-settings-section="settings-recording-microphone">${esc(t("Microphone settings"))}</button>`
          : "";
    banners.push(
      `<div class="permission-banner permission-banner-warning" role="status"><span class="permission-dot" aria-hidden="true"></span><div><strong>${esc(title)}</strong>${detail}</div>${action}</div>`,
    );
  }
  if (
    !accessibilityPermissionGranted() &&
    state.preferences.output === "paste"
  ) {
    banners.push(
      `<div class="permission-banner permission-banner-accessibility" role="status"><span class="permission-dot" aria-hidden="true"></span><div><strong>${esc(t(isMac() ? "Accessibility access is missing" : "Automatic insertion is unavailable"))}</strong><p>${esc(t("Text is copied instead. Allow keyboard access to insert it automatically."))}</p></div><button type="button" data-settings-view="permissions">${esc(t("Grant permission"))}</button></div>`,
    );
  }
  return banners.join("");
}

function notice(text: string) {
  const el = document.querySelector<HTMLDialogElement>("#settings-dialog")?.open
    ? document.querySelector<HTMLElement>("#settings-notice")!
    : document.querySelector<HTMLElement>("#notice")!;
  const message = document.createElement("span");
  message.textContent = t(text);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "notice-close";
  close.setAttribute("aria-label", t("Close"));
  close.title = t("Close");
  close.addEventListener("click", () => {
    el.hidden = true;
    el.replaceChildren();
  });
  el.replaceChildren(message, close);
  el.hidden = false;
}
async function command(
  name: string,
  args?: Record<string, unknown>,
  errorTarget?: () => HTMLElement | null,
): Promise<boolean> {
  if (name === "complete_setup" && !hasInstalledSelectedModel()) {
    notice("Download and select a model to continue.");
    return false;
  }
  try {
    const command = validateCommandName(name);
    await invoke(command, validateCommandInput(command, args ?? {}));
    return true;
  } catch (error) {
    const target = errorTarget?.();
    if (target) {
      target.textContent = String(error);
      target.hidden = false;
    } else notice(String(error));
    return false;
  }
}
function enqueueWrite<T>(
  queue: Promise<void>,
  operation: () => Promise<T>,
): { result: Promise<T>; next: Promise<void> } {
  const result = queue.then(operation);
  return { result, next: result.then(() => {}) };
}
// Send only the edited fields. Serializing writes also keeps delayed host replies in order.
async function writePreferences(
  changes: PreferencePatch,
  errorTarget?: () => HTMLElement | null,
): Promise<boolean> {
  pendingPreferences++;
  document
    .querySelectorAll<HTMLButtonElement>(".setup-navigation button")
    .forEach((button) => (button.disabled = true));
  const saved = enqueueWrite(preferenceQueue, async () => {
    try {
      state = await invoke("save_preferences", { changes });
      return true;
    } catch (error) {
      const target = errorTarget?.();
      if (target) {
        target.textContent = String(error);
        target.hidden = false;
      } else notice(String(error));
      return false;
    } finally {
      pendingPreferences--;
      if (!pendingPreferences) {
        if (tab === "setup") contentKey = "";
        render();
      }
    }
  });
  preferenceQueue = saved.next;
  return saved.result;
}
async function savePreferences(
  changes: PreferencePatch,
  errorTarget?: () => HTMLElement | null,
): Promise<boolean> {
  if (tab === "setup" || tab === "dictation" || overlay)
    return writePreferences(changes, errorTarget);
  return settingsAutosave.save(
    `preferences:${Object.keys(changes).sort().join(",")}`,
    () => writePreferences(changes, errorTarget),
  );
}
async function preference(name: string, value: unknown) {
  return savePreferences(preferencePatchSchema.parse({ [name]: value }));
}
function updateSettingsSaveStatus() {
  const status = document.querySelector<HTMLElement>("#settings-save-status");
  if (!status) return;
  status.dataset.status = settingsSaveStatus;
  status.innerHTML =
    settingsSaveStatus === "error"
      ? `<button type="button" id="retry-settings-save">${esc(t("Not saved · Retry"))}</button>`
      : settingsSaveStatus === "idle"
        ? status.innerHTML
        : `<span aria-hidden="true">${settingsSaveStatus === "saving" ? "●" : "✓"}</span> ${esc(t(settingsSaveStatus === "saving" ? "Saving…" : "Saved"))}`;
  status
    .querySelector<HTMLButtonElement>("#retry-settings-save")
    ?.addEventListener("click", () => void settingsAutosave.retry());
}
async function flushSettings(): Promise<boolean> {
  const saved = await settingsAutosave.flush();
  if (!saved) notice(t("Not saved · Retry"));
  return saved;
}
async function saveConnections(
  settings: TextConnectionSettings,
  delayMs = 0,
): Promise<boolean> {
  const conversationDraft = conversationInstructionDraft;
  const nextSettings = {
    ...settings,
    conversationInstruction:
      conversationDraft ?? settings.conversationInstruction,
  };
  pendingConnectionSettings = nextSettings;
  return settingsAutosave.save(
    "connections",
    async () => {
      try {
        const savedState = await invoke("save_connections", {
          settings: nextSettings,
        });
        if (pendingConnectionSettings === nextSettings) {
          state = savedState;
          pendingConnectionSettings = undefined;
          if (conversationInstructionDraft === conversationDraft)
            conversationInstructionDraft = undefined;
          contentKey = "";
        }
        return true;
      } catch (error) {
        notice(String(error));
        return false;
      }
    },
    delayMs,
  );
}
function latestConnectionSettings(): TextConnectionSettings {
  return pendingConnectionSettings ?? state.text_connections.settings;
}
async function startLmStudioServer() {
  try {
    const startedState = await invoke("start_lm_studio_server", {});
    startedState.text_connections.settings = latestConnectionSettings();
    state = startedState;
    contentKey = "";
    render();
  } catch (error) {
    contentKey = "";
    render();
    notice(String(error));
  }
}
async function scanConnections() {
  connectionScanStarted = true;
  const button = document.querySelector<HTMLButtonElement>("#scan-connections");
  if (button) {
    button.disabled = true;
    button.textContent = t("Scanning …");
  }
  try {
    const scannedState = await invoke("scan_connections", {});
    scannedState.text_connections.settings = latestConnectionSettings();
    state = scannedState;
    contentKey = "";
    render();
  } catch (error) {
    connectionScanStarted = false;
    if (button) {
      button.disabled = false;
      button.textContent = t("Scan again");
    }
    notice(String(error));
  }
}
async function startNewConversation() {
  if (
    state.status === "recording" ||
    state.status === "transcribing" ||
    state.text_connections.processing.status === "processing"
  )
    return;
  try {
    state = await invoke("new_conversation", {});
    workspaceKey = "";
    renderWorkspace();
    render();
  } catch (error) {
    notice(String(error));
  }
}
async function selectOutput(value: string) {
  if (value !== "paste") {
    pendingInsertOutput = false;
    insertPermissionSawConfiguring = false;
  }
  if (
    pendingPreferences ||
    ["recording", "transcribing"].includes(state.status) ||
    state.recovery_available ||
    state.shortcut_configuring ||
    state.recording_shortcut ||
    state.macos?.recording_shortcut === true ||
    !!state.download ||
    ["checking", "downloading", "installing"].includes(state.updates.status)
  ) {
    syncPreferenceControls();
    notice("Wait until the current task finishes before changing the output.");
    return false;
  }
  if (value !== "paste") {
    return preference("output", value);
  }
  if (portalBusy || state.paste_configuring) {
    syncPreferenceControls();
    notice("Wait until the current task finishes before changing the output.");
    return false;
  }
  if (state.paste_ready) return preference("output", "paste");
  if (!pasteAvailable()) {
    syncPreferenceControls();
    notice(
      "Your desktop does not expose this portal. Clipboard output remains available.",
    );
    return false;
  }
  if (pendingInsertOutput) return false;

  portalBusy = true;
  if (!isMac()) {
    pendingInsertOutput = true;
    insertPermissionActionPending = true;
    insertPermissionSawConfiguring = false;
  }
  render();
  try {
    const requested = await command("enable_paste");
    if (!requested) {
      pendingInsertOutput = false;
      insertPermissionSawConfiguring = false;
      return false;
    }
    if (isMac()) {
      if (state.paste_ready) return preference("output", "paste");
      notice(
        "Allow keyboard access in System Settings, then select Insert again.",
      );
      return false;
    }
    try {
      state = await invoke("get_state");
    } catch {
      // Keep the latest event snapshot if the state read is temporarily unavailable.
    }
    insertPermissionActionPending = false;
    if (state.paste_configuring) insertPermissionSawConfiguring = true;
    if (pendingInsertOutput && state.paste_ready) {
      pendingInsertOutput = false;
      insertPermissionSawConfiguring = false;
      return preference("output", "paste");
    }
    if (!state.paste_configuring) {
      pendingInsertOutput = false;
      insertPermissionSawConfiguring = false;
    }
    return false;
  } finally {
    insertPermissionActionPending = false;
    portalBusy = false;
    render();
  }
}
function syncPreferenceControls() {
  if (pendingPreferences) return;
  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-pref]")
    .forEach((input) => {
      const value =
        input.dataset.pref === "output"
          ? effectiveOutput()
          : state.preferences[input.dataset.pref as keyof Preferences];
      if (input instanceof HTMLInputElement && input.type === "checkbox")
        input.checked = !!value;
      else if (input instanceof HTMLInputElement && input.type === "radio")
        input.checked = input.value === String(value);
      else input.value = String(value ?? "");
    });
  const recognition = document.querySelector("#recognition-backend");
  if (recognition) {
    recognition.textContent =
      tab === "setup" && setupStep === 0
        ? setupRecognitionModeStatus()
        : macCpuOnly()
          ? recognitionHardwareStatus()
          : recognitionModeStatus();
  }
}
function recordingUnavailableMessage(): string {
  return t(recordingUnavailableTitle(state));
}

function recognitionModeStatus(): string {
  const cpu = state.cpu_device ?? t("CPU processor");
  if (!state.preferences.gpu) {
    return t("CPU selected: {device}", { device: cpu });
  }
  if (state.gpu_supported === false) {
    return t("GPU is selected, but this build uses the CPU: {device}", {
      device: cpu,
    });
  }
  if (state.gpu_checked === false) {
    return t("Checking GPU hardware …");
  }
  if (state.gpu_fallback) {
    return t("GPU recognition failed; this recording used the CPU: {device}", {
      device: cpu,
    });
  }
  if (!state.gpu_available) {
    return t(
      "No compatible GPU was detected. Recognition uses the CPU: {device}",
      {
        device: cpu,
      },
    );
  }
  return t(gpuText("GPU selected. Vulkan device detected: {device}"), {
    device: state.gpu_device ?? t("GPU device"),
  });
}

function setupRecognitionModeStatus(): string {
  const cpu = state.cpu_device ?? t("CPU processor");
  if (!state.gpu_supported) {
    return t(
      "GPU recognition is unavailable in this build. CPU remains available: {device}",
      { device: cpu },
    );
  }
  if (!state.gpu_checked) return t("Checking GPU hardware …");
  if (state.gpu_fallback) {
    return t("GPU recognition failed; using CPU: {device}", { device: cpu });
  }
  if (!state.gpu_available) {
    return t(
      "No compatible GPU was detected. Recognition uses the CPU: {device}",
      { device: cpu },
    );
  }
  if (state.preferences.gpu) {
    return t(gpuText("GPU selected. Vulkan device detected: {device}"), {
      device: state.gpu_device ?? t("GPU device"),
    });
  }
  return t(gpuText("CPU selected; Vulkan GPU available: {device}"), {
    device: state.gpu_device ?? t("GPU device"),
  });
}

function recognitionModeControl(setup = false, showStatus = true): string {
  const cpu = state.cpu_device ?? t("CPU processor");
  const gpu =
    state.gpu_device ?? t(setup ? "GPU device" : gpuText("Vulkan GPU"));
  const gpuAvailable =
    state.gpu_supported === true &&
    state.gpu_checked === true &&
    state.gpu_available;
  const gpuDisabled = setup ? !gpuAvailable : !state.gpu_supported;
  const status = setup ? setupRecognitionModeStatus() : recognitionModeStatus();
  return `<fieldset class="compute-mode" aria-label="${esc(t("Recognition mode"))}"><label><input type="radio" name="gpu-mode" data-pref="gpu" value="false" ${state.preferences.gpu ? "" : "checked"}><span><strong>${esc(t("CPU"))}</strong><small>${esc(cpu)}</small></span></label><label><input type="radio" name="gpu-mode" data-pref="gpu" value="true" ${state.preferences.gpu ? "checked" : ""} ${gpuDisabled ? "disabled" : ""}><span><strong>${esc(t("GPU"))}</strong><small>${esc(gpu)}</small></span></label></fieldset>${showStatus ? `<p class="secondary" id="recognition-backend">${esc(status)}</p>` : ""}`;
}

const microphoneIcon =
  "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8";
function emptyModelDialog() {
  return '<dialog id="model-drawer" aria-labelledby="model-drawer-title"></dialog>';
}
function emptyUpdateDialog() {
  return `<dialog id="update-dialog" aria-labelledby="update-dialog-version" aria-describedby="update-dialog-message"><div class="update-dialog-shell"><header class="update-dialog-header"><img src="./branding/icon-bordered.svg" width="52" height="52" alt=""><div class="update-dialog-identity"><span class="update-dialog-kicker" id="update-dialog-status"></span><h2 class="update-dialog-version" id="update-dialog-version"></h2><p class="update-dialog-installed" id="update-dialog-installed"></p></div></header><div class="update-dialog-body"><p class="visually-hidden" id="update-dialog-message"></p><h2>${esc(t("What’s new"))}</h2><p class="update-dialog-notes-language" id="update-dialog-notes-language" hidden></p><ul class="update-highlights" id="update-dialog-highlights"></ul><button type="button" id="update-release-link" class="update-release-link" data-project-link="release">${esc(t("All changes on GitHub"))}</button></div><div class="update-dialog-progress" id="update-dialog-progress" hidden><progress id="update-progress-bar" max="1" value="0"></progress><span id="update-progress-label"></span></div><footer class="update-dialog-footer"><span class="update-dialog-hint" id="update-dialog-hint"></span><div class="update-dialog-actions"><button type="button" id="update-later">${esc(t("Later"))}</button><button type="button" id="update-main-action" class="primary"></button></div></footer></div></dialog>`;
}
function bindDialogFocusTrap(dialog: HTMLDialogElement) {
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !dialog.open) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (element) => !element.hidden && element.getClientRects().length > 0,
    );
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (active === dialog || !dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
function bindModelDialogShell() {
  const dialog = document.querySelector<HTMLDialogElement>("#model-drawer");
  if (!dialog) return;
  dialog.onclose = (event) =>
    restoreModelDialogFocus(event.currentTarget as HTMLDialogElement);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void requestCloseModelDialog();
  });
  bindDialogFocusTrap(dialog);
}
function bindUpdateDialogShell() {
  const dialog = document.querySelector<HTMLDialogElement>("#update-dialog");
  if (!dialog) return;
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.onclose = () => {
    if (dialog.open || !dialog.isConnected) return;
    const opener = updateDialogOpener;
    updateDialogOpener = null;
    if (opener?.isConnected && !opener.hidden && !opener.matches(":disabled")) {
      opener.focus();
      return;
    }
    const fallback = [
      document.querySelector<HTMLElement>("#about-update-action"),
      document.querySelector<HTMLElement>("#header-update"),
      document.querySelector<HTMLElement>("#open-settings"),
    ].find(
      (element) =>
        element?.isConnected &&
        !element.hidden &&
        !element.matches(":disabled"),
    );
    fallback?.focus();
  };
  dialog
    .querySelector<HTMLButtonElement>("#update-later")
    ?.addEventListener("click", () => dialog.close());
  dialog
    .querySelector<HTMLButtonElement>("#update-main-action")
    ?.addEventListener("click", () => {
      if (state.updates.status === "ready") {
        if (canInstallUpdate()) void command("install_update");
      } else if (
        state.updates.configured &&
        !!state.updates.version &&
        ["available", "error"].includes(state.updates.status)
      ) {
        void command("download_update");
      }
    });
  dialog
    .querySelector<HTMLButtonElement>("#update-release-link")
    ?.addEventListener("click", () => {
      if (
        state.updates.version &&
        [
          "available",
          "downloading",
          "verifying",
          "ready",
          "installing",
          "error",
        ].includes(state.updates.status)
      )
        void command("open_project_link", { target: "release" });
    });
  bindDialogFocusTrap(dialog);
}
function bindSettingsDialogShell() {
  const dialog = document.querySelector<HTMLDialogElement>("#settings-dialog");
  if (!dialog) return;
  const closeSettings = async () => {
    if (!(await flushSettings())) return;
    aiModelsSettings.cancelEdit();
    tab = "dictation";
    contentKey = "";
    render();
  };
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void closeSettings();
  });
  dialog.onclose = () => {
    if (dialog.open || !dialog.isConnected) return;
    // Opening model management from Settings closes this dialog first. The
    // model drawer owns focus until it closes, so do not return to Settings.
    if (document.querySelector<HTMLDialogElement>("#model-drawer")?.open) {
      settingsDialogOpener = null;
      return;
    }
    settingsDialogOpener?.isConnected
      ? settingsDialogOpener.focus()
      : document.querySelector<HTMLElement>("#open-settings")?.focus();
    settingsDialogOpener = null;
  };
  dialog
    .querySelector<HTMLButtonElement>("#close-settings")
    ?.addEventListener("click", () => void closeSettings());
  bindDialogFocusTrap(dialog);
}
function renderShell() {
  const key = `${state.preferences.ui_language}:${state.preferences.setup_completed}:${state.profile ?? "stable"}`;
  if (shellKey === key) return;
  if (
    shellKey &&
    (settingsSaveStatus === "saving" || settingsSaveStatus === "error")
  )
    return;
  if (document.querySelector<HTMLDialogElement>("#model-drawer")?.open) {
    modelFocusRestorePending = true;
    closeModelDialog();
  }
  const previousSettings =
    document.querySelector<HTMLDialogElement>("#settings-dialog");
  if (previousSettings?.open) previousSettings.close();
  mainWaveform?.destroy();
  mainWaveform = undefined;
  overlayWaveform?.destroy();
  overlayWaveform = undefined;
  shellKey = key;
  contentKey = "";
  workspaceKey = "";
  const setup = !state.preferences.setup_completed;
  document.documentElement.classList.toggle("setup-mode", setup && !overlay);
  if (setup) {
    app.innerHTML = `${windowTitlebar()}<main class="setup-main"><div id="notice" role="alert" hidden></div><div id="content"></div></main><div id="record-control"></div>${emptyModelDialog()}`;
    bindModelDialogShell();
    if (overlay)
      app.innerHTML =
        '<div id="notice" role="alert" hidden></div><div id="record-control"></div>';
    return;
  }
  const settingsTabs: [View, string][] = [
    ["general", "General"],
    ["recording", "Recording & shortcuts"],
    ["text", "Text processing"],
    ["connections", "AI models"],
    ["history", "History"],
    ["permissions", "Permissions"],
    ["about", "About"],
  ];
  app.innerHTML = `${windowTitlebar()}<div id="notice" role="alert" hidden></div><div id="dictation-workspace" class="dictation-workspace"><div class="workspace-frame${historyRailOpen ? "" : " history-collapsed"}"><main id="dictation-content" class="dictation-main"></main><aside id="dictation-history" class="dictation-history history-rail" aria-label="${esc(t("History"))}"></aside></div><div id="record-control"></div></div><dialog id="settings-dialog" aria-labelledby="page-title"><div class="settings-dialog-shell"><nav class="settings-dialog-nav" aria-label="${esc(t("Settings"))}">${settingsTabs.map(([id, title]) => `<button type="button" data-tab="${id}">${esc(t(title))}${id === "permissions" && missingPermissionCount() > 0 ? ` · ${missingPermissionCount()}` : ""}</button>`).join("")}<small class="settings-dialog-version">OpenWhisper ${esc(state.version)}</small></nav><div class="settings-dialog-panel"><header class="settings-dialog-heading"><h1 id="page-title"></h1><span id="settings-save-status" role="status" aria-live="polite"></span><button type="button" id="close-settings" class="settings-close" aria-label="${esc(t("Close"))}">${symbol("M6 6l12 12M18 6 6 18")}</button></header><div id="settings-notice" role="alert" hidden></div><div class="settings-dialog-scroll"><div class="settings-content"><div id="content"></div></div></div></div></div></dialog>${emptyModelDialog()}${emptyUpdateDialog()}`;
  bindModelDialogShell();
  bindUpdateDialogShell();
  bindSettingsDialogShell();
  updateSettingsSaveStatus();
  if (overlay)
    app.innerHTML =
      '<div id="notice" role="alert" hidden></div><div id="record-control"></div>';
}

app.addEventListener("click", (event) => {
  void handleShellClick(event);
});
async function handleShellClick(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[data-tab], [data-settings-view], [data-ui-language], [data-window-action], [data-open-model-drawer], #open-settings, #toggle-history",
  );
  if (!button) return;
  if (button.id === "toggle-history") {
    historyRailOpen = !historyRailOpen;
    const frame = document.querySelector<HTMLElement>(".workspace-frame");
    frame?.classList.toggle("history-collapsed", !historyRailOpen);
    button.setAttribute("aria-expanded", String(historyRailOpen));
    button.setAttribute(
      "aria-label",
      t(historyRailOpen ? "Hide history" : "Show history"),
    );
    button.textContent = t(historyRailOpen ? "Hide history" : "Show history");
    const list = document.querySelector<HTMLElement>("#dictation-history-list");
    if (list) list.hidden = !historyRailOpen;
    return;
  }
  if (!(await flushSettings())) return;
  if (!button.dataset.windowAction) aiModelsSettings.cancelEdit();
  if (button.id === "open-settings") {
    settingsDialogOpener = button;
    tab = "general";
    contentKey = "";
    render();
    return;
  }
  if (button.dataset.settingsView) {
    settingsDialogOpener = button;
    tab = button.dataset.settingsView as View;
    pendingSettingsSection = button.dataset.settingsSection ?? "";
    contentKey = "";
    render();
    if (pendingSettingsSection) {
      document
        .getElementById(pendingSettingsSection)
        ?.scrollIntoView({ block: "start" });
      pendingSettingsSection = "";
    }
    return;
  }
  if (button.hasAttribute("data-open-model-drawer")) {
    if (button.closest("#settings-dialog")) {
      settingsDialogOpener = null;
      tab = "dictation";
      contentKey = "";
      render();
      const workspaceOpener =
        document.querySelector<HTMLElement>("#open-model-drawer");
      if (workspaceOpener) openModelDialog(workspaceOpener);
      return;
    }
    openModelDialog(button);
    return;
  }
  if (button.dataset.windowAction) {
    void command("window_action", { action: button.dataset.windowAction });
    return;
  }
  if (button.dataset.uiLanguage) {
    void preference("ui_language", button.dataset.uiLanguage);
    return;
  }
  if (button.dataset.tab && tab === "dictation") settingsDialogOpener = button;
  tab = button.dataset.tab as View;
  render();
}

const processingStageOrder = [
  "recognition",
  "cleanup",
  "vocabulary",
  "model",
  "snippets",
] as const;

let processingGeneration: number | undefined;
let processingAttempt: number | undefined;
let processingVisible = false;
let processingVisibilityTimer: ReturnType<typeof setTimeout> | undefined;
let processingStartedAt = 0;
let processingMaximum = 0;
let processingWasBusy = false;

function processingProgressView() {
  const busy = state.status === "transcribing";
  const recoverable = !!state.recovery_available && !busy;
  if (!busy && !recoverable) {
    if (processingVisibilityTimer) clearTimeout(processingVisibilityTimer);
    processingVisibilityTimer = undefined;
    processingGeneration = undefined;
    processingAttempt = undefined;
    processingVisible = false;
    processingMaximum = 0;
    processingWasBusy = false;
    return { visible: false, recoverable: false, fraction: 0 };
  }

  const generation = state.recording_generation;
  const eventAttempt = state.text_processing?.attempt;
  const generationChanged = processingGeneration !== generation;
  const attemptChanged =
    eventAttempt !== undefined && eventAttempt !== processingAttempt;
  if (busy && (!processingWasBusy || generationChanged || attemptChanged)) {
    if (processingVisibilityTimer) clearTimeout(processingVisibilityTimer);
    processingVisibilityTimer = undefined;
    processingGeneration = generation;
    if (eventAttempt !== undefined) processingAttempt = eventAttempt;
    else processingAttempt ??= 1;
    processingStartedAt = Date.now();
    processingMaximum = 0;
    processingVisible = false;
  }
  if (recoverable && generationChanged) processingGeneration = generation;
  if (busy && eventAttempt !== undefined) processingAttempt = eventAttempt;
  processingWasBusy = busy;

  if (busy && !processingVisible && !processingVisibilityTimer) {
    const remaining = Math.max(0, 300 - (Date.now() - processingStartedAt));
    processingVisibilityTimer = setTimeout(() => {
      processingVisibilityTimer = undefined;
      if (state.status !== "transcribing") return;
      processingVisible = true;
      workspaceKey = "";
      render();
    }, remaining);
  }

  if (busy) {
    const stages = visibleProcessingStages();
    const event = state.text_processing;
    let stage = event?.stage;
    if (state.text_connections.processing.status === "processing")
      stage = "model";
    const index = stages.findIndex((item) => item === stage);
    if (index >= 0) {
      let withinStage = 0;
      if (event && event.stage === stage) {
        if (event.status === "completed" || event.status === "skipped") {
          withinStage = 1;
        } else if (
          stage === "recognition" &&
          event.completedSamples !== undefined &&
          event.totalSamples !== undefined &&
          event.totalSamples > 0
        ) {
          withinStage = Math.max(
            0,
            Math.min(1, event.completedSamples / event.totalSamples),
          );
        }
      }
      const fraction = (index + withinStage) / stages.length;
      processingMaximum = Math.max(processingMaximum, Math.min(0.97, fraction));
    }
  }

  return {
    visible: recoverable || processingVisible,
    recoverable,
    fraction: processingMaximum,
  };
}

function visibleProcessingStages() {
  const modelConfigured = state.text_connections.settings.connections.some(
    (connection) => connection.enabled,
  );
  const includeModel =
    (modelConfigured &&
      (state.text_connections.settings.mode === "conversation" ||
        state.text_connections.settings.revision?.enabled)) ||
    state.text_connections.processing.provider !== null ||
    (state.text_processing?.stage === "model" &&
      state.text_processing.status !== "skipped");
  const order =
    state.text_connections.settings.mode === "conversation"
      ? (["recognition", "cleanup", "vocabulary", "snippets", "model"] as const)
      : processingStageOrder;
  return order.filter((stage) => stage !== "model" || includeModel);
}

function recordingStatusTitle(): string {
  const recording = state.status === "recording";
  const busy = state.status === "transcribing";
  const recovery = !!state.recovery_available && !recording && !busy;
  if (recording) return t("Listening to you");
  if (busy) return processingVisible ? t("Processing…") : "";
  if (recovery || state.status === "error")
    return t("Something needs attention");
  if (state.recording_available === false) {
    switch (state.recording_unavailable_reason) {
      case "model":
        return t("Choose a model");
      case "permission":
        return t("Microphone access is not allowed.");
      case "audio":
        return t("No microphone available");
      case "host":
        return t("Recording service unavailable");
      default:
        return t("Recording is unavailable");
    }
  }
  return t("Ready");
}

function recordControl() {
  const recording = state.status === "recording",
    busy = state.status === "transcribing",
    recovery = !!state.recovery_available && !recording && !busy;
  const progressView = processingProgressView();
  const text = recording
    ? t("Recording · {time}", {
        time: `${Math.floor(state.elapsed / 60)}:${String(state.elapsed % 60).padStart(2, "0")}`,
      })
    : busy
      ? processingVisible
        ? t("Processing…")
        : ""
      : recovery
        ? t("Retry transcription")
        : t("Start dictation");
  const unavailable =
    state.recording_available === false && !recording && !recovery;
  const visibleText =
    overlay && recording
      ? `${Math.floor(state.elapsed / 60)}:${String(state.elapsed % 60).padStart(2, "0")}`
      : text;
  const controls = document.querySelector<HTMLDivElement>("#record-control")!;
  const setupIdle =
    !state.preferences.setup_completed &&
    !recording &&
    !busy &&
    !recovery &&
    state.status !== "error";
  controls.dataset.setupIdle = String(setupIdle);
  controls.dataset.recovery = String(recovery);
  document.documentElement.classList.toggle(
    "setup-recording",
    !overlay && !state.preferences.setup_completed && !setupIdle,
  );
  if (!controls.childElementCount) {
    const outputModes: [string, string, string][] = [
      ["paste", t("Insert"), t("Paste at the cursor")],
      ["clipboard", t("Copy"), t("Copy to clipboard only")],
    ];
    const outputControls = `<div class="record-output" role="group" aria-label="${esc(t("Output"))}"><span class="record-output-label">${esc(t("Output"))}</span>${outputModes.map(([value, label, fullLabel]) => `<button type="button" data-output="${value}" data-pref="output" aria-label="${esc(fullLabel)}" title="${esc(fullLabel)}" aria-pressed="${effectiveOutput() === value}" ${recording || recovery || busy || (value === "paste" && (!accessibilityPermissionGranted() || portalBusy || state.paste_configuring)) ? "disabled" : ""}>${esc(label)}</button>`).join("")}</div>`;
    const overlayBars = Array.from({ length: 5 }, () => "<i></i>").join("");
    controls.innerHTML = overlay
      ? `<div class="record-actions"><div class="record-status"><div class="audio-mark" aria-hidden="true">${overlayBars}<canvas class="live-waveform" data-waveform="overlay" aria-hidden="true"></canvas></div><div class="record-copy"><strong id="status-title" aria-live="polite"></strong><span id="status" role="status"></span><div id="overlay-progress" role="progressbar" aria-label="${esc(t("Text processing progress"))}" hidden></div></div><button id="record-unavailable-action" data-goto="recording" hidden></button></div><span id="record-label"></span><button id="cancel" aria-label="${esc(t("Discard recording"))}" hidden>${esc(t("Cancel"))}</button><button id="record" class="capsule"><span id="record-symbol"></span><span id="record-action-label" class="record-action-label"></span></button></div>`
      : `<div class="record-leading"><button id="discard-result" type="button" title="${esc(t("Clear current text; saved history is kept."))}" aria-label="${esc(t("Clear current text; saved history is kept."))}">${esc(t("Discard"))}</button><button id="cancel" aria-label="${esc(t("Discard recording"))}" hidden>${esc(t("Cancel"))}</button><div class="record-status"><div class="audio-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><div class="record-copy"><strong id="status-title"></strong><span id="status" role="status"></span></div><button id="record-unavailable-action" data-goto="recording" hidden></button></div></div><div class="record-center"><button id="record" class="capsule"><span id="record-symbol"></span></button><span id="record-label"></span></div>${outputControls}`;
    document
      .querySelector("#record")!
      .addEventListener(
        "click",
        () =>
          void command(
            state.recovery_available
              ? "retry_transcription"
              : "toggle_recording",
          ),
      );
    document
      .querySelector("#cancel")!
      .addEventListener(
        "click",
        () =>
          void command(
            state.recovery_available && state.status !== "recording"
              ? "discard_recovery"
              : "cancel_recording",
          ),
      );
    document
      .querySelector<HTMLButtonElement>("#discard-result")
      ?.addEventListener("click", () => {
        dismissedTranscriptValue = state.transcript;
        dismissedTranscriptGeneration = state.recording_generation;
        selectedHistoryIndex = null;
        workspaceKey = "";
        renderWorkspace();
      });
    controls
      .querySelectorAll<HTMLButtonElement>("[data-output]")
      .forEach((output) =>
        output.addEventListener(
          "click",
          () => void selectOutput(output.dataset.output ?? ""),
        ),
      );
    document
      .querySelector<HTMLButtonElement>("#record-unavailable-action")!
      .addEventListener("click", () => {
        void (async () => {
          if (!(await flushSettings())) return;
          if (state.recording_unavailable_reason === "model" && !overlay) {
            openModelDialog(
              document.querySelector<HTMLButtonElement>(
                "#record-unavailable-action",
              )!,
            );
            return;
          }
          tab =
            state.recording_unavailable_reason === "permission"
              ? "permissions"
              : "recording";
          render();
        })();
      });
  }
  const button = document.querySelector<HTMLButtonElement>("#record")!;
  button.disabled =
    !recording &&
    !recovery &&
    (state.recording_available === false ||
      busy ||
      !!state.recording_shortcut ||
      ["downloading", "installing"].includes(state.updates.status));
  button.classList.toggle("recording", recording);
  button.title =
    state.recording_available === false && !recording && !recovery
      ? recordingUnavailableMessage()
      : t(state.message);
  button.setAttribute("aria-label", text);
  document.querySelector("#record-symbol")!.innerHTML = symbol(
    recording ? "M6 6h12v12H6z" : busy ? "M12 3a9 9 0 1 1-9 9" : microphoneIcon,
  );
  controls.dataset.status = state.status;
  controls.style.setProperty(
    "--voice-level",
    String(0.2 + (state.level ?? 0) * 0.8),
  );
  document.querySelector("#status-title")!.textContent = overlay
    ? recording
      ? ""
      : busy
        ? processingVisible
          ? t("Processing…")
          : ""
        : recovery
          ? t(overlay ? "Processing failed" : "Retry transcription")
          : state.status === "error"
            ? t("Something needs attention")
            : unavailable
              ? recordingUnavailableMessage()
              : t("Ready")
    : recordingStatusTitle();
  const recordActionLabel = document.querySelector<HTMLElement>(
    "#record-action-label",
  );
  if (recordActionLabel) {
    recordActionLabel.textContent = recovery
      ? t("Retry transcription")
      : t("Start dictation");
    recordActionLabel.hidden = recording || busy;
  }
  document.querySelector("#record-label")!.textContent = visibleText;
  const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
  cancel.hidden = !recording && !recovery && !(overlay && busy);
  cancel.setAttribute(
    "aria-label",
    t(
      recovery
        ? "Discard saved recording"
        : busy
          ? "Cancel processing"
          : "Discard recording",
    ),
  );
  cancel.textContent = t(recovery ? "Discard" : "Cancel");
  if (overlay) {
    button.hidden = busy;
    const overlayActions =
      document.querySelector<HTMLElement>(".record-actions");
    if (overlayActions) {
      overlayActions.style.setProperty(
        "--processing-fill",
        `${Math.round(progressView.fraction * 100)}%`,
      );
      overlayActions.classList.toggle(
        "processing-visible",
        busy && progressView.visible,
      );
      overlayActions.classList.toggle(
        "processing-error",
        progressView.recoverable,
      );
    }
  }
  controls
    .querySelectorAll<HTMLButtonElement>("[data-output]")
    .forEach((output) => {
      output.setAttribute(
        "aria-pressed",
        String(output.dataset.output === effectiveOutput()),
      );
      output.disabled =
        recording ||
        recovery ||
        busy ||
        (output.dataset.output === "paste" &&
          (portalBusy || state.paste_configuring === true));
    });
  const unavailableAction = document.querySelector<HTMLButtonElement>(
    "#record-unavailable-action",
  )!;
  controls.dataset.unavailable = String(unavailable);
  unavailableAction.hidden =
    !unavailable || state.recording_unavailable_reason === "host";
  unavailableAction.dataset.goto =
    state.recording_unavailable_reason === "model"
      ? "models"
      : state.recording_unavailable_reason === "permission"
        ? "permissions"
        : "recording";
  unavailableAction.textContent = t(
    state.recording_unavailable_reason === "model"
      ? "Open models"
      : "Open settings",
  );
  document.querySelector("#status")!.textContent = overlay
    ? ""
    : unavailable
      ? recordingUnavailableMessage()
      : t(state.message);
  const overlayProgress =
    document.querySelector<HTMLElement>("#overlay-progress");
  if (overlayProgress) {
    overlayProgress.hidden = !busy || !progressView.visible;
    overlayProgress.setAttribute("aria-valuemin", "0");
    overlayProgress.setAttribute("aria-valuemax", "100");
    overlayProgress.setAttribute(
      "aria-valuenow",
      String(Math.round(progressView.fraction * 100)),
    );
    overlayProgress.setAttribute("aria-valuetext", t("Processing…"));
  }
  syncDictationState();
}

function syncWaveform(
  current: LiveWaveform | undefined,
  canvas: HTMLCanvasElement | null,
): LiveWaveform | undefined {
  if (current?.canvas === canvas) return current;
  current?.destroy();
  return canvas ? new LiveWaveform(canvas) : undefined;
}

function syncWaveforms(seedCurrentLevel = true) {
  const recording = state.status === "recording";
  const generation = state.recording_generation;
  const mainWaveformElement = document.querySelector<HTMLElement>(
    ".dictation-waveform",
  );
  if (mainWaveformElement)
    mainWaveformElement.dataset.active = String(recording);
  const mainCanvas = document.querySelector<HTMLCanvasElement>(
    '#dictation-content canvas[data-waveform="main"]',
  );
  mainWaveform = syncWaveform(mainWaveform, mainCanvas);
  const overlayCanvas = overlay
    ? document.querySelector<HTMLCanvasElement>(
        '#record-control canvas[data-waveform="overlay"]',
      )
    : null;
  overlayWaveform = syncWaveform(overlayWaveform, overlayCanvas);
  for (const waveform of [mainWaveform, overlayWaveform]) {
    if (!waveform) continue;
    const freshGeneration = waveform.setRecording(recording, generation);
    if (
      freshGeneration &&
      seedCurrentLevel &&
      recording &&
      generation !== undefined
    )
      waveform.push(generation, state.level ?? 0, performance.now());
  }
}

function syncDictationState() {
  syncDiscardResult();
  syncWaveforms();
  const heading = document.querySelector<HTMLElement>(".dictation-status-pill");
  if (heading) heading.textContent = recordingStatusTitle();
  const timer = document.querySelector<HTMLElement>("#dictation-timer");
  if (timer) {
    const elapsed = state.elapsed;
    timer.textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  }
}

function syncDiscardResult() {
  const button = document.querySelector<HTMLButtonElement>("#discard-result");
  if (!button) return;
  const recording = state.status === "recording";
  const busy = state.status === "transcribing";
  const recovery = !!state.recovery_available && !recording && !busy;
  button.hidden = recording || recovery;
  button.disabled =
    busy ||
    (selectedHistoryIndex === null &&
      (dismissedTranscriptValue !== undefined ||
        (!state.transcript && !state.transcript_preview_omitted)));
}

function renderWorkspace() {
  const main = document.querySelector<HTMLElement>("#dictation-content");
  const rail = document.querySelector<HTMLElement>("#dictation-history");
  if (!main || !rail) return;
  if (
    dismissedTranscriptValue !== undefined &&
    (state.transcript !== dismissedTranscriptValue ||
      (state.status === "done" &&
        state.recording_generation !== dismissedTranscriptGeneration))
  ) {
    dismissedTranscriptValue = undefined;
    dismissedTranscriptGeneration = undefined;
  }
  const historySnapshot = JSON.stringify(state.history);
  if (
    (observedHistorySnapshot !== undefined &&
      observedHistorySnapshot !== historySnapshot) ||
    (observedTranscript !== undefined &&
      observedTranscript !== state.transcript)
  ) {
    selectedHistoryIndex = null;
  }
  observedHistorySnapshot = historySnapshot;
  observedTranscript = state.transcript;
  if (
    selectedHistoryIndex !== null &&
    state.history[selectedHistoryIndex] === undefined
  ) {
    selectedHistoryIndex = null;
  }
  const key = JSON.stringify([
    state.preferences.model,
    state.preferences.gpu,
    state.preferences.output,
    state.models,
    state.installed,
    state.recommended_models,
    state.recording_available,
    state.recording_unavailable_reason,
    state.macos,
    state.paste_ready,
    state.preferences.output,
    state.recovery_available,
    state.status,
    state.recording_generation,
    state.history,
    state.transcript,
    state.raw_transcript,
    state.raw_transcript_preview_omitted,
    state.text_processing,
    state.text_connections.processing,
    state.text_connections.settings.mode,
    state.text_connections.settings.connections,
    state.text_connections.conversation,
    state.transcript_preview_omitted,
    state.gpu_supported,
    state.gpu_checked,
    state.gpu_available,
    state.gpu_fallback,
    state.gpu_device,
    state.cpu_device,
    state.preferences.keep_history,
    state.preferences.cleanup_enabled,
    tab === "history",
    historyRailOpen,
    selectedHistoryIndex,
    dismissedTranscriptValue,
  ]);
  if (key === workspaceKey) {
    syncDictationState();
    return;
  }
  const activeWorkspaceElement = document.activeElement;
  const focusedWorkspaceControlId =
    activeWorkspaceElement instanceof HTMLElement &&
    main.contains(activeWorkspaceElement) &&
    activeWorkspaceElement.id &&
    activeWorkspaceElement.matches(
      "button, input, select, textarea, [tabindex]",
    )
      ? activeWorkspaceElement.id
      : undefined;
  workspaceKey = key;
  const model = state.models.find(
    (candidate) => candidate.id === state.preferences.model,
  );
  const selectedHistoryText =
    selectedHistoryIndex === null
      ? undefined
      : state.history[selectedHistoryIndex];
  const currentTranscriptDismissed = dismissedTranscriptValue !== undefined;
  const transcriptAvailable =
    selectedHistoryText !== undefined ||
    (state.text_connections.settings.mode === "conversation" &&
      state.text_connections.conversation.turns.length > 0) ||
    (!currentTranscriptDismissed &&
      (!!state.transcript || state.transcript_preview_omitted));
  const conversationMode =
    state.text_connections.settings.mode === "conversation";
  const conversationTurns = state.text_connections.conversation.turns;
  const transcriptMarkup = conversationMode
    ? `${conversationTurns.map((turn) => `<article class="conversation-turn"><h3>${esc(t("You"))}</h3><p class="transcript">${esc(turn.user)}</p><h3>${esc(t("Assistant"))}</h3><p class="transcript">${esc(turn.assistant)}</p></article>`).join("")}${state.status !== "transcribing" && state.transcript && conversationTurns.at(-1)?.assistant !== state.transcript ? `<article class="conversation-pending"><h3>${esc(t("Latest recording"))}</h3><p class="transcript">${esc(state.transcript_preview_omitted ? t("The complete transcript is available with Copy; its preview is too large.") : state.transcript)}</p></article>` : ""}${state.raw_transcript && state.status !== "transcribing" ? `<details class="raw-transcript"><summary>${esc(t("Raw recognition"))}</summary><p class="transcript">${esc(state.raw_transcript_preview_omitted ? t("The raw transcript is too large to preview.") : state.raw_transcript)}</p></details>` : ""}${conversationTurns.length === 0 && !state.transcript && state.status !== "transcribing" ? `<div class="dictation-empty"><p>${esc(t("Record a message to start this conversation."))}</p></div>` : ""}`
    : selectedHistoryText !== undefined
      ? `<p class="transcript">${esc(selectedHistoryText)}</p>`
      : state.status === "transcribing" || state.recovery_available
        ? ""
        : transcriptAvailable
          ? `<p class="transcript">${esc(state.transcript_preview_omitted ? t("The complete transcript is available with Copy; its preview is too large.") : state.transcript)}</p>${state.raw_transcript !== undefined || state.raw_transcript_preview_omitted ? `<details class="raw-transcript"><summary>${esc(t("Raw recognition"))}</summary><p class="transcript">${esc(state.raw_transcript_preview_omitted ? t("The raw transcript is too large to preview.") : (state.raw_transcript ?? ""))}</p></details>` : ""}`
          : `<div class="dictation-empty"><p>${esc(t("Press Record or the shortcut. Your text will appear here."))}</p></div>`;
  const processingFallbackMessage =
    state.text_connections.processing.reason ===
    "timeout_without_reasoning_control"
      ? "AI text processing timed out. LM Studio does not expose a setting to turn reasoning off for this model; try a model that does. Your original text was kept."
      : "AI text processing was skipped; your text was kept.";
  const processingFallbackNotice =
    selectedHistoryText === undefined &&
    transcriptAvailable &&
    state.status !== "transcribing" &&
    state.text_connections.processing.status === "fallback"
      ? `<p class="processing-fallback-notice" role="status">${esc(t(processingFallbackMessage))}</p>`
      : "";
  const selectedConnection = state.text_connections.settings.connections.find(
    (item) => item.enabled,
  );
  const selectedConnectionName = selectedConnection
    ? selectedConnection.provider.startsWith("custom:")
      ? (selectedConnection as CustomCliConnection).name
      : (
          {
            ollama: "Ollama",
            lm_studio: "LM Studio",
            claude_code: "Claude Code",
            codex: "Codex",
          } as Record<BuiltinTextProvider, string>
        )[selectedConnection.provider as BuiltinTextProvider]
    : undefined;
  const selectedConnectionUsable = selectedConnection
    ? state.text_connections.available.find(
        (item) => item.provider === selectedConnection.provider,
      )?.usable === true
    : false;
  const conversationNotice = conversationMode
    ? `<section class="conversation-bar"><div><strong>${esc(t("Voice conversation"))}</strong><span>${esc(selectedConnectionName && selectedConnectionUsable ? t("Using {provider}", { provider: selectedConnectionName }) : selectedConnectionName ? t("Selected connection is unavailable; recording still works without assistant replies.") : t("Recording still works without assistant replies."))}</span></div><div class="conversation-actions"><button id="new-chat" type="button" ${state.status === "recording" || state.status === "transcribing" || state.text_connections.processing.status === "processing" ? "disabled" : ""}>${esc(t("New chat"))}</button>${selectedConnectionUsable ? "" : `<button id="manage-connections" type="button">${esc(t("Choose connection"))}</button>`}</div></section>`
    : "";
  const contextFullNotice =
    conversationMode &&
    state.text_connections.processing.status === "fallback" &&
    state.text_connections.processing.reason === "context_full"
      ? `<p class="processing-fallback-notice context-full-notice" role="status">${esc(t("Conversation context is full. Start a new chat to continue with a fresh context."))} <button type="button" data-new-chat>${esc(t("New chat"))}</button></p>`
      : "";
  const processingView = processingProgressView();
  const progressValue = Math.round(processingView.fraction * 100);
  const processingMarkup = `<div class="dictation-processing-slot"><section class="dictation-processing-strip" aria-label="${esc(t("Text processing progress"))}" ${state.status !== "transcribing" || !processingView.visible ? "hidden" : ""}><span class="processing-progress-copy" role="status" aria-live="polite">${esc(t("Processing…"))}</span><div class="processing-progress-row"><div class="processing-bar" role="progressbar" aria-label="${esc(t("Text processing progress"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progressValue}" style="--processing-fill:${progressValue}%"><span aria-hidden="true"></span></div><button id="cancel-processing" type="button" aria-label="${esc(t("Cancel processing"))}">×</button></div></section><section class="dictation-processing-error" role="alert" style="--processing-fill:${progressValue}%" ${processingView.recoverable ? "" : "hidden"}><span class="processing-error-dot" aria-hidden="true"></span><span class="processing-error-copy">${esc(t("Processing failed"))}</span><button id="retry-processing" type="button">${esc(t("Retry transcription"))}</button></section></div>`;
  const mode = isMac()
    ? t("Native")
    : state.preferences.gpu && state.gpu_checked === false
      ? t("Checking")
      : state.preferences.gpu &&
          state.gpu_supported !== false &&
          state.gpu_available &&
          !state.gpu_fallback
        ? t("GPU")
        : t("CPU");
  const statusLabel =
    state.status === "recording"
      ? t("Listening to you")
      : state.status === "transcribing"
        ? processingVisible
          ? t("Processing…")
          : ""
        : state.recovery_available
          ? t("Something needs attention")
          : state.recording_available === false
            ? recordingUnavailableMessage()
            : t("Ready");
  const recordingReady = state.recording_available !== false;
  const modeTitle = recognitionHardwareStatus();
  const railStatus = state.preferences.keep_history
    ? t("Saved only on this device.")
    : t("History is not saved.");
  const retainedWaveformCanvas = mainWaveform?.canvas;
  retainedWaveformCanvas?.remove();
  main.innerHTML = `${permissionBanner()}<div class="dictation-topline"><div class="dictation-title"><h1>${esc(t("Dictation"))}</h1></div><label class="workspace-mode-select">${esc(t("Processing mode"))}<select id="workspace-mode" aria-label="${esc(t("Processing mode"))}" ${state.status === "recording" || state.status === "transcribing" ? "disabled" : ""}><option value="single" ${!conversationMode ? "selected" : ""}>${esc(t("Single recording"))}</option><option value="conversation" ${conversationMode ? "selected" : ""}>${esc(t("Voice conversation"))}</option></select></label><button id="open-model-drawer" type="button" class="dictation-change-model" data-open-model-drawer aria-label="${esc(`${model?.title ?? t("Choose a model")}, ${mode}. ${modeTitle}`)}" title="${esc(modeTitle)}"><span class="model-pill-status ${recordingReady ? "ready" : "unavailable"}" aria-hidden="true"></span><span class="model-pill-name">${esc(model?.title ?? t("Choose a model"))}</span><span class="model-pill-mode">${esc(mode)}</span><span class="model-pill-chevron" aria-hidden="true"></span></button><div class="dictation-status-pill" role="status">${esc(statusLabel)}</div></div><section class="dictation-activity" aria-label="${esc(t("Recording activity"))}"><strong id="dictation-timer" aria-label="${esc(t("Recording time"))}">0:00</strong><div class="dictation-waveform" aria-hidden="true"><canvas class="live-waveform" data-waveform="main" aria-hidden="true"></canvas></div></section>${conversationNotice}<section class="dictation-transcript" aria-labelledby="transcript-heading"><header class="dictation-transcript-heading"><h2 id="transcript-heading">${esc(conversationMode ? t("Conversation") : t("Transcript"))}</h2><button id="copy-dictation" type="button" ${transcriptAvailable ? "" : "hidden"}>${esc(t("Copy"))}</button></header><div class="dictation-transcript-body">${transcriptMarkup}${processingFallbackNotice}${contextFullNotice}</div></section>${processingMarkup}<section class="dictation-feature-cards" aria-label="${esc(t("Dictation settings"))}"><button type="button" data-open-model-drawer class="dictation-feature-card"><span class="dictation-feature-heading"><i class="dictation-feature-dot recognition"></i><strong>${esc(t("Recognition"))}</strong></span><span class="dictation-feature-description">${esc(`${model?.title ?? t("Choose a model")} · ${mode}`)}</span></button><button type="button" data-settings-view="text" data-settings-section="settings-vocabulary" class="dictation-feature-card"><span class="dictation-feature-heading"><i class="dictation-feature-dot vocabulary"></i><strong>${esc(t("Vocabulary"))}</strong></span><span class="dictation-feature-description">${esc(t("Names and technical terms"))}</span></button><button type="button" data-settings-view="text" class="dictation-feature-card"><span class="dictation-feature-heading"><i class="dictation-feature-dot snippets"></i><strong>${esc(t("Snippets"))}</strong></span><span class="dictation-feature-description">${esc(t("Expand spoken phrases"))}</span></button></section>`;
  bindVocabularyContextActions(main);
  if (retainedWaveformCanvas)
    main
      .querySelector<HTMLElement>(".dictation-waveform")
      ?.replaceChildren(retainedWaveformCanvas);
  rail.innerHTML = `<header class="dictation-history-heading"><div class="dictation-history-title"><h2>${esc(t("History"))}</h2><span class="dictation-history-count">${state.history.length}</span></div><button id="toggle-history" type="button" aria-expanded="${historyRailOpen}" aria-controls="dictation-history-list" aria-label="${esc(t(historyRailOpen ? "Hide history" : "Show history"))}">${esc(t(historyRailOpen ? "Hide history" : "Show history"))}</button></header><div id="dictation-history-list" class="dictation-history-list" ${historyRailOpen ? "" : "hidden"}>${state.history.length ? historyRows() : `<p class="secondary">${esc(t("No recordings in history yet."))}</p>`}</div><footer class="dictation-history-footer"><span>${esc(railStatus)}</span>${state.history.length ? `<button type="button" data-clear-history id="clear-history-rail" class="history-clear-action">${esc(t("Clear history"))}</button>` : ""}</footer>`;
  main
    .querySelector<HTMLButtonElement>("#copy-dictation")
    ?.addEventListener("click", () => {
      if (selectedHistoryIndex !== null) {
        void command("copy_history", { index: selectedHistoryIndex });
      } else void command("copy_transcript");
    });
  main
    .querySelector<HTMLButtonElement>("#cancel-processing")
    ?.addEventListener("click", () => void command("cancel_recording"));
  main
    .querySelector<HTMLButtonElement>("#retry-processing")
    ?.addEventListener("click", () => void command("retry_transcription"));
  main
    .querySelector<HTMLSelectElement>("#workspace-mode")
    ?.addEventListener("change", (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      const nextMode = select.value as TextConnectionSettings["mode"];
      const latest = latestConnectionSettings();
      if (
        nextMode === "conversation" &&
        latest.connections.some(
          (connection) =>
            connection.enabled &&
            connection.provider.startsWith("custom:") &&
            !(connection as CustomCliConnection).stdin.includes("{prompt}") &&
            !(connection as CustomCliConnection).args.some((argument) =>
              argument.includes("{prompt}"),
            ),
        )
      ) {
        select.value = latest.mode;
        notice(
          t(
            "Add {prompt} to the input template or an argument to use this connection in Conversation mode.",
            { prompt: "{prompt}" },
          ),
        );
        return;
      }
      void saveConnections({
        ...latest,
        mode: nextMode,
      });
    });
  main
    .querySelector<HTMLButtonElement>("#new-chat")
    ?.addEventListener("click", () => void startNewConversation());
  main
    .querySelector<HTMLButtonElement>("[data-new-chat]")
    ?.addEventListener("click", () => void startNewConversation());
  main
    .querySelector<HTMLButtonElement>("#manage-connections")
    ?.addEventListener("click", () => {
      tab = "general";
      contentKey = "";
      render();
      document
        .querySelector<HTMLButtonElement>('[data-settings-view="connections"]')
        ?.click();
    });
  main
    .querySelector<HTMLButtonElement>('[data-command="allow_microphone"]')
    ?.addEventListener("click", () => {
      void command("allow_microphone");
    });
  bindHistoryActions(rail);
  rail
    .querySelectorAll<HTMLButtonElement>("[data-history-select]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const index = Number(button.dataset.historySelect);
        selectedHistoryIndex = selectedHistoryIndex === index ? null : index;
        workspaceKey = "";
        renderWorkspace();
        document
          .querySelector<HTMLButtonElement>(`[data-history-select="${index}"]`)
          ?.focus();
      }),
    );
  if (focusedWorkspaceControlId && document.hasFocus()) {
    const focusedReplacement = main.querySelector<HTMLElement>(
      `#${CSS.escape(focusedWorkspaceControlId)}`,
    );
    if (
      focusedReplacement &&
      !focusedReplacement.hidden &&
      !focusedReplacement.matches(":disabled") &&
      focusedReplacement.getClientRects().length > 0
    ) {
      focusedReplacement.focus({ preventScroll: true });
    }
  }
  syncDictationState();
}

function render() {
  if (!state) return;
  document
    .querySelectorAll<HTMLDetailsElement>("[data-model-family]")
    .forEach((details) => {
      if (!details.isConnected) return;
      const family = details.dataset.modelFamily;
      if (!family) return;
      if (details.open) expandedModelFamilies.add(family);
      else expandedModelFamilies.delete(family);
    });
  setLocale(state.preferences.ui_language ?? "en");
  if (!state.preferences.setup_completed) tab = "setup";
  else if (tab === "setup") tab = "dictation";
  renderShell();
  syncWindowTitlebar();
  syncUpdateDialog();
  recordControl();
  if (overlay) return;
  syncModelDialog();
  const settingsDialog =
    document.querySelector<HTMLDialogElement>("#settings-dialog");
  if (settingsDialog) settingsDialog.dataset.view = tab;
  if (tab !== "dictation" && settingsDialog && !settingsDialog.open) {
    settingsDialogOpener ??=
      document.querySelector<HTMLElement>("#open-settings");
    settingsDialog.showModal();
  } else if (tab === "dictation" && settingsDialog?.open) {
    settingsDialog.close();
  }
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
    if (b.dataset.tab === "permissions")
      b.textContent = `${t("Permissions")}${missingPermissionCount() ? ` · ${missingPermissionCount()}` : ""}`;
    const selected = b.dataset.tab === tab;
    b.classList.toggle("selected", selected);
    b.setAttribute("aria-current", selected ? "page" : "false");
  });
  if (settingsSaveStatus !== "saving" && settingsSaveStatus !== "error")
    syncPreferenceControls();
  syncAboutUpdates();
  renderWorkspace();
  if (tab === "dictation") return;
  const triggerBusy =
    portalBusy ||
    state.shortcut_configuring ||
    ["recording", "transcribing"].includes(state.status) ||
    ["downloading", "installing"].includes(state.updates.status);
  document
    .querySelectorAll<HTMLButtonElement>(
      '[data-portal="enable_shortcut"], [data-portal="clear_shortcut"], [data-portal="desktop_shortcut"]',
    )
    .forEach((button) => {
      button.disabled =
        triggerBusy ||
        (button.dataset.portal === "enable_shortcut" &&
          !state.native_shortcuts &&
          !state.shortcut_portal);
    });
  const pageTitle = document.querySelector<HTMLElement>("#page-title");
  if (pageTitle)
    pageTitle.hidden = tab === "connections" && aiModelsSettings.editing;
  if (settingsSaveStatus === "saving" || settingsSaveStatus === "error") {
    return;
  }
  if (pendingPreferences) return;
  const focused = document.activeElement;
  if (
    renderedTab === tab &&
    focused instanceof HTMLElement &&
    focused.closest("#content") &&
    (focused instanceof HTMLTextAreaElement ||
      (focused instanceof HTMLInputElement && focused.type === "text"))
  ) {
    contentKey = "";
    return;
  }
  const nextKey = JSON.stringify(
    [
      tab,
      tab === "general" || tab === "recording" ? null : state.status,
      // Checkbox changes must not replace the focused row or move its click target.
      tab === "general"
        ? {
            ui_language: state.preferences.ui_language,
            setup_completed: state.preferences.setup_completed,
            model: state.preferences.model,
            gpu: state.preferences.gpu,
            output: state.preferences.output,
          }
        : tab === "recording"
          ? {
              ui_language: state.preferences.ui_language,
              setup_completed: state.preferences.setup_completed,
              model: state.preferences.model,
              output: state.preferences.output,
            }
          : tab === "connections"
            ? {
                settings: state.text_connections.settings,
                available: state.text_connections.available,
              }
            : tab === "text"
              ? {
                  preferences: state.preferences,
                  settings: state.text_connections.settings,
                }
              : tab === "about"
                ? {
                    ui_language: state.preferences.ui_language,
                    setup_completed: state.preferences.setup_completed,
                  }
                : state.preferences,
      state.installed,
      state.microphones,
      state.microphone_labels,
      state.recommended_models,
      state.shortcut_portal,
      state.paste_portal,
      state.shortcut,
      state.shortcut_configuring,
      state.native_shortcuts,
      state.native_x11,
      state.native_paste,
      state.native_mouse,
      state.native_middle_mouse,
      state.recording_shortcut,
      state.preferences.native_trigger,
      state.preferences.x11_trigger,
      state.paste_ready,
      state.paste_configuring,
      state.download,
      state.history,
      state.transcript,
      state.transcript_preview_omitted,
      state.macos,
      tab === "about" ? state.updates.configured : state.updates,
      state.overlay_available,
      state.overlay_unavailable_reason,
      state.gpu_supported,
      state.gpu_checked,
      state.gpu_available,
      state.gpu_device,
      state.cpu_device,
      state.gpu_fallback,
      state.launch_at_login_available,
      portalBusy,
      tab === "setup" ? setupStep : null,
    ],
    (_key, value) => {
      // Native bridge replies and state events may serialize dictionaries in different orders.
      // Compare their values so unchanged controls retain focus and their click targets.
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
          )
        : value;
    },
  );
  // Download progress updates the bar in place; re-rendering would reset scrolling and focus.
  document
    .querySelectorAll<HTMLProgressElement>("#content .model-row progress")
    .forEach((progress) => {
      progress.value = state.progress;
    });
  if (contentKey === nextKey) return;
  contentKey = nextKey;
  if (overlay) return;
  if (tab !== "setup") {
    document.querySelector<HTMLElement>("#page-title")!.textContent = t(
      tab === "recording"
        ? "Recording & shortcuts"
        : tab === "permissions"
          ? "Permissions"
          : (tabs.find(([id]) => id === tab)?.[1] ?? "Settings"),
    );
  }
  const content = document.querySelector<HTMLDivElement>("#content")!;
  content.dataset.settingsTab = tab;
  const main =
    document.querySelector<HTMLElement>(".settings-dialog-scroll") ??
    document.querySelector<HTMLElement>(".setup-main")!;
  const scrollTop = renderedTab === tab ? main.scrollTop : 0;
  renderedTab = tab;
  const p = state.preferences;
  if (tab === "setup") {
    const panels = [
      ...(setupHasHardwareStep()
        ? [
            {
              title: t("Choose recognition hardware"),
              detail: t(
                "Choose CPU or GPU for recognition. The next step suggests models for your selection.",
              ),
              content: recognitionModeControl(true),
            },
          ]
        : []),
      {
        title: t("Download a speech model"),
        detail: t(
          "Choose a model family to see its variants. Recommendations use your current CPU/GPU mode; all models remain available.",
        ),
        content: setupModelGroups(),
      },
      {
        title: isMac()
          ? t("Allow microphone access")
          : t("Choose a microphone"),
        detail: t(
          "Microphone access is needed to record your voice. Everything stays on your computer.",
        ),
        content: isMac()
          ? state.macos?.microphone_allowed
            ? `<p class="success">${esc(t("Microphone access allowed"))}</p>${microphoneControl()}`
            : `<button data-command="allow_microphone">${esc(t("Allow"))}</button>`
          : microphoneControl(),
      },
      {
        title: t("Choose a language"),
        detail: t(
          "Which language do you usually dictate in? Automatic detection can mistake short phrases for English.",
        ),
        content: languages(),
      },
      {
        title: t("Where should the text go?"),
        detail: t(
          "Choose automatic pasting or copy your text to the clipboard.",
        ),
        content: outputs(),
      },
      {
        title: isMac()
          ? t("Allow Accessibility access")
          : nativePaste()
            ? t("Allow automatic X11 paste")
            : t("Allow keyboard access"),
        detail: isMac()
          ? t(
              "Accessibility access is needed for automatic insertion and advanced triggers. Clipboard-only output remains available.",
            )
          : nativePaste()
            ? t(
                "Enable Ctrl+V pasting into the focused application for this X11 session. No screen capture is requested.",
              )
            : t(
                "Optional permission for automatic pasting. Only keyboard access is requested; no screen capture.",
              ),
        // Clipboard output remains usable without Accessibility access.
        accessibility: true,
        content: `${isMac() && state.paste_ready ? `<p class="success">${esc(t("Accessibility access allowed"))}</p>` : ""}${permissionButton()}${!pasteAvailable() ? `<p class="secondary">${esc(t("Your desktop does not expose this portal. Clipboard output remains available."))}</p>` : ""}`,
      },
      {
        title: t("How do you start the recording?"),
        detail:
          (isMac() && !macToggleOnly()) || state.native_mouse
            ? t(
                "Choose a key, shortcut, or mouse button. Place the cursor in a text field, press the trigger, speak, then press it again.",
              )
            : state.native_x11 || macToggleOnly()
              ? t(
                  "Choose a keyboard key or shortcut. Press it to start recording and press it again to stop.",
                )
              : t(
                  "Choose a shortcut in your desktop’s dialog. Press it to start recording and press it again to stop.",
                ),
        content: `<div class="setup-trigger-panel">${shortcutButton()}</div>`,
      },
    ];
    const modelRequired =
      !hasInstalledSelectedModel() &&
      (setupStep === setupModelStep() || setupStep === panels.length - 1);
    const accessibilityRequired =
      isMac() &&
      state.preferences.output === "paste" &&
      state.paste_ready !== true &&
      setupStep >= 0 &&
      (panels[setupStep] as { accessibility?: boolean } | undefined)
        ?.accessibility === true;
    const navigation = (welcome: boolean) => {
      const permissionFlowActive =
        portalBusy ||
        state.paste_configuring ||
        state.shortcut_configuring ||
        state.recording_shortcut ||
        state.macos?.recording_shortcut === true;
      const disabled =
        permissionFlowActive || pendingPreferences > 0 ? "disabled" : "";
      const primaryDisabled =
        permissionFlowActive ||
        pendingPreferences > 0 ||
        (!welcome && (modelRequired || accessibilityRequired))
          ? "disabled"
          : "";
      return `<footer class="setup-navigation">${welcome ? "" : `<button class="setup-back" data-setup-back ${disabled}>${esc(t("Back"))}</button>`}<span></span>${welcome || setupStep < panels.length - 1 ? `<button class="setup-primary" data-setup-next ${primaryDisabled}>${esc(t("Continue"))}</button>` : `<button class="setup-primary" data-command="complete_setup" ${primaryDisabled}>${esc(t("Finish setup"))}</button>`}</footer>`;
    };
    if (setupStep < 0) {
      content.innerHTML = `<section class="setup-card" aria-labelledby="setup-title"><div class="setup-card-body setup-welcome"><img class="setup-logo" src="./branding/mark-on-dark.svg" width="72" height="72" alt="OpenWhisper"><h1 id="setup-title" tabindex="-1">${esc(t("Speak. OpenWhisper writes with you."))}</h1><p class="setup-intro">${esc(t("OpenWhisper turns speech into text directly on this computer. No account, cloud, or subscription. Your recordings never leave your computer."))}</p><p class="setup-language-label">${esc(t("Interface language"))}</p><div class="setup-language" role="group" aria-label="${esc(t("Interface language"))}"><button data-ui-language="de" aria-pressed="${state.preferences.ui_language === "de"}">Deutsch</button><button data-ui-language="en" aria-pressed="${state.preferences.ui_language === "en"}">${esc(t("English"))}</button></div></div>${navigation(true)}</section>`;
    } else {
      const panel = panels[setupStep]!;
      const setupScrollTop =
        renderedSetupStep === setupStep
          ? (content.querySelector<HTMLElement>(".setup-card-body")
              ?.scrollTop ?? 0)
          : 0;
      renderedSetupStep = setupStep;
      const progress = Array.from(
        { length: panels.length },
        (_, index) =>
          `<span${index === setupStep ? ' class="current"' : ""}></span>`,
      ).join("");
      content.innerHTML = `<section class="setup-card" aria-labelledby="setup-title"><div class="setup-card-body"><div class="setup-segments" aria-hidden="true">${progress}</div><div class="setup-progress" role="status">${esc(t("Step {step} of {total}", { step: setupStep + 1, total: panels.length }))}</div><h1 id="setup-title" tabindex="-1">${esc(panel.title)}</h1><p class="setup-intro">${esc(panel.detail)}</p><div class="setup-panel-content">${panel.content}</div>${modelRequired ? `<p class="setup-footnote setup-model-required" role="status">${esc(t("Download and select a model to continue."))}</p>` : ""}${accessibilityRequired ? `<p class="setup-footnote setup-model-required" role="status">${esc(t("Allow Accessibility access to continue."))}</p>` : ""}${setupStep === panels.length - 1 ? `<p class="setup-footnote">${esc(t("You can change permissions, shortcuts, and recording preferences in General at any time."))}</p>` : ""}</div>${navigation(false)}</section>`;
      const setupBody = content.querySelector<HTMLElement>(".setup-card-body");
      if (setupBody) setupBody.scrollTop = setupScrollTop;
    }
    if (focusSetupTitle) {
      content.querySelector<HTMLElement>("#setup-title")?.focus();
      focusSetupTitle = false;
    }
  } else if (tab === "general") {
    const uiLanguage = `<div class="language-choice" role="group" aria-label="${esc(t("Interface language"))}"><button type="button" data-ui-language="de" aria-pressed="${p.ui_language === "de"}">Deutsch</button><button type="button" data-ui-language="en" aria-pressed="${p.ui_language === "en"}">English</button></div>`;
    const systemDetails = isMac()
      ? row(
          t("System"),
          `<span class="settings-system-status">${esc(state.desktop)} · ${esc(state.session)}</span>`,
        )
      : (state.native_x11
          ? row(
              t("Native X11 triggers"),
              `<span class="settings-system-status">${esc(t("Available"))}</span>`,
            )
          : "") +
        (state.native_paste
          ? row(
              t("Native X11 paste"),
              `<span class="settings-system-status">${esc(t("Available"))}</span>`,
            )
          : "") +
        row(
          t("Desktop"),
          `<span class="settings-system-status">${esc(state.desktop)} · ${esc(state.session)}</span>`,
        ) +
        row(
          t("Clipboard helper"),
          state.clipboard_available
            ? `<span class="settings-system-status">${esc(t("Available"))}</span>`
            : `<span class="warning">${esc(t("Install wl-clipboard (Wayland) or xclip (X11)"))}</span>`,
        ) +
        row(
          t("Global shortcuts portal"),
          `<span class="settings-system-status">${esc(t(state.shortcut_portal ? "Available" : "Unavailable"))}</span>`,
        ) +
        row(
          t("Keyboard portal"),
          `<span class="settings-system-status">${esc(t(state.paste_portal ? "Available" : "Unavailable"))}</span>`,
        );
    content.innerHTML =
      section(
        "",
        row(t("Interface language"), uiLanguage) +
          `<label class="row launch-at-login-row" title="${esc(state.launch_at_login_available === false ? t(state.profile === "development" ? "Launch at login is available in an installed version of OpenWhisper." : "Launch at login is unavailable in this installation.") : "")}"><span>${esc(t("Launch at login"))}</span><input class="switch" type="checkbox" data-pref="launch_at_login" ${p.launch_at_login ? "checked" : ""} ${state.launch_at_login_available === false ? "disabled" : ""}></label>` +
          (state.macos?.launch_at_login_pending
            ? `<div class="row approval"><span>${esc(t("Allow OpenWhisper in System Settings to finish enabling launch at login."))}</span><button data-command="open_login_settings">${esc(t("System Settings"))}</button></div>`
            : ""),
      ) +
      section(
        t("Recognition"),
        (macCpuOnly() ? "" : recognitionModeControl(false, false)) +
          `<div class="recognition-mode-footer"><p class="secondary" id="recognition-backend">${esc(macCpuOnly() ? recognitionHardwareStatus() : recognitionModeStatus())}</p><button type="button" id="manage-models" data-open-model-drawer>${esc(t("Manage models"))}</button></div>`,
      ) +
      section(t("System"), systemDetails);
  } else if (tab === "recording") {
    const overlayDescription = t(
      "Also show the indicator while idle when OpenWhisper is in the background.",
    );
    const overlayControl =
      isMac() || state.overlay_available
        ? `<label class="row setting-description-row"><span><span>${esc(t("Floating recording indicator"))}</span><small class="settings-row-description">${esc(overlayDescription)}</small></span><input class="switch" type="checkbox" data-pref="show_idle_overlay" ${p.show_idle_overlay ? "checked" : ""}></label>`
        : row(
            `${esc(t("Floating recording indicator"))}<small class="settings-row-description">${esc(overlayDescription)}</small>`,
            `<span class="warning">${esc(
              t(
                state.overlay_unavailable_reason === "runtime"
                  ? "Floating controls could not start. Check the GTK 3 and gtk-layer-shell runtime libraries, then restart OpenWhisper. Use the main window controls meanwhile."
                  : state.overlay_unavailable_reason === "unsupported"
                    ? "This Wayland compositor does not support layer-shell recording controls. Use the main window controls."
                    : "Floating controls are unavailable. Use the main window controls.",
              ),
            )}</span>`,
          );
    const triggerCaption = `<small class="settings-row-description">${esc(t(state.native_mouse ? "Key, shortcut, or mouse button" : "Key or shortcut"))}</small>`;
    const outputCaption = `<small class="settings-row-description">${esc(
      t(
        isMac()
          ? "Insert uses Accessibility access; Copy uses the clipboard."
          : "Insert uses keyboard access; Copy uses the clipboard.",
      ),
    )}</small>`;
    const recordingMode = row(
      t("Mode"),
      `<select data-pref="hold_to_record" aria-label="${esc(t("Recording mode"))}" ${modifierOnlyTrigger() || macToggleOnly() ? "disabled" : ""}>${option("false", t("Toggle"), String(p.hold_to_record))}${option("true", t("Push to talk"), String(p.hold_to_record))}</select>`,
    );
    const modeNote =
      (modifierOnlyTrigger()
        ? `<p class="secondary">${esc(t("Modifier-only triggers use toggle mode. Use a regular key or mouse button for push to talk."))}</p>`
        : "") +
      (macToggleOnly()
        ? `<p class="secondary">${esc(t("Regular keyboard shortcuts use toggle mode in this build."))}</p>`
        : "");
    const microphoneAccess = isMac()
      ? row(
          t("Microphone access"),
          `${macPermissionStatus(state.macos?.microphone_allowed === true)}<button data-command="allow_microphone">${esc(t("System Settings"))}</button>`,
        ) + row(t("Microphone"), microphoneControl())
      : row(t("Microphone"), microphoneControl());
    const permissions =
      row(
        isMac()
          ? t("Accessibility access")
          : nativePaste()
            ? t("Automatic X11 paste")
            : t("Keyboard access"),
        `${isMac() ? macPermissionStatus(state.paste_ready === true) : ""}${permissionButton()}`,
      ) +
      `<p class="secondary">${esc(
        isMac()
          ? t("Accessibility access is used for automatic insertion.")
          : nativePaste()
            ? t(
                "Enable Ctrl+V pasting into the focused application for this X11 session. No screen capture is requested.",
              )
            : t(
                "Keyboard access is needed for automatic pasting. Portal permission may need to be enabled again after restarting the app.",
              ),
      )}</p>`;
    const outputExtras =
      isMac() &&
      state.macos?.clipboard_restore_available !== false &&
      p.output === "paste"
        ? toggle(
            t("Restore the previous clipboard afterward"),
            "restore_clipboard",
            !!p.restore_clipboard,
          )
        : "";
    content.innerHTML =
      section(
        t("Keyboard"),
        row(`${esc(t("Trigger"))}${triggerCaption}`, shortcutButton(true)) +
          recordingMode +
          modeNote,
        "",
        "settings-recording-primary",
      ) +
      section(
        t("Output"),
        row(`${esc(t("Output"))}${outputCaption}`, settingOutputs()) +
          outputExtras +
          overlayControl +
          (isMac()
            ? toggle(
                t("Play start and stop sounds"),
                "play_sounds",
                !!p.play_sounds,
              )
            : ""),
        "",
        "settings-recording-output",
      ) +
      section(
        t("Language"),
        row(t("Language"), languages()) +
          (p.model.startsWith("parakeet")
            ? `<p class="secondary">${esc(t("The active Parakeet model detects the language automatically. This selection only applies to Whisper models."))}</p>`
            : ""),
        "",
        "settings-recording-language",
      ) +
      section(
        t("Microphone"),
        microphoneAccess,
        "",
        "settings-recording-microphone",
      ) +
      section(
        t("Permissions"),
        permissions,
        "",
        "settings-recording-permissions",
      );
  } else if (tab === "permissions") {
    const microphoneRow = `<div class="permission-row"><div class="permission-row-copy"><strong>${esc(t("Microphone"))}</strong><span>${esc(t("Records your voice. Audio stays on this device."))}</span>${microphonePermissionGranted() ? "" : `<small>${esc(microphonePermissionDetail())}</small>`}</div><span class="permission-badge ${microphonePermissionGranted() ? "permission-badge-ok" : "permission-badge-warning"}">${esc(t(microphonePermissionGranted() ? "Allowed" : "Required · missing"))}</span>${microphonePermissionGranted() ? `<button type="button" disabled>${esc(t("Allowed"))}</button>` : isMac() ? `<button type="button" data-command="allow_microphone">${esc(t(state.macos?.microphone_permission === "not-determined" ? "Allow microphone access" : "System Settings"))}</button>` : `<button type="button" data-command="refresh_microphones">${esc(t("Check again"))}</button>`}</div>`;
    const accessibilityRow = `<div class="permission-row"><div class="permission-row-copy"><strong>${esc(isMac() ? t("Accessibility access") : t("Keyboard access"))}</strong><span>${esc(t("Recognizes your shortcut and inserts text into the active window."))}</span>${accessibilityPermissionGranted() ? "" : `<small>${esc(t("Text is copied instead. Allow keyboard access to insert it automatically."))}</small>`}</div><span class="permission-badge ${accessibilityPermissionGranted() ? "permission-badge-ok" : "permission-badge-accessibility"}">${esc(t(accessibilityPermissionGranted() ? "Allowed" : pasteAvailable() ? "Optional · missing" : "Unavailable"))}</span>${accessibilityPermissionGranted() ? `<button type="button" disabled>${esc(t("Allowed"))}</button>` : permissionButton()}</div>`;
    content.innerHTML = section(
      t("Permissions"),
      `<div class="permission-list">${microphoneRow}${accessibilityRow}</div><p class="secondary">${esc(t("Permission status refreshes automatically when OpenWhisper returns to the foreground."))}</p>`,
    );
  } else if (tab === "models") {
    content.innerHTML =
      section(
        "",
        `<strong>${esc(t("Your computer:"))} ${esc(state.desktop)} · ${esc(state.session)}</strong><p class="secondary">${esc(t("Current recognition device: {device}", { device: recognitionHardwareStatus() }))}</p>`,
      ) +
      (state.profile === "development"
        ? section(
            t("Development model directory"),
            `<p class="secondary" id="development-model-directory" style="overflow-wrap:anywhere">${esc(state.model_directory)}</p>`,
          )
        : "") +
      section(
        "NVIDIA Parakeet",
        state.models
          .filter((m) => m.family === "parakeet")
          .map((model) => modelRow(model))
          .join(""),
        t(
          "25 European languages, including German, English, French, Spanish, Italian, Polish, Dutch, and Ukrainian. Detects the language automatically.",
        ),
      ) +
      section(
        "OpenAI Whisper",
        state.models
          .filter((m) => m.family === "whisper")
          .map((model) => modelRow(model))
          .join(""),
        t(
          "About 99 languages, including Chinese, Japanese, Korean, and Turkish. Supports a fixed language and custom vocabulary.",
        ),
      ) +
      section(
        "",
        (isMac()
          ? `<button data-command="import_model">${esc(t("Import a model …"))}</button> `
          : "") +
          `<button id="show-models">${esc(t("Show in file manager"))}</button>`,
        isMac()
          ? t(
              "All models run locally using whisper.cpp. Download once from Hugging Face or import a compatible ggml file.",
            )
          : t(
              "All models run locally using whisper.cpp. Download once from Hugging Face; downloads are checked against its SHA-256 metadata. Custom model import is not yet available on Linux.",
            ),
      );
    content
      .querySelector("#show-models")!
      .addEventListener("click", () => void command("show_models_folder"));
  } else if (tab === "text") {
    if (snippetDraft === undefined)
      snippetDraft = p.snippets.map((snippet) => ({ ...snippet }));
    const textConnectionSettings = latestConnectionSettings();
    content.innerHTML =
      `<section class="text-processing-card" id="settings-vocabulary"><header class="text-processing-heading"><i class="text-processing-dot vocabulary" aria-hidden="true"></i><div><div class="vocabulary-heading-line"><h2>${esc(t("2 · Vocabulary"))}</h2><span id="vocabulary-save-status" role="status" aria-live="polite">${esc(t("Saved"))}</span></div><p class="text-processing-description">${esc(t("Add proper names and technical terms. Similar-sounding words are corrected to your spelling."))}</p></div></header><div class="text-processing-body"><div class="vocabulary-example"><span>${esc(t("You say “Obsidian”, recognized as"))}</span><del>Opsidian</del><span aria-hidden="true">→</span><strong>Obsidian</strong></div><div class="vocabulary-list" id="vocabulary-list"><div class="vocabulary-table-head"><span>${esc(t("Spelling"))}</span><span>${esc(t("Corrected from"))}</span><span aria-hidden="true"></span></div>${p.vocabulary.map((entry, index) => vocabularyRow(entry, index)).join("")}</div><form id="vocabulary-add-form" class="vocabulary-add-grid"><input id="new-vocabulary-spelling" class="vocabulary-input" data-vocab-focus="new-spelling" aria-label="${esc(t("Spelling"))}" placeholder="${esc(t("Spelling, e.g. Obsidian"))}" maxlength="8192"><input id="new-vocabulary-misheard" class="vocabulary-input" data-vocab-focus="new-misheard" aria-label="${esc(t("Often recognized as"))}" placeholder="${esc(t("Often recognized as … (comma-separated)"))}" maxlength="8192"><button type="submit" class="vocabulary-add-button">${esc(t("Add"))}</button></form><p class="vocabulary-help">${esc(t("Click a spelling to edit it. Add misheard forms with Enter; remove them with ×. Without entries, OpenWhisper still corrects similar-sounding words automatically."))}</p></div></section>` +
      `<section class="text-processing-card" id="settings-snippets"><header class="text-processing-heading"><i class="text-processing-dot snippets" aria-hidden="true"></i><div><h2>${esc(t("Snippets"))}</h2><p class="text-processing-description">${esc(t("Say a trigger word to insert its saved text. Matching ignores letter case, hyphens, and trailing punctuation."))}</p></div></header><div class="text-processing-body"><div id="snippets">${p.snippets.length ? p.snippets.map(snippetRow).join("") : `<p id="empty-snippets" class="secondary">${esc(t("No snippets yet. For example, say “my YouTube link” to insert a URL instead."))}</p>`}</div><div class="snippet-card-actions"><button type="button" id="add-snippet">${esc(t("Add snippet"))}</button></div></div></section>`;
    content.querySelector<HTMLElement>("#settings-snippets h2")!.textContent =
      `${textConnectionSettings.mode === "conversation" ? "3." : "4."} ${t("Snippets")}`;
    content
      .querySelector<HTMLElement>("#settings-snippets")!
      .insertAdjacentHTML(
        "beforeend",
        `<p id="snippet-draft-error" role="status" hidden></p>`,
      );
    content.insertAdjacentHTML(
      "afterbegin",
      `<section class="text-processing-card" id="settings-cleanup"><header class="text-processing-heading"><i class="text-processing-dot cleanup" aria-hidden="true"></i><div><h2>1. ${esc(t("Cleanup"))}</h2><p class="text-processing-description">${esc(t("Remove obvious recognition artifacts while preserving your words and meaning."))}</p></div></header><div class="text-processing-body">${toggle(t("Clean up recognized text"), "cleanup_enabled", p.cleanup_enabled)}</div></section>`,
    );
    if (textConnectionSettings.mode === "conversation") {
      content.insertAdjacentHTML(
        "beforeend",
        `<section class="text-processing-card"><label class="text-processing-body"><strong>${esc(t("Conversation instruction"))}</strong><textarea id="conversation-instruction" rows="4" maxlength="8192">${esc(conversationInstructionDraft ?? textConnectionSettings.conversationInstruction)}</textarea></label></section>`,
      );
    } else {
      content
        .querySelector<HTMLElement>("#settings-vocabulary")!
        .insertAdjacentHTML(
          "afterend",
          `<section id="settings-ai-revision">${aiRevisionMarkup(textConnectionSettings, state.text_connections.available)}</section>`,
        );
      bindAiRevision(content, {
        settings: latestConnectionSettings,
        save: saveConnections,
      });
    }
    const vocabularyList =
      content.querySelector<HTMLElement>("#vocabulary-list")!;
    const vocabularyStatus = content.querySelector<HTMLElement>(
      "#vocabulary-save-status",
    )!;
    const vocabularyDraft: VocabEntry[] = p.vocabulary.map((entry) => ({
      ...entry,
      misheard: [...entry.misheard],
    }));
    let vocabularyRevision = 0;
    let restoreVocabularyFocus: string | undefined;
    const setVocabularyStatus = (message: string) => {
      vocabularyStatus.textContent = t(message);
    };
    const focusVocabulary = (focus: string | undefined) => {
      if (!focus) return;
      const input =
        Array.from(
          vocabularyList.querySelectorAll<HTMLInputElement>(
            "input[data-vocab-focus]",
          ),
        ).find((candidate) => candidate.dataset.vocabFocus === focus) ??
        Array.from(
          content.querySelectorAll<HTMLInputElement>("input[data-vocab-focus]"),
        ).find((candidate) => candidate.dataset.vocabFocus === focus);
      input?.focus();
      if (input && input.selectionStart !== null)
        input.setSelectionRange(input.selectionStart, input.selectionStart);
    };
    const renderVocabularyRows = (focus?: string, aliasValue?: string) => {
      vocabularyList
        .querySelectorAll(".vocabulary-row")
        .forEach((row) => row.remove());
      vocabularyList.insertAdjacentHTML(
        "beforeend",
        vocabularyDraft
          .map((entry, index) =>
            vocabularyRow(
              entry,
              index,
              focus === `alias-${index}` ? aliasValue : "",
            ),
          )
          .join(""),
      );
      if (focus) focusVocabulary(focus);
    };
    const saveVocabularyDraft = async () => {
      const revision = vocabularyRevision;
      if (vocabularyEntriesHaveConflicts(vocabularyDraft)) {
        setVocabularyStatus("A misheard form can belong to only one spelling.");
        return true;
      }
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.dataset.vocabFocus
          : undefined;
      const focus = restoreVocabularyFocus ?? active;
      const ok = await writePreferences({
        vocabulary: vocabularyDraft.map((entry) => ({
          ...entry,
          misheard: [...entry.misheard],
        })),
      });
      if (!ok) {
        setVocabularyStatus("Could not save vocabulary.");
        return false;
      }
      if (revision === vocabularyRevision) {
        setVocabularyStatus("Saved");
        restoreVocabularyFocus = undefined;
        focusVocabulary(focus);
      }
      return true;
    };
    const scheduleVocabularySave = (focus?: string, immediate = false) => {
      vocabularyRevision++;
      restoreVocabularyFocus = focus ?? restoreVocabularyFocus;
      setVocabularyStatus("Saving …");
      void settingsAutosave
        .save("vocabulary", saveVocabularyDraft, immediate ? 0 : 450)
        .then((saved) => {
          if (!saved) setVocabularyStatus("Could not save vocabulary.");
        });
    };
    vocabularyList.addEventListener("input", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      const row = input.closest<HTMLElement>(".vocabulary-row");
      const index = Number(row?.dataset.vocabularyIndex);
      if (!Number.isInteger(index) || !vocabularyDraft[index]) return;
      if (input.matches("[data-vocabulary-spelling]")) {
        const spelling = input.value.trim();
        if (!spelling || input.value !== spelling) return;
        const duplicate = vocabularyDraft.some(
          (entry, entryIndex) =>
            entryIndex !== index &&
            vocabularyEntryKey(entry.spelling) === vocabularyEntryKey(spelling),
        );
        if (duplicate) {
          return;
        }
        vocabularyDraft[index]!.spelling = spelling;
        scheduleVocabularySave(input.dataset.vocabFocus);
      } else if (
        input.matches("[data-vocabulary-alias]") &&
        input.value.includes(",")
      ) {
        const parts = input.value.split(",");
        const remainder = parts.pop() ?? "";
        const entry = vocabularyDraft[index]!;
        for (const alias of parts.map((part) => part.trim()).filter(Boolean)) {
          if (
            !entry.misheard.some(
              (value) =>
                vocabularyEntryKey(value) === vocabularyEntryKey(alias),
            )
          )
            entry.misheard.push(alias);
        }
        input.value = remainder;
        renderVocabularyRows(input.dataset.vocabFocus, remainder);
        scheduleVocabularySave(`alias-${index}`, true);
      }
    });
    vocabularyList.addEventListener("focusout", (event) => {
      const input = event.target;
      if (
        !(input instanceof HTMLInputElement) ||
        !input.matches("[data-vocabulary-spelling]")
      )
        return;
      const row = input.closest<HTMLElement>(".vocabulary-row");
      const index = Number(row?.dataset.vocabularyIndex);
      const entry = vocabularyDraft[index];
      if (!entry) return;
      const spelling = input.value.trim();
      if (!spelling) {
        renderVocabularyRows(`spelling-${index}`);
        return;
      }
      const spellingChanged =
        entry.spelling !== spelling || input.value !== spelling;
      const duplicateIndex = vocabularyDraft.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          vocabularyEntryKey(candidate.spelling) ===
            vocabularyEntryKey(spelling),
      );
      if (duplicateIndex >= 0) {
        const duplicate = vocabularyDraft[duplicateIndex]!;
        for (const alias of entry.misheard) {
          if (
            !duplicate.misheard.some(
              (value) =>
                vocabularyEntryKey(value) === vocabularyEntryKey(alias),
            )
          ) {
            duplicate.misheard.push(alias);
          }
        }
        vocabularyDraft.splice(index, 1);
        const targetIndex =
          duplicateIndex > index ? duplicateIndex - 1 : duplicateIndex;
        renderVocabularyRows(`spelling-${targetIndex}`);
        scheduleVocabularySave(`spelling-${targetIndex}`, true);
        return;
      }
      entry.spelling = spelling;
      if (input.value !== spelling) renderVocabularyRows(`spelling-${index}`);
      if (spellingChanged) scheduleVocabularySave(`spelling-${index}`, true);
    });
    vocabularyList.addEventListener("keydown", (event) => {
      const input = event.target;
      if (
        !(input instanceof HTMLInputElement) ||
        !input.matches("[data-vocabulary-alias]")
      )
        return;
      if (event.key !== "Enter" && event.key !== ",") return;
      event.preventDefault();
      const index = Number(
        input.closest<HTMLElement>(".vocabulary-row")?.dataset.vocabularyIndex,
      );
      const entry = vocabularyDraft[index];
      if (!entry) return;
      for (const alias of correctionParts(input.value)) {
        if (
          !entry.misheard.some(
            (value) => vocabularyEntryKey(value) === vocabularyEntryKey(alias),
          )
        )
          entry.misheard.push(alias);
      }
      renderVocabularyRows(`alias-${index}`, "");
      scheduleVocabularySave(`alias-${index}`, true);
    });
    vocabularyList.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "[data-remove-vocabulary-alias], [data-remove-vocabulary-entry]",
      );
      if (!button) return;
      const row = button.closest<HTMLElement>(".vocabulary-row");
      const index = Number(row?.dataset.vocabularyIndex);
      const entry = vocabularyDraft[index];
      if (!entry) return;
      if (button.hasAttribute("data-remove-vocabulary-entry"))
        vocabularyDraft.splice(index, 1);
      else
        entry.misheard.splice(Number(button.dataset.removeVocabularyAlias), 1);
      renderVocabularyRows(
        `alias-${Math.max(0, Math.min(index, vocabularyDraft.length - 1))}`,
        "",
      );
      scheduleVocabularySave(undefined, true);
    });
    const addForm = content.querySelector<HTMLFormElement>(
      "#vocabulary-add-form",
    )!;
    const newSpelling = addForm.querySelector<HTMLInputElement>(
      "#new-vocabulary-spelling",
    )!;
    const newMisheard = addForm.querySelector<HTMLInputElement>(
      "#new-vocabulary-misheard",
    )!;
    addForm.onsubmit = (event) => {
      event.preventDefault();
      const spelling = newSpelling.value.trim();
      if (!spelling) {
        newSpelling.focus();
        return;
      }
      const aliases = correctionParts(newMisheard.value);
      const existing = vocabularyDraft.find(
        (entry) =>
          vocabularyEntryKey(entry.spelling) === vocabularyEntryKey(spelling),
      );
      if (existing) {
        for (const alias of aliases) {
          if (
            !existing.misheard.some(
              (value) =>
                vocabularyEntryKey(value) === vocabularyEntryKey(alias),
            )
          )
            existing.misheard.push(alias);
        }
      } else vocabularyDraft.push({ spelling, misheard: aliases });
      newSpelling.value = "";
      newMisheard.value = "";
      renderVocabularyRows();
      scheduleVocabularySave("new-spelling", true);
    };
    content
      .querySelector<HTMLTextAreaElement>("#conversation-instruction")
      ?.addEventListener("input", (event) => {
        conversationInstructionDraft = (
          event.currentTarget as HTMLTextAreaElement
        ).value;
        const latest = latestConnectionSettings();
        void saveConnections(
          {
            ...latest,
            conversationInstruction: conversationInstructionDraft,
          },
          450,
        );
      });

    const updateSnippetDraftError = () => {
      const invalid = !!snippetDraft?.some(
        (snippet) => !snippet.trigger.trim() || !snippet.expansion.trim(),
      );
      const error = content.querySelector<HTMLElement>("#snippet-draft-error");
      if (error) {
        error.hidden = !invalid;
        error.textContent = invalid
          ? t("Not saved. Complete each snippet's trigger and text.")
          : "";
      }
      return invalid;
    };
    const renderSnippetDraft = () => {
      const target = content.querySelector<HTMLElement>("#snippets")!;
      target.innerHTML = snippetDraft!.length
        ? snippetDraft!.map(snippetRow).join("")
        : `<p id="empty-snippets" class="secondary">${esc(t("No snippets yet. For example, say “my YouTube link” to insert a URL instead."))}</p>`;
      updateSnippetDraftError();
      target
        .querySelectorAll<HTMLButtonElement>("[data-remove]")
        .forEach((button) => {
          button.onclick = () => {
            snippetDraft!.splice(
              Number(
                button.closest<HTMLElement>(".snippet-row")?.dataset.index,
              ),
              1,
            );
            if (!snippetDraft!.length) snippetDraft = [];
            renderSnippetDraft();
            saveSnippetDraft(0);
          };
        });
      target
        .querySelectorAll<HTMLElement>(".snippet-row")
        .forEach((row, index) => {
          row.dataset.index = String(index);
          row.querySelector<HTMLInputElement>("[name=enabled]")!.onchange = (
            inputEvent,
          ) => {
            snippetDraft![index]!.enabled = (
              inputEvent.currentTarget as HTMLInputElement
            ).checked;
            saveSnippetDraft(0);
          };
          row.querySelector<HTMLInputElement>("[name=trigger]")!.oninput = (
            inputEvent,
          ) => {
            snippetDraft![index]!.trigger = (
              inputEvent.currentTarget as HTMLInputElement
            ).value;
            updateSnippetDraftError();
            saveSnippetDraft(450);
          };
          row.querySelector<HTMLTextAreaElement>("[name=expansion]")!.oninput =
            (inputEvent) => {
              snippetDraft![index]!.expansion = (
                inputEvent.currentTarget as HTMLTextAreaElement
              ).value;
              updateSnippetDraftError();
              saveSnippetDraft(450);
            };
        });
    };
    const saveSnippetDraft = (delayMs: number) => {
      if (!snippetDraft) return;
      const snapshot = snippetDraft.map((snippet) => ({ ...snippet }));
      const revision = ++snippetRevision;
      if (
        snapshot.some(
          (snippet) => !snippet.trigger.trim() || !snippet.expansion.trim(),
        )
      ) {
        updateSnippetDraftError();
        void settingsAutosave.save("snippets", async () => false, delayMs);
        return;
      }
      updateSnippetDraftError();
      void settingsAutosave
        .save(
          "snippets",
          () => writePreferences({ snippets: snapshot }),
          delayMs,
        )
        .then((saved) => {
          if (saved && revision === snippetRevision) {
            contentKey = "";
            render();
          }
        });
    };
    content.querySelector("#add-snippet")!.addEventListener("click", () => {
      snippetDraft ??= [];
      snippetDraft.push({
        id: crypto.randomUUID(),
        trigger: "",
        expansion: "",
        enabled: true,
      });
      renderSnippetDraft();
      saveSnippetDraft(0);
      content
        .querySelector<HTMLInputElement>(
          ".snippet-row:last-child [name=trigger]",
        )
        ?.focus();
    });
    renderSnippetDraft();
  } else if (tab === "connections") {
    aiModelsSettings.render(content);
    if (!connectionScanStarted) void scanConnections();
  } else if (tab === "history") {
    const historyBytes = state.history.reduce(
      (bytes, text) => bytes + new TextEncoder().encode(text).byteLength,
      0,
    );
    const historySize =
      historyBytes < 1024
        ? `${historyBytes} B`
        : `${new Intl.NumberFormat(p.ui_language === "de" ? "de-DE" : "en-US", {
            maximumFractionDigits: 1,
          }).format(historyBytes / 1024)} KB`;
    content.innerHTML = section(
      "",
      `<label class="row setting-description-row"><span><span>${esc(t("Save history"))}</span><small class="settings-row-description">${esc(t("Keep the last 20 recordings locally."))}</small></span><input class="switch" type="checkbox" data-pref="keep_history" ${p.keep_history ? "checked" : ""}></label>` +
        `<div class="row history-storage-stats" title="${esc(t("Separate transcript files are not included."))}"><span>${esc(t("Stored history text"))}</span><div class="control"><span>${esc(t("{count} recordings · {size}", { count: String(state.history.length), size: historySize }))}</span></div></div>` +
        row(
          t("Transcripts folder"),
          `<button type="button" data-command="show_transcripts_folder">${esc(t("Show in file manager"))}</button>`,
        ) +
        row(
          t("History"),
          `<button type="button" data-clear-history id="clear-history" class="history-delete-all" ${state.history.length ? "" : "disabled"}>${esc(t("Delete all"))}</button>`,
        ),
      "",
      "settings-history-controls",
    );
    bindHistoryActions(content);
  } else {
    content.innerHTML = `<div class="about-brand"><img src="./branding/icon-bordered.svg" width="72" height="72" alt="${esc(t("OpenWhisper app icon"))}"><div class="about-copy">${wordmark()}<p>${esc(t("Local speech recognition for macOS and Linux"))}</p><span class="version-badge">${esc(t("Version {version}", { version: state.version }))}${state.profile === "development" && state.development_build ? ` · ${esc(t("Dev build {build}", { build: state.development_build }))}` : ""}</span></div></div><p class="about-description">${esc(t("Open source and free to use, with no account, subscription, or API key. Speech is recognized on your computer with Whisper or Parakeet; after the model is downloaded, dictation works offline."))}</p><div class="about-links"><button type="button" class="about-link" data-project-link="repository" aria-label="${esc(t("GitHub"))}"><span>${esc(t("GitHub"))}</span><small>${esc(t("Browse the source and project updates."))}</small></button><button type="button" class="about-link" data-project-link="issues" aria-label="${esc(t("Report an issue"))}"><span>${esc(t("Report an issue"))}</span><small>${esc(t("Report a bug or request a change."))}</small></button><button type="button" class="about-link" data-project-link="license" aria-label="${esc(t("MIT License"))}"><span>${esc(t("MIT License"))}</span><small>${esc(t("View the project license."))}</small></button></div>`;
    content.insertAdjacentHTML(
      "beforeend",
      `<section id="about-updates" class="about-updates"><h2>${esc(t("Updates"))}</h2><div class="group"><div class="row about-update-row"><span><span class="about-update-title"><i class="about-update-dot" id="about-update-dot" aria-hidden="true"></i><span id="about-update-status" aria-live="polite"></span></span><small class="settings-row-description" id="about-update-summary" hidden></small></span><div class="control"><button type="button" id="about-update-action"></button></div></div><label class="row setting-description-row" id="about-auto-updates"><span><span>${esc(t("Automatically check for updates"))}</span><small class="settings-row-description">${esc(t("At startup, at most once per hour, and after resuming."))}</small></span><input class="switch" type="checkbox" data-pref="auto_check_updates" ${p.auto_check_updates ? "checked" : ""}></label></div></section>`,
    );
    syncAboutUpdates();
  }
  main.scrollTop = scrollTop;
  if (modelFocusRestorePending) {
    document.querySelector<HTMLElement>(".dictation-change-model")?.focus();
    modelFocusRestorePending = false;
  }
  content
    .querySelectorAll<HTMLButtonElement>("[data-command]")
    .forEach((b) => (b.onclick = () => void command(b.dataset.command!)));
  content
    .querySelectorAll<HTMLButtonElement>("[data-project-link]")
    .forEach((button) => {
      button.onclick = () => {
        const target = button.dataset.projectLink;
        if (
          target === "repository" ||
          target === "issues" ||
          target === "license"
        )
          void command("open_project_link", { target });
      };
    });
  content
    .querySelector<HTMLButtonElement>("#about-update-action")
    ?.addEventListener("click", (event) => {
      if (
        [
          "available",
          "downloading",
          "verifying",
          "ready",
          "installing",
        ].includes(state.updates.status) ||
        (state.updates.status === "checking" && !!state.updates.version) ||
        (state.updates.status === "error" && !!state.updates.version)
      )
        openUpdateDialog(event.currentTarget as HTMLElement);
      else if (state.updates.configured && state.updates.status !== "checking")
        void command("check_updates");
    });
  content
    .querySelectorAll<HTMLDetailsElement>("[data-model-family]")
    .forEach((details) =>
      details.addEventListener("toggle", () => {
        if (!details.isConnected) return;
        const family = details.dataset.modelFamily;
        if (!family) return;
        if (details.open) expandedModelFamilies.add(family);
        else expandedModelFamilies.delete(family);
      }),
    );
  content
    .querySelector<HTMLButtonElement>("[data-setup-next]")
    ?.addEventListener("click", () => {
      if (setupStep === setupModelStep() && !hasInstalledSelectedModel()) {
        notice("Download and select a model to continue.");
        return;
      }
      if (pendingPreferences > 0) return;
      setupStep = Math.min(setupStep + 1, setupStepCount() - 1);
      focusSetupTitle = true;
      contentKey = "";
      render();
    });
  content
    .querySelector<HTMLButtonElement>("[data-setup-back]")
    ?.addEventListener("click", () => {
      if (pendingPreferences > 0) return;
      setupStep = Math.max(setupStep - 1, -1);
      focusSetupTitle = true;
      contentKey = "";
      render();
    });
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
              : input.dataset.pref === "hold_to_record" ||
                  input.dataset.pref === "gpu"
                ? input.value === "true"
                : input.value;
          if (input.dataset.pref === "output") void selectOutput(String(value));
          else void preference(input.dataset.pref!, value);
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
  bindModelActions(content);
}
function nativePaste() {
  return !isMac() && !!state.native_paste && !state.paste_portal;
}
function pasteAvailable() {
  return state.paste_portal || !!state.native_paste;
}
/** macOS permissions are granted in System Settings; show whether macOS currently reports access. */
function macPermissionStatus(allowed: boolean) {
  return `<span class="permission-status ${allowed ? "success" : "secondary"}">${esc(t(allowed ? "Allowed" : "Not allowed"))}</span>`;
}
function permissionButton() {
  const pending = !isMac() && state.paste_configuring;
  return `<button data-portal="${state.paste_ready || pending ? "disable_paste" : "enable_paste"}" ${!pasteAvailable() || portalBusy ? "disabled" : ""}>${pending ? t("Cancel") : state.paste_ready ? (isMac() ? t("System Settings") : t("Revoke")) : t("Allow")}</button>`;
}
function updateStatus() {
  const u = state.updates;
  switch (u.status) {
    case "checking":
      return t("Checking for updates …");
    case "current":
      return t("You have the latest version.");
    case "available":
      return t("Version {version} is available.", { version: u.version ?? "" });
    case "downloading": {
      const received = formatUpdateSize(u.download?.received ?? 0);
      const total = u.download?.total;
      return total && total > 0
        ? t("Downloading update: {received} of {total}", {
            received,
            total: formatUpdateSize(total),
          })
        : t("Downloading update: {received}", { received });
    }
    case "verifying":
      return t("Verifying update …");
    case "ready":
      return t("Update ready to install");
    case "installing":
      return t("Installing update …");
    case "error":
      return t("Update failed: {error}", {
        error: t(u.error ?? "Unknown error"),
      });
    default:
      return t("Not checked yet.");
  }
}

function updateButtonLabel() {
  const update = state.updates;
  switch (update.status) {
    case "available":
      return t("Update");
    case "checking":
      return t("Checking");
    case "downloading":
      return update.download?.total
        ? `${Math.round((update.download.received / update.download.total) * 100)}%`
        : t("Downloading update");
    case "verifying":
      return t("Verifying update …");
    case "ready":
      return t("Update ready");
    case "installing":
      return t("Update");
    case "current":
      return t("Up to date");
    case "error":
      return update.version ? t("Update") : t("Update error");
    default:
      return t("Updates");
  }
}

function modifierOnlyTrigger() {
  const trigger = state.preferences.native_trigger;
  return (
    !isMac() &&
    !state.native_x11 &&
    !!state.native_shortcuts &&
    trigger?.kind === "key" &&
    (trigger.key & 0x01ffffff) >= 0x01000020 &&
    (trigger.key & 0x01ffffff) <= 0x01000023
  );
}
function mouseButtonLabel(button: number) {
  if (button === 2) return t("Middle mouse button");
  if (button === 8) return t("Mouse back button");
  if (button === 9) return t("Mouse forward button");
  return t("Mouse button {number}", { number: String(button - 4) });
}
function triggerLabel() {
  const macMouse = isMac() ? /^Mouse(\d)$/u.exec(state.shortcut ?? "") : null;
  if (macMouse) return mouseButtonLabel(Number(macMouse[1]));
  const trigger = state.preferences.native_trigger;
  if (
    !isMac() &&
    !state.native_x11 &&
    state.native_shortcuts &&
    trigger?.kind === "mouse"
  ) {
    return mouseButtonLabel(trigger.button);
  }
  return state.shortcut ?? t("Set trigger …");
}
function shortcutBusy() {
  return (
    portalBusy ||
    ["recording", "transcribing"].includes(state.status) ||
    ["downloading", "installing"].includes(state.updates.status)
  );
}
function shortcutButton(compact = false) {
  const captureHint = state.shortcut_configuring
    ? t("Choose a shortcut in your desktop’s dialog.")
    : isMac() && state.macos!.recording_shortcut
      ? t(state.macos!.shortcut_hint)
      : !isMac() && state.recording_shortcut
        ? t(
            state.native_x11 || !state.native_mouse
              ? "Press and release a keyboard key. Escape cancels."
              : "Press and release a key or mouse button. Escape cancels.",
          )
        : "";
  if (captureHint)
    return compact
      ? `<span class="secondary" role="status">${esc(captureHint)}</span> <button data-command="cancel_shortcut">${esc(t("Cancel"))}</button>`
      : `<div class="setup-trigger-capture" role="status"><span>${esc(captureHint)}</span><button type="button" data-command="cancel_shortcut">${esc(t("Cancel"))}</button></div>`;
  const busy = shortcutBusy();
  const disabled =
    (!state.shortcut_portal && !state.native_shortcuts) || busy
      ? "disabled"
      : "";
  const value = state.shortcut ? triggerLabel() : t("Set trigger …");
  return compact
    ? `<button type="button" class="settings-trigger-button" data-portal="enable_shortcut" ${disabled}>${esc(value)}</button>`
    : state.shortcut
      ? `<button type="button" class="setup-trigger-button" data-portal="enable_shortcut" aria-label="${esc(value)}" ${disabled}><span class="setup-trigger-key">${esc(value)}</span><span class="setup-trigger-hint">${esc(t("Click to change"))}</span></button>`
      : `<button type="button" class="setup-trigger-button" data-portal="enable_shortcut" aria-label="${esc(value)}" ${disabled}><span class="setup-trigger-key">${symbol("M3 5h18v14H3zM7 9h2m3 0h2m3 0h2M7 13h2m3 0h2m3 0h2M7 17h2m3 0h2m3 0h2")}</span><span class="setup-trigger-hint">${esc(value)}</span></button>`;
}

// Explicit native setup must not activate focused buttons or edit settings.
for (const name of ["keydown", "keyup"] as const)
  window.addEventListener(
    name,
    (event) => {
      if (state?.recording_shortcut) event.preventDefault();
    },
    { capture: true },
  );
// Capture buttons only in explicit setup. Normal browser navigation and primary
// clicks (including Cancel) keep their normal behavior outside this setup.
for (const name of ["mousedown", "mouseup", "auxclick"] as const)
  window.addEventListener(
    name,
    (event) => {
      if (
        overlay ||
        !event.isTrusted ||
        !state?.recording_shortcut ||
        !state.native_mouse
      )
        return;
      const button =
        event.button === 1
          ? 2
          : event.button === 3
            ? 8
            : event.button === 4
              ? 9
              : undefined;
      if (button === undefined) return;
      event.preventDefault();
      if (name === "mousedown") mouseTriggerCandidate = button;
      else if (name === "mouseup" && mouseTriggerCandidate === button) {
        mouseTriggerCandidate = undefined;
        void invoke("capture_mouse_trigger", { button }).catch(() =>
          notice(
            t(
              "Shortcut setup or recording failed. Window recording remains usable.",
            ),
          ),
        );
      }
    },
    { capture: true },
  );
window.addEventListener("blur", () => {
  mouseTriggerCandidate = undefined;
});
function snippetRow(s?: Snippet) {
  return `<div class="snippet-row" data-id="${esc(s?.id ?? crypto.randomUUID())}"><input class="switch" type="checkbox" name="enabled" aria-label="${esc(t("Enable snippet"))}" ${!s || s.enabled ? "checked" : ""}><input name="trigger" aria-label="${esc(t("When I say"))}" placeholder="${esc(t("When I say …"))}" value="${esc(s?.trigger ?? "")}" maxlength="128"><span>→</span><textarea name="expansion" aria-label="${esc(t("Insert"))}" placeholder="${esc(t("… insert"))}" rows="2">${esc(s?.expansion ?? "")}</textarea><button type="button" data-remove aria-label="${esc(t("Remove snippet"))}">×</button></div>`;
}

function vocabularyRow(entry: VocabEntry, index: number, aliasDraft = "") {
  const chips = entry.misheard
    .map(
      (alias, aliasIndex) =>
        `<span class="vocabulary-chip">${esc(alias)}<button type="button" data-remove-vocabulary-alias="${aliasIndex}" data-vocab-focus="alias-${index}" aria-label="${esc(t("Remove correction {text}", { text: alias }))}">×</button></span>`,
    )
    .join("");
  const placeholder = entry.misheard.length
    ? t("+ more")
    : t("Add a misheard form …");
  return `<div class="vocabulary-row" data-vocabulary-index="${index}"><input class="vocabulary-spelling" data-vocabulary-spelling data-vocab-focus="spelling-${index}" aria-label="${esc(t("Spelling"))}" value="${esc(entry.spelling)}"><div class="vocabulary-chips">${chips}<input class="vocabulary-alias-input" data-vocabulary-alias data-vocab-focus="alias-${index}" aria-label="${esc(t("Add a misheard form"))}" placeholder="${esc(placeholder)}" value="${esc(aliasDraft)}"></div><button class="vocabulary-remove-entry" type="button" data-remove-vocabulary-entry aria-label="${esc(t("Remove vocabulary entry {text}", { text: entry.spelling }))}" title="${esc(t("Remove entry"))}">×</button></div>`;
}

function mergeVocabularyCorrection(
  entries: readonly VocabEntry[],
  spelling: string,
  misheard: string,
): VocabEntry[] {
  const next = entries.map((entry) => ({
    ...entry,
    misheard: [...entry.misheard],
  }));
  const existing = next.find(
    (entry) =>
      vocabularyEntryKey(entry.spelling) === vocabularyEntryKey(spelling),
  );
  if (existing) {
    if (
      !existing.misheard.some(
        (value) => vocabularyEntryKey(value) === vocabularyEntryKey(misheard),
      )
    ) {
      existing.misheard.push(misheard);
    }
  } else next.push({ spelling, misheard: [misheard] });
  return next;
}

function vocabularyEntriesHaveConflicts(
  entries: readonly VocabEntry[],
): boolean {
  const aliasOwners = new Map<string, string>();
  for (const entry of entries) {
    const ownerSpelling = vocabularyEntryKey(entry.spelling);
    for (const alias of entry.misheard) {
      const key = vocabularyMatchKey(alias);
      if (!key) continue;
      const owner = aliasOwners.get(key);
      if (owner !== undefined && owner !== ownerSpelling) return true;
      if (owner === undefined) aliasOwners.set(key, ownerSpelling);
    }
  }
  return false;
}

function correctionParts(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function bindVocabularyContextActions(main: HTMLElement) {
  main.insertAdjacentHTML(
    "beforeend",
    `<div id="transcript-context-menu" class="transcript-context-menu" role="menu" hidden><button type="button" role="menuitem" id="add-transcript-correction">${esc(t("Add to vocabulary"))}</button></div><dialog id="vocabulary-correction-dialog" class="vocabulary-correction-dialog"><form><h2>${esc(t("Add a correction"))}</h2><label for="corrected-vocabulary-spelling">${esc(t("Corrected spelling"))}</label><input id="corrected-vocabulary-spelling" maxlength="8192" autocomplete="off" placeholder="${esc(t("Enter the correct spelling"))}"><div class="vocabulary-correction-actions"><button type="button" data-cancel-correction>${esc(t("Cancel"))}</button><button type="submit">${esc(t("Add correction"))}</button></div></form></dialog>`,
  );
  const menu = main.querySelector<HTMLElement>("#transcript-context-menu")!;
  const menuButton = main.querySelector<HTMLButtonElement>(
    "#add-transcript-correction",
  )!;
  const dialog = main.querySelector<HTMLDialogElement>(
    "#vocabulary-correction-dialog",
  )!;
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const spellingInput = dialog.querySelector<HTMLInputElement>(
    "#corrected-vocabulary-spelling",
  )!;
  let selectedText = "";
  const hideMenu = () => {
    menu.hidden = true;
  };
  main.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.closest(".dictation-transcript-body .transcript") ||
      selectedHistoryIndex !== null
    )
      return;
    const selection = window.getSelection()?.toString().trim() ?? "";
    if (!selection) return;
    event.preventDefault();
    selectedText = selection;
    menu.hidden = false;
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
    menuButton.focus();
  });
  main.addEventListener("click", (event) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("#transcript-context-menu")
    )
      hideMenu();
  });
  menuButton.addEventListener("click", () => {
    hideMenu();
    spellingInput.value = "";
    dialog.showModal();
    spellingInput.focus();
  });
  dialog
    .querySelector<HTMLButtonElement>("[data-cancel-correction]")!
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const spelling = spellingInput.value.trim();
      if (!spelling || !selectedText) {
        spellingInput.focus();
        return;
      }
      const vocabulary = mergeVocabularyCorrection(
        state.preferences.vocabulary,
        spelling,
        selectedText,
      );
      dialog.close();
      if (vocabularyEntriesHaveConflicts(vocabulary)) {
        notice("A misheard form can belong to only one spelling.");
        return;
      }
      if (await savePreferences({ vocabulary }))
        notice("Added correction to vocabulary.");
    })();
  });
}

async function start() {
  try {
    let receivedStateEvent = false;
    await listen("navigate", (event) => {
      void (async () => {
        if (
          [
            "setup",
            "general",
            "models",
            "snippets",
            "history",
            "about",
          ].includes(event.payload)
        ) {
          if (!(await flushSettings())) return;
          aiModelsSettings.cancelEdit();
          tab = event.payload === "snippets" ? "text" : event.payload;
          contentKey = "";
          render();
        }
      })();
    });
    await listen("state", (event) => {
      receivedStateEvent = true;
      state = event.payload;
      if (!state.recording_shortcut) mouseTriggerCandidate = undefined;
      if (pendingInsertOutput && !isMac()) {
        if (state.paste_ready) {
          pendingInsertOutput = false;
          insertPermissionSawConfiguring = false;
          void preference("output", "paste");
        } else if (state.paste_configuring) {
          insertPermissionSawConfiguring = true;
        } else if (
          !insertPermissionActionPending &&
          insertPermissionSawConfiguring
        ) {
          pendingInsertOutput = false;
          insertPermissionSawConfiguring = false;
        }
      }
      render();
    });
    await listen("recording_telemetry", (event) => {
      if (!state || !isCurrentRecordingTelemetry(state, event.payload)) return;
      state = {
        ...state,
        elapsed: event.payload.elapsed,
        level: event.payload.level,
      };
      syncWaveforms(false);
      const generation = event.payload.generation;
      const sampleAt = performance.now();
      mainWaveform?.push(generation, event.payload.level, sampleAt);
      overlayWaveform?.push(generation, event.payload.level, sampleAt);
      recordControl();
    });
    const initialState = await invoke("get_state");
    if (!receivedStateEvent) state = initialState;
    if (!state.preferences.setup_completed) tab = "setup";
    else if (
      state.initial_tab &&
      ["setup", "general", "models", "snippets", "history", "about"].includes(
        state.initial_tab,
      )
    )
      tab =
        state.initial_tab === "setup"
          ? "general"
          : state.initial_tab === "snippets"
            ? "text"
            : state.initial_tab;
    render();
    document.documentElement.dataset.ready = "true";
  } catch (error) {
    notice(
      t("Could not connect to the desktop backend: {error}", {
        error: String(error),
      }),
    );
  }
}
void start();

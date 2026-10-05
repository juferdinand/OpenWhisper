import { invoke, listen } from "./bridge";
import "./style.css";

interface Snippet {
  id: string;
  trigger: string;
  expansion: string;
  enabled: boolean;
}
interface Preferences {
  model: string;
  language: string;
  microphone: string;
  vocabulary: string;
  snippets: Snippet[];
  output: string;
  hold_to_record: boolean;
  gpu: boolean;
  keep_history: boolean;
  restore_clipboard?: boolean;
  play_sounds?: boolean;
  show_idle_overlay?: boolean;
  launch_at_login?: boolean;
  auto_check_updates?: boolean;
}
interface Model {
  id: string;
  title: string;
  family: string;
  size: string;
  note: string;
}
interface MacState {
  microphone_allowed: boolean;
  recording_shortcut: boolean;
  shortcut_hint: string;
  editor: string;
  recommended: string[];
  updates_configured: boolean;
  update_status: string;
  can_install_update: boolean;
  update_busy: boolean;
}
interface State {
  initial_tab?: Tab;
  platform: string;
  macos?: MacState;
  version: string;
  status: string;
  message: string;
  transcript: string;
  history: string[];
  preferences: Preferences;
  models: Model[];
  installed: string[];
  microphones: string[];
  session: string;
  desktop: string;
  clipboard_available: boolean;
  shortcut_portal: boolean;
  paste_portal: boolean;
  shortcut: string | null;
  paste_ready: boolean;
  gpu_available: boolean;
  download: string | null;
  progress: number;
  elapsed: number;
  model_directory: string;
}
type Tab = "setup" | "general" | "models" | "snippets" | "history" | "about";
let state: State;
let tab: Tab = "general";
let dirty = false;
let portalBusy = false;
let contentKey = "";
const app = document.querySelector<HTMLDivElement>("#app")!;
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
const toggle = (label: string, name: string, checked: boolean) =>
  `<label class="row"><span>${label}</span><input class="switch" type="checkbox" data-pref="${name}" ${checked ? "checked" : ""}></label>`;
const languages = () =>
  `<select data-pref="language" aria-label="Language">${[
    ["auto", "Detect automatically"],
    ["en", "English"],
    ["de", "German"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["it", "Italian"],
    ["nl", "Dutch"],
    ["pt", "Portuguese"],
    ["pl", "Polish"],
    ["uk", "Ukrainian"],
    ["ja", "Japanese"],
    ["zh", "Chinese"],
    ["tr", "Turkish"],
    ["ru", "Russian"],
    ["ko", "Korean"],
  ]
    .map(([v, l]) => option(v, l, state.preferences.language))
    .join("")}</select>`;
const isMac = () => state.platform === "macos";
const outputs = () =>
  `<div class="radio-group">${[["paste", "Paste at the cursor"], ["clipboard", "Copy to clipboard only"], ...(isMac() ? [["editor", "Open in a text editor"]] : [])].map(([v, l]) => `<label><input type="radio" name="output" data-pref="output" value="${v}" ${state.preferences.output === v ? "checked" : ""}>${l}</label>`).join("")}</div>`;

function notice(text: string) {
  const el = document.querySelector<HTMLElement>("#notice")!;
  el.textContent = text;
  el.hidden = false;
}
async function command(
  name: string,
  args?: Record<string, unknown>,
): Promise<boolean> {
  try {
    await invoke(name, args);
    return true;
  } catch (error) {
    notice(String(error));
    return false;
  }
}
async function preference(name: string, value: unknown) {
  await command("save_settings", {
    preferences: { ...state.preferences, [name]: value },
  });
}

app.innerHTML = `<aside><nav aria-label="Settings">${tabs.map(([id, title, path]) => `<button data-tab="${id}">${symbol(path)}<span>${title}</span></button>`).join("")}</nav></aside><main><div id="notice" role="alert" hidden></div><div id="content"></div></main><div id="record-control"></div>`;
document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      if (dirty) {
        notice("Save or discard your changes before switching tabs.");
        return;
      }
      tab = b.dataset.tab as Tab;
      render();
    }),
);

function recordControl() {
  const recording = state.status === "recording",
    busy = state.status === "transcribing";
  const text = recording
    ? `Recording · ${Math.floor(state.elapsed / 60)}:${String(state.elapsed % 60).padStart(2, "0")}`
    : busy
      ? "Transcribing …"
      : "Click or press your shortcut";
  const controls = document.querySelector<HTMLDivElement>("#record-control")!;
  if (!controls.childElementCount) {
    controls.innerHTML =
      '<button id="record" class="capsule"><span id="record-symbol"></span><span id="record-label"></span></button><button id="cancel" aria-label="Discard recording" hidden>×</button><span id="status" role="status"></span>';
    document
      .querySelector("#record")!
      .addEventListener("click", () => void command("toggle_recording"));
    document
      .querySelector("#cancel")!
      .addEventListener("click", () => void command("cancel_recording"));
  }
  const button = document.querySelector<HTMLButtonElement>("#record")!;
  button.disabled = busy;
  button.classList.toggle("recording", recording);
  button.title = state.message;
  document.querySelector("#record-symbol")!.textContent = recording
    ? "●"
    : busy
      ? "◌"
      : "♩";
  document.querySelector("#record-label")!.textContent = text;
  document.querySelector<HTMLElement>("#cancel")!.hidden = !recording;
  document.querySelector("#status")!.textContent = state.message;
}

function render() {
  if (!state) return;
  recordControl();
  document
    .querySelectorAll<HTMLButtonElement>("[data-tab]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.tab === tab));
  if (dirty) {
    contentKey = "";
    return;
  }
  const nextKey = JSON.stringify([
    tab,
    state.preferences,
    state.installed,
    state.microphones,
    state.shortcut_portal,
    state.paste_portal,
    state.shortcut,
    state.paste_ready,
    state.download,
    Math.round(state.progress * 100),
    state.history,
    state.transcript,
    state.macos,
    portalBusy,
  ]);
  if (contentKey === nextKey) return;
  contentKey = nextKey;
  const content = document.querySelector<HTMLDivElement>("#content")!;
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
        '<p class="secondary">WhisperFree turns speech into text directly on this computer. No account, cloud, or subscription. Your recordings never leave your computer.</p>',
      ) +
      section(
        "Get started in six steps",
        step(
          1,
          "Download a speech model",
          "Download once, then work offline. Start with Whisper Base (142 MB) for CPU recognition.",
          state.installed.length > 0,
          '<button data-goto="models">Open models</button>',
        ) +
          step(
            2,
            isMac() ? "Allow microphone access" : "Choose a microphone",
            "Microphone access is needed to record your voice. Everything stays on your computer.",
            isMac()
              ? state.macos!.microphone_allowed
              : state.microphones.length > 0,
            isMac()
              ? '<button data-command="allow_microphone">Allow</button>'
              : '<button data-goto="general">Microphone settings</button>',
          ) +
          step(
            3,
            "Choose a language",
            "Which language do you usually dictate in? Automatic detection can mistake short phrases for English.",
            p.language !== "auto",
            languages(),
          ) +
          step(
            4,
            "Where should the text go?",
            "Choose automatic pasting or copy your text to the clipboard.",
            true,
            outputs(),
          ) +
          step(
            5,
            isMac() ? "Allow Accessibility access" : "Allow keyboard access",
            isMac()
              ? "Required for automatic insertion and advanced triggers. Clipboard-only output remains available."
              : "Optional permission for automatic pasting. Only keyboard access is requested; no screen capture.",
            state.paste_ready,
            `<button data-portal="${state.paste_ready ? "disable_paste" : "enable_paste"}" ${!state.paste_portal || portalBusy ? "disabled" : ""}>${state.paste_ready ? (isMac() ? "System Settings" : "Revoke") : "Allow"}</button>${!state.paste_portal ? '<p class="secondary">Your desktop does not expose this portal. Clipboard output remains available.</p>' : ""}`,
          ) +
          step(
            6,
            "Set a trigger and try it",
            isMac()
              ? "Choose a key, shortcut, or mouse button. Place the cursor in a text field, press the trigger, speak, then press it again."
              : "Choose a shortcut in your desktop’s dialog. Place the cursor in a text field, press the trigger, speak, then press it again.",
            !!state.shortcut,
            shortcutButton(),
          ),
      );
  } else if (tab === "general") {
    content.innerHTML =
      section(
        "Recording",
        row("Trigger", shortcutButton()) +
          row(
            "Mode",
            `<select data-pref="hold_to_record" aria-label="Recording mode">${option("false", "Toggle", String(p.hold_to_record))}${option("true", "Push to talk", String(p.hold_to_record))}</select>`,
          ) +
          row("Language", languages()) +
          (p.model.startsWith("parakeet")
            ? '<p class="secondary">The active Parakeet model detects the language automatically. This selection only applies to Whisper models.</p>'
            : "") +
          row(
            "Microphone",
            isMac()
              ? '<span class="secondary">System default</span>'
              : `<select data-pref="microphone" aria-label="Microphone">${option("", "System default", p.microphone)}${state.microphones.map((m) => option(m, m, p.microphone)).join("")}</select>`,
          ) +
          (isMac()
            ? toggle(
                "Play start and stop sounds",
                "play_sounds",
                !!p.play_sounds,
              )
            : ""),
        isMac()
          ? ""
          : "Start and stop sounds are not available in this Linux preview.",
      ) +
      section(
        "Custom vocabulary",
        `<textarea id="vocabulary" rows="3" maxlength="8192" aria-label="Custom vocabulary" placeholder="e.g. Kubernetes, Jira, SwiftUI, Grafana">${esc(p.vocabulary)}</textarea><div class="edit-actions" id="vocabulary-actions" hidden><button id="save-vocabulary">Save</button><button data-discard>Discard</button></div>`,
        "Names and technical terms, separated by commas. Similar spellings are corrected after recognition with any model. Whisper models also receive these terms during recognition.",
      ) +
      section(
        "Output",
        outputs() +
          (isMac() && p.output === "paste"
            ? toggle(
                "Restore the previous clipboard afterward",
                "restore_clipboard",
                !!p.restore_clipboard,
              )
            : "") +
          (isMac() && p.output === "editor"
            ? row(
                esc(state.macos!.editor),
                '<button data-command="choose_editor">Choose another editor …</button>',
              ) +
              '<button data-command="show_transcripts_folder">Transcripts folder</button>'
            : ""),
        isMac()
          ? ""
          : "Automatic pasting requires keyboard permission in Setup. Clipboard restoration and text editor output are not available in this preview.",
      ) +
      section(
        "Appearance & system",
        isMac()
          ? toggle(
              "Show overlay when idle",
              "show_idle_overlay",
              !!p.show_idle_overlay,
            ) +
              toggle("Launch at login", "launch_at_login", !!p.launch_at_login)
          : row(
              "Desktop",
              `<span class="secondary">${esc(state.desktop)} · ${esc(state.session)}</span>`,
            ) +
              row(
                "Clipboard helper",
                state.clipboard_available
                  ? '<span class="success">Available</span>'
                  : '<span class="warning">Install wl-clipboard (Wayland) or xclip (X11)</span>',
              ) +
              row(
                "Global shortcuts portal",
                state.shortcut_portal ? "Available" : "Unavailable",
              ) +
              row(
                "Keyboard portal",
                state.paste_portal ? "Available" : "Unavailable",
              ) +
              (state.gpu_available
                ? toggle("Use Vulkan acceleration (experimental)", "gpu", p.gpu)
                : row("Recognition", "CPU")),
        isMac()
          ? ""
          : "A floating overlay and launch at login are still planned for Linux. Recording stops automatically after two minutes.",
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
          await command("save_settings", {
            preferences: { ...state.preferences, vocabulary: vocabulary.value },
          })
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
      return `<div class="model-row"><button class="model-radio" aria-label="Use ${esc(m.title)}" data-select="${esc(m.id)}" ${!installed ? "disabled" : ""}>${selected ? "◉" : "○"}</button><div class="model-description"><strong>${esc(m.title)}</strong>${(isMac() ? state.macos!.recommended.includes(m.id) : m.id === "base") ? '<span class="recommendation">Recommended</span>' : ""}<p>${esc(m.size)} · ${esc(m.note)}</p></div><div class="model-buttons">${downloading ? `<progress aria-label="Download progress" value="${state.progress}" max="1"></progress><button data-cancel-download>Cancel</button>` : installed ? `${selected ? '<span class="success">Active</span>' : `<button data-select="${esc(m.id)}">Use</button>`}` : `<button data-download="${esc(m.id)}" ${state.download ? "disabled" : ""}>Download</button>`}${installed && isMac() ? `<button data-delete="${esc(m.id)}" aria-label="Delete ${esc(m.title)}" class="destructive">×</button>` : ""}</div></div>`;
    };
    content.innerHTML =
      section(
        "",
        `<strong>Your computer: ${esc(state.desktop)} · ${esc(state.session)} · ${isMac() ? "Native speech engine" : state.gpu_available ? "CPU / Vulkan" : "CPU"}</strong><p class="secondary">Highlighted models are recommended for your device.</p>`,
      ) +
      section(
        "NVIDIA Parakeet",
        state.models
          .filter((m) => m.family === "parakeet")
          .map(modelRow)
          .join(""),
        "25 European languages, including German, English, French, Spanish, Italian, Polish, Dutch, and Ukrainian. Detects the language automatically.",
      ) +
      section(
        "OpenAI Whisper",
        state.models
          .filter((m) => m.family === "whisper")
          .map(modelRow)
          .join(""),
        "About 99 languages, including Chinese, Japanese, Korean, and Turkish. Supports a fixed language and custom vocabulary.",
      ) +
      section(
        "",
        (isMac()
          ? '<button data-command="import_model">Import a model …</button> '
          : "") + '<button id="show-models">Show in file manager</button>',
        isMac()
          ? "All models run locally using whisper.cpp. Download once from Hugging Face or import a compatible ggml file."
          : "All models run locally using whisper.cpp. Download once from Hugging Face; downloads are checked against its SHA-256 metadata. Custom model import is not available in this preview.",
      );
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
    content.innerHTML = `<form id="snippet-form">${section("Snippets", `<div id="snippets">${p.snippets.length ? p.snippets.map(snippetRow).join("") : '<p id="empty-snippets" class="secondary">No snippets yet. For example, say “my YouTube link” to insert a URL instead.</p>'}</div>`, "Matching ignores letter case, hyphens, and trailing punctuation.")}${section("", '<button type="button" id="add-snippet">Add snippet</button><div class="edit-actions" id="snippet-actions" hidden><button type="submit">Save snippets</button><button type="button" data-discard>Discard</button></div>')}</form>`;
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
        await command("save_settings", {
          preferences: { ...state.preferences, snippets },
        })
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
          "Save the last 20 dictations locally",
          "keep_history",
          p.keep_history,
        ),
      ) +
      section(
        "Recent dictations",
        state.history.length
          ? state.history
              .map(
                (text, i) =>
                  `<div class="history-row"><p>${esc(text)}</p><button data-copy="${i}" aria-label="Copy dictation">Copy</button></div>`,
              )
              .join("")
          : '<p class="secondary">No dictations yet.</p>',
      ) +
      (!p.keep_history && state.transcript
        ? section(
            "Latest transcript",
            `<p class="transcript">${esc(state.transcript)}</p><button id="copy-latest">Copy</button>`,
            "Kept in memory only while this app is running.",
          )
        : "") +
      (state.history.length || state.transcript
        ? section(
            "",
            '<button id="clear-history" class="destructive">Clear history</button>',
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
        '<div class="about-brand"><img src="./app-icon.png" width="64" height="64" alt="WhisperFree app icon"><div><h1>WhisperFree</h1><p class="secondary">Version ' +
          esc(state.version) +
          (isMac() ? "" : " · Linux preview") +
          '</p></div></div><p>Dictate into any app. Fully local, free, and open source (MIT).</p><p class="secondary">Speech recognition: whisper.cpp (MIT) with OpenAI Whisper and NVIDIA Parakeet models.</p>',
      ) +
      section(
        "Updates",
        isMac() && state.macos!.updates_configured
          ? toggle(
              "Automatically check for updates (once a day)",
              "auto_check_updates",
              !!p.auto_check_updates,
            ) +
              row(
                esc(state.macos!.update_status),
                `<button data-command="${state.macos!.can_install_update ? "install_update" : "check_updates"}" ${state.macos!.update_busy ? "disabled" : ""}>${state.macos!.can_install_update ? "Download & install" : "Check now"}</button>`,
              )
          : '<p class="secondary">Updates are not configured in this build.</p>',
        isMac()
          ? "Updates are installed only after the native updater verifies the existing signing identity."
          : "Linux releases are published manually after verification. A push to main does not publish a version.",
      ) +
      (isMac()
        ? ""
        : section(
            "Linux support",
            `<p>${esc(state.desktop)} · ${esc(state.session)}</p><p class="secondary">CachyOS with KDE Plasma on Wayland is the first test target. Other distributions and desktops require separate validation. See the README support matrix.</p>`,
          ));
  }
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
        portalBusy = true;
        button.disabled = true;
        await command(button.dataset.portal!);
        portalBusy = false;
        render();
      }),
  );
  content.querySelectorAll("[data-discard]").forEach((b) =>
    b.addEventListener("click", () => {
      dirty = false;
      render();
    }),
  );
}
function shortcutButton() {
  if (isMac() && state.macos!.recording_shortcut)
    return `<span class="secondary">${esc(state.macos!.shortcut_hint)}</span> <button data-command="cancel_shortcut">Cancel</button>`;
  return `<button data-portal="enable_shortcut" ${!state.shortcut_portal || (!isMac() && !!state.shortcut) || portalBusy ? "disabled" : ""}>${state.shortcut ? esc(state.shortcut) : "Set trigger …"}</button>`;
}
function snippetRow(s?: Snippet) {
  return `<div class="snippet-row" data-id="${esc(s?.id ?? crypto.randomUUID())}"><input class="switch" type="checkbox" name="enabled" aria-label="Enable snippet" ${!s || s.enabled ? "checked" : ""}><input name="trigger" aria-label="When I say" placeholder="When I say …" value="${esc(s?.trigger ?? "")}" maxlength="128"><span>→</span><textarea name="expansion" aria-label="Insert" placeholder="… insert" rows="2">${esc(s?.expansion ?? "")}</textarea><button type="button" data-remove aria-label="Remove snippet">×</button></div>`;
}

async function start() {
  try {
    await listen<Tab>("navigate", (event) => {
      if (tabs.some(([id]) => id === event.payload)) {
        tab = event.payload;
        dirty = false;
        contentKey = "";
        render();
      }
    });
    await listen<State>("state", (event) => {
      state = event.payload;
      render();
    });
    state = await invoke<State>("get_state");
    if (state.initial_tab && tabs.some(([id]) => id === state.initial_tab))
      tab = state.initial_tab;
    else if (!state.installed.length) tab = "setup";
    render();
    document.documentElement.dataset.ready = "true";
  } catch (error) {
    notice(`Could not connect to the desktop backend: ${String(error)}`);
  }
}
void start();

import "./ai-models.css";
import { t } from "../i18n";
import { escapeHtml as esc } from "../escape-html";
import { customCliConnectionSchema } from "../../../src/contracts/text/connections.js";
import type {
  BuiltinTextProvider,
  CustomCliConnection,
  TextConnectionAvailability,
  TextConnectionSettings,
} from "../../../src/contracts/text/connections.js";

type Snapshot = {
  available: TextConnectionAvailability[];
  scanning: boolean;
  busy: boolean;
};
type CliTestResult =
  | { ok: true; elapsed_ms: number }
  | {
      ok: false;
      code:
        | "UNAVAILABLE"
        | "TIMEOUT"
        | "CANCELLED"
        | "FAILED"
        | "INVALID_RESPONSE"
        | "BUSY";
    };
type Dependencies = {
  getSnapshot(): Snapshot;
  getSettings(): TextConnectionSettings;
  saveSettings(settings: TextConnectionSettings): Promise<boolean>;
  testCustomCliConnection(
    connection: CustomCliConnection,
  ): Promise<CliTestResult>;
  scan(): void;
  startLmStudio(): void;
  requestRender(): void;
  notice(message: string): void;
};

const builtins: Record<BuiltinTextProvider, string> = {
  ollama: "Ollama",
  lm_studio: "LM Studio",
  claude_code: "Claude Code",
  codex: "Codex",
};
const endpoints: Partial<Record<BuiltinTextProvider, string>> = {
  ollama: "127.0.0.1:11434",
  lm_studio: "127.0.0.1:1234",
};
const formatModelId = (value: string) =>
  value
    .split(":")
    .map((namespace) =>
      namespace
        .split("-")
        .map((part) => {
          if (part.toLowerCase() === "gpt") return "GPT";
          const separated = part.replace(/([a-z])([0-9])/gi, "$1 $2");
          return separated.charAt(0).toUpperCase() + separated.slice(1);
        })
        .join(" "),
    )
    .join(" · ")
    .replace(/^GPT (\d)/, "GPT-$1");
const option = (value: string, label: string, selected: string) =>
  `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
const effortLabels: Readonly<Record<string, string>> = {
  none: "No reasoning",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xhigh",
  max: "max",
  ultra: "Ultra",
  off: "Off",
  on: "On",
};
const effortLabel = (value: string) => {
  const label = effortLabels[value];
  return label ? t(label) : value;
};
const reasoningEntry = (
  found: TextConnectionAvailability | undefined,
  model: string,
) => found?.model_reasoning?.find((item) => item.model === model);
type ReasoningConnection = Exclude<
  TextConnectionSettings["connections"][number],
  CustomCliConnection
>;
const withoutReasoning = (
  connection: ReasoningConnection,
): ReasoningConnection => {
  const next = { ...connection };
  delete next.reasoning_effort;
  return next;
};

export function createAiModelsSettings(deps: Dependencies) {
  let draft: CustomCliConnection | undefined;
  let draftIsNew = false;
  let selectedProvider: string | undefined;
  let previousProvider: string | undefined;
  let cliTestState: "idle" | "running" | "ok" | "missing" | "failed" = "idle";
  let cliTestMessage = "";
  let cliTestRun = 0;
  const pendingScan = new Set<string>();

  const saveConnections = (
    connections: TextConnectionSettings["connections"],
  ) => deps.saveSettings({ ...deps.getSettings(), connections });

  const modelValue = (
    connection: TextConnectionSettings["connections"][number],
    found: TextConnectionAvailability | undefined,
  ) => {
    if (connection.provider === "ollama" || connection.provider === "lm_studio")
      return connection.model || found?.models[0] || "";
    if (
      connection.provider === "claude_code" ||
      connection.provider === "codex"
    )
      return connection.model;
    return "";
  };

  const statusText = (
    connection: TextConnectionSettings["connections"][number],
    found: TextConnectionAvailability | undefined,
    usable: boolean,
  ) => {
    if (!found) return t("Not checked");
    if (found.reason === "server_stopped") return t("Server stopped");
    if (found.reason === "not_running") return t("Not running");
    if (found.reason === "not_installed") return t("Not installed");
    if (found.reason === "no_models") return t("No models found");
    if (found.reason === "scan_failed")
      return t("Could not check this connection");
    if (!usable) return t("Not available");
    if (
      connection.provider === "ollama" ||
      connection.provider === "lm_studio"
    ) {
      const endpoint = endpoints[connection.provider];
      const count = found.models.length;
      return [
        endpoint,
        t(count === 1 ? "{count} model" : "{count} models", { count }),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    return t("Available");
  };

  const shortInfo = (
    connection: TextConnectionSettings["connections"][number],
    found: TextConnectionAvailability | undefined,
    usable: boolean,
  ) => {
    if (!usable) return statusText(connection, found, usable);
    if (!connection.enabled) return t("Off");
    if (connection.provider.startsWith("custom:")) return t("Custom command");
    const selected = modelValue(connection, found);
    const model = selected
      ? connection.provider === "ollama" || connection.provider === "lm_studio"
        ? formatModelId(selected)
        : (found?.model_options?.find((item) => item.value === selected)
            ?.display_name ?? formatModelId(selected))
      : t("Use tool settings");
    const selectedReasoningModel =
      (connection.provider === "claude_code" ||
        connection.provider === "codex") &&
      !selected
        ? "default"
        : selected;
    const advertised = reasoningEntry(found, selectedReasoningModel);
    if (
      !advertised &&
      !("reasoning_effort" in connection && connection.reasoning_effort)
    )
      return model;
    const effort =
      "reasoning_effort" in connection
        ? connection.reasoning_effort
        : undefined;
    const displayedEffort = effort ?? advertised?.default;
    return `${model} · ${t("Reasoning {value}", {
      value: displayedEffort ? effortLabel(displayedEffort) : t("Standard"),
    })}`;
  };

  const saveEffort = (provider: string, effort: string) =>
    saveConnections(
      deps.getSettings().connections.map((connection) => {
        if (connection.provider !== provider) return connection;
        switch (connection.provider) {
          case "ollama":
          case "lm_studio":
          case "claude_code":
          case "codex":
            return effort
              ? { ...connection, reasoning_effort: effort }
              : withoutReasoning(connection);
          default:
            return connection;
        }
      }),
    );

  const removeOverrideButton = (
    connection: TextConnectionSettings["connections"][number],
  ) => {
    if (!("reasoning_effort" in connection) || !connection.reasoning_effort)
      return "";
    return `<button type="button" class="ai-models-effort-reset" data-effort-reset="${esc(connection.provider)}">${esc(t("Use model default"))}</button>`;
  };

  const renderEffort = (
    connection: TextConnectionSettings["connections"][number],
    found: TextConnectionAvailability | undefined,
    selected: string,
    controlsDisabled: boolean,
  ) => {
    const custom = connection.provider.startsWith("custom:");
    const cli =
      connection.provider === "claude_code" || connection.provider === "codex";
    const noModel = cli && selected.length === 0;
    const model = selected || (cli ? "default" : "");
    const capability =
      !custom && !noModel ? reasoningEntry(found, model) : undefined;
    const storedEffort =
      "reasoning_effort" in connection
        ? (connection.reasoning_effort ?? "")
        : "";
    const lockedReason = custom
      ? t("Custom commands cannot set reasoning")
      : noModel
        ? t("Follows the tool settings")
        : t("This model does not report reasoning controls");

    if (
      !capability ||
      (storedEffort && !capability.options.includes(storedEffort))
    ) {
      const explanation =
        storedEffort && capability
          ? t("This model no longer reports the saved reasoning setting.")
          : lockedReason;
      return `<div class="ai-models-field ai-models-effort ai-models-effort-disabled" aria-disabled="true"><span class="ai-models-label">${esc(t("Reasoning"))}</span><div class="ai-models-effort-unavailable"><small>${esc(explanation)}</small></div>${removeOverrideButton(connection)}</div>`;
    }

    const options = capability.options;
    const defaultIsOption =
      capability.default !== undefined && options.includes(capability.default);
    const hasStandardStop = !defaultIsOption;
    const stops = hasStandardStop ? ["default", ...options] : [...options];
    const selectedStop =
      storedEffort && options.includes(storedEffort)
        ? storedEffort
        : defaultIsOption
          ? (capability.default ?? "")
          : "default";
    const selectedIndex = Math.max(0, stops.indexOf(selectedStop));
    const label = (stop: string) =>
      stop === "default" ? t("Standard") : effortLabel(stop);
    const stopLabel = label(stops[selectedIndex] ?? "default");
    if (stops.length === 1) {
      return `<div class="ai-models-field ai-models-effort"><div class="ai-models-effort-title"><span class="ai-models-label">${esc(t("Reasoning"))}</span><output class="ai-models-effort-current">${esc(stopLabel)}</output></div></div>`;
    }
    const rangeLabel = t("{provider} reasoning", {
      provider: builtins[connection.provider as BuiltinTextProvider],
    });
    const progress = (selectedIndex / (stops.length - 1)) * 100;
    const hasOverride = Boolean(
      storedEffort && storedEffort !== capability.default,
    );
    const defaultNote =
      capability.default && hasOverride
        ? `<small>${esc(t("Model default: {effort}", { effort: effortLabel(capability.default) }))}</small>`
        : "";
    const effortFooter =
      hasOverride && capability.default
        ? `<div class="ai-models-effort-foot">${defaultNote}${removeOverrideButton(connection)}</div>`
        : "";
    const tickMarkup = stops
      .map(
        (_, index) =>
          `<span class="ai-models-slider-tick ${index === selectedIndex ? "is-current" : index < selectedIndex ? "is-passed" : ""}"></span>`,
      )
      .join("");
    const labelMarkup = stops
      .map((stop, index) => {
        const gridColumn = Math.max(1, index);
        const className = index === selectedIndex ? "is-current" : "";
        return `<span class="${className}" style="grid-column:${gridColumn};grid-row:1">${esc(label(stop))}</span>`;
      })
      .join("");
    return `<div class="ai-models-field ai-models-effort"><div class="ai-models-effort-title"><span class="ai-models-label">${esc(t("Reasoning"))}</span><output class="ai-models-effort-current" data-effort-current>${esc(stopLabel)}</output></div><div class="ai-models-slider-control" style="--effort-stop-count:${stops.length};--effort-stop-interval-count:${stops.length - 1}"><div class="ai-models-slider-track" aria-hidden="true"><span class="ai-models-slider-fill" style="width:${progress}%"></span>${tickMarkup}</div><input type="range" class="ai-models-slider" data-effort-slider="${esc(connection.provider)}" min="0" max="${stops.length - 1}" step="any" value="${selectedIndex}" aria-label="${esc(rangeLabel)}" aria-valuetext="${esc(stopLabel)}" ${controlsDisabled ? "disabled" : ""}><div class="ai-models-slider-labels" aria-hidden="true">${labelMarkup}</div></div>${effortFooter}</div>`;
  };

  const resizeArgumentsField = (content: HTMLElement) => {
    const field = content.querySelector<HTMLTextAreaElement>("#custom-args");
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight + 2}px`;
  };

  const syncDraft = (content: HTMLElement) => {
    if (!draft) return;
    draft = {
      ...draft,
      name:
        content.querySelector<HTMLInputElement>("#custom-name")?.value ??
        draft.name,
      command:
        content.querySelector<HTMLInputElement>("#custom-command")?.value ??
        draft.command,
      args: (
        content.querySelector<HTMLTextAreaElement>("#custom-args")?.value ??
        draft.args.join("\n")
      )
        .split("\n")
        .filter((line) => line.length > 0),
      output: (content.querySelector<HTMLButtonElement>(
        "[data-cli-format].is-selected",
      )?.dataset.cliFormat ?? draft.output) as "text" | "json",
      responsePath:
        content.querySelector<HTMLInputElement>("#custom-response-path")
          ?.value ?? (draft.output === "json" ? draft.responsePath : ""),
    };
    if (draft.output === "text") draft.responsePath = "";
  };

  const renderEditor = (content: HTMLElement, controlsDisabled: boolean) => {
    if (!draft) return;
    const json = draft.output === "json";
    const nameTitle = draftIsNew
      ? t("New CLI connection")
      : t("Edit CLI connection");
    content.innerHTML = `<section class="ai-models-editor" aria-label="${esc(nameTitle)}">
      <header class="ai-models-pane-header"><div><h2>${esc(nameTitle)}</h2><p>${esc(t("For tools OpenWhisper does not detect automatically"))}</p></div></header>
      <div class="ai-models-editor-body">
        <label class="ai-models-field"><span class="ai-models-label">${esc(t("Connection name"))}</span><input id="custom-name" maxlength="128" value="${esc(draft.name)}" placeholder="${esc(t("For example, Gemini"))}" autocomplete="off" ${controlsDisabled ? "disabled" : ""}></label>
        <label class="ai-models-field"><span class="ai-models-label">${esc(t("Executable or command"))}</span><input id="custom-command" class="ai-models-mono" maxlength="1024" value="${esc(draft.command)}" placeholder="gemini" autocomplete="off" ${controlsDisabled ? "disabled" : ""}></label>
        <label class="ai-models-field ai-models-wide"><span class="ai-models-label">${esc(t("Arguments (one per line)"))}</span><textarea id="custom-args" rows="2" placeholder="--output-format&#10;json" ${controlsDisabled ? "disabled" : ""}>${esc(draft.args.join("\n"))}</textarea><small>${esc(t("One argument per line. No shell; text via stdin."))}</small></label>
        <div class="ai-models-field ai-models-wide"><span class="ai-models-label">${esc(t("Read response as"))}</span><div class="ai-models-format"><div class="ai-models-segment" role="group" aria-label="${esc(t("Read response as"))}"><button type="button" data-cli-format="text" class="${!json ? "is-selected" : ""}" ${controlsDisabled ? "disabled" : ""}>${esc(t("Plain text"))}</button><button type="button" data-cli-format="json" class="${json ? "is-selected" : ""}" ${controlsDisabled ? "disabled" : ""}>JSON</button></div>${json ? `<label class="ai-models-json-field"><span>${esc(t("Field"))}</span><input id="custom-response-path" maxlength="512" value="${esc(draft.responsePath)}" placeholder="response" autocomplete="off" ${controlsDisabled ? "disabled" : ""}></label>` : ""}</div></div>
      </div>
      <footer class="ai-models-editor-footer"><button type="button" id="ai-models-test" ${controlsDisabled || cliTestState === "running" ? "disabled" : ""}>${esc(t(cliTestState === "running" ? "Testing…" : "Test"))}</button><span class="ai-models-test-result ${cliTestState}" role="status" aria-live="polite">${esc(cliTestMessage)}</span><span class="ai-models-actions-spacer"></span><button type="button" id="ai-models-cancel" ${controlsDisabled ? "disabled" : ""}>${esc(t("Cancel"))}</button><button type="button" id="ai-models-save" class="primary" ${!draft.name.trim() || !draft.command.trim() || controlsDisabled ? "disabled" : ""}>${esc(t(draftIsNew ? "Add" : "Save CLI connection"))}</button></footer>
    </section>`;
    resizeArgumentsField(content);
    content
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        ".ai-models-editor-body input, .ai-models-editor-body textarea",
      )
      .forEach((field) => {
        field.addEventListener("input", () => {
          syncDraft(content);
          resizeArgumentsField(content);
          cliTestRun += 1;
          cliTestState = "idle";
          cliTestMessage = "";
          const save =
            content.querySelector<HTMLButtonElement>("#ai-models-save");
          if (save)
            save.disabled =
              !draft?.name.trim() || !draft?.command.trim() || controlsDisabled;
          const test =
            content.querySelector<HTMLButtonElement>("#ai-models-test");
          if (test) test.disabled = controlsDisabled;
          const result = content.querySelector<HTMLElement>(
            ".ai-models-test-result",
          );
          if (result) result.textContent = "";
        });
      });
    content
      .querySelectorAll<HTMLButtonElement>("[data-cli-format]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          syncDraft(content);
          draft = {
            ...draft!,
            output: button.dataset.cliFormat as "text" | "json",
          };
          if (draft.output === "text") draft.responsePath = "";
          cliTestRun += 1;
          cliTestState = "idle";
          cliTestMessage = "";
          renderEditor(content, controlsDisabled);
        });
      });
    content.querySelector("#ai-models-test")?.addEventListener("click", () => {
      syncDraft(content);
      if (!draft) return;
      if (!draft.command.trim()) {
        cliTestState = "missing";
        cliTestMessage = t("Program is required");
        renderEditor(content, controlsDisabled);
        return;
      }
      const parsed = customCliConnectionSchema.safeParse({
        ...draft,
        stdin: draft.stdin || "{prompt}",
      });
      if (!parsed.success) {
        cliTestState = "failed";
        cliTestMessage = t("Check the CLI connection fields and try again.");
        renderEditor(content, controlsDisabled);
        return;
      }
      const run = ++cliTestRun;
      cliTestState = "running";
      cliTestMessage = t("Testing…");
      renderEditor(content, controlsDisabled);
      void deps
        .testCustomCliConnection(parsed.data)
        .then((result) => {
          if (run !== cliTestRun || !draft) return;
          if (result.ok) {
            cliTestState = "ok";
            cliTestMessage = t("Responded · {seconds} s", {
              seconds: (result.elapsed_ms / 1000).toFixed(1),
            });
          } else {
            cliTestState = "failed";
            cliTestMessage = t(
              result.code === "UNAVAILABLE"
                ? "Program was not found"
                : result.code === "TIMEOUT"
                  ? "CLI test timed out"
                  : result.code === "INVALID_RESPONSE"
                    ? "CLI returned an invalid response"
                    : result.code === "BUSY"
                      ? "Unavailable during recording or processing"
                      : "CLI connection test failed",
            );
          }
          renderEditor(content, controlsDisabled);
        })
        .catch(() => {
          if (run !== cliTestRun || !draft) return;
          cliTestState = "failed";
          cliTestMessage = t("CLI connection test failed");
          renderEditor(content, controlsDisabled);
        });
    });
    content
      .querySelector("#ai-models-cancel")
      ?.addEventListener("click", cancelEdit);
    content.querySelector("#ai-models-save")?.addEventListener("click", () => {
      void (async () => {
        syncDraft(content);
        if (!draft) return;
        const savedDraft = {
          ...draft,
          enabled: draftIsNew ? true : draft.enabled,
        };
        const parsed = customCliConnectionSchema.safeParse({
          ...savedDraft,
          stdin: savedDraft.stdin || "{prompt}",
        });
        if (!parsed.success) {
          deps.notice(t("Check the CLI connection fields and try again."));
          return;
        }
        const latest = deps.getSettings().connections;
        const connections = draftIsNew
          ? [...latest, parsed.data]
          : latest.map((connection) =>
              connection.provider === parsed.data.provider
                ? parsed.data
                : connection,
            );
        const saved = await saveConnections(connections);
        if (saved) {
          pendingScan.delete(parsed.data.provider);
          selectedProvider = parsed.data.provider;
          draft = undefined;
          draftIsNew = false;
          previousProvider = undefined;
          cliTestRun += 1;
          const host = content.closest<HTMLElement>("#content");
          if (host) render(host);
          deps.scan();
        }
      })();
    });
  };

  const cancelEdit = () => {
    const cancelledProvider = draft?.provider;
    if (cancelledProvider) pendingScan.delete(cancelledProvider);
    draft = undefined;
    draftIsNew = false;
    selectedProvider = previousProvider ?? selectedProvider;
    previousProvider = undefined;
    cliTestRun += 1;
    cliTestState = "idle";
    cliTestMessage = "";
    deps.requestRender();
  };

  const renderList = (
    content: HTMLElement,
    settings: TextConnectionSettings,
    availability: Map<string, TextConnectionAvailability>,
    controlsDisabled: boolean,
    activeProvider: string,
  ) => {
    const firstEnabled = settings.connections.find(
      (connection) => connection.enabled,
    )?.provider;
    const rows = settings.connections.map((connection) => {
      const provider = connection.provider;
      const found = pendingScan.has(provider)
        ? undefined
        : availability.get(provider);
      const usable = found?.usable ?? false;
      const name = provider.startsWith("custom:")
        ? (connection as CustomCliConnection).name
        : builtins[provider as BuiltinTextProvider];
      const state = connection.enabled
        ? provider === firstEnabled
          ? "primary"
          : "enabled"
        : "disabled";
      const selected = activeProvider === provider;
      const draggable = !controlsDisabled;
      const showPriority = provider === firstEnabled && connection.enabled;
      const title = showPriority
        ? t("Used first")
        : statusText(connection, found, usable);
      return `<li class="ai-models-row ${selected ? "is-selected" : ""} ${!usable ? "is-unavailable" : ""}" data-provider="${esc(provider)}" data-row-state="${state}"><button type="button" class="ai-models-row-select" data-select-provider="${esc(provider)}" aria-pressed="${selected}" ${controlsDisabled ? "disabled" : ""}><span class="ai-models-status-dot ${state}" title="${esc(title)}" aria-label="${esc(title)}"></span><span class="ai-models-row-copy"><strong>${esc(name)}</strong><small>${esc(shortInfo(connection, found, usable))}</small></span></button><button type="button" class="ai-models-grip" data-connection-grip="${esc(provider)}" aria-label="${esc(t("Move {provider} with Alt and arrow keys", { provider: name }))}" draggable="${draggable}" ${controlsDisabled ? "disabled" : ""}>${"<span></span>".repeat(6)}</button></li>`;
    });
    const addDisabled = settings.connections.length >= 20 || controlsDisabled;
    const list = content.querySelector<HTMLOListElement>(".ai-models-list")!;
    const existing = new Map(
      Array.from(list.querySelectorAll<HTMLElement>(".ai-models-row")).map(
        (row) => [row.dataset.provider ?? "", row],
      ),
    );
    rows.forEach((markup, index) => {
      const template = document.createElement("template");
      template.innerHTML = markup;
      const next = template.content.firstElementChild as HTMLElement | null;
      if (!next) return;
      const provider = next.dataset.provider ?? "";
      const row = existing.get(provider);
      if (row) {
        existing.delete(provider);
        row.className = next.className;
        row.dataset.rowState = next.dataset.rowState;
        row.innerHTML = next.innerHTML;
        if (list.children.item(index) !== row)
          list.insertBefore(row, list.children.item(index));
      } else {
        list.insertBefore(next, list.children.item(index));
      }
    });
    for (const row of existing.values()) row.remove();
    const addButton = content.querySelector<HTMLButtonElement>(
      "#add-custom-connection",
    );
    if (addButton) addButton.disabled = addDisabled;
  };

  const renderDetails = (
    content: HTMLElement,
    settings: TextConnectionSettings,
    availability: Map<string, TextConnectionAvailability>,
    controlsDisabled: boolean,
    provider: string,
  ) => {
    const connection = settings.connections.find(
      (entry) => entry.provider === provider,
    );
    const pane = content.querySelector<HTMLElement>(".ai-models-detail");
    if (!pane) return;
    if (!connection) {
      pane.innerHTML = `<p class="ai-models-empty">${esc(t("Select a connection to see its settings"))}</p>`;
      return;
    }
    const found = pendingScan.has(provider)
      ? undefined
      : availability.get(provider);
    const usable = found?.usable ?? false;
    const custom = provider.startsWith("custom:");
    const cli = provider === "claude_code" || provider === "codex";
    const localConnection =
      connection.provider === "ollama" || connection.provider === "lm_studio"
        ? connection
        : undefined;
    const name = custom
      ? (connection as CustomCliConnection).name
      : builtins[provider as BuiltinTextProvider];
    const selected = modelValue(connection, found);
    const selectedModel = cli && !selected ? "default" : selected;
    const capability = reasoningEntry(found, selectedModel);
    const defaultProvider = settings.connections.find(
      (entry) => entry.enabled,
    )?.provider;
    const status = [
      provider === defaultProvider ? t("Used first") : "",
      statusText(connection, found, usable),
    ]
      .filter(Boolean)
      .join(" · ");
    const modelWarning =
      provider === "lm_studio" &&
      selected &&
      found?.models_without_reasoning_control?.includes(selected)
        ? `<small class="ai-models-model-warning">${esc(t("LM Studio does not expose a setting to turn reasoning off for this model. If it reasons by default, AI revision may time out; your transcript will be kept."))}</small>`
        : "";
    const options =
      found?.model_options ??
      (found?.models ?? []).map((value) => ({
        value,
        display_name: formatModelId(value),
        source: "cli" as const,
      }));
    const selectableOptions =
      provider === "claude_code"
        ? options.filter((item) => item.value !== "default")
        : options;
    const recommendedClaude =
      provider === "claude_code" && selected === "default";
    const missingCliModel =
      selected &&
      !selectableOptions.some((item) => item.value === selected) &&
      !recommendedClaude;
    const modelControl = localConnection
      ? `<label class="ai-models-field"><span class="ai-models-label">${esc(t("Model"))}</span><select data-connection-model="${esc(provider)}" ${!usable || controlsDisabled ? "disabled" : ""}>${localConnection.model && !found?.models.includes(localConnection.model) ? option(localConnection.model, formatModelId(localConnection.model), selected) : ""}${found?.models.length ? found.models.map((value) => option(value, formatModelId(value), selected)).join("") : option("", t("No models found"), selected)}</select>${modelWarning}</label>`
      : cli
        ? `<label class="ai-models-field"><span class="ai-models-label">${esc(t("Model"))}</span><select data-cli-model="${esc(provider)}" ${!usable || controlsDisabled ? "disabled" : ""}>${option("", t("Use tool settings"), selected)}${selectableOptions.map((item) => option(item.value, item.display_name === item.value ? formatModelId(item.value) : item.display_name, selected)).join("")}${recommendedClaude ? option("default", t("Recommended Claude model"), selected) : ""}${missingCliModel ? option(selected, formatModelId(selected), selected) : ""}</select></label>`
        : `<div class="ai-models-field"><span class="ai-models-label">${esc(t("Command"))}</span><div class="ai-models-readonly-command">${esc([(connection as CustomCliConnection).command, ...(connection as CustomCliConnection).args].join(" "))}</div></div>`;
    const unavailableCallout =
      provider === "lm_studio" && found?.reason === "server_stopped"
        ? `<div class="ai-models-unavailable-callout"><span>${esc(t("LM Studio server is not running"))}</span><button type="button" data-start-lm-studio ${controlsDisabled ? "disabled" : ""}>${esc(t("Start server"))}</button></div>`
        : !usable
          ? `<p class="ai-models-unavailable-callout">${esc(statusText(connection, found, usable))}</p>`
          : "";
    const enabledDisabled =
      controlsDisabled || (!usable && !connection.enabled);
    const isOn = connection.enabled;
    const editControls = custom
      ? `<div class="ai-models-detail-actions"><button type="button" data-connection-edit="${esc(provider)}" ${controlsDisabled ? "disabled" : ""}>${esc(t("Edit"))}</button><button type="button" data-connection-remove="${esc(provider)}" ${controlsDisabled ? "disabled" : ""}>${esc(t("Remove"))}</button></div>`
      : "";
    pane.innerHTML = `<header class="ai-models-pane-header"><div><h2>${esc(name)}</h2><p class="ai-models-status-line ${usable ? "is-available" : ""}">${esc(status)}</p></div><button type="button" class="ai-models-switch ${isOn ? "is-on" : ""}" data-connection-enabled="${esc(provider)}" role="switch" aria-checked="${isOn}" aria-label="${esc(t("Enable {provider}", { provider: name }))}" ${enabledDisabled ? "disabled" : ""}><span></span></button></header>${unavailableCallout}${modelControl}${renderEffort(connection, found, selected, !usable || controlsDisabled)}${editControls}`;
    pane
      .querySelector<HTMLButtonElement>("[data-start-lm-studio]")
      ?.addEventListener("click", (event) => {
        (event.currentTarget as HTMLButtonElement).disabled = true;
        deps.startLmStudio();
      });
    pane
      .querySelector<HTMLButtonElement>("[data-connection-enabled]")
      ?.addEventListener("click", () => {
        if (controlsDisabled || (!usable && !connection.enabled)) return;
        const connections = deps.getSettings().connections.map((entry) => {
          if (entry.provider !== provider) return entry;
          if (
            (entry.provider === "ollama" || entry.provider === "lm_studio") &&
            !entry.enabled
          ) {
            const selectedModel =
              pane.querySelector<HTMLSelectElement>(
                `[data-connection-model="${CSS.escape(provider)}"]`,
              )?.value ?? "";
            return {
              ...entry,
              model: selectedModel,
              enabled: selectedModel.length > 0,
            };
          }
          return { ...entry, enabled: !entry.enabled };
        });
        void saveConnections(connections);
      });
    pane
      .querySelector<HTMLSelectElement>("[data-connection-model]")
      ?.addEventListener("change", (event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        void (async () => {
          const connections = deps.getSettings().connections.map((entry) => {
            if (entry.provider !== provider) return entry;
            switch (entry.provider) {
              case "ollama":
              case "lm_studio":
                return { ...withoutReasoning(entry), model: value };
              default:
                return entry;
            }
          });
          const saved = await saveConnections(connections);
          if (saved && provider === "ollama") deps.scan();
        })();
      });
    pane
      .querySelector<HTMLSelectElement>("[data-cli-model]")
      ?.addEventListener("change", (event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        void saveConnections(
          deps.getSettings().connections.map((entry) => {
            if (entry.provider !== provider) return entry;
            switch (entry.provider) {
              case "claude_code":
              case "codex":
                return { ...withoutReasoning(entry), model: value };
              default:
                return entry;
            }
          }),
        );
      });
    pane
      .querySelector<HTMLButtonElement>("[data-effort-reset]")
      ?.addEventListener("click", () => void saveEffort(provider, ""));
    const effortSlider = pane.querySelector<HTMLInputElement>(
      "[data-effort-slider]",
    );
    if (effortSlider && capability) {
      const defaultIsOption =
        capability.default !== undefined &&
        capability.options.includes(capability.default);
      const hasStandardStop = !defaultIsOption;
      const stops = hasStandardStop
        ? ["default", ...capability.options]
        : [...capability.options];
      const control = effortSlider.closest<HTMLElement>(
        ".ai-models-slider-control",
      );
      const fill = control?.querySelector<HTMLElement>(
        ".ai-models-slider-fill",
      );
      const currentValue = pane.querySelector<HTMLOutputElement>(
        "[data-effort-current]",
      );
      const ticks = control?.querySelectorAll<HTMLElement>(
        ".ai-models-slider-tick",
      );
      const labels = control?.querySelectorAll<HTMLElement>(
        ".ai-models-slider-labels span",
      );
      const stopLabel = (index: number) =>
        stops[index] === "default"
          ? t("Standard")
          : effortLabel(stops[index] ?? "");
      const updateSlider = () => {
        const max = stops.length - 1;
        const position = Math.max(0, Math.min(max, Number(effortSlider.value)));
        const selectedStop = Math.round(position);
        if (fill) fill.style.width = `${(position / max) * 100}%`;
        const currentLabel = stopLabel(selectedStop);
        effortSlider.setAttribute("aria-valuetext", currentLabel);
        if (currentValue) {
          currentValue.value = currentLabel;
          currentValue.textContent = currentLabel;
        }
        ticks?.forEach((tick, index) => {
          tick.classList.toggle("is-current", index === selectedStop);
          tick.classList.toggle("is-passed", index < position);
        });
        labels?.forEach((label, index) =>
          label.classList.toggle("is-current", index === selectedStop),
        );
      };
      const commitSlider = () => {
        const selectedStop = Math.max(
          0,
          Math.min(stops.length - 1, Math.round(Number(effortSlider.value))),
        );
        effortSlider.value = String(selectedStop);
        updateSlider();
        const effort =
          hasStandardStop && selectedStop === 0
            ? ""
            : (capability.options[selectedStop - (hasStandardStop ? 1 : 0)] ??
              "");
        void saveEffort(provider, effort === capability.default ? "" : effort);
      };
      let keyboardInteraction = false;
      effortSlider.addEventListener("input", updateSlider);
      effortSlider.addEventListener("keydown", (event) => {
        let next = Number(effortSlider.value);
        switch (event.key) {
          case "ArrowRight":
          case "ArrowUp":
          case "PageUp":
            next = Math.round(next) + 1;
            break;
          case "ArrowLeft":
          case "ArrowDown":
          case "PageDown":
            next = Math.round(next) - 1;
            break;
          case "Home":
            next = 0;
            break;
          case "End":
            next = stops.length - 1;
            break;
          default:
            return;
        }
        event.preventDefault();
        effortSlider.value = String(
          Math.max(0, Math.min(stops.length - 1, next)),
        );
        keyboardInteraction = true;
        updateSlider();
      });
      effortSlider.addEventListener("keyup", (event) => {
        if (!keyboardInteraction) return;
        if (
          ![
            "ArrowRight",
            "ArrowUp",
            "PageUp",
            "ArrowLeft",
            "ArrowDown",
            "PageDown",
            "Home",
            "End",
          ].includes(event.key)
        )
          return;
        keyboardInteraction = false;
        commitSlider();
      });
      effortSlider.addEventListener("blur", () => {
        if (!keyboardInteraction) return;
        keyboardInteraction = false;
        commitSlider();
      });
      effortSlider.addEventListener("change", () => {
        if (!keyboardInteraction) commitSlider();
      });
    }
    pane
      .querySelectorAll<HTMLButtonElement>("[data-connection-edit]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          previousProvider = selectedProvider;
          const entry = deps
            .getSettings()
            .connections.find((item) => item.provider === provider);
          if (!entry || !entry.provider.startsWith("custom:")) return;
          draftIsNew = false;
          pendingScan.add(entry.provider);
          draft = {
            ...(entry as CustomCliConnection),
            args: [...(entry as CustomCliConnection).args],
          };
          cliTestState = "idle";
          cliTestMessage = "";
          deps.requestRender();
        }),
      );
    pane
      .querySelector<HTMLButtonElement>("[data-connection-remove]")
      ?.addEventListener("click", () => {
        const connections = deps
          .getSettings()
          .connections.filter((entry) => entry.provider !== provider);
        selectedProvider = connections[0]?.provider;
        void saveConnections(connections);
      });
  };

  const moveConnection = async (
    content: HTMLElement,
    provider: string,
    delta: -1 | 1,
  ) => {
    const connections = [...deps.getSettings().connections];
    const index = connections.findIndex((entry) => entry.provider === provider);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= connections.length) return;
    [connections[index], connections[nextIndex]] = [
      connections[nextIndex]!,
      connections[index]!,
    ];
    if (await saveConnections(connections)) {
      selectedProvider = provider;
      render(content);
      content
        .querySelector<HTMLButtonElement>(
          `[data-connection-grip="${CSS.escape(provider)}"]`,
        )
        ?.focus();
    }
  };

  const render = (content: HTMLElement) => {
    const { available, scanning, busy } = deps.getSnapshot();
    const settings = deps.getSettings();
    const availability = new Map(
      available.map((item) => [item.provider, item]),
    );
    const controlsDisabled = scanning || busy;
    if (
      selectedProvider &&
      !settings.connections.some((entry) => entry.provider === selectedProvider)
    )
      selectedProvider = undefined;
    selectedProvider ??= settings.connections[0]?.provider;
    const activeProvider = selectedProvider ?? "";
    const locked = busy;
    if (!content.querySelector(".ai-models-settings"))
      content.innerHTML = `<section class="ai-models-settings">
      <header class="ai-models-intro"><div><p>${esc(t("Models power AI features such as AI text revision in Text processing. They start off."))}</p><p>${esc(t("Connections are listed in priority order. AI features use the first enabled connection."))}</p><p class="ai-models-speed-hint">${esc(t("Local models: large dense models (e.g. 27–31B) can take 15 seconds or more per minute of dictation. Mixture-of-experts models with few active parameters (e.g. names ending in -a3b) usually answer in a few seconds."))}</p></div><button type="button" id="scan-connections" ${controlsDisabled ? "disabled" : ""}><span class="ai-models-scan-dot ${scanning ? "scanning" : "ready"}"></span>${esc(t(scanning ? "Scanning …" : "Scan again"))}</button></header>
      ${locked ? `<p class="ai-models-lock" role="status">${esc(t("Locked during recording or processing"))}</p>` : ""}
      <div class="ai-models-workspace ${locked ? "is-locked" : ""}" ${locked ? "inert" : ""}>
        <aside class="ai-models-list-pane"><ol class="ai-models-list" aria-label="${esc(t("AI connections"))}"></ol><button type="button" id="add-custom-connection" class="ai-models-add" ${settings.connections.length >= 20 || controlsDisabled ? "disabled" : ""}><span class="ai-models-add-icon" aria-hidden="true"></span>${esc(t("Add CLI connection"))}</button></aside>
        <section class="ai-models-detail" aria-live="polite"></section>
      </div>
      <p class="ai-models-privacy">${esc(t("Local servers do not prove local-only processing. CLI tools and custom commands may send text to cloud services."))}</p>
    </section>`;
    const workspace = content.querySelector<HTMLElement>(
      ".ai-models-workspace",
    );
    workspace?.classList.toggle("is-locked", locked);
    if (workspace) {
      if (locked) workspace.setAttribute("inert", "");
      else workspace.removeAttribute("inert");
      const existingLock =
        content.querySelector<HTMLElement>(".ai-models-lock");
      if (locked && !existingLock) {
        const lock = document.createElement("p");
        lock.className = "ai-models-lock";
        lock.setAttribute("role", "status");
        lock.textContent = t("Locked during recording or processing");
        workspace.before(lock);
      } else if (!locked) existingLock?.remove();
    }
    const scanButton =
      content.querySelector<HTMLButtonElement>("#scan-connections");
    if (scanButton) {
      scanButton.disabled = controlsDisabled;
      scanButton.innerHTML = `<span class="ai-models-scan-dot ${scanning ? "scanning" : "ready"}"></span>${esc(t(scanning ? "Scanning …" : "Scan again"))}`;
    }
    if (draft) {
      workspace?.classList.add("is-adding");
      renderList(
        content,
        settings,
        availability,
        controlsDisabled,
        activeProvider,
      );
      const list = content.querySelector<HTMLElement>(".ai-models-list-pane");
      if (list) {
        list
          .querySelectorAll<HTMLElement>("[data-select-provider]")
          .forEach((row) => row.classList.remove("is-selected"));
        content
          .querySelector("#add-custom-connection")
          ?.classList.add("is-selected");
      }
      renderEditor(
        content.querySelector<HTMLElement>(".ai-models-detail")!,
        controlsDisabled,
      );
    } else {
      workspace?.classList.remove("is-adding");
      content
        .querySelector("#add-custom-connection")
        ?.classList.remove("is-selected");
      renderList(
        content,
        settings,
        availability,
        controlsDisabled,
        activeProvider,
      );
      renderDetails(
        content,
        settings,
        availability,
        controlsDisabled,
        activeProvider,
      );
    }
    const scanControl =
      content.querySelector<HTMLButtonElement>("#scan-connections");
    if (scanControl) scanControl.onclick = deps.scan;
    const addControl = content.querySelector<HTMLButtonElement>(
      "#add-custom-connection",
    );
    if (addControl)
      addControl.onclick = () => {
        previousProvider = selectedProvider;
        const provider = `custom:${crypto.randomUUID()}` as const;
        draftIsNew = true;
        pendingScan.add(provider);
        draft = {
          provider,
          enabled: true,
          name: "",
          command: "",
          args: [],
          stdin: "{prompt}",
          output: "text",
          responsePath: "",
        };
        cliTestState = "idle";
        cliTestMessage = "";
        content
          .querySelectorAll<HTMLElement>(".ai-models-row.is-selected")
          .forEach((row) => row.classList.remove("is-selected"));
        content
          .querySelector(".ai-models-workspace")
          ?.classList.add("is-adding");
        content
          .querySelector("#add-custom-connection")
          ?.classList.add("is-selected");
        const pane = content.querySelector<HTMLElement>(".ai-models-detail");
        if (pane) renderEditor(pane, controlsDisabled);
        content.querySelector<HTMLInputElement>("#custom-name")?.focus();
      };
    content
      .querySelectorAll<HTMLButtonElement>("[data-select-provider]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          if (controlsDisabled) return;
          selectedProvider = button.dataset.selectProvider;
          draft = undefined;
          render(content);
        }),
      );
    content
      .querySelectorAll<HTMLButtonElement>("[data-connection-grip]")
      .forEach((grip) => {
        const provider = grip.dataset.connectionGrip;
        if (!provider) return;
        grip.addEventListener("keydown", (event) => {
          if (!event.altKey || controlsDisabled) return;
          const delta =
            event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
          if (!delta) return;
          event.preventDefault();
          void moveConnection(content, provider, delta);
        });
        grip.addEventListener("dragstart", (event) => {
          const row = grip.closest<HTMLElement>(".ai-models-row");
          if (!row || controlsDisabled) {
            event.preventDefault();
            return;
          }
          row.classList.add("is-dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", provider);
          }
        });
        grip.addEventListener("dragend", () => {
          const ordered = [
            ...content.querySelectorAll<HTMLElement>(
              ".ai-models-row[data-provider]",
            ),
          ].map((row) => row.dataset.provider!);
          const byProvider = new Map<
            string,
            TextConnectionSettings["connections"][number]
          >(
            deps
              .getSettings()
              .connections.map((entry) => [entry.provider, entry]),
          );
          const connections = ordered.flatMap((id) => {
            const entry = byProvider.get(id);
            return entry ? [entry] : [];
          });
          content
            .querySelectorAll(".ai-models-row")
            .forEach((row) => row.classList.remove("is-dragging"));
          if (connections.length === deps.getSettings().connections.length)
            void saveConnections(connections);
        });
      });
    content.querySelectorAll<HTMLElement>(".ai-models-row").forEach((row) => {
      row.ondragover = (event) => {
        const dragging = content.querySelector<HTMLElement>(
          ".ai-models-row.is-dragging",
        );
        if (!dragging || dragging === row || controlsDisabled) return;
        event.preventDefault();
        const bounds = row.getBoundingClientRect();
        const insertBefore = event.clientY < bounds.top + bounds.height / 2;
        const list = row.parentElement;
        if (!list) return;
        list.insertBefore(
          dragging,
          insertBefore ? row : row.nextElementSibling,
        );
      };
    });
  };

  return {
    render,
    get editing() {
      return draft !== undefined;
    },
    cancelEdit,
  };
}

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
type Dependencies = {
  getSnapshot(): Snapshot;
  getSettings(): TextConnectionSettings;
  saveSettings(settings: TextConnectionSettings): Promise<boolean>;
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

export function createAiModelsSettings(deps: Dependencies) {
  let draft: CustomCliConnection | undefined;
  let draftIsNew = false;
  let editedProvider: string | undefined;
  const pendingScan = new Set<string>();

  const saveConnections = (
    connections: TextConnectionSettings["connections"],
  ) => deps.saveSettings({ ...deps.getSettings(), connections });

  const renderEditor = (content: HTMLElement) => {
    if (!draft) return;
    const json = draft.output === "json";
    content.innerHTML = `<section class="ai-models-editor" aria-label="${esc(t("New CLI connection"))}">
      <header class="ai-models-editor-header"><button type="button" id="ai-models-back">← ${esc(t("AI models"))}</button><div><p>${esc(t("AI models"))}</p><h2>${esc(t(draftIsNew ? "New CLI connection" : "Edit CLI connection"))}</h2></div></header>
      <div class="ai-models-editor-body">
        <label>${esc(t("Connection name"))}<input id="custom-name" maxlength="128" value="${esc(draft.name)}" autocomplete="off"></label>
        <label>${esc(t("Executable or command"))}<input id="custom-command" maxlength="1024" value="${esc(draft.command)}" autocomplete="off"></label>
        <label class="ai-models-wide">${esc(t("Arguments (one per line)"))}<textarea id="custom-args" rows="5">${esc(draft.args.join("\n"))}</textarea><small>${esc(t("Arguments are passed directly, without a shell. The transcript is sent through standard input."))}</small></label>
        <label>${esc(t("Output format"))}<select id="custom-output"><option value="text" ${!json ? "selected" : ""}>${esc(t("Plain text"))}</option><option value="json" ${json ? "selected" : ""}>JSON</option></select></label>
        ${json ? `<label>${esc(t("JSON response field"))}<input id="custom-response-path" maxlength="512" value="${esc(draft.responsePath)}" placeholder="response"></label>` : ""}
        <p class="ai-models-preview ai-models-wide"><strong>${esc(t("Preview"))}</strong><code>${esc([draft.command || t("Executable or command"), ...draft.args].join(" "))} · stdin</code>${json ? `<span>${esc(t("JSON field"))}: ${esc(draft.responsePath || "response")}</span>` : ""}</p>
      </div>
      <footer class="ai-models-editor-footer"><button type="button" id="ai-models-cancel">${esc(t("Cancel"))}</button><button type="button" id="ai-models-save" class="primary" ${draft.name.trim() && draft.command.trim() ? "" : "disabled"}>${esc(t("Save CLI connection"))}</button></footer>
    </section>`;

    const sync = () => {
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
        output: (content.querySelector<HTMLSelectElement>("#custom-output")
          ?.value ?? draft.output) as "text" | "json",
        responsePath:
          content.querySelector<HTMLInputElement>("#custom-response-path")
            ?.value ?? (draft.output === "json" ? draft.responsePath : ""),
      };
      if (draft.output === "text") draft.responsePath = "";
    };
    content
      .querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(
        ".ai-models-editor-body input, .ai-models-editor-body textarea, .ai-models-editor-body select",
      )
      .forEach((field) =>
        field.addEventListener(
          field instanceof HTMLSelectElement ? "change" : "input",
          () => {
            sync();
            if (field.id === "custom-output") renderEditor(content);
            else updatePreview(content);
          },
        ),
      );
    content
      .querySelector("#ai-models-back")
      ?.addEventListener("click", cancelEdit);
    content
      .querySelector("#ai-models-cancel")
      ?.addEventListener("click", cancelEdit);
    content.querySelector("#ai-models-save")?.addEventListener("click", () => {
      void (async () => {
        sync();
        if (!draft) return;
        const savedDraft = draft;
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
          if (draft === savedDraft) {
            draft = undefined;
            draftIsNew = false;
            editedProvider = undefined;
          }
          deps.requestRender();
          deps.scan();
        }
      })();
    });
  };

  const updatePreview = (content: HTMLElement) => {
    if (!draft) return;
    const preview = content.querySelector<HTMLElement>(
      ".ai-models-preview code",
    );
    if (preview)
      preview.textContent = `${[draft.command || t("Executable or command"), ...draft.args].join(" ")} · stdin`;
    const field = content.querySelector<HTMLElement>(".ai-models-preview span");
    if (field)
      field.textContent = `${t("JSON field")}: ${draft.responsePath || "response"}`;
    const save = content.querySelector<HTMLButtonElement>("#ai-models-save");
    if (save) save.disabled = !draft.name.trim() || !draft.command.trim();
  };

  const cancelEdit = () => {
    const cancelledProvider = draft?.provider;
    draft = undefined;
    if (editedProvider) pendingScan.delete(editedProvider);
    else if (cancelledProvider) pendingScan.delete(cancelledProvider);
    draftIsNew = false;
    editedProvider = undefined;
    deps.requestRender();
  };

  const render = (content: HTMLElement) => {
    if (draft) {
      renderEditor(content);
      return;
    }
    const { available, scanning, busy } = deps.getSnapshot();
    const settings = deps.getSettings();
    const availability = new Map(
      available.map((item) => [item.provider, item]),
    );
    const standardProvider = settings.connections.find(
      (connection) => connection.enabled,
    )?.provider;
    const controlsDisabled = scanning || busy;
    content.innerHTML = `<section class="ai-models-intro"><div><p>${esc(t("Models power AI features such as AI text revision in Text processing. They start off."))}</p><p>${esc(t("Only the first enabled model is used."))}</p></div><button type="button" id="scan-connections" ${scanning ? "disabled" : ""}><span class="ai-models-scan-dot ${scanning ? "scanning" : "ready"}"></span>${esc(t(scanning ? "Scanning …" : "Scan again"))}</button></section>
      <ol class="connection-list ai-models-list">${settings.connections
        .map((connection, index) => {
          const provider = connection.provider;
          const found = pendingScan.has(provider)
            ? undefined
            : availability.get(provider);
          const local = provider === "ollama" || provider === "lm_studio";
          const cli = provider === "claude_code" || provider === "codex";
          const custom = provider.startsWith("custom:");
          const usable = found?.usable ?? false;
          const name = custom
            ? (connection as CustomCliConnection).name
            : builtins[provider as BuiltinTextProvider];
          const status =
            found?.reason === "server_stopped"
              ? t("Server stopped")
              : found?.reason === "not_running"
                ? t("Not running")
                : found?.reason === "not_installed"
                  ? t("Not installed")
                  : found?.reason === "no_models"
                    ? t("No models found")
                    : found?.reason === "scan_failed"
                      ? t("Could not check this connection")
                      : usable
                        ? local && found?.models.length
                          ? t("Available · {count} models", {
                              count: found.models.length,
                            })
                          : t("Available")
                        : t("Not checked");
          const selected = local
            ? connection.model || found?.models[0] || ""
            : cli
              ? connection.model
              : "";
          const cliOptions =
            found?.model_options ??
            (found?.models ?? []).map((value) => ({
              value,
              display_name: formatModelId(value),
              source: "cli" as const,
            }));
          const selectableCliOptions =
            provider === "claude_code"
              ? cliOptions.filter((item) => item.value !== "default")
              : cliOptions;
          const recommendedClaude =
            provider === "claude_code" && selected === "default";
          const missingModel =
            selected &&
            !selectableCliOptions.some((item) => item.value === selected) &&
            !recommendedClaude;
          const model = local
            ? `<select data-connection-model="${esc(provider)}" aria-label="${esc(t("{provider} model", { provider: name }))}" ${!usable || controlsDisabled ? "disabled" : ""}>${connection.model && !found?.models.includes(connection.model) ? option(connection.model, formatModelId(connection.model), selected) : ""}${found?.models.length ? found.models.map((value) => option(value, formatModelId(value), selected)).join("") : option("", t("No models found"), selected)}</select>`
            : cli
              ? `<select data-cli-model="${esc(provider)}" aria-label="${esc(t("{provider} model", { provider: name }))}" ${!usable || controlsDisabled ? "disabled" : ""}>${option("", t("Use tool settings"), selected)}${selectableCliOptions.map((item) => option(item.value, item.display_name === item.value ? formatModelId(item.value) : item.display_name, selected)).join("")}${recommendedClaude ? option("default", t("Recommended Claude model"), selected) : ""}${missingModel ? option(selected, formatModelId(selected), selected) : ""}</select>`
              : custom
                ? `<select aria-label="${esc(t("{provider} model", { provider: name }))}" disabled>${option("", t("Use tool settings"), "")}</select>`
                : `<span class="ai-models-command">${esc((connection as CustomCliConnection).command || t("Custom CLI"))}</span>`;
          const toggleDisabled =
            (!connection.enabled && (!usable || (local && !selected))) ||
            busy ||
            scanning;
          return `<li class="connection-card connection-row" data-provider="${esc(provider)}"><span class="connection-number">${index + 1}</span><div class="connection-identity"><strong>${esc(name)}${provider === standardProvider ? `<span class="connection-default">${esc(t("Standard"))}</span>` : ""}</strong><span class="connection-state ${usable ? "available" : "unavailable"}">${esc(status)}</span>${provider === "lm_studio" && found?.reason === "server_stopped" ? `<button type="button" class="connection-start-server" data-start-lm-studio ${controlsDisabled ? "disabled" : ""}>${esc(t("Start server"))}</button>` : ""}</div><label class="connection-model"><span class="visually-hidden">${esc(t("Model"))}</span>${model}</label><label class="connection-toggle" title="${esc(t("Enabled"))}"><input class="switch connection-switch" type="checkbox" data-connection-enabled="${esc(provider)}" ${connection.enabled ? "checked" : ""} ${toggleDisabled ? "disabled" : ""}><span class="visually-hidden">${esc(t("Enabled"))}</span></label><div class="connection-order"><button type="button" data-connection-move="up" data-provider="${esc(provider)}" aria-label="${esc(t("Move {provider} up", { provider: name }))}" ${index === 0 || controlsDisabled ? "disabled" : ""}>↑</button><button type="button" data-connection-move="down" data-provider="${esc(provider)}" aria-label="${esc(t("Move {provider} down", { provider: name }))}" ${index === settings.connections.length - 1 || controlsDisabled ? "disabled" : ""}>↓</button>${custom ? `<button type="button" data-connection-edit="${esc(provider)}" ${controlsDisabled ? "disabled" : ""}>${esc(t("Edit"))}</button><button type="button" data-connection-remove="${esc(provider)}" aria-label="${esc(t("Remove {provider}", { provider: name }))}" ${controlsDisabled ? "disabled" : ""}>×</button>` : ""}</div></li>`;
        })
        .join(
          "",
        )}<li class="ai-models-add-row"><button type="button" id="add-custom-connection" ${settings.connections.length >= 20 || controlsDisabled ? "disabled" : ""}>＋ ${esc(t("Add CLI connection"))}</button></li></ol>
      <p class="connection-privacy">${esc(t("Local servers do not prove local-only processing. CLI tools and custom commands may send text to cloud services."))}</p>`;

    content
      .querySelector("#scan-connections")
      ?.addEventListener("click", deps.scan);
    content
      .querySelector<HTMLButtonElement>("[data-start-lm-studio]")
      ?.addEventListener("click", (event) => {
        (event.currentTarget as HTMLButtonElement).disabled = true;
        deps.startLmStudio();
      });
    content
      .querySelector("#add-custom-connection")
      ?.addEventListener("click", () => {
        const provider = `custom:${crypto.randomUUID()}` as const;
        draftIsNew = true;
        editedProvider = undefined;
        pendingScan.add(provider);
        draft = {
          provider,
          enabled: false,
          name: "",
          command: "",
          args: [],
          stdin: "{prompt}",
          output: "text",
          responsePath: "",
        };
        deps.requestRender();
      });
    content
      .querySelectorAll<HTMLButtonElement>("[data-connection-edit]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const entry = deps
            .getSettings()
            .connections.find(
              (item) => item.provider === button.dataset.connectionEdit,
            );
          if (!entry || !entry.provider.startsWith("custom:")) return;
          draftIsNew = false;
          pendingScan.add(entry.provider);
          draft = {
            ...(entry as CustomCliConnection),
            args: [...(entry as CustomCliConnection).args],
          };
          deps.requestRender();
        }),
      );
    content
      .querySelectorAll<HTMLInputElement>("[data-connection-enabled]")
      .forEach((input) =>
        input.addEventListener("change", () => {
          const provider = input.dataset.connectionEnabled!;
          const connections = deps.getSettings().connections.map((entry) => {
            if (entry.provider !== provider) return entry;
            if (
              (entry.provider === "ollama" || entry.provider === "lm_studio") &&
              input.checked
            ) {
              const selected =
                content.querySelector<HTMLSelectElement>(
                  `[data-connection-model="${CSS.escape(provider)}"]`,
                )?.value ?? "";
              return {
                ...entry,
                model: selected,
                enabled: selected.length > 0,
              };
            }
            return {
              ...entry,
              enabled:
                input.checked && !!availability.get(entry.provider)?.usable,
            };
          });
          void saveConnections(connections);
        }),
      );
    content
      .querySelectorAll<HTMLSelectElement>("[data-connection-model]")
      .forEach((select) =>
        select.addEventListener("change", () => {
          const provider = select.dataset.connectionModel!;
          void saveConnections(
            deps
              .getSettings()
              .connections.map((entry) =>
                entry.provider === provider &&
                (entry.provider === "ollama" || entry.provider === "lm_studio")
                  ? { ...entry, model: select.value }
                  : entry,
              ),
          );
        }),
      );
    content
      .querySelectorAll<HTMLSelectElement>("[data-cli-model]")
      .forEach((select) =>
        select.addEventListener("change", () => {
          const provider = select.dataset.cliModel!;
          void saveConnections(
            deps
              .getSettings()
              .connections.map((entry) =>
                entry.provider === provider &&
                (entry.provider === "claude_code" || entry.provider === "codex")
                  ? { ...entry, model: select.value }
                  : entry,
              ),
          );
        }),
      );
    content
      .querySelectorAll<HTMLButtonElement>("[data-connection-move]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          const connections = [...deps.getSettings().connections];
          const index = connections.findIndex(
            (entry) => entry.provider === button.dataset.provider,
          );
          const next =
            index + (button.dataset.connectionMove === "up" ? -1 : 1);
          if (index < 0 || next < 0 || next >= connections.length) return;
          [connections[index], connections[next]] = [
            connections[next]!,
            connections[index]!,
          ];
          void saveConnections(connections);
        }),
      );
    content
      .querySelectorAll<HTMLButtonElement>("[data-connection-remove]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          void saveConnections(
            deps
              .getSettings()
              .connections.filter(
                (entry) => entry.provider !== button.dataset.connectionRemove,
              ),
          );
        }),
      );
  };

  return {
    render,
    get editing() {
      return draft !== undefined;
    },
    cancelEdit,
  };
}

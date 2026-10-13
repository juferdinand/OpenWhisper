import { escapeHtml as esc } from "../escape-html";
import { t } from "../i18n";
import {
  defaultTextRevisionSettings,
  type TextConnectionSettings,
  type TextConnectionAvailability,
  type TextRevisionSettings,
} from "../../../src/contracts/text/connections.js";
import "./ai-revision.css";

const rules = [
  [
    "spelling_grammar",
    "Spelling and grammar",
    "Correct errors while keeping your choice of words.",
  ],
  [
    "resolve_verbal_corrections",
    "Resolve verbal corrections",
    "“Tuesday, no, Wednesday” becomes “Wednesday”.",
  ],
  [
    "paragraphs",
    "Add paragraphs",
    "Break longer recordings at changes of topic.",
  ],
  [
    "numbers_times",
    "Consistent numbers and times",
    "“Seven o’clock” becomes “07:00”; dates use DD.MM.YYYY.",
  ],
] as const;

export function aiRevisionMarkup(
  settings: TextConnectionSettings,
  available: TextConnectionAvailability[],
): string {
  const revision = settings.revision ?? defaultTextRevisionSettings();
  const selected = settings.connections.find(
    (connection) => connection.enabled,
  );
  const found = available.find(
    (entry) => entry.provider === selected?.provider,
  );
  const usable =
    found?.usable === true &&
    selected !== undefined &&
    (!(selected.provider === "ollama" || selected.provider === "lm_studio") ||
      (!!selected.model && found.models.includes(selected.model)));
  const providerName =
    selected && "name" in selected
      ? selected.name
      : selected?.provider === "ollama"
        ? "Ollama"
        : selected?.provider === "lm_studio"
          ? "LM Studio"
          : selected?.provider === "claude_code"
            ? "Claude Code"
            : selected?.provider === "codex"
              ? "Codex"
              : "";
  const model = selected && "model" in selected ? selected.model : "";
  const active = [
    ...rules
      .filter(([key]) => revision.builtins[key])
      .map(([, label]) => t(label)),
    ...revision.custom_rules
      .filter((rule) => rule.enabled)
      .map((rule) => rule.text),
  ];
  const switchMarkup = (attributes: string, checked: boolean, label: string) =>
    `<input class="switch" type="checkbox" ${attributes} aria-label="${esc(label)}" ${checked ? "checked" : ""}>`;
  return `<section class="text-processing-card ai-revision-card ${revision.enabled ? "is-active" : ""}">
    <header class="ai-revision-heading"><div><h2><i aria-hidden="true"></i>3. ${esc(t("AI revision"))}<span class="ai-revision-badge">${esc(t("Optional"))}</span></h2><p>${esc(t("An AI model corrects your text using your rules. Content and wording are preserved."))}</p></div>${switchMarkup(`id="ai-revision-enabled" ${!usable && !revision.enabled ? "disabled" : ""}`, revision.enabled, t("Enable AI revision"))}</header>
    ${!settings.revision ? `<p class="secondary ai-revision-legacy">${esc(t("Your previous AI settings remain saved. Set up AI revision using the rules below."))}</p>` : ""}
    ${!usable ? `<div class="ai-revision-model-needed"><span>${esc(t("Enable an AI model, such as Ollama or Claude Code, to use this feature."))}</span><button type="button" class="primary" data-settings-view="connections">${esc(t("Set up an AI model"))}</button></div>` : ""}
    ${revision.enabled ? `<div class="ai-revision-rules">${rules.map(([key, label, description]) => `<label class="ai-revision-rule"><span><strong>${esc(t(label))}</strong><small>${esc(t(description))}</small></span>${switchMarkup(`data-revision-rule="${key}"`, revision.builtins[key], t(label))}</label>`).join("")}${revision.custom_rules.map((rule) => `<div class="ai-revision-rule"><span><strong>${esc(rule.text)}<span class="ai-revision-badge">${esc(t("Custom"))}</span></strong><small>${esc(t("Custom rule"))}</small></span><span class="ai-revision-rule-actions"><button type="button" class="rule-remove" data-remove-revision-rule="${esc(rule.id)}" aria-label="${esc(t("Remove rule"))}">×</button>${switchMarkup(`data-custom-revision-rule="${esc(rule.id)}"`, rule.enabled, rule.text)}</span></div>`).join("")}<form id="add-revision-rule"><input id="revision-rule-text" maxlength="8192" aria-label="${esc(t("Custom rule"))}" placeholder="${esc(t("Custom rule, such as “Use formal language”"))}"><button type="submit" ${revision.custom_rules.length >= 32 ? "disabled" : ""}>${esc(t("Add"))}</button></form></div><p class="ai-revision-summary">${esc(active.length ? t("{count} active · applied in this order: {rules}", { count: String(active.length), rules: active.join(" → ") }) : t("No active rule. Text after vocabulary correction stays unchanged."))}</p>` : ""}
    <div class="ai-revision-model"><span>${esc(selected ? t("Uses {model}", { model: [providerName, model].filter(Boolean).join(" · ") }) : t("No AI model enabled"))}</span><button type="button" class="link" data-settings-view="connections">${esc(t("Change AI models"))}</button></div>
  </section>`;
}

export function bindAiRevision(
  container: HTMLElement,
  options: {
    settings(): TextConnectionSettings;
    save(settings: TextConnectionSettings): Promise<boolean>;
  },
): void {
  const save = (
    change: (revision: TextRevisionSettings) => TextRevisionSettings,
  ) => {
    const settings = options.settings();
    return options.save({
      ...settings,
      revision: change(settings.revision ?? defaultTextRevisionSettings()),
    });
  };
  container
    .querySelector<HTMLInputElement>("#ai-revision-enabled")
    ?.addEventListener("change", (event) => {
      const enabled = (event.currentTarget as HTMLInputElement).checked;
      void save((revision) => ({ ...revision, enabled }));
    });
  container
    .querySelectorAll<HTMLInputElement>("[data-revision-rule]")
    .forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset
          .revisionRule as keyof TextRevisionSettings["builtins"];
        void save((revision) => ({
          ...revision,
          builtins: { ...revision.builtins, [key]: input.checked },
        }));
      });
    });
  container
    .querySelectorAll<HTMLInputElement>("[data-custom-revision-rule]")
    .forEach((input) => {
      input.addEventListener(
        "change",
        () =>
          void save((revision) => ({
            ...revision,
            custom_rules: revision.custom_rules.map((rule) =>
              rule.id === input.dataset.customRevisionRule
                ? { ...rule, enabled: input.checked }
                : rule,
            ),
          })),
      );
    });
  container
    .querySelectorAll<HTMLButtonElement>("[data-remove-revision-rule]")
    .forEach((button) => {
      button.addEventListener(
        "click",
        () =>
          void save((revision) => ({
            ...revision,
            custom_rules: revision.custom_rules.filter(
              (rule) => rule.id !== button.dataset.removeRevisionRule,
            ),
          })),
      );
    });
  container
    .querySelector<HTMLFormElement>("#add-revision-rule")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = container.querySelector<HTMLInputElement>(
        "#revision-rule-text",
      )!;
      const text = input.value.trim();
      if (!text) return;
      void save((revision) => ({
        ...revision,
        custom_rules: [
          ...revision.custom_rules,
          { id: crypto.randomUUID(), text, enabled: true },
        ],
      }));
    });
}

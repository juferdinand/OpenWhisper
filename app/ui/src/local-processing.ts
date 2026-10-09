import { invoke } from "./bridge.js";
import { t } from "./i18n.js";
import {
  defaultLocalProcessingProfile,
  localProcessingProfilePatchSchema,
  previewLocalProcessingInputSchema,
  type LocalProcessingProfile as ProcessingProfile,
  type LocalProcessingProfilePatch,
} from "../../src/contracts/speech/local-processing.js";
const defaults = defaultLocalProcessingProfile();
const profileKeys = [
  "enabled",
  "provider",
  "endpoint",
  "model",
  "instruction",
  "max_tokens",
  "timeout_seconds",
] as const;
const failureMessages = {
  INVALID_REQUEST:
    "Preview text must contain between 1 byte and 64 KB; your dictation is unchanged",
  INVALID_PROFILE: "Invalid text processing profile",
  DISABLED: "Text processing preview is disabled",
  MODEL_REQUIRED: "Enter a text model identifier",
  BUSY: "A text processing preview is already running",
  CANCELLED: "Text processing cancelled; your dictation is unchanged",
  CLOSED: "Text processing preview is unavailable",
  TIMEOUT: "Text processing timed out; your dictation is unchanged",
  CONNECTION_FAILED:
    "Could not connect to the selected local server; your dictation is unchanged",
  HTTP_REJECTED:
    "The local server rejected the request; check its model and authentication settings",
  RESPONSE_TOO_LARGE: "The model response exceeded the preview limit",
  RESPONSE_READ_FAILED: "Could not read the model response",
  INVALID_RESPONSE: "The model returned an invalid or incomplete text response",
};
let input = "";
let result = "";
let feedback = "";
let requestID: string | undefined;
let latestRequestID: string | undefined;
let draft: ProcessingProfile | undefined;
const pendingFields: LocalProcessingProfilePatch = {};
let saves = 0;
let patchSequence = 0;
const fieldVersions = new Map<keyof ProcessingProfile, number>();
let current:
  | {
      root: HTMLElement;
      profile: ProcessingProfile | undefined;
      latest: string;
      save: (changes: LocalProcessingProfilePatch) => Promise<boolean>;
      invalidProfile: boolean;
    }
  | undefined;
function refresh() {
  if (current?.root.isConnected)
    mountProcessingPreview(
      current.root,
      current.profile,
      current.latest,
      current.save,
      current.invalidProfile,
    );
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** The renderer retains preview fields for this session; host transport never adds them to app state. */
export function mountProcessingPreview(
  root: HTMLElement,
  profile: ProcessingProfile | undefined,
  latest: string,
  save: (changes: LocalProcessingProfilePatch) => Promise<boolean>,
  invalidProfile = false,
) {
  current = { root, profile, latest, save, invalidProfile };
  const base = profile ?? defaults;
  const p: ProcessingProfile = {
    enabled: pendingFields.enabled ?? base.enabled,
    provider: pendingFields.provider ?? base.provider,
    endpoint: pendingFields.endpoint ?? base.endpoint,
    model: pendingFields.model ?? base.model,
    instruction: pendingFields.instruction ?? base.instruction,
    max_tokens: pendingFields.max_tokens ?? base.max_tokens,
    timeout_seconds: pendingFields.timeout_seconds ?? base.timeout_seconds,
  };
  draft = p;
  if (!root.dataset.processingBuilt) {
    root.dataset.processingBuilt = "true";
    root.innerHTML = `<h2>${escape(t("Text processing preview"))}</h2><div class="group processing-preview">
    <p id="processing-profile-warning" role="alert" ${invalidProfile ? "" : "hidden"}>${escape(t("Saved text processing preferences are invalid. Previews are disabled; edit this profile to replace the saved file."))}</p>
    <p class="secondary">${escape(t("Optional and manual. Dictation stays independent; preview results never replace your original text."))}</p>
    <p>${escape(t("Only numeric loopback servers are allowed. The selected server or model may still send data remotely; check its configuration before sending."))}</p>
    <label class="row"><span>${escape(t("Enable manual previews"))}</span><input id="processing-enabled" class="switch" type="checkbox" ${p.enabled ? "checked" : ""} ${requestID ? "disabled" : ""}></label>
    <label class="row"><span>${escape(t("Text provider"))}</span><select id="processing-provider" ${requestID ? "disabled" : ""}><option value="lm_studio" ${p.provider === "lm_studio" ? "selected" : ""}>LM Studio</option><option value="ollama" ${p.provider === "ollama" ? "selected" : ""}>Ollama</option></select></label>
    <label class="processing-field">${escape(t("Server endpoint"))}<input id="processing-endpoint" type="url" value="${escape(p.endpoint)}" spellcheck="false" ${requestID ? "disabled" : ""}></label>
    <label class="processing-field">${escape(t("Text model identifier"))}<input id="processing-model" value="${escape(p.model)}" spellcheck="false" ${requestID ? "disabled" : ""}></label>
    <label class="processing-field">${escape(t("Processing instruction"))}<textarea id="processing-instruction" rows="3" ${requestID ? "disabled" : ""}>${escape(p.instruction)}</textarea></label>
    <div class="processing-limits"><label>${escape(t("Maximum output tokens"))}<input id="processing-max_tokens" type="number" min="32" max="4096" value="${p.max_tokens}" ${requestID ? "disabled" : ""}></label><label>${escape(t("Timeout in seconds"))}<input id="processing-timeout_seconds" type="number" min="1" max="120" value="${p.timeout_seconds}" ${requestID ? "disabled" : ""}></label></div>
    <label class="processing-field">${escape(t("Text to send"))}<textarea id="processing-input" rows="5" ${requestID ? "readonly" : ""}>${escape(input)}</textarea></label>
    <p id="processing-destination" class="secondary">${escape(t("Destination: {endpoint} · {model}", { endpoint: p.endpoint, model: p.model || t("No text model selected") }))}</p>
    <div class="processing-actions"><button id="processing-use-latest" ${requestID || !latest ? "disabled" : ""}>${escape(t("Use latest dictation"))}</button><button id="processing-send" ${requestID || !p.enabled || !p.model.trim() || !input.trim() ? "disabled" : ""}>${escape(t("Send preview"))}</button><button id="processing-cancel" ${requestID ? "" : "hidden"}>${escape(t("Cancel"))}</button></div>
    <p id="processing-feedback" role="status">${escape(t(requestID ? "Processing preview …" : feedback))}</p>
    <label class="processing-field">${escape(t("Preview result"))}<textarea id="processing-result" rows="5" readonly>${escape(result)}</textarea></label>
  </div>`;
    const field = <
      T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    >(
      name: string,
    ) => root.querySelector<T>(`#processing-${name}`)!;
    const updateSend = () => {
      root.querySelector<HTMLButtonElement>("#processing-send")!.disabled =
        !!requestID ||
        !!saves ||
        !draft!.enabled ||
        !draft!.model.trim() ||
        !input.trim();
    };
    for (const name of profileKeys) {
      field(name).onchange = async () => {
        const control = field(name);
        const value =
          name === "enabled"
            ? control instanceof HTMLInputElement && control.checked
            : ["max_tokens", "timeout_seconds"].includes(name)
              ? Number(control.value)
              : control.value;
        const parsed = localProcessingProfilePatchSchema.safeParse(
          name === "provider"
            ? {
                provider: value,
                endpoint:
                  value === "ollama"
                    ? "http://127.0.0.1:11434"
                    : "http://127.0.0.1:1234/v1",
              }
            : { [name]: value },
        );
        if (!parsed.success) {
          feedback = "Invalid text processing profile";
          if (control instanceof HTMLInputElement && name === "enabled")
            control.checked = draft!.enabled;
          else control.value = String(draft![name]);
          refresh();
          return;
        }
        const patch = parsed.data;
        const keys = profileKeys.filter((key) => Object.hasOwn(patch, key));
        const version = ++patchSequence;
        for (const key of keys) fieldVersions.set(key, version);
        Object.assign(pendingFields, patch);
        saves++;
        refresh();
        let saved = false;
        const rejectedFields: (keyof ProcessingProfile)[] = [];
        try {
          saved = await current!.save(patch);
        } finally {
          for (const key of keys) {
            if (fieldVersions.get(key) === version) {
              delete pendingFields[key];
              fieldVersions.delete(key);
              if (!saved) rejectedFields.push(key);
            }
          }
          saves--;
          refresh();
          // A rejected select/number edit can still own focus. Restore that
          // value without replacing its node or overwriting a newer edit.
          for (const key of rejectedFields) {
            const control = current!.root.querySelector<
              HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >(`#processing-${key}`);
            if (!control) continue;
            if (key === "enabled" && control instanceof HTMLInputElement)
              control.checked = draft!.enabled;
            else if (
              ["max_tokens", "timeout_seconds"].includes(key)
                ? Number(control.value) === patch[key]
                : control.value === String(patch[key])
            )
              control.value = String(draft![key]);
          }
        }
      };
    }
    field<HTMLTextAreaElement>("input").oninput = () => {
      input = field("input").value;
      updateSend();
    };
    root
      .querySelector("#processing-use-latest")!
      .addEventListener("click", () => {
        input = current!.latest;
        result = "";
        feedback = "";
        refresh();
      });
    root
      .querySelector("#processing-send")!
      .addEventListener("click", async () => {
        if (requestID || saves) return;
        const id = crypto.randomUUID();
        if (
          !previewLocalProcessingInputSchema.safeParse({
            requestId: id,
            text: input,
          }).success
        ) {
          feedback = failureMessages.INVALID_REQUEST;
          refresh();
          return;
        }
        requestID = id;
        latestRequestID = id;
        result = "";
        feedback = "";
        refresh();
        try {
          const output = await invoke("preview_local_processing", {
            requestId: id,
            text: input,
          });
          if (requestID !== id) return;
          if (output.ok) {
            result = output.text;
            feedback = "Preview ready. Review it before using it.";
          } else {
            feedback = failureMessages[output.code];
          }
        } catch {
          if (requestID === id)
            feedback =
              "Could not complete the preview; your dictation is unchanged";
        } finally {
          if (requestID === id) {
            requestID = undefined;
            refresh();
          }
        }
      });
    root
      .querySelector("#processing-cancel")!
      .addEventListener("click", async () => {
        if (!requestID) return;
        const id = requestID;
        requestID = undefined;
        feedback = "Text processing cancelled; your dictation is unchanged";
        refresh();
        try {
          await invoke("cancel_local_processing", { requestId: id });
        } catch {
          if (latestRequestID === id && !requestID) {
            feedback =
              "Could not cancel the preview; its result will be ignored";
            refresh();
          }
        }
      });
  }
  for (const name of profileKeys) {
    const control = root.querySelector<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >(`#processing-${name}`)!;
    control.disabled = !!requestID;
    if (name === "enabled" && control instanceof HTMLInputElement)
      control.checked = p.enabled;
    else if (document.activeElement !== control)
      control.value = String(p[name]);
  }
  const text = root.querySelector<HTMLTextAreaElement>("#processing-input")!;
  text.readOnly = !!requestID;
  if (document.activeElement !== text) text.value = input;
  root.querySelector<HTMLTextAreaElement>("#processing-result")!.value = result;
  root.querySelector<HTMLElement>("#processing-profile-warning")!.hidden =
    !invalidProfile;
  root.querySelector<HTMLElement>("#processing-feedback")!.textContent = t(
    requestID ? "Processing preview …" : feedback,
  );
  root.querySelector<HTMLElement>("#processing-destination")!.textContent = t(
    "Destination: {endpoint} · {model}",
    { endpoint: p.endpoint, model: p.model || t("No text model selected") },
  );
  root.querySelector<HTMLButtonElement>("#processing-send")!.disabled =
    !!requestID ||
    !!saves ||
    !draft!.enabled ||
    !draft!.model.trim() ||
    !input.trim();
  root.querySelector<HTMLButtonElement>("#processing-cancel")!.hidden =
    !requestID;
  root.querySelector<HTMLButtonElement>("#processing-use-latest")!.disabled =
    !!requestID || !latest;
}

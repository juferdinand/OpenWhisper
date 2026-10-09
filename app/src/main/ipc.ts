import { Buffer } from "node:buffer";
import {
  MAX_UI_REQUEST_BYTES,
  MAX_UI_STATE_BYTES,
  validateCommandInput,
  validateCommandName,
  validateCommandOutput,
} from "../contracts/ui/state.js";
import type { CommandInput, CommandName } from "../contracts/ui/state.js";

export { MAX_UI_REQUEST_BYTES } from "../contracts/ui/state.js";
const MAX_UI_RESPONSE_BYTES = MAX_UI_STATE_BYTES + 64 * 1024;

export type UiWindowRole = "main" | "overlay";
export const TRUSTED_UI_URLS: Readonly<Record<UiWindowRole, string>> = Object.freeze({
  main: "app://openwhisper/index.html",
  overlay: "app://openwhisper/index.html?overlay=1",
});

export interface UiSender {
  readonly webContentsId: number;
  readonly mainFrame: boolean;
  readonly url: string;
}

export interface TrustedUiWindow {
  readonly webContentsId: number;
  readonly role: UiWindowRole;
}

/** Results are unknown at this trust boundary, then validated by their command schema. */
export type CommandHandlers = {
  readonly [N in CommandName]?: (args: CommandInput<N>) => unknown | Promise<unknown>;
};

const errorMessages = Object.freeze({
  UNTRUSTED_SENDER: "This window is not authorized to use the app bridge.",
  INVALID_REQUEST: "The app bridge request is invalid.",
  REQUEST_TOO_LARGE: "The app bridge request is too large.",
  FORBIDDEN_COMMAND: "This action is not available from this window.",
  UNAVAILABLE_COMMAND: "This action is not available in this build.",
  HANDLER_FAILED: "The app could not complete this action.",
  INVALID_RESPONSE: "The app returned an invalid bridge response.",
  RESPONSE_TOO_LARGE: "The app bridge response is too large.",
});

export type UiErrorCode = keyof typeof errorMessages;
export interface UiDispatchFailure {
  readonly ok: false;
  readonly error: { readonly code: UiErrorCode; readonly message: string };
}
interface UiDispatchSuccess {
  readonly ok: true;
  // The receiving preload validates this value again against its invoked command.
  readonly value: unknown;
}
export type UiDispatchResult = UiDispatchSuccess | UiDispatchFailure;

/** Never include exceptions, schema diagnostics or submitted values in wire errors. */
export function uiFailure(code: UiErrorCode): UiDispatchFailure {
  return { ok: false, error: { code, message: errorMessages[code] } };
}

interface UiDispatchRequest {
  readonly sender: unknown;
  readonly serializedRequest: unknown;
}
export interface UiDispatcher {
  isTrustedSender(sender: unknown): boolean;
  dispatch(request: UiDispatchRequest): Promise<UiDispatchResult>;
}

const overlayCommands: ReadonlySet<CommandName> = new Set([
  "get_state",
  "toggle_recording",
  "cancel_recording",
  "retry_transcription",
  "discard_recovery",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

type Route = (args: unknown) => Promise<UiDispatchResult>;

function route<N extends CommandName>(
  name: N,
  handler: CommandHandlers[N],
): Route {
  return async (args) => {
    let input: CommandInput<N>;
    try {
      input = validateCommandInput(name, args);
    } catch {
      return uiFailure("INVALID_REQUEST");
    }
    if (handler === undefined) return uiFailure("UNAVAILABLE_COMMAND");

    let result: unknown;
    try {
      result = await handler(input);
    } catch {
      return uiFailure("HANDLER_FAILED");
    }

    let value: unknown;
    try {
      value = validateCommandOutput(name, result);
    } catch {
      return uiFailure("INVALID_RESPONSE");
    }
    // Void actions use null so a JSON envelope still contains an explicit value.
    const response: UiDispatchSuccess = { ok: true, value: value === undefined ? null : value };
    try {
      if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_UI_RESPONSE_BYTES) {
        return uiFailure("RESPONSE_TOO_LARGE");
      }
    } catch {
      return uiFailure("INVALID_RESPONSE");
    }
    return response;
  };
}

/** A pure router; only the Electron wrapper may construct sender metadata from real frames. */
export function createUiDispatcher(options: {
  readonly windows: readonly TrustedUiWindow[];
  readonly handlers: CommandHandlers;
}): UiDispatcher {
  const windows = new Map<number, UiWindowRole>();
  for (const window of options.windows) {
    if (!Number.isSafeInteger(window.webContentsId) || window.webContentsId < 1 || windows.has(window.webContentsId)) {
      throw new Error("Trusted window IDs must be unique positive safe integers.");
    }
    if (window.role !== "main" && window.role !== "overlay") {
      throw new Error("Trusted window role is invalid.");
    }
    windows.set(window.webContentsId, window.role);
  }

  function senderRole(sender: unknown): UiWindowRole | undefined {
    try {
      if (!record(sender) || !exactKeys(sender, ["webContentsId", "mainFrame", "url"])) return undefined;
      if (sender.mainFrame !== true || typeof sender.webContentsId !== "number" || !Number.isSafeInteger(sender.webContentsId)) return undefined;
      const role = windows.get(sender.webContentsId);
      return role !== undefined && sender.url === TRUSTED_UI_URLS[role] ? role : undefined;
    } catch {
      return undefined;
    }
  }

  // Explicit entries keep input types coupled to their handlers. A new contract command
  // cannot silently bypass this map: satisfies requires adding its concrete route.
  const handlers = options.handlers;
  const routes = {
    get_state: route("get_state", handlers.get_state),
    save_preferences: route("save_preferences", handlers.save_preferences),
    save_local_processing: route("save_local_processing", handlers.save_local_processing),
    preview_local_processing: route("preview_local_processing", handlers.preview_local_processing),
    cancel_local_processing: route("cancel_local_processing", handlers.cancel_local_processing),
    toggle_recording: route("toggle_recording", handlers.toggle_recording),
    cancel_recording: route("cancel_recording", handlers.cancel_recording),
    retry_transcription: route("retry_transcription", handlers.retry_transcription),
    discard_recovery: route("discard_recovery", handlers.discard_recovery),
    complete_setup: route("complete_setup", handlers.complete_setup),
    refresh_microphones: route("refresh_microphones", handlers.refresh_microphones),
    copy_transcript: route("copy_transcript", handlers.copy_transcript),
    copy_history: route("copy_history", handlers.copy_history),
    clear_history: route("clear_history", handlers.clear_history),
    show_models_folder: route("show_models_folder", handlers.show_models_folder),
    download_model: route("download_model", handlers.download_model),
    cancel_download: route("cancel_download", handlers.cancel_download),
    delete_model: route("delete_model", handlers.delete_model),
    import_model: route("import_model", handlers.import_model),
    enable_shortcut: route("enable_shortcut", handlers.enable_shortcut),
    cancel_shortcut: route("cancel_shortcut", handlers.cancel_shortcut),
    clear_shortcut: route("clear_shortcut", handlers.clear_shortcut),
    desktop_shortcut: route("desktop_shortcut", handlers.desktop_shortcut),
    enable_paste: route("enable_paste", handlers.enable_paste),
    disable_paste: route("disable_paste", handlers.disable_paste),
    allow_microphone: route("allow_microphone", handlers.allow_microphone),
    choose_editor: route("choose_editor", handlers.choose_editor),
    show_transcripts_folder: route("show_transcripts_folder", handlers.show_transcripts_folder),
    open_login_settings: route("open_login_settings", handlers.open_login_settings),
    check_updates: route("check_updates", handlers.check_updates),
    install_update: route("install_update", handlers.install_update),
  } satisfies Record<CommandName, Route>;

  return {
    isTrustedSender: (sender) => senderRole(sender) !== undefined,
    async dispatch(request) {
      const role = senderRole(request.sender);
      if (role === undefined) return uiFailure("UNTRUSTED_SENDER");

      const serialized = request.serializedRequest;
      if (typeof serialized !== "string") return uiFailure("INVALID_REQUEST");
      // The cheap character check bounds the work before counting UTF-8 bytes or parsing.
      if (serialized.length > MAX_UI_REQUEST_BYTES || Buffer.byteLength(serialized, "utf8") > MAX_UI_REQUEST_BYTES) {
        return uiFailure("REQUEST_TOO_LARGE");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        return uiFailure("INVALID_REQUEST");
      }
      if (!record(parsed) || !exactKeys(parsed, ["command", "args"])) return uiFailure("INVALID_REQUEST");
      let command: CommandName;
      try {
        command = validateCommandName(parsed.command);
      } catch {
        return uiFailure("INVALID_REQUEST");
      }
      if (role === "overlay" && !overlayCommands.has(command)) return uiFailure("FORBIDDEN_COMMAND");
      return routes[command](parsed.args);
    },
  };
}

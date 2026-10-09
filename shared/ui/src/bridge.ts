import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { DesktopBridge } from "../../../electron/src/contracts/bridge";
import {
  validateCommandInput,
  validateCommandOutput,
  validateEvent,
  type CommandName,
  type CommandInput,
  type CommandOutput,
  type EventName,
  type EventPayload,
} from "../../../electron/src/contracts/ui";

declare global {
  interface Window {
    openwhisper?: DesktopBridge;
    webkit?: {
      messageHandlers?: {
        openwhisper?: { postMessage(message: unknown): Promise<unknown> };
      };
    };
  }
}
const mac = window.webkit?.messageHandlers?.openwhisper;
type EmptyCommand = {
  [N in CommandName]: CommandInput<N> extends Record<string, never> ? N : never;
}[CommandName];

/** Transitional hosts share one validated contract while their adapters are replaced. */
export function invoke<N extends EmptyCommand>(
  command: N,
): Promise<CommandOutput<N>>;
export function invoke<N extends CommandName>(
  command: N,
  args: CommandInput<N>,
): Promise<CommandOutput<N>>;
export async function invoke(command: CommandName, args: unknown = {}) {
  const input = validateCommandInput(command, args);
  let result: unknown;
  if (window.openwhisper)
    result = await window.openwhisper.invoke(command, input);
  else if (mac) result = await mac.postMessage({ command, args: input });
  else result = await tauriInvoke<unknown>(command, input);
  return validateCommandOutput(command, result);
}

export async function listen<N extends EventName>(
  name: N,
  handler: (event: { payload: EventPayload<N> }) => void,
): Promise<() => void> {
  const receive = (value: unknown) => {
    let payload: EventPayload<N>;
    try {
      payload = validateEvent(name, value);
    } catch {
      return;
    }
    handler({ payload });
  };
  if (window.openwhisper) return window.openwhisper.subscribe(name, receive);
  if (!mac)
    return tauriListen<unknown>(name, (event) => receive(event.payload));
  const callback = (event: Event) => {
    if (event instanceof CustomEvent) {
      const detail: unknown = event.detail;
      receive(detail);
    }
  };
  window.addEventListener(`openwhisper:${name}`, callback);
  return () => window.removeEventListener(`openwhisper:${name}`, callback);
}

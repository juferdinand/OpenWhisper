import type { DesktopBridge } from "../../src/contracts/ui/bridge.js";
import {
  validateCommandInput,
  validateCommandOutput,
  validateEvent,
  type CommandName,
  type CommandInput,
  type CommandOutput,
  type EventName,
  type EventPayload,
} from "../../src/contracts/ui/state.js";

declare global {
  interface Window {
    openwhisper?: DesktopBridge;
  }
}

type EmptyCommand = {
  [N in CommandName]: CommandInput<N> extends Record<string, never> ? N : never;
}[CommandName];

function desktopBridge(): DesktopBridge {
  if (!window.openwhisper)
    throw new Error("The OpenWhisper desktop bridge is unavailable.");
  return window.openwhisper;
}

export function invoke<N extends EmptyCommand>(
  command: N,
): Promise<CommandOutput<N>>;
export function invoke<N extends CommandName>(
  command: N,
  args: CommandInput<N>,
): Promise<CommandOutput<N>>;
export async function invoke(command: CommandName, args: unknown = {}) {
  const input = validateCommandInput(command, args);
  const result = await desktopBridge().invoke(command, input);
  return validateCommandOutput(command, result);
}

export async function listen<N extends EventName>(
  name: N,
  handler: (event: { payload: EventPayload<N> }) => void,
): Promise<() => void> {
  const bridge = desktopBridge();
  return bridge.subscribe(name, (value) => {
    let payload: EventPayload<N>;
    try {
      payload = validateEvent(name, value);
    } catch {
      return;
    }
    handler({ payload });
  });
}

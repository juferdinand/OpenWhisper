import type { CommandName, EventName } from "./ui.js";

/** Every value is validated on each side of this isolated-world boundary. */
export interface DesktopBridge {
  invoke(command: CommandName, args: unknown): Promise<unknown>;
  subscribe(name: EventName, callback: (payload: unknown) => void): () => void;
}

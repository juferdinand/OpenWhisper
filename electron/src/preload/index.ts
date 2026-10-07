import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import type { DesktopBridge } from "../contracts/bridge.js";
import {
  MAX_UI_REQUEST_BYTES, validateCommandInput, validateCommandName,
  validateCommandOutput, validateEvent, validateEventName,
} from "../contracts/ui.js";

const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: z.string().max(64), message: z.string().max(256) }),
  }),
]);

const api: DesktopBridge = {
  async invoke(command, args) {
    const name = validateCommandName(command);
    const input = validateCommandInput(name, args);
    const serialized = JSON.stringify({ command: name, args: input });
    if (new TextEncoder().encode(serialized).byteLength > MAX_UI_REQUEST_BYTES) {
      throw new Error("The app bridge request is too large.");
    }
    const raw: unknown = await ipcRenderer.invoke("openwhisper:invoke", serialized);
    const reply = replySchema.safeParse(raw);
    if (!reply.success) throw new Error("The app returned an invalid bridge response.");
    if (!reply.data.ok) throw new Error(reply.data.error.message);
    return validateCommandOutput(name, reply.data.value);
  },
  subscribe(name, callback) {
    const event = validateEventName(name);
    if (typeof callback !== "function") throw new Error("An event callback is required.");
    const channel = `openwhisper:event:${event}`;
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      let validated: unknown;
      try { validated = validateEvent(event, payload); } catch { return; }
      callback(validated);
    };
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
};
contextBridge.exposeInMainWorld("openwhisper", Object.freeze(api));

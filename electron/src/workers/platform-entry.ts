import { BusFailure, LinuxBus, openLinuxBus } from "../platforms/linux/shared/bus.js";
import { ControlServiceError, DevControlService, type ControlCapturePort } from "../platforms/linux/shared/control.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifyDevelopmentLinuxBusArtifact } from "../services/development-artifact.js";
import type { PortalShortcutState } from "../platforms/linux/shared/portal-shortcuts.js";
import { DesktopShortcuts } from "../platforms/linux/shared/desktop-shortcuts.js";
import { kdeJournalSchema } from "../platforms/linux/kde/keyboard.js";
import { PrivateStateStore } from "../services/private-state.js";
import { PortalPaste, type PortalPasteState } from "../platforms/linux/shared/portal-paste.js";
import { boundPlatformFrame, platformRequestSchema, platformCaptureReplySchema, PlatformCaptureClient,
  type PlatformReply, type PlatformRequest, type PlatformCaptureRequest } from "./platform-protocol.js";

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(value: PlatformReply | PlatformCaptureRequest | { version: 1; type: "ready" } |
    { version: 1; type: "shortcuts"; state: PortalShortcutState } | { version: 1; type: "paste-state"; state: PortalPasteState } |
    { version: 1; type: "failure"; code: "TEARDOWN_FAILED" }): void;
}
const nativePort: unknown = Reflect.get(process, "parentPort");
if (process.platform !== "linux" || typeof nativePort !== "object" || nativePort === null) throw new Error("Platform owner unavailable.");
const owner = nativePort;
function portMethod(name: "on" | "postMessage"): (...args: unknown[]) => unknown {
  const callable: unknown = Reflect.get(owner, name);
  if (typeof callable !== "function") throw new Error("Platform owner unavailable.");
  return (...args) => { const output: unknown = Reflect.apply(callable, owner, args); return output; };
}
const subscribe = portMethod("on"), send = portMethod("postMessage");
const port: ParentPort = { on: (event, listener) => subscribe(event, listener), postMessage: (value) => { send(value); } };
const unavailable: ControlCapturePort = { status: () => "unavailable", start: async () => { throw new Error("Capture unavailable."); } };
let service: DevControlService | undefined;
let generation: string | undefined;
let busy = false;
let closing = false;
let fatal = false;
let capture: ControlCapturePort = unavailable;
let captureClient: PlatformCaptureClient | undefined;
let shortcuts: DesktopShortcuts | undefined;
let paste: PortalPaste | undefined;

// No bus/native addon is opened until an explicit validated initialize request.
port.on("message", (message) => {
  let request: PlatformRequest;
  try {
    boundPlatformFrame(message.data);
    if (platformCaptureReplySchema.safeParse(message.data).success) {
      if (!captureClient) throw new Error("Capture unavailable.");
      captureClient.receive(message.data); return;
    }
    request = platformRequestSchema.parse(message.data);
  }
  catch { process.exitCode = 1; process.exit(1); }
  if (busy || closing) { port.postMessage({ version: 1, id: request.id, ok: false, code: "BUSY" }); return; }
  busy = true;
  if (request.command === "shutdown") closing = true;
  void (async (): Promise<PlatformReply> => {
    switch (request.command) {
      case "initialize": {
        if (service) return { version: 1, id: request.id, ok: false, code: "BUSY" };
        let bus: LinuxBus;
        if (request.captureBridge) {
          if (process.type !== "utility") throw new Error("Platform owner unavailable.");
          const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
          const path = await verifyDevelopmentLinuxBusArtifact(root, request.captureBridge.native);
          // Bundling relocates import.meta.url. This dedicated utility consumes
          // only the verified fixed dist destination, never an IPC-supplied path.
          const binding: unknown = createRequire(import.meta.url)(path);
          bus = await LinuxBus.open(binding, request.address);
          captureClient = new PlatformCaptureClient(request.captureBridge.epoch, (frame) => { port.postMessage(frame); });
          capture = captureClient;
        } else bus = await openLinuxBus(request.address);
        service = await DevControlService.create(bus, capture); generation = bus.generation;
        const journal = request.kdeLeasePath ? await PrivateStateStore.open(request.kdeLeasePath, kdeJournalSchema, [], 4096) : undefined;
        if (captureClient) shortcuts = await DesktopShortcuts.create(bus, capture, (state) => {
          port.postMessage({ version: 1, type: "shortcuts", state });
        }, journal);
        paste = await PortalPaste.create(bus, (state) => port.postMessage({ version: 1, type: "paste-state", state }), undefined,
          () => { fatal = true; closing = true; port.postMessage({ version: 1, type: "failure", code: "TEARDOWN_FAILED" }); });
        return { version: 1, id: request.id, ok: true, value: { command: "initialize", generation, captureAvailable: !!captureClient } };
      }
      case "status": return { version: 1, id: request.id, ok: true, value: { command: "status", status: await capture.status() } };
      case "shortcut": {
        if (!shortcuts) return { version: 1, id: request.id, ok: false, code: "UNAVAILABLE" };
        shortcuts.command(request.action, request.hold);
        return { version: 1, id: request.id, ok: true, value: { command: "shortcut", state: shortcuts.state() } };
      }
      case "bind-key": {
        if (!shortcuts) return { version: 1, id: request.id, ok: false, code: "UNAVAILABLE" };
        void shortcuts.bind(request.key, request.hold).catch(() => {
          if (shortcuts) port.postMessage({ version: 1, type: "shortcuts", state: shortcuts.state() });
        });
        return { version: 1, id: request.id, ok: true, value: { command: "bind-key", state: shortcuts.state() } };
      }
      case "prepare-key": {
        if (!shortcuts) return { version: 1, id: request.id, ok: false, code: "UNAVAILABLE" };
        await shortcuts.prepareKeyCapture(request.windowId, request.hold);
        return { version: 1, id: request.id, ok: true, value: { command: "prepare-key", state: shortcuts.state() } };
      }
      case "paste-permission": {
        if (!paste) return { version: 1, id: request.id, ok: false, code: "UNAVAILABLE" };
        if (request.action === "enable") paste.enable();
        else void paste.clear("CANCELLED").catch(() => {});
        return { version: 1, id: request.id, ok: true, value: { command: "paste-permission", state: paste.state() } };
      }
      case "paste": {
        if (!paste) return { version: 1, id: request.id, ok: false, code: "UNAVAILABLE" };
        return { version: 1, id: request.id, ok: true, value: { command: "paste", accepted: await paste.paste() } };
      }
      case "shutdown": {
        const closed = await Promise.allSettled([paste?.close(), shortcuts?.close()]);
        for (const result of closed) if (result.status === "rejected") throw result.reason;
        await service?.close(); captureClient?.close();
        return { version: 1, id: request.id, ok: true, value: { command: "shutdown" } };
      }
    }
  })().then((reply) => { port.postMessage(reply); }, (error: unknown) => {
    if (closing || (error instanceof ControlServiceError || error instanceof BusFailure) && error.code === "TEARDOWN_FAILED") { fatal = true; closing = true; }
    port.postMessage({ version: 1, id: request.id, ok: false, code: closing ? "TEARDOWN_FAILED" : "UNAVAILABLE" });
  }).finally(() => {
    busy = false;
    // Fatal teardown remains closed until the parent kills/reaps this owner.
    // Electron's process.exit notification can precede actual OS reaping.
    if (closing && !fatal) process.exit(0);
  });
});
port.postMessage({ version: 1, type: "ready" });

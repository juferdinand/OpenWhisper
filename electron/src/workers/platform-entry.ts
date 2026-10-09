import { BusFailure, LinuxBus, openLinuxBus } from "../platforms/linux/shared/bus.js";
import { ControlServiceError, DevControlService } from "../platforms/linux/shared/control.js";
import type { ControlCapturePort } from "../core/recording-control.js";
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
const unavailable: ControlCapturePort = { status: () => "unavailable",
  wireStatus: () => ({ status: "idle", elapsed: 0n, recovery_available: false }),
  start: async () => { throw new Error("Capture unavailable."); } };
let service: DevControlService | undefined;
let ownedBus: LinuxBus | undefined;
let initializeTask: Promise<void> | undefined;
let generation: string | undefined;
let initializeStarted = false;
let closeTask: Promise<void> | undefined;
let busy = false;
let closing = false;
let fatal = false;
let capture: ControlCapturePort = unavailable;
let captureClient: PlatformCaptureClient | undefined;
let shortcuts: DesktopShortcuts | undefined;
let paste: PortalPaste | undefined;

function closeResources(): Promise<void> {
  closeTask ??= Promise.resolve().then(async () => {
    // Retain the original setup until each pending acquisition has settled.
    // Setup checks retirement after storing every acquired resource; it never
    // awaits cleanup itself, so this join cannot cycle with its failure handler.
    await initializeTask?.catch(() => {});
    // Release input/capture leases while their original bus and RPC are live.
    const input = await Promise.allSettled([paste?.close(), shortcuts?.close()]);
    const control = await Promise.allSettled([service?.close()]);
    // Retain every bus acquired during setup, including a bus whose later
    // portal or control initialization failed.
    const bus = await Promise.allSettled([ownedBus?.close()]);
    captureClient?.close();
    if ([...input, ...control, ...bus].some((result) => result.status === "rejected")) throw new BusFailure("TEARDOWN_FAILED");
  });
  return closeTask;
}

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
  catch {
    closing = true; fatal = true;
    void closeResources().then(() => { process.exit(1); }, () => { process.exit(1); });
    return;
  }
  if (busy || closing) { port.postMessage({ version: 1, id: request.id, ok: false, code: "BUSY" }); return; }
  busy = true;
  if (request.command === "shutdown") closing = true;
  void (async (): Promise<PlatformReply> => {
    switch (request.command) {
      case "initialize": {
        if (initializeStarted) return { version: 1, id: request.id, ok: false, code: "BUSY" };
        initializeStarted = true;
        const appId = request.appId ?? "io.github.whisperfree.dev";
        const current = (): void => { if (closing || closeTask) throw new BusFailure("CLOSED"); };
        initializeTask = Promise.resolve().then(async () => {
          current();
          if (request.captureBridge) {
            if (process.type !== "utility") throw new Error("Platform owner unavailable.");
            const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
            const path = await verifyDevelopmentLinuxBusArtifact(root, request.captureBridge.native);
            current();
            // Bundling relocates import.meta.url. This dedicated utility consumes
            // only the verified fixed dist destination, never an IPC-supplied path.
            const binding: unknown = createRequire(import.meta.url)(path);
            ownedBus = await LinuxBus.open(binding, request.address);
            current();
            captureClient = new PlatformCaptureClient(request.captureBridge.epoch, (frame) => { port.postMessage(frame); });
            capture = captureClient;
          } else {
            ownedBus = await openLinuxBus(request.address);
            current();
          }
          generation = ownedBus.generation;
          service = await DevControlService.create(ownedBus, capture, appId === "io.github.whisperfree" ? "stable" : "development"); current();
          const journal = request.kdeLeasePath ? await PrivateStateStore.open(request.kdeLeasePath, kdeJournalSchema, [], 4096) : undefined;
          current();
          if (captureClient) {
            shortcuts = await DesktopShortcuts.create(ownedBus, capture, (state) => {
              port.postMessage({ version: 1, type: "shortcuts", state });
            }, journal, appId); current();
          }
          paste = await PortalPaste.create(ownedBus, (state) => port.postMessage({ version: 1, type: "paste-state", state }), undefined,
            () => {
              fatal = true; closing = true; port.postMessage({ version: 1, type: "failure", code: "TEARDOWN_FAILED" });
              void closeResources().catch(() => {});
            }, appId);
          current();
        });
        try {
          await initializeTask; current();
          if (!generation) throw new BusFailure("INVALID_FRAME");
          return { version: 1, id: request.id, ok: true, value: { command: "initialize", generation, captureAvailable: !!captureClient } };
        } catch (error: unknown) { await closeResources(); throw error; }
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
        await closeResources();
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

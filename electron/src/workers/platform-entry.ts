import { openLinuxBus } from "../platforms/linux/shared/bus.js";
import { ControlServiceError, DevControlService, type ControlCapturePort } from "../platforms/linux/shared/control.js";
import { boundPlatformFrame, platformRequestSchema, type PlatformReply, type PlatformRequest } from "./platform-protocol.js";

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  postMessage(value: PlatformReply | { version: 1; type: "ready" }): void;
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

// No bus/native addon is opened until an explicit validated initialize request.
port.on("message", (message) => {
  let request: PlatformRequest;
  try { boundPlatformFrame(message.data); request = platformRequestSchema.parse(message.data); }
  catch { process.exitCode = 1; process.exit(1); }
  if (busy || closing) { port.postMessage({ version: 1, id: request.id, ok: false, code: "BUSY" }); return; }
  busy = true;
  if (request.command === "shutdown") closing = true;
  void (async (): Promise<PlatformReply> => {
    switch (request.command) {
      case "initialize": {
        if (service) return { version: 1, id: request.id, ok: false, code: "BUSY" };
        const bus = await openLinuxBus(request.address);
        service = await DevControlService.create(bus, unavailable); generation = bus.generation;
        return { version: 1, id: request.id, ok: true, value: { command: "initialize", generation, captureAvailable: false } };
      }
      case "status": return { version: 1, id: request.id, ok: true, value: { command: "status", status: "unavailable" } };
      case "shutdown": {
        await service?.close(); return { version: 1, id: request.id, ok: true, value: { command: "shutdown" } };
      }
    }
  })().then((reply) => { port.postMessage(reply); }, (error: unknown) => {
    if (error instanceof ControlServiceError && error.code === "TEARDOWN_FAILED") { fatal = true; closing = true; }
    port.postMessage({ version: 1, id: request.id, ok: false, code: closing ? "TEARDOWN_FAILED" : "UNAVAILABLE" });
  }).finally(() => {
    busy = false;
    // Fatal teardown remains closed until the parent kills/reaps this owner.
    // Electron's process.exit notification can precede actual OS reaping.
    if (closing && !fatal) process.exit(0);
  });
});
port.postMessage({ version: 1, type: "ready" });

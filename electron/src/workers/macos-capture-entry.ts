import type {} from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NativeCaptureBoundary, type OwnedCaptureSession } from "../services/capture.js";
import { verifyDevelopmentMacCaptureArtifact } from "../services/development-artifact.js";
import { MacCaptureRuntime, MacCaptureRuntimeError } from "./macos-capture-runtime.js";
import { loadNativeMacCapture } from "./native-macos-capture.js";
import { developmentCaptureDescriptorSchema } from "./recording-host-protocol.js";
import { WorkerRecordingEffects } from "./recording-effects.js";

// The trusted main supplies only the epoch. Native paths and hardware selection are fixed here.
const epoch = (() => { try { return z.tuple([z.uuid()]).parse(process.argv.slice(2))[0]; }
  catch { throw new Error("Recording owner unavailable."); } })();
const uid = process.getuid?.(), parent: unknown = Reflect.get(process, "parentPort");
if (process.platform !== "darwin" || process.type !== "utility" || uid === undefined || uid === 0 ||
  (process.arch !== "x64" && process.arch !== "arm64") || typeof parent !== "object" || parent === null) {
  throw new Error("Recording owner unavailable.");
}
const method = (name: "on" | "postMessage"): ((...args: unknown[]) => unknown) => {
  const value: unknown = Reflect.get(parent, name);
  if (typeof value !== "function") throw new Error("Recording owner unavailable.");
  return (...args) => Reflect.apply(value, parent, args);
};
const subscribe = method("on"), post = method("postMessage");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const replies = new Set<(input: unknown) => void>(), exits = new Set<() => void>();
const rpc = new WorkerRecordingEffects({ send: (request) => { post(request); },
  onMessage: (listener) => { replies.add(listener); return () => { replies.delete(listener); }; },
  onExit: (listener) => { exits.add(listener); return () => { exits.delete(listener); }; },
}, epoch);
type Descriptor = z.infer<typeof developmentCaptureDescriptorSchema>;
let descriptor: Descriptor | undefined;
let loading: Promise<ReturnType<typeof loadNativeMacCapture>> | undefined;
function load(expected: Descriptor) {
  if (descriptor && (descriptor.bytes !== expected.bytes || descriptor.sha256 !== expected.sha256)) {
    return Promise.reject(new Error("CAPTURE_FAILED"));
  }
  descriptor ??= Object.freeze({ ...expected });
  // Expected bytes originate in main's captured build record; original failures stay sticky.
  loading ??= Promise.resolve().then(async () => loadNativeMacCapture(await verifyDevelopmentMacCaptureArtifact(root, expected)));
  void loading.catch(() => {}); return loading;
}
const sessions = new Set<OwnedCaptureSession>();
let cleanup: Promise<void> | undefined;
const runtime = new MacCaptureRuntime({ epoch, pid: process.pid, send: (reply) => { post(reply); }, effects: {
  async prepare(configuration) {
    const native = await load(configuration.capture);
    const capture = NativeCaptureBoundary.fromSessionFactory((generation) => native.create(generation, { mode: "avfoundation" }));
    // Allocation belongs only to an explicit Start. Native Start checks existing permission;
    // this entry never requests TCC permission, enumerates devices or writes recovery audio.
    return { create(callbacks) {
      const session = capture.create(callbacks);
      const owned: OwnedCaptureSession = { start: (signal) => session.start(signal),
        closeAndFence: () => session.closeAndFence(), prepare: (handle, context) => session.prepare(handle, context),
        release: async () => { await session.release(); sessions.delete(owned); },
      };
      sessions.add(owned); return owned;
    } };
  },
  infer: (context) => rpc.infer(context), delivery: rpc.delivery,
  close() {
    cleanup ??= Promise.resolve().then(async () => {
      await loading?.catch(() => {}); await rpc.close();
      // Runtime refuses retained stopped RAM before this cleanup is reached.
      const results = await Promise.allSettled([...sessions].map((session) => session.release()));
      if (results.some((result) => result.status === "rejected")) throw new Error("CAPTURE_FAILED");
    });
    void cleanup.catch(() => {}); return cleanup;
  },
} });
let retiring = false;
function retire(): void {
  if (retiring) return; retiring = true;
  void runtime.close().then(() => { process.exit(0); }, (error: unknown) => {
    if (error instanceof MacCaptureRuntimeError && error.code === "RECOVERY_PENDING") {
      // A refused Quit retains the same RAM owner and leaves explicit Retry/Discard usable.
      retiring = false; return;
    }
    // No cleanup certificate is fabricated; main's original kernel owner remains authoritative.
    process.exitCode = 1;
  });
}
subscribe("message", (event: unknown) => {
  if (typeof event !== "object" || event === null) { retire(); return; }
  const input: unknown = Reflect.get(event, "data");
  if (typeof input === "object" && input !== null && Reflect.get(input, "channel") === "recording-host") {
    // Main receives the cleanup reply before terminating this original owner.
    // Immediate exit here could drop the posted close acknowledgement.
    void runtime.receive(input).catch(() => { retire(); });
  } else for (const receive of replies) receive(input);
});
subscribe("close", () => { for (const listener of exits) listener(); retire(); });
process.once("SIGTERM", retire);
process.once("SIGINT", retire);

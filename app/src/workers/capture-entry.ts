import type {} from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CaptureBoundary, CaptureFinalization, PreparedAudio, WorkContext } from "../core/recording/recording.js";
import { NativeCaptureBoundary, type NativeCapturedHandle, type OwnedCaptureSession } from "../services/recording/capture.js";
import { verifyDevelopmentCaptureArtifact } from "../services/development/development-artifact.js";
import { CaptureRuntime } from "./recording/capture-runtime.js";
import { workerParentPort } from "./worker-port.js";
import { loadNativeCapture } from "./recording/native-capture.js";
import { developmentCaptureDescriptorSchema, type RecordingConfiguration } from "./recording/recording-host-protocol.js";
import { WorkerRecordingEffects } from "./recording/recording-effects.js";
import { PrivateAudioRecovery } from "./recording/recovery.js";
import { loadNativeCaptureSources, PulseSourceDevices } from "./recording/source-devices.js";

// Main supplies only an epoch. Native destinations originate in this fixed entry, never argv or IPC paths.
const epoch = (() => { try { return z.tuple([z.uuid()]).parse(process.argv.slice(2))[0]; }
  catch { throw new Error("Recording owner unavailable."); } })();
const uid = process.getuid?.();
if (process.platform !== "linux" || process.type !== "utility" || uid === undefined || uid === 0 ||
  (process.arch !== "x64" && process.arch !== "arm64")) throw new Error("Recording owner unavailable.");
const parent = workerParentPort("Recording owner unavailable.");
const subscribe = parent.on, post = parent.postMessage;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const replies = new Set<(input: unknown) => void>(), exits = new Set<() => void>();
const rpc = new WorkerRecordingEffects({ send: (request) => { post(request); },
  onMessage: (listener) => { replies.add(listener); return () => { replies.delete(listener); }; },
  onExit: (listener) => { exits.add(listener); return () => { exits.delete(listener); }; },
}, epoch);
type Descriptor = z.infer<typeof developmentCaptureDescriptorSchema>;
let descriptor: Descriptor | undefined;
let loading: Promise<Readonly<{ native: ReturnType<typeof loadNativeCapture>; devices: PulseSourceDevices }>> | undefined;
function load(expected: Descriptor) {
  if (descriptor && (descriptor.bytes !== expected.bytes || descriptor.sha256 !== expected.sha256)) {
    return Promise.reject(new Error("CAPTURE_FAILED"));
  }
  descriptor ??= Object.freeze({ ...expected });
  // Keep original verification/load failures sticky. Never refresh expected bytes or reset native ownership.
  loading ??= Promise.resolve().then(async () => {
    const path = await verifyDevelopmentCaptureArtifact(root, expected);
    return Object.freeze({ native: loadNativeCapture(path), devices: new PulseSourceDevices(loadNativeCaptureSources(path)) });
  });
  void loading.catch(() => {}); return loading;
}
const sessions = new Set<OwnedCaptureSession>();
function captureBoundary(configuration: RecordingConfiguration,
  loaded: Awaited<ReturnType<typeof load>>): CaptureBoundary<NativeCapturedHandle> {
  return { create(callbacks) {
    let session: OwnedCaptureSession | undefined, starting: Promise<void> | undefined;
    return {
      start(signal) {
        if (starting) return Promise.reject(new Error("CAPTURE_FAILED"));
        starting = Promise.resolve().then(async () => {
          // Resolve a current concrete default before allocation; never choose an arbitrary first source.
          const selection = await loaded.devices.resolve({ server: configuration.server, source: configuration.source });
          if (signal.aborted) throw new Error("CAPTURE_FAILED");
          session = new NativeCaptureBoundary(loaded.native, selection).create(callbacks); sessions.add(session);
          await session.start(signal);
        });
        void starting.catch(() => {}); return starting;
      },
      async closeAndFence(): Promise<CaptureFinalization<NativeCapturedHandle>> {
        await starting?.catch(() => {});
        return session ? session.closeAndFence() : { generation: callbacks.generation, streamClosed: true,
          finalSamplesFenced: true, error: null, captured: null };
      },
      async prepare(handle: NativeCapturedHandle, context: WorkContext): Promise<PreparedAudio> {
        if (!session) throw new Error("CAPTURE_FAILED"); return session.prepare(handle, context);
      },
      async release() {
        await starting?.catch(() => {});
        if (session) { await session.release(); sessions.delete(session); }
      },
    };
  } };
}
let cleanup: Promise<void> | undefined;
const runtime = new CaptureRuntime({ epoch, pid: process.pid, send: (reply) => { post(reply); }, effects: {
  async prepare(configuration) {
    const loaded = await load(configuration.capture), recovery = await PrivateAudioRecovery.open(configuration.recoveryPath);
    return { capture: captureBoundary(configuration, loaded), recovery };
  },
  async enumerate(request) { return (await load(request.capture)).devices.enumerate({ server: request.server }); },
  infer: (context) => rpc.infer(context), delivery: rpc.delivery,
  close() {
    cleanup ??= Promise.resolve().then(async () => {
      await loading?.catch(() => {}); await rpc.close();
      // Runtime checks stopped recovery before releasing utility-local RAM; the WAV is never discarded here.
      const results = await Promise.allSettled([...sessions].map(async (session) => { await session.release(); sessions.delete(session); }));
      if (results.some((result) => result.status === "rejected")) throw new Error("CAPTURE_FAILED");
    });
    void cleanup.catch(() => {}); return cleanup;
  },
} });
let retiring = false;
function retire(): void {
  if (retiring) return; retiring = true;
  void runtime.close().then(() => { process.exit(0); }, () => {
    // Failure keeps original owners/pending cleanup; main's actual retirement gate remains authoritative.
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

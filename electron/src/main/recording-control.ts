import type { RecordingSnapshot } from "../core/recording.js";
import type { ControlCaptureLease, ControlCapturePort, ControlStatus } from "../platforms/linux/shared/control.js";
import type { RecordingIdentity } from "./development-recording-host.js";

interface RecordingControlOwner {
  currentIdentity(): RecordingIdentity | undefined;
  command(command: "start" | "stop" | "cancel", expected?: RecordingIdentity): Promise<RecordingIdentity>;
}
export interface RecordingControlOptions {
  readonly owner: RecordingControlOwner;
  readonly snapshot: () => Pick<RecordingSnapshot, "phase" | "busy" | "recoveryAvailable">;
  readonly available: () => boolean;
  readonly configure: () => Promise<void>;
  readonly serialize: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly cleanupSerialize?: <T>(operation: () => Promise<T>) => Promise<T>;
}
function same(left: RecordingIdentity | undefined, right: RecordingIdentity): boolean {
  return left?.epoch === right.epoch && left.generation === right.generation;
}
/** Main-only leases bind one actual recording, including recordings started by the UI. */
export function createRecordingControlPort(options: RecordingControlOptions): ControlCapturePort {
  let current: Readonly<{ identity: RecordingIdentity; lease: ControlCaptureLease }> | undefined;
  const status = (): ControlStatus => {
    if (!options.available()) return "unavailable";
    const snapshot = options.snapshot();
    if (snapshot.phase === "recording" || snapshot.phase === "starting") return "recording";
    return snapshot.busy || snapshot.recoveryAvailable ? "transcribing" : "idle";
  };
  const lease = (identity: RecordingIdentity): ControlCaptureLease => {
    if (current && same(current.identity, identity)) return current.lease;
    let terminal: Promise<void> | undefined;
    const finish = (command: "stop" | "cancel"): Promise<void> => {
      if (terminal) return terminal;
      let invoked = false;
      const operation = (options.cleanupSerialize ?? options.serialize)(async () => {
        if (!same(options.owner.currentIdentity(), identity)) {
          // A later recording proves this old lease is no longer active. Cleanup
          // may finish without targeting it; explicit Stop reports the stale owner.
          if (command === "cancel") return;
          throw new Error("Recording owner changed.");
        }
        if (command === "stop" && status() !== "recording") throw new Error("Recording is not active.");
        invoked = true; await options.owner.command(command, identity);
      });
      terminal = operation;
      void operation.catch(() => { if (!invoked && terminal === operation) terminal = undefined; });
      return operation;
    };
    const result = Object.freeze({ stop: () => finish("stop"), cancel: () => finish("cancel") });
    current = Object.freeze({ identity: Object.freeze({ ...identity }), lease: result });
    return result;
  };
  return Object.freeze({
    status,
    async start(signal: AbortSignal) {
      return options.serialize(async () => {
        if (signal.aborted || status() !== "idle") throw new Error("Recording is unavailable.");
        await options.configure();
        if (signal.aborted) throw new Error("Recording start was cancelled.");
        // Return the acquired original lease even if cancellation arrives during Start.
        // The authenticated caller rolls back this exact generation, never a later one.
        return lease(await options.owner.command("start"));
      });
    },
    async currentLease() {
      const identity = options.owner.currentIdentity();
      return identity && status() === "recording" ? lease(identity) : undefined;
    },
  });
}

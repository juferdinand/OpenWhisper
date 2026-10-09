import { z } from "zod";

export const controlStatusSchema = z.enum([
  "idle",
  "recording",
  "transcribing",
  "unavailable",
]);
export type ControlStatus = z.infer<typeof controlStatusSchema>;
export type RecordingStatus = "idle" | "recording" | "transcribing" | "done" | "error";

export interface ControlWireStatus {
  readonly status: RecordingStatus;
  readonly elapsed: bigint;
  readonly recovery_available: boolean;
}

/** A lease owns only one acquisition. Stop resolves after closure/sample fencing. */
export interface ControlCaptureLease {
  stop(): Promise<void>;
  cancel(): Promise<void>;
}

/** A different immutable recording owner proves this lease has already ended. */
export class ControlCaptureLeaseError extends Error {
  constructor() {
    super("Recording owner changed.");
    this.name = "ControlCaptureLeaseError";
  }
}

/** Platform-neutral control port used by desktop shortcuts and session control. */
export interface ControlCapturePort {
  status(): ControlStatus | Promise<ControlStatus>;
  /** Separate wire observation preserves done/error/recovery without changing action gating. */
  wireStatus?(): ControlWireStatus | Promise<ControlWireStatus>;
  start(signal: AbortSignal): Promise<ControlCaptureLease>;
  /** Capture the current immutable owner after authentication, never retarget a stale lease. */
  currentLease?(): Promise<ControlCaptureLease | undefined>;
}

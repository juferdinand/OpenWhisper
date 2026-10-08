import { z } from "zod";
import { bindLinuxProcessRetirement, type InitialRetirementObservation, type RetirementObservation } from "./process-retirement.js";
import { backendIdentitySchema, type RetirementBoundary } from "./backend-supervisor.js";
import { SpeechWorkerError } from "./speech-client.js";

/** Inert wrapper seam only; the production binder always uses genuine procfs. */
export interface LinuxSpeechWitness {
  readonly initial: InitialRetirementObservation;
  readonly current: RetirementObservation;
  observe(signal?: AbortSignal): Promise<RetirementObservation>;
  waitForRetirement(signal?: AbortSignal): Promise<void>;
  settleReads(): Promise<void>;
}
const level = z.enum(["running", "non-running", "reaped", "ambiguous"]);
const refuse = () => new SpeechWorkerError("TEARDOWN_FAILED");

export function wrapLinuxSpeechWitness(witness: LinuxSpeechWitness): RetirementBoundary {
  const first = witness.initial;
  const parsed = first.identity === null ? null : backendIdentitySchema.safeParse({ pid: first.identity.pid, uid: first.identity.uid,
    parentPid: first.identity.parentPid, epoch: first.identity.epoch, birth: { platform: "linux", startTicks: first.identity.startTicks } });
  if (parsed && !parsed.success) throw refuse();
  const candidate = parsed?.success ? parsed.data : null;
  if (!level.safeParse(first.level).success || first.canAdmit !== (first.level === "running") ||
    ((first.level === "running" || first.level === "non-running") && candidate === null)) throw refuse();
  return Object.freeze({
    initial: Object.freeze({ level: first.level, canAdmit: first.canAdmit, identity: first.level === "reaped" ? null : candidate }),
    get current() { const parsed = level.safeParse(witness.current.level); return Object.freeze({ level: parsed.success ? parsed.data : "ambiguous" }); },
    async observe(signal) {
      const observed = level.safeParse((await witness.observe(signal)).level);
      if (!observed.success) throw refuse();
      // The underlying witness compares every birth/UID/topology against its
      // original candidate. The wrapper never constructs a later identity.
      return Object.freeze({ level: observed.data, identity: observed.data === "running" || observed.data === "non-running" ? candidate : null });
    },
    waitForRetirement: (signal) => witness.waitForRetirement(signal),
    settleReads: () => witness.settleReads(),
  } satisfies RetirementBoundary);
}

export interface LinuxSpeechRetirementAllocation {
  bind(): Promise<RetirementBoundary>;
  /** Resource closure only, even when conversion of a resolved bind refused.
   * This is never a retirement/admission certificate. */
  settleReads(): Promise<void>;
}

/** Inert host seam. The original bind and resolved witness stay owned even if
 * binding or conversion refuses; a rejected allocation cannot bind again. */
export function createLinuxSpeechRetirementAllocation(bind: () => Promise<LinuxSpeechWitness>): LinuxSpeechRetirementAllocation {
  let original: Promise<LinuxSpeechWitness> | undefined, boundary: Promise<RetirementBoundary> | undefined;
  let witness: LinuxSpeechWitness | undefined;
  const start = (): Promise<RetirementBoundary> => {
    if (!boundary) {
      // Assign ownership before invoking the binder or awaiting any read.
      original = Promise.resolve().then(bind);
      boundary = original.then((resolved) => { witness = resolved; return wrapLinuxSpeechWitness(resolved); }).catch(() => { throw refuse(); });
      void original.catch(() => {}); void boundary.catch(() => {});
    }
    return boundary;
  };
  return Object.freeze({ bind: start,
    async settleReads() {
      const accepted = original;
      if (accepted) { try { await accepted; } catch { /* Retain original refusal; no replacement bind. */ } }
      if (witness) await witness.settleReads();
    },
  });
}

/** No injected reader/clock, no worker PID adoption, and no signal/reaper here.
 * Capture this holder on the provisional owner before awaiting bind(). */
export function prepareLinuxSpeechRetirement(pid: number, epoch: string): LinuxSpeechRetirementAllocation {
  if (process.platform !== "linux") throw refuse();
  return createLinuxSpeechRetirementAllocation(() => bindLinuxProcessRetirement({ pid, epoch, uid: process.getuid?.(), parentPid: process.pid }));
}

/** Test-only daemon ownership. Terminal events order, never certify, retirement. */
import { z } from "zod";
import { bindBirth, observeBirth, awaitNonRunning, WitnessRefusal, type Birth, type Observation } from "./process-witness.js";
import { safeFailure, failureSchema, type Failure } from "./diagnostics.js";

export interface DaemonHandle {
  readonly pid: number | undefined;
  onExit(callback: (code: unknown, signal: unknown) => void): void;
  onClose(callback: (code: unknown, signal: unknown) => void): void;
  onError(callback: (error: unknown) => void): void;
  signalTerminate(): boolean;
}
export interface DaemonWitness {
  bind(pid: number, parentPid: number): Promise<Birth>;
  observe(birth: Birth): Promise<Observation>;
  nonRunning(birth: Birth, remainingMs: number): Promise<Observation>;
}
const defaultWitness: DaemonWitness = { bind: bindBirth, observe: observeBirth, nonRunning: awaitNonRunning };
const birthSchema = z.strictObject({ pid: z.int().positive(), parentPid: z.int().positive(),
  ticks: z.string().regex(/^[1-9][0-9]{0,19}$/u).refine((value) => BigInt(value) <= (1n << 64n) - 1n) });
const observationSchema = z.discriminatedUnion("level", [
  z.strictObject({ level: z.literal("running"), reason: z.literal("same-birth") }),
  z.strictObject({ level: z.literal("non-running"), reason: z.enum(["zombie", "dead"]) }),
  z.strictObject({ level: z.literal("absent"), reason: z.literal("absence") }),
]);
const eventSchema = z.strictObject({ code: z.int().min(-2147483648).max(2147483647).nullable(),
  signal: z.enum(["SIGTERM", "SIGKILL", "OTHER"]).nullable() });
const stageSchema = z.enum(["DAEMON_SPAWNED", "DAEMON_READY", "DAEMON_BIRTH_BIND_STARTED", "DAEMON_BIRTH_BOUND",
  "DAEMON_BIRTH_BIND_REFUSED", "DAEMON_PRE_SIGNAL_OBSERVATION", "DAEMON_SIGNAL_REQUESTED", "DAEMON_EXIT_OBSERVED",
  "DAEMON_CLOSE_OBSERVED", "DAEMON_COMPLETION_OBSERVED", "DAEMON_FINAL_OBSERVATION", "DAEMON_RETIRED", "DAEMON_RETIREMENT_REFUSED"]);
export const daemonDiagnosisSchema = z.strictObject({
  stages: z.array(z.strictObject({ stage: stageSchema, elapsedMs: z.number().finite().nonnegative() })).max(24),
  birth: birthSchema.nullable(), exit: eventSchema.nullable(), close: eventSchema.nullable(),
  signalRequested: z.boolean(), signalAccepted: z.boolean().nullable(),
  preObservation: observationSchema.nullable(), finalObservation: observationSchema.nullable(), refusal: failureSchema.nullable(),
});
type DaemonDiagnosis = z.infer<typeof daemonDiagnosisSchema>;

export class OwnedDaemon {
  private readonly start = performance.now();
  private readonly pid: number | undefined;
  private readonly stages: DaemonDiagnosis["stages"] = [];
  private birth: Birth | null = null;
  private exit: DaemonDiagnosis["exit"] = null;
  private close: DaemonDiagnosis["close"] = null;
  private signalRequested = false;
  private signalAccepted: boolean | null = null;
  private preObservation: Observation | null = null;
  private finalObservation: Observation | null = null;
  private refusal: Failure | null = null;
  private failureCause: unknown;
  private admissionStarted = false;
  private cleanup: Promise<Observation> | undefined;
  private readonly completion: Promise<void>;

  constructor(private readonly handle: DaemonHandle, private readonly persist: (value: DaemonDiagnosis) => void,
    private readonly witness: DaemonWitness = defaultWitness) {
    this.pid = handle.pid;
    let accept = (): void => { throw new Error("Missing original daemon completion resolver."); };
    let reject = (_error: unknown): void => { throw new Error("Missing original daemon completion rejection."); };
    this.completion = new Promise<void>((resolve, refuse) => { accept = resolve; reject = refuse; });
    // The same original promise/listeners exist before readiness or SIGTERM.
    void this.completion.catch(() => undefined);
    const receive = (kind: "exit" | "close", code: unknown, signal: unknown): void => {
      try {
        const event = eventSchema.parse({ code, signal: signal === null || signal === undefined ? null :
          signal === "SIGTERM" || signal === "SIGKILL" ? signal : "OTHER" });
        if (kind === "exit") { this.exit = event; this.mark("DAEMON_EXIT_OBSERVED"); }
        else { this.close = event; this.mark("DAEMON_CLOSE_OBSERVED"); }
        if (this.exit && this.close) accept();
      } catch (error: unknown) { this.fail(error); reject(error); }
    };
    handle.onExit((code, signal) => { receive("exit", code, signal); });
    handle.onClose((code, signal) => { receive("close", code, signal); });
    handle.onError((error) => { this.fail(error); reject(error); });
    this.mark("DAEMON_SPAWNED");
  }
  snapshot(): DaemonDiagnosis { return daemonDiagnosisSchema.parse({ stages: this.stages, birth: this.birth,
    exit: this.exit, close: this.close, signalRequested: this.signalRequested, signalAccepted: this.signalAccepted,
    preObservation: this.preObservation, finalObservation: this.finalObservation, refusal: this.refusal }); }
  private mark(stage: z.infer<typeof stageSchema>): void {
    if (this.stages.length >= 24) throw new Error("Owned daemon diagnostic bound exceeded.");
    this.stages.push({ stage, elapsedMs: performance.now() - this.start }); this.persist(this.snapshot());
  }
  private fail(error: unknown): void {
    if (this.refusal === null) { this.refusal = safeFailure("PROCESS_OBSERVATION", error); this.failureCause = error; }
    this.persist(this.snapshot());
  }
  private current(): void { if (this.refusal !== null) throw this.failureCause; }
  private remaining(end: number): number {
    const remaining = end - performance.now();
    if (!Number.isFinite(end) || remaining <= 0) throw new WitnessRefusal("DEADLINE_EXPIRED", "LOOKUP");
    return remaining;
  }
  private async within<T>(promise: Promise<T>, end: number): Promise<T> {
    const remaining = this.remaining(end); let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WitnessRefusal("DEADLINE_EXPIRED", "LOOKUP")), remaining);
    });
    try { const value = await Promise.race([promise, expired]); this.remaining(end); return value; }
    finally { if (timer) clearTimeout(timer); }
  }
  /** Original readiness admission; never called again during shutdown. */
  async admitAfterReadiness(parentPid: number, remainingOperationMs: number): Promise<void> {
    if (this.admissionStarted) throw new Error("Original daemon birth already attempted.");
    this.admissionStarted = true; this.mark("DAEMON_READY"); this.mark("DAEMON_BIRTH_BIND_STARTED");
    const end = performance.now() + remainingOperationMs;
    try {
      this.current(); this.remaining(end);
      if (!this.pid) throw new WitnessRefusal("ADMISSION_REFUSED", "LOOKUP");
      const birth = birthSchema.parse(await this.within(this.witness.bind(this.pid, parentPid), end)); this.current();
      if (birth.pid !== this.pid || birth.parentPid !== parentPid) throw new WitnessRefusal("TOPOLOGY_CHANGED", "LOOKUP");
      this.birth = Object.freeze(birth); this.mark("DAEMON_BIRTH_BOUND"); this.remaining(end);
    } catch (error: unknown) { this.fail(error); this.mark("DAEMON_BIRTH_BIND_REFUSED"); throw error; }
  }
  /** One shared bound covers original-handle signal, event ordering and fresh proof. */
  retire(boundMs: number): Promise<Observation> {
    this.cleanup ??= this.retireOnce(boundMs); return this.cleanup;
  }
  private async retireOnce(boundMs: number): Promise<Observation> {
    const end = performance.now() + boundMs;
    try {
      this.current(); this.remaining(end);
      const birth = this.birth;
      if (!birth) throw new WitnessRefusal("ADMISSION_REFUSED", "LOOKUP");
      if (!this.exit && !this.close) {
        this.mark("DAEMON_PRE_SIGNAL_OBSERVATION");
        this.preObservation = observationSchema.parse(await this.within(this.witness.observe(birth), end)); this.current();
        if (this.preObservation.level === "running" && !this.exit && !this.close) {
          this.remaining(end); this.signalRequested = true; this.mark("DAEMON_SIGNAL_REQUESTED");
          this.signalAccepted = this.handle.signalTerminate(); this.persist(this.snapshot());
        }
      }
      await this.within(this.completion, end); this.current(); this.mark("DAEMON_COMPLETION_OBSERVED");
      this.mark("DAEMON_FINAL_OBSERVATION");
      const observed = observationSchema.parse(await this.within(this.witness.nonRunning(birth, this.remaining(end)), end));
      this.current(); this.remaining(end);
      if (observed.level === "running") throw new WitnessRefusal("LOOKUP_UNCONFIRMED", "LOOKUP");
      this.finalObservation = observed; this.mark("DAEMON_RETIRED"); this.remaining(end); return observed;
    } catch (error: unknown) { this.fail(error); this.mark("DAEMON_RETIREMENT_REFUSED"); throw error; }
  }
}

import { performance } from "node:perf_hooks";

/** Errors poison acceptance without resolving the original physical event.
 * Callers retain this completion even after a separate bounded wait rejects. */
export class OriginalClosure<T> {
  readonly completion: Promise<T>;
  private accept!: (value: T) => void;
  private closedAt: number | undefined;
  private errors = 0;
  private overflow = false;
  private expired = false;
  constructor(private readonly until: number) {
    if (!Number.isFinite(until)) throw new Error("INVALID_LIFETIME");
    this.completion = new Promise<T>((accept) => { this.accept = accept; });
  }
  get closed(): boolean { return this.closedAt !== undefined; }
  noteError(): void { this.errors = Math.min(16, this.errors + 1); }
  noteOverflow(): void { this.overflow = true; }
  noteDeadline(): void { this.expired = true; }
  close(value: T): void {
    if (this.closed) { this.noteError(); return; }
    this.closedAt = performance.now(); this.accept(value);
  }
  get state(): Readonly<{ closureObserved: boolean; errorEvents: number; stdoutOverflow: boolean; timedOut: boolean; lateClose: boolean }> {
    return Object.freeze({ closureObserved: this.closed, errorEvents: this.errors, stdoutOverflow: this.overflow,
      timedOut: this.expired, lateClose: this.closedAt !== undefined && this.closedAt >= this.until });
  }
  assertAcceptedClosure(): void {
    if (this.errors || this.overflow || this.expired || this.closedAt === undefined || this.closedAt >= this.until)
      throw new Error("ORIGINAL_CLOSURE_REFUSED");
  }
  async accepted(): Promise<T> {
    const value = await this.completion;
    // Monotonic acceptance is independent of a delayed timer callback.
    this.assertAcceptedClosure(); if (performance.now() >= this.until) throw new Error("ORIGINAL_CLOSURE_REFUSED");
    return value;
  }
}
export interface OriginalCLISource {
  onError(listener: () => void): void;
  onClose(listener: (code: number | null) => void): void;
  signal(kind: "SIGTERM" | "SIGKILL"): void;
}
export interface FixtureTimers {
  schedule(effect: () => void, milliseconds: number): Readonly<{ cancel(): void }>;
}
const actualTimers: FixtureTimers = {
  schedule: (effect, milliseconds) => {
    const timer = setTimeout(effect, milliseconds); return Object.freeze({ cancel: () => { clearTimeout(timer); } });
  },
};

/** Fixed original-child supervision. Inert timer effects are used only by
 * contract tests; the real launcher supplies the original object and defaults. */
export function retainOriginalCLI(source: OriginalCLISource, until: number, timers: FixtureTimers = actualTimers): OriginalClosure<number | null> {
  const closure = new OriginalClosure<number | null>(until);
  let deadline: Readonly<{ cancel(): void }> | undefined, escalation: Readonly<{ cancel(): void }> | undefined;
  const signal = (kind: "SIGTERM" | "SIGKILL"): void => { try { source.signal(kind); } catch { closure.noteError(); } };
  source.onError(() => { closure.noteError(); });
  source.onClose((code) => {
    closure.close(code);
    deadline?.cancel(); escalation?.cancel();
  });
  if (!closure.closed) deadline = timers.schedule(() => {
    if (closure.closed) return;
    closure.noteDeadline();
    escalation = timers.schedule(() => { if (!closure.closed) signal("SIGKILL"); }, 8000);
    signal("SIGTERM");
  }, Math.max(0, until - performance.now()));
  return closure;
}

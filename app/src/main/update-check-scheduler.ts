export interface UpdateCheckSchedulerClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: UpdateCheckSchedulerClock = {
  now: Date.now,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Bounded startup/hourly checks plus a resume check with a cooldown and overlap fence. */
export function createUpdateCheckScheduler(input: Readonly<{
  check(): Promise<void>;
  allowed(): boolean;
  clock?: UpdateCheckSchedulerClock;
  startupDelayMs?: number;
  intervalMs?: number;
  resumeCooldownMs?: number;
}>): Readonly<{ start(): void; resume(): void; close(): void }> {
  const clock = input.clock ?? systemClock, startupDelay = input.startupDelayMs ?? 10_000,
    interval = input.intervalMs ?? 60 * 60 * 1000, resumeCooldown = input.resumeCooldownMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(startupDelay) || startupDelay < 0 || !Number.isSafeInteger(interval) || interval < 1 ||
      !Number.isSafeInteger(resumeCooldown) || resumeCooldown < 0) {
    throw new RangeError("Invalid update check schedule.");
  }
  let timer: unknown, started = false, closed = false, busy = false, lastResume = Number.NEGATIVE_INFINITY;
  const run = async (): Promise<void> => {
    if (closed || busy) return;
    try { if (!input.allowed()) return; } catch { return; }
    busy = true;
    try { await input.check(); } catch { /* Automatic update discovery is optional. */ }
    finally { busy = false; }
  };
  const schedule = (delay: number): void => {
    if (closed) return;
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => { timer = undefined; void run(); schedule(interval); }, delay);
  };
  return Object.freeze({
    start(): void { if (started || closed) return; started = true; schedule(startupDelay); },
    resume(): void {
      const now = clock.now();
      if (!started || closed || now - lastResume < resumeCooldown) return;
      lastResume = now; void run();
    },
    close(): void { if (closed) return; closed = true; if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; },
  });
}

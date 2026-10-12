export type SettingsSaveStatus = "idle" | "saving" | "saved" | "error";

export interface SettingsAutosaveOptions {
  readonly onState: (state: { readonly status: SettingsSaveStatus }) => void;
}

interface WriteJob {
  write: () => Promise<boolean>;
  readonly waiters: Array<(saved: boolean) => void>;
}

interface SaveEntry {
  pending: WriteJob | undefined;
  failed: WriteJob | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Debounces per-key edits and serializes writes while exposing one shared status. */
export class SettingsAutosave {
  private readonly entries = new Map<string, SaveEntry>();
  private readonly idleWaiters: Array<() => void> = [];
  private running = false;
  private flushing = 0;
  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  private status: SettingsSaveStatus = "idle";

  constructor(private readonly options: SettingsAutosaveOptions) {}

  save(
    key: string,
    asyncWrite: () => Promise<boolean>,
    delayMs = 0,
  ): Promise<boolean> {
    const entry = this.entry(key);
    this.clearSavedTimer();
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.failed = undefined;

    let resolve!: (saved: boolean) => void;
    const result = new Promise<boolean>((accept) => {
      resolve = accept;
    });
    if (entry.pending) {
      entry.pending.write = asyncWrite;
      entry.pending.waiters.push(resolve);
    } else entry.pending = { write: asyncWrite, waiters: [resolve] };

    this.publish();
    const effectiveDelay = this.flushing ? 0 : Math.max(0, delayMs);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      this.pump();
    }, effectiveDelay);
    return result;
  }

  /** Starts debounced writes now and waits for the current dirty set to settle once. */
  async flush(): Promise<boolean> {
    this.flushing++;
    try {
      for (const entry of this.entries.values()) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
      }
      this.pump();
      await this.whenIdle();
      return !this.hasFailures();
    } finally {
      this.flushing--;
    }
  }

  /** Retries the latest failed snapshot for each key, without retrying indefinitely. */
  async retry(): Promise<boolean> {
    for (const entry of this.entries.values()) {
      if (!entry.failed || entry.pending) continue;
      const failed = entry.failed;
      entry.failed = undefined;
      entry.pending = { write: failed.write, waiters: [] };
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (this.entries.size) this.clearSavedTimer();
    this.publish();
    for (const entry of this.entries.values()) {
      if (entry.pending && entry.timer === undefined) {
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          this.pump();
        }, 0);
      }
    }
    this.pump();
    await this.whenIdle();
    return !this.hasFailures();
  }

  private entry(key: string): SaveEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { pending: undefined, failed: undefined, timer: undefined };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private pump(): void {
    if (this.running) return;
    const next = Array.from(this.entries.values()).find(
      (entry) => entry.pending && entry.timer === undefined,
    );
    if (!next?.pending) {
      this.publish();
      this.resolveIdle();
      return;
    }
    const job = next.pending;
    next.pending = undefined;
    this.running = true;
    this.publish();
    void Promise.resolve()
      .then(job.write)
      .then(
        (saved) => this.finish(next, job, saved === true),
        () => this.finish(next, job, false),
      );
  }

  private finish(entry: SaveEntry, job: WriteJob, saved: boolean): void {
    if (entry.pending) {
      entry.pending.waiters.unshift(...job.waiters);
    } else if (saved) {
      entry.failed = undefined;
      for (const resolve of job.waiters) resolve(true);
    } else {
      entry.failed = { write: job.write, waiters: [] };
      for (const resolve of job.waiters) resolve(false);
    }
    this.running = false;
    if (saved && !this.hasPending() && !this.hasFailures())
      this.showSavedBriefly();
    else this.publish();
    this.pump();
    this.resolveIdle();
  }

  private showSavedBriefly(): void {
    this.clearSavedTimer();
    this.publish("saved");
    this.savedTimer = setTimeout(() => {
      this.savedTimer = undefined;
      this.publish();
    }, 1_600);
  }

  private publish(forced?: SettingsSaveStatus): void {
    const next =
      forced ??
      (this.running || this.hasPending()
        ? "saving"
        : this.hasFailures()
          ? "error"
          : this.savedTimer
            ? "saved"
            : "idle");
    if (next === this.status) return;
    this.status = next;
    try {
      this.options.onState({ status: next });
    } catch {
      /* UI status must not affect persistence. */
    }
  }

  private whenIdle(): Promise<void> {
    if (!this.running && !this.hasPending()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveIdle(): void {
    if (this.running || this.hasPending()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private hasPending(): boolean {
    return Array.from(this.entries.values()).some(
      (entry) => entry.pending !== undefined,
    );
  }

  private hasFailures(): boolean {
    return Array.from(this.entries.values()).some(
      (entry) => entry.failed !== undefined,
    );
  }

  private clearSavedTimer(): void {
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.savedTimer = undefined;
  }
}

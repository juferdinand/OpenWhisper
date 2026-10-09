import { ControlCaptureLeaseError, type ControlCaptureLease, type ControlCapturePort } from "./control.js";

/** Portal edges act on immutable recording leases, including a recording started by the UI. */
export class ShortcutRecording {
  private pressed = false;
  private holding = false;
  private closed = false;
  private start: AbortController | undefined;
  private operation: Promise<void> | undefined;
  private readonly acquired = new Set<ControlCaptureLease>();
  private held: ControlCaptureLease | undefined;
  private closeTask: Promise<void> | undefined;
  constructor(private readonly capture: ControlCapturePort, private readonly hold: () => boolean,
    private readonly failed: () => void) {}

  activate(): void {
    if (this.closed || this.pressed) return;
    this.pressed = true; this.holding = this.hold();
    if (this.operation) return;
    const holding = this.holding;
    const cancellation = new AbortController(); this.start = cancellation;
    const operation = Promise.resolve().then(async () => {
      const status = await this.capture.status();
      if (this.closed || cancellation.signal.aborted) return;
      if (status === "recording" && !holding) {
        const lease = await this.capture.currentLease?.();
        if (lease && !this.closed && !cancellation.signal.aborted) {
          await this.stop(lease);
        }
      } else if (status === "idle") {
        for (const previous of this.acquired) { await previous.cancel(); this.acquired.delete(previous); }
        if (this.closed || cancellation.signal.aborted) return;
        const lease = await this.capture.start(cancellation.signal); this.acquired.add(lease);
        if (this.closed || cancellation.signal.aborted) { await lease.cancel(); this.acquired.delete(lease); }
        else if (holding) this.held = lease;
      }
    });
    this.operation = operation;
    void operation.catch(() => { if (!this.closed && !cancellation.signal.aborted) this.failed(); }).finally(() => {
      if (this.operation === operation) this.operation = undefined;
      if (this.start === cancellation) this.start = undefined;
    });
  }

  deactivate(): void {
    if (!this.pressed || this.closed) return;
    this.pressed = false;
    if (!this.holding) return;
    this.start?.abort();
    const lease = this.held; this.held = undefined;
    if (!lease) return;
    const operation = Promise.resolve().then(() => this.stop(lease));
    this.operation = operation;
    void operation.catch(this.failed).finally(() => { if (this.operation === operation) this.operation = undefined; });
  }

  private async stop(lease: ControlCaptureLease): Promise<void> {
    try { await lease.stop(); }
    catch (error: unknown) { if (!(error instanceof ControlCaptureLeaseError)) throw error; await lease.cancel(); }
    this.acquired.delete(lease);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true; this.pressed = false; this.start?.abort();
    this.closeTask = Promise.resolve().then(async () => {
      await this.operation?.catch(() => {});
      // Session loss never cancels an unrelated GUI/CLI acquisition.
      const results = await Promise.allSettled([...this.acquired].map(async (lease) => {
        await lease.cancel(); this.acquired.delete(lease);
      }));
      if (results.some((result) => result.status === "rejected")) throw new Error("Shortcut recording cleanup failed.");
    });
    void this.closeTask.catch(() => {}); return this.closeTask;
  }
}

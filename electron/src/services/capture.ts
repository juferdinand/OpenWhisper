import type { CaptureBoundary, CaptureCallbacks, CaptureFinalization, CaptureSession, CapturedHandle,
  PreparedAudio, WorkContext } from "../core/recording.js";
import { checkedCaptureSelection, type CaptureSelection, type NativeCapture, type NativeCaptureSession } from "../workers/native-capture.js";
import type { CaptureMetadata } from "../workers/native-capture.js";

export interface NativeCapturedHandle extends CapturedHandle { readonly owner: symbol }
export interface OwnedCaptureSession extends CaptureSession<NativeCapturedHandle> {
  /** Explicit cleanup only after delivery/discard; failed prepare leaves raw chunks owned. */
  release(): Promise<void>;
}
export interface CaptureDeadlines { readonly startupMs: number; readonly closeMs: number }
const defaultDeadlines: CaptureDeadlines = { startupMs: 10000, closeMs: 15000 };
function active(signal: AbortSignal): void { if (signal.aborted) throw new Error("CAPTURE_FAILED"); }
function bounded<T>(operation: Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((accept, reject) => {
    const fail = (): void => { cleanup(); reject(new Error("CAPTURE_FAILED")); };
    const timer = setTimeout(fail, milliseconds);
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", fail); };
    if (signal?.aborted) { fail(); return; }
    signal?.addEventListener("abort", fail, { once: true });
    operation.then((value) => { cleanup(); accept(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

/** Construct only inside the capture utility. No audio-bearing value crosses main IPC. */
export class NativeCaptureBoundary implements CaptureBoundary<NativeCapturedHandle> {
  private readonly selection: CaptureSelection;
  constructor(private readonly native: NativeCapture, selection: CaptureSelection, private readonly deadlines = defaultDeadlines) {
    this.selection = Object.freeze(checkedCaptureSelection(selection));
    for (const value of [deadlines.startupMs, deadlines.closeMs]) {
      if (!Number.isFinite(value) || value <= 0 || value > 60000) throw new Error("CAPTURE_FAILED");
    }
  }
  create(callbacks: CaptureCallbacks): OwnedCaptureSession {
    const native = this.native.create(callbacks.generation, this.selection);
    return new Session(native, callbacks, this.deadlines);
  }
  /** Reuse the same ownership/fence policy for a platform-specific verified session factory. */
  static fromSessionFactory(factory: (generation: number) => NativeCaptureSession,
    deadlines: CaptureDeadlines = defaultDeadlines): Readonly<{ create(callbacks: CaptureCallbacks): OwnedCaptureSession }> {
    for (const value of [deadlines.startupMs, deadlines.closeMs]) {
      if (!Number.isFinite(value) || value <= 0 || value > 60000) throw new Error("CAPTURE_FAILED");
    }
    const capturedDeadlines = Object.freeze({ ...deadlines });
    return Object.freeze({ create(callbacks: CaptureCallbacks): OwnedCaptureSession {
      return new Session(factory(callbacks.generation), callbacks, capturedDeadlines);
    } });
  }
}
class Session implements OwnedCaptureSession {
  private readonly handle: NativeCapturedHandle;
  private startup: Promise<void> | undefined;
  private startupSettled = false;
  private startupAccepted = true;
  private nativeClosing: Promise<CaptureMetadata> | undefined;
  private nativeRelease: Promise<CaptureMetadata> | undefined;
  private closing: Promise<CaptureFinalization<NativeCapturedHandle>> | undefined;
  private preparing = false;
  private released = false;
  private polling: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly native: NativeCaptureSession, private readonly callbacks: CaptureCallbacks, private readonly deadlines: CaptureDeadlines) {
    this.handle = Object.freeze({ generation: callbacks.generation, owner: Symbol("capture-owner") });
  }
  async start(signal: AbortSignal): Promise<void> {
    if (this.startup || this.released || this.closing) throw new Error("CAPTURE_FAILED");
    active(signal);
    this.startup = (async () => {
      const result = await this.native.start();
      if (result.generation !== this.handle.generation || !result.running || result.failed || result.streamClosed) {
        throw new Error("CAPTURE_FAILED");
      }
      active(signal);
      if (!this.startupAccepted) throw new Error("CAPTURE_FAILED");
      this.polling = setInterval(() => {
        if (this.released || this.closing) return;
        try {
          const status = this.native.status();
          if (status.generation !== this.handle.generation || status.failed) this.callbacks.onError(this.handle.generation);
          else this.callbacks.onLevel(this.handle.generation, status.level);
        } catch { this.callbacks.onError(this.handle.generation); }
      }, 100);
      this.polling.unref();
    })();
    void this.startup.then(() => { this.startupSettled = true; }, () => { this.startupSettled = true; });
    // Rollback/close waits for this transaction before touching the same native device.
    try { await bounded(this.startup, this.deadlines.startupMs, signal); }
    catch (error: unknown) { this.startupAccepted = false; this.native.abortStart(); throw error; }
  }
  closeAndFence(): Promise<CaptureFinalization<NativeCapturedHandle>> {
    if (this.released || this.preparing) return Promise.reject(new Error("CAPTURE_FAILED"));
    if (this.closing) return this.closing;
    if (this.polling) clearInterval(this.polling);
    this.closing = (async () => {
      if (this.startup) {
        try { await bounded(this.startup, this.deadlines.closeMs); }
        catch { if (!this.startupSettled) throw new Error("CAPTURE_FAILED"); }
      }
      if (!this.nativeClosing) {
        this.nativeClosing = this.native.closeAndFence();
        void this.nativeClosing.then((meta) => {
          if (!meta.streamClosed || !meta.finalSamplesFenced) this.nativeClosing = undefined;
        }, () => { this.nativeClosing = undefined; });
      }
      // Timeouts reject, retaining the pending native owner. Retry waits for the same close; no second operation is queued.
      const meta = await bounded(this.nativeClosing, this.deadlines.closeMs);
      if (meta.generation !== this.handle.generation) throw new Error("OWNERSHIP_FAILED");
      return { generation: this.handle.generation, streamClosed: meta.streamClosed, finalSamplesFenced: meta.finalSamplesFenced,
        error: meta.failed ? "capture_failed" : null, captured: meta.streamClosed && meta.finalSamplesFenced ? this.handle : null };
    })();
    void this.closing.then((result) => {
      if (!result.streamClosed || !result.finalSamplesFenced) this.closing = undefined;
    }, () => { this.closing = undefined; });
    return this.closing;
  }
  async prepare(captured: NativeCapturedHandle, context: WorkContext): Promise<PreparedAudio> {
    if (captured !== this.handle || context.generation !== this.handle.generation || this.released || this.preparing) {
      throw new Error("OWNERSHIP_FAILED");
    }
    active(context.signal); this.preparing = true;
    try {
      const fenced = await this.closing;
      if (!fenced?.streamClosed || !fenced.finalSamplesFenced) throw new Error("CAPTURE_FAILED");
      const meta = await this.native.prepare(); active(context.signal);
      if (meta.generation !== context.generation || !meta.streamClosed || !meta.finalSamplesFenced) throw new Error("OWNERSHIP_FAILED");
      const chunks: Float32Array[] = []; let count = 0;
      for (let i = 0; i < meta.chunkCount; i++) {
        active(context.signal);
        const chunk = this.native.readPreparedChunk(i); chunks.push(chunk); count += chunk.length;
        // Yield between bounded reads, independently of complete recording duration.
        if (i % 16 === 15) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (count !== meta.sampleCount) throw new Error("CAPTURE_FAILED");
      return Object.freeze({ generation: context.generation, attempt: context.attempt, sampleRate: 16000 as const,
        sampleCount: count, chunks: Object.freeze(chunks) });
    } finally { this.preparing = false; }
  }
  async release(): Promise<void> {
    if (this.released) return;
    if (this.preparing) throw new Error("CAPTURE_FAILED");
    const fence = await this.closeAndFence();
    if (!fence.streamClosed || !fence.finalSamplesFenced) throw new Error("CAPTURE_FAILED");
    if (!this.nativeRelease) {
      this.nativeRelease = this.native.release();
      // A rejected operation may be retried; a timed-out operation retains its original ownership barrier.
      void this.nativeRelease.catch(() => { this.nativeRelease = undefined; });
    }
    const result = await bounded(this.nativeRelease, this.deadlines.closeMs);
    if (result.generation !== this.handle.generation || !result.streamClosed || !result.finalSamplesFenced) {
      throw new Error("OWNERSHIP_FAILED");
    }
    this.released = true;
  }
}

import { randomUUID } from "node:crypto";
import {
  speechReadySchema, speechReplySchema, speechRequestSchema,
  type SpeechReply, type SpeechRequest,
} from "../workers/speech-protocol.js";
import type { SpeechModel } from "../workers/native-speech.js";

export interface SpeechChannel {
  send(message: SpeechRequest): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: () => void): () => void;
  terminate(): Promise<void>;
}
/** Ordinary factory refusals have rolled back their owner. A trusted integrity or
 * teardown refusal retains failed ownership and blocks this client's reallocation.
 * A returned channel transfers cleanup ownership. */
export type SpeechChannelFactory = (signal: AbortSignal) => Promise<SpeechChannel>;
export type SpeechFailureCode = "CANCELLED" | "BUSY" | "START_FAILED" | "INTEGRITY_FAILED" | "TEARDOWN_FAILED" | "WORKER_FAILED" | "TIMEOUT" | "INVALID_REPLY" | "NATIVE_FAILED" | "CLOSED";
export class SpeechWorkerError extends Error {
  constructor(readonly code: SpeechFailureCode) { super(`Speech worker: ${code}.`); }
}
function terminalFactoryFailure(error: unknown): error is SpeechWorkerError {
  return error instanceof SpeechWorkerError && (error.code === "INTEGRITY_FAILED" || error.code === "TEARDOWN_FAILED");
}

interface Pending {
  readonly request: SpeechRequest;
  readonly accept: (reply: SpeechReply) => void;
  readonly reject: (error: SpeechWorkerError) => void;
}
export interface SpeechDeadlines {
  readonly startupMs: number;
  readonly requestMs: number;
  readonly teardownMs?: number;
}

/** One request and one context owner; failed workers are disposed before a retry. */
export class SpeechClient {
  private channel: SpeechChannel | undefined;
  private pending: Pending | undefined;
  private detach: (() => void)[] = [];
  private start: Promise<void> | undefined;
  private readyAccept: (() => void) | undefined;
  private readyReject: ((error: SpeechWorkerError) => void) | undefined;
  private closed = false;
  private busy = false;
  private disposing: Promise<void> = Promise.resolve();
  private factoryOwnership: Promise<void> = Promise.resolve();
  private startupController: AbortController | undefined;
  private epoch = 0;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private readonly teardownMs: number;

  constructor(private readonly factory: SpeechChannelFactory, private readonly deadlines: SpeechDeadlines = {
    startupMs: 10_000, requestMs: 600_000,
  }) {
    for (const value of Object.values(deadlines)) {
      if (!Number.isInteger(value) || value <= 0 || value > 600_000) throw new Error("Invalid speech deadline.");
    }
    this.teardownMs = deadlines.teardownMs ?? 10_000;
  }

  private onMessage(input: unknown): void {
    if (this.readyAccept) {
      if (!speechReadySchema.safeParse(input).success) { this.fail("INVALID_REPLY"); return; }
      const accept = this.readyAccept;
      this.readyAccept = undefined;
      this.readyReject = undefined;
      accept();
      return;
    }
    const reply = speechReplySchema.safeParse(input);
    const pending = this.pending;
    if (!reply.success || !pending || reply.data.id !== pending.request.id ||
        (reply.data.ok && reply.data.value.command !== pending.request.command)) {
      this.fail("INVALID_REPLY");
      return;
    }
    this.pending = undefined;
    if (reply.data.ok) pending.accept(reply.data);
    else { pending.reject(new SpeechWorkerError("NATIVE_FAILED")); this.dispose(); }
  }

  private fail(code: SpeechFailureCode): void {
    const error = new SpeechWorkerError(code);
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyAccept = undefined;
    this.pending?.reject(error);
    this.pending = undefined;
    this.dispose();
  }

  private dispose(): void {
    this.epoch += 1;
    this.startupController?.abort();
    this.startupController = undefined;
    const channel = this.channel;
    this.channel = undefined;
    this.start = undefined;
    for (const detach of this.detach.splice(0)) detach();
    if (channel) void this.terminateOwned(channel);
  }

  private terminateOwned(channel: SpeechChannel): Promise<void> {
    const previous = this.disposing;
    this.disposing = previous.then(() => channel.terminate());
    // A failed teardown must not become an unhandled rejection or start a new worker.
    void this.disposing.catch(() => {});
    return this.disposing;
  }

  private ensureStarted(): Promise<void> {
    if (this.start) return this.start;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.startupController = controller;
    const previousFactory = this.factoryOwnership;
    const previousDisposal = this.disposing;
    this.start = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { this.fail("TIMEOUT"); }, this.deadlines.startupMs);
      this.readyAccept = () => { clearTimeout(timer); accept(); };
      this.readyReject = (error) => { clearTimeout(timer); reject(error); };
      // Register the transaction before invoking the factory. Cancellation rejects the
      // request promptly, but a retry waits for any late owner to be confirmed reaped.
      this.factoryOwnership = Promise.all([previousFactory, previousDisposal]).catch((error: unknown) => {
        throw new SpeechWorkerError(error instanceof SpeechWorkerError && error.code === "INTEGRITY_FAILED" ? "INTEGRITY_FAILED" : "TEARDOWN_FAILED");
      }).then(async () => {
        if (controller.signal.aborted || this.closed || epoch !== this.epoch) return;
        let channel: SpeechChannel;
        try { channel = await this.factory(controller.signal); }
        catch (error: unknown) {
          // Even a canceled/stale request must retain unconfirmed factory ownership.
          if (terminalFactoryFailure(error)) throw error;
          if (!controller.signal.aborted && epoch === this.epoch) this.fail("START_FAILED");
          return;
        }
        if (controller.signal.aborted || this.closed || epoch !== this.epoch) {
          await this.terminateOwned(channel);
          return;
        }
        this.channel = channel;
        const offMessage = channel.onMessage((value) => { if (epoch === this.epoch) this.onMessage(value); });
        if (epoch !== this.epoch) { offMessage(); return; }
        const offExit = channel.onExit(() => { if (epoch === this.epoch) this.fail("WORKER_FAILED"); });
        if (epoch !== this.epoch) { offMessage(); offExit(); return; }
        this.detach.push(offMessage, offExit);
      });
      void this.factoryOwnership.catch((error: unknown) => {
        if (!controller.signal.aborted && epoch === this.epoch) {
          this.fail(terminalFactoryFailure(error) ? error.code : "START_FAILED");
        }
      });
    });
    return this.start;
  }

  private async request(input: unknown, signal?: AbortSignal, shutdown = false): Promise<SpeechReply> {
    const request = speechRequestSchema.parse(input);
    if (this.closed || (this.closing && !shutdown)) throw new SpeechWorkerError("CLOSED");
    if (signal?.aborted) throw new SpeechWorkerError("CANCELLED");
    if (this.busy) throw new SpeechWorkerError("BUSY");
    this.busy = true;
    const abort = () => { this.fail("CANCELLED"); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.ensureStarted();
      if (signal?.aborted) throw new SpeechWorkerError("CANCELLED");
      const channel = this.channel;
      if (!channel) throw new SpeechWorkerError("WORKER_FAILED");
      return await new Promise<SpeechReply>((accept, reject) => {
        const timer = setTimeout(() => { this.fail("TIMEOUT"); }, shutdown ? 1000 : this.deadlines.requestMs);
        this.pending = {
          request,
          accept: (reply) => { clearTimeout(timer); accept(reply); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        };
        try { channel.send(request); }
        catch { this.fail("WORKER_FAILED"); }
      });
    } catch (error: unknown) {
      this.dispose();
      if (error instanceof SpeechWorkerError) throw error;
      throw new SpeechWorkerError("WORKER_FAILED");
    } finally {
      signal?.removeEventListener("abort", abort);
      this.busy = false;
    }
  }

  async gpuDevice(signal?: AbortSignal): Promise<string | null> {
    const reply = await this.request({ version: 1, id: randomUUID(), command: "discover" }, signal);
    if (!reply.ok || reply.value.command !== "discover") throw new SpeechWorkerError("INVALID_REPLY");
    return reply.value.gpu;
  }

  async transcribeWindow(model: SpeechModel, samples: Float32Array, language: string, vocabulary: string,
                         signal?: AbortSignal): Promise<string> {
    const reply = await this.request({ version: 1, id: randomUUID(), command: "transcribe", model, samples, language, vocabulary }, signal);
    if (!reply.ok || reply.value.command !== "transcribe") throw new SpeechWorkerError("INVALID_REPLY");
    return reply.value.text;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (this.channel && !this.busy && !this.readyAccept) {
        try { await this.request({ version: 1, id: randomUUID(), command: "shutdown" }, undefined, true); }
        catch { /* A hung/crashed worker is disposed below; no request/reply diagnostics. */ }
      }
      this.closed = true;
      this.fail("CLOSED");
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { reject(new SpeechWorkerError("WORKER_FAILED")); }, this.teardownMs);
        void Promise.all([this.factoryOwnership, this.disposing]).then(() => {
          clearTimeout(timer); accept();
        }, () => {
          clearTimeout(timer); reject(new SpeechWorkerError("WORKER_FAILED"));
        });
      });
    })();
    return this.closePromise;
  }
}

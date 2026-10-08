import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DeliveryBoundary, WorkContext } from "../core/recording.js";
import { SpeechWorkerError, type SpeechClient } from "../services/speech-client.js";
import { MAX_WINDOW_SAMPLES, speechWindowSchema } from "./native-speech.js";
import { RecordingEffectError, recordingEffectReplySchema, recordingEffectRequestSchema, safeRecordingEffectError,
  type RecordingEffectReply, type RecordingEffectRequest } from "./recording-effects-protocol.js";

type OperationRequest = Exclude<RecordingEffectRequest, { command: "cancel" }>;
export interface RecordingEffectPort {
  send(request: RecordingEffectRequest): void;
  onMessage(listener: (input: unknown) => void): () => void;
  onExit(listener: () => void): () => void;
}
export interface RecordingEffectDeadlines { readonly effectMs: number; readonly cleanupMs: number }
interface Pending {
  readonly request: OperationRequest;
  readonly signal: AbortSignal;
  readonly accept: (reply: RecordingEffectReply) => void;
  readonly reject: (error: RecordingEffectError) => void;
  readonly cleaned: () => void;
  readonly failedCleanup: (error: RecordingEffectError) => void;
  abort: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  cancelled: boolean;
  settled: boolean;
}
function inferenceError(input: unknown): SpeechWorkerError {
  if (input instanceof z.ZodError) return new SpeechWorkerError("INVALID_REPLY");
  const error = safeRecordingEffectError(input);
  if (error.code === "INVALID_FRAME" || error.code === "OWNERSHIP_FAILED" || error.code === "DELIVERY_FAILED") {
    return new SpeechWorkerError("INVALID_REPLY");
  }
  return new SpeechWorkerError(error.code);
}
async function waitForCleanup(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new RecordingEffectError("CANCELLED");
  await new Promise<void>((accept, reject) => {
    const abort = (): void => { reject(new RecordingEffectError("CANCELLED")); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(accept, reject).finally(() => { signal.removeEventListener("abort", abort); });
  });
  if (signal.aborted) throw new RecordingEffectError("CANCELLED");
}

/** Capture-utility RPC. It retains cleanup ownership after prompt inference cancellation. */
export class WorkerRecordingEffects {
  readonly delivery: DeliveryBoundary;
  private readonly epoch: string;
  private readonly detach: (() => void)[] = [];
  private pending: Pending | undefined;
  private barrier: Promise<void> = Promise.resolve();
  private reserving = false;
  private closed = false;
  private fatal: RecordingEffectError | undefined;
  private closeTask: Promise<void> | undefined;
  constructor(private readonly port: RecordingEffectPort, epoch: string,
    private readonly deadlines: RecordingEffectDeadlines = { effectMs: 600_000, cleanupMs: 15_000 }) {
    this.epoch = z.uuid().parse(epoch);
    for (const value of Object.values(deadlines)) {
      if (!Number.isInteger(value) || value < 1 || value > 600_000) throw new RecordingEffectError("INVALID_FRAME");
    }
    try {
      this.detach.push(port.onMessage((input) => this.receive(input)));
      this.detach.push(port.onExit(() => this.fail(new RecordingEffectError("WORKER_FAILED"))));
    } catch { for (const detach of this.detach.splice(0)) detach(); throw new RecordingEffectError("CLOSED"); }
    this.delivery = { deliver: async (text, context, identity) => {
      const reply = await this.run({ version: 1, epoch: this.epoch, id: randomUUID(),
        generation: context.generation, attempt: context.attempt, command: "deliver", text, identity }, context.signal);
      if (reply.kind === "failed") throw new RecordingEffectError(reply.code);
      if (reply.kind !== "deliver") throw new RecordingEffectError("INVALID_REPLY");
      return reply.receipt;
    } };
  }
  infer(context: WorkContext): Pick<SpeechClient, "transcribeWindow"> {
    return { transcribeWindow: async (model, samples, language, vocabulary, signal) => {
      try {
        if (!(samples instanceof Float32Array) || !(samples.buffer instanceof ArrayBuffer)
          || samples.length < 1 || samples.length > MAX_WINDOW_SAMPLES || !samples.every(Number.isFinite)) {
          throw new RecordingEffectError("INVALID_FRAME");
        }
        // Structured clone includes the whole backing buffer. Copy only this bounded view.
        const window = samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength ? samples : samples.slice();
        const reply = await this.run({ version: 1, epoch: this.epoch, id: randomUUID(),
          generation: context.generation, attempt: context.attempt, command: "infer", model,
          samples: speechWindowSchema.parse(window), language, vocabulary },
        signal ?? context.signal);
        if (reply.kind === "failed") throw new RecordingEffectError(reply.code);
        if (reply.kind !== "infer") throw new RecordingEffectError("INVALID_REPLY");
        return reply.text;
      } catch (error: unknown) { throw inferenceError(error); }
    } };
  }
  private async run(request: OperationRequest, signal: AbortSignal): Promise<RecordingEffectReply> {
    if (this.fatal) throw this.fatal;
    if (this.closed) throw new RecordingEffectError("CLOSED");
    if (!(signal instanceof AbortSignal)) throw new RecordingEffectError("INVALID_FRAME");
    if (this.reserving || (this.pending && !this.pending.settled)) throw new RecordingEffectError("BUSY");
    this.reserving = true;
    try {
      await waitForCleanup(this.barrier, signal);
      if (signal.aborted) throw new RecordingEffectError("CANCELLED");
      if (this.fatal) throw this.fatal;
      if (this.closed) throw new RecordingEffectError("CLOSED");
      const checked = recordingEffectRequestSchema.safeParse(request);
      if (!checked.success) throw new RecordingEffectError("INVALID_FRAME");
      const parsed = checked.data;
      if (parsed.command === "cancel") throw new RecordingEffectError("INVALID_FRAME");
      let cleaned!: () => void;
      let failedCleanup!: (error: RecordingEffectError) => void;
      this.barrier = new Promise<void>((accept, reject) => { cleaned = accept; failedCleanup = reject; });
      void this.barrier.catch(() => {});
      const operation = new Promise<RecordingEffectReply>((accept, reject) => {
        const pending: Pending = { request: parsed, signal, accept, reject, cleaned, failedCleanup,
          abort: () => {}, timer: undefined, cleanupTimer: undefined, cancelled: false, settled: false };
        pending.abort = () => this.cancel(pending, "CANCELLED"); this.pending = pending;
        pending.timer = setTimeout(() => this.cancel(pending, "TIMEOUT"), this.deadlines.effectMs);
        signal.addEventListener("abort", pending.abort, { once: true });
        if (signal.aborted) {
          this.clear(pending); pending.cleaned(); pending.settled = true;
          pending.reject(new RecordingEffectError("CANCELLED")); return;
        }
        try { this.port.send(parsed); }
        catch (error: unknown) { this.fail(safeRecordingEffectError(error)); return; }
        if (signal.aborted) pending.abort();
      });
      return operation;
    } finally { this.reserving = false; }
  }
  private cancel(pending: Pending, code: "CANCELLED" | "TIMEOUT"): void {
    if (this.pending !== pending || pending.cancelled) return;
    pending.cancelled = true;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.request.command === "infer" && !pending.settled) {
      pending.settled = true; pending.reject(new RecordingEffectError(code));
    }
    pending.cleanupTimer = setTimeout(() => this.fail(new RecordingEffectError("TEARDOWN_FAILED")), this.deadlines.cleanupMs);
    const request = pending.request;
    try { this.port.send({ version: 1, epoch: request.epoch, id: request.id,
      generation: request.generation, attempt: request.attempt, command: "cancel" }); }
    catch (error: unknown) { this.fail(safeRecordingEffectError(error)); }
    // Delivery waits for its correlated reply: abort cannot discard a late confirmed receipt.
  }
  private receive(input: unknown): void {
    const parsed = recordingEffectReplySchema.safeParse(input);
    const pending = this.pending;
    if (!parsed.success || !pending) { this.fail(new RecordingEffectError("INVALID_REPLY")); return; }
    const reply = parsed.data; const request = pending.request;
    if (reply.epoch !== request.epoch || reply.id !== request.id || reply.generation !== request.generation
      || reply.attempt !== request.attempt || (reply.kind !== "failed" && reply.kind !== request.command)
      || (reply.kind === "deliver" && (reply.receipt.generation !== request.generation || reply.receipt.attempt !== request.attempt))) {
      this.fail(new RecordingEffectError("INVALID_REPLY")); return;
    }
    if (reply.kind === "failed" && reply.code === "TEARDOWN_FAILED") {
      this.fail(new RecordingEffectError("TEARDOWN_FAILED")); return;
    }
    this.clear(pending); pending.cleaned();
    if (!pending.settled) {
      pending.settled = true; pending.accept(reply);
    }
  }
  private clear(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer);
    pending.signal.removeEventListener("abort", pending.abort);
    if (this.pending === pending) this.pending = undefined;
  }
  private fail(error: RecordingEffectError): void {
    this.fatal ??= error;
    const pending = this.pending;
    if (pending) {
      this.clear(pending); pending.failedCleanup(this.fatal);
      if (!pending.settled) { pending.settled = true; pending.reject(this.fatal); }
    }
    for (const detach of this.detach.splice(0)) detach();
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    if (this.pending) this.cancel(this.pending, "CANCELLED");
    this.closeTask = (async () => {
      try { await this.barrier; if (this.fatal) throw this.fatal; }
      finally { for (const detach of this.detach.splice(0)) detach(); }
    })();
    return this.closeTask;
  }
}

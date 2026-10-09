import { isAbsolute } from "node:path";
import { setImmediate } from "node:timers";
import { z } from "zod";
import { snippetSchema } from "../../contracts/ui/state.js";
import { speechLanguageSchema } from "../../contracts/speech/speech.js";

export const recordingRequestSchema = z.strictObject({
  model: z.strictObject({
    path: z.string().min(1).refine((path) => isAbsolute(path) && !path.includes("\0")),
    family: z.enum(["whisper", "parakeet"]), gpu: z.boolean(),
  }).readonly(),
  language: speechLanguageSchema,
  vocabulary: z.string().refine((value) => !value.includes("\0")),
  snippets: z.array(snippetSchema.readonly()).default([]).readonly(),
}).readonly();
export type RecordingRequest = z.infer<typeof recordingRequestSchema>;
export type RecordingRequestInput = z.input<typeof recordingRequestSchema>;

export interface Ownership { readonly generation: number; readonly attempt: number }
export interface WorkContext extends Ownership { readonly signal: AbortSignal }
export interface CapturedHandle { readonly generation: number }
export interface PreparedAudio extends Ownership {
  readonly sampleRate: 16000;
  readonly sampleCount: number;
  readonly chunks: readonly Float32Array[];
}
export interface CaptureFinalization<C extends CapturedHandle> {
  readonly generation: number;
  readonly streamClosed: boolean;
  readonly finalSamplesFenced: boolean;
  readonly error: "capture_failed" | null;
  readonly captured: C | null;
}
export interface CaptureCallbacks {
  readonly generation: number;
  readonly onLevel: (generation: number, level: number) => void;
  readonly onError: (generation: number) => void;
}
export interface CaptureSession<C extends CapturedHandle> {
  /** Observe cancellation during startup; never open capture after a rejected start. */
  start(signal: AbortSignal): Promise<void>;
  /** Close/check the stream, drain in-flight callbacks, and transfer a generation-owned handle.
   * This fence must not flatten/resample audio. Keep audio owned until preparation/discard.
   * A failed fence must leave the session available for a later cleanup attempt. */
  closeAndFence(): Promise<CaptureFinalization<C>>;
  /** Duration-heavy conversion/validation runs outside the main/renderer event loops.
   * Returned buffers are transferred exclusively; no old callback may mutate them. */
  prepare(captured: C, context: WorkContext): Promise<PreparedAudio>;
  /** Idempotent, bounded cleanup after a confirmed fence. Failure retains ownership for retry. */
  release?(): Promise<void>;
}
export interface CaptureBoundary<C extends CapturedHandle> {
  /** Allocate ownership only; opening a native stream belongs to start(). */
  create(callbacks: CaptureCallbacks): CaptureSession<C>;
}
export interface SpeechResult extends Ownership { readonly text: string }
export interface SpeechBoundary {
  /** Produce final processed text using a captured request, independently of optional LLMs:
   * raw inference -> cleanup -> vocabulary correction -> snippets. Parakeet vocabulary
   * is postprocessed; its native model does not accept a vocabulary prompt.
   * The adapter owns bounded inference windows, disposable workers and CPU/GPU retries. */
  transcribe(audio: PreparedAudio, request: RecordingRequest, context: WorkContext): Promise<SpeechResult>;
}
export interface SpeechDisposition extends Ownership { readonly hasSpeech: boolean }
export interface SpeechGate {
  /** Scan only in the capture utility. No duration-heavy work belongs on main or renderer. */
  classify(audio: PreparedAudio, context: WorkContext): Promise<SpeechDisposition>;
}
export type DeliveryReceipt = Ownership & (
  | { readonly outcome: "clipboard" | "paste"; readonly clipboardConfirmed: true }
  | { readonly outcome: "editor" | "failed"; readonly clipboardConfirmed: false }
);
export type DeliveryIdentity =
  | { readonly kind: "recovery"; readonly token: string }
  | { readonly kind: "memory"; readonly generation: number };
export interface DeliveryBoundary {
  /** Check cancellation/target ownership at commit, then confirm delivery. Linux recovery
   * identity survives a capture-helper restart; memory identity is scoped by its helper epoch.
   * Retrying one identity must not duplicate an already confirmed commit. */
  deliver(text: string, context: WorkContext, identity: DeliveryIdentity): Promise<DeliveryReceipt>;
}
export interface RecoveryToken { readonly id: string }
export interface RecoverySaved extends Ownership {
  readonly token: RecoveryToken;
  /** False retains a visible committed file whose directory durability still needs confirmation. */
  readonly durable?: boolean;
}
export interface RecoveryBoundary {
  latest(): Promise<RecoveryToken | null>;
  /** Atomically commit private audio or reject without a committed record. Cancellation
   * must not lose the only copy; a late committed token still belongs to this recording. */
  save(audio: PreparedAudio, context: WorkContext): Promise<RecoverySaved>;
  /** Retry durability for the same committed token before inference, without creating another backup. */
  ensureCommitted?(token: RecoveryToken, context: WorkContext): Promise<RecoverySaved>;
  read(token: RecoveryToken, context: WorkContext): Promise<PreparedAudio>;
  remove(token: RecoveryToken, context: WorkContext): Promise<Ownership>;
}
/** A finite monotonic millisecond clock; adapters normally use performance.now(). */
interface RecordingClock { now(): number }
export type RecordingPhase = "idle" | "starting" | "recording" | "stopping"
  | "transcribing" | "restoring" | "discarding" | "done" | "error";
export type RecordingError = "BUSY" | "INVALID_REQUEST" | "CALLER_INACTIVE" | "START_FAILED"
  | "STOP_FAILED" | "CAPTURE_FAILED" | "CAPTURE_RELEASE_FAILED" | "OWNERSHIP_FAILED" | "PREPARATION_FAILED"
  | "RECOVERY_PENDING" | "RECOVERY_READ_FAILED" | "RECOVERY_SAVE_FAILED"
  | "RECOVERY_REMOVE_FAILED" | "SPEECH_FAILED" | "EMPTY_TRANSCRIPT" | "DELIVERY_FAILED"
  | "CANCELLED" | "NO_RECOVERY";
export type ControlReply = { readonly ok: true; readonly generation: number }
  | { readonly ok: false; readonly generation: number; readonly error: RecordingError };
export type Acknowledge = (reply: ControlReply) => boolean;
export interface StartControl { readonly acknowledge: Acknowledge; readonly signal?: AbortSignal }
export interface RecordingSnapshot {
  readonly phase: RecordingPhase;
  readonly generation: number;
  readonly elapsedMs: number;
  readonly level: number;
  readonly busy: boolean;
  readonly recoveryAvailable: boolean;
  readonly error: RecordingError | null;
  readonly transcript: string;
}
interface CommonOptions<C extends CapturedHandle> {
  readonly capture: CaptureBoundary<C>;
  readonly speech: SpeechBoundary;
  readonly delivery: DeliveryBoundary;
  readonly clock: RecordingClock;
}
export type RecordingOptions<C extends CapturedHandle> = CommonOptions<C> & (
  | { readonly platform: "linux"; readonly recovery: RecoveryBoundary; readonly speechGate?: SpeechGate }
  | { readonly platform: "macos"; readonly recovery?: never; readonly speechGate?: never }
);
interface CaptureOwner<C extends CapturedHandle> {
  readonly generation: number;
  readonly request: RecordingRequest;
  readonly controller: AbortController;
  session: CaptureSession<C> | undefined;
  startDone: Promise<void>;
  closing: Promise<CaptureFinalization<C>> | undefined;
  failed: boolean;
  discarding: boolean;
}
interface Pending<C extends CapturedHandle> {
  readonly generation: number;
  readonly request: RecordingRequest;
  readonly session: CaptureSession<C> | undefined;
  readonly captured: C | undefined;
  prepared: PreparedAudio | undefined;
  preparing: Promise<PreparedAudio> | undefined;
  speechDetected: boolean | undefined;
  releasing: Promise<void> | undefined;
  released: boolean;
  token: RecoveryToken | undefined;
  durabilityPending: boolean;
  captureFailed: boolean;
  text: string | undefined;
  receipt: DeliveryReceipt | undefined;
  saving: Promise<RecoverySaved> | undefined;
  delivering: Promise<DeliveryReceipt> | undefined;
  removing: Promise<Ownership> | undefined;
  discarded: boolean;
}
interface Job<C extends CapturedHandle> {
  readonly pending: Pending<C>;
  readonly context: WorkContext;
  readonly controller: AbortController;
  readonly retentionError: RecordingError | undefined;
  completion: Promise<RecordingSnapshot>;
}

const accepted: Acknowledge = () => true;
function acknowledge(sink: Acknowledge, reply: ControlReply): boolean {
  try { return sink(reply) === true; } catch { return false; }
}
function owned(result: Ownership, context: Ownership): boolean {
  return result.generation === context.generation && result.attempt === context.attempt;
}
function tokenValid(token: RecoveryToken): boolean {
  return typeof token.id === "string" && token.id.length > 0 && token.id.length <= 512;
}
function checkedAudio(audio: PreparedAudio, context: Ownership): PreparedAudio {
  if (!owned(audio, context)) throw new Error("OWNERSHIP_FAILED");
  if (audio.sampleRate !== 16000 || !Number.isSafeInteger(audio.sampleCount) || audio.sampleCount < 0
    || !Array.isArray(audio.chunks)) throw new Error("PREPARATION_FAILED");
  let count = 0;
  for (const chunk of audio.chunks) {
    if (!(chunk instanceof Float32Array) || !(chunk.buffer instanceof ArrayBuffer)) {
      throw new Error("PREPARATION_FAILED");
    }
    count += chunk.length;
  }
  if (count !== audio.sampleCount) throw new Error("PREPARATION_FAILED");
  // Sample validation/conversion and windowing belong to the injected worker boundary.
  // No whole-recording sample limit or sample scan is introduced here.
  return Object.freeze({ ...audio, chunks: Object.freeze([...audio.chunks]) });
}

/** Pure lifecycle policy with injected effects. No device, filesystem, worker or LLM is opened here. */
export class RecordingCoordinator<C extends CapturedHandle> {
  private generation = 0;
  private attempt = 0;
  private phase: RecordingPhase = "idle";
  private error: RecordingError | null = null;
  private level = 0;
  private transcript = "";
  private startedAt: number | undefined;
  private elapsedMs = 0;
  private capture: CaptureOwner<C> | undefined;
  private pending: Pending<C> | undefined;
  private job: Job<C> | undefined;
  private lookup: object | undefined;
  private discarding = false;
  private readonly recovery: RecoveryBoundary | undefined;

  constructor(private readonly options: RecordingOptions<C>) {
    if (options.platform === "macos" && options.recovery !== undefined) {
      throw new Error("macOS recording recovery must remain in memory.");
    }
    if (options.platform === "macos" && options.speechGate !== undefined) {
      throw new Error("macOS recording must not use the Linux silence gate.");
    }
    if (options.platform === "linux" && options.recovery === undefined) {
      throw new Error("Linux recording requires a private recovery boundary.");
    }
    this.recovery = options.recovery;
  }

  snapshot(): RecordingSnapshot {
    const now = this.options.clock.now();
    const elapsed = this.startedAt !== undefined && Number.isFinite(now)
      ? Math.max(this.elapsedMs, now - this.startedAt) : this.elapsedMs;
    return Object.freeze({
      phase: this.phase, generation: this.generation, elapsedMs: Math.max(0, elapsed),
      level: this.level, busy: this.capture !== undefined || this.job !== undefined
        || this.lookup !== undefined || this.discarding,
      recoveryAvailable: this.pending !== undefined, error: this.error, transcript: this.transcript,
    });
  }

  completion(): Promise<RecordingSnapshot> {
    return this.job?.completion ?? Promise.resolve(this.snapshot());
  }

  private reply(ok: boolean, error: RecordingError = "BUSY", generation = this.generation): ControlReply {
    return ok ? { ok: true, generation } : { ok: false, generation, error };
  }
  private fail(error: RecordingError): void { this.phase = "error"; this.error = error; this.level = 0; }
  private available(): boolean { return !this.snapshot().busy && this.pending === undefined; }
  private context(generation: number, controller: AbortController): WorkContext {
    return { generation, attempt: ++this.attempt, signal: controller.signal };
  }
  private newPending(owner: { generation: number; request: RecordingRequest },
    session?: CaptureSession<C>, captured?: C, token?: RecoveryToken): Pending<C> {
    return { generation: owner.generation, request: owner.request, session, captured, token,
      prepared: undefined, preparing: undefined, speechDetected: undefined, releasing: undefined,
      released: false, text: undefined, receipt: undefined, saving: undefined,
      delivering: undefined, removing: undefined, discarded: false, durabilityPending: false, captureFailed: false };
  }

  async start(input: RecordingRequestInput, control: StartControl = { acknowledge: accepted }): Promise<ControlReply> {
    if (!this.available()) {
      const reply = this.reply(false, this.pending ? "RECOVERY_PENDING" : "BUSY");
      acknowledge(control.acknowledge, reply); return reply;
    }
    let request: RecordingRequest;
    try { request = recordingRequestSchema.parse(input); }
    catch { const reply = this.reply(false, "INVALID_REQUEST"); acknowledge(control.acknowledge, reply); return reply; }
    const owner: CaptureOwner<C> = {
      generation: ++this.generation, request, controller: new AbortController(), session: undefined,
      startDone: Promise.resolve(), closing: undefined, failed: false, discarding: false,
    };
    this.capture = owner; this.phase = "starting"; this.error = null;
    const expire = (): void => { owner.controller.abort(); };
    control.signal?.addEventListener("abort", expire, { once: true });
    if (control.signal?.aborted) expire();
    try {
      if (this.recovery) {
        const token = await this.recovery.latest();
        if (this.capture !== owner || owner.controller.signal.aborted) throw new Error("CALLER_INACTIVE");
        if (token !== null) {
          if (!tokenValid(token)) throw new Error("RECOVERY_READ_FAILED");
          this.pending = this.newPending(owner, undefined, undefined, token);
          this.capture = undefined; this.fail("RECOVERY_PENDING");
          const reply = this.reply(false, "RECOVERY_PENDING", owner.generation);
          acknowledge(control.acknowledge, reply); return reply;
        }
      }
      if (owner.controller.signal.aborted) throw new Error("CALLER_INACTIVE");
      owner.session = this.options.capture.create({
        generation: owner.generation,
        onLevel: (generation, level) => {
          if (generation === owner.generation && this.capture === owner && this.phase === "recording"
            && Number.isFinite(level)) this.level = Math.min(1, Math.max(0, level));
        },
        onError: (generation) => {
          if (generation !== owner.generation || this.capture !== owner) return;
          owner.failed = true;
          if (this.phase === "recording") void this.stop();
        },
      });
      owner.startDone = owner.session.start(owner.controller.signal);
      await owner.startDone;
      if (this.capture !== owner || owner.controller.signal.aborted || owner.failed) throw new Error("CALLER_INACTIVE");
      this.startedAt = this.options.clock.now(); this.elapsedMs = 0; this.level = 0;
      this.phase = "recording"; this.error = null;
      const success = this.reply(true, "BUSY", owner.generation);
      if (acknowledge(control.acknowledge, success)) return success;
      owner.controller.abort();
      await this.rollback(owner);
      return this.reply(false, "CALLER_INACTIVE", owner.generation);
    } catch {
      const reason: RecordingError = owner.controller.signal.aborted ? "CALLER_INACTIVE" : "START_FAILED";
      await this.rollback(owner);
      const reply = this.reply(false, reason, owner.generation);
      acknowledge(control.acknowledge, reply); return reply;
    } finally { control.signal?.removeEventListener("abort", expire); }
  }

  private async finalization(owner: CaptureOwner<C>): Promise<CaptureFinalization<C>> {
    owner.closing ??= (async () => {
      await owner.startDone.catch(() => {});
      return owner.session ? owner.session.closeAndFence() : {
        generation: owner.generation, streamClosed: true, finalSamplesFenced: true, error: null, captured: null,
      };
    })();
    try {
      const result = await owner.closing;
      if (!this.closed(owner, result)) owner.closing = undefined;
      return result;
    } catch (error: unknown) { owner.closing = undefined; throw error; }
  }
  private closed(owner: CaptureOwner<C>, result: CaptureFinalization<C>): boolean {
    return result.generation === owner.generation && result.streamClosed === true
      && result.finalSamplesFenced === true
      && (result.captured === null || result.captured.generation === owner.generation);
  }
  private freezeElapsed(): void {
    this.elapsedMs = this.snapshot().elapsedMs; this.startedAt = undefined; this.level = 0;
  }
  private async rollback(owner: CaptureOwner<C>): Promise<void> {
    owner.discarding = true; owner.controller.abort();
    try {
      const final = await this.finalization(owner);
      if (this.capture === owner) {
        this.freezeElapsed();
        if (this.closed(owner, final)) {
          try { await owner.session?.release?.(); }
          catch { if (this.capture === owner) this.fail("CAPTURE_RELEASE_FAILED"); return; }
          if (this.capture !== owner) return;
          this.capture = undefined; this.fail("START_FAILED");
        }
        else this.fail("STOP_FAILED");
      }
    } catch { if (this.capture === owner) this.fail("STOP_FAILED"); }
  }

  async stop(sink: Acknowledge = accepted): Promise<ControlReply> {
    const owner = this.capture;
    if (!owner) { const reply = this.reply(!this.job, "BUSY"); acknowledge(sink, reply); return reply; }
    if (owner.discarding) {
      const reply = this.reply(false, "BUSY", owner.generation); acknowledge(sink, reply); return reply;
    }
    if (this.phase === "starting") return this.cancel(sink);
    this.phase = "stopping";
    let final: CaptureFinalization<C>;
    try { final = await this.finalization(owner); }
    catch { this.fail("STOP_FAILED"); const reply = this.reply(false, "STOP_FAILED", owner.generation); acknowledge(sink, reply); return reply; }
    if (owner.discarding) {
      const reply = this.reply(false, "BUSY", owner.generation); acknowledge(sink, reply); return reply;
    }
    if (this.capture !== owner) {
      const reply = this.reply(false, "CANCELLED", owner.generation); acknowledge(sink, reply); return reply;
    }
    if (!this.closed(owner, final) || final.captured === null) {
      this.fail("STOP_FAILED"); const reply = this.reply(false, "STOP_FAILED", owner.generation);
      acknowledge(sink, reply); return reply;
    }
    this.freezeElapsed(); this.capture = undefined;
    const pending = this.newPending(owner, owner.session, final.captured);
    this.pending = pending;
    const failure = owner.failed || final.error !== null ? "CAPTURE_FAILED" : undefined;
    const reply = this.reply(failure === undefined, failure ?? "BUSY", owner.generation);
    if (failure) this.fail(failure); else { this.phase = "transcribing"; this.error = null; }
    // This synchronous sink commits Stop's reply before any duration-heavy work is scheduled.
    acknowledge(sink, reply);
    this.launch(pending, failure);
    return reply;
  }

  async cancel(sink: Acknowledge = accepted): Promise<ControlReply> {
    if (this.lookup) { this.lookup = undefined; this.phase = "idle"; }
    const owner = this.capture;
    if (owner) {
      owner.discarding = true; owner.controller.abort(); this.phase = "stopping";
      let final: CaptureFinalization<C>;
      try { final = await this.finalization(owner); }
      catch { if (this.capture === owner) this.fail("STOP_FAILED"); const reply = this.reply(false, "STOP_FAILED", owner.generation); acknowledge(sink, reply); return reply; }
      if (this.capture === owner) {
        if (!this.closed(owner, final)) {
          this.fail("STOP_FAILED"); const reply = this.reply(false, "STOP_FAILED", owner.generation); acknowledge(sink, reply); return reply;
        }
        this.freezeElapsed();
        if (owner.failed || final.error !== null) {
          this.capture = undefined;
          if (final.captured !== null) {
            this.pending = this.newPending(owner, owner.session, final.captured);
            this.launch(this.pending, "CAPTURE_FAILED");
          }
          this.fail("CAPTURE_FAILED");
          const reply = this.reply(false, "CAPTURE_FAILED", owner.generation); acknowledge(sink, reply); return reply;
        }
        try { await owner.session?.release?.(); }
        catch {
          if (this.capture === owner) this.fail("CAPTURE_RELEASE_FAILED");
          const reply = this.reply(false, "CAPTURE_RELEASE_FAILED", owner.generation); acknowledge(sink, reply); return reply;
        }
        if (this.capture !== owner) {
          const reply = this.reply(true, "BUSY", owner.generation); acknowledge(sink, reply); return reply;
        }
        this.capture = undefined;
        this.phase = "idle"; this.error = null;
      }
    } else if (this.job) {
      this.job.controller.abort(); this.job = undefined;
      this.fail("CANCELLED");
    }
    const reply = this.reply(true); acknowledge(sink, reply); return reply;
  }

  async restoreRecovery(input: RecordingRequestInput): Promise<boolean> {
    if (!this.recovery || !this.available()) return false;
    const request = recordingRequestSchema.parse(input);
    const lookup = {}; this.lookup = lookup; this.phase = "restoring";
    try {
      const token = await this.recovery.latest();
      if (this.lookup !== lookup) return false;
      if (token === null) { this.phase = "idle"; this.error = null; return false; }
      if (!tokenValid(token)) throw new Error("Invalid recovery token.");
      this.pending = this.newPending({ generation: ++this.generation, request }, undefined, undefined, token);
      this.fail("RECOVERY_PENDING"); return true;
    } catch { if (this.lookup === lookup) this.fail("RECOVERY_READ_FAILED"); return false; }
    finally { if (this.lookup === lookup) this.lookup = undefined; }
  }

  retry(): ControlReply {
    if (this.capture || this.job || this.lookup || this.discarding) return this.reply(false, "BUSY");
    if (!this.pending) return this.reply(false, "NO_RECOVERY");
    this.launch(this.pending); return this.reply(true);
  }

  async discardRecovery(): Promise<ControlReply> {
    if (this.capture || this.lookup || this.discarding) return this.reply(false, "BUSY");
    const pending = this.pending;
    if (!pending) return this.reply(true);
    this.job?.controller.abort(); this.job = undefined;
    this.discarding = true; pending.discarded = true; this.phase = "discarding";
    const context = this.context(pending.generation, new AbortController());
    let stage: RecordingError = "RECOVERY_REMOVE_FAILED";
    try {
      // Cancellation can clear the active job while its native conversion is still settling.
      await pending.preparing?.catch(() => {});
      // A save may commit after cancellation. Wait for its owned token before discarding.
      await pending.saving?.catch(() => {});
      // Do not release this recording's ownership while an earlier native delivery
      // can still commit. The adapter must settle cancellation with its bounded cleanup.
      await pending.delivering?.catch(() => {});
      await this.remove(pending, context);
      stage = "CAPTURE_RELEASE_FAILED"; await this.release(pending);
      if (this.pending === pending) { this.pending = undefined; this.phase = "idle"; this.error = null; }
      return this.reply(true, "BUSY", pending.generation);
    } catch {
      pending.discarded = false; this.fail(stage);
      return this.reply(false, stage, pending.generation);
    } finally { this.discarding = false; }
  }

  private launch(pending: Pending<C>, retentionError?: RecordingError): void {
    if (retentionError === "CAPTURE_FAILED") pending.captureFailed = true;
    const controller = new AbortController();
    const job: Job<C> = {
      pending, controller, context: this.context(pending.generation, controller), retentionError,
      completion: Promise.resolve(this.snapshot()),
    };
    this.job = job; this.phase = retentionError ? "error" : "transcribing";
    this.error = retentionError ?? null;
    job.completion = new Promise((resolve) => {
      setImmediate(() => { void this.process(job).then(() => { resolve(this.snapshot()); }); });
    });
  }
  private current(job: Job<C>): boolean {
    return this.job === job && this.pending === job.pending && !job.pending.discarded && !job.context.signal.aborted;
  }
  private async save(pending: Pending<C>, audio: PreparedAudio, context: WorkContext): Promise<void> {
    const recovery = this.recovery;
    if (!recovery || (pending.token && !pending.durabilityPending)) return;
    if (!pending.saving) {
      pending.saving = (async () => {
        const previous = pending.token;
        const saved = previous
          ? await (recovery.ensureCommitted?.(previous, context) ?? Promise.reject(new Error("Recovery durability is not confirmed.")))
          : await recovery.save(audio, context);
        if (!owned(saved, context) || !tokenValid(saved.token)
            || (previous && saved.token.id !== previous.id)) throw new Error("Invalid recovery ownership.");
        // A visible committed file must remain owned even when its durability failed.
        pending.token = Object.freeze({ id: saved.token.id });
        pending.durabilityPending = previous ? saved.durable !== true : saved.durable === false;
        if (saved.durable !== undefined && typeof saved.durable !== "boolean") {
          pending.durabilityPending = true; throw new Error("Invalid recovery durability.");
        }
        return saved;
      })();
    }
    const saving = pending.saving;
    try {
      await saving;
      if (pending.durabilityPending) throw new Error("Recovery durability is not confirmed.");
    } finally { if (pending.saving === saving) pending.saving = undefined; }
  }
  private deliveryConfirmed(receipt: DeliveryReceipt): boolean {
    if (receipt.outcome === "clipboard" || receipt.outcome === "paste") {
      return receipt.clipboardConfirmed === true;
    }
    return receipt.outcome === "editor" && receipt.clipboardConfirmed === false
      && this.options.platform === "macos";
  }
  private async remove(pending: Pending<C>, context: WorkContext): Promise<void> {
    const recovery = this.recovery;
    if (!recovery || !pending.token) return;
    if (!pending.removing) {
      const token = pending.token;
      pending.removing = (async () => {
        const result = await recovery.remove(token, context);
        if (!owned(result, context)) throw new Error("Invalid recovery removal ownership.");
        // A confirmed removal remains true after cancellation. Update only its old
        // recording object so a later retry does not refer to an already removed file.
        if (pending.token?.id === token.id) pending.token = undefined;
        return result;
      })();
    }
    const removing = pending.removing;
    try { await removing; } finally { if (pending.removing === removing) pending.removing = undefined; }
  }
  private async deliver(pending: Pending<C>, context: WorkContext): Promise<void> {
    if (pending.receipt && this.deliveryConfirmed(pending.receipt)) return;
    if (!pending.delivering) {
      pending.delivering = (async () => {
        const identity: DeliveryIdentity = pending.token
          ? { kind: "recovery", token: pending.token.id }
          : { kind: "memory", generation: pending.generation };
        const receipt = await this.options.delivery.deliver(pending.text ?? "", context, identity);
        if (!owned(receipt, context)) throw new Error("Invalid delivery ownership.");
        pending.receipt = receipt;
        return receipt;
      })();
    }
    const delivering = pending.delivering;
    try {
      const receipt = await delivering;
      if (!this.deliveryConfirmed(receipt)) throw new Error("Delivery was not confirmed.");
    } finally { if (pending.delivering === delivering) pending.delivering = undefined; }
  }
  private async release(pending: Pending<C>): Promise<void> {
    if (pending.released) return;
    pending.releasing ??= (async () => {
      await pending.session?.release?.(); pending.released = true;
    })();
    const releasing = pending.releasing;
    try { await releasing; }
    finally { if (pending.releasing === releasing) pending.releasing = undefined; }
  }
  private async process(job: Job<C>): Promise<void> {
    const { pending, context } = job;
    let stage: RecordingError = "PREPARATION_FAILED";
    try {
      if (!this.current(job)) return;
      if (!pending.prepared) {
        // A cancelled attempt may still own the native converter. Never run two preparations.
        await pending.preparing?.catch(() => {});
        if (!this.current(job)) return;
        let audio: PreparedAudio;
        if (pending.captured && pending.session) {
          const preparing = pending.session.prepare(pending.captured, context);
          pending.preparing = preparing;
          try { audio = await preparing; }
          finally { if (pending.preparing === preparing) pending.preparing = undefined; }
        } else if (pending.token && this.recovery) {
          stage = "RECOVERY_READ_FAILED"; audio = await this.recovery.read(pending.token, context);
        } else throw new Error("No captured audio is available.");
        if (!this.current(job)) return;
        pending.prepared = checkedAudio(audio, context);
      }
      if (!this.current(job)) return;
      const audio: PreparedAudio = { ...pending.prepared, generation: context.generation, attempt: context.attempt };
      const gate = this.options.platform === "linux" ? this.options.speechGate : undefined;
      if (gate && !pending.token && !pending.captureFailed) {
        if (pending.speechDetected === undefined) {
          const disposition = await gate.classify(audio, context);
          if (!this.current(job)) return;
          if (!owned(disposition, context) || typeof disposition.hasSpeech !== "boolean") {
            stage = "OWNERSHIP_FAILED"; throw new Error("Invalid silence classification ownership.");
          }
          pending.speechDetected = disposition.hasSpeech;
        }
        if (!pending.speechDetected) {
          stage = "CAPTURE_RELEASE_FAILED"; await this.release(pending);
          if (!this.current(job)) return;
          this.pending = undefined; this.phase = "idle"; this.error = null; return;
        }
      }
      stage = "RECOVERY_SAVE_FAILED";
      if (!pending.receipt || !this.deliveryConfirmed(pending.receipt)) await this.save(pending, audio, context);
      if (!this.current(job)) return;
      if (job.retentionError) { this.fail(job.retentionError); return; }
      if (pending.text === undefined) {
        stage = "SPEECH_FAILED";
        const result = await this.options.speech.transcribe(audio, pending.request, context);
        if (!this.current(job)) return;
        if (!owned(result, context)) { stage = "OWNERSHIP_FAILED"; throw new Error("Invalid speech ownership."); }
        if (typeof result.text !== "string" || result.text.trim().length === 0) {
          stage = "EMPTY_TRANSCRIPT"; throw new Error("No speech was recognized.");
        }
        pending.text = result.text;
      }
      if (!this.current(job)) return;
      stage = "DELIVERY_FAILED"; await this.deliver(pending, context);
      if (!this.current(job)) return;
      stage = "RECOVERY_REMOVE_FAILED";
      await this.remove(pending, context);
      if (!this.current(job)) return;
      stage = "CAPTURE_RELEASE_FAILED"; await this.release(pending);
      if (!this.current(job)) return;
      this.transcript = pending.text; this.pending = undefined; this.phase = "done"; this.error = null;
    } catch { if (this.current(job)) this.fail(stage); }
    finally { if (this.job === job) this.job = undefined; }
  }
}

import { z } from "zod";
import { RecordingCoordinator, type CaptureBoundary, type ControlReply, type DeliveryBoundary,
  type RecordingSnapshot, type RecoveryBoundary, type WorkContext } from "../core/recording/recording.js";
import { AdaptiveSpeechBoundary, createUtilitySpeechEffects } from "../services/speech/adaptive-speech.js";
import type { NativeCapturedHandle } from "../services/recording/capture.js";
import type { SpeechClient } from "../services/speech/speech-client.js";
import { LinuxSpeechGate } from "./speech-gate.js";
import { recordingHostReplySchema, recordingHostRequestSchema,
  type RecordingConfiguration, type RecordingEnumeration, type RecordingHostReply,
  type RecordingHostRequest, type RecordingSource } from "./recording-host-protocol.js";

export interface CaptureRuntimeEffects {
  /** Verifies/loads the fixed addon and opens only private recovery; no capture starts here. */
  prepare(configuration: RecordingConfiguration): Promise<Readonly<{
    capture: CaptureBoundary<NativeCapturedHandle>; recovery: RecoveryBoundary;
  }>>;
  enumerate(request: RecordingEnumeration): Promise<readonly RecordingSource[]>;
  infer(context: WorkContext): Pick<SpeechClient, "transcribeWindow">;
  readonly delivery: DeliveryBoundary;
  /** Original recording RPC cleanup; cancellation never forgets a late confirmed delivery. */
  close(): Promise<void>;
}
export class CaptureRuntimeError extends Error {
  constructor(readonly code: "INVALID_FRAME" | "TEARDOWN_FAILED" | "CLOSED") { super(`Recording host: ${code}.`); }
}
type Action = Exclude<RecordingHostRequest, RecordingConfiguration | RecordingEnumeration>;
type LocalReply<T> = T extends unknown ? Omit<T, "version" | "channel" | "epoch"> : never;

/** Utility-local normal recording composition. Only metadata, bounded windows and final text leave it. */
export class CaptureRuntime {
  private readonly epoch: string;
  private coordinator: RecordingCoordinator<NativeCapturedHandle> | undefined;
  private recovery: RecoveryBoundary | undefined;
  private configuration: RecordingConfiguration | undefined;
  private configuring: Promise<void> | undefined;
  private readonly operations = new Set<Promise<void>>();
  private readonly confirmedDelivery = new Map<string, Readonly<{ generation: number; attempt: number }>>();
  private readonly ids = new Set<string>();
  private busy = false;
  private closing = false;
  private closed = false;
  private halted = false;
  private pastRecoverySave = false;
  private closeTask: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private previous: RecordingSnapshot | undefined;
  constructor(options: { epoch: string; pid: number; send(reply: RecordingHostReply): void; effects: CaptureRuntimeEffects }) {
    this.epoch = z.uuid().parse(options.epoch);
    z.number().int().positive().max(0x7fffffff).parse(options.pid);
    this.send = options.send; this.effects = options.effects;
    this.emit({ kind: "ready", pid: options.pid });
  }
  private readonly send: (reply: RecordingHostReply) => void;
  private readonly effects: CaptureRuntimeEffects;
  private emit(value: LocalReply<RecordingHostReply>): void {
    this.send(recordingHostReplySchema.parse({ version: 1, channel: "recording-host", epoch: this.epoch, ...value }));
  }
  private publish(): void {
    const snapshot = this.coordinator?.snapshot(); if (!snapshot || this.closed) return;
    const old = this.previous;
    if (old && old.phase === snapshot.phase && old.generation === snapshot.generation && old.elapsedMs === snapshot.elapsedMs
      && old.level === snapshot.level && old.busy === snapshot.busy && old.recoveryAvailable === snapshot.recoveryAvailable
      && old.error === snapshot.error && old.transcript === snapshot.transcript) return;
    this.emit({ kind: "snapshot", snapshot }); this.previous = snapshot;
  }
  private control(request: RecordingHostRequest, reply: ControlReply): boolean {
    try { this.emit({ kind: "control", id: request.id, command: request.command, reply }); }
    catch { return false; }
    // A later snapshot refusal cannot retract the control acknowledgement already posted.
    try { this.publish(); } catch { void this.close().catch(() => {}); }
    return true;
  }
  private failed(request: RecordingHostRequest, code: "BUSY" | "INVALID_REQUEST" | "UNAVAILABLE" | "CLOSED" | "TEARDOWN_FAILED"): void {
    this.emit({ kind: "failed", id: request.id, code });
  }
  receive(input: unknown): Promise<void> {
    const parsed = recordingHostRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.epoch !== this.epoch || this.ids.has(parsed.data.id)) {
      return Promise.reject(new CaptureRuntimeError("INVALID_FRAME"));
    }
    const request = parsed.data; this.ids.add(request.id);
    if (this.ids.size > 256) { const oldest = this.ids.values().next().value; if (oldest) this.ids.delete(oldest); }
    if (this.closing && request.command !== "close") { this.failed(request, "CLOSED"); return Promise.resolve(); }
    if (request.command === "close") return this.close().then(() => {
      this.control(request, { ok: true, generation: this.coordinator?.snapshot().generation ?? 0 });
    }, () => { this.failed(request, "TEARDOWN_FAILED"); });
    if (request.command === "status") {
      this.publish(); this.control(request, { ok: true, generation: this.coordinator?.snapshot().generation ?? 0 }); return Promise.resolve();
    }
    if (this.busy && request.command !== "cancel") { this.failed(request, "BUSY"); return Promise.resolve(); }
    if (request.command !== "cancel") this.busy = true;
    const operation = Promise.resolve().then(async () => {
      if (this.closing) { this.failed(request, "CLOSED"); if (request.command !== "cancel") this.busy = false; return; }
      if (request.command === "cancel") {
        if (!this.coordinator) { this.failed(request, "UNAVAILABLE"); return; }
        await this.cancelPreservingStopped(); this.control(request, await this.coordinator.cancel()); return;
      }
      try {
        if (request.command === "configure") await this.configure(request);
        else if (request.command === "enumerate-sources") {
          if (this.coordinator?.snapshot().busy) { this.failed(request, "BUSY"); return; }
          const devices = await this.effects.enumerate(request);
          this.emit({ kind: "devices", id: request.id, devices });
        } else await this.action(request);
      } finally { this.busy = false; this.publish(); }
    }).catch(() => { this.failed(request, this.closing ? "CLOSED" : "UNAVAILABLE"); });
    this.operations.add(operation);
    void operation.then(() => { this.operations.delete(operation); }, () => { this.operations.delete(operation); });
    return operation;
  }
  private configure(request: RecordingConfiguration): Promise<void> {
    if (this.configuration || this.configuring) { this.failed(request, "BUSY"); return Promise.resolve(); }
    // Retain initialization before invoking effects; shutdown waits the same original operation.
    this.configuring = Promise.resolve().then(async () => {
      const prepared = await this.effects.prepare(request);
      if (this.closing) { this.failed(request, "CLOSED"); return; }
      this.recovery = prepared.recovery; this.configuration = request;
      const originalRecovery = prepared.recovery;
      const ensureCommitted = originalRecovery.ensureCommitted;
      const recovery: RecoveryBoundary = {
        latest: () => originalRecovery.latest(),
        save: (audio, context) => originalRecovery.save(audio, context),
        read: (token, context) => originalRecovery.read(token, context),
        ...(ensureCommitted ? { ensureCommitted: (token, context) => ensureCommitted.call(originalRecovery, token, context) } : {}),
        remove: async (token, context) => {
          // The main host retires only its exact issued receipt, after independently
          // checking the fixed private WAV is absent. Never acknowledge a failed remove.
          const removed = await originalRecovery.remove(token, context);
          if (removed.generation !== context.generation || removed.attempt !== context.attempt) {
            throw new CaptureRuntimeError("INVALID_FRAME");
          }
          // A cleanup retry may skip already-confirmed delivery. Authorize only
          // that actual issued delivery/replay, never the newer remove attempt.
          const issued = this.confirmedDelivery.get(token.id) ?? context;
          this.emit({ kind: "recovery-removed", token: token.id, generation: issued.generation, attempt: issued.attempt });
          this.confirmedDelivery.delete(token.id);
          return removed;
        },
      };
      this.coordinator = new RecordingCoordinator({ platform: "linux", capture: prepared.capture, recovery,
        clock: { now: () => performance.now() }, speechGate: new LinuxSpeechGate(), delivery: {
          deliver: async (text, context, identity) => {
            const receipt = await this.effects.delivery.deliver(text, context, identity);
            if (identity.kind === "recovery" && receipt.generation === context.generation && receipt.attempt === context.attempt
                && receipt.clipboardConfirmed && (receipt.outcome === "clipboard" || receipt.outcome === "paste")) {
              this.confirmedDelivery.set(identity.token, { generation: context.generation, attempt: context.attempt });
            }
            return receipt;
          },
        },
        speech: { transcribe: async (audio, selected, context) => {
          // Coordinator reaches this boundary only after stopped audio was privately saved.
          this.pastRecoverySave = true;
          if (this.halted || this.closing) {
            await this.coordinator?.cancel(); throw new CaptureRuntimeError("CLOSED");
          }
          const adaptive = new AdaptiveSpeechBoundary(createUtilitySpeechEffects({ gpuAvailable: false,
            infer: this.effects.infer(context), progress: (value) => { this.emit({ kind: "progress", ...value }); } }));
          return adaptive.transcribe(audio, selected, context);
        } },
      });
      await this.coordinator.restoreRecovery(request.request);
      this.timer = setInterval(() => { try { this.publish(); } catch { void this.close().catch(() => {}); } }, 100);
      this.timer.unref(); this.control(request, { ok: true, generation: this.coordinator.snapshot().generation });
    });
    void this.configuring.catch(() => {}); return this.configuring;
  }
  private async action(request: Action): Promise<void> {
    const coordinator = this.coordinator, configuration = this.configuration;
    if (!coordinator || !configuration) { this.failed(request, "UNAVAILABLE"); return; }
    switch (request.command) {
      case "start":
        this.halted = false; this.pastRecoverySave = false;
        await coordinator.start(configuration.request, { acknowledge: (reply) => this.control(request, reply) }); break;
      case "stop":
        await coordinator.stop((reply) => this.control(request, reply)); this.watchCompletion(); break;
      case "retry":
        this.halted = false; this.pastRecoverySave = false;
        this.control(request, coordinator.retry()); this.watchCompletion(); break;
      case "discard": this.control(request, await coordinator.discardRecovery()); break;
      case "cancel": case "status": case "close": break;
    }
  }
  private watchCompletion(): void {
    const work = this.coordinator?.completion(); if (!work) return;
    const publish = (): void => { try { this.publish(); } catch { void this.close().catch(() => {}); } };
    void work.then(publish, publish);
  }
  private async cancelPreservingStopped(): Promise<void> {
    const coordinator = this.coordinator; if (!coordinator) return;
    const completion = coordinator.completion(), snapshot = coordinator.snapshot(); this.halted = true;
    // Cancelling before preparation/save would lose the stopped recording at process exit.
    // Finish that owned transaction, then halt at the pre-inference boundary above.
    if (snapshot.recoveryAvailable && snapshot.busy && !this.pastRecoverySave) await completion;
    else { await coordinator.cancel(); await completion; }
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.halted = true;
    this.closeTask = Promise.resolve().then(async () => {
      await this.configuring?.catch(() => {});
      await this.cancelPreservingStopped();
      await Promise.all([...this.operations]);
      if (this.coordinator?.snapshot().busy) throw new CaptureRuntimeError("TEARDOWN_FAILED");
      // Never certify shutdown of unsaved retained RAM as preserved stopped audio.
      if (this.coordinator?.snapshot().recoveryAvailable && await this.recovery?.latest() === null) {
        throw new CaptureRuntimeError("TEARDOWN_FAILED");
      }
      await this.effects.close();
      this.publish(); this.closed = true; if (this.timer) clearInterval(this.timer);
    });
    void this.closeTask.catch(() => {}); return this.closeTask;
  }
}

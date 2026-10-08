import { z } from "zod";
import { RecordingCoordinator, type CaptureBoundary, type ControlReply, type DeliveryBoundary,
  type RecordingSnapshot, type WorkContext } from "../core/recording.js";
import { AdaptiveSpeechBoundary, createUtilitySpeechEffects } from "../services/adaptive-speech.js";
import type { NativeCapturedHandle } from "../services/capture.js";
import type { SpeechClient } from "../services/speech-client.js";
import { macRecordingHostReplySchema, macRecordingHostRequestSchema,
  type MacRecordingConfiguration, type MacRecordingHostReply, type MacRecordingHostRequest } from "./macos-recording-host-protocol.js";

export interface MacCaptureRuntimeEffects {
  /** Verify/load the fixed addon without creating an engine, querying TCC or opening capture. */
  prepare(configuration: MacRecordingConfiguration): Promise<CaptureBoundary<NativeCapturedHandle>>;
  infer(context: WorkContext): Pick<SpeechClient, "transcribeWindow">;
  readonly delivery: DeliveryBoundary;
  /** Retain original RPC/native cleanup until it actually settles. */
  close(): Promise<void>;
}
export class MacCaptureRuntimeError extends Error {
  constructor(readonly code: "INVALID_FRAME" | "TEARDOWN_FAILED" | "RECOVERY_PENDING" | "CLOSED") { super(`Recording host: ${code}.`); }
}
type LocalReply<T> = T extends unknown ? Omit<T, "version" | "channel" | "epoch"> : never;

/** Normal Mac recording ownership stays in the utility. Stopped audio never acquires a disk recovery boundary. */
export class MacCaptureRuntime {
  private readonly epoch: string;
  private coordinator: RecordingCoordinator<NativeCapturedHandle> | undefined;
  private configuration: MacRecordingConfiguration | undefined;
  private configuring: Promise<void> | undefined;
  private readonly operations = new Set<Promise<void>>();
  private readonly confirmedDelivery = new Map<number, Readonly<{ generation: number; attempt: number }>>();
  private readonly ids = new Set<string>();
  private busy = false;
  private closing = false;
  private closed = false;
  private closeTask: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private previous: RecordingSnapshot | undefined;
  private readonly send: (reply: MacRecordingHostReply) => void;
  private readonly effects: MacCaptureRuntimeEffects;
  constructor(options: { epoch: string; pid: number; send(reply: MacRecordingHostReply): void; effects: MacCaptureRuntimeEffects }) {
    this.epoch = z.uuid().parse(options.epoch);
    z.number().int().positive().max(0x7fffffff).parse(options.pid);
    this.send = options.send; this.effects = options.effects; this.emit({ kind: "ready", pid: options.pid });
  }
  private emit(value: LocalReply<MacRecordingHostReply>): void {
    this.send(macRecordingHostReplySchema.parse({ version: 1, channel: "recording-host", epoch: this.epoch, ...value }));
  }
  private publish(): void {
    const snapshot = this.coordinator?.snapshot(); if (!snapshot || this.closed) return;
    const old = this.previous;
    if (old && old.phase === snapshot.phase && old.generation === snapshot.generation && old.elapsedMs === snapshot.elapsedMs
      && old.level === snapshot.level && old.busy === snapshot.busy && old.recoveryAvailable === snapshot.recoveryAvailable
      && old.error === snapshot.error && old.transcript === snapshot.transcript) return;
    this.emit({ kind: "snapshot", snapshot }); this.previous = snapshot;
  }
  private control(request: MacRecordingHostRequest, reply: ControlReply): boolean {
    try { this.emit({ kind: "control", id: request.id, command: request.command, reply }); }
    catch { return false; }
    // A failed later snapshot cannot retract an already posted Stop acknowledgement.
    try { this.publish(); } catch { void this.close().catch(() => {}); }
    return true;
  }
  private failed(request: MacRecordingHostRequest, code: "BUSY" | "UNAVAILABLE" | "CLOSED" | "TEARDOWN_FAILED" | "RECOVERY_PENDING"): void {
    this.emit({ kind: "failed", id: request.id, code });
  }
  receive(input: unknown): Promise<void> {
    const parsed = macRecordingHostRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.epoch !== this.epoch || this.ids.has(parsed.data.id)) {
      return Promise.reject(new MacCaptureRuntimeError("INVALID_FRAME"));
    }
    const request = parsed.data; this.ids.add(request.id);
    if (this.ids.size > 256) { const oldest = this.ids.values().next().value; if (oldest) this.ids.delete(oldest); }
    if (this.closing && request.command !== "close") { this.failed(request, "CLOSED"); return Promise.resolve(); }
    if (request.command === "close") return this.close().then(() => {
      this.control(request, { ok: true, generation: this.coordinator?.snapshot().generation ?? 0 });
    }, (error: unknown) => {
      this.failed(request, error instanceof MacCaptureRuntimeError && error.code === "RECOVERY_PENDING" ? "RECOVERY_PENDING" : "TEARDOWN_FAILED");
    });
    if (request.command === "status") {
      this.publish(); this.control(request, { ok: true, generation: this.coordinator?.snapshot().generation ?? 0 }); return Promise.resolve();
    }
    if (this.busy && request.command !== "cancel") { this.failed(request, "BUSY"); return Promise.resolve(); }
    if (request.command !== "cancel") this.busy = true;
    const operation = Promise.resolve().then(async () => {
      if (this.closing) { this.failed(request, "CLOSED"); if (request.command !== "cancel") this.busy = false; return; }
      if (request.command === "cancel") {
        if (!this.coordinator) { this.failed(request, "UNAVAILABLE"); return; }
        const completion = this.coordinator.completion();
        const reply = await this.coordinator.cancel(); await completion; this.control(request, reply); return;
      }
      try {
        if (request.command === "configure") await this.configure(request);
        else await this.action(request);
      } finally { this.busy = false; this.publish(); }
    }).catch(() => { this.failed(request, this.closing ? "CLOSED" : "UNAVAILABLE"); });
    this.operations.add(operation);
    void operation.then(() => { this.operations.delete(operation); }, () => { this.operations.delete(operation); });
    return operation;
  }
  private configure(request: MacRecordingConfiguration): Promise<void> {
    if (this.configuration || this.configuring) { this.failed(request, "BUSY"); return Promise.resolve(); }
    this.configuring = Promise.resolve().then(async () => {
      const originalCapture = await this.effects.prepare(request);
      if (this.closing) { this.failed(request, "CLOSED"); return; }
      this.configuration = request;
      const capture: CaptureBoundary<NativeCapturedHandle> = { create: (callbacks) => {
        const session = originalCapture.create(callbacks), release = session.release;
        if (!release) throw new MacCaptureRuntimeError("TEARDOWN_FAILED");
        return { start: (signal) => session.start(signal), closeAndFence: () => session.closeAndFence(),
          prepare: (handle, context) => session.prepare(handle, context), release: async () => {
            await release.call(session);
            // Cleanup retry may skip an already-confirmed delivery. Release authorizes
            // only that actual issued context, after the original native release settles.
            const issued = this.confirmedDelivery.get(callbacks.generation);
            if (issued) { this.emit({ kind: "memory-released", ...issued }); this.confirmedDelivery.delete(callbacks.generation); }
          },
        };
      } };
      this.coordinator = new RecordingCoordinator({ platform: "macos", capture, clock: { now: () => performance.now() },
        delivery: { deliver: async (text, context, identity) => {
          const receipt = await this.effects.delivery.deliver(text, context, identity);
          if (identity.kind === "memory" && identity.generation === context.generation
              && receipt.generation === context.generation && receipt.attempt === context.attempt
              && ((receipt.clipboardConfirmed && (receipt.outcome === "clipboard" || receipt.outcome === "paste"))
                || (!receipt.clipboardConfirmed && receipt.outcome === "editor"))) {
            this.confirmedDelivery.set(context.generation, { generation: context.generation, attempt: context.attempt });
          }
          return receipt;
        } }, speech: { transcribe: (audio, selected, context) => {
          const adaptive = new AdaptiveSpeechBoundary(createUtilitySpeechEffects({ gpuAvailable: false,
            infer: this.effects.infer(context), progress: (value) => { this.emit({ kind: "progress", ...value }); } }));
          return adaptive.transcribe(audio, selected, context);
        } },
      });
      this.timer = setInterval(() => { try { this.publish(); } catch { void this.close().catch(() => {}); } }, 100);
      this.timer.unref(); this.control(request, { ok: true, generation: this.coordinator.snapshot().generation });
    });
    void this.configuring.catch(() => {}); return this.configuring;
  }
  private async action(request: Exclude<MacRecordingHostRequest, MacRecordingConfiguration>): Promise<void> {
    const coordinator = this.coordinator, configuration = this.configuration;
    if (!coordinator || !configuration) { this.failed(request, "UNAVAILABLE"); return; }
    switch (request.command) {
      case "start": await coordinator.start(configuration.request, { acknowledge: (reply) => this.control(request, reply) }); break;
      case "stop": await coordinator.stop((reply) => this.control(request, reply)); this.watchCompletion(); break;
      case "retry": this.control(request, coordinator.retry()); this.watchCompletion(); break;
      case "discard": this.control(request, await coordinator.discardRecovery()); break;
      case "cancel": case "status": case "close": break;
    }
  }
  private watchCompletion(): void {
    const work = this.coordinator?.completion(); if (!work) return;
    const publish = (): void => { try { this.publish(); } catch { void this.close().catch(() => {}); } };
    void work.then(publish, publish);
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    // A refused Quit must not make a stopped recording unretryable or discard its RAM.
    if (this.coordinator?.snapshot().recoveryAvailable) return Promise.reject(new MacCaptureRuntimeError("RECOVERY_PENDING"));
    this.closing = true;
    this.closeTask = Promise.resolve().then(async () => {
      await this.configuring?.catch(() => {});
      const completion = this.coordinator?.completion();
      await this.coordinator?.cancel(); await completion;
      await Promise.all([...this.operations]);
      if (this.coordinator?.snapshot().recoveryAvailable) throw new MacCaptureRuntimeError("RECOVERY_PENDING");
      if (this.coordinator?.snapshot().busy) throw new MacCaptureRuntimeError("TEARDOWN_FAILED");
      await this.effects.close(); this.publish(); this.closed = true;
      if (this.timer) clearInterval(this.timer);
    });
    void this.closeTask.catch((error: unknown) => {
      if (error instanceof MacCaptureRuntimeError && error.code === "RECOVERY_PENDING") {
        this.closing = false; this.closeTask = undefined;
      }
    });
    return this.closeTask;
  }
}

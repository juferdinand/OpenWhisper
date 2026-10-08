import { z } from "zod";
import type { DeliveryBoundary, DeliveryIdentity, DeliveryReceipt, WorkContext } from "../core/recording.js";
import type { RecordingInferenceClient, RecordingSpeechFactory } from "../services/recording-speech.js";
import type { SpeechModel } from "../workers/native-speech.js";
import { deliveryIdentitySchema, deliveryReceiptSchema, recordingEffectReplySchema,
  recordingEffectRequestSchema, RecordingEffectError, safeRecordingEffectError,
  type RecordingEffectFailureCode, type RecordingEffectReply, type RecordingEffectRequest,
} from "../workers/recording-effects-protocol.js";

type OperationRequest = Exclude<RecordingEffectRequest, { command: "cancel" }>;
type InferenceClient = RecordingInferenceClient;
type CommittedReceipt = Exclude<DeliveryReceipt, { outcome: "failed" }>;
type ReceiptEntry = { readonly reservation: string; readonly receipt?: CommittedReceipt };

/** Content-free receipts scoped by one running main/private profile, not durable app-restart state. */
export class DeliveryReceiptCache {
  private readonly entries = new Map<string, ReceiptEntry>();
  constructor(private readonly capacity = 128) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024) throw new RecordingEffectError("INVALID_FRAME");
  }
  private key(epoch: string, identity: DeliveryIdentity): string {
    z.uuid().parse(epoch); const parsed = deliveryIdentitySchema.parse(identity);
    return parsed.kind === "recovery" ? `recovery\0${parsed.token}` : `${epoch}\0memory\0${parsed.generation}`;
  }
  get(epoch: string, identity: DeliveryIdentity, context: WorkContext): DeliveryReceipt | undefined {
    const receipt = this.entries.get(this.key(epoch, identity))?.receipt;
    return receipt ? { ...receipt, generation: context.generation, attempt: context.attempt } : undefined;
  }
  reserve(epoch: string, identity: DeliveryIdentity, reservation: string): void {
    z.uuid().parse(reservation);
    const key = this.key(epoch, identity);
    // Unknown/confirmed commits cannot be evicted: their recovery file may still exist.
    if (this.entries.has(key) || this.entries.size === this.capacity) throw new RecordingEffectError("BUSY");
    this.entries.set(key, { reservation });
  }
  abandonFailed(epoch: string, identity: DeliveryIdentity, reservation: string): void {
    const key = this.key(epoch, identity); const entry = this.entries.get(key);
    if (!entry || entry.reservation !== reservation || entry.receipt) throw new RecordingEffectError("OWNERSHIP_FAILED");
    this.entries.delete(key);
  }
  remember(epoch: string, identity: DeliveryIdentity, receipt: CommittedReceipt, reservation: string): void {
    const key = this.key(epoch, identity);
    const checked = deliveryReceiptSchema.parse(receipt);
    if (checked.outcome === "failed") throw new RecordingEffectError("DELIVERY_FAILED");
    const entry = this.entries.get(key);
    if (!entry || entry.reservation !== reservation || entry.receipt) throw new RecordingEffectError("OWNERSHIP_FAILED");
    this.entries.set(key, Object.freeze({ reservation, receipt: Object.freeze(checked) }));
  }
}

interface CommonRecordingEffectOptions {
  readonly epoch: string;
  readonly platform: "linux" | "macos";
  readonly delivery: DeliveryBoundary;
  readonly receipts: DeliveryReceiptCache;
}
export type MainRecordingEffectOptions = CommonRecordingEffectOptions & (
  | { readonly speech: RecordingSpeechFactory; readonly createSpeech?: never; readonly approveModel?: never }
  /** Historical synchronous inert-fixture seam; actual composition uses speech.open. */
  | { readonly speech?: never; readonly createSpeech: () => InferenceClient;
      readonly approveModel: (model: SpeechModel) => boolean }
);
interface Pending {
  readonly request: OperationRequest;
  readonly controller: AbortController;
  completion: Promise<RecordingEffectReply | undefined>;
}

/** Main owns only bounded inference windows, final explicit output and native-helper supervision. */
export class MainRecordingEffects {
  private pending: Pending | undefined;
  private speech: InferenceClient | undefined;
  private fatal: RecordingEffectFailureCode | undefined;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  constructor(private readonly options: MainRecordingEffectOptions) { z.uuid().parse(options.epoch); }

  async handle(input: unknown): Promise<RecordingEffectReply | undefined> {
    const parsed = recordingEffectRequestSchema.safeParse(input);
    if (!parsed.success) throw new RecordingEffectError("INVALID_FRAME");
    const request = parsed.data;
    if (request.epoch !== this.options.epoch) throw new RecordingEffectError("OWNERSHIP_FAILED");
    if (request.command === "cancel") {
      const pending = this.pending;
      if (!pending || !this.same(pending.request, request)) throw new RecordingEffectError("OWNERSHIP_FAILED");
      pending.controller.abort();
      // The original operation supplies the sole reply after its cleanup or confirmed commit.
      return undefined;
    }
    if (this.fatal) return this.failed(request, this.fatal);
    if (this.closing) return this.failed(request, "CLOSED");
    if (this.pending) return this.failed(request, "BUSY");
    const pending: Pending = { request, controller: new AbortController(), completion: Promise.resolve(undefined) };
    this.pending = pending;
    pending.completion = Promise.resolve().then(() => this.execute(pending)).catch((error: unknown) =>
      this.failed(request, safeRecordingEffectError(error).code)).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    return pending.completion;
  }
  private same(left: RecordingEffectRequest, right: RecordingEffectRequest): boolean {
    return left.epoch === right.epoch && left.id === right.id
      && left.generation === right.generation && left.attempt === right.attempt;
  }
  private failed(request: OperationRequest, code: RecordingEffectFailureCode): RecordingEffectReply {
    return { version: 1, epoch: request.epoch, id: request.id, generation: request.generation,
      attempt: request.attempt, kind: "failed", code };
  }
  private async retire(client: InferenceClient): Promise<void> {
    try { await client.close(); }
    catch { this.fatal = "TEARDOWN_FAILED"; throw new RecordingEffectError("TEARDOWN_FAILED"); }
    if (this.speech === client) this.speech = undefined;
  }
  private async execute(pending: Pending): Promise<RecordingEffectReply> {
    const { request, controller } = pending;
    const context: WorkContext = { generation: request.generation, attempt: request.attempt, signal: controller.signal };
    const envelope = { version: 1, epoch: request.epoch, id: request.id, generation: request.generation, attempt: request.attempt };
    if (controller.signal.aborted) throw new RecordingEffectError("CANCELLED");
    if (request.command === "infer") {
      if (!this.options.speech && !this.options.approveModel(request.model)) throw new RecordingEffectError("OWNERSHIP_FAILED");
      let client = this.speech;
      if (!client) {
        try {
          client = this.options.speech ? await this.options.speech.open(request.model, controller.signal)
            : this.options.createSpeech();
          this.speech = client;
        } catch (error: unknown) {
          const checked = safeRecordingEffectError(error);
          if (checked.code === "TEARDOWN_FAILED") this.fatal = checked.code;
          throw checked;
        }
      }
      try {
        // A cancelled accepted opening may still return a real owner. Retire
        // that exact client before replying; never send a late inference.
        if (controller.signal.aborted) throw new RecordingEffectError("CANCELLED");
        const text = await client.transcribeWindow(request.model, request.samples, request.language, request.vocabulary, context.signal);
        if (controller.signal.aborted) throw new RecordingEffectError("CANCELLED");
        return recordingEffectReplySchema.parse({ ...envelope, kind: "infer", text });
      } catch (error: unknown) {
        // SpeechClient may reject cancellation before the native process exits. Reap before replying/reuse.
        await this.retire(client); throw safeRecordingEffectError(error);
      }
    }
    if (this.options.platform === "linux" && request.identity.kind !== "recovery") {
      throw new RecordingEffectError("OWNERSHIP_FAILED");
    }
    const cached = this.options.receipts.get(request.epoch, request.identity, context);
    if (cached) return recordingEffectReplySchema.parse({ ...envelope, kind: "deliver", receipt: cached });
    this.options.receipts.reserve(request.epoch, request.identity, request.id);
    const raw = await this.options.delivery.deliver(request.text, context, request.identity);
    const parsed = deliveryReceiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.generation !== context.generation || parsed.data.attempt !== context.attempt) {
      throw new RecordingEffectError("OWNERSHIP_FAILED");
    }
    const receipt = parsed.data;
    if (receipt.outcome === "editor" && this.options.platform !== "macos") throw new RecordingEffectError("DELIVERY_FAILED");
    if (receipt.outcome !== "failed") this.options.receipts.remember(request.epoch, request.identity, receipt, request.id);
    else this.options.receipts.abandonFailed(request.epoch, request.identity, request.id);
    // A late confirmed native delivery remains committed, even after cancellation or helper loss.
    return recordingEffectReplySchema.parse({ ...envelope, kind: "deliver", receipt });
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.pending?.controller.abort();
    this.closeTask = (async () => {
      await this.pending?.completion;
      if (this.speech) await this.retire(this.speech);
      if (this.fatal) throw new RecordingEffectError(this.fatal);
    })();
    return this.closeTask;
  }
}

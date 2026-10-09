import { z } from "zod";
import { preferencesSchema } from "../../contracts/ui/state.js";
import { speechModelSchema, type SpeechModel } from "../../workers/native-speech.js";
import { RecordingEffectError, safeRecordingEffectError } from "../../workers/recording-effects-protocol.js";
import type { BackendSpeechJob, BackendSupervisor } from "./backend-supervisor.js";
import { ModelInventoryError, type ModelInventory, type ModelLease } from "../models/model-inventory.js";
import type { SpeechClient } from "./speech-client.js";

export type RecordingInferenceClient = Pick<SpeechClient, "transcribeWindow" | "close">;
export interface RecordingSpeechFactory {
  open(model: SpeechModel, signal: AbortSignal): Promise<RecordingInferenceClient>;
}
const selectionSchema = z.strictObject({ id: preferencesSchema.shape.model, gpu: z.boolean() }).readonly();
interface Owner {
  acquisition?: Promise<ModelLease>;
  lease?: ModelLease;
  job?: BackendSpeechJob;
  jobClose?: Promise<void>;
  release?: Promise<void>;
  closing?: Promise<void>;
}
interface Gate {
  readonly inventory: ModelInventory;
  readonly acquire: ModelInventory["acquire"];
  readonly createJob: BackendSupervisor["createJob"];
  owner?: Owner;
  failed?: RecordingEffectError;
}
// The normal supervisor is retained by one continuing main. New helper epochs
// and factory/selection objects cannot bypass its earlier lease-close failure.
const gates = new WeakMap<BackendSupervisor, Gate>();

function failure(input: unknown): RecordingEffectError {
  if (input instanceof ModelInventoryError) {
    return new RecordingEffectError(input.code === "CANCELLED" ? "CANCELLED"
      : input.code === "RELEASE_FAILED" ? "TEARDOWN_FAILED" : "OWNERSHIP_FAILED");
  }
  return safeRecordingEffectError(input);
}
function matches(model: SpeechModel, lease: ModelLease): boolean {
  return model.path === lease.model.path && model.family === lease.model.family
    && (!model.gpu || lease.model.gpu);
}
function active(signal: AbortSignal): void {
  if (signal.aborted) throw new RecordingEffectError("CANCELLED");
}

/** Main-only composition; dependencies and selection are never supplied by IPC.
 * No acquisition, process, native module or inference runs during construction. */
export function createInventoryRecordingSpeechFactory(options: {
  readonly inventory: ModelInventory;
  readonly supervisor: BackendSupervisor;
  readonly selection: unknown;
}): RecordingSpeechFactory {
  const selected = selectionSchema.safeParse(options.selection);
  if (!selected.success || typeof options.supervisor !== "object" || options.supervisor === null) {
    throw new RecordingEffectError("OWNERSHIP_FAILED");
  }
  const selection = selected.data;
  let gate = gates.get(options.supervisor);
  if (gate && gate.inventory !== options.inventory) throw new RecordingEffectError("OWNERSHIP_FAILED");
  if (!gate) {
    gate = { inventory: options.inventory, acquire: options.inventory.acquire.bind(options.inventory),
      createJob: options.supervisor.createJob.bind(options.supervisor) };
    gates.set(options.supervisor, gate);
  }
  const shared = gate;
  function retire(owner: Owner): Promise<void> {
    if (owner.closing) return owner.closing;
    // Retain the adapter operation before invoking even a synchronously
    // refusing/reentrant host close. Pass its original promise to the lease.
    owner.closing = Promise.resolve().then(async () => {
      // createJob only constructs policy. Without a returned job no prepare or
      // inference was invoked, so this is pre-process completion, not OS proof.
      let original: Promise<void>;
      try { original = owner.job ? owner.job.close() : Promise.resolve(); }
      catch { original = Promise.reject(new RecordingEffectError("TEARDOWN_FAILED")); }
      owner.jobClose = original;
      void original.catch(() => {});
      try {
        if (owner.lease) {
          owner.release = owner.lease.release(original);
          await owner.release;
        }
        else await original;
      } catch {
        shared.failed ??= new RecordingEffectError("TEARDOWN_FAILED");
        throw shared.failed;
      }
      if (shared.owner !== owner) {
        shared.failed ??= new RecordingEffectError("TEARDOWN_FAILED");
        throw shared.failed;
      }
      delete shared.owner;
    });
    void owner.closing.catch(() => {});
    return owner.closing;
  }
  return Object.freeze({ async open(input: SpeechModel, signal: AbortSignal): Promise<RecordingInferenceClient> {
    if (shared.failed) throw shared.failed;
    if (shared.owner) throw new RecordingEffectError("BUSY");
    const parsed = speechModelSchema.safeParse(input);
    if (!parsed.success || !(signal instanceof AbortSignal) || (parsed.data.gpu && !selection.gpu)) {
      throw new RecordingEffectError("OWNERSHIP_FAILED");
    }
    active(signal);
    const owner: Owner = {}; shared.owner = owner;
    try {
      // Accepted acquisition stays owned even when cancellation precedes its
      // resolution. Do not race it against an abort/timeout and forget a lease.
      owner.acquisition = shared.acquire(selection.id, { gpu: selection.gpu });
      owner.lease = await owner.acquisition;
      active(signal);
      if (!matches(parsed.data, owner.lease)) throw new RecordingEffectError("OWNERSHIP_FAILED");
      owner.job = shared.createJob(owner.lease);
      const lease = owner.lease, job = owner.job;
      return Object.freeze({
        async transcribeWindow(model, samples, language, vocabulary, nextSignal) {
          if (owner.closing || shared.owner !== owner) throw new RecordingEffectError("CLOSED");
          if (shared.failed) throw shared.failed;
          const checked = speechModelSchema.safeParse(model);
          if (!checked.success || !matches(checked.data, lease)) throw new RecordingEffectError("OWNERSHIP_FAILED");
          try { return await job.transcribeWindow(checked.data, samples, language, vocabulary, nextSignal); }
          catch (error: unknown) { throw failure(error); }
        },
        close: () => retire(owner),
      } satisfies RecordingInferenceClient);
    } catch (error: unknown) {
      await retire(owner);
      throw failure(error);
    }
  } });
}

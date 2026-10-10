import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { SpeechAllocation, type SpeechAllocationToken } from "../../core/speech/allocation.js";
import { speechLanguageSchema, speechModelSchema, speechVocabularySchema, speechWindowSchema,
  type SpeechModel } from "../../workers/speech/native-speech.js";
import { SpeechClient, SpeechWorkerError, type SpeechChannel, type SpeechFailureCode } from "./speech-client.js";
import { resourceBackendSchema, type ResourceBackend, type VerifiedSpeechResource } from "./speech-resources.js";
import type { ModelLease } from "../models/model-inventory.js";

const pidSchema = z.number().int().positive().max(0x7fff_ffff);
const uidSchema = z.number().int().nonnegative().max(0xffff_fffe);
const hostSchema = z.strictObject({ platform: z.enum(["linux", "darwin"]), architecture: z.enum(["x64", "arm64"]),
  uid: uidSchema, parentPid: pidSchema }).readonly();
const deadlinesSchema = z.strictObject({ startupMs: z.number().int().min(1).max(8000).default(8000),
  requestMs: z.number().int().min(1).max(600_000).default(600_000), cleanupMs: z.number().int().min(1).max(8000).default(8000) }).readonly();
const birthSchema = z.discriminatedUnion("platform", [
  z.strictObject({ platform: z.literal("linux"), startTicks: z.bigint().positive().max((1n << 64n) - 1n) }).readonly(),
  z.strictObject({ platform: z.literal("darwin"), seconds: z.bigint().nonnegative().max((1n << 63n) - 1n),
    micros: z.number().int().nonnegative().max(999_999) }).readonly(),
]);
export const backendIdentitySchema = z.strictObject({ pid: pidSchema, uid: uidSchema,
  parentPid: pidSchema, epoch: z.string().uuid(), birth: birthSchema }).readonly();
export type BackendIdentity = z.infer<typeof backendIdentitySchema>;
const levelSchema = z.enum(["running", "non-running", "reaped", "ambiguous"]);
export const backendObservationSchema = z.strictObject({ level: levelSchema, identity: backendIdentitySchema.nullable() }).readonly();
const initialSchema = z.strictObject({ level: levelSchema, identity: backendIdentitySchema.nullable(), canAdmit: z.boolean() }).readonly();
export const backendChallengeSchema = z.strictObject({ version: z.literal(1), epoch: z.string().uuid(),
  nonce: z.string().uuid(), pid: pidSchema }).readonly();
const resourceSchema = z.strictObject({ backend: resourceBackendSchema,
  path: z.string().min(1).max(4096).refine((value) => isAbsolute(value) && value.endsWith(".node") && !value.includes("\0")),
  bytes: z.number().int().positive().max(512 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).readonly();

export interface RetirementBoundary {
  readonly initial: unknown;
  readonly current: Readonly<{ level: "running" | "non-running" | "reaped" | "ambiguous" }>;
  observe(signal: AbortSignal): Promise<unknown>;
  waitForRetirement(signal: AbortSignal): Promise<void>;
  settleReads(): Promise<void>;
}
export interface ProvisionalBackendOwner {
  /** From the original returned child object, never from a worker reply. */
  readonly pid: number;
  readonly channel: SpeechChannel;
  challenge(nonce: string, epoch: string, signal: AbortSignal): Promise<unknown>;
  bindRetirement(epoch: string, signal: AbortSignal): Promise<RetirementBoundary>;
}
export type OpenBackendResult = Readonly<{ kind: "not-created"; code: "START_FAILED" }> |
  Readonly<{ kind: "owner"; owner: ProvisionalBackendOwner }>;
export interface BackendEffects {
  verify(backend: ResourceBackend): Promise<unknown>;
  open(resource: VerifiedSpeechResource, epoch: string, signal: AbortSignal): Promise<OpenBackendResult>;
}
export interface BackendBindings {
  readonly host: z.infer<typeof hostSchema>;
  /** Host-only identity of the immutable catalog captured by verify; not itself
   * an authenticity proof. A renderer must never construct these bindings. */
  readonly catalog: object;
  readonly effects: BackendEffects;
  readonly deadlines?: z.input<typeof deadlinesSchema>;
}
export interface BackendSelection {
  readonly backend: ResourceBackend;
  readonly requestedGpu: boolean;
  readonly gpu: boolean;
  /** Capability category. The optional name is returned only for a selected physical device. */
  readonly detection: "none" | "software" | "device" | "unavailable";
  readonly gpuDevice?: string;
}
export type BackendLease = Pick<ModelLease, "model" | "validate">;
export interface BackendSpeechJob {
  prepare(signal?: AbortSignal): Promise<BackendSelection>;
  transcribeWindow(model: SpeechModel, samples: Float32Array, language: string, vocabulary: string, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
export interface BackendSupervisor {
  createJob(lease: BackendLease): BackendSpeechJob;
  /** Bounded no-model capability check. Implementations may omit it in test adapters. */
  discoverGpu?(): Promise<BackendSelection>;
}
export class BackendSupervisorError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "BACKEND_UNAVAILABLE") { super(`Backend supervisor: ${code}.`); }
}

type Host = z.infer<typeof hostSchema>;
type Deadlines = z.infer<typeof deadlinesSchema>;
interface Context {
  readonly token: SpeechAllocationToken;
  readonly epoch: string;
  readonly startup: AbortController;
  transaction?: Promise<void>;
  verification?: Promise<unknown>;
  validation?: Promise<void>;
  resource?: VerifiedSpeechResource;
  openAttempted: boolean;
  notCreated: boolean;
  invalidAdmission: boolean;
  admitted: boolean;
  owner?: ProvisionalBackendOwner;
  witness?: RetirementBoundary;
  candidate?: BackendIdentity;
  client?: SpeechClient;
  selection?: BackendSelection;
  retirement?: Promise<void>;
}
function worker(code: SpeechFailureCode): SpeechWorkerError { return new SpeechWorkerError(code); }
function active(signal?: AbortSignal): void { if (signal?.aborted) throw worker("CANCELLED"); }
function sameIdentity(left: BackendIdentity, right: BackendIdentity): boolean {
  if (left.pid !== right.pid || left.uid !== right.uid || left.parentPid !== right.parentPid || left.epoch !== right.epoch ||
      left.birth.platform !== right.birth.platform) return false;
  if (left.birth.platform === "linux" && right.birth.platform === "linux") return left.birth.startTicks === right.birth.startTicks;
  return left.birth.platform === "darwin" && right.birth.platform === "darwin" &&
    left.birth.seconds === right.birth.seconds && left.birth.micros === right.birth.micros;
}
function ownerShape(value: unknown): value is ProvisionalBackendOwner {
  if (typeof value !== "object" || value === null || !("pid" in value) || !pidSchema.safeParse(value.pid).success ||
      !("challenge" in value) || typeof value.challenge !== "function" || !("bindRetirement" in value) ||
      typeof value.bindRetirement !== "function" || !("channel" in value)) return false;
  const channel = value.channel;
  return typeof channel === "object" && channel !== null && "send" in channel && typeof channel.send === "function" &&
    "onMessage" in channel && typeof channel.onMessage === "function" && "onExit" in channel && typeof channel.onExit === "function" &&
    "terminate" in channel && typeof channel.terminate === "function";
}
const openResultSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("not-created"), code: z.literal("START_FAILED") }),
  z.strictObject({ kind: z.literal("owner"), owner: z.custom<ProvisionalBackendOwner>(ownerShape) })]);
const eligible: ReadonlySet<SpeechFailureCode> = new Set(["START_FAILED", "WORKER_FAILED", "TIMEOUT"]);

/** The original operation is always observed and retained. Deadlines do not
 * imply effect rollback, process death, or actual descriptor closure. */
function bounded<T>(operation: Promise<T>, ms: number, code: SpeechFailureCode, signal?: AbortSignal,
  onDeadline?: () => void): Promise<T> {
  return new Promise<T>((accept, reject) => {
    let settled = false;
    const deadline = performance.now() + ms;
    const finish = (effect: () => void): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); effect();
    };
    const abort = (): void => finish(() => { reject(worker("CANCELLED")); });
    const expired = (error?: unknown): void => { onDeadline?.(); reject(error instanceof SpeechWorkerError &&
      (error.code === "INTEGRITY_FAILED" || error.code === "TEARDOWN_FAILED") ? error : worker(code)); };
    const timer = setTimeout(() => { finish(() => { expired(); }); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    void operation.then((value) => { finish(() => { if (performance.now() >= deadline) expired(); else accept(value); }); },
      (error: unknown) => { finish(() => { if (performance.now() >= deadline) expired(error); else reject(error); }); });
  });
}

class MainBackendSupervisor implements BackendSupervisor {
  private readonly allocation = new SpeechAllocation();
  private readonly effects: BackendEffects;
  private gpuDiscovery?: Promise<BackendSelection>;
  constructor(readonly host: Host, readonly catalog: object, effects: BackendEffects, readonly deadlines: Deadlines) {
    this.effects = Object.freeze({ verify: effects.verify.bind(effects), open: effects.open.bind(effects) });
  }
  createJob(lease: BackendLease): BackendSpeechJob {
    this.allocation.check();
    const parsed = speechModelSchema.safeParse(lease.model);
    if (!parsed.success || typeof lease.validate !== "function") throw new BackendSupervisorError("INVALID_INPUT");
    const model = Object.freeze(parsed.data);
    let current: Context | undefined, busy = false, closed = false;
    let operation: Promise<unknown> | undefined, controller: AbortController | undefined, closing: Promise<void> | undefined;
    const execute = <T>(effect: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
      try { this.allocation.check(); } catch (error: unknown) { return Promise.reject(error); }
      if (closed) return Promise.reject(worker("CLOSED"));
      if (busy) return Promise.reject(worker("BUSY"));
      if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(new BackendSupervisorError("INVALID_INPUT"));
      if (signal?.aborted) return Promise.reject(worker("CANCELLED"));
      busy = true; const own = new AbortController(); controller = own;
      const abort = (): void => { own.abort(); }; signal?.addEventListener("abort", abort, { once: true });
      const result = Promise.resolve().then(() => { active(own.signal); return effect(own.signal); })
        .finally(() => { busy = false; signal?.removeEventListener("abort", abort); if (controller === own) controller = undefined; });
      operation = result; void result.catch(() => {}); return result;
    };
    const ensure = async (requestedGpu: boolean, signal: AbortSignal): Promise<Context> => {
      active(signal); this.allocation.check();
      if (current && (current.retirement || current.selection?.requestedGpu !== requestedGpu)) {
        await this.closeContext(current); current = undefined;
      }
      if (current) {
        const existing = current;
        existing.validation = this.allocation.retain(Promise.resolve().then(() => lease.validate()));
        const validation = this.allocation.retain(existing.validation.catch(() => {
          throw this.allocation.poison("INTEGRITY_FAILED", existing.validation);
        }));
        try { await bounded(validation, this.deadlines.startupMs, "TIMEOUT", signal); }
        catch (error: unknown) {
          if (error instanceof SpeechWorkerError && (error.code === "CANCELLED" || error.code === "TIMEOUT")) {
            void this.closeContext(existing).catch(() => {}); throw error;
          }
          throw this.allocation.poison("INTEGRITY_FAILED", existing.validation);
        }
        active(signal); return existing;
      }
      if (requestedGpu && this.host.platform === "darwin") throw new BackendSupervisorError("BACKEND_UNAVAILABLE");
      let detection: BackendSelection["detection"] = "none";
      if (requestedGpu) {
        const gpu = this.openContext("vulkan", () => lease.validate()); current = gpu;
        try {
          await this.admitContext(gpu, signal);
          const device = await this.client(gpu).gpuDevice(signal);
          active(signal);
          if (device !== null && (device.trim().length === 0 || /\p{Cc}/u.test(device))) throw worker("INVALID_REPLY");
          detection = device === null ? "none" : /\b(?:lavapipe|llvmpipe|swiftshader|software|cpu)\b/iu.test(device) ? "software" : "device";
          if (detection === "device") {
            const gpuDevice = device && device.trim().length <= 256 ? device.trim() : undefined;
            gpu.selection = Object.freeze({ backend: "vulkan", requestedGpu, gpu: true, detection,
              ...(gpuDevice ? { gpuDevice } : {}) }); return gpu;
          }
        } catch (error: unknown) {
          if (error instanceof SpeechWorkerError && (error.code === "INTEGRITY_FAILED" || error.code === "TEARDOWN_FAILED")) throw error;
          if (error instanceof SpeechWorkerError && error.code === "CANCELLED") {
            void this.closeContext(gpu).catch(() => {}); throw error;
          }
          // No replacement is permitted until this owner and its read FDs retire.
          await this.closeContext(gpu); current = undefined;
          if (!(error instanceof SpeechWorkerError) || !eligible.has(error.code)) throw error;
          active(signal); detection = "unavailable";
        }
        if (current) { await this.closeContext(gpu); current = undefined; }
      }
      active(signal); const cpu = this.openContext("cpu", () => lease.validate()); current = cpu;
      try {
        await this.admitContext(cpu, signal);
        cpu.selection = Object.freeze({ backend: "cpu", requestedGpu, gpu: false, detection });
        return cpu;
      } catch (error: unknown) {
        if (!(error instanceof SpeechWorkerError) || (error.code !== "INTEGRITY_FAILED" && error.code !== "TEARDOWN_FAILED")) {
          // Cancellation rejects promptly; close/new work still waits on this gate.
          void this.closeContext(cpu).catch(() => {});
        }
        throw error;
      }
    };
    return Object.freeze({
      prepare: (signal?: AbortSignal) => execute(async (own) => {
        const selected = (await ensure(model.gpu, own)).selection;
        if (!selected) throw worker("INTEGRITY_FAILED"); return selected;
      }, signal),
      transcribeWindow: (input: SpeechModel, samples: Float32Array, language: string, vocabulary: string, signal?: AbortSignal) =>
        execute(async (own) => {
          const requested = speechModelSchema.safeParse(input);
          if (!requested.success || requested.data.path !== model.path || requested.data.family !== model.family ||
              (requested.data.gpu && !model.gpu) || !speechWindowSchema.safeParse(samples).success ||
              !speechLanguageSchema.safeParse(language).success || !speechVocabularySchema.safeParse(vocabulary).success) {
            throw new BackendSupervisorError("INVALID_INPUT");
          }
          const context = await ensure(requested.data.gpu, own), selected = context.selection;
          if (!selected) throw worker("INTEGRITY_FAILED");
          // Adaptive coverage owns inference retries. Exactly one window is sent.
          return this.client(context).transcribeWindow({ ...model, gpu: selected.gpu }, samples, language,
            model.family === "parakeet" ? "" : vocabulary, own);
        }, signal),
      close: () => {
        if (closing) return closing;
        closed = true; controller?.abort();
        closing = (async () => { await operation?.catch(() => {}); if (current) await this.closeContext(current); })();
        void closing.catch(() => {}); return closing;
      },
    });
  }
  discoverGpu(): Promise<BackendSelection> {
    if (this.host.platform !== "linux" || this.host.architecture !== "x64") {
      return Promise.reject(new BackendSupervisorError("BACKEND_UNAVAILABLE"));
    }
    this.gpuDiscovery ??= this.discoverGpuOnce();
    return this.gpuDiscovery;
  }
  private async discoverGpuOnce(): Promise<BackendSelection> {
    let context: Context | undefined;
    let detection: BackendSelection["detection"] = "unavailable";
    let gpuDevice: string | undefined;
    try {
      context = this.openContext("vulkan", async () => {});
      await this.admitContext(context, context.startup.signal);
      const device = await bounded(this.client(context).gpuDevice(context.startup.signal), this.deadlines.startupMs,
        "TIMEOUT", context.startup.signal, () => context?.startup.abort());
      if (device !== null && (device.trim().length === 0 || /\p{Cc}/u.test(device))) throw worker("INVALID_REPLY");
      detection = device === null ? "none" : /\b(?:lavapipe|llvmpipe|swiftshader|software|cpu)\b/iu.test(device) ? "software" : "device";
      if (detection === "device" && device && device.trim().length <= 256) gpuDevice = device.trim();
    } catch (error: unknown) {
      if (error instanceof SpeechWorkerError && (error.code === "INTEGRITY_FAILED" || error.code === "TEARDOWN_FAILED" || error.code === "CANCELLED")) {
        if (context) await this.closeContext(context);
        throw error;
      }
      if (!(error instanceof SpeechWorkerError) || !eligible.has(error.code)) {
        if (context) await this.closeContext(context);
        throw error;
      }
      detection = "unavailable";
    }
    if (context) await this.closeContext(context);
    return Object.freeze({ backend: detection === "device" ? "vulkan" : "cpu", requestedGpu: true,
      gpu: detection === "device", detection, ...(gpuDevice ? { gpuDevice } : {}) });
  }
  private openContext(backend: ResourceBackend, validate: () => Promise<void>): Context {
    const epoch = randomUUID(), token = this.allocation.reserve(epoch);
    const context: Context = { token, epoch, startup: new AbortController(), openAttempted: false, notCreated: false, invalidAdmission: false, admitted: false };
    this.allocation.attach(token, context);
    context.transaction = this.allocation.retain(Promise.resolve().then(async () => {
      context.validation = this.allocation.retain(Promise.resolve().then(validate));
      try { await context.validation; }
      catch { throw this.allocation.poison("INTEGRITY_FAILED", context.validation); }
      active(context.startup.signal);
      context.verification = this.allocation.retain(Promise.resolve().then(() => this.effects.verify(backend)));
      let value: unknown;
      try { value = await context.verification; }
      catch (error: unknown) {
        throw this.allocation.poison(error instanceof SpeechWorkerError && error.code === "TEARDOWN_FAILED" ? "TEARDOWN_FAILED" : "INTEGRITY_FAILED", context.verification);
      }
      const resource = resourceSchema.safeParse(value);
      if (!resource.success || resource.data.backend !== backend) throw this.allocation.poison("INTEGRITY_FAILED", context.verification);
      context.resource = resource.data;
      active(context.startup.signal);
      context.openAttempted = true;
      let raw: OpenBackendResult;
      try { raw = await this.effects.open(resource.data, epoch, context.startup.signal); }
      catch (error: unknown) {
        throw this.allocation.poison(error instanceof SpeechWorkerError && error.code === "INTEGRITY_FAILED" ? "INTEGRITY_FAILED" : "TEARDOWN_FAILED", context.transaction);
      }
      const result = openResultSchema.safeParse(raw);
      if (!result.success) throw this.allocation.poison("TEARDOWN_FAILED", context.transaction);
      if (result.data.kind === "not-created") { context.notCreated = true; throw worker("START_FAILED"); }
      context.owner = result.data.owner;
      await this.confirm(context, context.startup.signal);
    }));
    return context;
  }
  private async challenge(context: Context, signal: AbortSignal): Promise<void> {
    const owner = context.owner; if (!owner) throw worker("TEARDOWN_FAILED");
    const nonce = randomUUID();
    const reply = backendChallengeSchema.safeParse(await owner.challenge(nonce, context.epoch, signal));
    if (!reply.success || reply.data.nonce !== nonce || reply.data.epoch !== context.epoch || reply.data.pid !== owner.pid) {
      context.invalidAdmission = true; throw this.allocation.poison("INTEGRITY_FAILED", context.transaction);
    }
  }
  private identity(context: Context, identity: BackendIdentity): void {
    if (identity.pid !== context.owner?.pid || identity.uid !== this.host.uid || identity.parentPid !== this.host.parentPid ||
        identity.epoch !== context.epoch || identity.birth.platform !== this.host.platform) {
      context.invalidAdmission = true; throw this.allocation.poison("INTEGRITY_FAILED", context.transaction);
    }
  }
  private async bind(context: Context, signal: AbortSignal): Promise<RetirementBoundary> {
    if (!context.owner) throw worker("TEARDOWN_FAILED");
    context.witness ??= await context.owner.bindRetirement(context.epoch, signal);
    const initial = initialSchema.safeParse(context.witness.initial);
    if (!initial.success || initial.data.level === "ambiguous") throw worker("TEARDOWN_FAILED");
    if (initial.data.identity) {
      this.identity(context, initial.data.identity);
      context.candidate ??= initial.data.identity;
      if (!sameIdentity(context.candidate, initial.data.identity)) throw worker("TEARDOWN_FAILED");
    }
    if (initial.data.level === "running") {
      if (!initial.data.canAdmit || !initial.data.identity) throw worker("TEARDOWN_FAILED");
    } else if (initial.data.canAdmit) throw worker("TEARDOWN_FAILED");
    return context.witness;
  }
  private async observe(context: Context, signal: AbortSignal): Promise<z.infer<typeof backendObservationSchema>> {
    const witness = context.witness; if (!witness) throw worker("TEARDOWN_FAILED");
    const observed = backendObservationSchema.safeParse(await witness.observe(signal));
    if (!observed.success || observed.data.level === "ambiguous") throw worker("TEARDOWN_FAILED");
    if (observed.data.level !== "reaped") {
      if (!observed.data.identity || !context.candidate || !sameIdentity(context.candidate, observed.data.identity)) throw worker("TEARDOWN_FAILED");
    }
    return observed.data;
  }
  private async confirm(context: Context, signal: AbortSignal): Promise<void> {
    await this.challenge(context, signal);
    const witness = await this.bind(context, signal);
    if (initialSchema.parse(witness.initial).level !== "running") throw worker("WORKER_FAILED");
    // A second fresh original-channel nonce immediately precedes the final
    // matching running observation. Neither first stat nor ready admits work.
    await this.challenge(context, signal);
    if ((await this.observe(context, signal)).level !== "running") throw worker("WORKER_FAILED");
  }
  private async admitContext(context: Context, signal: AbortSignal): Promise<void> {
    const transaction = context.transaction; if (!transaction) throw worker("TEARDOWN_FAILED");
    try { await bounded(transaction, this.deadlines.startupMs, "TIMEOUT", signal, () => { context.startup.abort(); }); }
    catch (error: unknown) {
      context.startup.abort();
      if (error instanceof SpeechWorkerError && (error.code === "INTEGRITY_FAILED" || error.code === "TEARDOWN_FAILED")) {
        throw this.allocation.poison(error.code, transaction);
      }
      throw error;
    }
    active(signal); this.allocation.admit(context.token);
    // This latch never resets and belongs to this exact original process only.
    context.admitted = true;
  }
  private client(context: Context): SpeechClient {
    if (context.client) return context.client;
    const owner = context.owner; if (!owner || !context.candidate) throw worker("TEARDOWN_FAILED");
    let transferred = false;
    const channel: SpeechChannel = {
      send: (value) => { owner.channel.send(value); },
      onMessage: (listener) => owner.channel.onMessage(listener),
      onExit: (listener) => owner.channel.onExit(listener),
      terminate: () => this.retireContext(context),
    };
    context.client = new SpeechClient(async () => {
      if (transferred || context.retirement) throw worker("TEARDOWN_FAILED");
      transferred = true; return channel;
    }, { startupMs: this.deadlines.startupMs, requestMs: this.deadlines.requestMs, teardownMs: this.deadlines.cleanupMs });
    return context.client;
  }
  private retireContext(context: Context): Promise<void> {
    if (context.retirement) return context.retirement;
    const cleanup = new AbortController();
    const actual = this.allocation.retain(Promise.resolve().then(async () => {
      await context.transaction?.catch(() => {});
      await context.validation?.catch(() => {});
      this.allocation.check();
      const owner = context.owner;
      if (!owner) {
        if (context.openAttempted && !context.notCreated) throw worker("TEARDOWN_FAILED");
        return; // Completed verification or explicit trusted no-owner rollback.
      }
      if (context.invalidAdmission) throw worker("TEARDOWN_FAILED");
      const witness = await this.bind(context, cleanup.signal);
      let observation = await this.observe(context, cleanup.signal);
      if (observation.level === "running") {
        // A synchronous native call can block helper JS. An already admitted
        // owner retains its two-nonce original-channel binding; fresh kernel
        // identity, not another JS response, gates its original-handle cleanup.
        if (!context.admitted) {
          await this.challenge(context, cleanup.signal);
          observation = await this.observe(context, cleanup.signal);
          if (observation.level === "running") await this.challenge(context, cleanup.signal);
        }
        observation = await this.observe(context, cleanup.signal);
        if (observation.level === "running") await owner.channel.terminate();
      }
      // Z/non-running and already absent owners never receive a signal.
      await witness.waitForRetirement(cleanup.signal);
      if ((await this.observe(context, cleanup.signal)).level !== "reaped") throw worker("TEARDOWN_FAILED");
      await witness.settleReads();
      if (z.strictObject({ level: levelSchema }).parse(witness.current).level !== "reaped") throw worker("TEARDOWN_FAILED");
    }));
    context.retirement = this.allocation.retire(context.token, () => bounded(actual, this.deadlines.cleanupMs, "TEARDOWN_FAILED", undefined,
      () => { cleanup.abort(); context.startup.abort(); }));
    void context.retirement.catch(() => {}); return context.retirement;
  }
  private async closeContext(context: Context): Promise<void> {
    const closed = context.client?.close(); if (closed) void this.allocation.retain(closed);
    await this.retireContext(context);
    // The older client's generic exit/shutdown result cannot release this
    // allocation. Its wrapped terminate is the full OS/read gate above. Late
    // ordinary listener/factory completion remains observed and can never open
    // another owner through this context's one-transfer-only factory.
  }
}

let main: { readonly facade: MainBackendSupervisor; readonly effects: BackendEffects } | undefined;
/** Pure host-only facade. No production channel/native adapter is wired yet.
 * One continuing main allocation survives every job; there is no reset API. */
export function initializeBackendSupervisor(bindings: BackendBindings): BackendSupervisor {
  const host = hostSchema.safeParse(bindings.host), deadlines = deadlinesSchema.safeParse(bindings.deadlines ?? {});
  if (!host.success || !deadlines.success || host.data.uid !== process.getuid?.() || host.data.parentPid !== process.pid ||
      typeof bindings.catalog !== "object" || bindings.catalog === null || !Object.isFrozen(bindings.catalog) ||
      typeof bindings.effects.verify !== "function" || typeof bindings.effects.open !== "function") throw new BackendSupervisorError("INVALID_INPUT");
  if (main) {
    const existing = main.facade;
    if (main.effects !== bindings.effects || existing.catalog !== bindings.catalog ||
        existing.host.platform !== host.data.platform || existing.host.architecture !== host.data.architecture || existing.host.uid !== host.data.uid ||
        existing.host.parentPid !== host.data.parentPid || existing.deadlines.startupMs !== deadlines.data.startupMs ||
        existing.deadlines.requestMs !== deadlines.data.requestMs || existing.deadlines.cleanupMs !== deadlines.data.cleanupMs) throw worker("INTEGRITY_FAILED");
    return existing;
  }
  const facade = new MainBackendSupervisor(host.data, bindings.catalog, bindings.effects, deadlines.data);
  main = { facade, effects: bindings.effects }; return facade;
}

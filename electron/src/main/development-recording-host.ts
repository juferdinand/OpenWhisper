import { session, utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import type { RecordingRequest } from "../core/recording.js";
import { initializeBackendSupervisor, type BackendSupervisor, type RetirementBoundary } from "../services/backend-supervisor.js";
import { prepareLinuxSpeechRetirement, type LinuxSpeechRetirementAllocation } from "../services/linux-speech-retirement.js";
import type { ModelInventory } from "../services/model-inventory.js";
import { createInventoryRecordingSpeechFactory } from "../services/recording-speech.js";
import { prepareSpeechResources } from "../services/speech-resources.js";
import { prepareSpeechEntryGraph } from "../services/speech-entry-graph.js";
import { verifyDevelopmentCaptureArtifact, verifyDevelopmentCaptureEntry,
  verifyDevelopmentMacCaptureArtifact, verifyDevelopmentMacCaptureEntry } from "../services/development-artifact.js";
import { recordingHostReplySchema, recordingHostRequestSchema,
  type RecordingHostReply, type RecordingHostRequest, type RecordingSource } from "../workers/recording-host-protocol.js";
import { recordingEffectRequestSchema } from "../workers/recording-effects-protocol.js";
import { createLinuxSpeechBindings, speechEnvironment } from "./linux-speech-host.js";
import type { DevelopmentRecordingDescriptor } from "./development-recording-descriptor.js";
import { DeliveryReceiptCache, MainRecordingEffects } from "./recording-effects.js";
import type { DeliveryBoundary } from "../core/recording.js";
import { macRecordingHostRequestSchema } from "../workers/macos-recording-host-protocol.js";
import { createMacChildRetirementAllocator, createMacSpeechBindings, macSpeechEnvironment, type MacChildRetirementAllocation } from "./macos-speech-host.js";

type SnapshotReply = Extract<RecordingHostReply, { kind: "snapshot" }>;
type ProgressReply = Extract<RecordingHostReply, { kind: "progress" }>;
type Reply = Extract<RecordingHostReply, { kind: "control" | "devices" | "failed" }>;
type Command = RecordingHostRequest["command"];
export interface RecordingIdentity { readonly epoch: string; readonly generation: number }
type RetirementAllocation = LinuxSpeechRetirementAllocation | MacChildRetirementAllocation;
interface Pending { readonly accept: (reply: Reply) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }
interface Owner {
  readonly child: UtilityProcess; readonly epoch: string; readonly requests: Map<string, Pending>;
  readonly spawned: Promise<number>; readonly ready: Promise<number>;
  readonly effects: MainRecordingEffects | undefined;
  readonly acknowledgements: Set<Promise<void>>;
  snapshot?: SnapshotReply["snapshot"];
  allocation?: RetirementAllocation; boundary?: RetirementBoundary; generation: number;
  closing?: Promise<void>; failed?: Error; exited: boolean;
}
const fail = (code = "Recording could not complete.") => new Error(code);
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fail()), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Only an owned local session socket; no inherited TCP or Pulse autospawn. */
export async function developmentPulseServer(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const runtime = environment.XDG_RUNTIME_DIR;
  const uid = process.getuid?.();
  if (uid === undefined || !runtime || !isAbsolute(runtime) || resolve(runtime) !== runtime || runtime.includes("\0")) throw fail();
  const root = await lstat(runtime);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== uid || (root.mode & 0o7777) !== 0o700) throw fail();
  const server = environment.PULSE_SERVER ?? `unix:${join(runtime, "pulse/native")}`;
  if (!server.startsWith("unix:")) throw fail();
  const path = server.slice(5);
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0") || !path.startsWith(`${runtime}${sep}`)) throw fail();
  const socket = await lstat(path);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid) throw fail();
  return server;
}

/** Normal main-owned Dev recording. Original children and the continuing pool are retained. */
export class DevelopmentRecordingHost {
  private owner: Owner | undefined;
  private fatal: Error | undefined;
  private readonly receipts = new DeliveryReceiptCache();
  private closed = false;
  private constructor(private readonly root: string, private readonly descriptor: DevelopmentRecordingDescriptor,
    private readonly inventory: ModelInventory, private readonly supervisor: BackendSupervisor,
    private readonly prepareRetirement: (pid: number, epoch: string) => RetirementAllocation,
    private readonly options: { readonly recoveryPath: string; readonly delivery: DeliveryBoundary;
      readonly snapshot: (snapshot: SnapshotReply["snapshot"]) => void; readonly progress: (progress: ProgressReply) => void }) {}

  static async open(root: string, descriptor: DevelopmentRecordingDescriptor, inventory: ModelInventory,
    options: DevelopmentRecordingHost["options"]): Promise<DevelopmentRecordingHost> {
    if (process.type !== "browser" || descriptor.platform !== process.platform || descriptor.architecture !== process.arch) throw fail();
    const resources = await prepareSpeechResources(join(root, "dist"), descriptor.speech);
    const graph = await prepareSpeechEntryGraph(root, descriptor.speechEntryGraph);
    const mac = descriptor.platform === "darwin"
      ? await createMacChildRetirementAllocator({ root, retirement: descriptor.retirement }) : undefined;
    const bindings = descriptor.platform === "darwin"
      ? await createMacSpeechBindings(resources, graph, { root, retirement: descriptor.retirement })
      : await createLinuxSpeechBindings(resources, graph);
    const supervisor = initializeBackendSupervisor(bindings);
    return new DevelopmentRecordingHost(root, descriptor, inventory, supervisor,
      mac ? (pid, epoch) => mac.prepare(pid, epoch) : prepareLinuxSpeechRetirement, options);
  }
  private async allocate(selection?: { readonly id: string; readonly request: RecordingRequest }): Promise<Owner> {
    if (this.closed || this.fatal || this.owner) throw this.fatal ?? fail();
    const mac = this.descriptor.platform === "darwin";
    const [entry] = await Promise.all([
      (mac ? verifyDevelopmentMacCaptureEntry : verifyDevelopmentCaptureEntry)(this.root, this.descriptor.captureEntry),
      (mac ? verifyDevelopmentMacCaptureArtifact : verifyDevelopmentCaptureArtifact)(this.root, this.descriptor.capture)]);
    if (this.closed || this.fatal || this.owner) throw this.fatal ?? fail();
    const epoch = randomUUID();
    const effects = selection ? new MainRecordingEffects({ epoch, platform: mac ? "macos" : "linux", receipts: this.receipts,
      delivery: this.options.delivery, speech: createInventoryRecordingSpeechFactory({ inventory: this.inventory,
        supervisor: this.supervisor, selection: { id: selection.id, gpu: false } }) }) : undefined;
    let acceptSpawn!: (pid: number) => void, rejectSpawn!: (error: Error) => void;
    const spawned = new Promise<number>((accept, reject) => { acceptSpawn = accept; rejectSpawn = reject; });
    let acceptReady!: (pid: number) => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<number>((accept, reject) => { acceptReady = accept; rejectReady = reject; });
    void spawned.catch(() => {}); void ready.catch(() => {});
    const child = utilityProcess.fork(entry, [epoch], { serviceName: "OpenWhisper Dev Capture", execArgv: [], stdio: "ignore",
      allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false, session: session.defaultSession,
      env: (mac ? macSpeechEnvironment : speechEnvironment)(process.env) });
    // Retain immediately, before constructing transport/listeners or awaiting startup.
    const owner: Owner = { child, epoch, effects, requests: new Map(), acknowledgements: new Set(), spawned, ready, exited: false, generation: 0 };
    this.owner = owner;
    child.on("error", () => { owner.failed ??= fail(); rejectSpawn(owner.failed); rejectReady(owner.failed); });
    child.once("spawn", () => {
      const pid = child.pid;
      if (!pid) { rejectSpawn(fail()); return; }
      try { owner.allocation = this.prepareRetirement(pid, epoch); acceptSpawn(pid); }
      catch { owner.failed ??= fail(); rejectSpawn(owner.failed); }
    });
    child.once("exit", () => {
      owner.exited = true; rejectSpawn(fail()); rejectReady(fail());
      for (const pending of owner.requests.values()) { clearTimeout(pending.timer); pending.reject(fail()); }
      owner.requests.clear();
      if (!owner.closing) { owner.failed ??= fail(); this.options.snapshot({ ...owner.snapshot, phase: "error",
        generation: owner.snapshot?.generation ?? 0, elapsedMs: owner.snapshot?.elapsedMs ?? 0, level: 0,
        busy: false, recoveryAvailable: owner.snapshot?.recoveryAvailable ?? false,
        error: "CAPTURE_FAILED", transcript: owner.snapshot?.transcript ?? "" }); }
    });
    child.on("message", (input: unknown) => {
      const host = recordingHostReplySchema.safeParse(input);
      if (host.success) {
        const reply = host.data;
        if (reply.epoch !== epoch) { owner.failed ??= fail(); rejectReady(owner.failed); return; }
        if (reply.kind === "ready") { if (reply.pid !== child.pid) rejectReady(fail()); else acceptReady(reply.pid); return; }
        if (reply.kind === "snapshot") { owner.snapshot = reply.snapshot; owner.generation = Math.max(owner.generation, reply.snapshot.generation);
          if (!owner.closing) this.options.snapshot(reply.snapshot); return; }
        if (reply.kind === "progress") { if (!owner.closing) this.options.progress(reply); return; }
        if (reply.kind === "recovery-removed") {
          if (this.descriptor.platform !== "linux") { owner.failed ??= fail(); return; }
          const acknowledgement = this.confirmRemoval(owner, reply);
          owner.acknowledgements.add(acknowledgement);
          void acknowledgement.then(() => owner.acknowledgements.delete(acknowledgement), () => { owner.failed ??= fail(); });
          return;
        }
        if (reply.kind === "memory-released") {
          if (this.descriptor.platform !== "darwin") { owner.failed ??= fail(); return; }
          this.receipts.retireConfirmedMemoryRelease(owner.epoch, { generation: reply.generation, attempt: reply.attempt });
          return;
        }
        const pending = owner.requests.get(reply.id);
        if (!pending) { owner.failed ??= fail(); return; }
        if (reply.kind === "control") owner.generation = Math.max(owner.generation, reply.reply.generation);
        clearTimeout(pending.timer); owner.requests.delete(reply.id); pending.accept(reply); return;
      }
      const effect = recordingEffectRequestSchema.safeParse(input);
      if (!effect.success || !effects || effect.data.epoch !== epoch) { owner.failed ??= fail(); rejectReady(owner.failed); return; }
      void effects.handle(effect.data).then((reply) => { if (reply && !owner.exited) child.postMessage(reply); }, () => { owner.failed ??= fail(); });
    });
    try {
      const [pid, announced] = await bounded(Promise.all([spawned, ready]), 10_000);
      if (pid !== announced || !owner.allocation) throw fail();
      owner.boundary = await bounded(owner.allocation.bind(AbortSignal.timeout(8_000)), 8_000);
      const admission = z.object({ level: z.literal("running"), canAdmit: z.literal(true),
        identity: z.object({ pid: z.literal(pid), parentPid: z.literal(process.pid), uid: z.literal(process.getuid?.() ?? -1), epoch: z.literal(epoch) }) }).parse(owner.boundary.initial);
      if (admission.identity.pid !== child.pid || owner.failed) throw fail();
      return owner;
    } catch (error: unknown) { await this.retire(owner).catch(() => {}); throw error; }
  }
  private request(owner: Owner, input: unknown, milliseconds = 20_000): Promise<Reply> {
    if (owner.exited || owner.failed) return Promise.reject(owner.failed ?? fail());
    const schema = this.descriptor.platform === "darwin" ? macRecordingHostRequestSchema : recordingHostRequestSchema;
    const id = randomUUID(), frame = schema.parse({ version: 1, channel: "recording-host", epoch: owner.epoch, id,
      ...(typeof input === "object" && input !== null ? input : {}) });
    if ((this.closed || owner.closing) && frame.command !== "close") return Promise.reject(fail());
    return new Promise<Reply>((accept, reject) => {
      const pending: Pending = { accept, reject, timer: setTimeout(() => { owner.failed ??= fail(); reject(owner.failed); }, milliseconds) };
      owner.requests.set(id, pending);
      try { owner.child.postMessage(frame); } catch { owner.failed ??= fail(); clearTimeout(pending.timer); reject(owner.failed); }
    });
  }
  private async confirmRemoval(owner: Owner, reply: Extract<RecordingHostReply, { kind: "recovery-removed" }>): Promise<void> {
    const directory = this.options.recoveryPath, stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.()
      || (stats.mode & 0o7777) !== 0o700 || await realpath(directory) !== directory) throw fail();
    try { await lstat(join(directory, `recording-${reply.token}.wav`)); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      // An explicit discard may have no committed receipt; it authorizes no cache deletion.
      this.receipts.retireConfirmedRemoval(owner.epoch, { kind: "recovery", token: reply.token },
        { generation: reply.generation, attempt: reply.attempt });
      return;
    }
    throw fail();
  }
  async enumerate(server: string): Promise<readonly RecordingSource[]> {
    if (this.descriptor.platform !== "linux") return [];
    if (this.owner && !this.owner.failed && !this.owner.exited) {
      const reply = await this.request(this.owner, { command: "enumerate-sources", capture: this.descriptor.capture, server });
      if (reply.kind !== "devices") throw fail(); return reply.devices;
    }
    if (this.owner) await this.retire(this.owner);
    const owner = await this.allocate();
    try {
      const reply = await this.request(owner, { command: "enumerate-sources", capture: this.descriptor.capture, server });
      if (reply.kind !== "devices") throw fail(); return reply.devices;
    } finally { await this.retire(owner); }
  }
  isConfigured(): boolean { return !!this.owner?.effects && !this.owner.exited && !this.owner.failed && !this.owner.closing; }
  currentIdentity(): RecordingIdentity | undefined {
    const owner = this.owner;
    return owner && this.isConfigured() ? Object.freeze({ epoch: owner.epoch, generation: owner.generation }) : undefined;
  }
  async configure(input: { readonly id: string; readonly request: RecordingRequest; readonly server?: string; readonly source?: string }): Promise<void> {
    if (this.owner) await this.retire(this.owner);
    const owner = await this.allocate(input);
    try {
      const reply = await this.request(owner, { command: "configure", capture: this.descriptor.capture, request: input.request,
        ...(this.descriptor.platform === "linux" ? { server: input.server, source: input.source, recoveryPath: this.options.recoveryPath } : {}) });
      if (reply.kind !== "control" || !reply.reply.ok) throw fail();
    } catch (error: unknown) { await this.retire(owner); throw error; }
  }
  async command(command: Exclude<Command, "configure" | "enumerate-sources">, expected?: RecordingIdentity): Promise<RecordingIdentity> {
    const owner = this.owner;
    if (!owner) throw fail();
    if (expected && (owner.epoch !== expected.epoch || owner.generation !== expected.generation)) throw fail("Recording owner changed.");
    try {
      const reply = await this.request(owner, { command });
      if (reply.kind !== "control" || !reply.reply.ok) throw fail();
      return Object.freeze({ epoch: owner.epoch, generation: reply.reply.generation });
    } catch (error: unknown) {
      if (owner.failed || owner.exited) await this.retire(owner);
      throw error;
    }
  }
  private retire(owner: Owner): Promise<void> {
    if (owner.closing) return owner.closing;
    if (this.descriptor.platform === "darwin" && !owner.exited && owner.snapshot?.recoveryAvailable) {
      return Promise.reject(fail("Retry or discard the stopped recording before closing."));
    }
    owner.closing = Promise.resolve().then(async () => {
      const effectClose = owner.effects?.close();
      void effectClose?.catch(() => {});
      let refused = !owner.exited && !!owner.failed;
      if (!owner.exited && !owner.failed) {
        try {
          const reply = await this.request(owner, { command: "close" }, 25_000);
          if (reply.kind !== "control" || !reply.reply.ok) refused = true;
        } catch { refused = true; }
      }
      try { await effectClose; } catch { refused = true; }
      await Promise.all(owner.acknowledgements);
      if (!owner.boundary && owner.allocation) owner.boundary = await owner.allocation.bind(AbortSignal.timeout(8_000));
      const boundary = owner.boundary;
      if (!boundary) throw fail();
      const cleanup = AbortSignal.timeout(8_000), observation = z.object({ level: z.enum(["running", "non-running", "reaped", "ambiguous"]) }).parse(await boundary.observe(cleanup));
      if (observation.level === "ambiguous") throw fail();
      // A failed close may still own stopped audio in RAM. Keep that exact worker alive.
      if (refused && observation.level === "running") throw fail();
      if (observation.level === "running" && !owner.child.kill()) {
        const after = z.object({ level: z.enum(["running", "non-running", "reaped", "ambiguous"]) }).parse(await boundary.observe(cleanup));
        if (after.level !== "non-running" && after.level !== "reaped") throw fail();
      }
      await boundary.waitForRetirement(cleanup); await boundary.settleReads();
      if (boundary.current.level !== "reaped") throw fail();
      if (this.descriptor.platform === "darwin") this.receipts.retireMemoryEpoch(owner.epoch);
      for (const pending of owner.requests.values()) { clearTimeout(pending.timer); pending.reject(fail()); }
      owner.requests.clear(); owner.child.removeAllListeners();
      if (refused) throw fail();
      if (this.owner === owner) this.owner = undefined;
    }).catch(() => { this.fatal ??= fail(); throw this.fatal; });
    void owner.closing.catch(() => {}); return owner.closing;
  }
  async close(): Promise<void> {
    if (this.descriptor.platform === "darwin" && !this.owner?.exited && this.owner?.snapshot?.recoveryAvailable) {
      throw fail("Retry or discard the stopped recording before closing.");
    }
    if (this.owner) await this.retire(this.owner);
    this.closed = true;
  }
}

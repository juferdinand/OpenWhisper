import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { z } from "zod";

const pid = z.number().int().min(1).max(0x7fff_ffff);
const uid = z.number().int().min(1).max(0x7fff_ffff);
const macProcessRecordSchema = z.strictObject({ kind: z.literal("record"), pid, parentPid: pid,
  uid, realUid: uid, savedUid: uid, state: z.enum(["idle", "running", "sleeping", "stopped", "zombie"]),
  seconds: z.bigint().min(1n).max((1n << 64n) - 1n), micros: z.bigint().min(0n).max(999999n) }).readonly();
export const macProcessSnapshotSchema = z.discriminatedUnion("kind", [macProcessRecordSchema,
  z.strictObject({ kind: z.literal("absent") }).readonly(),
  z.strictObject({ kind: z.literal("failure"), category: z.enum(["SYSCALL_FAILED", "ACCESS_REFUSED", "SHORT_RECORD", "INVALID_RECORD", "SYNTHETIC_ONLY"]) }).readonly()]);
const flags = { watched: z.boolean(), exitSeen: z.boolean(), cloexec: z.boolean() };
const observationSchema = z.strictObject({ second: macProcessSnapshotSchema, ...flags }).readonly();
const bindSchema = z.strictObject({ first: macProcessSnapshotSchema, second: macProcessSnapshotSchema, ...flags }).readonly();
const launchSchema = z.strictObject({ pid, uid, parentPid: pid, epoch: z.string().uuid() }).readonly();
const optionsSchema = z.strictObject({ deadlineMs: z.number().int().min(1).max(8000).default(8000),
  pollMs: z.number().int().min(1).max(250).default(20) }).readonly();
const nonceSchema = z.strictObject({ kind: z.literal("nonce"), epoch: z.string().uuid(), nonce: z.string().uuid() });

export type MacProcessRecord = z.infer<typeof macProcessRecordSchema>;
type Launch = z.infer<typeof launchSchema>;
type MacRetirementLevel = "running" | "non-running" | "reaped";
export interface MacRetirementObservation { readonly level: MacRetirementLevel }
export interface MacInitialObservation extends MacRetirementObservation {
  readonly canAdmit: boolean;
  readonly identity: MacProcessRecord | null;
}
export class MacRetirementError extends Error {
  readonly code = "TEARDOWN_FAILED";
  constructor() { super("Process retirement: TEARDOWN_FAILED."); this.name = "MacRetirementError"; }
}
/** Closed host-only effect. The actual adapter captures pid from its original
 * UtilityProcess at spawn; no helper frame or renderer supplies a target. */
export interface MacTrustedUtility {
  readonly pid: number | undefined;
  challenge(nonce: string, epoch: string, signal: AbortSignal): Promise<unknown>;
}
/** Injected only by pure tests or the fixed owned main fixture, never via IPC. */
export interface MacRetirementNative {
  create(pid: number, uid: number, parentPid: number): object;
  bindCandidate(owner: object): Promise<unknown>;
  observe(owner: object): Promise<unknown>;
  close(owner: object): Promise<void>;
}
export interface MacProbeNative extends MacRetirementNative {
  probeState(owner: object): unknown;
  holdNext(owner: object, automaticReleaseMs: number): void;
  releaseBarrier(owner: object): void;
  sdk(): unknown;
}
export interface MacProbeHost {
  readonly uid: number;
  readonly parentPid: number;
  readonly now?: () => number;
}
function failure(): never { throw new MacRetirementError(); }
function sameBirth(left: MacProcessRecord, right: MacProcessRecord): boolean {
  return left.pid === right.pid && left.seconds === right.seconds && left.micros === right.micros;
}
function owned(record: MacProcessRecord, launch: Launch): void {
  if (record.pid !== launch.pid || record.parentPid !== launch.parentPid ||
    record.uid !== launch.uid || record.realUid !== launch.uid || record.savedUid !== launch.uid) failure();
}

/** Pure classification after original-channel binding. NOTE_EXIT and zombie
 * retain the full-reap gate. A changed birth never authorizes acting on its PID. */
export function classifyMacRetirement(identity: MacProcessRecord, input: unknown, exitSeen: boolean): MacRetirementObservation {
  const parsed = macProcessSnapshotSchema.safeParse(input); if (!parsed.success) failure();
  const current = parsed.data;
  if (current.kind === "failure") failure();
  if (current.kind === "absent") return Object.freeze({ level: "reaped" });
  if (current.pid !== identity.pid) failure();
  if (!sameBirth(current, identity)) return Object.freeze({ level: "reaped" });
  if (current.uid !== identity.uid || current.realUid !== identity.realUid || current.savedUid !== identity.savedUid ||
    current.parentPid !== identity.parentPid) failure();
  return Object.freeze({ level: current.state === "zombie" || exitSeen ? "non-running" : "running" });
}

/** Standalone probe only. A close receipt proves observer disposal, not child
 * reaping. Continuing application reservations remain a later integration gate. */
export class OwnedMacRetirementProbe {
  private readonly owner: object;
  private readonly launch: Launch;
  private readonly options: z.infer<typeof optionsSchema>;
  private readonly now: () => number;
  private pending: Promise<unknown> | undefined;
  private nativeClosing: Promise<void> | undefined;
  private poisoned = false;
  private identity: MacProcessRecord | undefined;
  private bound = false;
  private retired = false;
  private started = false;
  constructor(private readonly native: MacRetirementNative, private readonly utility: MacTrustedUtility,
    epoch: string, host: MacProbeHost, options: unknown = {}) {
    const launch = launchSchema.safeParse({ pid: utility.pid, uid: host.uid, parentPid: host.parentPid, epoch });
    const limits = optionsSchema.safeParse(options);
    if (!launch.success || !limits.success || limits.data.pollMs > limits.data.deadlineMs) failure();
    this.launch = launch.data; this.options = limits.data; this.now = host.now ?? performance.now.bind(performance);
    // Synchronous owner acquisition precedes every asynchronous operation.
    try { this.owner = native.create(this.launch.pid, this.launch.uid, this.launch.parentPid); } catch { failure(); }
  }
  private async bounded<T>(promise: Promise<T>, signal: AbortSignal | undefined, milliseconds: number): Promise<T> {
    const until = this.now() + milliseconds;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        abort = () => { this.poisoned = true; reject(new MacRetirementError()); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, milliseconds);
      });
      const result = await Promise.race([promise, deadline]);
      // Timer callbacks may be delayed behind the microtask that delivered this
      // reply. Elapsed monotonic time, not timer ordering, decides acceptance.
      if (this.now() >= until || signal?.aborted) { this.poisoned = true; failure(); }
      return result;
    } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
  }
  private async operation(effect: () => Promise<unknown>, signal?: AbortSignal, milliseconds = this.options.deadlineMs): Promise<unknown> {
    if (this.poisoned || this.pending || this.nativeClosing || signal?.aborted || milliseconds <= 0) failure();
    const work = Promise.resolve().then(() => {
      if (this.poisoned || this.nativeClosing || signal?.aborted) failure();
      return effect();
    });
    this.pending = work;
    // Observe the same late operation even after deadline/abort. No replacement
    // query is queued and no stale result mutates identity or a later generation.
    void work.then(() => { if (this.pending === work) this.pending = undefined; }, () => {
      this.poisoned = true; if (this.pending === work) this.pending = undefined;
    });
    try {
      const result = await this.bounded(work, signal, milliseconds);
      if (this.poisoned || this.nativeClosing || signal?.aborted) failure();
      return result;
    } catch { this.poisoned = true; failure(); }
  }
  async bind(signal?: AbortSignal): Promise<MacInitialObservation> {
    if (this.started) failure(); this.started = true;
    try {
      const reply = bindSchema.parse(await this.operation(() => this.native.bindCandidate(this.owner), signal));
      if (reply.first.kind === "failure" || reply.second.kind === "failure") failure();
      if (reply.first.kind === "absent") {
        if (reply.second.kind !== "absent" || reply.watched || reply.exitSeen || reply.cloexec) failure();
        this.retired = true; return Object.freeze({ level: "reaped", canAdmit: false, identity: null });
      }
      owned(reply.first, this.launch);
      if (reply.second.kind === "absent") {
        this.retired = true; return Object.freeze({ level: "reaped", canAdmit: false, identity: null });
      }
      owned(reply.second, this.launch);
      if (!sameBirth(reply.first, reply.second)) failure();
      if (reply.second.state === "zombie" || reply.exitSeen) {
        return Object.freeze({ level: "non-running", canAdmit: false, identity: null });
      }
      if (!reply.watched || !reply.cloexec) failure();
      const controller = new AbortController();
      const abort = (): void => { controller.abort(); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const nonce = randomUUID();
      try {
        const challenge = nonceSchema.parse(await this.operation(() => this.utility.challenge(nonce, this.launch.epoch, controller.signal), signal));
        if (challenge.nonce !== nonce || challenge.epoch !== this.launch.epoch) failure();
      } finally { controller.abort(); signal?.removeEventListener("abort", abort); }
      const final = observationSchema.parse(await this.operation(() => this.native.observe(this.owner), signal));
      if (!final.watched || !final.cloexec) failure();
      const observation = classifyMacRetirement(reply.first, final.second, final.exitSeen);
      this.identity = reply.first; this.bound = true; this.retired = observation.level === "reaped";
      return Object.freeze({ ...observation, canAdmit: observation.level === "running", identity: this.identity });
    } catch { this.poisoned = true; failure(); }
  }
  private async sample(signal: AbortSignal | undefined, milliseconds: number): Promise<MacRetirementObservation> {
    if (!this.bound || !this.identity) failure();
    const reply = observationSchema.safeParse(await this.operation(() => this.native.observe(this.owner), signal, milliseconds));
    if (!reply.success || !reply.data.watched || !reply.data.cloexec) { this.poisoned = true; failure(); }
    try {
      const result = classifyMacRetirement(this.identity, reply.data.second, reply.data.exitSeen);
      if (result.level === "reaped") this.retired = true;
      return result;
    } catch { this.poisoned = true; failure(); }
  }
  observe(signal?: AbortSignal): Promise<MacRetirementObservation> {
    if (this.retired && !this.poisoned && !this.nativeClosing) return Promise.resolve(Object.freeze({ level: "reaped" }));
    return this.sample(signal, this.options.deadlineMs);
  }
  async waitForFullReap(signal?: AbortSignal): Promise<void> {
    const until = this.now() + this.options.deadlineMs;
    for (;;) {
      if (signal?.aborted || this.poisoned || this.nativeClosing) failure();
      if (this.retired) return;
      const remaining = until - this.now(); if (remaining <= 0) { this.poisoned = true; failure(); }
      if ((await this.sample(signal, Math.ceil(remaining))).level === "reaped") return;
      await new Promise<void>((accept) => { setTimeout(accept, Math.min(this.options.pollMs, Math.max(1, until - this.now()))); });
    }
  }
  async close(signal?: AbortSignal): Promise<void> {
    this.poisoned = true;
    if (!this.nativeClosing) {
      const pending = this.pending;
      this.nativeClosing = Promise.allSettled([Promise.resolve().then(() => this.native.close(this.owner)), ...(pending ? [pending] : [])])
        .then((results) => { if (results[0]?.status !== "fulfilled") failure(); });
      void this.nativeClosing.catch(() => { /* The same failed close remains owned. */ });
    }
    try { await this.bounded(this.nativeClosing, signal, this.options.deadlineMs); } catch { failure(); }
  }
  /** Test-only atomic evidence; it cannot query a PID or expose a descriptor. */
  probeState(native: MacProbeNative): unknown { if (native !== this.native) failure(); return native.probeState(this.owner); }
  holdNext(native: MacProbeNative, automaticReleaseMs = 0): void { if (native !== this.native) failure(); native.holdNext(this.owner, automaticReleaseMs); }
  releaseBarrier(native: MacProbeNative): void { if (native !== this.native) failure(); native.releaseBarrier(this.owner); }
}

/** Fixed owned probe resource only, not a production loader or IPC capability. */
export async function loadOwnedMacRetirementProbe(distribution: string): Promise<MacProbeNative> {
  if (process.platform !== "darwin" || process.type !== "browser" || !isMainThread || process.getuid?.() === 0 ||
    process.env["GITHUB_ACTIONS"] !== "true" || process.env["OPENWHISPER_OWNED_MAC_RETIREMENT_TEST"] !== "1" ||
    !isAbsolute(distribution) || distribution.includes("\0") || await realpath(distribution) !== resolve(distribution)) failure();
  const path = join(distribution, "native/openwhisper_macos_retirement_probe.node");
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || await realpath(path) !== path || file.uid !== process.getuid?.() || (file.mode & 0o022) !== 0) failure();
  const raw: unknown = createRequire(import.meta.url)(path);
  if (!raw || typeof raw !== "object") failure();
  const call = (name: string, args: readonly unknown[]): unknown => {
    const method: unknown = Reflect.get(raw, name); if (typeof method !== "function") failure();
    return Reflect.apply(method, raw, args);
  };
  for (const name of ["create", "bindCandidate", "observe", "close", "probeState", "holdNext", "releaseBarrier", "sdk"]) {
    if (typeof Reflect.get(raw, name) !== "function") failure();
  }
  const promise = (name: string, owner: object): Promise<unknown> => {
    const value = call(name, [owner]); if (!(value instanceof Promise)) failure(); return value;
  };
  return Object.freeze({ create: (processId: number, user: number, parent: number) => {
    const value = call("create", [processId, user, parent]); if (!value || typeof value !== "object") failure(); return value;
  }, bindCandidate: async (owner: object) => promise("bindCandidate", owner), observe: async (owner: object) => promise("observe", owner),
  close: async (owner: object) => { if (await promise("close", owner) !== undefined) failure(); }, probeState: (owner: object) => call("probeState", [owner]),
  holdNext: (owner: object, automatic: number) => { call("holdNext", [owner, automatic]); },
  releaseBarrier: (owner: object) => { call("releaseBarrier", [owner]); }, sdk: () => call("sdk", []) });
}

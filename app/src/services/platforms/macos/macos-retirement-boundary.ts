import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { BackendIdentity, RetirementBoundary } from "../../speech/backend-supervisor.js";
import { MacRetirementError, macProcessSnapshotSchema } from "./macos-process-retirement.js";
import type { MacProcessRecord } from "./macos-process-retirement.js";

const abiSchema = z.strictObject({ version: z.literal(1), role: z.literal("production"), napiVersion: z.literal(8),
  mainOnly: z.literal(true), zombieLookupArgument: z.literal(1), probeOnly: z.literal(false) }).readonly();
const pid = z.number().int().positive().max(0x7fff_ffff);
const launchSchema = z.strictObject({ pid, uid: pid, parentPid: pid, epoch: z.string().uuid() }).readonly();
const limitsSchema = z.strictObject({ deadlineMs: z.number().int().min(1).max(8000).default(8000),
  pollMs: z.number().int().min(1).max(250).default(20) }).readonly();
const flags = { watched: z.boolean(), exitSeen: z.boolean(), cloexec: z.boolean() };
const bindSchema = z.strictObject({ first: macProcessSnapshotSchema, second: macProcessSnapshotSchema, ...flags }).readonly();
const observeSchema = z.strictObject({ second: macProcessSnapshotSchema, ...flags }).readonly();
type Launch = z.infer<typeof launchSchema>;
type Flags = Pick<z.infer<typeof observeSchema>, "watched" | "exitSeen" | "cloexec">;
type Level = RetirementBoundary["current"]["level"];
interface Initial { readonly level: Level; readonly identity: BackendIdentity | null; readonly canAdmit: boolean }
export interface MacKernelRetirementNative {
  create(pid: number, uid: number, parentPid: number): object;
  bindCandidate(owner: object): Promise<unknown>;
  observe(owner: object): Promise<unknown>;
  close(owner: object): Promise<void>;
}
function fail(): never { throw new MacRetirementError(); }

/** Captures methods from an already verified fixed production artifact. This
 * validates its ABI only: it does not authenticate, locate or load a module.
 * A later main-only initializer must provide the fixed artifact capability. */
export function captureMacKernelRetirementNative(input: unknown): MacKernelRetirementNative {
  try {
    if (input === null || typeof input !== "object") fail();
    const names = ["create", "bindCandidate", "observe", "close", "abi"];
    const keys = Reflect.ownKeys(input);
    if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key))) fail();
    const method = (name: string): ((...args: unknown[]) => unknown) => {
      const value: unknown = Reflect.get(input, name); if (typeof value !== "function") fail();
      return (...args) => Reflect.apply(value, input, args);
    };
    const create = method("create"), bind = method("bindCandidate"), observe = method("observe"), close = method("close");
    abiSchema.parse(method("abi")());
    const pending = (call: (...args: unknown[]) => unknown, owner: object): Promise<unknown> => {
      const value = call(owner); if (!(value instanceof Promise)) fail(); return value;
    };
    return Object.freeze({
      create: (processId: number, uid: number, parent: number): object => {
        const owner = create(processId, uid, parent); if (owner === null || typeof owner !== "object") fail(); return owner;
      },
      bindCandidate: (owner: object) => pending(bind, owner), observe: (owner: object) => pending(observe, owner),
      close: async (owner: object) => { if (await pending(close, owner) !== undefined) fail(); },
    });
  } catch { fail(); }
}

/** Internal challenge-free mechanics, not a loader/factory or IPC capability.
 * The future guarded main initializer captures launch facts from its original
 * UtilityProcess and actual UID/PID. Inert tests provide synthetic facts/native
 * effects; production supplies neither an injected clock nor a proc reader.
 * Store this object on the provisional owner before calling bind(). */
export class MacKernelRetirementBoundary implements RetirementBoundary {
  private readonly owner: object;
  private readonly launch: Launch;
  private readonly limits: z.infer<typeof limitsSchema>;
  private binding: Promise<RetirementBoundary> | undefined;
  private pending: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  private poisoned = false;
  private record: MacProcessRecord | undefined;
  private identity: BackendIdentity | undefined;
  private watched = false;
  private cloexec = false;
  private exitSeen = false;
  private nonRunning = false;
  private initialValue: Initial = Object.freeze({ level: "ambiguous", identity: null, canAdmit: false });
  private currentValue: RetirementBoundary["current"] = Object.freeze({ level: "ambiguous" });
  constructor(private readonly native: MacKernelRetirementNative, launch: unknown, limits: unknown = {}) {
    try {
      this.launch = launchSchema.parse(launch); this.limits = limitsSchema.parse(limits);
      if (this.launch.pid === this.launch.parentPid || this.limits.pollMs > this.limits.deadlineMs ||
        !Object.isFrozen(native)) fail();
      // No asynchronous work occurs before the original opaque owner is stored.
      this.owner = native.create(this.launch.pid, this.launch.uid, this.launch.parentPid);
      if (this.owner === null || typeof this.owner !== "object") fail();
    } catch { fail(); }
  }
  get initial(): Initial { return this.initialValue; }
  get current(): RetirementBoundary["current"] { return this.currentValue; }
  private poison(): void {
    this.poisoned = true;
    // Keep actual full-reap evidence on cleanup failure; closing itself cannot
    // establish it. Query failure before reaping makes the level ambiguous.
    if (this.currentValue.level !== "reaped") this.currentValue = Object.freeze({ level: "ambiguous" });
  }
  private async bounded<T>(work: Promise<T>, signal: AbortSignal | undefined, milliseconds: number): Promise<T> {
    const until = performance.now() + milliseconds;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        abort = () => { this.poison(); reject(new MacRetirementError()); };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, milliseconds);
      });
      const result = await Promise.race([work, deadline]);
      if (performance.now() >= until || signal?.aborted) { this.poison(); fail(); }
      return result;
    } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
  }
  private async query(effect: () => Promise<unknown>, signal: AbortSignal, milliseconds = this.limits.deadlineMs): Promise<unknown> {
    if (this.poisoned || this.pending || this.closing || signal.aborted || milliseconds <= 0) { this.poison(); fail(); }
    const work = Promise.resolve().then(() => {
      if (this.poisoned || this.closing || signal.aborted) fail(); return effect();
    });
    this.pending = work;
    void work.then(() => { if (this.pending === work) this.pending = undefined; }, () => {
      this.poison(); if (this.pending === work) this.pending = undefined;
    });
    try {
      const reply = await this.bounded(work, signal, milliseconds);
      if (this.poisoned || this.closing || signal.aborted) fail(); return reply;
    } catch { this.poison(); fail(); }
  }
  private owned(record: MacProcessRecord): void {
    if (record.pid !== this.launch.pid || record.parentPid !== this.launch.parentPid || record.uid !== this.launch.uid ||
      record.realUid !== this.launch.uid || record.savedUid !== this.launch.uid || record.seconds > (1n << 63n) - 1n) fail();
  }
  private validFlags(value: Flags, subsequent: boolean): void {
    if ((value.watched && !value.cloexec) || (value.exitSeen && !value.watched) ||
      (subsequent && (value.watched !== this.watched || value.cloexec !== this.cloexec || (this.exitSeen && !value.exitSeen)))) fail();
  }
  private keep(record: MacProcessRecord): void {
    this.owned(record); this.record = record;
    this.identity = Object.freeze({ pid: record.pid, uid: record.uid, parentPid: record.parentPid, epoch: this.launch.epoch,
      birth: Object.freeze({ platform: "darwin", seconds: record.seconds, micros: Number(record.micros) }) });
  }
  private classify(snapshot: z.infer<typeof macProcessSnapshotSchema>, flags: Flags): Level {
    if (snapshot.kind === "failure") fail();
    if (snapshot.kind === "absent") return "reaped";
    const original = this.record; if (!original || snapshot.pid !== original.pid) fail();
    if (snapshot.seconds !== original.seconds || snapshot.micros !== original.micros) return "reaped";
    this.owned(snapshot);
    this.nonRunning ||= snapshot.state === "zombie" || flags.exitSeen;
    if (!this.nonRunning && !flags.watched) fail();
    return this.nonRunning ? "non-running" : "running";
  }
  bind(signal: AbortSignal): Promise<RetirementBoundary> {
    if (this.binding) return this.binding;
    this.binding = Promise.resolve().then(async () => {
      const reply = bindSchema.parse(await this.query(() => this.native.bindCandidate(this.owner), signal));
      this.validFlags(reply, false);
      if (reply.first.kind === "failure" || reply.second.kind === "failure") fail();
      if (reply.first.kind === "absent") {
        if (reply.second.kind !== "absent" || reply.watched || reply.cloexec || reply.exitSeen) fail();
        this.currentValue = Object.freeze({ level: "reaped" });
      } else {
        this.keep(reply.first); this.nonRunning = reply.first.state === "zombie";
        this.currentValue = Object.freeze({ level: this.classify(reply.second, reply) });
      }
      this.watched = reply.watched; this.cloexec = reply.cloexec; this.exitSeen = reply.exitSeen;
      this.initialValue = Object.freeze({ level: this.currentValue.level,
        identity: this.currentValue.level === "reaped" ? null : this.identity ?? null, canAdmit: this.currentValue.level === "running" });
      return this;
    }).catch(() => {
      this.poison();
      // Preserve one disposal obligation even though bind could not publish a
      // valid witness. This does not certify the child/allocation is retired.
      void this.startClose().catch(() => {}); fail();
    });
    void this.binding.catch(() => {}); return this.binding;
  }
  async observe(signal: AbortSignal): Promise<Readonly<{ level: Level; identity: BackendIdentity | null }>> {
    try {
      if (!this.binding || this.poisoned || this.closing || signal.aborted) fail();
      await this.binding;
      if (this.poisoned || this.closing || signal.aborted) fail();
      if (this.currentValue.level === "reaped") return Object.freeze({ level: "reaped", identity: null });
      const reply = observeSchema.parse(await this.query(() => this.native.observe(this.owner), signal));
      this.validFlags(reply, true);
      const level = this.classify(reply.second, reply); this.exitSeen = reply.exitSeen;
      this.currentValue = Object.freeze({ level });
      return Object.freeze({ level, identity: level === "reaped" ? null : this.identity ?? null });
    } catch { this.poison(); fail(); }
  }
  async waitForRetirement(signal: AbortSignal): Promise<void> {
    const until = performance.now() + this.limits.deadlineMs;
    try {
      for (;;) {
        if (this.poisoned || this.closing || signal.aborted || !this.binding) fail();
        await this.binding;
        // Binding has its own query budget. Its late availability cannot bypass
        // this wait call's independently captured absolute deadline.
        if (this.poisoned || this.closing || signal.aborted || performance.now() >= until) fail();
        if (this.currentValue.level === "reaped") return;
        const remaining = until - performance.now(); if (remaining <= 0) fail();
        const reply = observeSchema.parse(await this.query(() => this.native.observe(this.owner), signal, remaining));
        this.validFlags(reply, true);
        this.currentValue = Object.freeze({ level: this.classify(reply.second, reply) }); this.exitSeen = reply.exitSeen;
        if (this.currentValue.level === "reaped") return;
        await this.pause(signal, Math.min(this.limits.pollMs, Math.max(1, until - performance.now())));
      }
    } catch { this.poison(); fail(); }
  }
  private pause(signal: AbortSignal, milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new MacRetirementError()); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
  }
  private startClose(): Promise<void> {
    if (this.closing) return this.closing;
    const binding = this.binding, pending = this.pending;
    // Publish the exact promise before possibly throwing native.close, and wait
    // every accepted query/bind even if a deficient effect reports close early.
    this.closing = Promise.allSettled([Promise.resolve().then(() => this.native.close(this.owner)),
      ...(binding ? [binding] : []), ...(pending ? [pending] : [])]).then((results) => {
      if (results[0]?.status !== "fulfilled") { this.poison(); fail(); }
    });
    void this.closing.catch(() => {}); return this.closing;
  }
  async settleReads(): Promise<void> {
    try { await this.bounded(this.startClose(), undefined, this.limits.deadlineMs); } catch { this.poison(); fail(); }
  }
}

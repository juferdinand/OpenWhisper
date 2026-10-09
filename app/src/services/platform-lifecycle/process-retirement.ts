import { constants, type BigIntStats } from "node:fs";
import { lstat, open, statfs } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export const PROCFS_MAGIC = 0x9fa0n;
export const MAX_PROC_STAT_BYTES = 4096;
export const MAX_PROC_STATUS_BYTES = 65536;
export const MAX_RETIREMENT_DEADLINE_MS = 8000;
const pidSchema = z.number().int().positive().max(0x7fff_ffff);
const launchSchema = z.strictObject({ pid: pidSchema, uid: z.number().int().nonnegative().max(0xffff_fffe),
  parentPid: pidSchema, epoch: z.string().uuid() }).readonly();
const optionsSchema = z.strictObject({ deadlineMs: z.number().int().min(1).max(MAX_RETIREMENT_DEADLINE_MS).default(8000),
  pollMs: z.number().int().min(1).max(250).default(20) }).refine((value) => value.pollMs <= value.deadlineMs).readonly();
const stateSchema = z.enum(["R", "S", "D", "Z", "T", "t", "X", "x", "K", "W", "P", "I"]);
type LinuxState = z.infer<typeof stateSchema>;
type TrustedLaunch = z.infer<typeof launchSchema>;
type Options = z.infer<typeof optionsSchema>;
export type ProcessRetirementLevel = "running" | "non-running" | "reaped" | "ambiguous";
export type ProcField = "stat" | "status";
export class ProcessRetirementError extends Error {
  readonly code = "TEARDOWN_FAILED";
  constructor() { super("Process retirement: TEARDOWN_FAILED."); this.name = "ProcessRetirementError"; }
}
export interface LinuxProcessIdentity {
  readonly pid: number; readonly uid: number; readonly parentPid: number; readonly startTicks: bigint; readonly epoch: string;
}
export interface RetirementObservation { readonly level: ProcessRetirementLevel }
export interface InitialRetirementObservation extends RetirementObservation {
  /** Candidate live kernel identity only; this MUST NOT authorize workload. The
   * first snapshot can adopt a reused same-UID/direct-parent PID. Before future
   * admission, require fresh nonce confirmation over the original launched
   * child's private channel with matching birth metadata. Absence never admits. */
  readonly canAdmit: boolean;
  readonly identity: LinuxProcessIdentity | null;
}
export interface ProcessRetirementReadProvider {
  verify(signal: AbortSignal): Promise<void>;
  read(pid: number, field: ProcField, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
  /** Trusted test clock only. Production uses performance.now(), never wall-clock time. */
  readonly now?: () => number;
}
/** Fixed-path host effects, exposed for inert filesystem tests. Never supplied by IPC. */
export interface LinuxProcFile {
  stat(options: Readonly<{ bigint: true }>): Promise<BigIntStats>;
  read(buffer: Buffer, offset: number, length: number, position: null): Promise<Readonly<{ bytesRead: number }>>;
  close(): Promise<void>;
}
export interface LinuxProcfsIO {
  readonly platform: NodeJS.Platform;
  lstat(path: string): Promise<BigIntStats>;
  statfs(path: string): Promise<Readonly<{ type: bigint }>>;
  open(path: string, flags: number): Promise<LinuxProcFile>;
}
interface Inode { readonly dev: bigint; readonly ino: bigint }
export interface LinuxProcStat {
  readonly pid: number; readonly parentPid: number; readonly startTicks: bigint; readonly state: LinuxState;
}
export interface LinuxProcStatus {
  readonly pid: number; readonly parentPid: number; readonly uids: readonly number[];
}
interface Snapshot extends LinuxProcStat { readonly uids: readonly number[] }
const sameInode = (left: Inode, right: Inode): boolean => left.dev === right.dev && left.ino === right.ino;
function failure(): never { throw new ProcessRetirementError(); }
function active(signal: AbortSignal): void { if (signal.aborted) failure(); }
function code(error: unknown, expected: string): boolean {
  return error instanceof Error && "code" in error && error.code === expected;
}
function bytes(input: unknown, limit: number): Buffer {
  if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > limit) failure();
  return Buffer.from(input);
}
function unsigned(input: string | undefined, maximum: bigint, zero = true): bigint {
  if (input === undefined || !/^(?:0|[1-9][0-9]{0,19})$/u.test(input)) failure();
  const value = BigInt(input); if (value > maximum || (!zero && value === 0n)) failure(); return value;
}
function numeric(input: string): void {
  if (!/^-?(?:0|[1-9][0-9]{0,19})$/u.test(input)) failure();
  const value = BigInt(input); if (value < -(1n << 63n) || value > (1n << 64n) - 1n) failure();
}

/** /proc/pid/stat fields 1,3,4,22. Ignore comm as raw Latin-1 bytes: it can
 * contain parentheses/newlines or a truncated UTF-8 name. Never retain/log it.
 * Primary format: https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html */
export function parseLinuxProcStat(input: unknown): LinuxProcStat {
  const value = bytes(input, MAX_PROC_STAT_BYTES).toString("latin1");
  const opening = value.indexOf("("), closing = value.lastIndexOf(")");
  if (opening < 2 || closing < opening || value[opening - 1] !== " " || value[closing + 1] !== " " || !value.endsWith("\n")) failure();
  const pid = Number(unsigned(value.slice(0, opening - 1), 0x7fff_ffffn, false));
  const fields = value.slice(closing + 2, -1).split(" ");
  // Linux 5.15+ exposes 52 fields. Reject a partial numeric suffix; allow
  // bounded future numeric fields without depending on their meanings.
  if (fields.length < 50 || fields.length > 128) failure();
  const state = stateSchema.safeParse(fields[0]); if (!state.success) failure();
  for (const field of fields.slice(1)) numeric(field);
  return Object.freeze({ pid, state: state.data,
    parentPid: Number(unsigned(fields[1], 0x7fff_ffffn)),
    startTicks: unsigned(fields[19], (1n << 64n) - 1n, false) });
}
export function parseLinuxProcStatus(input: unknown): LinuxProcStatus {
  const value = bytes(input, MAX_PROC_STATUS_BYTES).toString("latin1");
  if (!value.endsWith("\n") || value.includes("\0")) failure();
  const selected = new Map<string, string>();
  for (const line of value.split("\n")) {
    const match = /^(Pid|Tgid|PPid|Uid):[ \t]+(.+)$/u.exec(line);
    if (!match) continue;
    const key = match[1], data = match[2];
    if (!key || !data || selected.has(key)) failure(); selected.set(key, data);
  }
  const pid = Number(unsigned(selected.get("Pid"), 0x7fff_ffffn, false));
  if (unsigned(selected.get("Tgid"), 0x7fff_ffffn, false) !== BigInt(pid)) failure();
  const parentPid = Number(unsigned(selected.get("PPid"), 0x7fff_ffffn));
  const uid = selected.get("Uid")?.split(/[ \t]+/u); if (!uid || uid.length !== 4) failure();
  return Object.freeze({ pid, parentPid, uids: Object.freeze(uid.map((item) => Number(unsigned(item, 0xffff_fffen)))) });
}

/** Genuine procfs only. Paths are built from a validated numeric PID and closed
 * field enum. Proc FDs do not prevent PID reuse; the witness compares births.
 * https://docs.kernel.org/filesystems/proc.html#process-specific-subdirectories */
export function createLinuxProcfsReadProvider(effects: LinuxProcfsIO = {
  platform: process.platform, lstat: (path) => lstat(path, { bigint: true }),
  statfs: (path) => statfs(path, { bigint: true }), open,
}): ProcessRetirementReadProvider {
  let rootIdentity: Inode | undefined;
  const verify = async (signal: AbortSignal): Promise<void> => {
    try {
    active(signal); if (effects.platform !== "linux") failure();
    const before = await effects.lstat("/proc"); active(signal);
    if (!before.isDirectory() || before.isSymbolicLink() || (rootIdentity && !sameInode(before, rootIdentity))) failure();
    if ((await effects.statfs("/proc")).type !== PROCFS_MAGIC) failure(); active(signal);
    const root = await effects.open("/proc", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await root.stat({ bigint: true }), named = await effects.lstat("/proc"); active(signal);
      if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !sameInode(opened, before) || !sameInode(opened, named)) failure();
      if ((await effects.statfs("/proc")).type !== PROCFS_MAGIC) failure(); active(signal);
      rootIdentity ??= Object.freeze({ dev: opened.dev, ino: opened.ino });
    } finally { await root.close(); }
    } catch { throw new ProcessRetirementError(); }
  };
  return Object.freeze({ verify, async read(pid, field, maximumBytes, signal) {
    if (!pidSchema.safeParse(pid).success || (field !== "stat" && field !== "status") ||
        maximumBytes !== (field === "stat" ? MAX_PROC_STAT_BYTES : MAX_PROC_STATUS_BYTES)) failure();
    await verify(signal);
    let file: LinuxProcFile | undefined;
    try {
      const directory = await effects.lstat(`/proc/${pid}`); active(signal);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== rootIdentity?.dev) failure();
      const path = `/proc/${pid}/${field}`, named = await effects.lstat(path); active(signal);
      if (!named.isFile() || named.isSymbolicLink() || named.dev !== rootIdentity?.dev) failure();
      file = await effects.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await file.stat({ bigint: true }); active(signal);
      if (!opened.isFile() || !sameInode(opened, named)) failure();
      const buffer = Buffer.alloc(maximumBytes + 1); let offset = 0;
      while (offset < buffer.length) {
        active(signal);
        const result = await file.read(buffer, offset, buffer.length - offset, null); active(signal);
        if (!Number.isInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length - offset) failure();
        if (result.bytesRead === 0) break; offset += result.bytesRead;
      }
      if (offset > maximumBytes) failure();
      const confirmed = await effects.lstat(path), parent = await effects.lstat(`/proc/${pid}`); active(signal);
      if (!confirmed.isFile() || confirmed.isSymbolicLink() || !sameInode(opened, confirmed) || !sameInode(directory, parent)) failure();
      await verify(signal); return buffer.subarray(0, offset);
    } catch (error: unknown) {
      if (code(error, "ENOENT")) { await verify(signal); return null; }
      throw new ProcessRetirementError();
    } finally { try { await file?.close(); } catch { throw new ProcessRetirementError(); } }
  } } satisfies ProcessRetirementReadProvider);
}

/** One trusted launched-owner candidate only. This observes; it never signals,
 * reaps, authenticates the original channel or releases an allocation/lease.
 * A first proc snapshot alone cannot establish original-child admission. It is
 * not yet wired into any channel or workload admission policy. */
export class LinuxProcessRetirementWitness {
  private initialValue: InitialRetirementObservation = Object.freeze({ level: "ambiguous", canAdmit: false, identity: null });
  private currentValue: RetirementObservation = Object.freeze({ level: "ambiguous" });
  private failed = false;
  private retired = false;
  private queue: Promise<void> = Promise.resolve();
  private acceptedOperation = 0;
  private runningOperation = 0;
  private readonly pendingReads = new Map<Promise<unknown>, number>();
  private previousTime = -Infinity;
  private constructor(private readonly launch: TrustedLaunch, private readonly options: Options,
                      private readonly reader: ProcessRetirementReadProvider) {}
  get initial(): InitialRetirementObservation { return this.initialValue; }
  get current(): RetirementObservation { return this.currentValue; }
  private now(): number {
    const now = (this.reader.now ?? (() => performance.now()))();
    if (!Number.isFinite(now) || now < this.previousTime) failure(); this.previousTime = now; return now;
  }
  private async snapshot(signal: AbortSignal): Promise<Snapshot | null> {
    active(signal); await this.reader.verify(signal); active(signal);
    const beforeBytes = await this.reader.read(this.launch.pid, "stat", MAX_PROC_STAT_BYTES, signal); active(signal);
    if (beforeBytes === null) return null;
    const before = parseLinuxProcStat(beforeBytes);
    const statusBytes = await this.reader.read(this.launch.pid, "status", MAX_PROC_STATUS_BYTES, signal); active(signal);
    const afterBytes = await this.reader.read(this.launch.pid, "stat", MAX_PROC_STAT_BYTES, signal); active(signal);
    if (afterBytes === null) return null;
    if (statusBytes === null) failure();
    const after = parseLinuxProcStat(afterBytes), status = parseLinuxProcStatus(statusBytes);
    if (before.pid !== this.launch.pid || after.pid !== before.pid || status.pid !== before.pid ||
        before.startTicks !== after.startTicks || before.parentPid !== after.parentPid || after.parentPid !== status.parentPid) failure();
    return Object.freeze({ ...after, uids: status.uids });
  }
  private owned(snapshot: Snapshot): void {
    if (snapshot.parentPid !== this.launch.parentPid || snapshot.uids.some((uid) => uid !== this.launch.uid)) failure();
  }
  private level(snapshot: Snapshot | null): ProcessRetirementLevel {
    if (snapshot === null) return "reaped";
    const original = this.initial.identity;
    if (original && snapshot.startTicks !== original.startTicks) return "reaped";
    this.owned(snapshot);
    return ["Z", "X", "x"].includes(snapshot.state) ? "non-running" : "running";
  }
  private bounded<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((accept, reject) => {
      const controller = new AbortController(); let settled = false, timer: NodeJS.Timeout | undefined;
      const finish = (effect: () => void): void => {
        if (settled) return; settled = true;
        if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); effect();
      };
      const refuse = (): void => finish(() => { this.failed = true; controller.abort(); reject(new ProcessRetirementError()); });
      const abort = (): void => refuse();
      let end: number;
      try { end = this.now() + this.options.deadlineMs;
        if (signal !== undefined && !(signal instanceof AbortSignal)) failure();
      } catch { refuse(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { refuse(); return; }
      timer = setTimeout(refuse, this.options.deadlineMs);
      const running = Promise.resolve().then(() => { active(controller.signal); return operation(controller.signal); });
      this.pendingReads.set(running, this.runningOperation);
      void running.then(() => this.pendingReads.delete(running), () => this.pendingReads.delete(running));
      void running.then((value) => {
        if (settled) return;
        try { if (this.now() >= end || signal?.aborted) { refuse(); return; } }
        catch { refuse(); return; }
        finish(() => accept(value));
      }, refuse);
    });
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.acceptedOperation === Number.MAX_SAFE_INTEGER) { this.failed = true; return Promise.reject(new ProcessRetirementError()); }
    const owner = ++this.acceptedOperation;
    const result = this.queue.then(() => { this.runningOperation = owner; return operation(); });
    this.queue = result.then(() => {}, () => {}); return result;
  }
  private record(level: ProcessRetirementLevel): RetirementObservation {
    this.currentValue = Object.freeze({ level }); if (level === "reaped") this.retired = true; return this.currentValue;
  }
  static async bind(input: unknown, inputOptions: unknown = {}, reader: ProcessRetirementReadProvider = createLinuxProcfsReadProvider()): Promise<LinuxProcessRetirementWitness> {
    const launch = launchSchema.safeParse(input), options = optionsSchema.safeParse(inputOptions);
    if (!launch.success || !options.success || launch.data.uid !== process.getuid?.() || launch.data.parentPid !== process.pid) failure();
    const witness = new LinuxProcessRetirementWitness(launch.data, options.data, reader);
    try {
      const snapshot = await witness.bounded((signal) => witness.snapshot(signal));
      const level = witness.level(snapshot); witness.record(level);
      const identity = snapshot === null ? null : Object.freeze({ ...launch.data, startTicks: snapshot.startTicks });
      witness.initialValue = Object.freeze({ level, canAdmit: level === "running", identity });
    } catch { witness.failed = true; witness.record("ambiguous"); }
    return witness;
  }
  /** Cleanup cancellation is fail closed. A future factory must use its own
   * cleanup deadline/signal, never an already-aborted inference signal. */
  observe(signal?: AbortSignal): Promise<RetirementObservation> {
    return this.serialized(async () => {
      if (this.failed) return this.record("ambiguous"); if (this.retired) return this.record("reaped");
      try { return this.record(await this.bounded(async (cleanup) => this.level(await this.snapshot(cleanup)), signal)); }
      catch { return this.record("ambiguous"); }
    });
  }
  waitForRetirement(signal?: AbortSignal): Promise<void> {
    return this.serialized(async () => {
      if (this.failed) failure(); if (this.retired) return;
      try {
        await this.bounded(async (cleanup) => {
          while (true) {
            const level = this.level(await this.snapshot(cleanup));
            if (level === "reaped") return;
            this.currentValue = Object.freeze({ level });
            await delay(this.options.pollMs, undefined, { signal: cleanup }); active(cleanup);
          }
        }, signal);
        this.record("reaped");
      } catch { this.record("ambiguous"); failure(); }
    });
  }
  /** Barrier for operations accepted before this call and their actual reader/
   * FD closure, not process retirement. Later requests are outside this snapshot.
   * A hung reader can keep it pending; the witness remains fail closed. */
  async settleReads(): Promise<void> {
    const through = this.acceptedOperation, accepted = this.queue;
    await accepted;
    await Promise.allSettled([...this.pendingReads].filter(([, owner]) => owner <= through).map(([read]) => read));
  }
}

export const bindLinuxProcessRetirement = LinuxProcessRetirementWitness.bind;

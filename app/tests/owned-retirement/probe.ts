import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { appendFile, lstat, open, statfs } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { bindLinuxProcessRetirement, createLinuxProcfsReadProvider, MAX_PROC_STAT_BYTES,
  parseLinuxProcStat, type LinuxProcessRetirementWitness, type LinuxProcfsIO,
  ProcessRetirementError, type InitialRetirementObservation, type ProcessRetirementLevel, type ProcessRetirementReadProvider } from "../../src/services/platform-lifecycle/process-retirement.js";
import { AllocationFence, FixtureError, ProbeFailure, confirmAdmission, diagnosticSignal, expectedExitMatches, parseReply, pidSchema, resultSchema,
  type Action, type CaseResult, type ChildMode, type IdentityReply, type ProbeResult, type Reply,
  type Request, type Runtime, type Suite, type ProbeStage } from "./contract.js";

export interface ChildTransport {
  readonly pid: () => number | undefined;
  send(request: Request): Promise<void>;
  kill(): boolean;
  onMessage(listener: (input: unknown) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onFailure(listener: () => void): void;
  onSpawn(listener: () => void): void;
}
function latch<T>() {
  let resolve: (value: T) => void = () => { throw new FixtureError(); };
  let reject: (error: unknown) => void = () => { throw new FixtureError(); };
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_accept, reject) => { timer = setTimeout(() => { reject(new FixtureError()); }, milliseconds); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
export class OwnedLink {
  private readonly spawned = latch<number>();
  private readonly ended = latch<void>();
  private readonly used = new Set<string>();
  private readonly nonceHashes: string[] = [];
  private pending: { nonce: string; resolve: (reply: Reply) => void; reject: (error: unknown) => void } | null = null;
  private failed = false;
  private recordedPid: number | undefined;
  private admittedBirth: string | null = null;
  private lastChallenge: IdentityReply | null = null;
  private lastChallengeAt = -Infinity;
  private terminated = false;
  private readonly createdAt = performance.now();
  exitObserved = false;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  exitAtMs: number | null = null;
  runtimePidUnsetAfterExit = false;
  constructor(private readonly transport: ChildTransport, readonly epoch: string, readonly mode: ChildMode) {
    // All replies come from this exact returned child object, never a shared bus.
    transport.onMessage((input) => {
      try {
        const reply = parseReply(input), pending = this.pending;
        if (!pending || reply.epoch !== this.epoch || reply.nonce !== pending.nonce || this.failed) throw new FixtureError();
        this.pending = null; pending.resolve(reply);
      } catch { this.poison(); }
    });
    transport.onFailure(() => { this.poison(); this.spawned.reject(new FixtureError()); });
    transport.onExit((code, signal) => {
      this.exitObserved = true; this.exitCode = code; this.exitSignal = signal;
      this.exitAtMs = performance.now();
      this.runtimePidUnsetAfterExit = transport.pid() === undefined;
      this.pending?.reject(new FixtureError()); this.pending = null; this.ended.resolve();
    });
    transport.onSpawn(() => {
      try { this.recordedPid = pidSchema.parse(transport.pid()); this.spawned.resolve(this.recordedPid); }
      catch { this.poison(); this.spawned.reject(new FixtureError()); }
    });
    // A launch failure may precede the caller's await; own both rejection paths.
    void this.spawned.promise.catch(() => {}); void this.ended.promise.catch(() => {});
  }
  private poison(): void { this.failed = true; this.pending?.reject(new FixtureError()); this.pending = null; }
  async readyPid(): Promise<number> { return bounded(this.spawned.promise, 2000); }
  private async request(request: Request): Promise<Reply> {
    if (this.pending || this.failed || this.exitObserved || this.used.has(request.nonce) || this.used.size >= 16) throw new FixtureError();
    this.used.add(request.nonce); this.nonceHashes.push(createHash("sha256").update(request.nonce).digest("hex"));
    const reply = latch<Reply>();
    this.pending = { nonce: request.nonce, resolve: reply.resolve, reject: reply.reject };
    try {
      // Own the reply before awaiting send; a fast child may already have exited.
      const accepted = bounded(reply.promise, 2000); void accepted.catch(() => {});
      await bounded(this.transport.send(request), 2000); return await accepted;
    } catch { this.poison(); throw new FixtureError(); }
    finally { if (this.pending?.nonce === request.nonce) this.pending = null; }
  }
  async challenge(): Promise<IdentityReply> {
    const reply = await this.request({ version: 1, kind: "challenge", epoch: this.epoch, nonce: randomBytes(32).toString("hex") });
    if (reply.kind !== "identity" || reply.pid !== this.recordedPid || reply.mode !== this.mode) throw new FixtureError();
    this.lastChallenge = reply; this.lastChallengeAt = performance.now(); return reply;
  }
  confirmCandidate(before: IdentityReply, initial: InitialRetirementObservation, after: IdentityReply): void {
    if (this.recordedPid === undefined || this.lastChallenge !== after || this.exitObserved || this.failed) throw new FixtureError();
    confirmAdmission(before, initial, after, { pid: this.recordedPid, parentPid: process.pid, epoch: this.epoch, mode: this.mode });
    this.admittedBirth = after.startTicks;
  }
  async action(action: Action): Promise<void> {
    if (this.admittedBirth === null) throw new FixtureError();
    const reply = await this.request({ version: 1, kind: "action", epoch: this.epoch, nonce: randomBytes(32).toString("hex"), action });
    if (reply.kind !== "ack" || reply.action !== action) throw new FixtureError();
  }
  /** Only the stored child object, after fresh confirmation and before its watchdog margin. */
  killConfirmed(): void {
    if (this.exitObserved || this.failed || this.terminated || this.admittedBirth === null || this.lastChallenge?.startTicks !== this.admittedBirth ||
      this.lastChallenge.parentPid !== process.pid || this.lastChallenge.uid !== 1000 || performance.now() - this.lastChallengeAt >= 1000 ||
      performance.now() - this.createdAt >= 10_000 || this.transport.pid() !== this.recordedPid ||
      !this.transport.kill()) throw new FixtureError();
    this.terminated = true;
  }
  async exit(): Promise<void> { await bounded(this.ended.promise, 8000); }
  get hashes(): string[] { return [...this.nonceHashes]; }
}
export type SpawnChild = (epoch: string, mode: ChildMode) => OwnedLink;

interface CloseHold { readonly reader: ProcessRetirementReadProvider; arm(): void; release(): void;
  readonly closing: Promise<void>; readonly closed: () => boolean; readonly held: () => boolean }
function heldDescriptor(pid: number): CloseHold {
  const closing = latch<void>(), release = latch<void>(); let armed = false, held = false, closed = false;
  const io: LinuxProcfsIO = { platform: process.platform,
    lstat: (path) => lstat(path, { bigint: true }), statfs: (path) => statfs(path, { bigint: true }),
    async open(path, flags) {
      const file = await open(path, flags);
      if (path !== `/proc/${pid}/stat` || !armed) return file;
      armed = false;
      return { stat: (options) => file.stat(options), read: (buffer, offset, length, position) => file.read(buffer, offset, length, position),
        async close() {
          held = true; closing.resolve();
          try { await release.promise; } finally { await file.close(); closed = true; }
          // Fixed late-close failure, after the real held descriptor was closed.
          throw new FixtureError();
        } };
    } };
  return { reader: createLinuxProcfsReadProvider(io), arm: () => { armed = true; }, release: () => { release.resolve(); },
    closing: closing.promise, closed: () => closed, held: () => held };
}

function initialCase(name: CaseResult["name"], link: OwnedLink, identity: IdentityReply, parentPid: number): CaseResult {
  return { name, pid: identity.pid, parentPid, uid: 1000, epoch: link.epoch, startTicks: identity.startTicks, nonceHashes: [],
    admitted: true, exitObserved: false, exitCode: null, exitSignal: null, observations: [], zombie: "NOT_OBSERVED",
    exitAtMs: null,
    kernelAbsentAfterExit: false, retiredBy: null, poisoned: false, replacementRefused: false, actualDescriptorHeld: false,
    descriptorClosed: false, queuedBarrierSettledEarly: false, spawnCount: 0, runtimePidUnsetAfterExit: false };
}
function level(result: CaseResult, observed: ProcessRetirementLevel, origin: number): void {
  const last = result.observations.at(-1);
  if (!last || last.level !== observed) result.observations.push({ atMs: performance.now() - origin, level: observed });
}
async function originalAbsent(pid: number, startTicks: string): Promise<"absence" | "different-birth"> {
  const reader = createLinuxProcfsReadProvider(), signal = AbortSignal.timeout(2000);
  while (!signal.aborted) {
    await reader.verify(signal);
    const bytes = await reader.read(pid, "stat", MAX_PROC_STAT_BYTES, signal);
    if (bytes === null) return "absence";
    const identity = parseLinuxProcStat(bytes); assert.equal(identity.pid, pid);
    if (identity.startTicks.toString() !== startTicks) return "different-birth";
    await delay(2, undefined, { signal });
  }
  throw new FixtureError();
}
async function watchRetirement(witness: LinuxProcessRetirementWitness, result: CaseResult, origin: number): Promise<void> {
  const reader = createLinuxProcfsReadProvider();
  let finished = false;
  const waiting = witness.waitForRetirement().finally(() => { finished = true; }); void waiting.catch(() => {});
  while (!finished) {
    level(result, witness.current.level, origin);
    if (witness.current.level === "non-running") {
      const bytes = await reader.read(result.pid, "stat", MAX_PROC_STAT_BYTES, AbortSignal.timeout(1000));
      if (bytes !== null) {
        const identity = parseLinuxProcStat(bytes); assert.equal(identity.pid, result.pid);
        if (identity.startTicks.toString() === result.startTicks && identity.state === "Z") result.zombie = "OBSERVED";
      }
    }
    await delay(1);
  }
  level(result, witness.current.level, origin); await waiting;
}
function refused(fence: AllocationFence): boolean {
  const before = fence.spawnCount; assert.throws(() => { fence.reserve(); }, FixtureError); assert.equal(fence.spawnCount, before); return true;
}
function collectExit(result: CaseResult, link: OwnedLink, origin: number): void {
  result.exitObserved = link.exitObserved; result.exitCode = link.exitCode; result.exitSignal = link.exitSignal;
  result.runtimePidUnsetAfterExit = link.runtimePidUnsetAfterExit; result.nonceHashes = link.hashes;
  result.exitAtMs = link.exitAtMs === null ? null : link.exitAtMs - origin;
}

export async function runProbe(runtime: Runtime, suite: Suite, spawn: SpawnChild): Promise<ProbeResult> {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 1000);
  const startedAtUtc = new Date().toISOString(), origin = performance.now(), fence = new AllocationFence(), results: CaseResult[] = [];
  const names: CaseResult["name"][] = suite === "held-reader" ? ["held-close"] : ["self-exit", "owned-term", "self-abort", "delayed-term"];
  for (const name of names) {
    const epoch = randomUUID(), mode = name === "delayed-term" ? "delayed-term" : "normal";
    fence.reserve(); const link = spawn(epoch, mode), pid = await link.readyPid();
    const before = await link.challenge(), hold = name === "held-close" ? heldDescriptor(pid) : null;
    const progress = async (phase: "pre-bind" | "candidate" | "post-bind" | "admitted" | "action-confirmed" | "termination-requested" |
      "retirement-proven" | "retirement-refused" | "runtime-exit" | "kernel-retirement-confirmed" | "reads-settled" | "complete", metadata: unknown): Promise<void> => {
      const line = JSON.stringify({ phase, runtime, suite, case: name, epoch, atMs: performance.now() - origin, metadata });
      assert.ok(Buffer.byteLength(line) <= 2048); await appendFile("/evidence/progress.jsonl", `${line}\n`, { mode: 0o600 });
    };
    const contentFree = (identity: IdentityReply) => ({ pid: identity.pid, uid: identity.uid, parentPid: identity.parentPid, startTicks: identity.startTicks });
    await progress("pre-bind", contentFree(before));
    const witness = await bindLinuxProcessRetirement({ pid, uid: 1000, parentPid: process.pid, epoch },
      { deadlineMs: name === "delayed-term" || hold ? 150 : 2000, pollMs: 1 }, hold?.reader ?? createLinuxProcfsReadProvider());
    await progress("candidate", { level: witness.initial.level, candidateOnly: witness.initial.canAdmit,
      startTicks: witness.initial.identity?.startTicks.toString() ?? null, expectedParentPid: process.pid });
    const after = await link.challenge();
    await progress("post-bind", contentFree(after));
    confirmAdmission(before, witness.initial, after, { pid, parentPid: process.pid, epoch, mode });
    link.confirmCandidate(before, witness.initial, after);
    assert.equal((await witness.observe()).level, "running"); assert.equal(link.exitObserved, false);
    await progress("admitted", { freshOriginalChannelConfirmed: true });
    const result = initialCase(name, link, before, process.pid); level(result, "running", origin);
    let stage: ProbeStage = "case-start";
    const runtimeExit = () => ({ exitObserved: link.exitObserved, exitCode: link.exitCode, exitSignal: diagnosticSignal(link.exitSignal) });
    try {
      if (hold) {
        stage = "held-observation";
        hold.arm(); const observations = [witness.observe(), witness.observe()];
        let settled = false; const barrier = witness.settleReads().then(() => { settled = true; });
        try {
          await bounded(hold.closing, 1000);
          const observed = await Promise.all(observations); assert.deepEqual(observed.map((item) => item.level), ["ambiguous", "ambiguous"]);
          result.actualDescriptorHeld = hold.held(); result.queuedBarrierSettledEarly = settled; assert.equal(settled, false);
        } finally { hold.release(); await Promise.allSettled([...observations, barrier]); }
        stage = "held-closure";
        result.descriptorClosed = hold.closed(); assert.equal(result.descriptorClosed, true);
        stage = "sticky-observation";
        assert.equal((await witness.observe()).level, "ambiguous"); level(result, "ambiguous", origin);
        stage = "allocation-refusal";
        fence.poison(); result.replacementRefused = refused(fence); result.poisoned = true;
        await progress("retirement-refused", { level: witness.current.level, replacementRefused: result.replacementRefused });
        stage = "child-action"; await link.action("exit");
        stage = "wait-runtime-exit"; await link.exit(); await progress("runtime-exit", runtimeExit());
        stage = "kernel-retirement"; result.retiredBy = await originalAbsent(pid, before.startTicks);
        await progress("kernel-retirement-confirmed", { retiredBy: result.retiredBy });
        stage = "sticky-observation";
        assert.equal((await witness.observe()).level, "ambiguous"); result.kernelAbsentAfterExit = result.retiredBy === "absence";
        stage = "allocation-refusal"; assert.equal(refused(fence), true);
      } else if (name === "delayed-term") {
        stage = "action-challenge"; const fresh = await link.challenge();
        stage = "action-confirmation"; confirmAdmission(after, witness.initial, fresh, { pid, parentPid: process.pid, epoch, mode });
        await progress("action-confirmed", { freshOriginalChannelConfirmed: true });
        stage = "schedule-exit"; await link.action("schedule-exit");
        stage = "termination-request"; link.killConfirmed(); await progress("termination-requested", { ownedObjectKillAccepted: true });
        stage = "wait-retirement";
        await assert.rejects(watchRetirement(witness, result, origin), (error: unknown) => error instanceof ProcessRetirementError && error.code === "TEARDOWN_FAILED");
        assert.equal(witness.current.level, "ambiguous");
        stage = "allocation-refusal"; fence.poison(); result.poisoned = true; result.replacementRefused = refused(fence);
        await progress("retirement-refused", { level: witness.current.level, replacementRefused: result.replacementRefused });
        stage = "wait-runtime-exit"; await link.exit(); await progress("runtime-exit", runtimeExit());
        stage = "kernel-retirement"; result.retiredBy = await originalAbsent(pid, before.startTicks); result.kernelAbsentAfterExit = result.retiredBy === "absence";
        await progress("kernel-retirement-confirmed", { retiredBy: result.retiredBy });
        stage = "sticky-observation"; assert.equal((await witness.observe()).level, "ambiguous");
        stage = "allocation-refusal"; assert.equal(refused(fence), true);
      } else {
        if (name === "owned-term") {
          stage = "action-challenge"; const fresh = await link.challenge();
          stage = "action-confirmation"; confirmAdmission(after, witness.initial, fresh, { pid, parentPid: process.pid, epoch, mode });
          await progress("action-confirmed", { freshOriginalChannelConfirmed: true });
          stage = "termination-request"; link.killConfirmed(); await progress("termination-requested", { ownedObjectKillAccepted: true });
        } else { stage = "child-action"; await link.action(name === "self-abort" ? "abort" : "exit"); }
        stage = "wait-retirement"; await watchRetirement(witness, result, origin);
        await progress("retirement-proven", { level: witness.current.level });
        stage = "wait-runtime-exit"; await link.exit(); await progress("runtime-exit", runtimeExit());
        stage = "kernel-retirement"; result.retiredBy = await originalAbsent(pid, before.startTicks); result.kernelAbsentAfterExit = result.retiredBy === "absence";
        await progress("kernel-retirement-confirmed", { retiredBy: result.retiredBy });
        stage = "retirement-fence"; fence.retired(witness.current.level);
      }
      stage = "settle-reads"; await witness.settleReads(); collectExit(result, link, origin); result.spawnCount = fence.spawnCount;
      await progress("reads-settled", { ...runtimeExit(), level: witness.current.level, descriptorClosed: result.descriptorClosed });
      stage = "exit-validation";
      assert.equal(result.exitObserved, true); assert.notEqual(result.exitCode, 72);
      assert.equal(expectedExitMatches(runtime, name, result.exitCode, result.exitSignal), true);
      stage = "complete-progress";
      await progress("complete", { exitCode: result.exitCode, exitSignal: diagnosticSignal(result.exitSignal), level: witness.current.level,
        retiredBy: result.retiredBy, zombie: result.zombie,
        poisoned: result.poisoned, replacementRefused: result.replacementRefused, descriptorClosed: result.descriptorClosed });
      results.push(result);
    } catch {
      throw new ProbeFailure({ category: "PROBE_CASE_FAILED", runtime, suite, case: name, stage, level: witness.current.level, ...runtimeExit() });
    }
  }
  return resultSchema.parse({ version: 1, status: "PASS", runtime, suite, startedAtUtc, finishedAtUtc: new Date().toISOString(),
    parentPid: process.pid, uid: 1000, cases: results, versions: process.versions,
    scope: "Owned inert Linux child/procfs lifetime only; no factory, native, speech, capture, inventory, macOS or device proof." });
}

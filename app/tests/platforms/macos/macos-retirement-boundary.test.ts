import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { captureMacKernelRetirementNative, MacKernelRetirementBoundary } from "../../../src/services/platforms/macos/macos-retirement-boundary.js";
import { MacRetirementError } from "../../../src/services/platforms/macos/macos-process-retirement.js";
import type { MacProcessRecord } from "../../../src/services/platforms/macos/macos-process-retirement.js";

const record: MacProcessRecord = Object.freeze({ kind: "record", pid: 123, parentPid: 100, uid: 501, realUid: 501, savedUid: 501,
  seconds: 1_700_000_000n, micros: 12345n, state: "sleeping" });
const flags = Object.freeze({ watched: true, exitSeen: false, cloexec: true });
const abi = Object.freeze({ version: 1, role: "production", napiVersion: 8, mainOnly: true, zombieLookupArgument: 1, probeOnly: false });
const signal = (): AbortSignal => new AbortController().signal;
// These fixtures include successful setup/cleanup on shared CI runners. The
// held operations still expire against this one real budget; production limits
// and monotonic time are unchanged.
const heldFixtureDeadlineMs = 3_000;
function deferred<T>(): { promise: Promise<T>; accept: (value: T) => void; reject: (error: unknown) => void } {
  let accept!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, failure) => { accept = resolve; reject = failure; }); return { promise, accept, reject };
}
const rejects = async (effect: Promise<unknown>): Promise<void> => {
  await assert.rejects(effect, (error: unknown) => error instanceof MacRetirementError && error.code === "TEARDOWN_FAILED");
};
const flush = async (): Promise<void> => { for (let count = 0; count < 12; count += 1) await Promise.resolve(); };
class FakeNative {
  readonly owner = {};
  calls: string[] = [];
  bindReply: unknown = { first: record, second: record, ...flags };
  replies: unknown[] = [];
  bindHold: Promise<unknown> | undefined;
  observeHold: Promise<unknown> | undefined;
  closeHold: Promise<void> | undefined;
  createFailure = false;
  closeFailure = false;
  readonly raw = {
    abi: (): unknown => abi,
    create: (pid: unknown, uid: unknown, parent: unknown): object => {
      this.calls.push("create"); assert.equal(pid, 123); assert.equal(uid, 501); assert.equal(parent, 100);
      if (this.createFailure) throw new Error("Owned acquisition failure."); return this.owner;
    },
    bindCandidate: (owner: unknown): Promise<unknown> => {
      assert.equal(owner, this.owner); this.calls.push("bind"); return this.bindHold ?? Promise.resolve(this.bindReply);
    },
    observe: (owner: unknown): Promise<unknown> => {
      assert.equal(owner, this.owner); this.calls.push("observe");
      return this.observeHold ?? Promise.resolve(this.replies.shift() ?? { second: record, ...flags });
    },
    close: (owner: unknown): Promise<void> => {
      assert.equal(owner, this.owner); this.calls.push("close");
      if (this.closeFailure) throw new Error("Owned synchronous close failure."); return this.closeHold ?? Promise.resolve();
    },
  };
}
function fixture(fake = new FakeNative(), limits: unknown = {}): { fake: FakeNative; boundary: MacKernelRetirementBoundary; epoch: string } {
  const epoch = randomUUID();
  return { fake, epoch, boundary: new MacKernelRetirementBoundary(captureMacKernelRetirementNative(fake.raw),
    { pid: 123, uid: 501, parentPid: 100, epoch }, limits) };
}

test("production Mac boundary captures its owner synchronously and performs no helper challenge", async () => {
  const { fake, boundary, epoch } = fixture();
  assert.deepEqual(fake.calls, ["create"]); assert.equal(boundary.current.level, "ambiguous");
  const binding = boundary.bind(signal()); assert.equal(binding, boundary.bind(signal()));
  assert.equal(await binding, boundary);
  assert.deepEqual(fake.calls, ["create", "bind"]);
  assert.deepEqual(boundary.initial, { level: "running", canAdmit: true,
    identity: { pid: 123, uid: 501, parentPid: 100, epoch, birth: { platform: "darwin", seconds: record.seconds, micros: 12345 } } });
  assert.equal((await boundary.observe(signal())).level, "running"); await boundary.settleReads(); await boundary.settleReads();
  assert.equal(fake.calls.filter((call) => call === "close").length, 1);
  // Observer disposal cannot relabel a live process reaped.
  assert.equal(boundary.current.level, "running");
});
test("native production ABI rejects probe roles, hooks, unknown fields and missing methods before owner acquisition", () => {
  for (const value of [null, {}, { ...new FakeNative().raw, abi: () => ({ ...abi, probeOnly: true }) },
    { ...new FakeNative().raw, abi: () => ({ ...abi, role: "probe" }) },
    { ...new FakeNative().raw, abi: () => ({ ...abi, zombieLookupArgument: 0 }) },
    { ...new FakeNative().raw, abi: () => ({ ...abi, napiVersion: 9 }) },
    { ...new FakeNative().raw, abi: () => ({ ...abi, mainOnly: false }) },
    { ...new FakeNative().raw, abi: () => ({ ...abi, extra: true }) },
    { ...new FakeNative().raw, observe: undefined }, { ...new FakeNative().raw, createSynthetic: () => ({}) },
    { ...new FakeNative().raw, holdNext: () => {} }, { ...new FakeNative().raw, sdk: () => ({}) }]) {
    assert.throws(() => captureMacKernelRetirementNative(value), MacRetirementError);
  }
});
test("captured native methods cannot be redirected by later exports mutation", async () => {
  const fake = new FakeNative(), native = captureMacKernelRetirementNative(fake.raw);
  fake.raw.bindCandidate = () => { throw new Error("A later mutable export must not run."); };
  const boundary = new MacKernelRetirementBoundary(native, { pid: 123, uid: 501, parentPid: 100, epoch: randomUUID() });
  await boundary.bind(signal()); await boundary.settleReads(); assert.deepEqual(fake.calls, ["create", "bind", "close"]);
});
test("Mac launch rejects helper-provided topology, root facts, malformed epochs and injected clock options", () => {
  const fake = new FakeNative(), native = captureMacKernelRetirementNative(fake.raw);
  for (const value of [{ pid: 123, uid: 0, parentPid: 100, epoch: randomUUID() },
    { pid: 123, uid: 501, parentPid: 123, epoch: randomUUID() }, { pid: 123, uid: 501, parentPid: 100, epoch: "invalid" },
    { pid: 123, uid: 501, parentPid: 100, epoch: randomUUID(), name: "Unselected content" }]) {
    assert.throws(() => new MacKernelRetirementBoundary(native, value), MacRetirementError);
  }
  assert.throws(() => fixture(undefined, { now: () => 0 }), MacRetirementError);
  assert.deepEqual(fake.calls, []);
});
test("synchronous native acquisition refusal publishes no bind or replacement query", () => {
  const fake = new FakeNative(); fake.createFailure = true;
  assert.throws(() => fixture(fake), MacRetirementError); assert.deepEqual(fake.calls, ["create"]);
});
test("initial zombie without a registered watch keeps its original identity until actual absence", async () => {
  const fake = new FakeNative(), unregistered = { watched: false, exitSeen: false, cloexec: true };
  fake.bindReply = { first: record, second: { ...record, state: "zombie" }, ...unregistered };
  fake.replies = [{ second: { ...record, state: "zombie" }, ...unregistered }, { second: { kind: "absent" }, ...unregistered }];
  const { boundary, epoch } = fixture(fake); await boundary.bind(signal());
  assert.equal(boundary.initial.level, "non-running"); assert.equal(boundary.initial.canAdmit, false);
  assert.equal(boundary.initial.identity?.epoch, epoch); assert.equal(boundary.initial.identity?.pid, 123);
  const zombie = await boundary.observe(signal()); assert.equal(zombie.level, "non-running"); assert.equal(zombie.identity, boundary.initial.identity);
  await boundary.waitForRetirement(signal()); assert.deepEqual(await boundary.observe(signal()), { level: "reaped", identity: null });
  await boundary.settleReads(); assert.equal(boundary.current.level, "reaped");
});
test("watch registration ESRCH with an absent second snapshot establishes reap, never running admission", async () => {
  const fake = new FakeNative(); fake.bindReply = { first: record, second: { kind: "absent" }, watched: false, exitSeen: false, cloexec: true };
  const { boundary } = fixture(fake); await boundary.bind(signal());
  assert.deepEqual(boundary.initial, { level: "reaped", identity: null, canAdmit: false });
  await boundary.waitForRetirement(signal()); await boundary.observe(signal()); await boundary.settleReads();
  assert.deepEqual(fake.calls, ["create", "bind", "close"]);
});
test("post-await cancellation cannot issue a cached reap receipt to an expired caller", async () => {
  for (const kind of ["observe", "wait"] as const) {
    const fake = new FakeNative(); fake.bindReply = { first: record, second: { kind: "absent" }, ...flags };
    const { boundary } = fixture(fake); await boundary.bind(signal());
    const controller = new AbortController();
    const pending = kind === "observe" ? boundary.observe(controller.signal) : boundary.waitForRetirement(controller.signal);
    controller.abort(); await rejects(pending); assert.equal(boundary.current.level, "reaped"); await boundary.settleReads();
    assert.deepEqual(fake.calls, ["create", "bind", "close"]);
  }
});
test("late binding availability cannot bypass the wait call's own elapsed budget", async () => {
  const fake = new FakeNative(); fake.bindReply = { first: record, second: { kind: "absent" }, ...flags };
  const { boundary } = fixture(fake, { deadlineMs: 250, pollMs: 1 });
  const binding = boundary.bind(signal()), waiting = boundary.waitForRetirement(signal());
  // The query has not dispatched yet. Its own budget starts after this bounded
  // inert delay, while the independent wait's budget has already expired.
  const until = performance.now() + 300;
  while (performance.now() < until) { /* No proc query or native operation. */ }
  await binding; await rejects(waiting);
  assert.equal(boundary.current.level, "reaped"); await boundary.settleReads();
  assert.deepEqual(fake.calls, ["create", "bind", "close"]);
});
test("initial absent snapshots require the exact no-watch shape", async () => {
  const fake = new FakeNative(); fake.bindReply = { first: { kind: "absent" }, second: { kind: "absent" }, watched: false, exitSeen: false, cloexec: false };
  const { boundary } = fixture(fake); await boundary.bind(signal()); assert.equal(boundary.initial.level, "reaped"); await boundary.settleReads();
  for (const wrong of [{ first: { kind: "absent" }, second: record, watched: false, exitSeen: false, cloexec: false },
    { first: { kind: "absent" }, second: { kind: "absent" }, ...flags }]) {
    const other = new FakeNative(); other.bindReply = wrong;
    const scoped = fixture(other).boundary; await rejects(scoped.bind(signal())); await scoped.settleReads();
  }
});
test("a live unregistered watch and malformed flag topology cannot admit or manufacture reaping", async () => {
  for (const value of [{ watched: false, exitSeen: false, cloexec: true }, { watched: true, exitSeen: false, cloexec: false },
    { watched: false, exitSeen: true, cloexec: true }]) {
    const fake = new FakeNative(); fake.bindReply = { first: record, second: record, ...value };
    const { boundary } = fixture(fake); await rejects(boundary.bind(signal())); assert.equal(boundary.initial.canAdmit, false);
    assert.equal(boundary.current.level, "ambiguous"); await boundary.settleReads();
    assert.equal(boundary.current.level, "ambiguous"); assert.equal(fake.calls.filter((call) => call === "close").length, 1);
  }
});
test("NOTE_EXIT is non-running and only a later zombie-inclusive absence releases the original birth", async () => {
  const { fake, boundary } = fixture(); await boundary.bind(signal());
  fake.replies = [{ second: record, ...flags, exitSeen: true }, { second: { ...record, state: "zombie" }, ...flags, exitSeen: true },
    { second: { kind: "absent" }, ...flags, exitSeen: true }];
  assert.equal((await boundary.observe(signal())).level, "non-running"); assert.equal((await boundary.observe(signal())).level, "non-running");
  assert.equal((await boundary.observe(signal())).level, "reaped"); await boundary.settleReads();
});
test("a changed birth proves only the original process reaped and never adopts replacement UID or parent", async () => {
  const { fake, boundary } = fixture(); await boundary.bind(signal());
  fake.replies = [{ second: { ...record, seconds: record.seconds + 1n, uid: 999, realUid: 999, savedUid: 999, parentPid: 999 }, ...flags }];
  assert.deepEqual(await boundary.observe(signal()), { level: "reaped", identity: null });
  assert.equal(boundary.initial.identity?.birth.platform, "darwin"); assert.equal(boundary.initial.identity?.uid, 501); await boundary.settleReads();
});
test("a birth change between valid bind snapshots cannot admit a replacement", async () => {
  const fake = new FakeNative(); fake.bindReply = { first: record, second: { ...record, micros: record.micros + 1n, parentPid: 999 }, ...flags };
  const { boundary } = fixture(fake); await boundary.bind(signal()); assert.equal(boundary.initial.level, "reaped");
  assert.equal(boundary.initial.identity, null); assert.equal(boundary.initial.canAdmit, false); await boundary.settleReads();
});
test("unchanged birth with wrong PID or UID topology fails closed", async () => {
  for (const changed of [{ ...record, pid: 124 }, { ...record, uid: 999 }, { ...record, realUid: 999 },
    { ...record, savedUid: 999 }, { ...record, parentPid: 999 }]) {
    const { fake, boundary } = fixture(); await boundary.bind(signal()); fake.replies = [{ second: changed, ...flags }];
    await rejects(boundary.observe(signal())); assert.equal(boundary.current.level, "ambiguous"); await boundary.settleReads();
  }
});
test("native malformed, short, refused and out-of-range birth records cannot acquire a witness", async () => {
  for (const value of [{ ...record, state: "unknown" }, { ...record, name: "Unselected content" }, { ...record, micros: 1_000_000n },
    { ...record, seconds: (1n << 63n) }, { ...record, seconds: Number(record.seconds) }, { kind: "failure", category: "ACCESS_REFUSED" },
    { kind: "failure", category: "SHORT_RECORD" }, { kind: "failure", category: "SYNTHETIC_ONLY" }]) {
    const fake = new FakeNative(); fake.bindReply = { first: value, second: value, ...flags };
    const { boundary } = fixture(fake); await rejects(boundary.bind(signal())); await boundary.settleReads(); assert.equal(boundary.current.level, "ambiguous");
  }
});
test("old helper nonce replies are not a kernel bind frame and never cause a third challenge", async () => {
  const fake = new FakeNative(); fake.bindReply = { kind: "nonce", epoch: randomUUID(), nonce: randomUUID() };
  const { boundary } = fixture(fake); await rejects(boundary.bind(signal())); await boundary.settleReads(); assert.deepEqual(fake.calls, ["create", "bind", "close"]);
});
test("watch flags cannot disappear and observed exit cannot regress", async () => {
  for (const value of [{ watched: false, exitSeen: false, cloexec: true }, { watched: true, exitSeen: false, cloexec: false },
    { watched: true, exitSeen: false, cloexec: true }]) {
    const { fake, boundary } = fixture(); await boundary.bind(signal());
    fake.replies = [{ second: record, ...flags, exitSeen: true }, { second: record, ...value }];
    await boundary.observe(signal()); await rejects(boundary.observe(signal())); await boundary.settleReads();
  }
});
test("abort before native bind dispatch retains and closes only the original acquired owner", async () => {
  const { fake, boundary } = fixture(), controller = new AbortController();
  const binding = boundary.bind(controller.signal); controller.abort(); await rejects(binding); await boundary.settleReads();
  assert.deepEqual(fake.calls, ["create", "close"]); assert.equal(boundary.initial.canAdmit, false);
});
test("a held failed bind retains its exact transaction and waits late work even if close reports success early", async () => {
  const fake = new FakeNative(), held = deferred<unknown>(); fake.bindHold = held.promise;
  const { boundary } = fixture(fake, { deadlineMs: heldFixtureDeadlineMs, pollMs: 1 }), binding = boundary.bind(signal());
  await rejects(binding); assert.equal(boundary.bind(signal()), binding);
  await rejects(boundary.settleReads()); assert.equal(fake.calls.filter((call) => call === "bind").length, 1);
  held.accept(fake.bindReply); await boundary.settleReads(); assert.equal(boundary.current.level, "ambiguous");
  assert.equal(fake.calls.filter((call) => call === "close").length, 1);
});
test("aborted observation cannot publish a late reaped result or queue another query", async () => {
  const { fake, boundary } = fixture(); await boundary.bind(signal());
  const held = deferred<unknown>(); fake.observeHold = held.promise;
  const controller = new AbortController(), observing = boundary.observe(controller.signal); await flush(); controller.abort(); await rejects(observing);
  held.accept({ second: { kind: "absent" }, ...flags }); await flush();
  await rejects(boundary.observe(signal())); assert.equal(boundary.current.level, "ambiguous"); await boundary.settleReads();
  assert.equal(fake.calls.filter((call) => call === "observe").length, 1);
});
test("a concurrent query poisons admission and keeps only the original accepted native work", async () => {
  const { fake, boundary } = fixture(); await boundary.bind(signal());
  const held = deferred<unknown>(); fake.observeHold = held.promise;
  const first = boundary.observe(signal()); await flush(); await rejects(boundary.observe(signal()));
  held.accept({ second: record, ...flags }); await rejects(first); await boundary.settleReads();
  assert.equal(fake.calls.filter((call) => call === "observe").length, 1); assert.equal(boundary.current.level, "ambiguous");
});
test("monotonic expiry rejects a completed microtask reply before a delayed timer can run", async () => {
  const fake = new FakeNative(); fake.raw.bindCandidate = () => {
    fake.calls.push("bind"); const until = performance.now() + 25;
    while (performance.now() < until) { /* Bounded synthetic event-loop delay, no kernel effects. */ }
    return Promise.resolve(fake.bindReply);
  };
  const { boundary } = fixture(fake, { deadlineMs: 10, pollMs: 1 }); await rejects(boundary.bind(signal()));
  assert.equal(boundary.current.level, "ambiguous"); await boundary.settleReads(); assert.deepEqual(fake.calls, ["create", "bind", "close"]);
});
test("held observer close has one retained promise and successful retry after actual completion", async () => {
  const fake = new FakeNative(), held = deferred<void>(); fake.closeHold = held.promise;
  const { boundary } = fixture(fake, { deadlineMs: heldFixtureDeadlineMs, pollMs: 1 }); await boundary.bind(signal());
  fake.replies = [{ second: { kind: "absent" }, ...flags }]; await boundary.observe(signal());
  await rejects(boundary.settleReads()); await rejects(boundary.settleReads()); assert.equal(fake.calls.filter((call) => call === "close").length, 1);
  held.accept(); await boundary.settleReads(); assert.equal(boundary.current.level, "reaped");
});
test("synchronously throwing close stays rejected with no second native close or fabricated disposal", async () => {
  const { fake, boundary } = fixture(); await boundary.bind(signal()); fake.closeFailure = true;
  await rejects(boundary.settleReads()); fake.closeFailure = false; await rejects(boundary.settleReads());
  assert.equal(fake.calls.filter((call) => call === "close").length, 1); assert.equal(boundary.current.level, "ambiguous");
});
test("observer cleanup after full reap failure retains the original reap proof but never certifies FD cleanup", async () => {
  const { fake, boundary } = fixture(); await boundary.bind(signal()); fake.replies = [{ second: { kind: "absent" }, ...flags }];
  await boundary.observe(signal()); fake.closeFailure = true; await rejects(boundary.settleReads()); await rejects(boundary.settleReads());
  assert.equal(boundary.current.level, "reaped"); assert.equal(fake.calls.filter((call) => call === "close").length, 1);
});
test("a synchronous bind throw retains disposal and never publishes a second owner transaction", async () => {
  const fake = new FakeNative(); fake.raw.bindCandidate = () => { fake.calls.push("bind"); throw new Error("Owned refusal."); };
  const { boundary } = fixture(fake), binding = boundary.bind(signal()); await rejects(binding); assert.equal(boundary.bind(signal()), binding);
  await boundary.settleReads(); assert.deepEqual(fake.calls, ["create", "bind", "close"]); assert.equal(boundary.initial.canAdmit, false);
});
test("close before bind dispatch fences the queued operation without native query effects", async () => {
  const { fake, boundary } = fixture(), binding = boundary.bind(signal()), closing = boundary.settleReads();
  await rejects(binding); await closing; assert.deepEqual(fake.calls, ["create", "close"]); assert.equal(boundary.current.level, "ambiguous");
});
test("zombie-only polling expires without claiming full reap", async () => {
  const fake = new FakeNative(); fake.bindReply = { first: record, second: { ...record, state: "zombie" }, ...flags };
  fake.replies = Array.from({ length: 100 }, () => ({ second: { ...record, state: "zombie" }, ...flags }));
  const { boundary } = fixture(fake, { deadlineMs: heldFixtureDeadlineMs, pollMs: 1 }); await boundary.bind(signal());
  await rejects(boundary.waitForRetirement(signal())); assert.equal(boundary.current.level, "ambiguous"); await boundary.settleReads();
});
test("immutable native ABI captures reject non-Promise operations and nonempty close receipts", async () => {
  const first = new FakeNative(); const rawBind = { ...first.raw, bindCandidate: () => first.bindReply };
  const boundary = new MacKernelRetirementBoundary(captureMacKernelRetirementNative(rawBind), { pid: 123, uid: 501, parentPid: 100, epoch: randomUUID() });
  await rejects(boundary.bind(signal())); await boundary.settleReads();
  const second = new FakeNative(), rawClose = { ...second.raw, close: async () => "invalid" };
  const other = new MacKernelRetirementBoundary(captureMacKernelRetirementNative(rawClose), { pid: 123, uid: 501, parentPid: 100, epoch: randomUUID() });
  await other.bind(signal()); await rejects(other.settleReads());
});

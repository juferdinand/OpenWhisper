import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { classifyMacRetirement, MacRetirementError, OwnedMacRetirementProbe } from "../src/services/macos-process-retirement.js";
import type { MacProcessRecord, MacRetirementNative, MacTrustedUtility } from "../src/services/macos-process-retirement.js";

const record: MacProcessRecord = Object.freeze({ kind: "record", pid: 123, parentPid: 100, uid: 501, realUid: 501, savedUid: 501,
  seconds: 1_700_000_000n, micros: 12345n, state: "sleeping" });
const flags = { watched: true, exitSeen: false, cloexec: true };
function deferred<T>(): { promise: Promise<T>; accept: (value: T) => void; reject: (error: unknown) => void } {
  let accept!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, failure) => { accept = resolve; reject = failure; });
  return { promise, accept, reject };
}
class FakeNative implements MacRetirementNative {
  calls: string[] = []; owner = {}; active = false; closes = 0;
  bindReply: unknown = { first: record, second: record, ...flags };
  replies: unknown[] = [{ second: record, ...flags }];
  hold: Promise<unknown> | undefined;
  closeHold: Promise<void> | undefined;
  create(process: number, user: number, parent: number): object {
    assert.equal(process, 123); assert.equal(user, 501); assert.equal(parent, 100);
    if (this.active) throw new Error("Fixture owner remains reserved.");
    this.active = true; this.calls.push("create"); return this.owner;
  }
  bindCandidate(owner: object): Promise<unknown> { assert.equal(owner, this.owner); this.calls.push("bind"); return this.hold ?? Promise.resolve(this.bindReply); }
  observe(owner: object): Promise<unknown> {
    assert.equal(owner, this.owner); this.calls.push("observe"); return this.hold ?? Promise.resolve(this.replies.shift() ?? { second: record, ...flags });
  }
  async close(owner: object): Promise<void> {
    assert.equal(owner, this.owner); this.calls.push("close"); this.closes += 1;
    if (this.hold) await this.hold.catch(() => undefined);
    if (this.closeHold) await this.closeHold;
    this.active = false;
  }
}
function fixture(native = new FakeNative(), options: unknown = { deadlineMs: 30, pollMs: 1 },
  challenge?: MacTrustedUtility["challenge"]): { native: FakeNative; probe: OwnedMacRetirementProbe } {
  const utility: MacTrustedUtility = { pid: 123, challenge: challenge ?? (async (nonce, epoch) => {
    native.calls.push("challenge"); return { kind: "nonce", nonce, epoch };
  }) };
  return { native, probe: new OwnedMacRetirementProbe(native, utility, randomUUID(), { uid: 501, parentPid: 100 }, options) };
}
const rejects = async (effect: Promise<unknown>): Promise<void> => { await assert.rejects(effect, (error: unknown) => error instanceof MacRetirementError && error.code === "TEARDOWN_FAILED"); };

test("Mac candidate binding requires a fresh original-channel nonce between watch binding and final birth snapshot", async () => {
  const { native, probe } = fixture();
  assert.equal((await probe.bind()).canAdmit, true);
  assert.deepEqual(native.calls, ["create", "bind", "challenge", "observe"]);
  await probe.close(); await probe.close(); assert.equal(native.closes, 1);
});
test("Mac initial zombie and absence never admit work and an unregistered live record is ambiguous", async () => {
  for (const kind of ["zombie", "absent", "unwatched"] as const) {
    const native = new FakeNative();
    native.bindReply = kind === "absent" ? { first: { kind: "absent" }, second: { kind: "absent" }, watched: false, exitSeen: false, cloexec: false }
      : { first: record, second: kind === "zombie" ? { ...record, state: "zombie" } : record, ...flags, watched: false };
    const { probe } = fixture(native);
    if (kind === "unwatched") await rejects(probe.bind());
    else { const result = await probe.bind(); assert.equal(result.canAdmit, false); assert.equal(result.level, kind === "absent" ? "reaped" : "non-running"); }
    assert.equal(native.calls.includes("challenge"), false); await probe.close();
  }
});
test("Mac NOTE_EXIT and same-birth zombie retain the full-reap gate", () => {
  assert.equal(classifyMacRetirement(record, record, true).level, "non-running");
  assert.equal(classifyMacRetirement(record, { ...record, state: "zombie" }, false).level, "non-running");
  assert.equal(classifyMacRetirement(record, { kind: "absent" }, true).level, "reaped");
  assert.equal(classifyMacRetirement(record, { ...record, micros: record.micros + 1n }, false).level, "reaped");
  assert.equal(classifyMacRetirement(record, { ...record }, false).level, "running");
});
test("Mac changed birth is replacement evidence without adopting a changed parent or UID", () => {
  assert.equal(classifyMacRetirement(record, { ...record, seconds: record.seconds + 1n, parentPid: 999, uid: 502 }, false).level, "reaped");
  for (const value of [{ ...record, uid: 502 }, { ...record, parentPid: 999 }, { ...record, pid: 124 }, { ...record, realUid: 502 }, { ...record, savedUid: 502 }]) {
    assert.throws(() => classifyMacRetirement(record, value, false), MacRetirementError);
  }
});
test("Mac access refusal, short records, unknown state, malformed time and unselected fields fail closed", () => {
  for (const value of [{ kind: "failure", category: "ACCESS_REFUSED" }, { kind: "failure", category: "SHORT_RECORD" },
    { kind: "failure", category: "SYSCALL_FAILED" }, { ...record, state: "unknown" }, { ...record, micros: 1_000_000n },
    { ...record, seconds: 0n }, { ...record, seconds: Number(record.seconds) }, { ...record, name: "Unselected content" }]) {
    assert.throws(() => classifyMacRetirement(record, value, false), MacRetirementError);
  }
});
test("Mac first and second birth mismatch or UID topology mismatch cannot acquire readiness", async () => {
  for (const second of [{ ...record, micros: 99n }, { ...record, parentPid: 111 }, { ...record, savedUid: 502 }]) {
    const native = new FakeNative(); native.bindReply = { first: record, second, ...flags };
    const { probe } = fixture(native); await rejects(probe.bind()); assert.equal(native.calls.includes("challenge"), false); await probe.close();
  }
});
test("Mac stale nonce or epoch and birth loss after challenge cannot authorize work", async () => {
  for (const kind of ["nonce", "epoch", "gone"] as const) {
    const native = new FakeNative();
    if (kind === "gone") native.replies = [{ second: { kind: "absent" }, ...flags }];
    const { probe } = fixture(native, undefined, async (nonce, epoch) => ({ kind: "nonce", nonce: kind === "nonce" ? randomUUID() : nonce,
      epoch: kind === "epoch" ? randomUUID() : epoch }));
    if (kind === "gone") { const result = await probe.bind(); assert.equal(result.canAdmit, false); assert.equal(result.level, "reaped"); }
    else await rejects(probe.bind());
    await probe.close();
  }
});
test("Mac a held native bind deadline retains its owner and permits neither a second query nor premature close", async () => {
  const native = new FakeNative(), held = deferred<unknown>(); native.hold = held.promise;
  const { probe } = fixture(native, { deadlineMs: 10, pollMs: 1 });
  await rejects(probe.bind()); await rejects(probe.observe());
  assert.equal(native.active, true); assert.throws(() => fixture(native), MacRetirementError);
  await rejects(probe.close()); assert.equal(native.closes, 1); assert.equal(native.active, true);
  held.accept(native.bindReply); await probe.close(); assert.equal(native.closes, 1); assert.equal(native.active, false);
  assert.deepEqual(native.calls, ["create", "bind", "close"]);
});
test("Mac abort during an observation cannot let a late reaped result affect admission", async () => {
  const { native, probe } = fixture(); await probe.bind();
  const held = deferred<unknown>(); native.hold = held.promise;
  const controller = new AbortController(), observing = probe.observe(controller.signal);
  await Promise.resolve(); controller.abort(); await rejects(observing);
  held.accept({ second: { kind: "absent" }, ...flags }); await Promise.resolve();
  await rejects(probe.observe()); await probe.close(); assert.equal(native.calls.filter((value) => value === "observe").length, 2);
});
test("Mac pre-dispatch abort queues no native operation", async () => {
  const { native, probe } = fixture(); const controller = new AbortController();
  const binding = probe.bind(controller.signal); controller.abort(); await rejects(binding);
  assert.deepEqual(native.calls, ["create"]); await probe.close();
});
test("Mac a held close retains one native promise for explicit cleanup retry", async () => {
  const native = new FakeNative(), held = deferred<void>(); native.closeHold = held.promise;
  const { probe } = fixture(native, { deadlineMs: 10, pollMs: 1 }); await probe.bind();
  await rejects(probe.close()); await rejects(probe.close()); assert.equal(native.closes, 1); assert.equal(native.active, true);
  held.accept(); await probe.close(); assert.equal(native.active, false); assert.equal(native.closes, 1);
});
test("Mac full-reap polling never accepts a sequence containing only NOTE_EXIT and zombie", async () => {
  const { native, probe } = fixture(undefined, { deadlineMs: 10, pollMs: 1 }); await probe.bind();
  native.replies = Array.from({ length: 20 }, () => ({ second: { ...record, state: "zombie" }, ...flags, exitSeen: true }));
  await rejects(probe.waitForFullReap()); await probe.close();
});
test("Mac full-reap polling accepts zombie-inclusive absence after original binding", async () => {
  const { native, probe } = fixture(); await probe.bind();
  native.replies = [{ second: { ...record, state: "zombie" }, ...flags, exitSeen: true }, { second: { kind: "absent" }, ...flags, exitSeen: true }];
  await probe.waitForFullReap(); await probe.close();
});
test("Mac monotonic expiry rejects a native reply that wins the microtask race before its timer callback", async () => {
  const native = new FakeNative(); let now = 0;
  native.bindCandidate = async () => { native.calls.push("bind"); now = 31; return native.bindReply; };
  const probe = new OwnedMacRetirementProbe(native, { pid: 123, challenge: async () => { throw new Error("Must not challenge."); } },
    randomUUID(), { uid: 501, parentPid: 100, now: () => now }, { deadlineMs: 30, pollMs: 1 });
  await rejects(probe.bind()); assert.equal(native.active, true); assert.deepEqual(native.calls, ["create", "bind"]);
  await rejects(probe.observe()); await probe.close(); assert.equal(native.closes, 1);
});

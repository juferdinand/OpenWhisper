import test from "node:test";
import assert from "node:assert/strict";
import { OwnedDaemon, daemonDiagnosisSchema, type DaemonHandle, type DaemonWitness } from "./daemon-owner.js";
import { WitnessRefusal, type Birth, type Observation } from "./process-witness.js";
import { setTimeout as pause } from "node:timers/promises";

const birth: Birth = { pid: 77, parentPid: 42, ticks: "123" };
const running: Observation = { level: "running", reason: "same-birth" };
const absent: Observation = { level: "absent", reason: "absence" };
class Handle implements DaemonHandle {
  readonly pid = 77;
  readonly registered: string[] = [];
  signals = 0;
  signal: () => void = () => { this.emitExit(); this.emitClose(); };
  private exit: ((code: unknown, signal: unknown) => void) | undefined;
  private close: ((code: unknown, signal: unknown) => void) | undefined;
  private error: ((error: unknown) => void) | undefined;
  onExit(callback: (code: unknown, signal: unknown) => void): void { this.registered.push("exit"); this.exit = callback; }
  onClose(callback: (code: unknown, signal: unknown) => void): void { this.registered.push("close"); this.close = callback; }
  onError(callback: (error: unknown) => void): void { this.registered.push("error"); this.error = callback; }
  signalTerminate(): boolean { this.signals++; assert.deepEqual(this.registered, ["exit", "close", "error"]); this.signal(); return true; }
  emitExit(code: unknown = 0, signal: unknown = "SIGTERM"): void { this.exit?.(code, signal); }
  emitClose(code: unknown = 0, signal: unknown = "SIGTERM"): void { this.close?.(code, signal); }
  emitError(error: unknown): void { this.error?.(error); }
}
function fixture(overrides: Partial<DaemonWitness> = {}, persist: (value: ReturnType<OwnedDaemon["snapshot"]>) => void = () => undefined) {
  const handle = new Handle(); let binds = 0, observations = 0, finals = 0;
  const witness: DaemonWitness = {
    bind: async (pid, parentPid) => { binds++; assert.equal(pid, birth.pid); assert.equal(parentPid, birth.parentPid);
      return overrides.bind ? overrides.bind(pid, parentPid) : birth; },
    observe: async (value) => { observations++; assert.deepEqual(value, birth); return overrides.observe ? overrides.observe(value) : running; },
    nonRunning: async (value, remaining) => { finals++; assert.deepEqual(value, birth); assert.ok(remaining > 0);
      return overrides.nonRunning ? overrides.nonRunning(value, remaining) : absent; },
  };
  const owner = new OwnedDaemon(handle, persist, witness);
  return { handle, owner, counts: () => ({ binds, observations, finals }) };
}
test("original listeners cannot miss synchronous signal exit and close and final kernel proof is required", async () => {
  const f = fixture(); await f.owner.admitAfterReadiness(42, 100);
  const first = f.owner.retire(100); assert.equal(f.owner.retire(100), first);
  assert.deepEqual(await first, absent); assert.deepEqual(f.counts(), { binds: 1, observations: 1, finals: 1 });
  assert.equal(f.handle.signals, 1); assert.deepEqual(f.owner.snapshot().birth, birth);
  const stages = f.owner.snapshot().stages.map((value) => value.stage);
  assert.ok(stages.indexOf("DAEMON_EXIT_OBSERVED") < stages.indexOf("DAEMON_FINAL_OBSERVATION"));
  assert.ok(stages.indexOf("DAEMON_CLOSE_OBSERVED") < stages.indexOf("DAEMON_FINAL_OBSERVATION"));
});
test("exit alone cannot certify or trigger final lookup while the original close event is held", async () => {
  const f = fixture(); await f.owner.admitAfterReadiness(42, 100); f.handle.emitExit();
  let settled = false; const pending = f.owner.retire(100).finally(() => { settled = true; });
  await pause(5); assert.equal(settled, false); assert.equal(f.counts().finals, 0); assert.equal(f.handle.signals, 0);
  f.handle.emitClose(); assert.deepEqual(await pending, absent); assert.equal(f.counts().finals, 1);
});
test("already exited daemon still needs fresh kernel proof and never rebinds a late PID", async () => {
  const f = fixture({ nonRunning: async () => { throw new WitnessRefusal("BIRTH_CHANGED", "LOOKUP"); } });
  await f.owner.admitAfterReadiness(42, 100); f.handle.emitExit(); f.handle.emitClose();
  await assert.rejects(f.owner.retire(100)); assert.equal(f.handle.signals, 0); assert.equal(f.counts().binds, 1);
  assert.equal(f.owner.snapshot().refusal?.witness?.reason, "BIRTH_CHANGED");
  assert.equal(f.owner.snapshot().finalObservation, null); assert.equal(f.counts().finals, 1);
  await assert.rejects(f.owner.admitAfterReadiness(42, 100)); assert.equal(f.counts().binds, 1);
});
test("null-event lag with a same-birth zombie waits for original events before fresh final observation", async () => {
  const f = fixture({ observe: async () => ({ level: "non-running", reason: "zombie" }) });
  await f.owner.admitAfterReadiness(42, 100);
  let settled = false; const pending = f.owner.retire(100).finally(() => { settled = true; });
  await pause(5); assert.equal(settled, false); assert.equal(f.handle.signals, 0); assert.equal(f.counts().finals, 0);
  f.handle.emitExit(); f.handle.emitClose(); assert.deepEqual(await pending, absent); assert.equal(f.counts().finals, 1);
});
test("held original completion consumes one cleanup deadline and cannot allocate a second budget", async () => {
  const f = fixture(); f.handle.signal = () => f.handle.emitExit(); await f.owner.admitAfterReadiness(42, 100);
  const pending = f.owner.retire(10); await assert.rejects(pending); f.handle.emitClose();
  assert.equal(f.owner.retire(100), pending); await assert.rejects(f.owner.retire(100));
  assert.equal(f.counts().finals, 0); assert.equal(f.owner.snapshot().refusal?.witness?.reason, "DEADLINE_EXPIRED");
});
test("late completion and late final kernel observation are refused after the same monotonic deadline", async () => {
  for (const late of ["completion", "final"] as const) {
    const f = fixture({ nonRunning: async () => {
      if (late === "final") { const end = performance.now() + 15; while (performance.now() < end) { /* Inert delayed lookup. */ } }
      return absent;
    } });
    await f.owner.admitAfterReadiness(42, 100);
    f.handle.signal = () => {
      if (late === "completion") { const end = performance.now() + 15; while (performance.now() < end) { /* Inert delayed terminal events. */ } }
      f.handle.emitExit(); f.handle.emitClose();
    };
    await assert.rejects(f.owner.retire(5)); assert.equal(f.owner.snapshot().refusal?.witness?.reason, "DEADLINE_EXPIRED");
    assert.equal(f.owner.snapshot().finalObservation, null);
    assert.equal(f.counts().finals, late === "completion" ? 0 : 1);
    assert.equal(f.owner.snapshot().stages.some((value) => value.stage === "DAEMON_FINAL_OBSERVATION"), late === "final");
  }
});
test("ESRCH before signal or after original completion remains a sticky refusal", async () => {
  for (const boundary of ["before", "final"] as const) {
    const refusal = (): Promise<Observation> => Promise.reject(new WitnessRefusal("READ_REFUSED", "FIRST_STAT", "ESRCH"));
    const f = fixture(boundary === "before" ? { observe: refusal } : { nonRunning: refusal });
    await f.owner.admitAfterReadiness(42, 100);
    if (boundary === "final") { f.handle.emitExit(); f.handle.emitClose(); }
    const cleanup = f.owner.retire(100); await assert.rejects(cleanup);
    assert.equal(f.handle.signals, 0); assert.equal(f.owner.retire(100), cleanup);
    assert.deepEqual(f.owner.snapshot().refusal?.witness, { reason: "READ_REFUSED", component: "FIRST_STAT", ioCode: "ESRCH" });
    assert.equal(f.owner.snapshot().finalObservation, null);
  }
});
test("diagnostic persistence cannot hide an expired budget before the retirement Promise settles", async () => {
  let held = false;
  const f = fixture({}, (value) => {
    if (!held && value.stages.at(-1)?.stage === "DAEMON_RETIRED") {
      held = true; const end = performance.now() + 15; while (performance.now() < end) { /* Inert held evidence write. */ }
    }
  });
  await f.owner.admitAfterReadiness(42, 100); await assert.rejects(f.owner.retire(5));
  assert.equal(held, true); assert.equal(f.owner.snapshot().refusal?.witness?.reason, "DEADLINE_EXPIRED");
  assert.equal(f.owner.snapshot().stages.at(-1)?.stage, "DAEMON_RETIREMENT_REFUSED");
});
test("identity refusal and original process error retain categorical metadata without allowing a signal", async () => {
  for (const reason of ["UID_CHANGED", "TOPOLOGY_CHANGED", "BIRTH_CHANGED"] as const) {
    const f = fixture({ observe: async () => { throw new WitnessRefusal(reason, "SECOND_STAT"); } });
    await f.owner.admitAfterReadiness(42, 100); await assert.rejects(f.owner.retire(100));
    assert.equal(f.handle.signals, 0); assert.equal(f.owner.snapshot().refusal?.witness?.reason, reason);
  }
  const f = fixture(); await f.owner.admitAfterReadiness(42, 100);
  f.handle.emitError(Object.assign(new Error("arbitrary process detail"), { code: "EPERM" }));
  await assert.rejects(f.owner.retire(100)); assert.equal(f.handle.signals, 0);
  assert.equal(JSON.stringify(f.owner.snapshot()).includes("arbitrary process detail"), false);
  assert.equal(f.owner.snapshot().refusal?.code, "EPERM");
  assert.equal(daemonDiagnosisSchema.safeParse({ ...f.owner.snapshot(), rawStatus: "untrusted" }).success, false);
});

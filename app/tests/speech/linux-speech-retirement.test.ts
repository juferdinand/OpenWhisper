import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { backendObservationSchema } from "../../src/services/speech/backend-supervisor.js";
import { createLinuxSpeechRetirementAllocation, wrapLinuxSpeechWitness, type LinuxSpeechWitness } from "../../src/services/speech/linux-speech-retirement.js";
import type { InitialRetirementObservation, RetirementObservation } from "../../src/services/platform-lifecycle/process-retirement.js";
import { deferred, turn } from "../fixtures/speech-port.js";

function witness(initialLevel: RetirementObservation["level"] = "running") {
  let state: RetirementObservation = { level: initialLevel };
  let readClosures = 0, waits = 0;
  const identity = { pid: 1234, uid: 1000, parentPid: 4321, epoch: randomUUID(), startTicks: 15n };
  const initial: InitialRetirementObservation = { level: initialLevel, canAdmit: initialLevel === "running", identity: initialLevel === "reaped" ? null : identity };
  const source: LinuxSpeechWitness = { initial, get current() { return state; },
    async observe() { return state; }, async waitForRetirement() { waits++; }, async settleReads() { readClosures++; } };
  return { source, identity, state: (level: RetirementObservation["level"]) => { state = { level }; }, closures: () => readClosures, waits: () => waits };
}
test("running and non-running wrapper observations retain only initial candidate", async () => {
  const f = witness(), wrapped = wrapLinuxSpeechWitness(f.source), signal = new AbortController().signal;
  const first = backendObservationSchema.parse(await wrapped.observe(signal));
  assert.equal(first.identity?.birth.platform, "linux");
  f.state("non-running"); const second = backendObservationSchema.parse(await wrapped.observe(signal));
  assert.deepEqual(second.identity, first.identity); assert.equal(second.level, "non-running");
  f.state("reaped"); assert.deepEqual(await wrapped.observe(signal), { level: "reaped", identity: null });
  assert.deepEqual(wrapped.current, { level: "reaped" });
});
test("initial absence and ambiguity cannot become admission", async () => {
  for (const level of ["reaped", "ambiguous", "non-running"] as const) {
    const f = witness(level), wrapped = wrapLinuxSpeechWitness(f.source);
    assert.equal(f.source.initial.canAdmit, false);
    assert.deepEqual(wrapped.current, { level });
    if (level === "reaped") assert.deepEqual(wrapped.initial, { level, canAdmit: false, identity: null });
  }
});
test("ambiguous observation refuses identity and read closure is independent of reap", async () => {
  const f = witness(), wrapped = wrapLinuxSpeechWitness(f.source), signal = new AbortController().signal;
  f.state("ambiguous"); assert.deepEqual(await wrapped.observe(signal), { level: "ambiguous", identity: null });
  await wrapped.settleReads(); assert.equal(f.closures(), 1); assert.equal(f.waits(), 0);
  await wrapped.waitForRetirement(signal); assert.equal(f.waits(), 1);
});
test("malformed candidate and contradictory admission refuse fixed categorical error", () => {
  const f = witness();
  assert.throws(() => wrapLinuxSpeechWitness({ ...f.source, initial: { ...f.source.initial, identity: { ...f.identity, startTicks: 0n } } }), { code: "TEARDOWN_FAILED" });
  assert.throws(() => wrapLinuxSpeechWitness({ ...f.source, initial: { ...f.source.initial, canAdmit: false } }), { code: "TEARDOWN_FAILED" });
});
test("allocation stores original bind before invocation and memoizes converted boundary", async () => {
  const f = witness(), gate = deferred<LinuxSpeechWitness>(); let calls = 0;
  const allocation = createLinuxSpeechRetirementAllocation(() => { calls++; return gate.promise; });
  const first = allocation.bind(), second = allocation.bind(); assert.equal(first, second); assert.equal(calls, 0);
  await turn(); assert.equal(calls, 1);
  let settled = false; const barrier = allocation.settleReads().then(() => { settled = true; }); await turn(); assert.equal(settled, false);
  gate.accept(f.source); await first; await barrier; assert.equal(f.closures(), 1); assert.equal(calls, 1);
});
test("resolved witness remains retained after conversion rejection and actual FD barrier stays held", async () => {
  const f = witness(), reads = deferred<void>(); let calls = 0, barriers = 0;
  const bad: LinuxSpeechWitness = { ...f.source, initial: { ...f.source.initial, canAdmit: false },
    settleReads() { barriers++; return reads.promise; } };
  const allocation = createLinuxSpeechRetirementAllocation(async () => { calls++; return bad; });
  const first = allocation.bind(); await assert.rejects(first, { code: "TEARDOWN_FAILED" }); assert.equal(first, allocation.bind());
  let settled = false; const barrier = allocation.settleReads().then(() => { settled = true; }); await turn();
  assert.equal(barriers, 1); assert.equal(settled, false); reads.accept(); await barrier;
  assert.equal(calls, 1); await assert.rejects(allocation.bind(), { code: "TEARDOWN_FAILED" });
});
test("rejected original bind is retained without new read or replacement allocation", async () => {
  let calls = 0; const allocation = createLinuxSpeechRetirementAllocation(async () => { calls++; throw new Error("inert private error"); });
  const first = allocation.bind(); await assert.rejects(first, { code: "TEARDOWN_FAILED" });
  await allocation.settleReads(); assert.equal(first, allocation.bind()); assert.equal(calls, 1);
});

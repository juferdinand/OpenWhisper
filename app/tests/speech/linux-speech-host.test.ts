import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createLinuxSpeechHostEffects, speechEnvironment, SPEECH_EXCLUDED_ENVIRONMENT, type LinuxSpeechHostEffects } from "../../src/main/linux-speech-host.js";
import type { VerifiedSpeechResource } from "../../src/services/speech/speech-resources.js";
import { createLinuxSpeechRetirementAllocation, type LinuxSpeechWitness } from "../../src/services/speech/linux-speech-retirement.js";
import { InertSpeechPort, deferred, turn } from "../fixtures/speech-port.js";

const selected: VerifiedSpeechResource = { backend: "cpu", path: "/fixed/native/speech/cpu/openwhisper_speech.node", bytes: 10, sha256: "a".repeat(64) };
function fixture() {
  const port = new InertSpeechPort(); let forks = 0, holders = 0, binds = 0;
  const forked: unknown[][] = [];
  const input: LinuxSpeechHostEffects = { async verifyEntry() { return { entry: "/fixed/dist/workers/speech-entry.js" }; },
    async verifyResource() { return selected; },
    fork(entry, binding, epoch) { forks++; forked.push([entry, binding, epoch]); queueMicrotask(() => { port.spawn(); port.ready(); }); return port; },
    prepareRetirement(pid, epoch) { holders++; return createLinuxSpeechRetirementAllocation(async () => {
      binds++; const source: LinuxSpeechWitness = { initial: { level: "running", canAdmit: true,
        identity: { pid, epoch, uid: 1000, parentPid: 123, startTicks: 5n } }, current: { level: "running" },
        async observe() { return { level: "running" }; }, async waitForRetirement() {}, async settleReads() {} }; return source;
    }); },
  };
  return { input, port, forked, forks: () => forks, holders: () => holders, binds: () => binds };
}
test("fixed resource and entry are reverified before exact original fork", async () => {
  const f = fixture(), effects = createLinuxSpeechHostEffects(f.input), epoch = randomUUID();
  const result = await effects.open(selected, epoch, new AbortController().signal); assert.equal(result.kind, "owner");
  assert.deepEqual(f.forked, [["/fixed/dist/workers/speech-entry.js", selected.path, epoch]]);
  assert.equal(f.holders(), 1); assert.equal(f.binds(), 0);
  if (result.kind !== "owner") throw new Error("Missing inert owner.");
  const signal = new AbortController().signal, first = result.owner.bindRetirement(epoch, signal), second = result.owner.bindRetirement(epoch, signal);
  assert.equal(first, second); await first; assert.equal(f.binds(), 1); f.port.exit();
});
test("changed resource, failed entry, and foreign path cannot create a child", async () => {
  for (const kind of ["digest", "path", "entry"] as const) {
    const f = fixture(), effects = createLinuxSpeechHostEffects(kind === "entry" ? { ...f.input, async verifyEntry() { throw new Error("private detail"); } } : f.input);
    const requested = kind === "digest" ? { ...selected, sha256: "b".repeat(64) } : kind === "path" ? { ...selected, path: "/foreign/model.node" } : selected;
    await assert.rejects(effects.open(requested, randomUUID(), new AbortController().signal)); assert.equal(f.forks(), 0);
  }
});
test("invalid epoch and resource refuse before verification or fork", async () => {
  const f = fixture(), effects = createLinuxSpeechHostEffects(f.input);
  await assert.rejects(effects.open(selected, "not-a-uuid", new AbortController().signal), { code: "INTEGRITY_FAILED" });
  await assert.rejects(effects.open({ ...selected, bytes: Infinity }, randomUUID(), new AbortController().signal), { code: "INTEGRITY_FAILED" });
  assert.equal(f.forks(), 0);
});
test("cancellation before fork is proven not-created; cancellation after fork retains late original", async () => {
  const first = fixture(), signal = new AbortController(); signal.abort();
  assert.deepEqual(await createLinuxSpeechHostEffects(first.input).open(selected, randomUUID(), signal.signal), { kind: "not-created", code: "START_FAILED" });
  assert.equal(first.forks(), 0);
  const second = fixture(), after = new AbortController();
  const effects = createLinuxSpeechHostEffects({ ...second.input, fork() { after.abort(); return second.port; } });
  const pending = effects.open(selected, randomUUID(), after.signal); await turn();
  second.port.spawn(); second.port.ready(); const result = await pending;
  assert.equal(result.kind, "owner"); assert.equal(second.port.terminateCalls, 0); second.port.exit();
});
test("fork throw and missing original PID are uncertain terminal errors", async () => {
  const first = fixture(), effects = createLinuxSpeechHostEffects({ ...first.input, fork() { throw new Error("private failure after possible fork"); } });
  await assert.rejects(effects.open(selected, randomUUID(), new AbortController().signal), { code: "TEARDOWN_FAILED" });
  const second = fixture(), later = createLinuxSpeechHostEffects({ ...second.input, fork() { queueMicrotask(() => { for (const listener of second.port.spawns) listener(undefined); }); return second.port; } });
  await assert.rejects(later.open(selected, randomUUID(), new AbortController().signal), { code: "TEARDOWN_FAILED" });
  assert.equal(second.port.terminateCalls, 0); second.port.exit();
});
test("retirement holder is captured before a held or rejected bind and cannot be rebound", async () => {
  const f = fixture(), held = deferred<LinuxSpeechWitness>(); let calls = 0;
  const effects = createLinuxSpeechHostEffects({ ...f.input,
    prepareRetirement() { return createLinuxSpeechRetirementAllocation(() => { calls++; return held.promise; }); } });
  const epoch = randomUUID(), result = await effects.open(selected, epoch, new AbortController().signal);
  if (result.kind !== "owner") throw new Error("Missing inert owner.");
  const first = result.owner.bindRetirement(epoch, new AbortController().signal); await turn(); assert.equal(calls, 1);
  held.reject(new Error("inert bind failure")); await assert.rejects(first, { code: "TEARDOWN_FAILED" });
  assert.equal(result.owner.bindRetirement(epoch, new AbortController().signal), first); assert.equal(calls, 1); f.port.exit();
});
test("closed loader aliases are removed without mutating ordinary host environment", () => {
  const original: NodeJS.ProcessEnv = { SAFE_FIXTURE: "preserved", PATH: "/fixed/bin" };
  for (const key of SPEECH_EXCLUDED_ENVIRONMENT) original[key] = "inert value";
  const cleaned = speechEnvironment(original);
  for (const key of SPEECH_EXCLUDED_ENVIRONMENT) { assert.equal(cleaned[key], undefined); assert.equal(original[key], "inert value"); }
  assert.equal(cleaned.SAFE_FIXTURE, "preserved"); assert.equal(cleaned.PATH, "/fixed/bin");
});

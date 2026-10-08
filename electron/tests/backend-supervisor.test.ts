import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SpeechAllocation } from "../src/core/speech-allocation.js";
import { initializeBackendSupervisor, type BackendBindings, type BackendEffects,
  type BackendIdentity, type BackendLease, type BackendSupervisor, type ProvisionalBackendOwner,
  type RetirementBoundary } from "../src/services/backend-supervisor.js";
import { SpeechWorkerError, type SpeechChannel, type SpeechFailureCode } from "../src/services/speech-client.js";
import type { ResourceBackend } from "../src/services/speech-resources.js";
import type { SpeechRequest } from "../src/workers/speech-protocol.js";

const failure = (code: SpeechFailureCode) => (error: unknown): boolean => error instanceof SpeechWorkerError && error.code === code;
const invalidInput = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "INVALID_INPUT";
function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve = (): void => { throw new Error("Deferred is not initialized."); };
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve: () => { resolve(); } };
}
type Barrier = ReturnType<typeof deferred>;
const host = { platform: "linux", architecture: "x64", uid: process.getuid?.() ?? 0, parentPid: process.pid } as const;
const samples = new Float32Array(32);
const baseModel = { path: "/owned/models/inert-fixture.bin", family: "whisper", gpu: true } as const;

test("continuing allocation waits full completion and has no reset across epochs", async () => {
  const pool = new SpeechAllocation(), token = pool.reserve(randomUUID()), barrier = deferred();
  pool.attach(token, {}); pool.admit(token);
  assert.throws(() => pool.reserve(randomUUID()), failure("BUSY"));
  const retiring = pool.retire(token, async () => { await barrier.promise; });
  assert.equal(pool.phase, "retiring"); assert.throws(() => pool.reserve(randomUUID()), failure("BUSY"));
  barrier.resolve(); await retiring; assert.equal(pool.phase, "free");
  const newer = pool.reserve(randomUUID()); assert.notEqual(newer, token);
  await pool.retire(newer, async () => {});
});

test("failed completion stays terminal after late effect settlement and new epochs", async () => {
  const pool = new SpeechAllocation(), token = pool.reserve(randomUUID()), late = deferred();
  pool.attach(token, {}); pool.retain(late.promise);
  await assert.rejects(pool.retire(token, async () => { throw new Error("Owned closure refusal."); }), failure("TEARDOWN_FAILED"));
  late.resolve(); await late.promise;
  assert.equal(pool.phase, "failed"); assert.throws(() => pool.reserve(randomUUID()), failure("TEARDOWN_FAILED"));
});

test("duplicate retirement observes the exact existing gate without a second cleanup effect", async () => {
  const pool = new SpeechAllocation(), token = pool.reserve(randomUUID()), barrier = deferred();
  const first = pool.retire(token, async () => { await barrier.promise; });
  assert.equal(pool.retire(token, async () => { assert.fail("A duplicate cleanup must not execute."); }), first);
  barrier.resolve(); await first;
});

test("integrity refusal retains its category and cannot be replaced by teardown or another token", async () => {
  const pool = new SpeechAllocation(), other = new SpeechAllocation();
  const token = other.reserve(randomUUID());
  pool.reserve(randomUUID()); assert.throws(() => pool.admit(token), failure("INTEGRITY_FAILED"));
  const original = pool.poison("TEARDOWN_FAILED"); assert.equal(original.code, "INTEGRITY_FAILED");
  assert.throws(() => pool.reserve(randomUUID()), (error: unknown) => error === original);
});

interface Controls {
  discovery: string | null;
  initial: "running" | "non-running" | "reaped" | "ambiguous";
  infer: "success" | "native-failure" | "hang";
  challenge: "normal" | "wrong-nonce" | "wrong-pid" | "wrong-epoch" | "repeat" | "extra" | "hang";
  discoveryReply: "normal" | "hang" | "exit";
  changedBirth: boolean;
  changedUid: boolean;
  invalidReady: boolean;
  extraResource: boolean;
  badResourceBackend: boolean;
  verifyFailure: SpeechFailureCode | undefined;
  openFailure: SpeechFailureCode | undefined;
  noOwner: ResourceBackend | undefined;
  openGate: Barrier | undefined;
  verifyGate: Barrier | undefined;
  reapGate: Barrier | undefined;
  readsGate: Barrier | undefined;
  readsFailure: boolean;
  leaseFailure: boolean;
  holdAdmissionLoopMs: number;
  holdReadLoopMs: number;
  holdVerifyLoopMs: number;
}
function holdEventLoop(milliseconds: number): void {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { /* Inert bounded event-loop delay, no effects. */ }
}
interface OwnerRecord {
  readonly identity: BackendIdentity;
  readonly challenges: string[];
  level: "running" | "non-running" | "reaped" | "ambiguous";
  terminates: number;
  readSettled: boolean;
}
function fixture(deadlines: Partial<{ startupMs: number; requestMs: number; cleanupMs: number }> = {}) {
  const controls: Controls = { discovery: "Owned hardware-category fixture", initial: "running", infer: "success", challenge: "normal", discoveryReply: "normal",
    changedBirth: false, changedUid: false, invalidReady: false, extraResource: false, badResourceBackend: false,
    verifyFailure: undefined, openFailure: undefined, noOwner: undefined, openGate: undefined, verifyGate: undefined,
    reapGate: undefined, readsGate: undefined, readsFailure: false, leaseFailure: false,
    holdAdmissionLoopMs: 0, holdReadLoopMs: 0, holdVerifyLoopMs: 0 };
  const events: string[] = [], owners: OwnerRecord[] = [], requests: SpeechRequest[] = [], verifies: ResourceBackend[] = [];
  const effects: BackendEffects = {
    verify: async (backend) => {
      events.push(`verify:${backend}`); verifies.push(backend); await controls.verifyGate?.promise;
      holdEventLoop(controls.holdVerifyLoopMs);
      if (controls.verifyFailure) throw new SpeechWorkerError(controls.verifyFailure);
      const resource = { backend: controls.badResourceBackend ? "metal" : backend,
        path: `/owned/native/speech/${backend}/openwhisper_speech.node`, bytes: 128, sha256: "a".repeat(64) };
      return controls.extraResource ? { ...resource, arbitraryPath: "/unowned" } : resource;
    },
    open: async (resource, epoch) => {
      events.push(`open:${resource.backend}`); await controls.openGate?.promise;
      if (controls.openFailure) throw new SpeechWorkerError(controls.openFailure);
      if (controls.noOwner === resource.backend) return { kind: "not-created", code: "START_FAILED" };
      const identity: BackendIdentity = { pid: 10_000 + owners.length, uid: host.uid, parentPid: host.parentPid,
        epoch, birth: { platform: "linux", startTicks: BigInt(1000 + owners.length) } };
      const record: OwnerRecord = { identity, challenges: [], level: controls.initial, terminates: 0, readSettled: false };
      owners.push(record);
      const listeners = new Set<(value: unknown) => void>(), exits = new Set<() => void>();
      const observedIdentity = (): BackendIdentity => ({ ...identity, uid: controls.changedUid ? identity.uid + 1 : identity.uid,
        birth: { platform: "linux", startTicks: BigInt(1000 + owners.indexOf(record) + (controls.changedBirth ? 1 : 0)) } });
      const emit = (value: unknown): void => { for (const listener of listeners) listener(value); };
      const channel: SpeechChannel = {
        onMessage: (listener) => {
          listeners.add(listener); queueMicrotask(() => { if (listeners.has(listener)) listener(controls.invalidReady ?
            { version: 1, type: "ready", extra: true } : { version: 1, type: "ready" }); });
          return () => { listeners.delete(listener); };
        },
        onExit: (listener) => { exits.add(listener); return () => { exits.delete(listener); }; },
        send: (request) => {
          events.push(`request:${request.command}`); requests.push(request);
          if (request.command === "discover") {
            if (controls.discoveryReply === "hang") return;
            if (controls.discoveryReply === "exit") { record.level = "reaped"; for (const listener of exits) listener(); return; }
            emit({ version: 1, id: request.id, ok: true, value: { command: "discover", gpu: controls.discovery } });
          }
          else if (request.command === "shutdown") emit({ version: 1, id: request.id, ok: true, value: { command: "shutdown" } });
          else if (controls.infer === "native-failure") emit({ version: 1, id: request.id, ok: false, code: "NATIVE_FAILED" });
          else if (controls.infer === "success") emit({ version: 1, id: request.id, ok: true,
            value: { command: "transcribe", text: "Owned multilingual fixture 👩‍💻 中文 العربية." } });
        },
        terminate: async () => {
          events.push(`terminate:${resource.backend}`); record.terminates++;
          record.level = controls.reapGate ? "non-running" : "reaped";
          for (const listener of exits) listener();
        },
      };
      const witness: RetirementBoundary = {
        initial: { level: record.level, canAdmit: record.level === "running", identity: record.level === "reaped" ? null : identity },
        get current() { return { level: record.level }; },
        observe: async () => { events.push(`observe:${record.level}`); return { level: record.level,
          identity: record.level === "reaped" ? null : observedIdentity() }; },
        waitForRetirement: async () => {
          events.push("wait-reap"); await controls.reapGate?.promise;
          if (record.level === "non-running") record.level = "reaped";
          if (record.level !== "reaped") throw new SpeechWorkerError("TEARDOWN_FAILED");
        },
        settleReads: async () => {
          events.push("settle-reads"); await controls.readsGate?.promise;
          holdEventLoop(controls.holdReadLoopMs);
          if (controls.readsFailure) { record.level = "ambiguous"; throw new Error("Owned reader close refusal."); }
          record.readSettled = true;
        },
      };
      const owner: ProvisionalBackendOwner = {
        pid: identity.pid, channel,
        challenge: async (nonce, challengedEpoch, signal) => {
          record.challenges.push(nonce); events.push("challenge");
          if (record.challenges.length === 2) holdEventLoop(controls.holdAdmissionLoopMs);
          if (signal.aborted) throw new SpeechWorkerError("CANCELLED");
          if (controls.challenge === "hang") return new Promise<never>(() => {});
          const reply = { version: 1, nonce: controls.challenge === "wrong-nonce" ? randomUUID() :
            controls.challenge === "repeat" ? record.challenges[0] ?? nonce : nonce,
            epoch: controls.challenge === "wrong-epoch" ? randomUUID() : challengedEpoch,
            pid: controls.challenge === "wrong-pid" ? identity.pid + 1 : identity.pid };
          return controls.challenge === "extra" ? { ...reply, stale: true } : reply;
        },
        bindRetirement: async () => { events.push("bind-retirement"); return witness; },
      };
      return { kind: "owner", owner };
    },
  };
  const bindings: BackendBindings = { host, catalog: Object.freeze({}), effects,
    deadlines: { startupMs: 3000, requestMs: 3000, cleanupMs: 3000, ...deadlines } };
  const lease = (gpu = true, family: "whisper" | "parakeet" = "whisper"): BackendLease => ({
    model: { ...baseModel, gpu, family }, validate: async () => { events.push("validate-lease"); if (controls.leaseFailure) throw new Error("Owned changed lease."); },
  });
  return { controls, events, owners, requests, verifies, bindings, lease };
}

// Closed literal cases load only this fixed inert source module in separate
// module instances. This models different mains without a production reset or
// spawning a process; it is not evidence of actual process retirement.
type Case = "manual" | "none" | "software" | "hardware" | "startup" | "inference" | "switch" |
  "cancel-open" | "cancel-verify" | "hung-admitted" | "hung-unadmitted" | "birth" | "uid" | "read-timeout" |
  "late-read-failure" | "wrong-nonce" | "extra-challenge" | "resource-extra" | "resource-backend" |
  "resource-failure" | "generic-open" | "terminal-open" | "invalid-ready" | "zombie" | "absent" | "invalid-input" |
  "late-admission" | "late-cleanup" | "late-integrity" | "discovery-timeout" | "discovery-exit" |
  "wrong-pid" | "wrong-epoch" | "nonce-repeat" | "lease-failure" | "resource-teardown" | "ambiguous" | "admission-birth" |
  "concurrent-job" | "empty-device" | "mac-unavailable" | "changed-lease";
function facadeShape(value: unknown): value is BackendSupervisor {
  return typeof value === "object" && value !== null && "createJob" in value && typeof value.createJob === "function";
}
async function fresh(name: Case, bindings: BackendBindings): Promise<BackendSupervisor> {
  const url = new URL("../src/services/backend-supervisor.ts", import.meta.url); url.searchParams.set("inert-case", name);
  const loaded: unknown = await import(url.href);
  assert.ok(typeof loaded === "object" && loaded !== null && "initializeBackendSupervisor" in loaded &&
    typeof loaded.initializeBackendSupervisor === "function");
  const result: unknown = Reflect.apply(loaded.initializeBackendSupervisor, loaded, [bindings]);
  assert.ok(facadeShape(result)); return result;
}
async function until(condition: () => boolean): Promise<void> {
  const end = performance.now() + 1000;
  while (!condition()) { assert.ok(performance.now() < end, "Owned inert effect was not reached."); await delay(1); }
}

test("manual CPU verifies only CPU and never discovers or promotes GPU", async () => {
  const f = fixture(), main = await fresh("manual", f.bindings), job = main.createJob(f.lease(false));
  assert.deepEqual(await job.prepare(), { backend: "cpu", requestedGpu: false, gpu: false, detection: "none" });
  await job.transcribeWindow({ ...baseModel, gpu: false }, samples, "yue", "词汇"); await job.close();
  assert.deepEqual(f.verifies, ["cpu"]); assert.equal(f.requests.some((value) => value.command === "discover"), false);
  const request = f.requests.find((value) => value.command === "transcribe");
  assert.ok(request?.command === "transcribe"); assert.equal(request.model.gpu, false); assert.equal(request.language, "yue");
});

test("another job cannot validate, probe or open while the continuing main owner is live", async () => {
  const f = fixture(), main = await fresh("concurrent-job", f.bindings), first = main.createJob(f.lease(false));
  await first.prepare(); const oldEvents = f.events.length, second = main.createJob(f.lease(false));
  await assert.rejects(second.prepare(), failure("BUSY")); assert.equal(f.events.length, oldEvents);
  await first.close(); await second.prepare(); await second.close();
});

test("unvalidated macOS automatic backend refuses honestly before any resource or device effect", async () => {
  const f = fixture(), main = await fresh("mac-unavailable", { ...f.bindings, host: { ...host, platform: "darwin" } });
  const job = main.createJob(f.lease());
  await assert.rejects(job.prepare(), (error: unknown) => error instanceof Error && "code" in error && error.code === "BACKEND_UNAVAILABLE");
  assert.equal(f.events.length, 0); await job.close();
});

for (const [name, discovery, detection] of [["none", null, "none"], ["software", "llvmpipe (software Vulkan)", "software"]] as const) {
  test(`${name} detection retires Vulkan and read descriptors before CPU selection`, async () => {
    const f = fixture(); f.controls.discovery = discovery;
    const main = await fresh(name, f.bindings), job = main.createJob(f.lease());
    assert.deepEqual(await job.prepare(), { backend: "cpu", requestedGpu: true, gpu: false, detection });
    assert.deepEqual(f.verifies, ["vulkan", "cpu"]); assert.equal(f.owners[0]?.readSettled, true);
    assert.ok(f.events.indexOf("settle-reads") < f.events.indexOf("verify:cpu")); await job.close();
  });
}

test("hardware metadata authorizes a GPU request without claiming GPU execution", async () => {
  const f = fixture(), main = await fresh("hardware", f.bindings), job = main.createJob(f.lease(true, "parakeet"));
  assert.deepEqual(await job.prepare(), { backend: "vulkan", requestedGpu: true, gpu: true, detection: "device" });
  assert.equal(new Set(f.owners[0]?.challenges).size, 2);
  await job.transcribeWindow({ ...baseModel, family: "parakeet" }, samples, "auto", "private prompt not supported by Parakeet");
  const request = f.requests.find((value) => value.command === "transcribe");
  assert.ok(request?.command === "transcribe"); assert.equal(request.model.gpu, true); assert.equal(request.vocabulary, ""); await job.close();
});

test("empty device metadata is an invalid reply and never a hardware or CPU fallback claim", async () => {
  const f = fixture(); f.controls.discovery = "  ";
  const main = await fresh("empty-device", f.bindings), job = main.createJob(f.lease());
  await assert.rejects(job.prepare(), failure("INVALID_REPLY")); assert.deepEqual(f.verifies, ["vulkan"]); await job.close();
});

test("explicit trusted no-owner startup rollback is eligible for CPU fallback", async () => {
  const f = fixture(); f.controls.noOwner = "vulkan";
  const main = await fresh("startup", f.bindings), job = main.createJob(f.lease());
  assert.equal((await job.prepare()).detection, "unavailable"); assert.deepEqual(f.verifies, ["vulkan", "cpu"]); await job.close();
});

for (const [name, mode] of [["discovery-timeout", "hang"], ["discovery-exit", "exit"]] as const) {
  test(`${name} is eligible only after admitted owner retirement and reader closure`, async () => {
    const f = fixture(name === "discovery-timeout" ? { requestMs: 40 } : {}); f.controls.discoveryReply = mode;
    const main = await fresh(name, f.bindings), job = main.createJob(f.lease());
    assert.equal((await job.prepare()).detection, "unavailable");
    assert.deepEqual(f.verifies, ["vulkan", "cpu"]); assert.equal(f.owners[0]?.readSettled, true);
    assert.ok(f.events.indexOf("settle-reads") < f.events.indexOf("open:cpu")); await job.close();
  });
}

test("inference failure is returned once without supervisor replay", async () => {
  const f = fixture(), main = await fresh("inference", f.bindings), job = main.createJob(f.lease());
  await job.prepare(); f.controls.infer = "native-failure";
  await assert.rejects(job.transcribeWindow(baseModel, samples, "en", ""), failure("NATIVE_FAILED"));
  assert.equal(f.requests.filter((value) => value.command === "transcribe").length, 1);
  assert.deepEqual(f.verifies, ["vulkan"]); await job.close();
});

test("explicit later CPU attempt waits full GPU reap before sending that exact window", async () => {
  const f = fixture(), main = await fresh("switch", f.bindings), job = main.createJob(f.lease());
  await job.prepare(); f.controls.reapGate = deferred();
  const retry = job.transcribeWindow({ ...baseModel, gpu: false }, samples, "en", "");
  await until(() => f.events.includes("wait-reap")); assert.deepEqual(f.verifies, ["vulkan"]);
  f.controls.reapGate.resolve(); await retry;
  assert.deepEqual(f.verifies, ["vulkan", "cpu"]); assert.equal(f.owners[0]?.readSettled, true); await job.close();
});

test("cancelled late open stays reserved until its independently bound owner reaps", async () => {
  const f = fixture(); f.controls.openGate = deferred();
  const main = await fresh("cancel-open", f.bindings), job = main.createJob(f.lease(false)), abort = new AbortController();
  const pending = job.prepare(abort.signal); await until(() => f.events.includes("open:cpu")); abort.abort();
  await assert.rejects(pending, failure("CANCELLED"));
  await assert.rejects(main.createJob(f.lease(false)).prepare(), failure("BUSY"));
  f.controls.openGate.resolve(); await job.close();
  assert.equal(f.owners[0]?.terminates, 1); assert.equal(f.owners[0]?.readSettled, true);
  const newer = main.createJob(f.lease(false)); await newer.prepare(); await newer.close();
});

test("cancelled held verification never opens an owner after its actual completion", async () => {
  const f = fixture(); f.controls.verifyGate = deferred();
  const main = await fresh("cancel-verify", f.bindings), job = main.createJob(f.lease(false)), abort = new AbortController();
  const pending = job.prepare(abort.signal); await until(() => f.verifies.length === 1); abort.abort();
  await assert.rejects(pending, failure("CANCELLED"));
  await assert.rejects(main.createJob(f.lease(false)).prepare(), failure("BUSY"));
  f.controls.verifyGate.resolve(); await job.close(); assert.equal(f.owners.length, 0);
});

test("admitted native timeout can retire without a responsive JS challenge and retry only after reap", async () => {
  const f = fixture({ requestMs: 40 }), main = await fresh("hung-admitted", f.bindings), job = main.createJob(f.lease());
  await job.prepare(); const initialChallenges = f.owners[0]?.challenges.length;
  f.controls.challenge = "hang"; f.controls.infer = "hang"; f.controls.reapGate = deferred();
  await assert.rejects(job.transcribeWindow(baseModel, samples, "en", ""), failure("TIMEOUT"));
  await until(() => f.events.includes("wait-reap"));
  assert.equal(f.owners[0]?.challenges.length, initialChallenges); assert.equal(f.owners[0]?.terminates, 1);
  f.controls.infer = "success"; f.controls.challenge = "normal";
  const retry = job.transcribeWindow({ ...baseModel, gpu: false }, samples, "en", "");
  await delay(5); assert.equal(f.owners.length, 1);
  f.controls.reapGate.resolve(); await retry; assert.equal(f.owners[0]?.readSettled, true);
  f.controls.challenge = "normal"; await job.close();
});

test("unadmitted late owner with a hung original-channel challenge is never signaled or replaced", async () => {
  const f = fixture({ cleanupMs: 80 }); f.controls.openGate = deferred();
  const main = await fresh("hung-unadmitted", f.bindings), job = main.createJob(f.lease(false)), abort = new AbortController();
  const pending = job.prepare(abort.signal); await until(() => f.events.includes("open:cpu")); abort.abort();
  await assert.rejects(pending, failure("CANCELLED")); f.controls.challenge = "hang"; f.controls.openGate.resolve();
  await assert.rejects(job.close(), failure("TEARDOWN_FAILED")); assert.equal(f.owners[0]?.terminates, 0);
  assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
});

for (const name of ["birth", "uid"] as const) test(`admitted owner with changed ${name} never authorizes termination`, async () => {
  const f = fixture(), main = await fresh(name, f.bindings), job = main.createJob(f.lease(false)); await job.prepare();
  if (name === "birth") f.controls.changedBirth = true; else f.controls.changedUid = true;
  await assert.rejects(job.close(), failure("TEARDOWN_FAILED")); assert.equal(f.owners[0]?.terminates, 0);
  assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
});

test("read closure timeout remains terminal even after later actual effect settlement", async () => {
  const f = fixture({ cleanupMs: 80 }), main = await fresh("read-timeout", f.bindings), job = main.createJob(f.lease(false)); await job.prepare();
  f.controls.readsGate = deferred(); await assert.rejects(job.close(), failure("TEARDOWN_FAILED"));
  f.controls.readsGate.resolve(); await delay(1); assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
});

test("late read failure retains ownership after an observed reaped record", async () => {
  const f = fixture(), main = await fresh("late-read-failure", f.bindings), job = main.createJob(f.lease(false)); await job.prepare();
  f.controls.readsFailure = true; await assert.rejects(job.close(), failure("TEARDOWN_FAILED"));
  assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
});

for (const [name, mode] of [["wrong-nonce", "wrong-nonce"], ["extra-challenge", "extra"],
  ["wrong-pid", "wrong-pid"], ["wrong-epoch", "wrong-epoch"], ["nonce-repeat", "repeat"]] as const) {
  test(`${name} cannot admit native work or authorize a signal`, async () => {
    const f = fixture(); f.controls.challenge = mode;
    const main = await fresh(name, f.bindings), job = main.createJob(f.lease(false));
    await assert.rejects(job.prepare(), failure("INTEGRITY_FAILED")); assert.equal(f.requests.length, 0); assert.equal(f.owners[0]?.terminates, 0);
    assert.throws(() => main.createJob(f.lease(false)), failure("INTEGRITY_FAILED"));
  });
}

test("failed model lease validation is terminal before resource lookup or process allocation", async () => {
  const f = fixture(); f.controls.leaseFailure = true;
  const main = await fresh("lease-failure", f.bindings), job = main.createJob(f.lease());
  await assert.rejects(job.prepare(), failure("INTEGRITY_FAILED")); assert.deepEqual(f.verifies, []); assert.equal(f.owners.length, 0);
  assert.throws(() => main.createJob(f.lease(false)), failure("INTEGRITY_FAILED"));
});

test("changed lease on an already selected owner stops inference and stays terminal", async () => {
  const f = fixture(), main = await fresh("changed-lease", f.bindings), job = main.createJob(f.lease(false));
  await job.prepare(); f.controls.leaseFailure = true;
  await assert.rejects(job.transcribeWindow({ ...baseModel, gpu: false }, samples, "en", ""), failure("INTEGRITY_FAILED"));
  assert.equal(f.requests.some((request) => request.command === "transcribe"), false);
  assert.throws(() => main.createJob(f.lease(false)), failure("INTEGRITY_FAILED"));
});

test("resource descriptor-close failure keeps teardown category and cannot choose CPU", async () => {
  const f = fixture(); f.controls.verifyFailure = "TEARDOWN_FAILED";
  const main = await fresh("resource-teardown", f.bindings), job = main.createJob(f.lease());
  await assert.rejects(job.prepare(), failure("TEARDOWN_FAILED")); assert.deepEqual(f.verifies, ["vulkan"]); assert.equal(f.owners.length, 0);
  assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
});

test("ambiguous initial binding permanently refuses without a signal or native work", async () => {
  const f = fixture(); f.controls.initial = "ambiguous";
  const main = await fresh("ambiguous", f.bindings), job = main.createJob(f.lease(false));
  await assert.rejects(job.prepare(), failure("TEARDOWN_FAILED")); assert.equal(f.owners[0]?.terminates, 0); assert.equal(f.requests.length, 0);
  assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
});

test("birth change between candidate and final admission cannot admit or repair the allocation", async () => {
  const f = fixture(); f.controls.changedBirth = true;
  const main = await fresh("admission-birth", f.bindings), job = main.createJob(f.lease(false));
  await assert.rejects(job.prepare(), failure("TEARDOWN_FAILED")); assert.equal(f.owners[0]?.terminates, 0); assert.equal(f.requests.length, 0);
  assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
});

for (const name of ["resource-extra", "resource-backend", "resource-failure"] as const) {
  test(`${name} is terminal integrity failure before any owner or CPU fallback`, async () => {
    const f = fixture(); f.controls.extraResource = name === "resource-extra"; f.controls.badResourceBackend = name === "resource-backend";
    if (name === "resource-failure") f.controls.verifyFailure = "INTEGRITY_FAILED";
    const main = await fresh(name, f.bindings), job = main.createJob(f.lease());
    await assert.rejects(job.prepare(), failure("INTEGRITY_FAILED")); assert.equal(f.owners.length, 0); assert.deepEqual(f.verifies, ["vulkan"]);
    assert.throws(() => main.createJob(f.lease()), failure("INTEGRITY_FAILED"));
  });
}

for (const [name, cause, expected] of [["generic-open", "START_FAILED", "TEARDOWN_FAILED"],
  ["terminal-open", "INTEGRITY_FAILED", "INTEGRITY_FAILED"]] as const) test(`${name} throw does not establish no-owner rollback`, async () => {
  const f = fixture(); f.controls.openFailure = cause;
  const main = await fresh(name, f.bindings), job = main.createJob(f.lease());
  await assert.rejects(job.prepare(), failure(expected)); assert.deepEqual(f.verifies, ["vulkan"]);
  assert.throws(() => main.createJob(f.lease()), failure(expected));
});

test("unknown readiness keys are rejected without CPU fallback", async () => {
  const f = fixture(); f.controls.invalidReady = true;
  const main = await fresh("invalid-ready", f.bindings), job = main.createJob(f.lease());
  await assert.rejects(job.prepare(), failure("INVALID_REPLY")); assert.deepEqual(f.verifies, ["vulkan"]); await job.close();
});

for (const [name, level] of [["zombie", "non-running"], ["absent", "reaped"]] as const) test(`${name} candidate never admits work or receives a signal`, async () => {
  const f = fixture(); f.controls.initial = level;
  const main = await fresh(name, f.bindings), job = main.createJob(f.lease(false));
  await assert.rejects(job.prepare(), failure("WORKER_FAILED")); await job.close();
  assert.equal(f.owners[0]?.terminates, 0); assert.equal(f.requests.length, 0); assert.equal(f.owners[0]?.readSettled, true);
});

test("model identity, manual CPU and exact window validation precede all start effects", async () => {
  const f = fixture(), main = await fresh("invalid-input", f.bindings), job = main.createJob(f.lease(false));
  for (const input of [{ ...baseModel }, { ...baseModel, gpu: false, path: "/foreign/model.bin" },
    { ...baseModel, gpu: false, family: "parakeet" } as const]) {
    await assert.rejects(job.transcribeWindow(input, samples, "en", ""), invalidInput);
  }
  await assert.rejects(job.transcribeWindow({ ...baseModel, gpu: false }, new Float32Array(new ArrayBuffer(256), 4, 32), "en", ""),
    invalidInput);
  assert.equal(f.events.length, 0); await job.close();
});

test("admission success after a blocked event-loop deadline never admits native work", async () => {
  const f = fixture({ startupMs: 40 }); f.controls.holdAdmissionLoopMs = 60;
  const main = await fresh("late-admission", f.bindings), job = main.createJob(f.lease(false));
  await assert.rejects(job.prepare(), failure("TIMEOUT")); await job.close();
  assert.equal(f.requests.length, 0); assert.equal(f.owners[0]?.readSettled, true);
});

test("cleanup completion after an elapsed monotonic deadline cannot release the allocation", async () => {
  const f = fixture({ cleanupMs: 80 }), main = await fresh("late-cleanup", f.bindings), job = main.createJob(f.lease(false));
  await job.prepare(); f.controls.holdReadLoopMs = 100;
  await assert.rejects(job.close(), failure("TEARDOWN_FAILED"));
  assert.equal(f.owners[0]?.level, "reaped"); assert.equal(f.owners[0]?.readSettled, true);
  assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
});

test("late integrity rejection preserves terminal category despite elapsed startup deadline", async () => {
  const f = fixture({ startupMs: 40 }); f.controls.holdVerifyLoopMs = 60; f.controls.verifyFailure = "INTEGRITY_FAILED";
  const main = await fresh("late-integrity", f.bindings), job = main.createJob(f.lease());
  await assert.rejects(job.prepare(), failure("INTEGRITY_FAILED")); assert.equal(f.owners.length, 0);
  assert.throws(() => main.createJob(f.lease()), failure("INTEGRITY_FAILED"));
});

test("ordinary module singleton cannot be reset by new jobs, bindings or client epochs", async () => {
  const f = fixture(), main = initializeBackendSupervisor(f.bindings);
  assert.equal(initializeBackendSupervisor(f.bindings), main);
  assert.throws(() => initializeBackendSupervisor({ ...f.bindings, catalog: Object.freeze({}) }), failure("INTEGRITY_FAILED"));
  const job = main.createJob(f.lease(false)), alreadyCreated = main.createJob(f.lease(false));
  await job.prepare(); f.controls.readsFailure = true;
  await assert.rejects(job.close(), failure("TEARDOWN_FAILED"));
  assert.equal(initializeBackendSupervisor(f.bindings), main);
  assert.throws(() => main.createJob(f.lease(false)), failure("TEARDOWN_FAILED"));
  await assert.rejects(alreadyCreated.prepare(), failure("TEARDOWN_FAILED"));
  assert.throws(() => initializeBackendSupervisor({ ...f.bindings, effects: fixture().bindings.effects }), failure("INTEGRITY_FAILED"));
});

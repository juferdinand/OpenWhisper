import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createMacChildRetirementAllocation, createMacChildRetirementAllocator, createMacSpeechHostEffects,
  macSpeechEnvironment, MAC_SPEECH_EXCLUDED_ENVIRONMENT, type MacSpeechHostEffects } from "../src/main/macos-speech-host.js";
import { captureMacKernelRetirementNative, MacKernelRetirementBoundary } from "../src/services/macos-retirement-boundary.js";
import type { MacProcessRecord } from "../src/services/macos-process-retirement.js";
import type { VerifiedSpeechResource } from "../src/services/speech-resources.js";
import { InertSpeechPort, deferred, turn } from "./fixtures/speech-port.js";

const cpu: VerifiedSpeechResource = Object.freeze({ backend: "cpu", path: "/fixed/dist/native/speech/cpu/openwhisper_speech.node", bytes: 10, sha256: "a".repeat(64) });
const metal: VerifiedSpeechResource = Object.freeze({ ...cpu, backend: "metal", path: "/fixed/dist/native/speech/metal/openwhisper_speech.node" });
const abi = Object.freeze({ version: 1, role: "production", napiVersion: 8, mainOnly: true, zombieLookupArgument: 1, probeOnly: false });
const flags = Object.freeze({ watched: true, exitSeen: false, cloexec: true });
const signal = (): AbortSignal => new AbortController().signal;

class InertKernel {
  readonly owner = {};
  readonly record: MacProcessRecord = Object.freeze({ kind: "record", pid: 1234, parentPid: 100, uid: 501, realUid: 501, savedUid: 501,
    seconds: 1_700_000_000n, micros: 12345n, state: "sleeping" });
  readonly calls: string[] = [];
  bindHold: Promise<unknown> | undefined;
  closeHold: Promise<void> | undefined;
  bindReply: unknown = { first: this.record, second: this.record, ...flags };
  readonly replies: unknown[] = [];
  readonly raw = {
    abi: (): unknown => abi,
    create: (pid: unknown, uid: unknown, parent: unknown): object => {
      assert.deepEqual([pid, uid, parent], [1234, 501, 100]); this.calls.push("create"); return this.owner;
    },
    bindCandidate: (owner: unknown): Promise<unknown> => {
      assert.equal(owner, this.owner); this.calls.push("bind"); return this.bindHold ?? Promise.resolve(this.bindReply);
    },
    observe: (owner: unknown): Promise<unknown> => {
      assert.equal(owner, this.owner); this.calls.push("observe"); return Promise.resolve(this.replies.shift() ?? { second: this.record, ...flags });
    },
    close: (owner: unknown): Promise<void> => {
      assert.equal(owner, this.owner); this.calls.push("close"); return this.closeHold ?? Promise.resolve();
    },
  };
  boundary(epoch: string): MacKernelRetirementBoundary {
    return new MacKernelRetirementBoundary(captureMacKernelRetirementNative(this.raw), { pid: 1234, uid: 501, parentPid: 100, epoch });
  }
}
function fixture(selected: VerifiedSpeechResource = cpu) {
  const port = new InertSpeechPort(), kernel = new InertKernel();
  const forks: unknown[][] = [], held: MacKernelRetirementBoundary[] = [];
  let verifications = 0;
  const input: MacSpeechHostEffects = {
    async verifyResource(backend) { verifications++; assert.equal(backend, selected.backend); return selected; },
    async verifyEntry() { return { entry: "/fixed/dist/workers/speech-entry.js" }; },
    fork(entry, binding, epoch) { forks.push([entry, binding, epoch]); queueMicrotask(() => { port.spawn(); port.ready(); }); return port; },
    prepareRetirement(pid, epoch) {
      assert.equal(pid, port.pid); const boundary = kernel.boundary(epoch); held.push(boundary);
      return createMacChildRetirementAllocation(boundary);
    },
  };
  return { input, port, kernel, forks, held, verifications: () => verifications };
}

test("Mac CPU and Metal resource effects reverify fixed bytes before the original fork", async () => {
  for (const selected of [cpu, metal]) {
    const f = fixture(selected), effects = createMacSpeechHostEffects(f.input), epoch = randomUUID();
    assert.deepEqual(await effects.verify(selected.backend), selected);
    const result = await effects.open(selected, epoch, signal());
    if (result.kind !== "owner") throw new Error("Missing inert owner.");
    assert.equal(f.verifications(), 2);
    assert.deepEqual(f.forks, [["/fixed/dist/workers/speech-entry.js", selected.path, epoch]]);
    assert.deepEqual(f.kernel.calls, ["create"]); assert.equal(f.held.length, 1);
    const first = result.owner.bindRetirement(epoch, signal());
    assert.equal(result.owner.bindRetirement(epoch, signal()), first);
    const witness = await first;
    assert.deepEqual(witness.initial, { level: "running", canAdmit: true, identity: { pid: 1234, uid: 501, parentPid: 100,
      epoch, birth: { platform: "darwin", seconds: f.kernel.record.seconds, micros: 12345 } } });
    await witness.settleReads(); f.port.exit();
  }
});

test("Mac rejects Vulkan and malformed resource or epoch before verification and creation", async () => {
  const f = fixture(), effects = createMacSpeechHostEffects(f.input);
  await assert.rejects(effects.verify("vulkan"), { code: "INTEGRITY_FAILED" });
  for (const input of [{ ...cpu, backend: "vulkan" as const }, { ...cpu, bytes: Infinity }, { ...cpu, path: "/fixed/../foreign.node" }]) {
    await assert.rejects(effects.open(input, randomUUID(), signal()), { code: "INTEGRITY_FAILED" });
  }
  await assert.rejects(effects.open(cpu, "invalid", signal()), { code: "INTEGRITY_FAILED" });
  assert.equal(f.verifications(), 0); assert.equal(f.forks.length, 0); assert.deepEqual(f.kernel.calls, []);
});

test("changed bytes or selected destination and failed entry cannot create a Mac helper", async () => {
  for (const kind of ["digest", "path", "entry", "backend"] as const) {
    const f = fixture();
    const effects = createMacSpeechHostEffects(kind === "entry" ? { ...f.input, async verifyEntry() { throw new Error("private detail"); } }
      : kind === "backend" ? { ...f.input, async verifyResource() { return metal; } } : f.input);
    const requested = kind === "digest" ? { ...cpu, sha256: "b".repeat(64) }
      : kind === "path" ? { ...cpu, path: "/foreign/openwhisper_speech.node" } : cpu;
    await assert.rejects(effects.open(requested, randomUUID(), signal()), { code: "INTEGRITY_FAILED" });
    assert.equal(f.forks.length, 0); assert.deepEqual(f.kernel.calls, []);
  }
});

test("pre-fork cancellation proves no owner while late spawn remains owned without implicit termination", async () => {
  const f = fixture(), before = new AbortController(); before.abort();
  assert.deepEqual(await createMacSpeechHostEffects(f.input).open(cpu, randomUUID(), before.signal), { kind: "not-created", code: "START_FAILED" });
  assert.equal(f.forks.length, 0);
  const late = fixture(), after = new AbortController();
  const effects = createMacSpeechHostEffects({ ...late.input, fork() { after.abort(); return late.port; } });
  const pending = effects.open(cpu, randomUUID(), after.signal); await turn();
  assert.deepEqual(late.kernel.calls, []); assert.equal(late.port.terminateCalls, 0);
  late.port.spawn(); late.port.ready(); const result = await pending;
  assert.equal(result.kind, "owner"); assert.deepEqual(late.kernel.calls, ["create"]);
  assert.equal(late.port.terminateCalls, 0);
  if (result.kind !== "owner") throw new Error("Missing late inert owner.");
  await assert.rejects(result.owner.bindRetirement(randomUUID(), signal()), { code: "INTEGRITY_FAILED" });
  assert.deepEqual(late.kernel.calls, ["create"]); late.port.exit();
});

test("uncertain Mac fork or missing original PID is terminal and never authorizes a signal", async () => {
  const f = fixture();
  await assert.rejects(createMacSpeechHostEffects({ ...f.input, fork() { throw new Error("uncertain creation"); } })
    .open(cpu, randomUUID(), signal()), { code: "TEARDOWN_FAILED" });
  assert.equal(f.port.terminateCalls, 0); assert.deepEqual(f.kernel.calls, []);
  const missing = fixture();
  const effects = createMacSpeechHostEffects({ ...missing.input, fork() {
    queueMicrotask(() => { for (const listener of missing.port.spawns) listener(undefined); missing.port.ready(); }); return missing.port;
  } });
  await assert.rejects(effects.open(cpu, randomUUID(), signal()), { code: "TEARDOWN_FAILED" });
  assert.equal(missing.port.terminateCalls, 0); assert.deepEqual(missing.kernel.calls, []); missing.port.exit();
});

test("shared Mac allocation owns held bind and read disposal without replacement after refusal", async () => {
  const kernel = new InertKernel(), bind = deferred<unknown>(), close = deferred<void>();
  kernel.bindHold = bind.promise; kernel.closeHold = close.promise;
  const boundary = kernel.boundary(randomUUID()), allocation = createMacChildRetirementAllocation(boundary);
  assert.deepEqual(kernel.calls, ["create"]);
  const original = allocation.bind(signal()); await turn(); assert.deepEqual(kernel.calls, ["create", "bind"]);
  let disposed = false;
  const reads = allocation.settleReads(); void reads.then(() => { disposed = true; });
  assert.equal(allocation.settleReads(), reads); await turn();
  assert.deepEqual(kernel.calls, ["create", "bind", "close"]); assert.equal(disposed, false);
  bind.reject(new Error("inert bind refusal")); await assert.rejects(original, { code: "TEARDOWN_FAILED" });
  assert.equal(allocation.bind(signal()), original); assert.equal(disposed, false);
  close.accept(); await reads; assert.equal(disposed, true);
  assert.equal(boundary.current.level, "ambiguous");
  assert.equal(kernel.calls.filter((call) => call === "bind").length, 1);
  assert.equal(kernel.calls.filter((call) => call === "close").length, 1);
});

test("ordinary exit and observer close do not replace Mac zombie full-reap and read barriers", async () => {
  const f = fixture(), epoch = randomUUID(), result = await createMacSpeechHostEffects(f.input).open(cpu, epoch, signal());
  if (result.kind !== "owner") throw new Error("Missing inert owner.");
  const witness = await result.owner.bindRetirement(epoch, signal()); f.port.exit();
  assert.equal(witness.current.level, "running");
  f.kernel.replies.push({ second: { ...f.kernel.record, state: "zombie" }, ...flags, exitSeen: true });
  const zombie: unknown = await witness.observe(signal());
  assert.deepEqual(zombie, { level: "non-running", identity: { pid: 1234, uid: 501, parentPid: 100, epoch,
    birth: { platform: "darwin", seconds: f.kernel.record.seconds, micros: 12345 } } });
  assert.equal(witness.current.level, "non-running");
  f.kernel.replies.push({ second: { kind: "absent" }, ...flags, exitSeen: true });
  await witness.waitForRetirement(signal()); assert.deepEqual(await witness.observe(signal()), { level: "reaped", identity: null });
  const close = deferred<void>(); f.kernel.closeHold = close.promise; let settled = false;
  const reads = witness.settleReads(); void reads.then(() => { settled = true; }); await turn();
  assert.equal(settled, false); assert.equal(witness.current.level, "reaped");
  close.accept(); await reads; assert.equal(settled, true); assert.equal(witness.current.level, "reaped");
});

test("failed original Mac observer closure remains the exact refused allocation promise", async () => {
  const kernel = new InertKernel(), close = deferred<void>(); kernel.closeHold = close.promise;
  const boundary = kernel.boundary(randomUUID()), allocation = createMacChildRetirementAllocation(boundary);
  await allocation.bind(signal()); const first = allocation.settleReads();
  close.reject(new Error("inert close refusal")); await assert.rejects(first, { code: "TEARDOWN_FAILED" });
  assert.equal(allocation.settleReads(), first); await assert.rejects(allocation.settleReads(), { code: "TEARDOWN_FAILED" });
  assert.equal(kernel.calls.filter((call) => call === "close").length, 1); assert.equal(boundary.current.level, "ambiguous");
});

test("production Mac allocator refuses ordinary Node before artifact or native loading", async () => {
  await assert.rejects(createMacChildRetirementAllocator({ root: "/never-read-owned-fixture", retirement: { bytes: 1, sha256: "a".repeat(64) } }),
    { code: "INTEGRITY_FAILED" });
});

test("Mac speech drops loader and logging aliases without mutating its ordinary environment", () => {
  const input: NodeJS.ProcessEnv = { PATH: "/fixed/bin", SAFE_FIXTURE: "preserved", DYLD_INSERT_LIBRARIES: "inert value",
    DYLD_FALLBACK_FRAMEWORK_PATH: "inert value", __XPC_DYLD_LIBRARY_PATH: "inert value" };
  for (const key of MAC_SPEECH_EXCLUDED_ENVIRONMENT) input[key] = "inert value";
  const cleaned = macSpeechEnvironment(input);
  for (const key of [...MAC_SPEECH_EXCLUDED_ENVIRONMENT, "DYLD_INSERT_LIBRARIES", "DYLD_FALLBACK_FRAMEWORK_PATH", "__XPC_DYLD_LIBRARY_PATH"]) {
    assert.equal(cleaned[key], undefined); assert.equal(input[key], "inert value");
  }
  assert.equal(cleaned.PATH, "/fixed/bin"); assert.equal(cleaned.SAFE_FIXTURE, "preserved");
});

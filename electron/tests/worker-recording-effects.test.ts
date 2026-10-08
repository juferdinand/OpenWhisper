import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { WorkContext } from "../src/core/recording.js";
import { WorkerRecordingEffects, type RecordingEffectPort } from "../src/workers/recording-effects.js";
import type { RecordingEffectReply, RecordingEffectRequest } from "../src/workers/recording-effects-protocol.js";

class OwnedPort implements RecordingEffectPort {
  readonly sent: RecordingEffectRequest[] = [];
  readonly messages = new Set<(input: unknown) => void>();
  readonly exits = new Set<() => void>();
  send(request: RecordingEffectRequest): void { this.sent.push(request); }
  onMessage(listener: (input: unknown) => void): () => void {
    this.messages.add(listener); return () => { this.messages.delete(listener); };
  }
  onExit(listener: () => void): () => void { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
  receive(reply: unknown): void { for (const listener of this.messages) listener(reply); }
  exit(): void { for (const listener of this.exits) listener(); }
  last(): RecordingEffectRequest { const request = this.sent.at(-1); assert.ok(request); return request; }
}
const model = { path: "/owned/model.bin", family: "whisper" as const, gpu: false };
const samples = new Float32Array(16000);
function context(controller = new AbortController(), attempt = 1): WorkContext {
  return { generation: 1, attempt, signal: controller.signal };
}
function reply(request: RecordingEffectRequest, text = "Public fixture result"): RecordingEffectReply {
  assert.equal(request.command, "infer");
  return { version: 1, epoch: request.epoch, id: request.id, generation: request.generation,
    attempt: request.attempt, kind: "infer", text };
}
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (condition()) return; await setImmediate(); }
  assert.fail("Owned worker RPC did not reach its expected boundary.");
}

test("worker promptly cancels inference but retains cleanup ownership before the next window", async () => {
  const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID());
  const controller = new AbortController(); const current = context(controller);
  const operation = effects.infer(current).transcribeWindow(model, samples, "de", "", current.signal);
  const cancelled = assert.rejects(operation, /CANCELLED/);
  await until(() => port.sent.length === 1); const original = port.last(); controller.abort(); await cancelled;
  assert.equal(port.last().command, "cancel");
  const next = context(new AbortController(), 2);
  const retried = effects.infer(next).transcribeWindow(model, samples, "de", "", next.signal);
  await setImmediate(); assert.equal(port.sent.length, 2);
  port.receive(reply(original)); await until(() => port.sent.length === 3);
  assert.equal(port.last().attempt, 2); port.receive(reply(port.last(), "Next owned window"));
  assert.equal(await retried, "Next owned window"); await effects.close();
  assert.equal(port.messages.size, 0); assert.equal(port.exits.size, 0);
});

test("worker waits for a late confirmed complete delivery after cancellation and close", async () => {
  const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID());
  const controller = new AbortController(); const current = context(controller);
  const text = "Unchanged 日本語 👩‍💻\n".repeat(200_000);
  assert.ok(Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024);
  let finished = false;
  const delivery = effects.delivery.deliver(text, current, { kind: "recovery", token: randomUUID() })
    .then((receipt) => { finished = true; return receipt; });
  await until(() => port.sent.length === 1); const request = port.last();
  assert.equal(request.command, "deliver"); if (request.command === "deliver") assert.equal(request.text, text);
  controller.abort(); const closing = effects.close(); await setImmediate(); assert.equal(finished, false);
  assert.equal(port.sent.length, 2); assert.equal(port.last().command, "cancel");
  port.receive({ version: 1, epoch: request.epoch, id: request.id, generation: request.generation,
    attempt: request.attempt, kind: "deliver", receipt: { generation: 1, attempt: 1,
      outcome: "clipboard", clipboardConfirmed: true } });
  assert.equal((await delivery).outcome, "clipboard"); await closing;
  assert.equal(port.messages.size, 0); assert.equal(port.exits.size, 0);
});

test("worker cannot reuse an owner when cancellation cleanup exceeds its separate deadline", async () => {
  const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID(), { effectMs: 10_000, cleanupMs: 20 });
  const controller = new AbortController(); const current = context(controller);
  const operation = effects.infer(current).transcribeWindow(model, samples, "en", "", current.signal);
  const cancelled = assert.rejects(operation, /CANCELLED/);
  await until(() => port.sent.length === 1); controller.abort(); await cancelled;
  const next = context(new AbortController(), 2);
  const blocked = effects.infer(next).transcribeWindow(model, samples, "en", "", next.signal);
  await assert.rejects(blocked, /TEARDOWN_FAILED/); assert.equal(port.sent.length, 2);
  await assert.rejects(effects.close(), /TEARDOWN_FAILED/);
  assert.equal(port.messages.size, 0); assert.equal(port.exits.size, 0);
});

test("worker rejects mismatched epoch, operation, generation, attempt and receipt ownership", async () => {
  for (const change of [{ epoch: randomUUID() }, { id: randomUUID() }, { generation: 2 }, { attempt: 2 }]) {
    const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID()); const current = context();
    const operation = effects.infer(current).transcribeWindow(model, samples, "en", "", current.signal);
    const refused = assert.rejects(operation, /INVALID_REPLY/);
    await until(() => port.sent.length === 1); port.receive({ ...reply(port.last()), ...change }); await refused;
    await assert.rejects(effects.close(), /INVALID_REPLY/);
  }
  const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID()); const current = context();
  const operation = effects.delivery.deliver("Public fixture", current, { kind: "recovery", token: randomUUID() });
  const refused = assert.rejects(operation, /INVALID_REPLY/); await until(() => port.sent.length === 1);
  const request = port.last();
  port.receive({ version: 1, epoch: request.epoch, id: request.id, generation: 1, attempt: 1,
    kind: "deliver", receipt: { generation: 1, attempt: 2, outcome: "clipboard", clipboardConfirmed: true } });
  await refused; await assert.rejects(effects.close(), /INVALID_REPLY/);
});

test("worker uses the adaptive attempt signal and rejects shared-memory input before sending", async () => {
  const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID()); const current = context();
  const derived = new AbortController(); derived.abort();
  await assert.rejects(effects.infer(current).transcribeWindow(model, samples, "de", "", derived.signal), /CANCELLED/);
  await assert.rejects(effects.infer(current).transcribeWindow(model,
    new Float32Array(new SharedArrayBuffer(64000)), "de", "", current.signal), /INVALID_REPLY/);
  assert.equal(port.sent.length, 0); await effects.close();
});

test("worker copies only an offset inference view before structured cloning to main", async () => {
  const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID()); const current = context();
  const source = new Float32Array(new ArrayBuffer(16 * 1024 * 1024), 4096, 16);
  source.set([0.125, -0.25, 0.5]);
  const operation = effects.infer(current).transcribeWindow(model, source, "en", "", current.signal);
  await until(() => port.sent.length === 1); const request = structuredClone(port.last());
  assert.equal(request.command, "infer"); if (request.command === "infer") {
    assert.equal(request.samples.buffer.byteLength, 64); assert.equal(request.samples.byteOffset, 0);
    assert.deepEqual([...request.samples], [...source]); assert.notEqual(request.samples.buffer, source.buffer);
  }
  port.receive(reply(request)); await operation; await effects.close();
});

test("abort during the cleanup microtask handoff sends no inference or cancellation frame", async () => {
  const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID());
  const controller = new AbortController(); const current = context(controller);
  const operation = effects.infer(current).transcribeWindow(model, samples, "en", "", current.signal);
  const cancelled = assert.rejects(operation, /CANCELLED/);
  queueMicrotask(() => { queueMicrotask(() => { controller.abort(); }); });
  await cancelled; assert.equal(port.sent.length, 0); await effects.close();
});

test("worker treats unexpected transport exit as terminal without opening another owner", async () => {
  const port = new OwnedPort(); const effects = new WorkerRecordingEffects(port, randomUUID()); const current = context();
  const operation = effects.infer(current).transcribeWindow(model, samples, "en", "", current.signal);
  const failed = assert.rejects(operation, /WORKER_FAILED/); await until(() => port.sent.length === 1); port.exit(); await failed;
  await assert.rejects(effects.infer(current).transcribeWindow(model, samples, "en", "", current.signal), /WORKER_FAILED/);
  assert.equal(port.sent.length, 1); await assert.rejects(effects.close(), /WORKER_FAILED/);
  assert.equal(port.messages.size, 0); assert.equal(port.exits.size, 0);
});

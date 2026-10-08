import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { DeliveryReceipt, WorkContext } from "../src/core/recording.js";
import { DeliveryReceiptCache, MainRecordingEffects } from "../src/main/recording-effects.js";
import { SpeechWorkerError } from "../src/services/speech-client.js";
import { recordingEffectRequestSchema, recordingEffectReplySchema,
  safeRecordingEffectError } from "../src/workers/recording-effects-protocol.js";

const envelope = { version: 1, epoch: randomUUID(), id: randomUUID(), generation: 3, attempt: 2 };
const inference = { ...envelope, command: "infer", model: { path: "/owned/model.bin", family: "whisper", gpu: false },
  samples: new Float32Array(16000), language: "de", vocabulary: "Unchanged 日本語 👩‍💻" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const copied = (context: WorkContext): DeliveryReceipt => ({ generation: context.generation, attempt: context.attempt,
  outcome: "clipboard", clipboardConfirmed: true });
function fixture(receipts = new DeliveryReceiptCache()) {
  let creates = 0; let inferences = 0; let closes = 0; let deliveries = 0;
  let inferHook: ((signal?: AbortSignal) => Promise<string>) | undefined;
  let closeHook: (() => Promise<void>) | undefined;
  let deliveryHook: ((text: string, context: WorkContext) => Promise<DeliveryReceipt>) | undefined;
  const options = { epoch: envelope.epoch, platform: "linux" as const, receipts,
    approveModel: (model: { path: string }) => model.path === "/owned/model.bin",
    createSpeech: () => {
      creates++;
      return { async transcribeWindow(_model: unknown, _samples: Float32Array, _language: string, _vocabulary: string, signal?: AbortSignal) {
        inferences++; return inferHook ? inferHook(signal) : "Fixture result";
      }, async close() { closes++; await closeHook?.(); } };
    }, delivery: { async deliver(text: string, context: WorkContext) {
      deliveries++; return deliveryHook ? deliveryHook(text, context) : copied(context);
    } },
  };
  return { options, broker: new MainRecordingEffects(options), receipts,
    counts: () => ({ creates, inferences, closes, deliveries }),
    infer: (hook: NonNullable<typeof inferHook>) => { inferHook = hook; },
    closing: (hook: NonNullable<typeof closeHook>) => { closeHook = hook; },
    delivery: (hook: NonNullable<typeof deliveryHook>) => { deliveryHook = hook; } };
}
const delivery = (token = randomUUID(), epoch = envelope.epoch, text = "Unchanged 日本語 👩‍💻") => ({
  ...envelope, epoch, id: randomUUID(), command: "deliver", text, identity: { kind: "recovery", token } });
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) { if (condition()) return; await setImmediate(); }
  assert.fail("Owned broker did not reach its expected effect.");
}

test("recording effects permit only bounded finite inference windows and closed metadata", () => {
  assert.doesNotThrow(() => recordingEffectRequestSchema.parse(inference));
  for (const input of [
    { ...inference, samples: new Float32Array(480001) },
    { ...inference, samples: new Float32Array([Number.NaN]) },
    { ...inference, samples: new Float32Array(new SharedArrayBuffer(64000)) },
    { ...inference, samples: new Float32Array(new ArrayBuffer(16 * 1024 * 1024), 4096, 16) },
    { ...inference, model: { ...inference.model, path: "relative.bin" } },
    { ...inference, arbitraryCode: "/owned/other-code.js" },
    { ...inference, epoch: "unowned" }, { ...inference, attempt: 0 },
    { ...inference, command: "native_method" },
  ]) assert.throws(() => recordingEffectRequestSchema.parse(input));
});

test("complete final text above four MiB survives the delivery protocol byte for byte", () => {
  const text = "Unchanged 日本語 👩‍💻\n".repeat(200_000);
  assert.ok(Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024);
  const delivery = recordingEffectRequestSchema.parse({ ...envelope, command: "deliver", text,
    identity: { kind: "recovery", token: randomUUID() } });
  assert.equal(delivery.command, "deliver"); if (delivery.command === "deliver") assert.strictEqual(delivery.text, text);
  assert.throws(() => recordingEffectRequestSchema.parse({ ...envelope, command: "deliver", text,
    identity: { kind: "memory", generation: 4 } }));
});

test("delivery receipts cannot contradict native output confirmation", () => {
  const frame = { ...envelope, kind: "deliver", receipt: {
    generation: 3, attempt: 2, outcome: "clipboard", clipboardConfirmed: true } };
  assert.doesNotThrow(() => recordingEffectReplySchema.parse(frame));
  assert.throws(() => recordingEffectReplySchema.parse({ ...frame,
    receipt: { ...frame.receipt, clipboardConfirmed: false } }));
  assert.throws(() => recordingEffectReplySchema.parse({ ...frame, extra: "sensitive" }));
  assert.equal(safeRecordingEffectError({ code: "TEARDOWN_FAILED", message: "private" }).code, "TEARDOWN_FAILED");
  assert.equal(safeRecordingEffectError(new Error("private native detail")).message.includes("private"), false);
});

test("main broker refuses arbitrary model files and wrong helper epochs before opening native inference", async () => {
  const f = fixture();
  const refused = await f.broker.handle({ ...inference, model: { ...inference.model, path: "/unowned/model.bin" } });
  assert.equal(refused?.kind, "failed"); if (refused?.kind === "failed") assert.equal(refused.code, "OWNERSHIP_FAILED");
  await assert.rejects(f.broker.handle({ ...inference, epoch: randomUUID() }), /OWNERSHIP_FAILED/);
  await assert.rejects(f.broker.handle({ ...inference, arbitraryCode: "private" }), /INVALID_FRAME/);
  assert.deepEqual(f.counts(), { creates: 0, inferences: 0, closes: 0, deliveries: 0 }); await f.broker.close();
});

test("async speech opening stays owned through cancellation and late original client retirement", async () => {
  const f = fixture(), opening = deferred<import("../src/services/recording-speech.js").RecordingInferenceClient>();
  const retired = deferred<void>(); let opens = 0, inferences = 0, closes = 0, replied = false, ended = false;
  const broker = new MainRecordingEffects({ epoch: envelope.epoch, platform: "linux", receipts: f.receipts,
    delivery: f.options.delivery, speech: { open: async (_model, signal) => {
      opens++; assert.equal(signal.aborted, false); return opening.promise;
    } } });
  const accepted = broker.handle(inference).then((reply) => { replied = true; return reply; });
  await until(() => opens === 1); await broker.handle({ ...envelope, command: "cancel" });
  const busy = await broker.handle({ ...inference, id: randomUUID() });
  assert.equal(busy?.kind, "failed"); if (busy?.kind === "failed") assert.equal(busy.code, "BUSY");
  const closing = broker.close().then(() => { ended = true; });
  await setImmediate(); assert.equal(replied, false); assert.equal(ended, false);
  opening.resolve({ transcribeWindow: async () => { inferences++; return "Must not infer"; },
    close: () => { closes++; return retired.promise; } });
  await until(() => closes === 1); assert.equal(inferences, 0); assert.equal(replied, false); assert.equal(ended, false);
  retired.resolve(); const reply = await accepted; await closing;
  assert.equal(reply?.kind, "failed"); if (reply?.kind === "failed") assert.equal(reply.code, "CANCELLED");
  assert.deepEqual({ opens, inferences, closes }, { opens: 1, inferences: 0, closes: 1 });
});

test("opening teardown refusal remains fatal to broker reuse and shutdown", async () => {
  const f = fixture(); let opens = 0;
  const broker = new MainRecordingEffects({ epoch: envelope.epoch, platform: "linux", receipts: f.receipts,
    delivery: f.options.delivery, speech: { open: async () => { opens++; throw { code: "TEARDOWN_FAILED" }; } } });
  for (const id of [envelope.id, randomUUID()]) {
    const reply = await broker.handle({ ...inference, id });
    assert.equal(reply?.kind, "failed"); if (reply?.kind === "failed") assert.equal(reply.code, "TEARDOWN_FAILED");
  }
  assert.equal(opens, 1); await assert.rejects(broker.close(), { code: "TEARDOWN_FAILED" });
});

test("native integrity and invalid model authority are never rewritten as retryable worker failures", () => {
  for (const code of ["INTEGRITY_FAILED", "INVALID_INPUT", "BACKEND_UNAVAILABLE"]) {
    assert.equal(safeRecordingEffectError({ code, message: "Private diagnostic" }).code, "OWNERSHIP_FAILED");
  }
});

test("cancelled inference acknowledges only after confirmed helper cleanup and never overlaps a new owner", async () => {
  const f = fixture(); const cleanup = deferred<void>();
  f.closing(() => cleanup.promise);
  f.infer(async (signal) => new Promise<string>((_accept, reject) => {
    assert.ok(signal); signal.addEventListener("abort", () => reject(new SpeechWorkerError("CANCELLED")), { once: true });
  }));
  let replied = false; const original = f.broker.handle(inference).then((reply) => { replied = true; return reply; });
  await until(() => f.counts().inferences === 1);
  await f.broker.handle({ ...envelope, command: "cancel" });
  await until(() => f.counts().closes === 1); assert.equal(replied, false);
  const busy = await f.broker.handle({ ...inference, id: randomUUID(), attempt: 3 });
  assert.equal(busy?.kind, "failed"); if (busy?.kind === "failed") assert.equal(busy.code, "BUSY");
  assert.equal(f.counts().creates, 1);
  cleanup.resolve(); const cancelled = await original;
  assert.equal(cancelled?.kind, "failed"); if (cancelled?.kind === "failed") assert.equal(cancelled.code, "CANCELLED");
  f.infer(async () => "Fresh owner");
  const retried = await f.broker.handle({ ...inference, id: randomUUID(), attempt: 3 });
  assert.equal(retried?.kind, "infer"); assert.equal(f.counts().creates, 2); await f.broker.close();
});

test("failed native teardown permanently blocks broker reuse with a fixed safe error", async () => {
  const f = fixture(); f.infer(async () => { throw new SpeechWorkerError("NATIVE_FAILED"); });
  f.closing(async () => { throw new Error("private native details"); });
  for (const id of [envelope.id, randomUUID()]) {
    const reply = await f.broker.handle({ ...inference, id });
    assert.equal(reply?.kind, "failed"); if (reply?.kind === "failed") assert.equal(reply.code, "TEARDOWN_FAILED");
    assert.equal(JSON.stringify(reply).includes("private"), false);
  }
  assert.equal(f.counts().creates, 1); await assert.rejects(f.broker.close(), /TEARDOWN_FAILED/);
});

test("cancel before main dispatch opens no speech context", async () => {
  const f = fixture(); const operation = f.broker.handle(inference);
  await f.broker.handle({ ...envelope, command: "cancel" });
  const reply = await operation;
  assert.equal(reply?.kind, "failed"); if (reply?.kind === "failed") assert.equal(reply.code, "CANCELLED");
  assert.equal(f.counts().creates, 0); await f.broker.close();
});

test("late confirmed long delivery survives cancel and reply loss across a capture-helper epoch", async () => {
  const f = fixture(); const commit = deferred<DeliveryReceipt>(); let captured: WorkContext | undefined;
  const text = "Unchanged 日本語 👩‍💻\n".repeat(200_000); const request = delivery(randomUUID(), envelope.epoch, text);
  f.delivery(async (received, context) => { assert.strictEqual(received, text); captured = context; return commit.promise; });
  const operation = f.broker.handle(request); await until(() => captured !== undefined); assert.ok(captured);
  await f.broker.handle({ ...envelope, id: request.id, command: "cancel" }); assert.equal(captured.signal.aborted, true);
  const closing = f.broker.close(); commit.resolve(copied(captured));
  const oldReply = await operation; assert.equal(oldReply?.kind, "deliver"); await closing;
  // Drop oldReply as if the capture utility disappeared after native commit.
  const epoch = randomUUID(); const replacement = new MainRecordingEffects({ ...f.options, epoch });
  const restored = await replacement.handle({ ...request, epoch, id: randomUUID(), generation: 1, attempt: 1 });
  assert.equal(restored?.kind, "deliver"); if (restored?.kind === "deliver") {
    assert.deepEqual(restored.receipt, { generation: 1, attempt: 1, outcome: "clipboard", clipboardConfirmed: true });
  }
  assert.equal(f.counts().deliveries, 1); assert.equal(f.counts().creates, 0); await replacement.close();
});

test("delivery ownership and Linux recovery identities cannot falsely confirm output", async () => {
  const f = fixture(); f.delivery(async (_text, context) => ({ ...copied(context), generation: context.generation + 1 }));
  const request = delivery(); const reply = await f.broker.handle(request);
  assert.equal(reply?.kind, "failed"); if (reply?.kind === "failed") assert.equal(reply.code, "OWNERSHIP_FAILED");
  f.delivery(async (_text, context) => copied(context));
  const uncertain = await f.broker.handle({ ...request, id: randomUUID() });
  assert.equal(uncertain?.kind, "failed"); if (uncertain?.kind === "failed") assert.equal(uncertain.code, "BUSY");
  assert.equal(f.counts().deliveries, 1);
  const noRecovery = await f.broker.handle({ ...request, id: randomUUID(), identity: { kind: "memory", generation: 3 } });
  assert.equal(noRecovery?.kind, "failed"); if (noRecovery?.kind === "failed") assert.equal(noRecovery.code, "OWNERSHIP_FAILED");
  assert.equal(f.counts().deliveries, 1); await f.broker.close();
});

test("receipt capacity is reserved before output and never evicts a still recoverable confirmed identity", async () => {
  const f = fixture(new DeliveryReceiptCache(1)); const request = delivery();
  assert.equal((await f.broker.handle(request))?.kind, "deliver");
  const refused = await f.broker.handle(delivery());
  assert.equal(refused?.kind, "failed"); if (refused?.kind === "failed") assert.equal(refused.code, "BUSY");
  await f.broker.close(); const epoch = randomUUID(); const replacement = new MainRecordingEffects({ ...f.options, epoch });
  const restored = await replacement.handle({ ...request, epoch, id: randomUUID() });
  assert.equal(restored?.kind, "deliver"); assert.equal(f.counts().deliveries, 1); await replacement.close();
});

test("a shared receipt reservation prevents overlapping output owners across helper epochs", async () => {
  const f = fixture(); const commit = deferred<DeliveryReceipt>(); let captured: WorkContext | undefined;
  const request = delivery(); f.delivery(async (_text, context) => { captured = context; return commit.promise; });
  const operation = f.broker.handle(request); await until(() => captured !== undefined); assert.ok(captured);
  const epoch = randomUUID(); const replacement = new MainRecordingEffects({ ...f.options, epoch });
  const refused = await replacement.handle({ ...request, epoch, id: randomUUID() });
  assert.equal(refused?.kind, "failed"); if (refused?.kind === "failed") assert.equal(refused.code, "BUSY");
  assert.equal(f.counts().deliveries, 1); commit.resolve(copied(captured)); await operation;
  assert.equal((await replacement.handle({ ...request, epoch, id: randomUUID() }))?.kind, "deliver");
  assert.equal(f.counts().deliveries, 1); await f.broker.close(); await replacement.close();
});

test("foreign cancellation cannot abort a reserved inference", async () => {
  const f = fixture(); const result = deferred<string>(); let signal: AbortSignal | undefined;
  f.infer(async (received) => { signal = received; return result.promise; });
  const operation = f.broker.handle(inference); await until(() => signal !== undefined);
  await assert.rejects(f.broker.handle({ ...envelope, id: randomUUID(), command: "cancel" }), /OWNERSHIP_FAILED/);
  await assert.rejects(f.broker.handle({ ...envelope, generation: 4, command: "cancel" }), /OWNERSHIP_FAILED/);
  assert.equal(signal?.aborted, false); result.resolve("Original owner unchanged");
  assert.equal((await operation)?.kind, "infer"); await f.broker.close();
});

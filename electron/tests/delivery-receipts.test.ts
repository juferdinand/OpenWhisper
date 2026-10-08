import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { DeliveryIdentity, DeliveryReceipt, WorkContext } from "../src/core/recording.js";
import { DeliveryReceiptCache, MainRecordingEffects } from "../src/main/recording-effects.js";

function fixture(capacity = 128) {
  const cache = new DeliveryReceiptCache(capacity);
  let writes = 0;
  const broker = (epoch: string) => new MainRecordingEffects({ epoch, platform: "linux", receipts: cache,
    speech: { async open() { throw new Error("Inference was not requested."); } },
    delivery: { async deliver(_text, context) {
      writes++;
      return { generation: context.generation, attempt: context.attempt, outcome: "clipboard", clipboardConfirmed: true };
    } },
  });
  return { cache, broker, writes: () => writes };
}
const identity = (): DeliveryIdentity => ({ kind: "recovery", token: randomUUID() });
function request(epoch: string, token: DeliveryIdentity, generation = 1, attempt = 1) {
  return { version: 1, epoch, id: randomUUID(), generation, attempt, command: "deliver", identity: token,
    text: "Preserved 日本語 👩‍💻 output" };
}

test("confirmed recovery removal permits more than 128 sequential real broker deliveries", async () => {
  const f = fixture(), epoch = randomUUID(), broker = f.broker(epoch);
  for (let n = 1; n <= 260; n++) {
    const token = identity(), context = { generation: n, attempt: n };
    const result = await broker.handle(request(epoch, token, n, n));
    assert.equal(result?.kind, "deliver");
    assert.equal(f.cache.retireConfirmedRemoval(epoch, token, context), true);
    assert.equal(f.cache.retireConfirmedRemoval(epoch, token, context), false);
  }
  assert.equal(f.writes(), 260);
  await broker.close();
});

test("only the most recently issued committed delivery epoch and context authorize removal", async () => {
  const f = fixture(1), epoch = randomUUID(), broker = f.broker(epoch), token = identity();
  assert.equal((await broker.handle(request(epoch, token)))?.kind, "deliver");
  assert.equal(f.cache.retireConfirmedRemoval(randomUUID(), token, { generation: 1, attempt: 1 }), false);
  assert.equal(f.cache.retireConfirmedRemoval(epoch, identity(), { generation: 1, attempt: 1 }), false);
  assert.equal(f.cache.retireConfirmedRemoval(epoch, token, { generation: 2, attempt: 1 }), false);
  assert.equal(f.cache.retireConfirmedRemoval(epoch, token, { generation: 1, attempt: 2 }), false);
  assert.equal(f.cache.retireConfirmedRemoval(epoch, token, { generation: 0, attempt: 1 }), false);
  // Replaying the retained receipt changes authority without copying output again.
  assert.equal((await broker.handle(request(epoch, token, 2, 3)))?.kind, "deliver");
  assert.equal(f.cache.retireConfirmedRemoval(epoch, token, { generation: 1, attempt: 1 }), false);
  const replacementEpoch = randomUUID(), replacement = f.broker(replacementEpoch);
  assert.equal((await replacement.handle(request(replacementEpoch, token, 4, 5)))?.kind, "deliver");
  assert.equal(f.cache.retireConfirmedRemoval(epoch, token, { generation: 4, attempt: 5 }), false);
  assert.equal(f.cache.retireConfirmedRemoval(replacementEpoch, token, { generation: 2, attempt: 3 }), false);
  assert.equal(f.cache.retireConfirmedRemoval(replacementEpoch, token, { generation: 4, attempt: 5 }), true);
  assert.equal(f.writes(), 1);
  await broker.close(); await replacement.close();
});

test("lost delivery replies retain replay protection and capacity until exact removal acknowledgment", async () => {
  const f = fixture(1), epoch = randomUUID(), token = identity(), broker = f.broker(epoch);
  await broker.handle(request(epoch, token)); // Drop the original successful reply.
  await broker.close();
  const replacementEpoch = randomUUID(), replacement = f.broker(replacementEpoch);
  const refused = await replacement.handle(request(replacementEpoch, identity()));
  assert.equal(refused?.kind, "failed"); if (refused?.kind === "failed") assert.equal(refused.code, "BUSY");
  assert.equal(f.writes(), 1);
  const replay = await replacement.handle(request(replacementEpoch, token, 2, 7));
  assert.equal(replay?.kind, "deliver");
  if (replay?.kind === "deliver") assert.deepEqual(replay.receipt,
    { generation: 2, attempt: 7, outcome: "clipboard", clipboardConfirmed: true });
  assert.equal(f.cache.retireConfirmedRemoval(epoch, token, { generation: 1, attempt: 1 }), false);
  assert.equal(f.writes(), 1);
  assert.equal(f.cache.retireConfirmedRemoval(replacementEpoch, token, { generation: 2, attempt: 7 }), true);
  assert.equal((await replacement.handle(request(replacementEpoch, identity())))?.kind, "deliver");
  assert.equal(f.writes(), 2);
  await replacement.close();
});

test("unconfirmed reservations and memory receipts cannot be retired by a recovery acknowledgment", () => {
  const cache = new DeliveryReceiptCache(1), epoch = randomUUID(), token = identity(), reservation = randomUUID();
  cache.reserve(epoch, token, reservation);
  assert.equal(cache.retireConfirmedRemoval(epoch, token, { generation: 1, attempt: 1 }), false);
  assert.throws(() => cache.reserve(epoch, identity(), randomUUID()), { code: "BUSY" });
  // A known failed external write may abandon its reservation through the existing API.
  cache.abandonFailed(epoch, token, reservation);
  const memory: DeliveryIdentity = { kind: "memory", generation: 1 }, memoryReservation = randomUUID();
  cache.reserve(epoch, memory, memoryReservation);
  const receipt: DeliveryReceipt = { generation: 1, attempt: 1, outcome: "clipboard", clipboardConfirmed: true };
  cache.remember(epoch, memory, receipt, memoryReservation);
  const context: WorkContext = { generation: 1, attempt: 1, signal: new AbortController().signal };
  assert.deepEqual(cache.get(epoch, memory, context), receipt);
  assert.equal(cache.retireConfirmedRemoval(epoch, memory, { generation: 1, attempt: 1 }), false);
  assert.throws(() => cache.reserve(epoch, identity(), randomUUID()), { code: "BUSY" });
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DeliveryReceiptCache } from "../../../src/main/recording-effects.js";

test("confirmed memory releases allow more than the receipt cache capacity without eviction", () => {
  const cache = new DeliveryReceiptCache(2), epoch = randomUUID();
  for (let generation = 1; generation <= 260; generation++) {
    const identity = { kind: "memory" as const, generation }, reservation = randomUUID();
    cache.reserve(epoch, identity, reservation);
    cache.remember(epoch, identity, { generation, attempt: 1, outcome: "clipboard", clipboardConfirmed: true }, reservation);
    assert.equal(cache.retireConfirmedMemoryRelease(randomUUID(), { generation, attempt: 1 }), false);
    assert.equal(cache.retireConfirmedMemoryRelease(epoch, { generation, attempt: 2 }), false);
    assert.equal(cache.retireConfirmedMemoryRelease(epoch, { generation, attempt: 1 }), true);
  }
});
test("retired Mac RAM epochs clear uncertain memory receipts and preserve durable Linux receipts", () => {
  const cache = new DeliveryReceiptCache(2), epoch = randomUUID(), token = randomUUID();
  cache.reserve(epoch, { kind: "memory", generation: 1 }, randomUUID());
  cache.reserve(epoch, { kind: "recovery", token }, randomUUID());
  assert.equal(cache.retireConfirmedMemoryRelease(epoch, { generation: 1, attempt: 1 }), false);
  cache.retireMemoryEpoch(epoch);
  cache.reserve(epoch, { kind: "memory", generation: 2 }, randomUUID());
  assert.throws(() => cache.reserve(randomUUID(), { kind: "memory", generation: 1 }, randomUUID()), { code: "BUSY" });
});

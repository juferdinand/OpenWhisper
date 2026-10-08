import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SpeechClient, SpeechWorkerError, type SpeechChannel } from "../src/services/speech-client.js";

const code = (expected: string) => (error: unknown): boolean => error instanceof SpeechWorkerError && error.code === expected;

test("trusted terminal factory refusals preserve their category and permanently exclude reallocation", async () => {
  for (const category of ["TEARDOWN_FAILED", "INTEGRITY_FAILED"] as const) {
    let starts = 0;
    const client = new SpeechClient(async () => { starts++; throw new SpeechWorkerError(category); });
    await assert.rejects(client.gpuDevice(), code(category));
    await assert.rejects(client.gpuDevice(), code(category));
    await assert.rejects(client.gpuDevice(), code(category));
    assert.equal(starts, 1);
    await assert.rejects(client.close(), code("WORKER_FAILED"));
    await assert.rejects(client.gpuDevice(), code("CLOSED"));
  }
});

test("a terminal factory failure after cancellation remains owned before any retry", async () => {
  let starts = 0;
  let refuse = (_error: Error): void => { throw new Error("Uninitialized factory fixture."); };
  const returned = new Promise<SpeechChannel>((_accept, reject) => { refuse = reject; });
  const client = new SpeechClient(async () => { starts++; return returned; });
  const cancel = new AbortController();
  const pending = client.gpuDevice(cancel.signal);
  const cancelled = assert.rejects(pending, code("CANCELLED"));
  await nextTurn(); cancel.abort(); await cancelled;
  refuse(new SpeechWorkerError("TEARDOWN_FAILED")); await nextTurn();
  await assert.rejects(client.gpuDevice(), code("TEARDOWN_FAILED"));
  assert.equal(starts, 1);
  await assert.rejects(client.close(), code("WORKER_FAILED"));
});

test("an arbitrary exception code cannot supply trusted integrity or teardown categories", async () => {
  for (const category of ["INTEGRITY_FAILED", "TEARDOWN_FAILED"]) {
    let starts = 0;
    const client = new SpeechClient(async () => {
      starts++; throw Object.assign(new Error("Private factory details."), { code: category });
    });
    await assert.rejects(client.gpuDevice(), code("START_FAILED"));
    await assert.rejects(client.gpuDevice(), code("START_FAILED"));
    assert.equal(starts, 2); await client.close();
  }
});

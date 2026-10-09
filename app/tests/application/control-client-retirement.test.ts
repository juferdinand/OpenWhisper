import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ControlClientError, DevelopmentControlClient, type DevelopmentControlPort } from "../../src/platforms/linux/shared/control-client.js";

function deferred() {
  let resolve = (): void => { throw new Error("Uninitialized test completion."); };
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function port(unsubscribe: () => Promise<void>, closing: Promise<void>) {
  const epoch = randomUUID();
  let closed = false, closes = 0;
  const frame = (value: unknown, sender = "org.freedesktop.DBus") => ({ generation: epoch, sender, value });
  const implementation: DevelopmentControlPort = {
    generation: epoch, get isClosed() { return closed; },
    watchDevelopmentOwner: async () => unsubscribe,
    resolveDevelopmentOwner: async () => frame(":1.7"),
    ownerUid: async () => frame(1000),
    readStatus: async () => frame('{"status":"idle","elapsed":0,"recovery_available":false}', ":1.7"),
    executeAction: async () => { throw new Error("This test must not dispatch actions."); },
    close: async () => { closes++; await closing; closed = true; },
  };
  return { implementation, closes: () => closes };
}

test("a settled close certificate cannot hide a still-held unsubscribe operation", async () => {
  const unsubscribe = deferred();
  const fixture = port(() => unsubscribe.promise, Promise.resolve());
  const client = new DevelopmentControlClient({ uid: 1000, cleanupMs: 20, factory: async () => fixture.implementation });
  await assert.rejects(client.execute("status"), (error: unknown) => error instanceof ControlClientError && error.code === "DISPOSAL_FAILED");
  assert.equal(fixture.implementation.isClosed, true); assert.equal(fixture.closes(), 1);
  unsubscribe.resolve(); await nextTurn();
  await assert.rejects(client.close(), (error: unknown) => error instanceof ControlClientError && error.code === "DISPOSAL_FAILED");
  await assert.rejects(client.execute("status"), (error: unknown) => error instanceof ControlClientError && error.code === "CLOSED");
});

test("unsubscribe refusal still waits for the authoritative all-resource close certificate", async () => {
  const closing = deferred();
  const fixture = port(async () => { throw new Error("Private subscription information."); }, closing.promise);
  const client = new DevelopmentControlClient({ uid: 1000, cleanupMs: 1000, factory: async () => fixture.implementation });
  let delivered = false;
  const pending = client.execute("status").then((value) => { delivered = true; return value; });
  const deadline = performance.now() + 1000;
  while (fixture.closes() === 0) { assert.ok(performance.now() < deadline); await nextTurn(); }
  assert.equal(delivered, false); assert.equal(fixture.implementation.isClosed, false);
  await assert.rejects(client.execute("status"), (error: unknown) => error instanceof ControlClientError && error.code === "BUSY");
  // This injected certificate stands for all watches and callbacks being disposed.
  closing.resolve(); assert.equal((await pending).status, "idle"); await client.close();
  assert.equal(delivered, true); assert.equal(fixture.closes(), 1);
});

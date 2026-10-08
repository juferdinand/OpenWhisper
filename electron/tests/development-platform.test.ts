import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DevelopmentPlatformCaptureBridge } from "../src/main/development-platform-host.js";
import { PlatformCaptureClient, platformCaptureRequestSchema, platformCaptureReplySchema,
  type PlatformCaptureRequest } from "../src/workers/platform-protocol.js";
import type { ControlCaptureLease, ControlStatus } from "../src/platforms/linux/shared/control.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const before = performance.now();
  while (!predicate()) { if (performance.now() - before > 1500) throw Error("Fixture did not reach its boundary."); await delay(1); }
}
function frame(bridge: DevelopmentPlatformCaptureBridge, input: unknown) {
  return platformCaptureRequestSchema.parse({ version: 1, channel: "platform-capture", epoch: bridge.epoch, id: randomUUID(),
    ...(typeof input === "object" && input !== null ? input : {}) });
}

test("platform capture RPC refuses audio paths text extra arguments and wrong generations", async () => {
  let starts = 0;
  const bridge = new DevelopmentPlatformCaptureBridge({ status: () => "idle", async start() {
    starts++; return { async stop() {}, async cancel() {} };
  } });
  assert.throws(() => frame(bridge, { command: "start", path: "/untrusted", transcript: "private" }));
  assert.equal((await bridge.handle({ ...frame(bridge, { command: "start" }), epoch: randomUUID() })).ok, false);
  assert.equal(starts, 0);
  assert.equal(platformCaptureReplySchema.safeParse({ ...frame(bridge, { command: "status" }), ok: true,
    value: { command: "status", status: "idle", samples: [] } }).success, false);
  await bridge.close();
});

test("aborted late Start remains owned until exactly its acquired lease finishes rollback", async () => {
  const acquired = deferred<ControlCaptureLease>(), cleanup = deferred<void>(); let starts = 0, cancels = 0;
  const bridge = new DevelopmentPlatformCaptureBridge({ status: () => "idle", async start(signal) {
    starts++; await until(() => signal.aborted); return acquired.promise;
  } });
  const request = frame(bridge, { command: "start" }), original = bridge.handle(request);
  await until(() => starts === 1);
  let aborted = false;
  const cancellation = bridge.handle(frame(bridge, { command: "abort-start", target: request.id })).then(() => { aborted = true; });
  acquired.resolve({ async stop() { throw Error("Wrong original action."); }, async cancel() { cancels++; await cleanup.promise; } });
  await until(() => cancels === 1); assert.equal(aborted, false);
  let closed = false; const closing = bridge.close().then(() => { closed = true; });
  await delay(5); assert.equal(closed, false); cleanup.resolve();
  const reply = await original; assert.equal(reply.ok, false); if (!reply.ok) assert.equal(reply.code, "CANCELLED");
  await cancellation; await closing; assert.equal(cancels, 1);
});

test("GUI current lease and CLI acquisition deduplicate while Stop waits only for its sample fence", async () => {
  let state: ControlStatus = "idle", stops = 0, cancels = 0;
  const fence = deferred<void>();
  const lease: ControlCaptureLease = { async stop() { stops++; await fence.promise; state = "transcribing"; },
    async cancel() { cancels++; state = "idle"; } };
  const bridge = new DevelopmentPlatformCaptureBridge({ status: () => state,
    async start() { state = "recording"; return lease; }, async currentLease() { return state === "recording" ? lease : undefined; } });
  const started = await bridge.handle(frame(bridge, { command: "start" })), current = await bridge.handle(frame(bridge, { command: "lease" }));
  assert.ok(started.ok && started.value.command === "start"); assert.ok(current.ok && current.value.command === "lease");
  assert.equal(current.value.lease, started.value.lease);
  let stopped = false; const stopping = bridge.handle(frame(bridge, { command: "stop", lease: started.value.lease })).then(() => { stopped = true; });
  await until(() => stops === 1); assert.equal(stopped, false); fence.resolve(); await stopping;
  assert.equal(state, "transcribing"); await bridge.close(); assert.equal(cancels, 0);
});

test("stale opaque lease cannot stop the later GUI recording and safe stale Cancel retires its reference", async () => {
  let generation = 1, laterStops = 0;
  const lease: ControlCaptureLease = { async stop() { if (generation !== 1) throw Error("Stale owner."); laterStops++; },
    async cancel() { if (generation === 1) laterStops++; } };
  const bridge = new DevelopmentPlatformCaptureBridge({ status: () => "recording", async start() { return lease; }, async currentLease() { return lease; } });
  const started = await bridge.handle(frame(bridge, { command: "start" })); assert.ok(started.ok && started.value.command === "start");
  generation = 2;
  const reply = await bridge.handle(frame(bridge, { command: "stop", lease: started.value.lease })); assert.equal(reply.ok, false);
  await bridge.close(); assert.equal(laterStops, 0);
});

test("actual pure worker RPC handles current status and correlated cancellation of a held main Start", async () => {
  const acquired = deferred<ControlCaptureLease>(); let observed = false, cancels = 0;
  const bridge = new DevelopmentPlatformCaptureBridge({ status: () => "idle", async start(signal) {
    observed = true; await until(() => signal.aborted); return acquired.promise;
  } });
  let client: PlatformCaptureClient;
  const sent: PlatformCaptureRequest[] = [];
  client = new PlatformCaptureClient(bridge.epoch, (request) => {
    sent.push(request); void bridge.handle(request).then((reply) => { client.receive(reply); });
  });
  assert.equal(await client.status(), "idle");
  const signal = new AbortController(), starting = client.start(signal.signal);
  const refused = assert.rejects(starting, { code: "CANCELLED" });
  await until(() => observed); signal.abort(); acquired.resolve({ async stop() {}, async cancel() { cancels++; } });
  await refused; assert.equal(cancels, 1);
  assert.ok(sent.some((request) => request.command === "abort-start"));
  await bridge.close(); client.close();
});
test("worker current lease preserves the original acquisition and terminal cleanup reference", async () => {
  let state: ControlStatus = "idle", stops = 0, cancels = 0;
  const lease: ControlCaptureLease = { async stop() { stops++; state = "transcribing"; }, async cancel() { cancels++; } };
  const bridge = new DevelopmentPlatformCaptureBridge({ status: () => state,
    async start() { state = "recording"; return lease; }, async currentLease() { return lease; } });
  let client: PlatformCaptureClient;
  client = new PlatformCaptureClient(bridge.epoch, (request) => {
    void bridge.handle(request).then((reply) => { client.receive(reply); });
  });
  const acquired = await client.start(new AbortController().signal), current = await client.currentLease();
  assert.equal(current, acquired);
  await current.stop(); await acquired.cancel();
  assert.equal(stops, 1); assert.equal(cancels, 0);
  await bridge.close(); client.close();
});

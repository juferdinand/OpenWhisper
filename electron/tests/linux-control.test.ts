import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BusFailure, type BusEvent, type BusFilter, type BusMethod, type BusReply } from "../src/platforms/linux/shared/bus.js";
import { DevControlService, DEV_CONTROL_NAME, DEV_CONTROL_PATH, type ControlBus } from "../src/platforms/linux/shared/control.js";
import type { ControlCaptureLease, ControlCapturePort, ControlStatus } from "../src/core/recording-control.js";
import { controlTarget, type ControlKind } from "../src/platforms/linux/shared/control-identity.js";
import { parseControlStatus } from "../src/platforms/linux/shared/control-status.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => { throw new Error("Uninitialized fixture."); };
  const promise = new Promise<void>((accept) => { resolve = accept; }); return { promise, resolve };
}
async function wait(predicate: () => boolean): Promise<void> {
  const before = performance.now();
  while (!predicate()) { if (performance.now() - before > 1500) throw new Error("Fixture timed out."); await new Promise<void>((accept) => { setTimeout(accept, 2); }); }
}
class FakeBus implements ControlBus {
  constructor(readonly kind: ControlKind = "development") {}
  generation = randomUUID(); isClosed = false;
  handler: ((event: BusEvent) => void) | undefined;
  watcher: ((event: BusEvent) => void) | undefined;
  order: string[] = [];
  replies: { id: string; status: string }[] = [];
  refusals: { id: string; category: string }[] = [];
  denied = false; replyFails = false;
  authGate: Promise<void> | undefined;
  replyGate: Promise<void> | undefined;
  replyEntered = false;
  async call(method: BusMethod): Promise<BusReply> {
    assert.equal(method.destination, "org.freedesktop.DBus"); assert.equal(method.member, "RequestName");
    assert.deepEqual(method.body, [{ type: "s", value: controlTarget(this.kind).name }, { type: "u", value: 4 }]);
    this.order.push("name"); return { sender: method.destination, signature: "u", body: [{ type: "u", value: 1 }] };
  }
  async subscribe(filter: BusFilter, handler: (event: BusEvent) => void): Promise<() => Promise<void>> {
    assert.equal(filter.member, "NameOwnerChanged"); this.order.push("watch"); this.watcher = handler;
    return async () => { this.watcher = undefined; };
  }
  async exportControl(handler: (event: BusEvent) => void, kind: ControlKind = "development"): Promise<void> {
    assert.equal(kind, this.kind); this.order.push("export"); this.handler = handler;
  }
  async authorizeControl(event: BusEvent): Promise<void> {
    await this.authGate;
    if (this.denied) throw new BusFailure("DENIED");
    if (!this.controlCurrent(event)) throw new BusFailure("EXPIRED");
  }
  controlCurrent(event: BusEvent): boolean {
    return !this.isClosed && event.connection === this.generation && event.expiresAtUs !== undefined && BigInt(event.expiresAtUs) > process.hrtime.bigint() / 1000n;
  }
  async reply(id: string, status: string): Promise<void> {
    this.replyEntered = true; await this.replyGate;
    if (this.replyFails || this.isClosed) throw new BusFailure("TRANSPORT_FAILED");
    this.replies.push({ id, status });
  }
  async reject(id: string, category: string): Promise<void> { this.refusals.push({ id, category }); }
  async close(): Promise<void> { this.isClosed = true; }
  invoke(action = "status", durationMs = 1000): string {
    const id = randomUUID(); this.handler?.({ kind: "method", id, connection: this.generation, sender: ":1.9",
      path: controlTarget(this.kind).path, interface: "io.github.whisperfree.Control1", member: action === "status" ? "Status" : "Execute",
      signature: action === "status" ? "" : "s", body: action === "status" ? [] : [{ type: "s", value: action }],
      expiresAtUs: (process.hrtime.bigint() / 1000n + BigInt(durationMs * 1000)).toString() }); return id;
  }
  loseCaller(): void {
    this.watcher?.({ kind: "signal", id: "", connection: this.generation, sender: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged", signature: "sss",
      body: [{ type: "s", value: ":1.9" }, { type: "s", value: ":1.9" }, { type: "s", value: "" }] });
  }
}
class FakeCapture implements ControlCapturePort {
  state: ControlStatus = "idle"; starts = 0; stops = 0; cancellations = 0;
  startGate: Promise<void> | undefined; stopGate: Promise<void> | undefined;
  signal: AbortSignal | undefined;
  status(): ControlStatus { return this.state; }
  wireStatus() { return { status: this.state === "unavailable" ? "idle" as const : this.state, elapsed: 0n, recovery_available: false }; }
  async start(signal: AbortSignal): Promise<ControlCaptureLease> {
    this.starts++; this.signal = signal; await this.startGate; this.state = "recording";
    return {
      stop: async () => { this.stops++; await this.stopGate; this.state = "transcribing"; },
      cancel: async () => { this.cancellations++; this.state = "idle"; },
    };
  }
}

test("Dev control subscribes before export and refuses unknown or foreign actions without capture", async () => {
  const bus = new FakeBus(), capture = new FakeCapture(); const service = await DevControlService.create(bus, capture);
  assert.deepEqual(bus.order, ["watch", "export", "name"]);
  const bad = bus.invoke("start; unsafe"); await wait(() => bus.refusals.some((item) => item.id === bad));
  assert.equal(bus.refusals[0]?.category, "InvalidRequest"); assert.equal(capture.starts, 0);
  bus.denied = true; const foreign = bus.invoke("start"); await wait(() => bus.refusals.some((item) => item.id === foreign));
  assert.equal(bus.refusals.at(-1)?.category, "Denied"); assert.equal(capture.starts, 0); await service.close();
});

test("control reserves one action and Stop waits for closure but not duration-dependent preparation", async () => {
  const bus = new FakeBus(), capture = new FakeCapture(); const service = await DevControlService.create(bus, capture);
  bus.invoke("start"); await wait(() => bus.replies.length === 1);
  bus.invoke("start"); await wait(() => bus.replies.length === 2); assert.equal(capture.starts, 1);
  const closure = deferred(); capture.stopGate = closure.promise;
  const stop = bus.invoke("toggle"); await wait(() => capture.stops === 1);
  const repeated = bus.invoke("toggle"); await wait(() => bus.refusals.some((item) => item.id === repeated));
  assert.equal(bus.refusals.at(-1)?.category, "Busy"); assert.equal(bus.replies.some((item) => item.id === stop), false);
  closure.resolve(); await wait(() => bus.replies.some((item) => item.id === stop));
  assert.equal(parseControlStatus(bus.replies.at(-1)?.status).status, "transcribing");
  bus.invoke("start"); await wait(() => bus.refusals.at(-1)?.category === "Busy"); assert.equal(capture.starts, 1);
  await service.close();
});

test("caller loss during UID lookup prevents acquisition", async () => {
  const bus = new FakeBus(), capture = new FakeCapture(), authorization = deferred(); bus.authGate = authorization.promise;
  const service = await DevControlService.create(bus, capture); bus.invoke("start"); bus.loseCaller(); authorization.resolve();
  await wait(() => bus.refusals.length === 1); assert.equal(capture.starts, 0); await service.close();
});

test("caller loss and expiry during acquisition roll back exactly the acquired owner", async () => {
  for (const cause of ["disconnect", "expiry"]) {
    const bus = new FakeBus(), capture = new FakeCapture(), acquisition = deferred(); capture.startGate = acquisition.promise;
    const service = await DevControlService.create(bus, capture); bus.invoke("start", cause === "expiry" ? 30 : 1000);
    await wait(() => capture.starts === 1);
    if (cause === "disconnect") bus.loseCaller(); else await new Promise<void>((accept) => { setTimeout(accept, 45); });
    acquisition.resolve(); await wait(() => capture.cancellations === 1);
    assert.equal(bus.replies.length, 0); assert.equal(capture.state, "idle"); await service.close();
  }
});

test("native rejection rolls back while accepted reply survives normal caller exit before NAPI completion", async () => {
  for (const accepted of [false, true]) {
    const bus = new FakeBus(), capture = new FakeCapture(), nativeAcceptance = deferred();
    bus.replyGate = nativeAcceptance.promise; bus.replyFails = !accepted;
    const service = await DevControlService.create(bus, capture); bus.invoke("start"); await wait(() => bus.replyEntered);
    bus.loseCaller(); nativeAcceptance.resolve();
    await wait(() => accepted ? bus.replies.length === 1 : capture.cancellations === 1);
    assert.equal(capture.cancellations, accepted ? 0 : 1);
    if (accepted) { assert.equal(capture.state, "recording"); bus.loseCaller(); assert.equal(capture.cancellations, 0); }
    await service.close(); assert.equal(capture.cancellations, 1);
  }
});

test("closing during late acquisition cancels its lease before disposal completes", async () => {
  const bus = new FakeBus(), capture = new FakeCapture(), acquisition = deferred(); capture.startGate = acquisition.promise;
  const service = await DevControlService.create(bus, capture); bus.invoke("start"); await wait(() => capture.starts === 1);
  const close = service.close(); assert.equal(capture.signal?.aborted, true); acquisition.resolve(); await close;
  assert.equal(capture.cancellations, 1); assert.equal(bus.replies.length, 0); await service.close();
});

test("authenticated Stop captures the exact GUI lease and awaits its original fence", async () => {
  const bus = new FakeBus(), fence = deferred(); let stops = 0, lookups = 0;
  let state: ControlStatus = "recording";
  const lease: ControlCaptureLease = { async stop() { stops++; await fence.promise; state = "transcribing"; }, async cancel() {} };
  const capture: ControlCapturePort = { status: async () => state, async start() { throw Error("GUI already acquired it."); },
    wireStatus: () => ({ status: state === "unavailable" ? "idle" : state, elapsed: 0n, recovery_available: false }),
    async currentLease() { lookups++; return lease; } };
  const service = await DevControlService.create(bus, capture);
  bus.denied = true; bus.invoke("stop"); await wait(() => bus.refusals.length === 1);
  assert.equal(lookups, 0); assert.equal(stops, 0);
  bus.denied = false; const stop = bus.invoke("stop"); await wait(() => stops === 1);
  assert.equal(bus.replies.some((reply) => reply.id === stop), false);
  fence.resolve(); await wait(() => bus.replies.some((reply) => reply.id === stop));
  assert.equal(parseControlStatus(bus.replies.at(-1)?.status).status, "transcribing"); await service.close();
});

test("implemented current lease returning none never falls back to the previous CLI owner", async () => {
  const bus = new FakeBus(); let state: ControlStatus = "idle", oldStops = 0;
  const original: ControlCaptureLease = { async stop() { oldStops++; }, async cancel() {} };
  const capture: ControlCapturePort = { status: async () => state, async start() { state = "recording"; return original; },
    wireStatus: () => ({ status: state === "unavailable" ? "idle" : state, elapsed: 0n, recovery_available: false }),
    async currentLease() { return undefined; } };
  const service = await DevControlService.create(bus, capture); bus.invoke("start"); await wait(() => bus.replies.length === 1);
  const stop = bus.invoke("stop"); await wait(() => bus.refusals.some((reply) => reply.id === stop));
  assert.equal(oldStops, 0); assert.equal(state, "recording"); await service.close();
});

test("stable control owns only its fixed legacy endpoint and preserves detailed JSON observation", async () => {
  const bus = new FakeBus("stable"), capture = new FakeCapture();
  capture.wireStatus = () => ({ status: "idle", elapsed: 9007199254740993n, recovery_available: true });
  const service = await DevControlService.create(bus, capture, "stable");
  const id = bus.invoke("status"); await wait(() => bus.replies.some((reply) => reply.id === id));
  assert.deepEqual(parseControlStatus(bus.replies.at(-1)?.status), { status: "idle", elapsed: 9007199254740993n, recovery_available: true });
  const wrong = randomUUID(); bus.handler?.({ kind: "method", id: wrong, connection: bus.generation, sender: ":1.9",
    path: DEV_CONTROL_PATH, interface: "io.github.whisperfree.Control1", member: "Status", signature: "", body: [],
    expiresAtUs: (process.hrtime.bigint() / 1000n + 1000000n).toString() });
  await wait(() => bus.refusals.some((reply) => reply.id === wrong));
  assert.equal(bus.refusals.at(-1)?.category, "InvalidRequest"); assert.equal(capture.starts, 0);
  assert.equal(DEV_CONTROL_NAME, controlTarget("development").name); await service.close();
});

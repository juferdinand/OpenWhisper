import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { bindPlatformChild, PlatformChannelError, type PlatformChild } from "../../src/main/platform-channel.js";
import { boundPlatformFrame, platformRequestSchema, type PlatformRequest } from "../../src/workers/platform-protocol.js";

class Child extends EventEmitter implements PlatformChild {
  sent: PlatformRequest[] = []; kills = 0; confirmExit = true;
  postMessage(request: PlatformRequest): void {
    this.sent.push(request);
    if (request.command === "shutdown") queueMicrotask(() => {
      this.emit("message", { version: 1, id: request.id, ok: true, value: { command: "shutdown" } });
    });
  }
  kill(): boolean { this.kills++; if (this.confirmExit) queueMicrotask(() => { this.emit("exit"); }); return true; }
  ready(): void { this.emit("message", { version: 1, type: "ready" }); }
}
const deadlines = { readyMs: 50, requestMs: 50, exitMs: 50 };
test("platform protocol bounds malformed frames and exposes no generic bus or capture command", () => {
  assert.throws(() => platformRequestSchema.parse({ version: 1, id: randomUUID(), command: "call", destination: "anything" }));
  assert.throws(() => platformRequestSchema.parse({ version: 1, id: randomUUID(), command: "initialize", address: "autolaunch:" }));
  assert.throws(() => boundPlatformFrame({ value: "x".repeat(9000) }));
  const cyclic: { child?: unknown } = {}; cyclic.child = cyclic; assert.throws(() => boundPlatformFrame(cyclic));
  assert.throws(() => boundPlatformFrame(Object.defineProperty({}, "value", { get() { throw new Error("Must not execute."); } })));
});
test("platform channel validates readiness and exact request reply then confirms normal shutdown", async () => {
  const child = new Child(), pending = bindPlatformChild(child, new AbortController().signal, deadlines); child.ready(); const channel = await pending;
  const id = randomUUID(); const result = channel.request({ version: 1, id, command: "status" });
  child.emit("message", { version: 1, id, ok: true, value: { command: "status", status: "unavailable" } });
  assert.equal((await result).ok, true); await channel.close(); assert.equal(child.kills, 1);
});
test("wrong reply identity and concurrent request are refused and owner is reaped", async () => {
  const child = new Child(), factory = bindPlatformChild(child, new AbortController().signal, deadlines); child.ready(); const channel = await factory;
  const response = channel.request({ version: 1, id: randomUUID(), command: "status" });
  await assert.rejects(channel.request({ version: 1, id: randomUUID(), command: "status" }), (error: unknown) => error instanceof PlatformChannelError && error.code === "BUSY");
  child.emit("message", { version: 1, id: randomUUID(), ok: true, value: { command: "status", status: "idle" } });
  await assert.rejects(response, (error: unknown) => error instanceof PlatformChannelError && error.code === "INVALID_FRAME");
  await channel.close(); assert.equal(child.kills, 1);
});
test("startup timeout cancellation and unconfirmed teardown block factory completion safely", async () => {
  const timeout = new Child(); await assert.rejects(bindPlatformChild(timeout, new AbortController().signal, deadlines)); assert.equal(timeout.kills, 1);
  const aborted = new Child(), signal = new AbortController(); const pending = bindPlatformChild(aborted, signal.signal, deadlines); signal.abort(); await assert.rejects(pending); assert.equal(aborted.kills, 1);
  const stuck = new Child(); stuck.confirmExit = false;
  await assert.rejects(bindPlatformChild(stuck, new AbortController().signal, deadlines), (error: unknown) => error instanceof PlatformChannelError && error.code === "TEARDOWN_FAILED");
});

async function heldOwner(requestMs = 1000, exitMs = 1000) {
  const child = new Child(); child.confirmExit = false;
  const signal = new AbortController();
  const factory = bindPlatformChild(child, signal.signal, { readyMs: 1000, requestMs, exitMs });
  child.ready(); return { child, signal, channel: await factory };
}
function code(expected: PlatformChannelError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof PlatformChannelError && error.code === expected;
}

test("wrong reply keeps the failed request pending until the held owner exits", async () => {
  const { child, channel } = await heldOwner();
  let settled = false;
  const request = channel.request({ version: 1, id: randomUUID(), command: "status" });
  const refused = assert.rejects(request, code("INVALID_FRAME")).then(() => { settled = true; });
  child.emit("message", { version: 1, id: randomUUID(), ok: true, value: { command: "status", status: "idle" } });
  await delay(10); assert.equal(child.kills, 1); assert.equal(settled, false);
  await assert.rejects(channel.request({ version: 1, id: randomUUID(), command: "status" }), code("CLOSED"));
  const closing = channel.close(); let closed = false; void closing.then(() => { closed = true; });
  // A valid-looking late reply cannot release the old owner's fence.
  const original = child.sent[0]; assert.ok(original);
  child.emit("message", { version: 1, id: original.id, ok: true, value: { command: "status", status: "idle" } });
  await delay(10); assert.equal(settled, false); assert.equal(closed, false); assert.equal(child.kills, 1);
  child.emit("exit"); await refused; await closing;
  assert.equal(settled, true); assert.equal(closed, true);
});

test("request timeout retains its categorical failure until confirmed owner exit", async () => {
  const { child, channel } = await heldOwner(10);
  let settled = false;
  const refused = assert.rejects(channel.request({ version: 1, id: randomUUID(), command: "status" }), code("WORKER_FAILED"))
    .then(() => { settled = true; });
  await delay(30); assert.equal(child.kills, 1); assert.equal(settled, false);
  child.emit("exit"); await refused; await channel.close(); assert.equal(child.kills, 1);
});

test("failed request reap reports TEARDOWN_FAILED and permanently blocks owner reuse", async () => {
  const { child, channel } = await heldOwner(1000, 20);
  let settled = false;
  const refused = assert.rejects(channel.request({ version: 1, id: randomUUID(), command: "status" }), code("TEARDOWN_FAILED"))
    .then(() => { settled = true; });
  child.emit("message", { version: 1, id: randomUUID(), ok: true, value: { command: "status", status: "idle" } });
  await delay(5); assert.equal(settled, false);
  await refused; await assert.rejects(channel.close(), code("TEARDOWN_FAILED"));
  await assert.rejects(channel.request({ version: 1, id: randomUUID(), command: "status" }), code("CLOSED"));
  assert.equal(child.kills, 1); child.emit("exit");
  await assert.rejects(channel.close(), code("TEARDOWN_FAILED"));
});

test("explicit fatal cleanup reply waits for the held owner exit before rejecting", async () => {
  const { child, channel } = await heldOwner(); const id = randomUUID(); let settled = false;
  const refused = assert.rejects(channel.request({ version: 1, id, command: "shutdown" }), code("TEARDOWN_FAILED"))
    .then(() => { settled = true; });
  child.emit("message", { version: 1, id, ok: false, code: "TEARDOWN_FAILED" });
  await delay(10); assert.equal(child.kills, 1); assert.equal(settled, false);
  await assert.rejects(channel.request({ version: 1, id: randomUUID(), command: "status" }), code("CLOSED"));
  child.emit("exit"); await refused; await channel.close(); assert.equal(child.kills, 1);
});

test("asynchronous paste teardown failure reaps an idle owner and blocks later work", async () => {
  const { child, channel } = await heldOwner();
  child.emit("message", { version: 1, type: "failure", code: "TEARDOWN_FAILED" });
  await delay(5); assert.equal(child.kills, 1);
  await assert.rejects(channel.request({ version: 1, id: randomUUID(), command: "paste" }), code("CLOSED"));
  let closed = false; const closing = channel.close().then(() => { closed = true; });
  await delay(5); assert.equal(closed, false);
  child.emit("exit"); await closing; assert.equal(closed, true); assert.equal(child.kills, 1);
});

test("abort and active close share the held-owner request and exit fence", async () => {
  for (const action of ["abort", "close"] as const) {
    const { child, channel, signal } = await heldOwner();
    let settled = false;
    const refused = assert.rejects(channel.request({ version: 1, id: randomUUID(), command: "status" }), code(action === "abort" ? "CANCELLED" : "CLOSED"))
      .then(() => { settled = true; });
    if (action === "abort") signal.abort();
    const closing = channel.close(); await delay(10);
    assert.equal(child.kills, 1); assert.equal(settled, false);
    child.emit("exit"); await refused; await closing;
  }
});
test("platform initialize accepts only the two fixed application identities and preserves omitted Dev frames", () => {
  const request = { version: 1, id: randomUUID(), command: "initialize", address: "unix:path=/owned/bus" };
  assert.equal(Object.hasOwn(platformRequestSchema.parse(request), "appId"), false);
  for (const appId of ["io.github.whisperfree.dev", "io.github.whisperfree"]) {
    assert.equal(platformRequestSchema.parse({ ...request, appId }).command, "initialize");
  }
  for (const appId of ["", "OpenWhisper", "io.github.whisperfree.dev.Control", "io.github.whisperfree.other", null]) {
    assert.equal(platformRequestSchema.safeParse({ ...request, appId }).success, false);
  }
  assert.equal(platformRequestSchema.safeParse({ version: 1, id: randomUUID(), command: "status", appId: "io.github.whisperfree" }).success, false);
});

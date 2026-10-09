import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BusFailure, LinuxBus, parseSessionBusAddress, type BusMethod } from "../../../src/platforms/linux/shared/bus.js";
import { boundBusInput, parseBusValues, signatureOf, validSignature, type BusValue } from "../../../src/platforms/linux/shared/bus-values.js";
import { controlTarget } from "../../../src/platforms/linux/shared/control-identity.js";

test("Bus values preserve exact widths, arrays, dictionaries and explicit variants", () => {
  const body = parseBusValues([{ type: "x", value: "-9223372036854775808" }, { type: "t", value: "18446744073709551615" },
    { type: "dict", key: "s", member: "v", value: [{ key: { type: "s", value: "mode" }, value: { type: "v", signature: "u", value: { type: "u", value: 4 } } }] },
    { type: "a", element: "(su)", value: [{ type: "r", value: [{ type: "s", value: "key" }, { type: "u", value: 3 }] }] }]);
  assert.equal(body.map(signatureOf).join(""), "xta{sv}a(su)");
  assert.equal(validSignature("a{sv}(su)"), true); assert.equal(validSignature(""), true);
  for (const invalid of ["r", "a", "()", "{sv}", "a{vv}", "a{ss", "m", "a".repeat(17) + "s"]) assert.equal(validSignature(invalid), false);
});
test("Bus framing rejects overflow, malformed values, cycles and duplicate dictionary keys", () => {
  for (const value of [{ type: "u", value: 4294967296 }, { type: "x", value: "9223372036854775808" },
    { type: "t", value: "-1" }, { type: "g", value: "r" }, { type: "d", value: Infinity },
    { type: "s", value: "x", extra: true }, { type: "a", element: "ss", value: [] },
    { type: "v", signature: "s", value: { type: "u", value: 2 } }]) assert.throws(() => parseBusValues([value]));
  const repeated: BusValue = { type: "s", value: "key" }; assert.equal(parseBusValues([repeated, repeated]).length, 2);
  assert.throws(() => parseBusValues([{ type: "dict", key: "s", member: "s", value: [{ key: repeated, value: repeated }, { key: repeated, value: repeated }] }]));
  const cycle: unknown[] = []; cycle.push(cycle); assert.throws(() => boundBusInput(cycle));
  assert.throws(() => boundBusInput("x".repeat(65_537))); assert.throws(() => boundBusInput(Array(4097).fill(0)));
});
test("Bus text preserves multilingual emoji and rejects unpaired UTF16 without substitution", () => {
  const content = "Grüß dich · 日本語 · 🎙️ 😀";
  assert.deepEqual(parseBusValues([{ type: "s", value: content }]), [{ type: "s", value: content }]);
  for (const value of ["\ud800", "\udc00", "before\ud800after", "\ud800\ud800"]) {
    assert.throws(() => parseBusValues([{ type: "s", value }])); assert.throws(() => boundBusInput({ [value]: "metadata" }));
  }
});
test("Session addresses cannot activate another transport or inherit a system bus", () => {
  assert.equal(parseSessionBusAddress("unix:path=/tmp/private-bus"), "unix:path=/tmp/private-bus");
  assert.equal(parseSessionBusAddress("unix:abstract=private%2Dbus,guid=" + "a".repeat(32)), "unix:abstract=private%2Dbus,guid=" + "a".repeat(32));
  for (const address of [undefined, "", "system", "autolaunch:", "unixexec:path=/bin/sh", "tcp:host=localhost", "unix:path=/tmp/bus;tcp:host=x", "unix:path=/tmp/bus,foo=x"]) assert.throws(() => parseSessionBusAddress(address));
});
const method: BusMethod = { destination: ":1.2", path: "/owned", interface: "org.openwhisper.Owned", member: "Echo",
  inputSignature: "s", outputSignature: "s", body: [{ type: "s", value: "metadata" }], timeoutMs: 1000 };
function fixture() {
  const connection = randomUUID(); const counters = { calls: 0, cancels: 0, closes: 0 };
  let event: ((value: unknown) => void) | undefined;
  let callHandler: (request: unknown) => unknown = (request) => {
    assert.ok(typeof request === "object" && request !== null);
    return { connection, id: Reflect.get(request, "id"), sender: ":1.2", signature: "s", body: [{ type: "s", value: "metadata" }] };
  };
  const binding = {
    open: () => ({ connection, uniqueName: ":1.1" }), call: (_: unknown, request: unknown) => { counters.calls += 1; return callHandler(request); },
    cancel: () => { counters.cancels += 1; }, close: () => { counters.closes += 1; },
    subscribe: (_: unknown, __: unknown, handler: unknown) => { if (typeof handler !== "function") throw new Error(); event = (value) => { Reflect.apply(handler, undefined, [value]); }; return randomUUID(); },
    unsubscribe: () => undefined, exportControl: () => undefined, reply: () => undefined, reject: () => undefined, readFd: () => Buffer.from("owned"), closeFd: () => undefined,
  };
  return { connection, binding, counters, emit: (value: unknown) => event?.(value), set: (handler: (request: unknown) => unknown) => { callHandler = handler; } };
}
test("Pinned sender, signature, generation and request ID must match before replies are accepted", async () => {
  for (const mutation of [{ sender: ":1.3" }, { connection: randomUUID() }, { id: randomUUID() }, { signature: "u" }]) {
    const f = fixture(); const bus = await LinuxBus.open(f.binding, "unix:path=/tmp/owned");
    f.set((request) => { assert.ok(typeof request === "object" && request !== null); return { connection: f.connection, id: Reflect.get(request, "id"), sender: ":1.2", signature: "s", body: [{ type: "s", value: "metadata" }], ...mutation }; });
    await assert.rejects(bus.call(method)); await bus.close(); assert.equal(f.counters.closes, 1);
  }
  const f = fixture(); const bus = await LinuxBus.open(f.binding, "unix:path=/tmp/owned");
  assert.equal((await bus.call(method)).sender, ":1.2");
  assert.throws(() => bus.call({ ...method, destination: "org.openwhisper.Unpinned" })); assert.equal(f.counters.calls, 1); await bus.close();
});
test("Cancellation reaches the native request and suppresses a late successful response", async () => {
  const f = fixture(); let resolve: ((value: unknown) => void) | undefined;
  f.set((request) => new Promise<unknown>((accept) => { resolve = (body) => { assert.ok(typeof request === "object" && request !== null); accept({ connection: f.connection, id: Reflect.get(request, "id"), sender: ":1.2", signature: "s", body }); }; }));
  const bus = await LinuxBus.open(f.binding, "unix:path=/tmp/owned"); const controller = new AbortController();
  const result = bus.call(method, controller.signal); controller.abort(); resolve?.([{ type: "s", value: "metadata" }]);
  await assert.rejects(result, (error: unknown) => error instanceof BusFailure && error.code === "CANCELLED");
  assert.equal(f.counters.cancels, 1); await bus.close(); await bus.close(); assert.equal(f.counters.closes, 1);
  await assert.rejects(LinuxBus.open(f.binding, "unix:path=/tmp/owned", AbortSignal.abort()));
});
test("Untrusted signals and events after close cannot mutate application state", async () => {
  const f = fixture(); const bus = await LinuxBus.open(f.binding, "unix:path=/tmp/owned"); let mutations = 0;
  const filter = { sender: ":1.2", path: "/owned", interface: "org.openwhisper.Owned", member: "Changed" };
  await bus.subscribe(filter, () => { mutations += 1; });
  const frame = { kind: "signal", id: "", connection: f.connection, ...filter, signature: "", body: [] };
  f.emit(frame); assert.equal(mutations, 1); f.emit({ ...frame, sender: ":1.3" });
  await bus.close(); f.emit(frame); assert.equal(mutations, 1); assert.equal(f.counters.closes, 1);
});

test("export facade passes only fixed identity selectors and rejects an event from the other endpoint", async () => {
  for (const kind of ["stable", "development"] as const) {
    const f = fixture(); let callback: ((value: unknown) => void) | undefined, selected: unknown, handled = 0;
    const binding = { ...f.binding, exportControl: (_connection: unknown, handler: unknown, selector: unknown) => {
      assert.equal(typeof handler, "function"); callback = (value) => Reflect.apply(handler as (...args: unknown[]) => unknown, undefined, [value]); selected = selector;
    } };
    const bus = await LinuxBus.open(binding, "unix:path=/tmp/owned");
    await bus.exportControl(() => { handled++; }, kind); assert.equal(selected, kind === "stable" ? "stable" : undefined);
    const event = { kind: "method", id: randomUUID(), connection: f.connection, sender: ":1.9",
      path: controlTarget(kind).path, interface: "io.github.whisperfree.Control1", member: "Status", signature: "", body: [],
      expiresAtUs: (process.hrtime.bigint() / 1000n + 1000000n).toString() };
    callback?.(event); assert.equal(handled, 1);
    callback?.({ ...event, path: controlTarget(kind === "stable" ? "development" : "stable").path });
    await bus.close(); assert.equal(handled, 1); assert.equal(f.counters.closes, 1);
  }
});

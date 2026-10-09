import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { BusFailure, LinuxBus } from "../../../src/platforms/linux/shared/bus.js";

function deferred<T>() {
  let accept!: (value: T) => void;
  let refuse!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { accept = resolve; refuse = reject; });
  return { promise, accept, refuse };
}
const options = () => ({ expiresAtUs: (process.hrtime.bigint() / 1000n + 5_000_000n).toString() });
const failure = (code: string) => (value: unknown) => value instanceof BusFailure && value.code === code;
function fixture() {
  const connection = randomUUID();
  const ready = deferred<unknown>(); const closed = deferred<void>();
  const identity = { connection, uniqueName: ":1.2" };
  const counters = { defaults: 0, starts: 0, closes: 0 };
  let deadline: unknown;
  let returned: unknown = { connection, ready: ready.promise };
  const binding = {
    open: () => { counters.defaults++; return identity; },
    beginOpen: (_address: unknown, expiresAtUs: unknown, _lifecycle: unknown) => {
      counters.starts++; deadline = expiresAtUs; return returned;
    },
    close: (token: unknown) => { assert.equal(token, connection); counters.closes++; return closed.promise; },
    call: () => undefined, cancel: () => undefined, subscribe: () => undefined,
    unsubscribe: () => undefined, exportControl: () => undefined, reply: () => undefined,
    reject: () => undefined, readFd: () => undefined, closeFd: () => undefined,
  };
  return { connection, ready, closed, identity, counters, binding,
    deadline: () => deadline, returned: (value: unknown) => { returned = value; } };
}

test("existing default opening does not require or invoke beginOpen", async () => {
  const f = fixture(); const { beginOpen: _unused, ...oldBinding } = f.binding;
  const bus = await LinuxBus.open(oldBinding, "unix:path=/tmp/owned");
  assert.equal(bus.uniqueName, ":1.2"); assert.equal(f.counters.defaults, 1);
  const closing = bus.close(); f.closed.accept(); await closing;
});

test("explicit opening forwards one unchanged monotonic expiry and validates the ready identity", async () => {
  const f = fixture(); const deadline = options();
  const opened = LinuxBus.open(f.binding, "unix:path=/tmp/owned", undefined, deadline);
  assert.equal(f.counters.starts, 1); assert.equal(f.counters.defaults, 0);
  assert.equal(f.deadline(), deadline.expiresAtUs);
  f.ready.accept(f.identity); const bus = await opened;
  assert.equal(bus.generation, f.connection);
  const first = bus.close(); assert.equal(bus.close(), first);
  f.closed.accept(); await first; assert.equal(f.counters.closes, 1);
});

test("abort before readiness synchronously closes the opaque owner and awaits ready plus certificate", async () => {
  const f = fixture(); const abort = new AbortController();
  const opened = LinuxBus.open(f.binding, "unix:path=/tmp/owned", abort.signal, options());
  let settled = false; void opened.then(() => { settled = true; }, () => { settled = true; });
  abort.abort(); assert.equal(f.counters.closes, 1);
  f.closed.accept(); await nextTurn(); assert.equal(settled, false);
  f.ready.accept(f.identity);
  await assert.rejects(opened, failure("CANCELLED")); assert.equal(f.counters.closes, 1);
});

test("a late ready reply cannot bypass a held callback retirement certificate", async () => {
  const f = fixture(); const abort = new AbortController();
  const opened = LinuxBus.open(f.binding, "unix:path=/tmp/owned", abort.signal, options());
  let settled = false; void opened.then(() => { settled = true; }, () => { settled = true; });
  abort.abort(); f.ready.accept(f.identity); await nextTurn(); assert.equal(settled, false);
  f.closed.accept(); await assert.rejects(opened, failure("CANCELLED"));
});

test("opening rejection retains cleanup ownership and exposes failed teardown instead of cancellation", async () => {
  const f = fixture();
  const opened = LinuxBus.open(f.binding, "unix:path=/tmp/owned", undefined, options());
  let settled = false; void opened.then(() => { settled = true; }, () => { settled = true; });
  f.ready.refuse(Object.assign(new Error("Private native detail."), { code: "CANCELLED" }));
  await nextTurn(); assert.equal(f.counters.closes, 1); assert.equal(settled, false);
  f.closed.refuse(Object.assign(new Error("Private cleanup detail."), { code: "TEARDOWN_FAILED" }));
  await assert.rejects(opened, failure("TEARDOWN_FAILED"));
});

test("abort during synchronous beginOpen still disposes the handle before any readiness reply", async () => {
  const f = fixture(); const abort = new AbortController();
  const binding = { ...f.binding, beginOpen: (...args: unknown[]): unknown => {
    abort.abort(); return Reflect.apply(f.binding.beginOpen, f.binding, args);
  } };
  const opened = LinuxBus.open(binding, "unix:path=/tmp/owned", abort.signal, options());
  assert.equal(f.counters.closes, 1); f.ready.accept(f.identity); f.closed.accept();
  await assert.rejects(opened, failure("CANCELLED"));
});

test("a failed close remains owned until readiness settles and never supplies a successful certificate", async () => {
  const f = fixture(); const abort = new AbortController();
  const opened = LinuxBus.open(f.binding, "unix:path=/tmp/owned", abort.signal, options());
  let settled = false; void opened.then(() => { settled = true; }, () => { settled = true; });
  abort.abort(); f.closed.refuse(Object.assign(new Error("Synthetic disposal refusal."), { code: "TEARDOWN_FAILED" }));
  await nextTurn(); assert.equal(settled, false);
  f.ready.accept(f.identity); await assert.rejects(opened, failure("TEARDOWN_FAILED"));
});

test("wrong ready generation and malformed opening shape retain their original owner until closed", async () => {
  for (const malformedShape of [false, true]) {
    const f = fixture();
    if (malformedShape) f.returned({ connection: f.connection, ready: f.ready.promise, extra: true });
    const opened = LinuxBus.open(f.binding, "unix:path=/tmp/owned", undefined, options());
    let settled = false; void opened.then(() => { settled = true; }, () => { settled = true; });
    if (!malformedShape) f.ready.accept({ ...f.identity, connection: randomUUID() });
    await nextTurn(); assert.equal(f.counters.closes, 1); assert.equal(settled, false);
    f.closed.accept(); await nextTurn(); assert.equal(settled, !malformedShape);
    if (malformedShape) f.ready.accept(f.identity);
    await assert.rejects(opened); assert.equal(f.counters.closes, 1);
  }
});

test("expired, malformed and already cancelled opening requests allocate no native owner", async () => {
  const f = fixture();
  await assert.rejects(LinuxBus.open(f.binding, "unix:path=/tmp/owned", undefined, { expiresAtUs: "1" }), failure("TIMEOUT"));
  for (const expiresAtUs of ["0", "01", "-1", "18446744073709551616", "1.5", ""]) {
    await assert.rejects(LinuxBus.open(f.binding, "unix:path=/tmp/owned", undefined, { expiresAtUs }));
  }
  await assert.rejects(LinuxBus.open(f.binding, "unix:path=/tmp/owned", AbortSignal.abort(), options()), failure("CANCELLED"));
  assert.equal(f.counters.starts, 0); assert.equal(f.counters.defaults, 0); assert.equal(f.counters.closes, 0);
});

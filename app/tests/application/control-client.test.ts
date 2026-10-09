import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseLaunchArguments } from "../../src/cli/arguments.js";
import { ControlClientError, DEVELOPMENT_CONTROL_TARGET, DevelopmentControlClient, controlFailureOutput, runDevelopmentControl,
  type ControlClientErrorCode, type ControlOperationContext, type DevelopmentControlPort } from "../../src/platforms/linux/shared/control-client.js";

function deferred<T>() {
  let resolve = (_value: T): void => { throw new Error("Uninitialized fixture."); };
  let reject = (_error: Error): void => { throw new Error("Uninitialized fixture."); };
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
function code(expected: ControlClientErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ControlClientError && error.code === expected;
}
async function wait(predicate: () => boolean): Promise<void> {
  const expires = performance.now() + 1000;
  while (!predicate()) { if (performance.now() >= expires) throw new Error("Fixture timed out."); await nextTurn(); }
}
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((accept, reject) => {
    const abort = (): void => { reject(new ControlClientError("CANCELLED")); };
    signal.addEventListener("abort", abort, { once: true });
    task.then((value) => { signal.removeEventListener("abort", abort); accept(value); }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
class Port implements DevelopmentControlPort {
  generation = randomUUID(); isClosed = false; closes = 0; unwatches = 0;
  calls: string[] = [];
  handler: ((event: unknown) => void) | undefined;
  lastWatcher: ((event: unknown) => void) | undefined;
  contexts: ControlOperationContext[] = [];
  uid = 1000;
  owner = ":1.9";
  ownerReply: unknown = undefined;
  statusReply: unknown = undefined;
  uidGate: Promise<void> | undefined;
  statusGate: Promise<void> | undefined;
  closeGate: Promise<void> | undefined;
  closeFails = false;
  status = '{"status":"recording","elapsed":9007199254740993,"recovery_available":false}';
  frame(value: unknown, sender = "org.freedesktop.DBus"): unknown { return { generation: this.generation, sender, value }; }
  private record(name: string, context: ControlOperationContext): void {
    assert.equal(context.noAutoStart, true); assert.match(context.expiresAtUs, /^[1-9][0-9]*$/);
    assert.ok(context.timeoutMs >= 1 && context.timeoutMs <= 5000); this.calls.push(name); this.contexts.push(context);
  }
  async watchDevelopmentOwner(handler: (event: unknown) => void, context: ControlOperationContext): Promise<() => Promise<void>> {
    this.record("watch", context); this.handler = handler; this.lastWatcher = handler;
    return async () => { this.unwatches++; this.handler = undefined; };
  }
  async resolveDevelopmentOwner(context: ControlOperationContext): Promise<unknown> {
    this.record("owner", context); return this.ownerReply ?? this.frame(this.owner);
  }
  async ownerUid(owner: string, context: ControlOperationContext): Promise<unknown> {
    this.record(`uid:${owner}`, context); if (this.uidGate) await abortable(this.uidGate, context.signal); return this.frame(this.uid);
  }
  async readStatus(owner: string, context: ControlOperationContext): Promise<unknown> {
    this.record(`status:${owner}`, context); if (this.statusGate) await abortable(this.statusGate, context.signal);
    return this.statusReply ?? this.frame(this.status, owner);
  }
  async executeAction(owner: string, action: "start" | "stop" | "toggle" | "cancel", context: ControlOperationContext): Promise<unknown> {
    this.record(`${action}:${owner}`, context); return this.statusReply ?? this.frame(this.status, owner);
  }
  async close(): Promise<void> {
    this.closes++; await this.closeGate;
    if (this.closeFails) throw new Error("Private cleanup information.");
    this.isClosed = true;
  }
  loseOwner(): void {
    this.handler?.({ generation: this.generation, name: this.owner, before: this.owner, after: "" });
  }
}

test("pure CLI routing never opens a factory for invalid or ordinary GUI arguments", async () => {
  let opens = 0;
  const options = { uid: 1000, factory: async () => { opens++; return new Port(); } };
  const layout = Object.freeze({ kind: "packaged", executable: "/owned/app" });
  const invalid = await runDevelopmentControl(parseLaunchArguments([layout.executable, "--control", "start", "extra"], layout), options);
  assert.equal(invalid?.exitCode, 2); assert.equal(invalid?.stdout, "");
  assert.equal(invalid?.stderr, "Usage: openwhisper-desktop --control start|stop|toggle|cancel|status\n");
  assert.equal(await runDevelopmentControl(parseLaunchArguments([layout.executable, "--dev-profile", "/owned/profile"], layout), options), undefined);
  assert.equal(opens, 0);
});

test("an already canceled request and unused client closure allocate no port", async () => {
  let opens = 0;
  const options = { uid: 1000, factory: async () => { opens++; return new Port(); } };
  const cancellation = new AbortController(); cancellation.abort();
  const canceled = new DevelopmentControlClient(options);
  await assert.rejects(canceled.execute("start", cancellation.signal), code("CANCELLED")); await canceled.close();
  const closed = new DevelopmentControlClient(options); await closed.close();
  await assert.rejects(closed.execute("start"), code("CLOSED")); assert.equal(opens, 0);
});

test("client watches before lookup, pins one same-user unique owner and closes before success", async () => {
  for (const command of ["start", "stop", "toggle", "cancel", "status"] as const) {
    const port = new Port();
    const output = await runDevelopmentControl({ kind: "control", command }, { uid: 1000, factory: async () => port });
    assert.deepEqual(DEVELOPMENT_CONTROL_TARGET, { name: "io.github.whisperfree.dev.Control", path: "/io/github/whisperfree/dev/Control", interface: "io.github.whisperfree.Control1" });
    assert.deepEqual(port.calls, ["watch", "owner", "uid::1.9", `${command}::1.9`]);
    assert.equal(new Set(port.contexts.map((context) => context.expiresAtUs)).size, 1);
    assert.equal(port.closes, 1); assert.equal(port.unwatches, 1); assert.equal(port.isClosed, true);
    assert.deepEqual(output, { exitCode: 0, stdout: `${port.status}\n`, stderr: "" });
  }
});

test("foreign UID, wrong epoch/sender and legacy enum responses refuse before output", async () => {
  const foreign = new Port(); foreign.uid = 1001;
  const client = new DevelopmentControlClient({ uid: 1000, factory: async () => foreign });
  await assert.rejects(client.execute("start"), code("FOREIGN_OWNER"));
  assert.deepEqual(foreign.calls, ["watch", "owner", "uid::1.9"]); assert.equal(foreign.closes, 1);
  for (const kind of ["epoch", "sender", "extra", "legacy", "oversize"]) {
    const port = new Port();
    if (kind === "epoch") port.ownerReply = { generation: randomUUID(), sender: "org.freedesktop.DBus", value: port.owner };
    if (kind === "sender") port.statusReply = port.frame(port.status, ":1.10");
    if (kind === "extra") port.statusReply = { generation: port.generation, sender: port.owner, value: port.status, private: "ignored secret" };
    if (kind === "legacy") port.statusReply = port.frame("unavailable", port.owner);
    if (kind === "oversize") port.statusReply = port.frame(" ".repeat(4097), port.owner);
    const output = await runDevelopmentControl({ kind: "control", command: "status" }, { uid: 1000, factory: async () => port });
    assert.deepEqual(output, { exitCode: 1, stdout: "", stderr: "Invalid control response.\n" });
    assert.equal(port.closes, 1);
  }
});

test("owner disappearance during UID lookup and changed connection generation send no action", async () => {
  const port = new Port(), gate = deferred<void>(); port.uidGate = gate.promise;
  const client = new DevelopmentControlClient({ uid: 1000, factory: async () => port });
  const pending = client.execute("start"); const refused = assert.rejects(pending, code("OWNER_CHANGED"));
  await wait(() => port.calls.includes("uid::1.9")); port.loseOwner(); await refused;
  assert.equal(port.calls.some((call) => call.startsWith("start:")), false); assert.equal(port.closes, 1);
  const changed = new Port();
  changed.resolveDevelopmentOwner = async (context) => {
    assert.equal(context.noAutoStart, true); const response = changed.frame(changed.owner); changed.generation = randomUUID(); return response;
  };
  await assert.rejects(new DevelopmentControlClient({ uid: 1000, factory: async () => changed }).execute("start"), code("OWNER_CHANGED"));
  assert.equal(changed.calls.some((call) => call.startsWith("start:")), false);
});

test("canceled late opening remains owned until its held close completes", async () => {
  const opening = deferred<DevelopmentControlPort>(), closed = deferred<void>(), port = new Port(); port.closeGate = closed.promise;
  const abort = new AbortController(); let opens = 0, settled = false;
  const client = new DevelopmentControlClient({ uid: 1000, factory: async () => { opens++; return opening.promise; }, cleanupMs: 500 });
  const pending = client.execute("start", abort.signal); const refused = assert.rejects(pending, code("CANCELLED")).then(() => { settled = true; });
  abort.abort(); await nextTurn(); assert.equal(settled, false);
  await assert.rejects(client.execute("toggle"), code("BUSY")); assert.equal(opens, 1);
  opening.resolve(port); await wait(() => port.closes === 1); assert.equal(settled, false); assert.deepEqual(port.calls, []);
  closed.resolve(); await refused; await client.close();
  assert.equal(port.isClosed, true); await assert.rejects(client.execute("start"), code("CLOSED")); assert.equal(opens, 1);
});

test("timeout uses an operation budget then awaits late factory cleanup separately", async () => {
  const opening = deferred<DevelopmentControlPort>(), closing = deferred<void>(), port = new Port(); port.closeGate = closing.promise;
  let context: ControlOperationContext | undefined, settled = false;
  const client = new DevelopmentControlClient({ uid: 1000, operationMs: 15, cleanupMs: 500, factory: async (value) => { context = value; return opening.promise; } });
  const pending = client.execute("start"); const refused = assert.rejects(pending, code("TIMEOUT")).then(() => { settled = true; });
  await wait(() => context?.signal.aborted === true); assert.equal(settled, false);
  opening.resolve(port); await wait(() => port.closes === 1); assert.equal(settled, false);
  closing.resolve(); await refused; assert.equal(port.isClosed, true); assert.deepEqual(port.calls, []);
});

test("unconfirmed cleanup fails closed and still disposes a later factory without retry", async () => {
  const opening = deferred<DevelopmentControlPort>(), port = new Port(); let opens = 0;
  const client = new DevelopmentControlClient({ uid: 1000, operationMs: 10, cleanupMs: 15, factory: async () => { opens++; return opening.promise; } });
  await assert.rejects(client.execute("toggle"), code("DISPOSAL_FAILED"));
  await assert.rejects(client.close(), code("DISPOSAL_FAILED"));
  await assert.rejects(client.execute("toggle"), code("CLOSED")); assert.equal(opens, 1);
  opening.resolve(port); await wait(() => port.isClosed); assert.equal(port.closes, 1); assert.deepEqual(port.calls, []);
});

test("held successful close and explicit active close never resolve before retirement", async () => {
  const port = new Port(), closed = deferred<void>(); port.closeGate = closed.promise;
  const client = new DevelopmentControlClient({ uid: 1000, factory: async () => port }); let delivered = false;
  const pending = client.execute("start").then((value) => { delivered = true; return value; });
  await wait(() => port.closes === 1); assert.equal(delivered, false);
  // Invoke the captured callback even though unsubscription already began.
  assert.ok(port.lastWatcher);
  port.lastWatcher({ generation: port.generation, name: port.owner, before: port.owner, after: "" });
  closed.resolve(); assert.equal((await pending).status, "recording");
  assert.equal(port.calls.filter((call) => call.startsWith("cancel:")).length, 0);
  const active = new Port(), reading = deferred<void>(), retirement = deferred<void>(); active.statusGate = reading.promise; active.closeGate = retirement.promise;
  const other = new DevelopmentControlClient({ uid: 1000, factory: async () => active });
  const request = other.execute("status"); const refused = assert.rejects(request, code("CLOSED"));
  await wait(() => active.calls.includes("status::1.9"));
  const close = other.close(); assert.equal(other.close(), close); let done = false; void close.then(() => { done = true; });
  await wait(() => active.closes === 1); assert.equal(done, false); retirement.resolve(); await close; await refused;
});

test("a close deadline is failure, and later closure never authorizes a repeat action", async () => {
  const port = new Port(), retired = deferred<void>(); port.closeGate = retired.promise; let opens = 0;
  const client = new DevelopmentControlClient({ uid: 1000, cleanupMs: 15, factory: async () => { opens++; return port; } });
  await assert.rejects(client.execute("start"), code("DISPOSAL_FAILED"));
  assert.equal(port.isClosed, false); await assert.rejects(client.close(), code("DISPOSAL_FAILED"));
  await assert.rejects(client.execute("start"), code("CLOSED"));
  retired.resolve(); await wait(() => port.isClosed);
  assert.equal(opens, 1); assert.equal(port.calls.filter((call) => call === "start::1.9").length, 1);
});

test("native refusal and failed disposal expose only fixed text and never retry", async () => {
  let opens = 0;
  const output = await runDevelopmentControl({ kind: "control", command: "start" }, { uid: 1000, factory: async () => {
    opens++; throw new Error("private remote payload and address");
  } });
  assert.deepEqual(output, { exitCode: 1, stdout: "", stderr: "OpenWhisper Dev control request failed.\n" }); assert.equal(opens, 1);
  assert.equal(controlFailureOutput({ code: "NOT_RUNNING", message: "private remote text" }).stderr, "OpenWhisper Dev control request failed.\n");
  const port = new Port(); port.closeFails = true;
  const client = new DevelopmentControlClient({ uid: 1000, factory: async () => port });
  await assert.rejects(client.execute("start"), code("DISPOSAL_FAILED"));
  await assert.rejects(client.close(), code("DISPOSAL_FAILED"));
  assert.equal(port.isClosed, false); assert.equal(port.closes, 1);
});

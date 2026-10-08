import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BusFailure, type BusEvent, type BusFilter, type BusMethod, type BusReply } from "../src/platforms/linux/shared/bus.js";
import { parseBusValues, signatureOf, type BusValue } from "../src/platforms/linux/shared/bus-values.js";
import type { ShortcutBus } from "../src/platforms/linux/shared/portal-shortcuts.js";
import { PortalPaste } from "../src/platforms/linux/shared/portal-paste.js";

const desktop = "/org/freedesktop/portal/desktop", remote = "org.freedesktop.portal.RemoteDesktop";
const text = (value: string): BusValue => ({ type: "s", value });
const dict = (values: Record<string, BusValue> = {}): BusValue => ({ type: "dict", key: "s", member: "v",
  value: Object.entries(values).map(([key, value]) => ({ key: text(key), value: { type: "v", signature: signatureOf(value), value } })) });
function field(value: BusValue | undefined, name: string) {
  if (value?.type !== "dict") return;
  const result = value.value.find((entry) => entry.key.type === "s" && entry.key.value === name)?.value;
  return result?.type === "v" ? result.value : undefined;
}
async function until(condition: () => boolean) {
  for (let n = 0; n < 500; n++) { if (condition()) return; await delay(2); } throw new Error("Fixture did not settle.");
}
class Bus implements ShortcutBus {
  uniqueName = ":1.5"; generation = randomUUID(); isClosed = false; portalOwner = ":1.8";
  present = true; devices = 1; code = 0; pendingStart = false; closeFails = false; failKey: number | undefined;
  failKeyState: 0 | 1 | undefined;
  heldSubscription: string | undefined; releaseSubscription: (() => void) | undefined;
  session = ""; request = ""; calls: BusMethod[] = [];
  subscriptions = new Map<BusFilter, (event: BusEvent) => void>();
  async owner() { if (!this.present) throw new BusFailure("REMOTE_ERROR"); return this.portalOwner; }
  async subscribe(filter: BusFilter, receive: (event: BusEvent) => void) {
    this.subscriptions.set(filter, receive);
    if (filter.interface === this.heldSubscription) await new Promise<void>((resolve) => { this.releaseSubscription = resolve; });
    return async () => { this.subscriptions.delete(filter); };
  }
  emit(path: string, iface: string, member: string, signature: string, body: BusValue[], changes: Partial<BusEvent> = {}) {
    for (const [filter, receive] of this.subscriptions) if (filter.path === path && filter.interface === iface && filter.member === member) receive({
      kind: "signal", id: "", connection: this.generation, sender: this.portalOwner, path, interface: iface, member, signature, body, ...changes });
  }
  response(changes: Partial<BusEvent> = {}) {
    this.emit(this.request, "org.freedesktop.portal.Request", "Response", "ua{sv}",
      [{ type: "u", value: this.code }, dict({ devices: { type: "u", value: this.devices } })], changes);
  }
  async call(method: BusMethod, signal?: AbortSignal): Promise<BusReply> {
    if (signal?.aborted) throw new BusFailure("CANCELLED");
    const input = parseBusValues(method.body); assert.equal(input.map(signatureOf).join(""), method.inputSignature); this.calls.push(method);
    let body: BusValue[] = [];
    if (method.member === "Get") body = [{ type: "v", signature: "u", value: { type: "u", value: this.devices } }];
    if (method.member === "NameHasOwner") body = [{ type: "b", value: this.present }];
    if (["CreateSession", "SelectDevices", "Start"].includes(method.member)) {
      const options = input.at(-1), token = field(options, "handle_token"); assert.ok(token?.type === "s");
      this.request = `${desktop}/request/1_5/${token.value}`;
      if (method.member === "CreateSession") {
        const sessionToken = field(options, "session_handle_token"); assert.ok(sessionToken?.type === "s");
        this.session = `${desktop}/session/1_5/${sessionToken.value}`;
        this.emit(this.request, "org.freedesktop.portal.Request", "Response", "ua{sv}",
          [{ type: "u", value: 0 }, dict({ session_handle: text(this.session) })]);
      } else if (method.member === "SelectDevices") {
        assert.deepEqual(field(options, "types"), { type: "u", value: 1 });
        assert.equal(field(options, "persist_mode"), undefined); assert.equal(field(options, "restore_token"), undefined);
        this.emit(this.request, "org.freedesktop.portal.Request", "Response", "ua{sv}", [{ type: "u", value: 0 }, dict()]);
      } else if (!this.pendingStart) this.response();
      body = [{ type: "o", value: this.request }];
    }
    if (method.member === "Close" && this.closeFails) throw new BusFailure("TIMEOUT");
    if (method.member === "NotifyKeyboardKeycode" && input[2]?.type === "i" && input[2].value === this.failKey &&
      (this.failKeyState === undefined || input[3]?.type === "u" && input[3].value === this.failKeyState)) throw new BusFailure("TIMEOUT");
    return { sender: method.destination, signature: method.outputSignature, body };
  }
}
async function fixture() { const bus = new Bus(), paste = await PortalPaste.create(bus, () => {}, 1000); return { bus, paste }; }
async function enable(paste: PortalPaste) { paste.enable(); await until(() => !paste.state().configuring); assert.equal(paste.state().ready, true); }
test("paste capability probing requests no consent or input and requires keyboard devices", async () => {
  const { bus, paste } = await fixture(); assert.equal(paste.state().available, true); assert.equal(paste.state().ready, false);
  assert.deepEqual(bus.calls.map((call) => call.member), ["Get"]); await paste.close();
  const unsupported = new Bus(); unsupported.devices = 2;
  const absent = await PortalPaste.create(unsupported, () => {}); assert.equal(absent.state().available, false); await absent.close();
});
test("keyboard-only grant handles responses before method replies and releases each paste key", async () => {
  const { bus, paste } = await fixture(); await enable(paste); assert.equal(await paste.paste(), true);
  const keys = bus.calls.filter((call) => call.member === "NotifyKeyboardKeycode").map((call) => parseBusValues(call.body).slice(2));
  assert.deepEqual(keys, [[29, 1], [47, 1], [47, 0], [29, 0]].map(([key, state]) => [{ type: "i", value: key }, { type: "u", value: state }]));
  assert.equal(bus.calls.some((call) => call.interface.includes("ScreenCast")), false);
  await paste.close(); assert.equal(bus.subscriptions.size, 0);
});
test("pending keyboard grant ignores foreign owners and generations and can be cancelled and retried", async () => {
  const { bus, paste } = await fixture(); bus.pendingStart = true; paste.enable();
  await until(() => bus.calls.some((call) => call.member === "Start"));
  bus.response({ sender: ":1.99" }); bus.response({ connection: randomUUID() }); await delay(4); assert.equal(paste.state().ready, false);
  await paste.clear("CANCELLED"); assert.equal(paste.state().configuring, false); assert.equal(paste.state().ready, false);
  assert.ok(bus.calls.some((call) => call.interface === "org.freedesktop.portal.Request" && call.member === "Close"));
  bus.pendingStart = false; await enable(paste); await paste.close();
});
for (const member of ["Session", "Request"] as const) {
  test(`cancellation during ${member} subscription closes no uncreated objects and permits immediate retry`, async (t) => {
    const bus = new Bus(); let failures = 0;
    const paste = await PortalPaste.create(bus, () => {}, 1000, () => { failures++; });
    bus.heldSubscription = `org.freedesktop.portal.${member}`;
    t.after(() => { bus.releaseSubscription?.(); });
    paste.enable(); await until(() => !!bus.releaseSubscription);
    const cancelled = paste.clear("CANCELLED");
    bus.heldSubscription = undefined; bus.releaseSubscription?.();
    await cancelled;
    assert.equal(paste.state().result, "CANCELLED"); assert.equal(paste.state().configuring, false);
    assert.equal(paste.state().ready, false); assert.equal(paste.state().available, true);
    assert.equal(bus.calls.some((call) => call.member === "CreateSession"), false);
    assert.equal(bus.calls.some((call) => call.member === "Close"), false);
    assert.equal(bus.subscriptions.size, 1); assert.equal(failures, 0);
    await enable(paste); assert.equal(await paste.paste(), true);
    await paste.close(); assert.equal(bus.subscriptions.size, 0); assert.equal(failures, 0);
  });
}
test("denied keyboard consent closes the created session and permits a later explicit grant", async () => {
  const { bus, paste } = await fixture(); bus.code = 2; paste.enable(); await until(() => !paste.state().configuring);
  assert.equal(paste.state().result, "DENIED"); assert.equal(await paste.paste(), false);
  assert.ok(bus.calls.some((call) => call.path === bus.session && call.member === "Close"));
  bus.code = 0; await enable(paste); await paste.close();
});
test("failed V press still releases V and Ctrl and never reports successful insertion", async () => {
  const { bus, paste } = await fixture(); await enable(paste); bus.failKey = 47;
  assert.equal(await paste.paste(), false); assert.equal(paste.state().ready, false);
  const keys = bus.calls.filter((call) => call.member === "NotifyKeyboardKeycode").map((call) => parseBusValues(call.body).slice(2));
  assert.deepEqual(keys.at(-1), [{ type: "i", value: 29 }, { type: "u", value: 0 }]);
  assert.equal(keys.length, 4); assert.equal(await paste.paste(), false); await paste.close();
});
test("original session loss revokes readiness without affecting a fresh explicit session", async () => {
  const { bus, paste } = await fixture(); await enable(paste); const previous = bus.session;
  bus.emit(previous, "org.freedesktop.portal.Session", "Closed", "a{sv}", [dict()]);
  await until(() => bus.subscriptions.size === 1); assert.equal(await paste.paste(), false);
  await enable(paste); assert.notEqual(bus.session, previous); await paste.close();
});
test("uncertain session cleanup remains a failed owner rather than a clean shutdown", async () => {
  const { bus, paste } = await fixture(); await enable(paste); bus.closeFails = true;
  await assert.rejects(paste.clear()); await assert.rejects(paste.close()); assert.equal(paste.state().ready, false);
  assert.ok(bus.subscriptions.size > 0);
});
test("failed key release and session closure notify fatal cleanup once and prevent terminal owner reuse", async () => {
  const bus = new Bus(); let failures = 0;
  const paste = await PortalPaste.create(bus, () => {}, 1000, () => { failures++; });
  await enable(paste); bus.failKey = 47; bus.failKeyState = 0; bus.closeFails = true;
  assert.equal(await paste.paste(), false);
  await until(() => failures === 1);
  const keys = bus.calls.filter((call) => call.member === "NotifyKeyboardKeycode").map((call) => parseBusValues(call.body).slice(2));
  assert.deepEqual(keys, [[29, 1], [47, 1], [47, 0], [29, 0]].map(([key, state]) => [{ type: "i", value: key }, { type: "u", value: state }]));
  assert.ok(bus.calls.some((call) => call.member === "Close" && call.interface === "org.freedesktop.portal.Session" && call.path === bus.session));
  assert.deepEqual(paste.state(), { available: false, configuring: false, ready: false, result: "FAILED" });
  assert.throws(() => paste.enable(), (error: unknown) => error instanceof BusFailure && error.code === "TEARDOWN_FAILED");
  assert.equal(await paste.paste(), false);
  await assert.rejects(paste.close(), (error: unknown) => error instanceof BusFailure && error.code === "TEARDOWN_FAILED");
  assert.equal(failures, 1);
  assert.equal(bus.calls.filter((call) => call.member === "NotifyKeyboardKeycode").length, 4);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BusFailure, type BusEvent, type BusFilter, type BusMethod, type BusReply } from "../src/platforms/linux/shared/bus.js";
import { parseBusValues, signatureOf, type BusValue } from "../src/platforms/linux/shared/bus-values.js";
import { PortalShortcuts, type ShortcutBus } from "../src/platforms/linux/shared/portal-shortcuts.js";
import { ShortcutRecording } from "../src/platforms/linux/shared/shortcut-recording.js";
import type { ControlCaptureLease, ControlCapturePort, ControlStatus } from "../src/platforms/linux/shared/control.js";

const desktop = "/org/freedesktop/portal/desktop", iface = "org.freedesktop.portal.GlobalShortcuts";
const text = (value: string): BusValue => ({ type: "s", value });
const dict = (values: Record<string, BusValue> = {}): BusValue => ({ type: "dict", key: "s", member: "v",
  value: Object.entries(values).map(([key, value]) => ({ key: text(key), value: { type: "v", signature: signatureOf(value), value } })) });
function get(value: BusValue | undefined, key: string): BusValue | undefined {
  if (value?.type !== "dict") return;
  const entry = value.value.find((item) => item.key.type === "s" && item.key.value === key)?.value;
  return entry?.type === "v" ? entry.value : undefined;
}
const bound = (label: string | null): BusValue => ({ type: "a", element: "(sa{sv})", value: label === null ? [] : [
  { type: "r", value: [text("dictate"), dict({ trigger_description: text(label) })] }] });
async function until(condition: () => boolean): Promise<void> {
  for (let count = 0; count < 500; count++) { if (condition()) return; await delay(2); }
  throw new Error("Fixture did not settle.");
}
class FakeBus implements ShortcutBus {
  uniqueName = ":1.5"; generation = randomUUID(); isClosed = false;
  present = true; portalOwner = ":1.8"; version = 2; code = 0; delayBinding = false; badSession = false;
  session = ""; request = ""; methods: BusMethod[] = [];
  subscriptions = new Map<BusFilter, (event: BusEvent) => void>();
  async owner(): Promise<string> { if (!this.present) throw new BusFailure("REMOTE_ERROR"); return this.portalOwner; }
  async subscribe(filter: BusFilter, callback: (event: BusEvent) => void): Promise<() => Promise<void>> {
    this.subscriptions.set(filter, callback); return async () => { this.subscriptions.delete(filter); };
  }
  async call(method: BusMethod): Promise<BusReply> {
    const input = parseBusValues(method.body);
    assert.equal(input.map(signatureOf).join(""), method.inputSignature); this.methods.push(method);
    let body: BusValue[] = [];
    if (method.member === "Get") body = [{ type: "v", signature: "u", value: { type: "u", value: this.version } }];
    if (method.member === "CreateSession" || method.member === "BindShortcuts") {
      const options = input.at(-1), token = get(options, "handle_token"); assert.equal(token?.type, "s");
      assert.ok(token?.type === "s"); this.request = `${desktop}/request/1_5/${token.value}`;
      if (method.member === "CreateSession") {
        const token = get(options, "session_handle_token"); assert.ok(token?.type === "s");
        this.session = `${desktop}/session/1_5/${token.value}`;
        this.response(0, dict({ session_handle: text(this.badSession ? "/foreign/session" : this.session) }));
      } else if (!this.delayBinding) this.response(this.code);
      body = [{ type: "o", value: this.request }];
    }
    return { sender: this.portalOwner, signature: method.outputSignature, body };
  }
  emit(path: string, member: string, signature: string, body: BusValue[], sender = this.portalOwner, interfaceName = iface): void {
    for (const [filter, receive] of this.subscriptions) {
      if (filter.path === path && filter.member === member && filter.interface === interfaceName) receive({ kind: "signal", id: "",
        connection: this.generation, sender, path, interface: interfaceName, member, signature, body });
    }
  }
  response(code: number, values = dict({ shortcuts: bound("Ctrl+Alt+Space") })): void {
    this.emit(this.request, "Response", "ua{sv}", [{ type: "u", value: code }, values], this.portalOwner, "org.freedesktop.portal.Request");
  }
  edge(member: "Activated" | "Deactivated", session = this.session, sender = this.portalOwner, time = "1"): void {
    this.emit(desktop, member, "osta{sv}", [{ type: "o", value: session }, text("dictate"), { type: "t", value: time }, dict()], sender);
  }
}
class Capture implements ControlCapturePort {
  phase: ControlStatus = "idle"; started = 0; stopped: number[] = []; cancelled: number[] = [];
  gate: Promise<void> | undefined; current: ControlCaptureLease | undefined;
  status(): ControlStatus { return this.phase; }
  async currentLease(): Promise<ControlCaptureLease | undefined> { return this.current; }
  async start(): Promise<ControlCaptureLease> {
    const id = ++this.started; await this.gate; this.phase = "recording";
    const lease = { stop: async () => { this.stopped.push(id); this.phase = "transcribing"; },
      cancel: async () => { this.cancelled.push(id); this.phase = "idle"; } }; this.current = lease; return lease;
  }
}
async function enabled(hold = false) {
  const bus = new FakeBus(), capture = new Capture(); const service = await PortalShortcuts.create(bus, capture, () => {}, 1000);
  service.command("enable", hold); await until(() => !service.state().configuring);
  assert.equal(service.state().label, "Ctrl+Alt+Space"); return { bus, capture, service };
}

test("portal absence preserves button recording and never binds or starts capture", async () => {
  const bus = new FakeBus(); bus.present = false; const capture = new Capture();
  const service = await PortalShortcuts.create(bus, capture, () => {});
  assert.equal(service.state().available, false); assert.equal(bus.methods.length, 0); assert.equal(capture.started, 0);
  await service.close(); assert.equal(bus.subscriptions.size, 0);
});
test("binding consumes the early Response signal and renders only the confirmed desktop description", async () => {
  const { bus, capture, service } = await enabled();
  assert.deepEqual(bus.methods.map((value) => value.member), ["Get", "Register", "CreateSession", "BindShortcuts"]);
  assert.equal(service.state().result, "ENABLED"); assert.equal(capture.started, 0);
  bus.edge("Activated", bus.session, ":1.99"); bus.edge("Activated", "/foreign/session"); await delay(5);
  assert.equal(capture.started, 0);
  bus.edge("Activated"); bus.edge("Activated"); await until(() => capture.phase === "recording"); assert.equal(capture.started, 1);
  bus.edge("Deactivated"); await delay(5); assert.deepEqual(capture.stopped, []);
  bus.edge("Activated", bus.session, bus.portalOwner, "2"); await until(() => capture.stopped.length === 1);
  await service.close(); assert.equal(bus.subscriptions.size, 0);
});
test("hold mode uses one real release edge and keeps the acquired owner immutable", async () => {
  const { bus, capture, service } = await enabled(true);
  bus.edge("Activated"); bus.edge("Activated"); await until(() => capture.phase === "recording");
  bus.edge("Deactivated"); await until(() => capture.stopped.length === 1); assert.deepEqual(capture.stopped, [1]);
  assert.equal(capture.started, 1); await service.close(); assert.deepEqual(capture.cancelled, []);
});
test("toggle stops an existing GUI recording and portal closure does not cancel GUI ownership", async () => {
  const { bus, capture, service } = await enabled(); await capture.start();
  bus.edge("Activated"); await until(() => capture.stopped.length === 1);
  await service.close(); assert.equal(capture.started, 1); assert.deepEqual(capture.cancelled, []);
});
test("release while Start is pending cancels that original acquisition without a delayed new recording", async () => {
  const capture = new Capture(); let finish!: () => void; capture.gate = new Promise<void>((resolve) => { finish = resolve; });
  const trigger = new ShortcutRecording(capture, () => true, () => { assert.fail("Unexpected fixture failure."); });
  trigger.activate(); await until(() => capture.started === 1); trigger.deactivate(); finish();
  await until(() => capture.cancelled.length === 1); assert.deepEqual(capture.cancelled, [1]); await trigger.close();
});
test("Cancel closes the pending request and session before a fresh explicit retry", async () => {
  const bus = new FakeBus(), capture = new Capture(); bus.delayBinding = true;
  const service = await PortalShortcuts.create(bus, capture, () => {}, 1000); service.command("enable", false);
  await until(() => bus.methods.some((method) => method.member === "BindShortcuts")); const original = bus.session;
  service.command("cancel", false); await until(() => !service.state().configuring);
  assert.equal(service.state().result, "CANCELLED"); assert.equal(service.state().label, null);
  assert.ok(bus.methods.some((method) => method.member === "Close" && method.interface === "org.freedesktop.portal.Request"));
  assert.ok(bus.methods.some((method) => method.member === "Close" && method.path === original));
  bus.delayBinding = false; service.command("enable", false); await until(() => !!service.state().label);
  assert.notEqual(bus.session, original); bus.edge("Activated", original); await delay(5); assert.equal(capture.started, 0);
  await service.close();
});
test("denied binding and foreign session handles close the session without enabling a trigger", async () => {
  for (const variant of ["denied", "foreign"] as const) {
    const bus = new FakeBus(), capture = new Capture(); bus.code = variant === "denied" ? 2 : 0; bus.badSession = variant === "foreign";
    const service = await PortalShortcuts.create(bus, capture, () => {}); service.command("enable", false);
    await until(() => !service.state().configuring); assert.equal(service.state().label, null); assert.equal(service.state().result, "FAILED");
    assert.ok(bus.methods.some((method) => method.member === "Close" && method.path === bus.session));
    assert.equal(capture.started, 0); await service.close();
  }
});
test("a response deadline closes outstanding portal resources without imposing a recording cutoff", async () => {
  const bus = new FakeBus(); bus.delayBinding = true;
  const service = await PortalShortcuts.create(bus, new Capture(), () => {}, 15); service.command("enable", false);
  await until(() => !service.state().configuring); assert.equal(service.state().result, "FAILED");
  assert.ok(bus.methods.some((method) => method.member === "Close" && method.interface === "org.freedesktop.portal.Request")); await service.close();
});
test("removing the desktop binding cancels a held recording and restores main controls", async () => {
  const { bus, capture, service } = await enabled(true); bus.edge("Activated"); await until(() => capture.phase === "recording");
  bus.emit(desktop, "ShortcutsChanged", "oa(sa{sv})", [{ type: "o", value: bus.session }, bound(null)]);
  await until(() => !service.state().configuring && capture.cancelled.length === 1);
  assert.equal(service.state().label, null); assert.equal(service.state().result, "UNASSIGNED"); await service.close();
});
test("portal session loss retires its own held recording and can be explicitly enabled again", async () => {
  const { bus, capture, service } = await enabled(true); bus.edge("Activated"); await until(() => capture.phase === "recording");
  bus.emit(bus.session, "Closed", "a{sv}", [dict()], bus.portalOwner, "org.freedesktop.portal.Session");
  await until(() => service.state().result === "ENDED" && !service.state().configuring); assert.deepEqual(capture.cancelled, [1]);
  service.command("enable", false); await until(() => !!service.state().label); await service.close();
});
test("reconfiguration uses the existing session and never binds it twice", async () => {
  const { bus, service } = await enabled(); service.command("configure", false); await until(() => !service.state().configuring);
  assert.equal(bus.methods.filter((method) => method.member === "BindShortcuts").length, 1);
  assert.equal(bus.methods.at(-1)?.member, "ConfigureShortcuts"); await service.close();
});
test("portal replacement closes the original unique owner and probes the replacement without binding automatically", async () => {
  const { bus, capture, service } = await enabled(true); bus.edge("Activated"); await until(() => capture.phase === "recording");
  const original = bus.portalOwner; bus.portalOwner = ":1.10";
  bus.emit("/org/freedesktop/DBus", "NameOwnerChanged", "sss", [text("org.freedesktop.portal.Desktop"), text(original), text(bus.portalOwner)],
    "org.freedesktop.DBus", "org.freedesktop.DBus");
  await until(() => service.state().available && service.state().label === null && capture.cancelled.length === 1);
  assert.ok(bus.methods.some((method) => method.member === "Close" && method.destination === original));
  assert.equal(bus.methods.filter((method) => method.member === "BindShortcuts").length, 1); await service.close();
});
test("activation during unresolved consent cannot start capture even if a backend emits a binding change", async () => {
  const bus = new FakeBus(), capture = new Capture(); bus.delayBinding = true;
  const service = await PortalShortcuts.create(bus, capture, () => {}); service.command("enable", true);
  await until(() => bus.methods.some((method) => method.member === "BindShortcuts"));
  bus.emit(desktop, "ShortcutsChanged", "oa(sa{sv})", [{ type: "o", value: bus.session }, bound("Ctrl+Alt+Space")]);
  bus.edge("Activated"); await delay(5); assert.equal(capture.started, 0); assert.equal(service.state().label, null);
  await service.clear(); await service.close();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { KdeKeyboard, kdeJournalSchema, kdeKeySchema, keyLabel, type KdeJournal } from "../src/platforms/linux/kde/keyboard.js";
import { KdeKeyCapture, type KeyboardInput } from "../src/platforms/linux/kde/key-capture.js";
import { BusFailure, type BusEvent, type BusFilter, type BusMethod, type BusReply } from "../src/platforms/linux/shared/bus.js";
import { parseBusValues, signatureOf, type BusValue } from "../src/platforms/linux/shared/bus-values.js";
import type { ShortcutBus } from "../src/platforms/linux/shared/portal-shortcuts.js";
import type { ControlCaptureLease, ControlCapturePort, ControlStatus } from "../src/platforms/linux/shared/control.js";
const text = (value: string): BusValue => ({ type: "s", value });
class Journal implements KdeJournal {
  entries: ReturnType<typeof kdeJournalSchema.parse> = [];
  snapshot() { return structuredClone(this.entries); }
  async update(reducer: Parameters<KdeJournal["update"]>[0]) { this.entries = kdeJournalSchema.parse(reducer(this.snapshot())); return this.snapshot(); }
}
class Bus implements ShortcutBus {
  uniqueName = ":1.5"; generation = randomUUID(); isClosed = false; available = true; free = true; rejectKey = false;
  cleanupFails = false; component = ""; ownerName = ":1.8"; calls: BusMethod[] = [];
  subscriptions = new Map<BusFilter, (event: BusEvent) => void>();
  live = new Set([this.uniqueName, this.ownerName]);
  ownerGate: Promise<void> | undefined;
  async owner(name: string): Promise<string> {
    if (name === "org.kde.kglobalaccel") await this.ownerGate;
    if (!this.available || name.startsWith(":") && !this.live.has(name)) throw new BusFailure("REMOTE_ERROR");
    return name.startsWith(":") ? name : this.ownerName;
  }
  async subscribe(filter: BusFilter, receive: (event: BusEvent) => void) {
    this.subscriptions.set(filter, receive); return async () => { this.subscriptions.delete(filter); };
  }
  async call(method: BusMethod): Promise<BusReply> {
    const input = parseBusValues(method.body); assert.equal(input.map(signatureOf).join(""), method.inputSignature);
    this.calls.push(method); let body: BusValue[] = [];
    if (method.member === "NameHasOwner") { assert.ok(input[0]?.type === "s"); body = [{ type: "b", value: this.live.has(input[0].value) }]; }
    if (method.member === "globalShortcutAvailable") body = [{ type: "b", value: this.free }];
    if (method.member === "doRegister") {
      const value = input[0]; assert.ok(value?.type === "a" && value.value[0]?.type === "s"); this.component = value.value[0].value;
    }
    if (method.member === "getComponent") body = [{ type: "o", value: "/component/owned" }];
    if (method.member === "setShortcutKeys") {
      assert.deepEqual(input[2], { type: "u", value: 6 });
      body = this.rejectKey ? [{ type: "a", element: "(ai)", value: [] }] : [input[1]!];
    }
    if (method.member === "unregister") { if (this.cleanupFails) throw new BusFailure("TIMEOUT"); body = [{ type: "b", value: true }]; }
    return { sender: method.destination, signature: method.outputSignature, body };
  }
  edge(down: boolean, overrides: Partial<BusEvent> = {}) {
    const member = down ? "globalShortcutPressed" : "globalShortcutReleased";
    for (const [filter, receive] of this.subscriptions) if (filter.member === member) receive({
      kind: "signal", id: "", sender: this.ownerName, connection: this.generation, path: "/component/owned",
      interface: "org.kde.kglobalaccel.Component", member, signature: "ssx", body: [text(this.component), text("_k_session:dictate"), { type: "x", value: "100" }], ...overrides });
  }
}
class Capture implements ControlCapturePort {
  phase: ControlStatus = "idle"; started = 0; stops: number[] = []; cancels: number[] = []; current: ControlCaptureLease | undefined;
  status() { return this.phase; } async currentLease() { return this.current; }
  async start() {
    const id = ++this.started; this.phase = "recording";
    this.current = { stop: async () => { this.stops.push(id); this.phase = "transcribing"; },
      cancel: async () => { this.cancels.push(id); this.phase = "idle"; } }; return this.current;
  }
}
async function until(condition: () => boolean) { for (let n = 0; n < 100; n++) { if (condition()) return; await delay(2); } throw new Error("Fixture did not settle."); }
async function fixture() { const bus = new Bus(), capture = new Capture(), journal = new Journal();
  const keyboard = await KdeKeyboard.create(bus, capture, journal, () => {}); return { bus, capture, journal, keyboard }; }
test("KDE probe has no registration, journal mutation, or recording side effect", async () => {
  const { bus, capture, journal, keyboard } = await fixture(); assert.equal(keyboard.state().available, true);
  assert.deepEqual(bus.calls, []); assert.deepEqual(journal.entries, []); assert.equal(capture.started, 0); await keyboard.close();
});
test("KDE confirms Qt four-entry sequences and handles toggle edges on the shared owner", async () => {
  const { bus, capture, journal, keyboard } = await fixture(); await keyboard.bind(0x0c000020, false);
  assert.equal(keyboard.state().key, 0x0c000020); assert.equal(keyLabel(keyboard.state().key!), "Ctrl+Alt+Space");
  assert.equal(journal.entries.length, 1); bus.edge(true, { sender: ":1.99" }); bus.edge(true, { connection: randomUUID() });
  await delay(4); assert.equal(capture.started, 0);
  bus.edge(true); bus.edge(true); await until(() => capture.started === 1); bus.edge(false); await delay(4);
  assert.deepEqual(capture.stops, []); bus.edge(true); await until(() => capture.stops.length === 1);
  await keyboard.close(); assert.deepEqual(journal.entries, []); assert.equal(bus.subscriptions.size, 0);
});
test("KDE real release stops hold mode once and cannot target a later GUI acquisition", async () => {
  const { bus, capture, keyboard } = await fixture(); await keyboard.bind(0x01000037, true);
  bus.edge(true); await until(() => capture.started === 1); bus.edge(false); await until(() => capture.stops.length === 1);
  capture.phase = "idle"; await capture.start(); bus.edge(false); await delay(5); assert.deepEqual(capture.stops, [1]);
  await keyboard.close(); assert.equal(capture.phase, "recording");
});
test("KDE conflict preserves the current binding and does not register a replacement", async () => {
  const { bus, journal, keyboard } = await fixture(); await keyboard.bind(0x01000037, false);
  const previous = journal.snapshot(); bus.free = false; await keyboard.bind(0x01000038, false);
  assert.equal(keyboard.state().result, "CONFLICT"); assert.equal(keyboard.state().key, 0x01000037);
  assert.deepEqual(journal.snapshot(), previous); assert.equal(bus.calls.filter((call) => call.member === "doRegister").length, 1); await keyboard.close();
});
test("KDE registration race rejection releases only the new session action", async () => {
  const { bus, journal, keyboard } = await fixture(); bus.rejectKey = true;
  await assert.rejects(keyboard.bind(0x01000037, false)); assert.equal(keyboard.state().key, null);
  assert.deepEqual(journal.entries, []); assert.equal(bus.calls.at(-1)?.member, "unregister"); await keyboard.close();
});
test("KDE recovers a journalled crashed owner only after explicit setup", async () => {
  const { bus, journal, keyboard } = await fixture(); const component = `io.github.whisperfree.dev.trigger.${randomUUID().replaceAll("-", "")}`;
  journal.entries = [{ component, connection: ":1.90" }]; assert.equal(bus.calls.length, 0);
  await keyboard.bind(0x01000037, false); const release = bus.calls.find((call) => call.member === "unregister");
  assert.deepEqual(parseBusValues(release!.body), [text(component), text("_k_session:dictate")]); await keyboard.close();
});
test("KDE never takes over a journalled live owner", async () => {
  const { bus, journal, keyboard } = await fixture(); bus.live.add(":1.90");
  journal.entries = [{ component: `io.github.whisperfree.dev.trigger.${randomUUID().replaceAll("-", "")}`, connection: ":1.90" }];
  await assert.rejects(keyboard.bind(0x01000037, false)); assert.deepEqual(bus.calls.map((call) => call.member), ["NameHasOwner"]); await keyboard.close();
});
test("KDE uncertain removal retains its recovery journal and rejects clean shutdown", async () => {
  const { bus, journal, keyboard } = await fixture(); await keyboard.bind(0x01000037, false); bus.cleanupFails = true;
  await assert.rejects(keyboard.clear(), (error: unknown) => error instanceof BusFailure && error.code === "TEARDOWN_FAILED");
  assert.equal(journal.entries.length, 1); await assert.rejects(keyboard.close());
});
test("KDE concurrent Remove and shutdown share one original binding retirement", async () => {
  const { bus, journal, keyboard } = await fixture(); await keyboard.bind(0x01000037, false);
  await Promise.all([keyboard.clear(), keyboard.close(), keyboard.close()]);
  assert.equal(bus.calls.filter((call) => call.member === "unregister").length, 1);
  assert.deepEqual(journal.entries, []); assert.equal(bus.subscriptions.size, 0);
});
test("KDE Cancel during final owner verification cannot publish a late binding", async () => {
  const { bus, capture, journal, keyboard } = await fixture(); let resume!: () => void;
  bus.ownerGate = new Promise<void>((resolve) => { resume = resolve; });
  const binding = keyboard.bind(0x01000037, false);
  await until(() => bus.calls.some((call) => call.member === "setShortcutKeys"));
  const cancelled = keyboard.cancelSetup(); resume(); await assert.rejects(binding); await cancelled;
  assert.equal(keyboard.state().key, null); assert.deepEqual(journal.entries, []);
  bus.edge(true); await delay(4); assert.equal(capture.started, 0); await keyboard.close();
});
test("KDE modifier-only hold and invalid key values are rejected before registration", async () => {
  const { bus, keyboard } = await fixture(); await assert.rejects(keyboard.bind(0x01000021, true));
  for (const key of [0, 0x01000000, 0x010000ff, 0x40000020, 0xd800]) assert.equal(kdeKeySchema.safeParse(key).success, false);
  assert.equal(bus.calls.length, 0); await keyboard.close();
});
const input = (key: string, code = key, changes: Partial<KeyboardInput> = {}): KeyboardInput => ({ type: "keyDown", key, code,
  control: false, alt: false, shift: false, meta: false, ...changes });
test("KDE capture commits the original chord only on the chosen key release", () => {
  const capture = new KdeKeyCapture(); assert.equal(capture.consume(input("Control", "ControlLeft", { control: true })).kind, "pending");
  capture.consume(input(" ", "Space", { control: true, alt: true }));
  assert.equal(capture.consume(input("Control", "ControlLeft", { type: "keyUp" })).kind, "pending");
  assert.deepEqual(capture.consume(input(" ", "Space", { type: "keyUp" })), { kind: "key", key: 0x0c000020 });
});
test("KDE capture supports Unicode, keypad and modifier-only keys and refuses dead input", () => {
  for (const [key, code, expected] of [["ä", "Quote", 0xc4], ["Enter", "NumpadEnter", 0x21000005],
    ["Control", "ControlLeft", 0x01000021]] as const) {
    const capture = new KdeKeyCapture(); capture.consume(input(key, code));
    assert.deepEqual(capture.consume(input(key, code, { type: "keyUp" })), { kind: "key", key: expected });
  }
  assert.equal(new KdeKeyCapture().consume(input("Dead")).kind, "unsupported");
  assert.equal(new KdeKeyCapture().consume(input("Escape")).kind, "cancel");
});

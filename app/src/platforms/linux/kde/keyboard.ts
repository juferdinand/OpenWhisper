import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BusFailure, type BusEvent } from "../shared/bus.js";
import type { BusValue } from "../shared/bus-values.js";
import { linuxApplicationIdSchema, type LinuxApplicationId, type ShortcutBus } from "../shared/portal-shortcuts.js";
import type { ControlCapturePort } from "../../../core/recording/control.js";
import { ShortcutRecording } from "../../../core/recording/shortcut.js";

const serviceName = "org.kde.kglobalaccel", iface = "org.kde.KGlobalAccel", path = "/kglobalaccel";
const action = "_k_session:dictate";
const text = (value: string): BusValue => ({ type: "s", value });
const strings = (values: string[]): BusValue => ({ type: "a", element: "s", value: values.map(text) });
const sequence = (key: number): BusValue => ({ type: "r", value: [{ type: "a", element: "i",
  value: [key, 0, 0, 0].map((value) => ({ type: "i", value })) }] });
const modifiers = 0x3e000000;
const names: Readonly<Record<number, string>> = { 0x20: "Space", 0x01000001: "Tab", 0x01000002: "Backtab",
  0x01000003: "Backspace", 0x01000004: "Return", 0x01000005: "Enter", 0x01000006: "Insert", 0x01000007: "Delete",
  0x01000008: "Pause", 0x01000009: "Print", 0x01000010: "Home", 0x01000011: "End", 0x01000012: "Left",
  0x01000013: "Up", 0x01000014: "Right", 0x01000015: "Down", 0x01000016: "Page Up", 0x01000017: "Page Down",
  0x01000020: "Shift", 0x01000021: "Ctrl", 0x01000022: "Super", 0x01000023: "Alt", 0x01000024: "Caps Lock",
  0x01000025: "Num Lock", 0x01000026: "Scroll Lock", 0x01000055: "Menu", 0x01000058: "Help",
  0x01000070: "Volume down", 0x01000071: "Mute", 0x01000072: "Volume up", 0x01000080: "Play",
  0x01000081: "Stop", 0x01000082: "Previous track", 0x01000083: "Next track" };
function keyName(key: number): string | undefined {
  if (names[key]) return names[key];
  if (key >= 0x01000030 && key <= 0x01000052) return `F${key - 0x01000030 + 1}`;
  if (key < 0x21 || key > 0x10ffff || key >= 0xd800 && key <= 0xdfff) return undefined;
  const character = String.fromCodePoint(key);
  return /[\p{C}\p{Z}]/u.test(character) ? undefined : character;
}
export const kdeKeySchema = z.int().min(1).max(0x3fffffff).refine((key) => keyName(key & ~modifiers) !== undefined);
export function modifierOnly(key: number): boolean { const base = key & ~modifiers; return base >= 0x01000020 && base <= 0x01000023; }
export function keyLabel(key: number): string {
  kdeKeySchema.parse(key);
  const parts: string[] = [];
  for (const [mask, name] of [[0x04000000, "Ctrl"], [0x08000000, "Alt"], [0x02000000, "Shift"],
    [0x10000000, "Super"], [0x20000000, "Numpad"]] as const) if (key & mask) parts.push(name);
  parts.push(keyName(key & ~modifiers)!); return parts.join("+");
}
export const kdeJournalSchema = z.array(z.strictObject({ component: z.string().regex(/^io\.github\.whisperfree(?:\.dev)?\.trigger\.[a-f0-9]{32}$/),
  connection: z.string().regex(/^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/) })).max(2);
type JournalEntry = z.infer<typeof kdeJournalSchema>[number];
export interface KdeJournal { snapshot(): JournalEntry[]; update(reducer: (current: JournalEntry[]) => unknown): Promise<JournalEntry[]> }
export interface KdeKeyboardState { available: boolean; configuring: boolean; key: number | null;
  result: "NONE" | "ENABLED" | "ENDED" | "FAILED" | "CONFLICT" }
interface Binding { component: string; owner: string; componentPath: string; key: number;
  recording: ShortcutRecording; subscriptions: (() => Promise<void>)[] }

/** Session-only KGlobalAccel keyboard bindings. No key registration happens in create(). */
export class KdeKeyboard {
  private current: KdeKeyboardState = { available: false, configuring: false, key: null, result: "NONE" };
  private owner: string | undefined;
  private active: Binding | undefined;
  private operation: Promise<void> | undefined;
  private clearTask: Promise<void> | undefined;
  private closeTask: Promise<void> | undefined;
  private setup: AbortController | undefined;
  private watcher: (() => Promise<void>) | undefined;
  private closed = false;
  private hold = false;
  private cleanupFailed = false;
  private constructor(private readonly bus: ShortcutBus, private readonly capture: ControlCapturePort,
    private readonly journal: KdeJournal, private readonly changed: (state: KdeKeyboardState) => void,
    private readonly appId: LinuxApplicationId) {}
  static async create(bus: ShortcutBus, capture: ControlCapturePort, journal: KdeJournal,
    changed: (state: KdeKeyboardState) => void, appId: LinuxApplicationId = "io.github.whisperfree.dev"): Promise<KdeKeyboard> {
    const keyboard = new KdeKeyboard(bus, capture, journal, changed, linuxApplicationIdSchema.parse(appId));
    keyboard.watcher = await bus.subscribe({ sender: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus", member: "NameOwnerChanged" }, (event) => {
      const [name, before, after] = event.body;
      if (event.connection !== bus.generation || event.sender !== "org.freedesktop.DBus" ||
        event.path !== "/org/freedesktop/DBus" || event.interface !== "org.freedesktop.DBus" || event.signature !== "sss" || name?.type !== "s" ||
        ![serviceName, "org.kde.KWin"].includes(name.value) || before?.type !== "s" || after?.type !== "s") return;
      keyboard.owner = undefined; keyboard.setup?.abort(); keyboard.publish({ available: false, key: null });
      void keyboard.clear("ENDED").then(() => keyboard.probe()).catch(() => keyboard.publish({ result: "FAILED" }));
    });
    await keyboard.probe(); return keyboard;
  }
  state(): KdeKeyboardState { return { ...this.current }; }
  holdMode(): boolean { return this.hold; }
  async canBind(input: number): Promise<boolean> {
    const key = kdeKeySchema.parse(input);
    if (this.closed || this.cleanupFailed) throw new BusFailure("TEARDOWN_FAILED");
    if (!this.owner) await this.probe(); const owner = this.owner;
    if (!owner || !this.current.available) throw new BusFailure("REMOTE_ERROR");
    await this.recover(owner);
    const available = await this.call(owner, "globalShortcutAvailable", "(ai)s", "b", [sequence(key), text("")]);
    if (available[0]?.type !== "b") throw new BusFailure("INVALID_FRAME");
    return available[0].value;
  }
  private publish(changes: Partial<KdeKeyboardState>): void { this.current = { ...this.current, ...changes }; this.changed(this.state()); }
  private async probe(): Promise<void> {
    if (this.closed || this.bus.isClosed) return;
    try {
      await this.bus.owner("org.kde.KWin"); const owner = await this.bus.owner(serviceName);
      if (this.closed) return; this.owner = owner; this.publish({ available: true });
    } catch { this.publish({ available: false }); }
  }
  mode(hold: boolean): void {
    if (hold && this.current.key !== null && modifierOnly(this.current.key)) throw new Error("Modifier-only KDE triggers use toggle mode.");
    this.hold = hold;
  }
  private async call(owner: string, member: string, inputSignature: string, outputSignature: string,
    body: BusValue[], signal?: AbortSignal): Promise<BusValue[]> {
    return (await this.bus.call({ destination: owner, path, interface: iface, member, inputSignature, outputSignature,
      body, timeoutMs: 1500 }, signal)).body;
  }
  private async recover(owner: string): Promise<void> {
    const entries = kdeJournalSchema.parse(this.journal.snapshot());
    if (entries.some((entry) => !entry.component.startsWith(`${this.appId}.trigger.`))) {
      throw new Error("The KDE journal belongs to a different application.");
    }
    for (const entry of entries) {
      if (entry.component === this.active?.component) continue;
      if (await this.hasOwner(entry.connection)) throw new Error("Another KDE trigger owner is running.");
      await this.remove(owner, entry.component);
    }
  }
  private async hasOwner(name: string): Promise<boolean> {
    const reply = await this.bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus", member: "NameHasOwner", inputSignature: "s", outputSignature: "b",
      body: [text(name)], timeoutMs: 1500 });
    if (reply.body[0]?.type !== "b") throw new BusFailure("INVALID_FRAME"); return reply.body[0].value;
  }
  private async remove(owner: string, component: string): Promise<void> {
    try {
      const result = await this.call(owner, "unregister", "ss", "b", [text(component), text(action)]);
      if (result[0]?.type !== "b") throw new BusFailure("INVALID_FRAME");
    } catch (error: unknown) {
      // A verified vanished original daemon cannot retain our temporary action.
      if (!(error instanceof BusFailure) || error.code !== "REMOTE_ERROR") throw error;
      if (await this.hasOwner(owner)) throw error;
    }
    await this.journal.update((entries) => entries.filter((entry) => entry.component !== component));
  }
  bind(input: number, hold: boolean): Promise<void> {
    const key = kdeKeySchema.parse(input);
    if (this.closed || this.cleanupFailed) return Promise.reject(new BusFailure("TEARDOWN_FAILED"));
    if (this.operation || this.clearTask) return Promise.reject(new Error("Shortcut setup is busy."));
    if (hold && modifierOnly(key)) return Promise.reject(new Error("Modifier-only KDE triggers use toggle mode."));
    this.hold = hold;
    if (this.active?.key === key) return Promise.resolve();
    const setup = new AbortController(); this.setup = setup; this.publish({ configuring: true, result: "NONE" });
    const operation = this.install(key, setup.signal).finally(() => {
      if (this.operation === operation) this.operation = undefined;
      if (this.setup === setup) this.setup = undefined;
      this.publish({ configuring: false });
    });
    this.operation = operation; void operation.catch(() => {}); return operation;
  }
  prepareCapture(): Promise<void> {
    if (this.closed || this.cleanupFailed) return Promise.reject(new BusFailure("TEARDOWN_FAILED"));
    if (this.operation || this.clearTask) return Promise.reject(new Error("Shortcut setup is busy."));
    // A crashed session action can consume the key before window capture sees it.
    // Recover only after explicit setup, before asking the user to choose a key.
    const operation = (async () => {
      if (!this.owner) await this.probe(); const owner = this.owner;
      if (!owner || !this.current.available) throw new BusFailure("REMOTE_ERROR");
      await this.recover(owner);
    })().finally(() => { if (this.operation === operation) this.operation = undefined; });
    this.operation = operation; void operation.catch(() => {}); return operation;
  }
  private async install(key: number, signal: AbortSignal): Promise<void> {
    let pending: Binding | undefined, journaled = false;
    try {
      if (!this.owner) await this.probe(); const owner = this.owner;
      if (!owner || !this.current.available) throw new BusFailure("REMOTE_ERROR");
      await this.recover(owner);
      const available = await this.call(owner, "globalShortcutAvailable", "(ai)s", "b", [sequence(key), text("")], signal);
      if (available[0]?.type !== "b") throw new BusFailure("INVALID_FRAME");
      if (!available[0].value) { this.publish({ result: "CONFLICT" }); return; }
      const component = `${this.appId}.trigger.${randomUUID().replaceAll("-", "")}`;
      pending = { component, owner, componentPath: "", key, subscriptions: [],
        recording: new ShortcutRecording(this.capture, () => this.hold, () => this.publish({ result: "FAILED" })) };
      await this.journal.update((entries) => [...entries, { component, connection: this.bus.uniqueName }]); journaled = true;
      const description = strings([component, action, this.appId === "io.github.whisperfree.dev" ? "OpenWhisper Dev" : "OpenWhisper", "Start or stop dictation"]);
      await this.call(owner, "doRegister", "as", "", [description], signal);
      const result = await this.call(owner, "getComponent", "s", "o", [text(component)], signal);
      if (result[0]?.type !== "o") throw new BusFailure("INVALID_FRAME"); pending.componentPath = result[0].value;
      for (const member of ["globalShortcutPressed", "globalShortcutReleased"] as const) {
        const binding = pending;
        binding.subscriptions.push(await this.bus.subscribe({ sender: owner, path: binding.componentPath,
          interface: "org.kde.kglobalaccel.Component", member }, (event) => this.edge(binding, event)));
      }
      const bound = await this.call(owner, "setShortcutKeys", "asa(ai)u", "a(ai)", [description,
        { type: "a", element: "(ai)", value: [sequence(key)] }, { type: "u", value: 6 }], signal);
      const list = bound[0], item = list?.type === "a" && list.element === "(ai)" && list.value.length === 1 ? list.value[0] : undefined;
      const keys = item?.type === "r" && item.value.length === 1 ? item.value[0] : undefined;
      if (keys?.type !== "a" || keys.element !== "i" || keys.value.length !== 4 || keys.value.some((value, index) =>
        value.type !== "i" || value.value !== (index === 0 ? key : 0))) {
        this.publish({ result: "CONFLICT" }); throw new Error("The desktop rejected the shortcut.");
      }
      const sameOwner = await this.bus.owner(serviceName) === owner;
      if (signal.aborted || this.closed || !sameOwner) throw new BusFailure("CANCELLED");
      if (this.active) await this.release(this.active);
      if (signal.aborted || this.closed) {
        this.publish({ key: this.active?.key ?? null }); throw new BusFailure("CANCELLED");
      }
      this.active = pending; pending = undefined; this.publish({ key, result: "ENABLED" });
    } catch (error: unknown) {
      if (this.current.result !== "CONFLICT") this.publish({ result: "FAILED" });
      throw error;
    } finally {
      if (pending) {
        try { await pending.recording.close(); for (const unsubscribe of pending.subscriptions) await unsubscribe();
          if (journaled) await this.remove(pending.owner, pending.component); }
        catch { this.cleanupFailed = true; this.publish({ result: "FAILED" }); throw new BusFailure("TEARDOWN_FAILED"); }
      }
    }
  }
  private edge(binding: Binding, event: BusEvent): void {
    if (this.closed || this.active !== binding || event.connection !== this.bus.generation || event.sender !== binding.owner ||
      event.path !== binding.componentPath || event.interface !== "org.kde.kglobalaccel.Component" || event.signature !== "ssx") return;
    const [component, id, timestamp] = event.body;
    if (component?.type !== "s" || component.value !== binding.component || id?.type !== "s" || id.value !== action || timestamp?.type !== "x") return;
    if (event.member === "globalShortcutPressed") binding.recording.activate();
    else if (event.member === "globalShortcutReleased") binding.recording.deactivate();
  }
  private async release(binding: Binding): Promise<void> {
    await binding.recording.close();
    for (const unsubscribe of binding.subscriptions) await unsubscribe();
    await this.remove(binding.owner, binding.component);
    if (this.active === binding) this.active = undefined;
  }
  async cancelSetup(): Promise<void> {
    this.setup?.abort(); await this.operation?.catch(() => {});
    if (this.cleanupFailed) throw new BusFailure("TEARDOWN_FAILED");
    this.publish({ key: this.active?.key ?? null, result: this.active ? "ENABLED" : "NONE" });
  }
  clear(result: KdeKeyboardState["result"] = "NONE"): Promise<void> {
    if (this.clearTask) return this.clearTask;
    this.setup?.abort();
    const task = Promise.resolve().then(async () => {
      await this.operation?.catch(() => {});
      if (this.cleanupFailed) throw new BusFailure("TEARDOWN_FAILED");
      try { if (this.active) await this.release(this.active); this.publish({ key: null, result }); }
      catch { this.cleanupFailed = true; this.publish({ key: null, result: "FAILED" }); throw new BusFailure("TEARDOWN_FAILED"); }
    });
    this.clearTask = task;
    void task.catch(() => {}).finally(() => { if (this.clearTask === task) this.clearTask = undefined; });
    return task;
  }
  close(): Promise<void> {
    this.closed = true;
    this.closeTask ??= Promise.resolve().then(async () => { await this.clear(); await this.watcher?.(); this.watcher = undefined; });
    void this.closeTask.catch(() => {}); return this.closeTask;
  }
}

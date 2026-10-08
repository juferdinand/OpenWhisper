import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BusFailure, type BusEvent, type BusFilter, type BusMethod, type BusReply } from "./bus.js";
import type { BusValue } from "./bus-values.js";
import type { ControlCapturePort } from "./control.js";
import { ShortcutRecording } from "./shortcut-recording.js";

const desktop = "/org/freedesktop/portal/desktop";
const portalName = "org.freedesktop.portal.Desktop";
const shortcuts = "org.freedesktop.portal.GlobalShortcuts";
const daemon = "org.freedesktop.DBus";
export const portalShortcutStateSchema = z.strictObject({ available: z.boolean(), configuring: z.boolean(),
  label: z.string().max(1024).nullable(), nativeAvailable: z.boolean().default(false), nativeKey: z.int().nullable().default(null),
  result: z.enum(["NONE", "ENABLED", "UNASSIGNED", "CANCELLED", "ENDED", "FAILED", "CONFLICT", "CONFIGURE_UNAVAILABLE"]) });
export type PortalShortcutState = z.infer<typeof portalShortcutStateSchema>;
export interface ShortcutBus {
  readonly uniqueName: string; readonly generation: string; readonly isClosed: boolean;
  owner(name: string): Promise<string>;
  call(method: BusMethod, signal?: AbortSignal): Promise<BusReply>;
  subscribe(filter: BusFilter, handler: (event: BusEvent) => void): Promise<() => Promise<void>>;
}
const string = (value: string): BusValue => ({ type: "s", value });
const object = (value: string): BusValue => ({ type: "o", value });
const dictionary = (values: Readonly<Record<string, BusValue>> = {}): BusValue => ({ type: "dict", key: "s", member: "v",
  value: Object.entries(values).map(([key, value]) => ({ key: string(key), value: { type: "v", signature: signature(value), value } })) });
function signature(value: BusValue): string { return value.type === "s" ? "s" : value.type === "a" ? `a${value.element}` : "o"; }
function field(value: BusValue | undefined, name: string): BusValue | undefined {
  if (value?.type !== "dict" || value.key !== "s" || value.member !== "v") return undefined;
  const matches = value.value.filter((entry) => entry.key.type === "s" && entry.key.value === name);
  const entry = matches.length === 1 ? matches[0]?.value : undefined;
  return entry?.type === "v" ? entry.value : undefined;
}
function description(value: BusValue | undefined): string | null {
  if (value?.type !== "a" || value.element !== "(sa{sv})") throw new BusFailure("INVALID_FRAME");
  const matching = value.value.filter((item) => item.type === "r" && item.value[0]?.type === "s" && item.value[0].value === "dictate");
  if (matching.length > 1) throw new BusFailure("INVALID_FRAME");
  const shortcut = matching[0]; const label = shortcut?.type === "r" ? field(shortcut.value[1], "trigger_description") : undefined;
  if (label === undefined) return null;
  if (label.type !== "s" || label.value.length > 1024) throw new BusFailure("INVALID_FRAME");
  return label.value.trim() || null;
}

/** The existing utility's bus owns portal consent, release edges and session cleanup. */
export class PortalShortcuts {
  private owner: string | undefined;
  private registeredOwner: string | undefined;
  private version = 0;
  private session: string | undefined;
  private sessionOwner: string | undefined;
  private trigger: ShortcutRecording | undefined;
  private hold = false;
  private setup: AbortController | undefined;
  private operation: Promise<void> | undefined;
  private clearTask: Promise<void> | undefined;
  private closed = false;
  private cleanupFailed = false;
  private watcher: (() => Promise<void>) | undefined;
  private subscriptions: (() => Promise<void>)[] = [];
  private lastTimestamp = 0n;
  private current = portalShortcutStateSchema.parse({ available: false, configuring: false, label: null, result: "NONE" });
  private constructor(private readonly bus: ShortcutBus, private readonly capture: ControlCapturePort,
    private readonly changed: (state: PortalShortcutState) => void, private readonly responseMs: number) {}
  static async create(bus: ShortcutBus, capture: ControlCapturePort, changed: (state: PortalShortcutState) => void,
    responseMs = 120_000): Promise<PortalShortcuts> {
    const service = new PortalShortcuts(bus, capture, changed, responseMs);
    service.watcher = await bus.subscribe({ sender: daemon, path: "/org/freedesktop/DBus", interface: daemon,
      member: "NameOwnerChanged" }, (event) => {
      const [name, before, after] = event.body;
      if (event.connection !== bus.generation || event.signature !== "sss" || name?.type !== "s" || name.value !== portalName ||
        before?.type !== "s" || after?.type !== "s") return;
      service.owner = undefined; service.registeredOwner = undefined;
      service.publish({ available: false, label: null });
      void service.clear("ENDED").then(() => service.probe()).catch(() => service.publish({ result: "FAILED" }));
    });
    await service.probe(); return service;
  }
  state(): PortalShortcutState { return { ...this.current }; }
  private publish(changes: Partial<PortalShortcutState>): void {
    this.current = portalShortcutStateSchema.parse({ ...this.current, ...changes }); this.changed(this.state());
  }
  private async probe(): Promise<void> {
    if (this.closed || this.bus.isClosed) return;
    try {
      const owner = await this.bus.owner(portalName);
      const reply = await this.bus.call({ destination: owner, path: desktop, interface: "org.freedesktop.DBus.Properties", member: "Get",
        inputSignature: "ss", outputSignature: "v", body: [string(shortcuts), string("version")], timeoutMs: 2000 });
      const value = reply.body[0];
      if (value?.type !== "v" || value.signature !== "u" || value.value.type !== "u" || value.value.value < 1) throw new BusFailure("INVALID_FRAME");
      if (this.closed || await this.bus.owner(portalName) !== owner) return;
      this.owner = owner; this.version = value.value.value; this.publish({ available: true });
    } catch { this.publish({ available: false }); }
  }
  command(action: "enable" | "configure" | "clear" | "cancel" | "mode", hold: boolean): void {
    if (this.closed) throw new BusFailure("CLOSED");
    if (this.cleanupFailed) throw new BusFailure("TEARDOWN_FAILED");
    this.hold = hold;
    if (action === "mode") return;
    if (action === "clear" || action === "cancel") {
      void this.clear(action === "cancel" ? "CANCELLED" : "NONE").catch(() => this.publish({ result: "FAILED" })); return;
    }
    if (this.operation || this.clearTask) return;
    const setup = new AbortController(); this.setup = setup; this.publish({ configuring: true, result: "NONE" });
    const existingSession = this.session;
    const operation = (async () => {
      try {
        if (!this.owner) await this.probe();
        const owner = this.owner;
        if (!owner || !this.current.available) throw new BusFailure("REMOTE_ERROR");
        if (this.session) {
          if (this.version < 2) throw new BusFailure("REMOTE_ERROR");
          await this.bus.call({ destination: owner, path: desktop, interface: shortcuts, member: "ConfigureShortcuts",
            inputSignature: "osa{sv}", outputSignature: "", body: [object(this.session), string(""), dictionary()], timeoutMs: 3000 }, setup.signal);
          return;
        }
        if (this.registeredOwner !== owner) {
          // Registry is optional on older frontends. It grants no input permission.
          try { await this.bus.call({ destination: owner, path: desktop, interface: "org.freedesktop.host.portal.Registry", member: "Register",
            inputSignature: "sa{sv}", outputSignature: "", body: [string("io.github.whisperfree.dev"), dictionary()], timeoutMs: 2000 }, setup.signal); }
          catch (error: unknown) { if (!(error instanceof BusFailure) || error.code !== "REMOTE_ERROR") throw error; }
          this.registeredOwner = owner;
        }
        const token = `openwhisper_${randomUUID().replaceAll("-", "")}`;
        const session = `${desktop}/session/${this.bus.uniqueName.slice(1).replaceAll(".", "_")}/${token}`;
        this.session = session; this.sessionOwner = owner; this.lastTimestamp = 0n;
        this.trigger = new ShortcutRecording(this.capture, () => this.hold, () => this.publish({ result: "FAILED" }));
        await this.listen(owner, session);
        const created = await this.request(owner, "CreateSession", [], { session_handle_token: string(token) }, setup.signal);
        const returned = field(created, "session_handle");
        if (returned?.type !== "s" || returned.value !== session) throw new BusFailure("INVALID_FRAME");
        const list: BusValue = { type: "a", element: "(sa{sv})", value: [{ type: "r", value: [string("dictate"),
          dictionary({ description: string("Start or stop dictation"), preferred_trigger: string("CTRL+ALT+space") })] }] };
        const bound = await this.request(owner, "BindShortcuts", [object(session), list, string("")], {}, setup.signal);
        const label = description(field(bound, "shortcuts")); this.publish({ label, result: label ? "ENABLED" : "UNASSIGNED" });
      } catch (error: unknown) {
        if (existingSession && !setup.signal.aborted) {
          // A missing/failed settings dialog does not revoke an existing grant.
          this.publish({ result: this.current.label ? "CONFIGURE_UNAVAILABLE" : "UNASSIGNED" }); return;
        }
        await this.releaseSession();
        this.publish({ result: setup.signal.aborted || error instanceof BusFailure && error.code === "CANCELLED" ? "CANCELLED" : "FAILED" });
      } finally {
        if (this.setup === setup) this.setup = undefined;
        this.publish({ configuring: false });
      }
    })();
    this.operation = operation;
    void operation.catch(() => this.publish({ result: "FAILED" })).finally(() => { if (this.operation === operation) this.operation = undefined; });
  }
  private async listen(owner: string, session: string): Promise<void> {
    const add = async (path: string, iface: string, member: string, receive: (event: BusEvent) => void) => {
      const unsubscribe = await this.bus.subscribe({ sender: owner, path, interface: iface, member }, (event) => {
        if (this.closed || this.session !== session || event.connection !== this.bus.generation || event.sender !== owner ||
          event.path !== path || event.interface !== iface || event.member !== member) return;
        receive(event);
      }); this.subscriptions.push(unsubscribe);
    };
    await add(session, "org.freedesktop.portal.Session", "Closed", () => {
      void this.clear("ENDED").catch(() => this.publish({ result: "FAILED" }));
    });
    await add(desktop, shortcuts, "ShortcutsChanged", (event) => {
      if (this.current.configuring && !this.current.label) return;
      if (event.signature !== "oa(sa{sv})" || event.body[0]?.type !== "o" || event.body[0].value !== session) return;
      try {
        const label = description(event.body[1]); this.publish({ label, result: label ? "ENABLED" : "UNASSIGNED" });
        if (!label) void this.clear("UNASSIGNED").catch(() => this.publish({ result: "FAILED" }));
      }
      catch { this.publish({ result: "FAILED" }); }
    });
    for (const member of ["Activated", "Deactivated"] as const) await add(desktop, shortcuts, member, (event) => {
      const [handle, id, timestamp] = event.body;
      if (!this.current.label || event.signature !== "osta{sv}" || handle?.type !== "o" || handle.value !== session ||
        id?.type !== "s" || id.value !== "dictate" || timestamp?.type !== "t" || !/^[0-9]+$/u.test(timestamp.value)) return;
      const time = BigInt(timestamp.value); if (time < this.lastTimestamp) return; this.lastTimestamp = time;
      if (member === "Activated") this.trigger?.activate(); else this.trigger?.deactivate();
    });
  }
  private async request(owner: string, member: "CreateSession" | "BindShortcuts", prefix: BusValue[],
    options: Record<string, BusValue>, signal: AbortSignal): Promise<BusValue> {
    const token = `openwhisper_${randomUUID().replaceAll("-", "")}`;
    const path = `${desktop}/request/${this.bus.uniqueName.slice(1).replaceAll(".", "_")}/${token}`;
    let accept!: (value: BusValue) => void, reject!: (reason: unknown) => void;
    const response = new Promise<BusValue>((resolve, refuse) => { accept = resolve; reject = refuse; }); void response.catch(() => {});
    const abort = () => reject(new BusFailure("CANCELLED"));
    const timer = setTimeout(() => reject(new BusFailure("TIMEOUT")), this.responseMs);
    let unsubscribe: (() => Promise<void>) | undefined;
    let succeeded = false;
    try {
      unsubscribe = await this.bus.subscribe({ sender: owner, path, interface: "org.freedesktop.portal.Request", member: "Response" }, (event) => {
        if (event.connection !== this.bus.generation || event.sender !== owner || event.path !== path || event.signature !== "ua{sv}") return;
        const [code, values] = event.body;
        if (code?.type !== "u" || values?.type !== "dict") { reject(new BusFailure("INVALID_FRAME")); return; }
        if (code.value === 0) accept(values); else reject(new BusFailure(code.value === 1 ? "CANCELLED" : "DENIED"));
      });
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      const reply = await this.bus.call({ destination: owner, path: desktop, interface: shortcuts, member,
        inputSignature: member === "CreateSession" ? "a{sv}" : "oa(sa{sv})sa{sv}", outputSignature: "o",
        body: [...prefix, dictionary({ ...options, handle_token: string(token) })], timeoutMs: 3000 }, signal);
      if (reply.body[0]?.type !== "o" || reply.body[0].value !== path) throw new BusFailure("INVALID_FRAME");
      const value = await response; if (signal.aborted) throw new BusFailure("CANCELLED"); succeeded = true; return value;
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (!succeeded) await this.remoteClose(owner, path, "org.freedesktop.portal.Request");
      await unsubscribe?.();
    }
  }
  private async remoteClose(owner: string, path: string, iface: string): Promise<void> {
    try { await this.bus.call({ destination: owner, path, interface: iface, member: "Close", inputSignature: "", outputSignature: "", body: [], timeoutMs: 1000 }); }
    catch (error: unknown) { if (!(error instanceof BusFailure) || error.code !== "REMOTE_ERROR") throw error; }
  }
  private async releaseSession(): Promise<void> {
    const session = this.session, trigger = this.trigger, owner = this.sessionOwner;
    this.session = undefined; this.publish({ label: null });
    try {
      await trigger?.close(); this.trigger = undefined;
      if (session && owner) await this.remoteClose(owner, session, "org.freedesktop.portal.Session");
      this.sessionOwner = undefined;
      const subscriptions = this.subscriptions.splice(0); await Promise.all(subscriptions.map((unsubscribe) => unsubscribe()));
    } catch (error: unknown) { this.cleanupFailed = true; this.publish({ available: false }); throw error; }
  }
  clear(result: PortalShortcutState["result"] = "NONE"): Promise<void> {
    if (this.clearTask) return this.clearTask;
    this.setup?.abort(); this.publish({ label: null, configuring: true });
    const task = Promise.resolve().then(async () => {
      await this.operation; await this.releaseSession(); this.publish({ result, configuring: false });
    });
    this.clearTask = task; void task.catch(() => this.publish({ configuring: false, result: "FAILED" })).finally(() => {
      if (this.clearTask === task) this.clearTask = undefined;
    }); return task;
  }
  async close(): Promise<void> { this.closed = true; await this.clear(); await this.watcher?.(); }
}

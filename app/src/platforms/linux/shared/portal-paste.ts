import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BusFailure, type BusEvent } from "./bus.js";
import { signatureOf, type BusValue } from "./bus-values.js";
import { linuxApplicationIdSchema, type LinuxApplicationId, type ShortcutBus } from "./portal-shortcuts.js";

const desktop = "/org/freedesktop/portal/desktop", portalName = "org.freedesktop.portal.Desktop";
const remote = "org.freedesktop.portal.RemoteDesktop", daemon = "org.freedesktop.DBus";
const text = (value: string): BusValue => ({ type: "s", value });
const object = (value: string): BusValue => ({ type: "o", value });
const dict = (values: Readonly<Record<string, BusValue>> = {}): BusValue => ({ type: "dict", key: "s", member: "v",
  value: Object.entries(values).map(([key, value]) => ({ key: text(key), value: { type: "v", signature: signatureOf(value), value } })) });
function field(value: BusValue | undefined, key: string): BusValue | undefined {
  if (value?.type !== "dict" || value.key !== "s" || value.member !== "v") return undefined;
  const entries = value.value.filter((entry) => entry.key.type === "s" && entry.key.value === key);
  const result = entries.length === 1 ? entries[0]?.value : undefined;
  return result?.type === "v" ? result.value : undefined;
}
export const portalPasteStateSchema = z.strictObject({ available: z.boolean(), configuring: z.boolean(), ready: z.boolean(),
  result: z.enum(["NONE", "ENABLED", "CANCELLED", "DENIED", "ENDED", "FAILED"]) });
export type PortalPasteState = z.infer<typeof portalPasteStateSchema>;
interface Session { path: string; owner: string; started: boolean; closed: boolean; unsubscribe: () => Promise<void> }

/** Explicit keyboard-only consent; all input and sessions stay on the existing utility bus. */
export class PortalPaste {
  private owner: string | undefined;
  private session: Session | undefined;
  private setup: AbortController | undefined;
  private operation: Promise<void> | undefined;
  private pasteOperation: Promise<boolean> | undefined;
  private clearTask: Promise<void> | undefined;
  private closeTask: Promise<void> | undefined;
  private watcher: (() => Promise<void>) | undefined;
  private closed = false;
  private cleanupFailed = false;
  private current: PortalPasteState = { available: false, configuring: false, ready: false, result: "NONE" };
  private constructor(private readonly bus: ShortcutBus, private readonly changed: (state: PortalPasteState) => void,
    private readonly responseMs: number, private readonly failed: () => void, private readonly appId: LinuxApplicationId) {}
  static async create(bus: ShortcutBus, changed: (state: PortalPasteState) => void, responseMs = 120_000,
    failed: () => void = () => {}, appId: LinuxApplicationId = "io.github.whisperfree.dev"): Promise<PortalPaste> {
    const paste = new PortalPaste(bus, changed, responseMs, failed, linuxApplicationIdSchema.parse(appId));
    paste.watcher = await bus.subscribe({ sender: daemon, path: "/org/freedesktop/DBus", interface: daemon,
      member: "NameOwnerChanged" }, (event) => {
      const [name, before, after] = event.body;
      if (event.connection !== bus.generation || event.sender !== daemon || event.signature !== "sss" ||
        name?.type !== "s" || name.value !== portalName || before?.type !== "s" || after?.type !== "s") return;
      paste.owner = undefined; paste.publish({ available: false, ready: false });
      void paste.clear("ENDED").then(() => paste.probe()).catch(() => paste.publish({ result: "FAILED" }));
    });
    await paste.probe(); return paste;
  }
  state(): PortalPasteState { return { ...this.current }; }
  private publish(changes: Partial<PortalPasteState>): void {
    this.current = portalPasteStateSchema.parse({ ...this.current, ...changes }); this.changed(this.state());
  }
  private failCleanup(): void {
    if (this.cleanupFailed) return;
    this.cleanupFailed = true; this.publish({ ready: false, available: false, configuring: false, result: "FAILED" });
    this.failed();
  }
  private async probe(): Promise<void> {
    if (this.closed || this.bus.isClosed) return;
    try {
      const owner = await this.bus.owner(portalName);
      const reply = await this.bus.call({ destination: owner, path: desktop, interface: "org.freedesktop.DBus.Properties",
        member: "Get", inputSignature: "ss", outputSignature: "v", body: [text(remote), text("AvailableDeviceTypes")], timeoutMs: 2000 });
      const value = reply.body[0];
      if (value?.type !== "v" || value.signature !== "u" || value.value.type !== "u" || !(value.value.value & 1)) throw new BusFailure("INVALID_FRAME");
      if (this.closed) return; this.owner = owner; this.publish({ available: true });
    } catch { this.publish({ available: false }); }
  }
  enable(): void {
    if (this.closed || this.cleanupFailed) throw new BusFailure("TEARDOWN_FAILED");
    if (this.current.ready || this.operation || this.clearTask) return;
    const setup = new AbortController(); this.setup = setup; this.publish({ configuring: true, result: "NONE" });
    const operation = (async () => {
      try {
        if (!this.owner) await this.probe(); const owner = this.owner;
        if (!owner || !this.current.available) throw new BusFailure("REMOTE_ERROR");
        try { await this.bus.call({ destination: owner, path: desktop, interface: "org.freedesktop.host.portal.Registry",
          member: "Register", inputSignature: "sa{sv}", outputSignature: "", body: [text(this.appId), dict()], timeoutMs: 2000 }, setup.signal); }
        catch (error: unknown) { if (!(error instanceof BusFailure) || error.code !== "REMOTE_ERROR") throw error; }
        const token = `openwhisper_${randomUUID().replaceAll("-", "")}`;
        const path = `${desktop}/session/${this.bus.uniqueName.slice(1).replaceAll(".", "_")}/${token}`;
        const session: Session = { path, owner, started: false, closed: false, unsubscribe: async () => {} }; this.session = session;
        session.unsubscribe = await this.bus.subscribe({ sender: owner, path, interface: "org.freedesktop.portal.Session", member: "Closed" }, (event) => {
          if (!this.valid(event, owner, path) || event.interface !== "org.freedesktop.portal.Session" || event.member !== "Closed" ||
            event.signature !== "a{sv}" || this.session !== session) return;
          session.closed = true; this.setup?.abort(); this.publish({ ready: false, result: "ENDED" });
          if (!this.operation) void this.clear("ENDED").catch(() => this.publish({ result: "FAILED" }));
        });
        const created = await this.request(owner, "CreateSession", [], { session_handle_token: text(token) }, setup.signal,
          () => { session.started = true; });
        const returned = field(created, "session_handle");
        if (returned?.type !== "s" || returned.value !== path) throw new BusFailure("INVALID_FRAME");
        await this.request(owner, "SelectDevices", [object(path)], { types: { type: "u", value: 1 } }, setup.signal);
        const started = await this.request(owner, "Start", [object(path), text("")], {}, setup.signal);
        const devices = field(started, "devices");
        if (devices?.type !== "u" || !(devices.value & 1)) throw new BusFailure("DENIED");
        if (setup.signal.aborted || session.closed || this.closed || this.session !== session) throw new BusFailure("CANCELLED");
        this.publish({ ready: true, result: "ENABLED" });
      } catch (error: unknown) {
        await this.releaseSession();
        this.publish({ ready: false, result: error instanceof BusFailure && error.code === "CANCELLED" ? "CANCELLED"
          : error instanceof BusFailure && error.code === "DENIED" ? "DENIED" : "FAILED" });
      } finally { if (this.setup === setup) this.setup = undefined; this.publish({ configuring: false }); }
    })().catch(() => {
      this.failCleanup(); throw new BusFailure("TEARDOWN_FAILED");
    }).finally(() => { if (this.operation === operation) this.operation = undefined; });
    this.operation = operation; void operation.catch(() => {});
  }
  private valid(event: BusEvent, owner: string, path: string): boolean {
    return event.connection === this.bus.generation && event.sender === owner && event.path === path;
  }
  private async request(owner: string, member: "CreateSession" | "SelectDevices" | "Start", prefix: BusValue[],
    options: Readonly<Record<string, BusValue>>, signal: AbortSignal, dispatched: () => void = () => {}): Promise<BusValue> {
    const token = `openwhisper_${randomUUID().replaceAll("-", "")}`;
    const path = `${desktop}/request/${this.bus.uniqueName.slice(1).replaceAll(".", "_")}/${token}`;
    let accept!: (value: BusValue) => void, reject!: (error: unknown) => void;
    const response = new Promise<BusValue>((resolve, refuse) => { accept = resolve; reject = refuse; }); void response.catch(() => {});
    const abort = () => reject(new BusFailure("CANCELLED"));
    const timer = setTimeout(() => reject(new BusFailure("TIMEOUT")), this.responseMs);
    let unsubscribe: (() => Promise<void>) | undefined, completed = false, requested = false;
    try {
      unsubscribe = await this.bus.subscribe({ sender: owner, path, interface: "org.freedesktop.portal.Request", member: "Response" }, (event) => {
        if (!this.valid(event, owner, path) || event.interface !== "org.freedesktop.portal.Request" || event.member !== "Response" || event.signature !== "ua{sv}") return;
        const [code, values] = event.body;
        if (code?.type !== "u" || values?.type !== "dict") { reject(new BusFailure("INVALID_FRAME")); return; }
        completed = true;
        if (code.value === 0) accept(values); else reject(new BusFailure(code.value === 1 ? "CANCELLED" : "DENIED"));
      });
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      // No object can exist if cancellation happened while subscriptions were prepared.
      if (signal.aborted) throw new BusFailure("CANCELLED");
      dispatched(); requested = true;
      const reply = await this.bus.call({ destination: owner, path: desktop, interface: remote, member,
        inputSignature: member === "CreateSession" ? "a{sv}" : member === "SelectDevices" ? "oa{sv}" : "osa{sv}",
        outputSignature: "o", body: [...prefix, dict({ ...options, handle_token: text(token) })], timeoutMs: 3000 }, signal);
      if (reply.body[0]?.type !== "o" || reply.body[0].value !== path) throw new BusFailure("INVALID_FRAME");
      const value = await response; if (signal.aborted) throw new BusFailure("CANCELLED"); return value;
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      try { if (requested && !completed) await this.remoteClose(owner, path, "org.freedesktop.portal.Request"); }
      finally { await unsubscribe?.(); }
    }
  }
  private async remoteClose(owner: string, path: string, iface: string): Promise<void> {
    try { await this.bus.call({ destination: owner, path, interface: iface, member: "Close", inputSignature: "", outputSignature: "", body: [], timeoutMs: 1000 }); }
    catch (error: unknown) {
      if (this.session?.owner === owner && this.session.closed && this.session.path === path) return;
      if (!(error instanceof BusFailure) || error.code !== "REMOTE_ERROR") throw error;
      const reply = await this.bus.call({ destination: daemon, path: "/org/freedesktop/DBus", interface: daemon, member: "NameHasOwner",
        inputSignature: "s", outputSignature: "b", body: [text(owner)], timeoutMs: 1000 });
      if (reply.body[0]?.type !== "b" || reply.body[0].value) throw error;
    }
  }
  private async releaseSession(): Promise<void> {
    const session = this.session; this.publish({ ready: false });
    if (!session) return;
    if (session.started && !session.closed) await this.remoteClose(session.owner, session.path, "org.freedesktop.portal.Session");
    await session.unsubscribe(); if (this.session === session) this.session = undefined;
  }
  paste(): Promise<boolean> {
    if (this.pasteOperation) return Promise.resolve(false);
    const session = this.session;
    if (!session || !this.current.ready || session.closed || this.closed || this.clearTask) return Promise.resolve(false);
    const operation = (async () => {
      let failed = false;
      // Release both keys even after a press failure. Never replay an uncertain paste.
      for (const [key, state] of [[29, 1], [47, 1], [47, 0], [29, 0]] as const) {
        if (state === 1 && (failed || session.closed || !this.current.ready)) { failed = true; continue; }
        try { await this.bus.call({ destination: session.owner, path: desktop, interface: remote, member: "NotifyKeyboardKeycode",
          inputSignature: "oa{sv}iu", outputSignature: "", body: [object(session.path), dict(), { type: "i", value: key }, { type: "u", value: state }], timeoutMs: 1000 }); }
        catch { failed = true; }
      }
      if (failed) this.publish({ ready: false, result: "FAILED" });
      return !failed;
    })();
    this.pasteOperation = operation;
    void operation.finally(() => { if (this.pasteOperation === operation) this.pasteOperation = undefined;
      if (!this.current.ready) void this.clear("FAILED").catch(() => this.publish({ result: "FAILED" })); });
    return operation;
  }
  clear(result: PortalPasteState["result"] = "NONE"): Promise<void> {
    if (this.clearTask) return this.clearTask;
    this.setup?.abort(); this.publish({ ready: false });
    const task = Promise.resolve().then(async () => { await this.operation; await this.pasteOperation; await this.releaseSession();
      this.publish({ configuring: false, result }); }).catch(() => {
      this.failCleanup(); throw new BusFailure("TEARDOWN_FAILED");
    }).finally(() => { if (this.clearTask === task) this.clearTask = undefined; });
    this.clearTask = task; void task.catch(() => {});
    return task;
  }
  close(): Promise<void> {
    this.closeTask ??= Promise.resolve().then(async () => { this.closed = true; await this.clear(); await this.watcher?.(); });
    return this.closeTask;
  }
}

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boundBusInput, busInterfaceSchema, busMemberSchema, busPathSchema, busSignatureSchema,
  busUniqueNameSchema, parseBusValues, signatureOf, type BusValue } from "./bus-values.js";

const daemon = "org.freedesktop.DBus";
const senderSchema = z.union([busUniqueNameSchema, z.literal(daemon)]);
const connectionSchema = z.strictObject({ connection: z.uuid(), uniqueName: busUniqueNameSchema });
const lifecycleSchema = z.strictObject({ kind: z.literal("failure"), connection: z.uuid() });
const replySchema = z.strictObject({ connection: z.uuid(), id: z.uuid(), sender: senderSchema,
  signature: busSignatureSchema, body: z.unknown() });
const deadlineSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).refine((value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) < (1n << 64n));
const openingOptionsSchema = z.strictObject({ expiresAtUs: deadlineSchema });
const openingSchema = z.strictObject({ connection: z.uuid(), ready: z.instanceof(Promise) });
const eventFields = { connection: z.uuid(), path: busPathSchema, interface: busInterfaceSchema, member: busMemberSchema,
  signature: busSignatureSchema, body: z.unknown() };
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...eventFields, kind: z.literal("signal"), id: z.literal(""), sender: senderSchema }),
  z.strictObject({ ...eventFields, kind: z.literal("method"), id: z.uuid(), sender: busUniqueNameSchema, expiresAtUs: deadlineSchema }),
]);
const methodSchema = z.strictObject({ destination: senderSchema, path: busPathSchema, interface: busInterfaceSchema,
  member: busMemberSchema, inputSignature: busSignatureSchema, outputSignature: busSignatureSchema,
  body: z.unknown(), timeoutMs: z.int().min(1).max(5000) });
const filterSchema = z.strictObject({ sender: senderSchema, path: busPathSchema, interface: busInterfaceSchema, member: busMemberSchema });
const nativeNames = ["open", "call", "cancel", "subscribe", "unsubscribe", "exportControl", "reply", "reject", "readFd", "closeFd", "close"] as const;
type NativeName = typeof nativeNames[number];
type NativeMethods = Record<NativeName, (...args: unknown[]) => unknown>;
export type BusMethod = z.input<typeof methodSchema>;
export type BusFilter = z.infer<typeof filterSchema>;
export interface BusReply { sender: string; signature: string; body: BusValue[] }
export type BusOpeningOptions = z.input<typeof openingOptionsSchema>;
export interface BusEvent extends BusReply { kind: "signal" | "method"; connection: string; id: string; path: string; interface: string; member: string; expiresAtUs?: string }
export type BusFailureCode = "INVALID_FRAME" | "CLOSED" | "CANCELLED" | "TIMEOUT" | "REMOTE_ERROR" | "TRANSPORT_FAILED" | "TEARDOWN_FAILED" | "EXPIRED" | "DENIED";
export class BusFailure extends Error {
  constructor(readonly code: BusFailureCode) { super("Linux session service failed."); this.name = "BusFailure"; }
}
function safeFailure(error: unknown): BusFailure {
  if (error instanceof BusFailure) return error;
  if (typeof error === "object" && error !== null) {
    const code: unknown = Reflect.get(error, "code");
    if (code === "CANCELLED" || code === "TIMEOUT" || code === "CLOSED" || code === "REMOTE_ERROR" || code === "INVALID_FRAME" || code === "TEARDOWN_FAILED") return new BusFailure(code);
  }
  return new BusFailure("TRANSPORT_FAILED");
}
function methods(binding: unknown): NativeMethods {
  if (typeof binding !== "object" || binding === null) throw new BusFailure("INVALID_FRAME");
  const receiver = binding;
  function method(name: NativeName): (...args: unknown[]) => unknown {
    const callable: unknown = Reflect.get(receiver, name);
    if (typeof callable !== "function") throw new BusFailure("INVALID_FRAME");
    return (...args) => { const result: unknown = Reflect.apply(callable, receiver, args); return result; };
  }
  return { open: method("open"), call: method("call"), cancel: method("cancel"), subscribe: method("subscribe"),
    unsubscribe: method("unsubscribe"), exportControl: method("exportControl"), reply: method("reply"), reject: method("reject"),
    readFd: method("readFd"), closeFd: method("closeFd"), close: method("close") };
}
export function parseSessionBusAddress(input: unknown): string {
  const value = z.string().max(1024).parse(input);
  if (!/^unix:(?:path=\/[A-Za-z0-9_./%\-]+|abstract=[A-Za-z0-9_./%\-]+)(?:,guid=[a-fA-F0-9]{32})?$/.test(value)) throw new BusFailure("INVALID_FRAME");
  return value;
}
function validatedReply(input: unknown): z.infer<typeof replySchema> & { body: BusValue[] } {
  boundBusInput(input); const reply = replySchema.parse(input); const body = parseBusValues(reply.body);
  if (body.map(signatureOf).join("") !== reply.signature) throw new BusFailure("INVALID_FRAME");
  return { ...reply, body };
}

/** Worker-local facade. It never opens a bus merely by being imported. */
export class LinuxBus {
  readonly uniqueName: string;
  readonly generation: string;
  private readonly connection: string;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  private readonly pending = new Map<string, Promise<BusReply>>();
  private readonly subscriptions = new Set<string>();
  private constructor(private readonly native: NativeMethods, identity: z.infer<typeof connectionSchema>) {
    this.connection = identity.connection; this.generation = identity.connection; this.uniqueName = identity.uniqueName;
  }
  /** Injection exists for pure tests and owned utilities, never preload IPC. */
  static async open(binding: unknown, address: unknown, signal?: AbortSignal, opening?: BusOpeningOptions): Promise<LinuxBus> {
    if (signal?.aborted) throw new BusFailure("CANCELLED");
    const native = methods(binding); const explicit = parseSessionBusAddress(address);
    if (opening !== undefined) return LinuxBus.openBefore(binding, native, explicit, opening, signal);
    let bus: LinuxBus | undefined;
    let earlyFailure: string | undefined;
    const onFailure = (input: unknown): void => {
      try {
        boundBusInput(input); const frame = lifecycleSchema.parse(input);
        if (bus) { if (frame.connection === bus.connection) void bus.close().catch(() => undefined); }
        else earlyFailure = frame.connection;
      } catch { if (bus) void bus.close().catch(() => undefined); }
    };
    try {
      const result: unknown = await native.open(explicit, onFailure); boundBusInput(result);
      bus = new LinuxBus(native, connectionSchema.parse(result));
      if (earlyFailure !== undefined) { await bus.close(); throw new BusFailure("TRANSPORT_FAILED"); }
      if (signal?.aborted) { await bus.close(); throw new BusFailure("CANCELLED"); }
      return bus;
    } catch (error: unknown) { if (bus && !bus.closing) await bus.close(); throw safeFailure(error); }
  }
  private static async openBefore(binding: unknown, native: NativeMethods, address: string,
                                  input: BusOpeningOptions, signal?: AbortSignal): Promise<LinuxBus> {
    const options = openingOptionsSchema.parse(input);
    const expires = BigInt(options.expiresAtUs);
    if (expires <= process.hrtime.bigint() / 1000n) throw new BusFailure("TIMEOUT");
    if (typeof binding !== "object" || binding === null) throw new BusFailure("INVALID_FRAME");
    const begin: unknown = Reflect.get(binding, "beginOpen");
    if (typeof begin !== "function") throw new BusFailure("INVALID_FRAME");
    let connection: string | undefined;
    let bus: LinuxBus | undefined;
    let earlyFailure = false;
    let cancelled = false;
    let closing: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (closing) return closing;
      if (!connection) return Promise.reject(new BusFailure("TEARDOWN_FAILED"));
      try { closing = Promise.resolve(native.close(connection)).then(() => undefined).catch((error: unknown) => { throw safeFailure(error); }); }
      catch (error: unknown) { closing = Promise.reject(safeFailure(error)); }
      // Abort/lifecycle callbacks initiate disposal synchronously, but readiness
      // remains owned until its settlement; no unhandled early rejection.
      void closing.catch(() => undefined);
      return closing;
    };
    const onFailure = (value: unknown): void => {
      try {
        boundBusInput(value); const frame = lifecycleSchema.parse(value);
        if (bus) { if (frame.connection === bus.connection) void bus.close().catch(() => undefined); return; }
        if (connection && frame.connection !== connection) return;
      } catch { /* Invalid native lifecycle metadata also requires disposal. */ }
      earlyFailure = true;
      if (connection) void dispose();
    };
    let ready: Promise<unknown> | undefined;
    const abort = (): void => { cancelled = true; void dispose(); };
    try {
      const raw: unknown = Reflect.apply(begin, binding, [address, options.expiresAtUs, onFailure]);
      // Retain a valid ownership token/Promise even if the rest of the return
      // shape is malformed, so a rejected identity cannot escape cleanup.
      if (typeof raw === "object" && raw !== null) {
        const token = z.uuid().safeParse(Reflect.get(raw, "connection"));
        const pending: unknown = Reflect.get(raw, "ready");
        if (token.success) connection = token.data;
        if (pending instanceof Promise) ready = pending;
      }
      const opened = openingSchema.parse(raw);
      connection = opened.connection; ready = opened.ready;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      if (earlyFailure) void dispose();
      const value: unknown = await ready; boundBusInput(value);
      const identity = connectionSchema.parse(value);
      if (identity.connection !== connection) throw new BusFailure("INVALID_FRAME");
      if (cancelled || signal?.aborted) throw new BusFailure("CANCELLED");
      if (earlyFailure) throw new BusFailure("TRANSPORT_FAILED");
      if (expires <= process.hrtime.bigint() / 1000n) throw new BusFailure("TIMEOUT");
      bus = new LinuxBus(native, identity);
      return bus;
    } catch (error: unknown) {
      // The native certificate includes opening completion and final callback
      // holders. Separately keep even a malformed/late ready Promise owned.
      if (connection) {
        const disposal = dispose();
        if (ready) await Promise.allSettled([ready]);
        await disposal;
      } else if (ready) {
        await Promise.allSettled([ready]);
        throw new BusFailure("TEARDOWN_FAILED");
      }
      throw safeFailure(error);
    } finally { signal?.removeEventListener("abort", abort); }
  }
  private active(): void { if (this.closing) throw new BusFailure("CLOSED"); }
  get isClosed(): boolean { return this.closing; }
  call(input: BusMethod, signal?: AbortSignal): Promise<BusReply> {
    this.active(); boundBusInput(input); const method = methodSchema.parse(input); const body = parseBusValues(method.body);
    if (body.map(signatureOf).join("") !== method.inputSignature || this.pending.size >= 8) throw new BusFailure("INVALID_FRAME");
    if (signal?.aborted) return Promise.reject(new BusFailure("CANCELLED"));
    const id = randomUUID(); let cancelled = false;
    const abort = (): void => { cancelled = true; try { this.native.cancel(this.connection, id); } catch { /* Close also cancels native work. */ } };
    // Native call registers its GCancellable synchronously before returning.
    let returned: unknown;
    try { returned = this.native.call(this.connection, { ...method, id, body, noAutoStart: true }); }
    catch (error: unknown) { return Promise.reject(safeFailure(error)); }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const task = Promise.resolve(returned).then((input: unknown) => {
      const reply = validatedReply(input);
      if (cancelled || this.closing) {
        const values = [...reply.body];
        while (values.length > 0) {
          const value = values.pop(); if (!value) continue;
          if (value.type === "h") { try { this.native.closeFd(this.connection, value.token); } catch { /* Native Close may already have disposed the holder. */ } }
          else if (value.type === "a" || value.type === "r") values.push(...value.value);
          else if (value.type === "dict") for (const entry of value.value) values.push(entry.key, entry.value);
          else if (value.type === "v") values.push(value.value);
        }
        throw new BusFailure(cancelled ? "CANCELLED" : "CLOSED");
      }
      if (reply.connection !== this.connection || reply.id !== id || reply.sender !== method.destination || reply.signature !== method.outputSignature) throw new BusFailure("INVALID_FRAME");
      return { sender: reply.sender, signature: reply.signature, body: reply.body };
    }).catch((error: unknown) => {
      const failure = safeFailure(error);
      if (failure.code === "INVALID_FRAME") void this.close().catch(() => { /* Supervision blocks reuse after failed teardown. */ });
      throw failure;
    }).finally(() => { signal?.removeEventListener("abort", abort); this.pending.delete(id); });
    this.pending.set(id, task); return task;
  }
  async owner(name: string): Promise<string> {
    const approved = z.string().max(255).regex(/^[A-Za-z_-][A-Za-z0-9_-]*(?:\.[A-Za-z_-][A-Za-z0-9_-]*)+$/).parse(name);
    const reply = await this.call({ destination: daemon, path: "/org/freedesktop/DBus", interface: daemon,
      member: "GetNameOwner", inputSignature: "s", outputSignature: "s", body: [{ type: "s", value: approved }], timeoutMs: 3000 });
    const value = reply.body[0]; if (value?.type !== "s") throw new BusFailure("INVALID_FRAME"); return busUniqueNameSchema.parse(value.value);
  }
  async uid(unique: string): Promise<number> {
    const reply = await this.call({ destination: daemon, path: "/org/freedesktop/DBus", interface: daemon,
      member: "GetConnectionUnixUser", inputSignature: "s", outputSignature: "u", body: [{ type: "s", value: busUniqueNameSchema.parse(unique) }], timeoutMs: 3000 });
    const value = reply.body[0]; if (value?.type !== "u") throw new BusFailure("INVALID_FRAME"); return value.value;
  }
  private eventCallback(filter: BusFilter | undefined, handler: (event: BusEvent) => void): (input: unknown) => void {
    return (input) => {
      if (this.closing) return;
      try {
        boundBusInput(input); const event = eventSchema.parse(input); const body = parseBusValues(event.body);
        if (event.connection !== this.connection || body.map(signatureOf).join("") !== event.signature) throw new BusFailure("INVALID_FRAME");
        if (filter && (event.kind !== "signal" || event.sender !== filter.sender || event.path !== filter.path || event.interface !== filter.interface || event.member !== filter.member)) throw new BusFailure("INVALID_FRAME");
        if (!filter && (event.kind !== "method" || !z.uuid().safeParse(event.id).success || event.path !== "/io/github/whisperfree/dev/Control" || event.interface !== "io.github.whisperfree.Control1" ||
          !((event.member === "Status" && event.signature === "") || (event.member === "Execute" && event.signature === "s")))) throw new BusFailure("INVALID_FRAME");
        const normalized: BusEvent = { kind: event.kind, connection: event.connection, id: event.id, path: event.path,
          interface: event.interface, member: event.member, sender: event.sender, signature: event.signature, body };
        if (event.kind === "method") {
          if (!event.expiresAtUs) throw new BusFailure("INVALID_FRAME");
          normalized.expiresAtUs = event.expiresAtUs;
          if (BigInt(event.expiresAtUs) <= process.hrtime.bigint() / 1000n) { void this.reject(event.id, "Expired").catch(() => undefined); return; }
        }
        handler(normalized);
      } catch { void this.close().catch(() => { /* Supervision owns failed teardown. */ }); }
    };
  }
  async subscribe(input: BusFilter, handler: (event: BusEvent) => void): Promise<() => Promise<void>> {
    this.active(); boundBusInput(input); const filter = filterSchema.parse(input);
    const result: unknown = await this.native.subscribe(this.connection, filter, this.eventCallback(filter, handler));
    const id = z.uuid().parse(result);
    if (this.closing) throw new BusFailure("CLOSED"); this.subscriptions.add(id);
    return async () => { if (!this.subscriptions.delete(id) || this.closing) return; await this.native.unsubscribe(this.connection, id); };
  }
  async exportControl(handler: (event: BusEvent) => void): Promise<void> {
    this.active(); await this.native.exportControl(this.connection, this.eventCallback(undefined, handler)); this.active();
  }
  /** Recheck after asynchronous UID lookup and again at state reservation. */
  controlCurrent(event: BusEvent): boolean {
    return !this.closing && event.kind === "method" && event.connection === this.connection &&
      event.expiresAtUs !== undefined && deadlineSchema.safeParse(event.expiresAtUs).success &&
      BigInt(event.expiresAtUs) > process.hrtime.bigint() / 1000n;
  }
  async authorizeControl(event: BusEvent): Promise<void> {
    if (!this.controlCurrent(event)) throw new BusFailure("EXPIRED");
    if (await this.uid(event.sender) !== process.getuid?.()) throw new BusFailure("DENIED");
    if (!this.controlCurrent(event)) throw new BusFailure("EXPIRED");
  }
  async reply(id: string, status: string): Promise<void> {
    this.active(); const body = parseBusValues([{ type: "s", value: status }]);
    await this.native.reply(this.connection, z.uuid().parse(id), body); this.active();
  }
  async reject(id: string, category: "Denied" | "Busy" | "Expired" | "InvalidRequest" | "Unavailable"): Promise<void> {
    this.active(); const allowed = z.enum(["Denied", "Busy", "Expired", "InvalidRequest", "Unavailable"]).parse(category);
    await this.native.reject(this.connection, z.uuid().parse(id), allowed); this.active();
  }
  async readRegularFd(token: string): Promise<Buffer> {
    this.active(); const result: unknown = await this.native.readFd(this.connection, z.uuid().parse(token)); this.active();
    if (!Buffer.isBuffer(result) || result.byteLength > 1_048_576) throw new BusFailure("INVALID_FRAME"); return result;
  }
  closeFd(token: string): void { this.active(); this.native.closeFd(this.connection, z.uuid().parse(token)); }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.subscriptions.clear();
    this.closeTask = (async () => {
      await this.native.close(this.connection);
      await Promise.allSettled([...this.pending.values()]);
    })().catch((error: unknown) => { throw safeFailure(error); }); return this.closeTask;
  }
}

/** Only a dedicated utility can load this OS binding; main never receives FDs. */
export async function openLinuxBus(address: unknown, signal?: AbortSignal): Promise<LinuxBus> {
  if (process.platform !== "linux" || (Reflect.get(process, "parentPort") === undefined && typeof process.send !== "function")) throw new BusFailure("CLOSED");
  const directory = fileURLToPath(new URL("../../../native/", import.meta.url));
  const bindingPath = join(directory, "openwhisper_linux_bus.node");
  const metadata = await lstat(bindingPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(bindingPath) !== resolve(bindingPath) || await realpath(dirname(bindingPath)) !== resolve(directory)) throw new BusFailure("CLOSED");
  const binding: unknown = createRequire(import.meta.url)(bindingPath);
  return LinuxBus.open(binding, address, signal);
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { controlStatusSchema } from "../../../core/recording/control.js";
import type { ControlCaptureLease, ControlCapturePort } from "../../../core/recording/control.js";
import { BusFailure, type BusEvent, type BusFilter, type BusMethod, type BusReply } from "./bus.js";
import { controlTarget, type ControlKind } from "./control-identity.js";
import { serializeControlStatus } from "./control-status.js";

export type { ControlCaptureLease, ControlCapturePort, ControlStatus } from "../../../core/recording/control.js";

export const DEV_CONTROL_NAME = controlTarget("development").name;
export const DEV_CONTROL_PATH = controlTarget("development").path;
const daemon = "org.freedesktop.DBus";
const controlActionSchema = z.enum(["start", "stop", "toggle", "cancel"]);
type Refusal = "Denied" | "Busy" | "Expired" | "InvalidRequest" | "Unavailable";
export interface ControlBus {
  readonly generation: string;
  readonly isClosed: boolean;
  call(method: BusMethod, signal?: AbortSignal): Promise<BusReply>;
  subscribe(filter: BusFilter, handler: (event: BusEvent) => void): Promise<() => Promise<void>>;
  exportControl(handler: (event: BusEvent) => void, kind?: ControlKind): Promise<void>;
  authorizeControl(event: BusEvent): Promise<void>;
  controlCurrent(event: BusEvent): boolean;
  reply(id: string, status: string): Promise<void>;
  reject(id: string, category: Refusal): Promise<void>;
  close(): Promise<void>;
}
interface Transaction {
  readonly id: string;
  readonly epoch: string;
  readonly event: BusEvent;
  readonly cancellation: AbortController;
  readonly timer: NodeJS.Timeout;
}
export class ControlServiceError extends Error {
  constructor(readonly code: "CLOSED" | "TEARDOWN_FAILED" | "START_FAILED") {
    super("Linux control service failed."); this.name = "ControlServiceError";
  }
}

/** Content-free control. Importing this module neither opens a bus nor captures. */
export class DevControlService {
  private readonly epoch = randomUUID();
  private active: Transaction | undefined;
  private pending: Promise<void> | undefined;
  private recording: ControlCaptureLease | undefined;
  private readonly leases = new Set<ControlCaptureLease>();
  private closing = false;
  private unsubscribe: (() => Promise<void>) | undefined;
  private closeTask: Promise<void> | undefined;
  private constructor(private readonly bus: ControlBus, private readonly capture: ControlCapturePort, private readonly kind: ControlKind) {}

  static async create(bus: ControlBus, capture: ControlCapturePort, kind: ControlKind = "development"): Promise<DevControlService> {
    const target = controlTarget(kind);
    const service = new DevControlService(bus, capture, kind);
    try {
      // Subscribe before authentication/export so a caller cannot disappear unnoticed.
      service.unsubscribe = await bus.subscribe({ sender: daemon, path: "/org/freedesktop/DBus",
        interface: daemon, member: "NameOwnerChanged" }, (event) => { service.ownerChanged(event); });
      await bus.exportControl((event) => { service.receive(event); }, kind);
      const reply = await bus.call({ destination: daemon, path: "/org/freedesktop/DBus", interface: daemon,
        member: "RequestName", inputSignature: "su", outputSignature: "u",
        body: [{ type: "s", value: target.name }, { type: "u", value: 4 }], timeoutMs: 1000 });
      const acquired = reply.body[0];
      if (acquired?.type !== "u" || acquired.value !== 1 || reply.body.length !== 1 || bus.isClosed) throw new ControlServiceError("START_FAILED");
      return service;
    } catch {
      await service.close(); throw new ControlServiceError("START_FAILED");
    }
  }

  private ownerChanged(event: BusEvent): void {
    if (this.closing || event.connection !== this.bus.generation || event.kind !== "signal" ||
      event.sender !== daemon || event.path !== "/org/freedesktop/DBus" || event.interface !== daemon ||
      event.member !== "NameOwnerChanged" || event.signature !== "sss" || event.body.length !== 3) return;
    const [name, before, after] = event.body;
    if (name?.type !== "s" || before?.type !== "s" || after?.type !== "s") return;
    if (this.active && name.value === this.active.event.sender && before.value === name.value && after.value === "") {
      this.active.cancellation.abort();
    }
  }

  private receive(event: BusEvent): void {
    if (this.closing || this.bus.isClosed) return;
    if (event.kind !== "method" || event.connection !== this.bus.generation || event.path !== controlTarget(this.kind).path ||
      event.interface !== "io.github.whisperfree.Control1" ||
      !((event.member === "Status" && event.signature === "" && event.body.length === 0) ||
        (event.member === "Execute" && event.signature === "s" && event.body.length === 1))) {
      void this.refuse(event.id, "InvalidRequest"); return;
    }
    if (this.active) { void this.refuse(event.id, "Busy"); return; }
    if (!this.bus.controlCurrent(event) || event.expiresAtUs === undefined) { void this.refuse(event.id, "Expired"); return; }
    const remaining = Number((BigInt(event.expiresAtUs) - process.hrtime.bigint() / 1000n + 999n) / 1000n);
    const cancellation = new AbortController();
    const timer = setTimeout(() => { cancellation.abort(); }, Math.max(1, Math.min(3000, remaining)));
    const transaction: Transaction = { id: randomUUID(), epoch: this.epoch, event, cancellation, timer };
    this.active = transaction;
    const task = this.execute(transaction).catch(async (error: unknown) => {
      const category: Refusal = error instanceof BusFailure && error.code === "DENIED" ? "Denied" :
        error instanceof BusFailure && error.code === "EXPIRED" ? "Expired" : "Unavailable";
      await this.refuse(event.id, category);
    }).finally(() => {
      clearTimeout(timer);
      if (this.active?.id === transaction.id) this.active = undefined;
      if (this.pending === task) this.pending = undefined;
    });
    this.pending = task;
  }

  private current(transaction: Transaction): void {
    if (this.closing || this.bus.isClosed || this.active?.id !== transaction.id || transaction.epoch !== this.epoch ||
      transaction.cancellation.signal.aborted || !this.bus.controlCurrent(transaction.event)) throw new BusFailure("EXPIRED");
  }
  private async refuse(id: string, category: Refusal): Promise<void> {
    try { await this.bus.reject(id, category); } catch { /* An expired/disconnected invocation has no safe reply target. */ }
  }
  private async rollback(lease: ControlCaptureLease): Promise<void> {
    await lease.cancel(); this.leases.delete(lease);
    if (this.recording === lease) this.recording = undefined;
  }

  private async replyStatus(transaction: Transaction): Promise<void> {
    this.current(transaction);
    if (!this.capture.wireStatus) throw new BusFailure("TRANSPORT_FAILED");
    const status = serializeControlStatus(await this.capture.wireStatus());
    this.current(transaction);
    await this.bus.reply(transaction.event.id, status);
  }

  private async execute(transaction: Transaction): Promise<void> {
    this.current(transaction);
    await this.bus.authorizeControl(transaction.event);
    this.current(transaction);
    const status = controlStatusSchema.parse(await this.capture.status());
    this.current(transaction);
    if (transaction.event.member === "Status") {
      await this.replyStatus(transaction); return;
    }
    const argument = transaction.event.body[0];
    const parsed = controlActionSchema.safeParse(argument?.type === "s" ? argument.value : undefined);
    if (!parsed.success) { await this.refuse(transaction.event.id, "InvalidRequest"); return; }
    if (status === "unavailable") { await this.refuse(transaction.event.id, "Unavailable"); return; }
    if (status === "transcribing") { await this.refuse(transaction.event.id, "Busy"); return; }
    const action = parsed.data === "toggle" ? status === "recording" ? "stop" : "start" : parsed.data;
    this.current(transaction);
    if (action === "start") {
      if (status === "recording") { await this.replyStatus(transaction); return; }
      let acquired: ControlCaptureLease | undefined;
      try {
        acquired = await this.capture.start(transaction.cancellation.signal);
        this.leases.add(acquired);
        this.current(transaction);
        await this.replyStatus(transaction);
        // Native acceptance is the commit point. A normal CLI can receive its
        // reply and disconnect before this Promise's completion reaches Node.
        this.recording = acquired;
      } catch (error: unknown) {
        if (acquired) await this.rollback(acquired);
        throw error;
      }
      return;
    }
    if (status === "recording") {
      const lease = this.capture.currentLease ? await this.capture.currentLease() : this.recording;
      this.current(transaction);
      if (!lease) throw new BusFailure("TRANSPORT_FAILED");
      // Stop/cancel finish their owned closure even if the caller subsequently leaves.
      if (action === "stop") await lease.stop(); else await lease.cancel();
      this.leases.delete(lease); this.recording = undefined;
      this.current(transaction);
    }
    this.current(transaction);
    await this.replyStatus(transaction);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.active?.cancellation.abort();
    const pending = this.pending;
    this.closeTask = (async () => {
      const results = await Promise.allSettled([this.unsubscribe?.() ?? Promise.resolve(), this.bus.close()]);
      if (pending) await pending;
      const leases = await Promise.allSettled([...this.leases].map((lease) => this.rollback(lease)));
      if ([...results, ...leases].some((result) => result.status === "rejected")) throw new ControlServiceError("TEARDOWN_FAILED");
    })();
    const disposal = this.closeTask;
    this.closeTask = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { reject(new ControlServiceError("TEARDOWN_FAILED")); }, 2000);
      disposal.then(accept, () => { reject(new ControlServiceError("TEARDOWN_FAILED")); }).finally(() => { clearTimeout(timer); });
    });
    return this.closeTask;
  }
}

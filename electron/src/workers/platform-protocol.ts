import { z } from "zod";
import { randomUUID } from "node:crypto";
import { controlStatusSchema, ControlCaptureLeaseError, type ControlCaptureLease, type ControlCapturePort, type ControlStatus } from "../platforms/linux/shared/control.js";
import { developmentArtifactSchema } from "../services/development-artifact.js";
import { linuxApplicationIdSchema, portalShortcutStateSchema } from "../platforms/linux/shared/portal-shortcuts.js";
import { kdeKeySchema } from "../platforms/linux/kde/keyboard.js";
import { portalPasteStateSchema } from "../platforms/linux/shared/portal-paste.js";

const envelope = { version: z.literal(1), id: z.uuid() };
const address = z.string().max(1024).regex(/^unix:(?:path=\/[A-Za-z0-9_./%\-]+|abstract=[A-Za-z0-9_./%\-]+)(?:,guid=[a-fA-F0-9]{32})?$/);
export const platformRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...envelope, command: z.literal("initialize"), address,
    appId: linuxApplicationIdSchema.optional(),
    kdeLeasePath: z.string().min(1).max(4096).regex(/^\//).optional(),
    captureBridge: z.strictObject({ epoch: z.uuid(), native: developmentArtifactSchema }).optional() }),
  z.strictObject({ ...envelope, command: z.literal("status") }),
  z.strictObject({ ...envelope, command: z.literal("shortcut"), action: z.enum(["enable", "configure", "clear", "cancel", "mode"]), hold: z.boolean() }),
  z.strictObject({ ...envelope, command: z.literal("bind-key"), key: kdeKeySchema, hold: z.boolean() }),
  z.strictObject({ ...envelope, command: z.literal("prepare-key"), windowId: z.int().min(1).max(0xffffffff).optional(), hold: z.boolean().optional() }),
  z.strictObject({ ...envelope, command: z.literal("paste-permission"), action: z.enum(["enable", "clear"]) }),
  z.strictObject({ ...envelope, command: z.literal("paste") }),
  z.strictObject({ ...envelope, command: z.literal("shutdown") }),
]);
export const platformReadySchema = z.strictObject({ version: z.literal(1), type: z.literal("ready") });
export const platformShortcutEventSchema = z.strictObject({ version: z.literal(1), type: z.literal("shortcuts"), state: portalShortcutStateSchema });
export const platformPasteEventSchema = z.strictObject({ version: z.literal(1), type: z.literal("paste-state"), state: portalPasteStateSchema });
export const platformFailureEventSchema = z.strictObject({ version: z.literal(1), type: z.literal("failure"), code: z.literal("TEARDOWN_FAILED") });
export const platformReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...envelope, ok: z.literal(true), value: z.union([
    z.strictObject({ command: z.literal("initialize"), generation: z.uuid(), captureAvailable: z.boolean() }),
    z.strictObject({ command: z.literal("status"), status: controlStatusSchema }),
    z.strictObject({ command: z.literal("shortcut"), state: portalShortcutStateSchema }),
    z.strictObject({ command: z.literal("bind-key"), state: portalShortcutStateSchema }),
    z.strictObject({ command: z.literal("prepare-key"), state: portalShortcutStateSchema }),
    z.strictObject({ command: z.literal("paste-permission"), state: portalPasteStateSchema }),
    z.strictObject({ command: z.literal("paste"), accepted: z.boolean() }),
    z.strictObject({ command: z.literal("shutdown") }),
  ]) }),
  z.strictObject({ ...envelope, ok: z.literal(false), code: z.enum(["UNAVAILABLE", "BUSY", "INVALID_FRAME", "TEARDOWN_FAILED"]) }),
]);
export type PlatformRequest = z.infer<typeof platformRequestSchema>;
export type PlatformReply = z.infer<typeof platformReplySchema>;

const captureEnvelope = { ...envelope, channel: z.literal("platform-capture"), epoch: z.uuid() };
export const platformCaptureRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...captureEnvelope, command: z.literal("status") }),
  z.strictObject({ ...captureEnvelope, command: z.literal("start") }),
  z.strictObject({ ...captureEnvelope, command: z.literal("lease") }),
  z.strictObject({ ...captureEnvelope, command: z.literal("stop"), lease: z.uuid() }),
  z.strictObject({ ...captureEnvelope, command: z.literal("cancel"), lease: z.uuid() }),
  z.strictObject({ ...captureEnvelope, command: z.literal("abort-start"), target: z.uuid() }),
]);
export const platformCaptureReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...captureEnvelope, ok: z.literal(true), value: z.union([
    z.strictObject({ command: z.literal("status"), status: controlStatusSchema }),
    z.strictObject({ command: z.literal("start"), lease: z.uuid() }),
    z.strictObject({ command: z.literal("lease"), lease: z.uuid().nullable() }),
    ...(["stop", "cancel", "abort-start"] as const).map((command) => z.strictObject({ command: z.literal(command) })),
  ]) }),
  z.strictObject({ ...captureEnvelope, ok: z.literal(false), code: z.enum(["BUSY", "CANCELLED", "UNAVAILABLE", "INVALID_FRAME", "TEARDOWN_FAILED", "STALE_LEASE"]) }),
]);
export type PlatformCaptureRequest = z.infer<typeof platformCaptureRequestSchema>;
export type PlatformCaptureReply = z.infer<typeof platformCaptureReplySchema>;

export class PlatformCaptureError extends Error {
  constructor(readonly code: "BUSY" | "CANCELLED" | "UNAVAILABLE" | "INVALID_FRAME" | "TEARDOWN_FAILED" | "STALE_LEASE") { super(code); }
}
/** Worker-only content-free capture RPC. Paths, samples and transcripts are never accepted. */
export class PlatformCaptureClient implements ControlCapturePort {
  private readonly leases = new Map<string, ControlCaptureLease>();
  private readonly pending = new Map<string, { command: PlatformCaptureRequest["command"]; timer: NodeJS.Timeout;
    accept: (reply: PlatformCaptureReply) => void; reject: (error: PlatformCaptureError) => void }>();
  private closed = false;
  constructor(private readonly epoch: string, private readonly send: (request: PlatformCaptureRequest) => void,
    private readonly timeoutMs = 5000) { z.uuid().parse(epoch); }
  receive(input: unknown): void {
    boundPlatformFrame(input); const reply = platformCaptureReplySchema.parse(input);
    if (reply.epoch !== this.epoch) throw new PlatformCaptureError("INVALID_FRAME");
    const pending = this.pending.get(reply.id);
    if (!pending || (reply.ok && reply.value.command !== pending.command)) throw new PlatformCaptureError("INVALID_FRAME");
    this.pending.delete(reply.id); clearTimeout(pending.timer);
    if (reply.ok) pending.accept(reply); else pending.reject(new PlatformCaptureError(reply.code));
  }
  private begin(input: unknown): { id: string; result: Promise<PlatformCaptureReply> } {
    if (this.closed) throw new PlatformCaptureError("UNAVAILABLE");
    if (this.pending.size >= 4) throw new PlatformCaptureError("BUSY");
    const id = randomUUID(), request = platformCaptureRequestSchema.parse({ version: 1, channel: "platform-capture", epoch: this.epoch, id,
      ...(typeof input === "object" && input !== null ? input : {}) });
    const result = new Promise<PlatformCaptureReply>((accept, reject) => {
      const timer = setTimeout(() => { this.close(); }, this.timeoutMs);
      this.pending.set(id, { command: request.command, timer, accept, reject });
      try { this.send(request); } catch { this.pending.delete(id); clearTimeout(timer); reject(new PlatformCaptureError("TEARDOWN_FAILED")); }
    });
    void result.catch(() => {}); return { id, result };
  }
  private lease(id: string): ControlCaptureLease {
    const existing = this.leases.get(id); if (existing) return existing;
    if (this.leases.size >= 16) throw new PlatformCaptureError("BUSY");
    let terminal: Promise<void> | undefined;
    const finish = (command: "stop" | "cancel"): Promise<void> => {
      terminal ??= this.begin({ command, lease: id }).result.then(() => { this.leases.delete(id); }).catch((error: unknown) => {
        // Only a verified owner change allows safe cleanup of this old reference.
        // Native terminal failures keep their rejected original promise.
        if (error instanceof PlatformCaptureError && error.code === "STALE_LEASE") {
          terminal = undefined; throw new ControlCaptureLeaseError();
        }
        throw error;
      });
      return terminal;
    };
    const lease = Object.freeze({ stop: () => finish("stop"), cancel: () => finish("cancel") });
    this.leases.set(id, lease); return lease;
  }
  async status(): Promise<ControlStatus> {
    const reply = await this.begin({ command: "status" }).result;
    if (!reply.ok || reply.value.command !== "status") throw new PlatformCaptureError("INVALID_FRAME");
    return reply.value.status;
  }
  async currentLease(): Promise<ControlCaptureLease | undefined> {
    const reply = await this.begin({ command: "lease" }).result;
    if (!reply.ok || reply.value.command !== "lease") throw new PlatformCaptureError("INVALID_FRAME");
    return reply.value.lease ? this.lease(reply.value.lease) : undefined;
  }
  async start(signal: AbortSignal): Promise<ControlCaptureLease> {
    if (signal.aborted) throw new PlatformCaptureError("CANCELLED");
    const operation = this.begin({ command: "start" });
    const abort = (): void => { try { void this.begin({ command: "abort-start", target: operation.id }).result.catch(() => {}); } catch { /* Main still retains the original start. */ } };
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    try {
      const reply = await operation.result;
      if (!reply.ok || reply.value.command !== "start") throw new PlatformCaptureError("INVALID_FRAME");
      const lease = this.lease(reply.value.lease);
      if (signal.aborted) { await lease.cancel(); throw new PlatformCaptureError("CANCELLED"); }
      return lease;
    } finally { signal.removeEventListener("abort", abort); }
  }
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new PlatformCaptureError("TEARDOWN_FAILED")); }
    this.pending.clear();
  }
}

/** Finite content-free helper frames; reject accessors/objects before parsing. */
export function boundPlatformFrame(input: unknown): void {
  const queue: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (queue.length > 0) {
    const item = queue.pop(); if (!item || ++nodes > 64 || item.depth > 4) throw new Error("Invalid platform frame.");
    const value = item.value;
    if (typeof value === "string") { if (Buffer.byteLength(value, "utf8") > 2048) throw new Error("Invalid platform frame."); }
    else if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Invalid platform frame."); }
    else if (value !== null && typeof value === "object") {
      if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid platform frame.");
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || key.length > 64) throw new Error("Invalid platform frame.");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("Invalid platform frame.");
        const child: unknown = descriptor.value;
        queue.push({ value: child, depth: item.depth + 1 });
      }
    } else if (typeof value !== "boolean" && value !== null) throw new Error("Invalid platform frame.");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 8192) throw new Error("Invalid platform frame.");
}

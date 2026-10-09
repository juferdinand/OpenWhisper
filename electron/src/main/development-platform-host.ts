import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { developmentArtifactSchema } from "../services/development-artifact.js";
import { controlStatusSchema, ControlCaptureLeaseError, type ControlCaptureLease, type ControlCapturePort, type ControlStatus } from "../core/recording-control.js";
import { boundPlatformFrame, platformCaptureRequestSchema, platformCaptureReplySchema,
  type PlatformCaptureRequest, type PlatformCaptureReply } from "../workers/platform-protocol.js";
import { createUtilityPlatformChannelFactory, PlatformChannelError, type PlatformChannel } from "./platform-channel.js";
import { linuxApplicationIdSchema, type LinuxApplicationId, type PortalShortcutState } from "../platforms/linux/shared/portal-shortcuts.js";
import type { PortalPasteState } from "../platforms/linux/shared/portal-paste.js";
import { serializeControlStatus } from "../platforms/linux/shared/control-status.js";

export const developmentPlatformHostDescriptorSchema = z.strictObject({
  root: z.string().min(1).refine((path) => isAbsolute(path) && resolve(path) === path && !path.includes("\0")),
  entry: developmentArtifactSchema, bus: developmentArtifactSchema,
}).readonly();
export type DevelopmentPlatformDescriptor = z.infer<typeof developmentPlatformHostDescriptorSchema>;
type StartOwner = { readonly id: string; readonly controller: AbortController; readonly completion: Promise<PlatformCaptureReply> };

/** Main owns original capture leases. An opaque worker token can never select a later GUI owner. */
export class DevelopmentPlatformCaptureBridge {
  readonly epoch = randomUUID();
  private readonly leases = new Map<string, ControlCaptureLease>();
  private readonly terminal = new Map<string, Promise<void>>();
  private readonly operations = new Set<Promise<PlatformCaptureReply>>();
  private starting: StartOwner | undefined;
  private closing = false;
  private fatal = false;
  private closeTask: Promise<void> | undefined;
  constructor(private readonly capture: ControlCapturePort) {}
  private failed(request: PlatformCaptureRequest, code: Extract<PlatformCaptureReply, { ok: false }>["code"]): PlatformCaptureReply {
    return { version: 1, channel: "platform-capture", epoch: this.epoch, id: request.id, ok: false, code };
  }
  private success(request: PlatformCaptureRequest, value: Extract<PlatformCaptureReply, { ok: true }>["value"]): PlatformCaptureReply {
    return platformCaptureReplySchema.parse({ version: 1, channel: "platform-capture", epoch: this.epoch, id: request.id, ok: true, value });
  }
  private remember(lease: ControlCaptureLease): string {
    for (const [id, existing] of this.leases) if (existing === lease) return id;
    const id = randomUUID(); this.leases.set(id, lease); return id;
  }
  private finish(id: string, lease: ControlCaptureLease, command: "stop" | "cancel"): Promise<void> {
    let operation = this.terminal.get(id);
    if (!operation) {
      operation = Promise.resolve().then(() => command === "stop" ? lease.stop() : lease.cancel());
      this.terminal.set(id, operation); void operation.catch(() => {});
    }
    return operation.then(() => { this.leases.delete(id); this.terminal.delete(id); }, (error: unknown) => {
      // The immutable main lease distinguishes a guard-only refusal from an
      // invoked native terminal failure. Its original promise remains authority.
      if (this.terminal.get(id) === operation) this.terminal.delete(id);
      throw error;
    });
  }
  handle(input: unknown): Promise<PlatformCaptureReply> {
    boundPlatformFrame(input); const request = platformCaptureRequestSchema.parse(input);
    if (request.epoch !== this.epoch) return Promise.resolve(this.failed(request, "INVALID_FRAME"));
    if (this.fatal) return Promise.resolve(this.failed(request, "TEARDOWN_FAILED"));
    if (this.closing) return Promise.resolve(this.failed(request, "UNAVAILABLE"));
    if (request.command === "start") return this.start(request);
    const operation = Promise.resolve().then(async () => {
      switch (request.command) {
        case "status": return this.success(request, { command: "status", status: controlStatusSchema.parse(await this.capture.status()) });
        case "wire-status": {
          if (!this.capture.wireStatus) return this.failed(request, "UNAVAILABLE");
          return this.success(request, { command: "wire-status", text: serializeControlStatus(await this.capture.wireStatus()) });
        }
        case "lease": {
          const lease = await this.capture.currentLease?.();
          if (this.closing) return this.failed(request, "UNAVAILABLE");
          return this.success(request, { command: "lease", lease: lease ? this.remember(lease) : null });
        }
        case "abort-start": {
          const start = this.starting;
          if (start?.id === request.target) { start.controller.abort(); await start.completion; }
          return this.success(request, { command: "abort-start" });
        }
        case "stop": case "cancel": {
          const lease = this.leases.get(request.lease);
          if (!lease) return this.failed(request, "UNAVAILABLE");
          // The original immutable lease performs its own generation check under
          // the normal main recording transaction; no status-based retargeting.
          await this.finish(request.lease, lease, request.command);
          return this.success(request, { command: request.command });
        }
      }
    }).catch((error: unknown) => this.failed(request, error instanceof ControlCaptureLeaseError ? "STALE_LEASE" : "UNAVAILABLE"));
    return this.retain(operation);
  }
  private retain(operation: Promise<PlatformCaptureReply>): Promise<PlatformCaptureReply> {
    this.operations.add(operation);
    void operation.finally(() => { this.operations.delete(operation); });
    return operation;
  }
  private start(request: Extract<PlatformCaptureRequest, { command: "start" }>): Promise<PlatformCaptureReply> {
    if (this.starting) return Promise.resolve(this.failed(request, "BUSY"));
    const controller = new AbortController();
    const completion = Promise.resolve().then(async () => {
      let acquired: ControlCaptureLease | undefined;
      let acquiredId: string | undefined;
      try {
        acquired = await this.capture.start(controller.signal);
        acquiredId = this.remember(acquired);
        if (controller.signal.aborted || this.closing) {
          await this.finish(acquiredId, acquired, "cancel"); acquired = undefined;
          return this.failed(request, "CANCELLED");
        }
        const lease = acquiredId; acquired = undefined;
        return this.success(request, { command: "start", lease });
      } catch {
        if (acquired) {
          try {
            if (!acquiredId) acquiredId = this.remember(acquired);
            await this.finish(acquiredId, acquired, "cancel");
          }
          catch { this.fatal = true; return this.failed(request, "TEARDOWN_FAILED"); }
        }
        return this.failed(request, controller.signal.aborted ? "CANCELLED" : "UNAVAILABLE");
      } finally { if (this.starting?.id === request.id) this.starting = undefined; }
    });
    this.starting = { id: request.id, controller, completion }; return this.retain(completion);
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.starting?.controller.abort();
    this.closeTask = Promise.resolve().then(async () => {
      await Promise.all(this.operations);
      const results = await Promise.allSettled([...this.leases].map(async ([id, lease]) => {
        await this.finish(id, lease, "cancel");
      }));
      if (this.fatal || results.some((result) => result.status === "rejected")) throw new PlatformChannelError("TEARDOWN_FAILED");
    });
    void this.closeTask.catch(() => {}); return this.closeTask;
  }
}

/** Explicit Linux recording-build service only. Preview imports do not fork or open a bus. */
export class DevelopmentPlatformHost {
  private closeTask: Promise<void> | undefined;
  private constructor(private readonly bridge: DevelopmentPlatformCaptureBridge, private readonly channel: PlatformChannel) {}
  static async open(options: { descriptor: DevelopmentPlatformDescriptor; address: string; capture: ControlCapturePort;
    shortcuts?: (state: PortalShortcutState) => void; paste?: (state: PortalPasteState) => void; kdeLeasePath?: string; appId?: LinuxApplicationId },
    signal: AbortSignal): Promise<DevelopmentPlatformHost> {
    const descriptor = developmentPlatformHostDescriptorSchema.parse(options.descriptor);
    const appId = options.appId === undefined ? undefined : linuxApplicationIdSchema.parse(options.appId);
    const bridge = new DevelopmentPlatformCaptureBridge(options.capture);
    const factory = createUtilityPlatformChannelFactory({ artifacts: descriptor, capture: (request) => bridge.handle(request),
      ...(options.shortcuts ? { shortcuts: options.shortcuts } : {}), ...(options.paste ? { paste: options.paste } : {}) });
    let channel: PlatformChannel | undefined;
    try {
      channel = await factory(signal);
      const reply = await channel.request({ version: 1, id: randomUUID(), command: "initialize", address: options.address,
        ...(appId === undefined ? {} : { appId }),
        ...(options.kdeLeasePath ? { kdeLeasePath: options.kdeLeasePath } : {}),
        captureBridge: { epoch: bridge.epoch, native: descriptor.bus } });
      if (!reply.ok || reply.value.command !== "initialize" || !reply.value.captureAvailable) throw new PlatformChannelError("UNAVAILABLE");
      return new DevelopmentPlatformHost(bridge, channel);
    } catch (error: unknown) {
      await bridge.close(); await channel?.close(); throw error;
    }
  }
  async status(): Promise<ControlStatus> {
    const reply = await this.channel.request({ version: 1, id: randomUUID(), command: "status" });
    if (!reply.ok || reply.value.command !== "status") throw new PlatformChannelError("INVALID_FRAME");
    return reply.value.status;
  }
  async shortcut(action: "enable" | "configure" | "clear" | "cancel" | "mode", hold: boolean): Promise<void> {
    const reply = await this.channel.request({ version: 1, id: randomUUID(), command: "shortcut", action, hold });
    if (!reply.ok || reply.value.command !== "shortcut") throw new PlatformChannelError("INVALID_FRAME");
  }
  async bindKey(key: number, hold: boolean): Promise<void> {
    const reply = await this.channel.request({ version: 1, id: randomUUID(), command: "bind-key", key, hold });
    if (!reply.ok || reply.value.command !== "bind-key") throw new PlatformChannelError("INVALID_FRAME");
  }
  async prepareKeyCapture(windowId?: number, hold?: boolean): Promise<void> {
    const reply = await this.channel.request({ version: 1, id: randomUUID(), command: "prepare-key",
      ...(windowId === undefined ? {} : { windowId }), ...(hold === undefined ? {} : { hold }) });
    if (!reply.ok || reply.value.command !== "prepare-key") throw new PlatformChannelError("INVALID_FRAME");
  }
  async pastePermission(action: "enable" | "clear"): Promise<void> {
    const reply = await this.channel.request({ version: 1, id: randomUUID(), command: "paste-permission", action });
    if (!reply.ok || reply.value.command !== "paste-permission") throw new PlatformChannelError("INVALID_FRAME");
  }
  async paste(): Promise<boolean> {
    const reply = await this.channel.request({ version: 1, id: randomUUID(), command: "paste" });
    if (!reply.ok || reply.value.command !== "paste") throw new PlatformChannelError("INVALID_FRAME");
    return reply.value.accepted;
  }
  close(): Promise<void> {
    this.closeTask ??= Promise.resolve().then(async () => {
      // The utility first closes its portal/CLI leases while capture RPC is live.
      // Main then retires any acquisitions left by a failed or killed utility.
      try { await this.channel.close(); } finally { await this.bridge.close(); }
    });
    return this.closeTask;
  }
}

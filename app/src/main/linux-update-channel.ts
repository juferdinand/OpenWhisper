import { Duplex } from "node:stream";
import { fstatSync, readlinkSync } from "node:fs";
import { Socket } from "node:net";
import { z } from "zod";
import { isNewerUpdateVersion, parseUpdateVersion } from "../services/update/common/update-policy.js";
import { LINUX_RESTART_NONCE, LINUX_RESTART_VERSION } from "./linux-restart.js";

export const LINUX_UPDATE_PROTOCOL = "OPENWHISPER_UPDATE_PROTOCOL";
export const LINUX_UPDATE_CHANNEL_FRAME_BYTES = 1024;
const canonicalVersion = z.string().max(62).refine((value) => { try { parseUpdateVersion(value); return true; } catch { return false; } });
const bindingSchema = z.strictObject({ currentVersion: canonicalVersion, nonce: z.string().regex(/^[a-f0-9]{64}$/u) });
export type LinuxUpdateChannelBinding = z.infer<typeof bindingSchema>;
const envelope = { version: z.literal(2), ...bindingSchema.shape };
const linuxUpdateCommandSchema = z.strictObject({ ...envelope, type: z.enum(["check", "install", "cancel", "retired"]) });
const linuxUpdatePublicStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.enum(["idle", "checking", "preparing"]) }),
  z.strictObject({ status: z.enum(["available", "prepared"]), updateVersion: canonicalVersion }),
  z.strictObject({ status: z.literal("failed"), code: z.enum(["UNAVAILABLE", "CANCELLED", "FAILED"]) }),
]);
export type LinuxUpdatePublicState = z.infer<typeof linuxUpdatePublicStateSchema>;
const linuxUpdateResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("state"), state: linuxUpdatePublicStateSchema }),
  z.strictObject({ ...envelope, type: z.literal("retire"), updateVersion: canonicalVersion }),
]);
export type LinuxUpdateResponse = z.infer<typeof linuxUpdateResponseSchema>;
class LinuxUpdateChannelError extends Error {
  constructor(readonly code: "INVALID_FRAME" | "INVALID_STATE" | "CHANNEL_FAILED") { super(code); this.name = "LinuxUpdateChannelError"; }
}
const failure = (code: LinuxUpdateChannelError["code"]): never => { throw new LinuxUpdateChannelError(code); };

/** The caller supplies its original anonymous duplex; no path, inherited-FD discovery or application effects occur here. */
function transport(pipe: Duplex, binding: LinuxUpdateChannelBinding, receive: (input: unknown) => void, interrupted: () => void) {
  try { binding = bindingSchema.parse(binding); } catch { return failure("INVALID_FRAME"); }
  let buffer = Buffer.alloc(0), ended = false, closed = false, poisoned = false;
  let finish!: () => void;
  const closure = new Promise<void>((accept) => { finish = accept; });
  const poison = (): void => { if (poisoned) return; poisoned = true; interrupted(); pipe.destroy(); };
  const data = (input: unknown): void => {
    if (poisoned || ended) { poison(); return; }
    if (!(input instanceof Uint8Array)) { poison(); return; }
    for (let offset = 0; offset < input.length;) {
      const remaining = input.subarray(offset), newline = remaining.indexOf(10);
      const length = newline < 0 ? remaining.length : newline + 1;
      if (length > LINUX_UPDATE_CHANNEL_FRAME_BYTES - buffer.length) { poison(); return; }
      buffer = Buffer.concat([buffer, remaining.subarray(0, length)]); offset += length;
      if (newline >= 0) {
        try {
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, -1)));
          const context = z.object(envelope).parse(value);
          if (context.currentVersion !== binding.currentVersion || context.nonce !== binding.nonce) return poison();
          buffer = Buffer.alloc(0); receive(value);
        } catch { poison(); return; }
        if (poisoned) return;
      }
    }
  };
  const end = (): void => { ended = true; if (buffer.length) poison(); interrupted(); pipe.end(); };
  const error = (): void => { poison(); };
  const close = (): void => {
    closed = true; if (!ended) poisoned = true; interrupted();
    pipe.off("data", data); pipe.off("end", end); pipe.off("error", error); finish();
  };
  pipe.on("data", data); pipe.once("end", end); pipe.on("error", error); pipe.once("close", close);
  return {
    binding, closure, poison,
    valid: (): boolean => !poisoned && !closed && !ended,
    cleanClosed: (): boolean => closed && ended && pipe.writableFinished && !poisoned,
    send(value: unknown): Promise<void> {
      if (!this.valid()) return Promise.reject(new LinuxUpdateChannelError("CHANNEL_FAILED"));
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      if (bytes.length > LINUX_UPDATE_CHANNEL_FRAME_BYTES) return Promise.reject(new LinuxUpdateChannelError("INVALID_FRAME"));
      return new Promise((accept, reject) => {
        let settled = false;
        const complete = (success: boolean): void => {
          if (settled) return; settled = true; pipe.off("close", interruptedWrite);
          if (success) accept(); else { poison(); reject(new LinuxUpdateChannelError("CHANNEL_FAILED")); }
        };
        // Backpressure may hold the callback even after the original duplex has fully closed.
        const interruptedWrite = (): void => { complete(ended && pipe.writableFinished && !poisoned); };
        pipe.once("close", interruptedWrite);
        try { pipe.write(bytes, (cause?: Error | null) => { complete(!cause && !poisoned); }); }
        catch { complete(false); }
      });
    },
    end: (): void => { pipe.end(); },
    close: async (): Promise<void> => { poison(); await closure; },
  };
}

export interface LinuxUpdateParentChannel {
  /** No installation authority: the caller alone owns verified feed/download/consumer state. */
  requestRetirement(): Promise<void>;
  /** Resolves only after the original full duplex closes; GUI/process/native close remains caller-owned. */
  readonly retirement: Promise<Readonly<{ updateVersion: string }> | undefined>;
  close(): Promise<void>;
}
export function createLinuxUpdateParentChannel(pipe: Duplex, binding: LinuxUpdateChannelBinding,
  action: (kind: "check" | "install", signal: AbortSignal) => Promise<LinuxUpdatePublicState>,
  onPreparedPublished?: () => void): LinuxUpdateParentChannel {
  let pending: Promise<void> | undefined, cancellation: AbortController | undefined, cancelled = false;
  const accepted = new Set<Promise<void>>();
  let state: LinuxUpdatePublicState = { status: "idle" }, retireVersion: string | undefined, retired = false;
  const wire = transport(pipe, binding, (value) => {
    const message = linuxUpdateCommandSchema.parse(value);
    if (message.type === "retired") {
      if (!retireVersion || retired || pending) return wire.poison(); retired = true; return;
    }
    if (retireVersion || retired) return wire.poison();
    if (message.type === "cancel") {
      if (!pending || cancelled) return wire.poison(); cancelled = true; cancellation!.abort(); return;
    }
    if (pending) return wire.poison();
    const controller = new AbortController(); cancellation = controller; cancelled = false;
    state = { status: message.type === "check" ? "checking" : "preparing" };
    const operation = Promise.resolve().then(async () => {
      await wire.send({ version: 2, ...wire.binding, type: "state", state });
      if (!wire.valid()) return;
      let result: LinuxUpdatePublicState;
      try { result = controller.signal.aborted ? { status: "failed", code: "CANCELLED" }
        : linuxUpdatePublicStateSchema.parse(await action(message.type as "check" | "install", controller.signal)); }
      catch { result = { status: "failed", code: "FAILED" }; }
      if (!wire.valid()) return;
      if (controller.signal.aborted) result = { status: "failed", code: "CANCELLED" };
      if ("updateVersion" in result && !isNewerUpdateVersion(result.updateVersion, wire.binding.currentVersion)) return wire.poison();
      if (result.status === "checking" || result.status === "preparing" ||
          (message.type === "check" && result.status === "prepared") || (message.type === "install" && result.status === "available")) return wire.poison();
      state = result;
      // The original action has settled. A GUI callback may immediately send its next command.
      if (pending === operation) { pending = undefined; cancellation = undefined; }
      await wire.send({ version: 2, ...wire.binding, type: "state", state });
      if (result.status === "prepared" && wire.valid()) onPreparedPublished?.();
    });
    pending = operation; accepted.add(operation);
    void operation.catch(() => { wire.poison(); }).finally(() => {
      accepted.delete(operation);
      if (pending === operation) { pending = undefined; cancellation = undefined; }
    });
  }, () => { cancellation?.abort(); });
  const settleAccepted = async (): Promise<void> => { await Promise.allSettled([...accepted]); };
  const settled = async (): Promise<void> => { await wire.closure; await settleAccepted(); };
  const retirement = settled().then(() => {
    if (!wire.cleanClosed()) return failure("CHANNEL_FAILED");
    if (retireVersion && !retired) return failure("INVALID_STATE");
    return retired && retireVersion ? Object.freeze({ updateVersion: retireVersion }) : undefined;
  }); void retirement.catch(() => {});
  return Object.freeze({ retirement,
    async requestRetirement(): Promise<void> {
      if (retireVersion || state.status !== "prepared") return failure("INVALID_STATE");
      await pending;
      if (!wire.valid() || retireVersion || state.status !== "prepared") return failure("INVALID_STATE");
      retireVersion = state.updateVersion;
      await wire.send({ version: 2, ...wire.binding, type: "retire", updateVersion: retireVersion });
    },
    async close(): Promise<void> { await wire.close(); await settleAccepted(); },
  });
}

export interface LinuxUpdateGuiChannel {
  request(kind: "check" | "install" | "cancel"): Promise<void>;
  /** Requires original readable EOF, writable completion and close; poisoning rejects. */
  readonly closed: Promise<void>;
  /** Caller must finish original native cleanup before this acknowledgment; original GUI close is still required. */
  acknowledgeRetired(): Promise<void>;
  quit(): void;
  close(): Promise<void>;
}
export function createLinuxUpdateGuiChannel(pipe: Duplex, binding: LinuxUpdateChannelBinding,
  receive: (response: LinuxUpdateResponse) => void): LinuxUpdateGuiChannel {
  let pending: "check" | "install" | undefined, cancelled = false, preparedVersion: string | undefined;
  let retireVersion: string | undefined, acknowledged = false;
  const wire = transport(pipe, binding, (value) => {
    const response = linuxUpdateResponseSchema.parse(value);
    if ("updateVersion" in response && !isNewerUpdateVersion(response.updateVersion, wire.binding.currentVersion)) return wire.poison();
    if (response.type === "retire") {
      if (pending || retireVersion || preparedVersion !== response.updateVersion) return wire.poison(); retireVersion = response.updateVersion;
    } else {
      if (retireVersion || !pending) return wire.poison();
      if ("updateVersion" in response.state && !isNewerUpdateVersion(response.state.updateVersion, wire.binding.currentVersion)) return wire.poison();
      if ((response.state.status === "checking" || response.state.status === "available") && pending !== "check" ||
          (response.state.status === "preparing" || response.state.status === "prepared") && pending !== "install") return wire.poison();
      if (response.state.status !== "checking" && response.state.status !== "preparing") {
        preparedVersion = response.state.status === "prepared" ? response.state.updateVersion : undefined;
        pending = undefined; cancelled = false;
      }
    }
    receive(response);
  }, () => {});
  const closed = wire.closure.then(() => { if (!wire.cleanClosed()) return failure("CHANNEL_FAILED"); });
  void closed.catch(() => {});
  return Object.freeze({
    closed,
    async request(kind: "check" | "install" | "cancel"): Promise<void> {
      if (!["check", "install", "cancel"].includes(kind) || retireVersion || (kind === "cancel" ? !pending || cancelled : pending)) return failure("INVALID_STATE");
      if (kind === "cancel") cancelled = true; else pending = kind;
      await wire.send({ version: 2, ...wire.binding, type: kind });
    },
    async acknowledgeRetired(): Promise<void> {
      if (!retireVersion || pending || acknowledged) return failure("INVALID_STATE"); acknowledged = true;
      await wire.send({ version: 2, ...wire.binding, type: "retired" }); wire.end();
    }, quit: wire.end, close: wire.close,
  });
}

/** Adopts only the fixed inherited V2 descriptor. Missing V2 leaves the V1 writer hints untouched. */
export function openLinuxUpdateGuiChannel(currentVersion: string,
  receive: (response: LinuxUpdateResponse) => void): LinuxUpdateGuiChannel | undefined {
  const protocol = process.env[LINUX_UPDATE_PROTOCOL];
  if (protocol === undefined) return undefined;
  const nonce = process.env[LINUX_RESTART_NONCE], capturedVersion = process.env[LINUX_RESTART_VERSION];
  delete process.env[LINUX_UPDATE_PROTOCOL]; delete process.env[LINUX_RESTART_NONCE]; delete process.env[LINUX_RESTART_VERSION];
  try {
    const uid = process.getuid?.();
    if (protocol !== "2" || process.platform !== "linux" || uid === undefined || uid === 0 || capturedVersion !== currentVersion) return failure("CHANNEL_FAILED");
    const binding = bindingSchema.parse({ currentVersion, nonce });
    const descriptor = fstatSync(3, { bigint: true });
    const anonymous = readlinkSync("/proc/self/fd/3");
    if ((!descriptor.isSocket() && !descriptor.isFIFO()) || descriptor.uid !== BigInt(uid) ||
        anonymous !== `${descriptor.isSocket() ? "socket" : "pipe"}:[${descriptor.ino}]`) return failure("CHANNEL_FAILED");
    return createLinuxUpdateGuiChannel(new Socket({ fd: 3, readable: true, writable: true }), binding, receive);
  } catch { return failure("CHANNEL_FAILED"); }
}

import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boundPlatformFrame, platformReadySchema, platformReplySchema, platformRequestSchema, platformShortcutEventSchema,
  platformCaptureRequestSchema, platformCaptureReplySchema, type PlatformCaptureRequest, type PlatformCaptureReply,
  type PlatformReply, type PlatformRequest } from "../workers/platform-protocol.js";
import { verifyDevelopmentPlatformEntry, verifyDevelopmentLinuxBusArtifact, type DevelopmentArtifact } from "../services/development-artifact.js";
import { prepareLinuxSpeechRetirement, type LinuxSpeechRetirementAllocation } from "../services/linux-speech-retirement.js";
import type { RetirementBoundary } from "../services/backend-supervisor.js";
import { speechEnvironment } from "./linux-speech-host.js";
import type { PortalShortcutState } from "../platforms/linux/shared/portal-shortcuts.js";

export class PlatformChannelError extends Error {
  constructor(readonly code: "CANCELLED" | "START_FAILED" | "WORKER_FAILED" | "CLOSED" | "BUSY" | "INVALID_FRAME" | "TEARDOWN_FAILED" | "UNAVAILABLE") {
    super("Linux platform owner failed."); this.name = "PlatformChannelError";
  }
}
export interface PlatformChannel {
  request(request: PlatformRequest): Promise<PlatformReply>;
  close(): Promise<void>;
}
export interface PlatformChild {
  postMessage(request: PlatformRequest | PlatformCaptureReply): void;
  kill(): boolean;
  on(event: "message", listener: (input: unknown) => void): unknown;
  on(event: "spawn" | "error", listener: () => void): unknown;
  once(event: "exit", listener: () => void): unknown;
  off(event: "message", listener: (input: unknown) => void): unknown;
  off(event: "spawn", listener: () => void): unknown;
}
interface Pending {
  request: PlatformRequest;
  accept: (reply: PlatformReply) => void;
  reject: (failure: PlatformChannelError) => void;
  timer: NodeJS.Timeout;
}
const distribution = dirname(dirname(fileURLToPath(import.meta.url)));
async function fixedFile(parts: readonly string[]): Promise<string> {
  const root = await realpath(distribution); const path = join(root, ...parts);
  const [metadata, resolved] = await Promise.all([lstat(path), realpath(path)]);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !resolved.startsWith(`${root}${sep}`)) throw new PlatformChannelError("START_FAILED");
  return resolved;
}

/** Pure transport injection for tests. Every failed owner is reaped before return. */
export async function bindPlatformChild(child: PlatformChild, signal: AbortSignal,
  deadlines = { readyMs: 5000, requestMs: 5000, exitMs: 8000 },
  capture?: (request: PlatformCaptureRequest) => Promise<PlatformCaptureReply>,
  shortcuts?: (state: PortalShortcutState) => void): Promise<PlatformChannel> {
  let ready = false, ended = false, closing = false;
  let pending: Pending | undefined;
  let terminalFailure: PlatformChannelError | undefined;
  let reap: Promise<void> | undefined;
  let closeTask: Promise<void> | undefined;
  let resolveExit: (() => void) | undefined;
  let exitTimer: NodeJS.Timeout | undefined;
  let acceptReady: (() => void) | undefined, refuseReady: ((failure: PlatformChannelError) => void) | undefined;
  let readyTimer: NodeJS.Timeout | undefined;
  const readiness = new Promise<void>((accept, reject) => { acceptReady = accept; refuseReady = reject; });
  // Install a rejection observer before a synchronous fixture or abort can fail.
  void readiness.catch(() => undefined);
  function settlePending(failure: PlatformChannelError): void {
    if (!pending) return;
    const operation = pending; pending = undefined; clearTimeout(operation.timer); operation.reject(failure);
  }
  function terminate(failure = new PlatformChannelError("CLOSED")): Promise<void> {
    closing = true; terminalFailure ??= failure;
    if (readyTimer) clearTimeout(readyTimer);
    if (pending) clearTimeout(pending.timer);
    if (reap) return reap;
    if (ended) { settlePending(terminalFailure); return Promise.resolve(); }
    reap = new Promise<void>((accept, reject) => {
      resolveExit = accept;
      exitTimer = setTimeout(() => {
        resolveExit = undefined; terminalFailure = new PlatformChannelError("TEARDOWN_FAILED");
        settlePending(terminalFailure); reject(terminalFailure);
      }, deadlines.exitMs);
      // A kill request, including a thrown/refused request, is not confirmed process exit.
      try { child.kill(); } catch { /* Await the exit event or fail closed at the reap deadline. */ }
    });
    return reap;
  }
  function fail(code: "CANCELLED" | "START_FAILED" | "WORKER_FAILED" | "INVALID_FRAME" | "TEARDOWN_FAILED"): void {
    const failure = new PlatformChannelError(code);
    terminalFailure ??= failure;
    refuseReady?.(terminalFailure); refuseReady = undefined;
    // Preserve the request's ownership until the actual exit event or failed reap.
    void terminate(terminalFailure).catch(() => undefined);
  }
  const spawn = (): void => { if (closing && !ended) child.kill(); };
  const abort = (): void => { fail("CANCELLED"); };
  const receive = (input: unknown): void => {
    if (closing || ended) return;
    try {
      boundPlatformFrame(input);
      const shortcut = platformShortcutEventSchema.safeParse(input);
      if (shortcut.success) {
        if (!ready) throw new PlatformChannelError("INVALID_FRAME");
        shortcuts?.(shortcut.data.state); return;
      }
      const invocation = platformCaptureRequestSchema.safeParse(input);
      if (invocation.success) {
        if (!ready || !capture) throw new PlatformChannelError("INVALID_FRAME");
        void capture(invocation.data).then((reply) => {
          if (!closing && !ended) child.postMessage(platformCaptureReplySchema.parse(reply));
        }).catch(() => { fail("TEARDOWN_FAILED"); });
        return;
      }
      if (!ready) {
        platformReadySchema.parse(input); ready = true;
        if (readyTimer) clearTimeout(readyTimer);
        acceptReady?.(); acceptReady = undefined; refuseReady = undefined; return;
      }
      const reply = platformReplySchema.parse(input);
      if (!pending || reply.id !== pending.request.id || (reply.ok && reply.value.command !== pending.request.command)) throw new PlatformChannelError("INVALID_FRAME");
      if (!reply.ok && reply.code === "TEARDOWN_FAILED") { fail("TEARDOWN_FAILED"); return; }
      const operation = pending; pending = undefined; clearTimeout(operation.timer);
      if (reply.ok) operation.accept(reply); else operation.reject(new PlatformChannelError(reply.code));
    } catch { fail("INVALID_FRAME"); }
  };
  const exit = (): void => {
    ended = true; closing = true;
    if (readyTimer) clearTimeout(readyTimer);
    if (exitTimer) clearTimeout(exitTimer);
    const failure = terminalFailure ?? new PlatformChannelError("WORKER_FAILED");
    refuseReady?.(failure); refuseReady = undefined;
    settlePending(failure);
    child.off("message", receive); child.off("spawn", spawn); signal.removeEventListener("abort", abort);
    resolveExit?.(); resolveExit = undefined;
  };
  child.on("message", receive); child.on("spawn", spawn); child.once("exit", exit);
  child.on("error", () => { fail("WORKER_FAILED"); });
  signal.addEventListener("abort", abort, { once: true });
  readyTimer = setTimeout(() => { fail("START_FAILED"); }, deadlines.readyMs);
  if (signal.aborted) abort();
  try { await readiness; if (signal.aborted || ended || closing) throw new PlatformChannelError("CANCELLED"); }
  catch (error: unknown) {
    await terminate(); throw error instanceof PlatformChannelError ? error : new PlatformChannelError("START_FAILED");
  }
  const channel: PlatformChannel = {
    request(input) {
      if (ended || closing || closeTask) return Promise.reject(new PlatformChannelError("CLOSED"));
      if (pending) return Promise.reject(new PlatformChannelError("BUSY"));
      boundPlatformFrame(input); const request = platformRequestSchema.parse(input);
      return new Promise<PlatformReply>((accept, reject) => {
        const timer = setTimeout(() => { fail("WORKER_FAILED"); }, deadlines.requestMs);
        pending = { request, accept, reject, timer };
        try { child.postMessage(request); } catch { fail("WORKER_FAILED"); }
      });
    },
    close() {
      if (closeTask) return closeTask;
      // Fixed shutdown first when idle. A failed or busy owner still gets reaped.
      if (!closing && !ended && !pending) {
        const shutdown = channel.request({ version: 1, id: randomUUID(), command: "shutdown" });
        closeTask = shutdown.catch(() => undefined).then(() => terminate());
      } else {
        closeTask = terminate();
      }
      return closeTask;
    },
  };
  return Object.freeze(channel);
}

/** Explicit construction only; no runtime import, bus or native addon on import. */
export function createUtilityPlatformChannelFactory(options?: {
  readonly artifacts: { readonly root: string; readonly entry: DevelopmentArtifact; readonly bus: DevelopmentArtifact };
  readonly capture: (request: PlatformCaptureRequest) => Promise<PlatformCaptureReply>;
  readonly shortcuts?: (state: PortalShortcutState) => void;
}): (signal: AbortSignal) => Promise<PlatformChannel> {
  return async (signal) => {
    if (process.platform !== "linux" || signal.aborted) throw new PlatformChannelError("CANCELLED");
    const { app, session, utilityProcess } = await import("electron");
    await new Promise<void>((accept, reject) => {
      const listener = (): void => { reject(new PlatformChannelError("CANCELLED")); cleanup(); };
      const timer = setTimeout(() => { reject(new PlatformChannelError("START_FAILED")); cleanup(); }, 5000);
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", listener); };
      signal.addEventListener("abort", listener, { once: true });
      void app.whenReady().then(() => { cleanup(); accept(); }, () => { cleanup(); reject(new PlatformChannelError("START_FAILED")); });
      if (signal.aborted) listener();
    });
    const [worker] = options ? await Promise.all([
      verifyDevelopmentPlatformEntry(options.artifacts.root, options.artifacts.entry),
      verifyDevelopmentLinuxBusArtifact(options.artifacts.root, options.artifacts.bus),
    ]) : await Promise.all([fixedFile(["workers", "platform-entry.js"]), fixedFile(["native", "openwhisper_linux_bus.node"])]);
    if (signal.aborted) throw new PlatformChannelError("CANCELLED");
    const environment = speechEnvironment(process.env);
    const child = utilityProcess.fork(worker, [], { serviceName: "OpenWhisper Dev Platform", stdio: "ignore", execArgv: [],
      allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false, session: session.defaultSession, env: environment });
    if (!options) return bindPlatformChild(child, signal);
    let allocation: LinuxSpeechRetirementAllocation | undefined;
    let boundaryPromise: Promise<RetirementBoundary> | undefined;
    const epoch = randomUUID();
    let acceptSpawn!: () => void;
    const spawned = new Promise<void>((accept) => { acceptSpawn = accept; });
    child.once("spawn", () => {
      if (child.pid) {
        allocation = prepareLinuxSpeechRetirement(child.pid, epoch);
        boundaryPromise = allocation.bind(); void boundaryPromise.catch(() => {});
      }
      acceptSpawn();
    });
    let retirement: Promise<void> | undefined;
    const retire = (): Promise<void> => {
      retirement ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([spawned, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PlatformChannelError("TEARDOWN_FAILED")), 5000); })]); }
        finally { if (timer) clearTimeout(timer); }
        if (!allocation || !boundaryPromise) throw new PlatformChannelError("TEARDOWN_FAILED");
        const boundary = await boundaryPromise, cleanup = AbortSignal.timeout(8000);
        if (z.object({ level: z.enum(["running", "non-running", "reaped", "ambiguous"]) }).parse(await boundary.observe(cleanup)).level === "running") child.kill();
        await boundary.waitForRetirement(cleanup); await boundary.settleReads();
        if (boundary.current.level !== "reaped") throw new PlatformChannelError("TEARDOWN_FAILED");
      })();
      void retirement.catch(() => {}); return retirement;
    };
    let channel: PlatformChannel;
    try {
      channel = await bindPlatformChild(child, signal, undefined, options.capture, options.shortcuts);
      if (!boundaryPromise) throw new PlatformChannelError("TEARDOWN_FAILED");
      z.object({ level: z.literal("running"), canAdmit: z.literal(true) }).parse((await boundaryPromise).initial);
    }
    catch (error: unknown) { await retire(); throw error; }
    return Object.freeze({ request: (request: PlatformRequest) => channel.request(request),
      close: async () => { await channel.close(); await retire(); } });
  };
}

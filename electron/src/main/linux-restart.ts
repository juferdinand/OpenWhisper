import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import { z } from "zod";
import { isNewerUpdateVersion, parseUpdateVersion } from "../services/update-policy.js";

export const LINUX_RESTART_NONCE = "OPENWHISPER_RESTART_NONCE";
export const LINUX_RESTART_VERSION = "OPENWHISPER_RESTART_VERSION";
export const LINUX_RESTART_FRAME_BYTES = 512;
const nonceSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const receiptSchema = z.strictObject({ version: z.literal(1), type: z.literal("restart"), nonce: nonceSchema,
  installedVersion: z.string().max(62).refine((value) => { try { parseUpdateVersion(value); return true; } catch { return false; } }) }).readonly();
export type LinuxRestartReceipt = z.infer<typeof receiptSchema>;
export class LinuxRestartError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "INVALID_REQUEST" | "CHANNEL_FAILED" | "REVALIDATION_FAILED" | "EXEC_FAILED") {
    super(code); this.name = "LinuxRestartError";
  }
}
function context(currentVersion: string, nonce: string): void {
  try { parseUpdateVersion(currentVersion); nonceSchema.parse(nonce); } catch { throw new LinuxRestartError("INVALID_REQUEST"); }
}

/** Reads only the original anonymous child pipe. EOF is required before trusting a single complete frame. */
export function readLinuxRestartReceipt(pipe: Readable, currentVersion: string, nonce: string): Promise<LinuxRestartReceipt | undefined> {
  context(currentVersion, nonce);
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, failed = false, ended = false;
    const data = (input: unknown): void => {
      if (failed) return;
      if (!(input instanceof Uint8Array) || input.length > LINUX_RESTART_FRAME_BYTES - bytes) { failed = true; chunks.length = 0; return; }
      if (input.length) { chunks.push(Buffer.from(input)); bytes += input.length; }
    };
    const cleanup = (): void => { pipe.off("data", data); pipe.off("end", end); pipe.off("error", error); pipe.off("close", close); };
    const error = (): void => { failed = true; };
    const end = (): void => { ended = true; };
    const close = (): void => {
      cleanup();
      try {
        if (failed || !ended) throw new LinuxRestartError("CHANNEL_FAILED");
        if (!bytes) { accept(undefined); return; }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
        if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw new LinuxRestartError("CHANNEL_FAILED");
        const receipt = receiptSchema.parse(JSON.parse(text.slice(0, -1)) as unknown);
        if (receipt.nonce !== nonce || !isNewerUpdateVersion(receipt.installedVersion, currentVersion)) throw new LinuxRestartError("CHANNEL_FAILED");
        accept(receipt);
      } catch { reject(new LinuxRestartError("CHANNEL_FAILED")); }
    };
    pipe.on("data", data); pipe.once("end", end); pipe.on("error", error); pipe.once("close", close);
  });
}

export interface LinuxRestartWriter { requestRestart(installedVersion: string): Promise<void> }
/** Host-only writer seam. The installer retains its original artifact, stage and backup ownership. */
export function createLinuxRestartWriter(pipe: Writable, currentVersion: string, nonce: string): LinuxRestartWriter {
  context(currentVersion, nonce); let requested = false, failed = false;
  const trackError = (): void => { failed = true; };
  pipe.on("error", trackError); pipe.once("close", () => { pipe.off("error", trackError); });
  return Object.freeze({
    async requestRestart(installedVersion: string): Promise<void> {
      if (requested) throw new LinuxRestartError("INVALID_REQUEST"); requested = true;
      if (failed) throw new LinuxRestartError("CHANNEL_FAILED");
      if (!isNewerUpdateVersion(installedVersion, currentVersion)) throw new LinuxRestartError("INVALID_REQUEST");
      const frame = Buffer.from(`${JSON.stringify(receiptSchema.parse({ version: 1, type: "restart", nonce, installedVersion }))}\n`);
      if (frame.length > LINUX_RESTART_FRAME_BYTES) throw new LinuxRestartError("INVALID_REQUEST");
      await new Promise<void>((accept, reject) => {
        const deadline = performance.now() + 5000;
        const finish = (): void => { if (performance.now() >= deadline) { error(); return; } cleanup(); accept(); };
        const error = (): void => { cleanup(); reject(new LinuxRestartError("CHANNEL_FAILED")); };
        const close = (): void => { if (performance.now() >= deadline || !pipe.writableFinished) error(); };
        const timer = setTimeout(() => { error(); pipe.destroy(); }, 5000);
        const cleanup = (): void => { clearTimeout(timer); pipe.off("finish", finish); pipe.off("error", error); pipe.off("close", close); };
        pipe.once("finish", finish); pipe.once("error", error); pipe.once("close", close);
        try { if (pipe.destroyed || pipe.writableEnded) error(); else pipe.end(frame); } catch { error(); }
      });
    },
  });
}

/** Unwired production boundary: fd3 must be an inherited same-user pipe/socket, never a pathname or regular file. */
export function openLinuxRestartWriter(currentVersion: string): LinuxRestartWriter {
  try {
    const nonce = process.env[LINUX_RESTART_NONCE], version = process.env[LINUX_RESTART_VERSION], uid = process.getuid?.();
    if (process.platform !== "linux" || uid === undefined || uid === 0 || !nonce || version !== currentVersion) throw new Error();
    context(currentVersion, nonce);
    delete process.env[LINUX_RESTART_NONCE]; delete process.env[LINUX_RESTART_VERSION];
    const descriptor = fstatSync(3);
    if ((!descriptor.isSocket() && !descriptor.isFIFO()) || descriptor.uid !== uid) throw new Error();
    return createLinuxRestartWriter(new Socket({ fd: 3, readable: false, writable: true }), currentVersion, nonce);
  } catch { throw new LinuxRestartError("UNAVAILABLE"); }
}

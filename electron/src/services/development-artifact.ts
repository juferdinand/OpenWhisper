import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const developmentArtifactSchema = z.strictObject({
  bytes: z.number().int().positive().max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).readonly();
export type DevelopmentArtifact = z.infer<typeof developmentArtifactSchema>;
export class DevelopmentArtifactError extends Error {
  constructor(readonly code: "INTEGRITY_FAILED" | "TEARDOWN_FAILED") { super(code); }
}
const failedClosures = new Map<string, FileHandle>();
type Destination = "dist/workers/capture-entry.js" | "dist/native/capture/openwhisper_capture.node";
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function safeFile(value: BigIntStats, expected: DevelopmentArtifact): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.nlink === 1n &&
    (value.uid === BigInt(process.getuid?.() ?? -1) || value.uid === 0n) &&
    (value.mode & 0o022n) === 0n && value.size === BigInt(expected.bytes);
}
async function checkAncestors(path: string): Promise<void> {
  for (let cursor = dirname(path);; cursor = dirname(cursor)) {
    const value = await lstat(cursor, { bigint: true });
    const stickyTemporary = value.uid === 0n && (value.mode & 0o1000n) !== 0n;
    if (!value.isDirectory() || value.isSymbolicLink() ||
      (value.uid !== 0n && value.uid !== BigInt(process.getuid?.() ?? -1)) ||
      ((value.mode & 0o022n) !== 0n && !stickyTemporary)) throw new DevelopmentArtifactError("INTEGRITY_FAILED");
    if (dirname(cursor) === cursor) break;
  }
}
/** Fixed Dev build destinations only. Hashes detect build mutation, not release authenticity. */
async function verify(root: string, destination: Destination, input: DevelopmentArtifact): Promise<string> {
  const parsed = developmentArtifactSchema.safeParse(input);
  if (!parsed.success || !isAbsolute(root) || resolve(root) !== root || root.includes("\0")) {
    throw new DevelopmentArtifactError("INTEGRITY_FAILED");
  }
  const path = join(root, destination);
  if (failedClosures.has(path)) throw new DevelopmentArtifactError("TEARDOWN_FAILED");
  let file: FileHandle | undefined;
  try {
    if (await realpath(root) !== root) throw new DevelopmentArtifactError("INTEGRITY_FAILED");
    await checkAncestors(path);
    const named = await lstat(path, { bigint: true });
    if (!safeFile(named, parsed.data)) throw new DevelopmentArtifactError("INTEGRITY_FAILED");
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const first = await file.stat({ bigint: true });
    if (!same(first, named) || !safeFile(first, parsed.data)) throw new DevelopmentArtifactError("INTEGRITY_FAILED");
    const hash = createHash("sha256"), block = Buffer.alloc(64 * 1024);
    let count = 0;
    for (;;) {
      const { bytesRead } = await file.read(block, 0, Math.min(block.length, parsed.data.bytes - count + 1), null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > parsed.data.bytes) throw new DevelopmentArtifactError("INTEGRITY_FAILED");
      hash.update(block.subarray(0, bytesRead));
    }
    if (count !== parsed.data.bytes || hash.digest("hex") !== parsed.data.sha256 ||
      !same(first, await file.stat({ bigint: true })) || !same(first, await lstat(path, { bigint: true }))) {
      throw new DevelopmentArtifactError("INTEGRITY_FAILED");
    }
    await checkAncestors(path);
    return path;
  } catch {
    throw new DevelopmentArtifactError("INTEGRITY_FAILED");
  } finally {
    if (file) {
      try { await file.close(); }
      catch { failedClosures.set(path, file); throw new DevelopmentArtifactError("TEARDOWN_FAILED"); }
    }
  }
}
export function verifyDevelopmentCaptureArtifact(root: string, expected: DevelopmentArtifact): Promise<string> {
  return verify(root, "dist/native/capture/openwhisper_capture.node", expected);
}
export function verifyDevelopmentCaptureEntry(root: string, expected: DevelopmentArtifact): Promise<string> {
  return verify(root, "dist/workers/capture-entry.js", expected);
}

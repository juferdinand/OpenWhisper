import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  Ownership, PreparedAudio, RecoveryBoundary, RecoverySaved, RecoveryToken, WorkContext,
} from "../../core/recording/recording.js";

const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const blockSamples = 4096;
interface DirectoryIdentity { readonly dev: bigint; readonly ino: bigint }
export interface RecoveryIO {
  readonly write: (file: FileHandle, bytes: Buffer) => Promise<void>;
  readonly syncFile: (file: FileHandle) => Promise<void>;
  readonly syncDirectory: (file: FileHandle) => Promise<void>;
}
export class RecoveryError extends Error {
  constructor(readonly code: "UNSAFE_STORAGE" | "INVALID_AUDIO" | "STORAGE_FAILED" | "CANCELLED") {
    super(code); this.name = "RecoveryError";
  }
}

function owned(context: Ownership): Ownership {
  if (!Number.isSafeInteger(context.generation) || context.generation < 0
      || !Number.isSafeInteger(context.attempt) || context.attempt < 0) {
    throw new RecoveryError("INVALID_AUDIO");
  }
  return { generation: context.generation, attempt: context.attempt };
}
function active(context: WorkContext): void {
  owned(context);
  if (context.signal.aborted) throw new RecoveryError("CANCELLED");
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function tokenId(token: RecoveryToken): string {
  if (!token || typeof token.id !== "string" || !identifier.test(token.id)) {
    throw new RecoveryError("INVALID_AUDIO");
  }
  return token.id;
}
async function writeAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten === 0) throw new RecoveryError("STORAGE_FAILED");
    offset += bytesWritten;
  }
}
async function readAll(file: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
    if (bytesRead === 0) throw new RecoveryError("INVALID_AUDIO");
    offset += bytesRead;
  }
}

/** Exact legacy IEEE-float mono 16 kHz header; RF64 is a size format, not a time limit. */
export function recoveryWavHeader(samples: bigint): Buffer {
  if (samples < 0n || samples > ((1n << 64n) - 73n) / 4n) throw new RecoveryError("INVALID_AUDIO");
  const bytes = samples * 4n;
  const rf64 = bytes > 0xffff_ffffn - 36n;
  const header = Buffer.alloc(rf64 ? 80 : 44);
  header.write(rf64 ? "RF64" : "RIFF", 0, "ascii");
  header.writeUInt32LE(rf64 ? 0xffff_ffff : Number(bytes + 36n), 4);
  header.write("WAVE", 8, "ascii");
  let format = 12;
  if (rf64) {
    header.write("ds64", 12, "ascii"); header.writeUInt32LE(28, 16);
    header.writeBigUInt64LE(bytes + 72n, 20); header.writeBigUInt64LE(bytes, 28);
    header.writeBigUInt64LE(samples, 36); header.writeUInt32LE(0, 44);
    format = 48;
  }
  header.write("fmt ", format, "ascii"); header.writeUInt32LE(16, format + 4);
  header.writeUInt16LE(3, format + 8); header.writeUInt16LE(1, format + 10);
  header.writeUInt32LE(16000, format + 12); header.writeUInt32LE(64000, format + 16);
  header.writeUInt16LE(4, format + 20); header.writeUInt16LE(32, format + 22);
  header.write("data", format + 24, "ascii");
  header.writeUInt32LE(rf64 ? 0xffff_ffff : Number(bytes), format + 28);
  return header;
}

async function directoryIdentity(path: string, expected?: DirectoryIdentity): Promise<DirectoryIdentity> {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
    throw new RecoveryError("UNSAFE_STORAGE");
  }
  const ancestors: string[] = [];
  for (let cursor = path;; cursor = dirname(cursor)) {
    ancestors.push(cursor); if (dirname(cursor) === cursor) break;
  }
  let identity: DirectoryIdentity | undefined;
  try {
    for (const ancestor of ancestors.reverse()) {
      const stats = await lstat(ancestor, { bigint: true });
      const mode = Number(stats.mode & 0o7777n);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error();
      if (ancestor === path) {
        if (stats.uid !== BigInt(uid) || mode !== 0o700 || (expected &&
            (stats.dev !== expected.dev || stats.ino !== expected.ino))) throw new Error();
        identity = { dev: stats.dev, ino: stats.ino };
      } else if ((stats.uid !== BigInt(uid) && stats.uid !== 0n)
          || ((mode & 0o022) !== 0 && !(stats.uid === 0n && (mode & 0o1000) !== 0))) throw new Error();
    }
  } catch { throw new RecoveryError("UNSAFE_STORAGE"); }
  if (!identity) throw new RecoveryError("UNSAFE_STORAGE");
  return identity;
}

/** Run only in the capture/recovery utility. Never scan or copy full audio in main/renderer. */
export class PrivateAudioRecovery implements RecoveryBoundary {
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string, private readonly identity: DirectoryIdentity,
                      private readonly io: RecoveryIO) {}

  static async open(path: string, effects: Partial<RecoveryIO> = {}): Promise<PrivateAudioRecovery> {
    const identity = await directoryIdentity(path);
    return new PrivateAudioRecovery(path, identity, {
      write: effects.write ?? writeAll,
      syncFile: effects.syncFile ?? ((file) => file.sync()),
      syncDirectory: effects.syncDirectory ?? ((file) => file.sync()),
    });
  }
  private run<T>(effect: () => Promise<T>): Promise<T> {
    const result = this.queue.then(effect).catch((error: unknown) => {
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError("STORAGE_FAILED");
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private filename(token: RecoveryToken): string { return join(this.path, `recording-${tokenId(token)}.wav`); }
  private async directory(): Promise<FileHandle> {
    await directoryIdentity(this.path, this.identity);
    const file = await open(this.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stats = await file.stat({ bigint: true });
      if (stats.dev !== this.identity.dev || stats.ino !== this.identity.ino || !stats.isDirectory()
          || stats.uid !== BigInt(process.getuid?.() ?? -1) || (stats.mode & 0o7777n) !== 0o700n) {
        throw new RecoveryError("UNSAFE_STORAGE");
      }
      return file;
    } catch (error: unknown) { await file.close(); throw error; }
  }
  private async record(token: RecoveryToken): Promise<{ file: FileHandle; sampleCount: number }> {
    await directoryIdentity(this.path, this.identity);
    let file: FileHandle;
    try { file = await open(this.filename(token), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw new RecoveryError("INVALID_AUDIO"); }
    try {
      await directoryIdentity(this.path, this.identity);
      const stats = await file.stat({ bigint: true });
      if (!stats.isFile() || stats.uid !== BigInt(process.getuid?.() ?? -1)
          || stats.nlink !== 1n || (stats.mode & 0o7777n) !== 0o600n) throw new RecoveryError("INVALID_AUDIO");
      const first = Buffer.alloc(44); await readAll(file, first);
      const offset = first.toString("ascii", 0, 4) === "RIFF" ? 44
        : first.toString("ascii", 0, 4) === "RF64" ? 80 : 0;
      if (!offset || stats.size <= BigInt(offset) || (stats.size - BigInt(offset)) % 4n !== 0n
          || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RecoveryError("INVALID_AUDIO");
      const samples = (stats.size - BigInt(offset)) / 4n;
      const expected = recoveryWavHeader(samples);
      const actual = offset === 44 ? first : Buffer.concat([first, Buffer.alloc(36)]);
      if (offset === 80) await readAll(file, actual.subarray(44));
      if (actual.length !== expected.length || !actual.equals(expected)) throw new RecoveryError("INVALID_AUDIO");
      return { file, sampleCount: Number(samples) };
    } catch (error: unknown) { await file.close(); throw error; }
  }
  private async samples(token: RecoveryToken, retain: boolean, context?: WorkContext): Promise<{
    sampleCount: number; chunks: Float32Array[];
  }> {
    const { file, sampleCount } = await this.record(token);
    const chunks: Float32Array[] = [];
    try {
      for (let position = 0; position < sampleCount;) {
        if (context) active(context);
        const length = Math.min(blockSamples, sampleCount - position);
        const bytes = Buffer.alloc(length * 4); await readAll(file, bytes);
        const chunk = retain ? new Float32Array(length) : undefined;
        for (let index = 0; index < length; index += 1) {
          const value = bytes.readFloatLE(index * 4);
          if (!Number.isFinite(value)) throw new RecoveryError("INVALID_AUDIO");
          if (chunk) chunk[index] = value;
        }
        if (chunk) chunks.push(chunk);
        position += length;
      }
      const remaining = Buffer.alloc(1);
      if ((await file.read(remaining, 0, 1, null)).bytesRead !== 0) throw new RecoveryError("INVALID_AUDIO");
      return { sampleCount, chunks };
    } finally { await file.close(); }
  }

  latest(): Promise<RecoveryToken | null> {
    return this.run(async () => {
      const directory = await this.directory();
      try { await this.io.syncDirectory(directory); } finally { await directory.close(); }
      const candidates: { id: string; time: bigint }[] = [];
      for (const name of await readdir(this.path)) {
        const id = name.startsWith("recording-") && name.endsWith(".wav") ? name.slice(10, -4) : "";
        if (!identifier.test(id)) continue;
        const stats = await lstat(join(this.path, name), { bigint: true }).catch(() => null);
        if (stats) candidates.push({ id, time: stats.mtimeNs });
      }
      candidates.sort((left, right) => left.time < right.time ? 1 : left.time > right.time ? -1 : left.id.localeCompare(right.id));
      for (const token of candidates) {
        try { await this.samples(token, false); return Object.freeze({ id: token.id }); }
        catch (error: unknown) {
          // A damaged backup is retained, while older intact owned recordings remain recoverable.
          if (!(error instanceof RecoveryError && error.code === "INVALID_AUDIO")) throw error;
        }
      }
      return null;
    });
  }

  save(audio: PreparedAudio, context: WorkContext): Promise<RecoverySaved> {
    return this.run(async () => {
      active(context);
      if (audio.generation !== context.generation || audio.attempt !== context.attempt || audio.sampleRate !== 16000
          || !Number.isSafeInteger(audio.sampleCount) || audio.sampleCount <= 0 || !Array.isArray(audio.chunks)) {
        throw new RecoveryError("INVALID_AUDIO");
      }
      const token = Object.freeze({ id: randomUUID() });
      const destination = this.filename(token);
      const temporary = `${destination}.tmp`;
      const directory = await this.directory();
      let file: FileHandle | undefined;
      let committed = false;
      try {
        file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await this.io.write(file, recoveryWavHeader(BigInt(audio.sampleCount)));
        let count = 0;
        for (const chunk of audio.chunks) {
          if (!(chunk instanceof Float32Array) || !(chunk.buffer instanceof ArrayBuffer)) throw new RecoveryError("INVALID_AUDIO");
          for (let position = 0; position < chunk.length; position += blockSamples) {
            active(context);
            const length = Math.min(blockSamples, chunk.length - position);
            const bytes = Buffer.alloc(length * 4);
            for (let index = 0; index < length; index += 1) {
              const value = chunk[position + index];
              if (value === undefined || !Number.isFinite(value)) throw new RecoveryError("INVALID_AUDIO");
              bytes.writeFloatLE(value, index * 4);
            }
            await this.io.write(file, bytes); count += length;
          }
        }
        if (count !== audio.sampleCount) throw new RecoveryError("INVALID_AUDIO");
        active(context); await this.io.syncFile(file); await file.close(); file = undefined;
        active(context); await directoryIdentity(this.path, this.identity);
        await rename(temporary, destination); committed = true;
        await this.io.syncDirectory(directory);
        return { ...owned(context), token, durable: true };
      } catch (error: unknown) {
        if (committed) return { ...owned(context), token, durable: false };
        if (error instanceof RecoveryError) throw error;
        throw new RecoveryError("STORAGE_FAILED");
      } finally {
        await file?.close().catch(() => {});
        // Never follow a replaced parent during cleanup; private orphan temporaries are ignored.
        await directoryIdentity(this.path, this.identity).then(() => unlink(temporary)).catch(() => {});
        await directory.close().catch(() => {});
      }
    });
  }

  ensureCommitted(token: RecoveryToken, context: WorkContext): Promise<RecoverySaved> {
    return this.run(async () => {
      active(context);
      const { file } = await this.record(token);
      try { await this.io.syncFile(file); } finally { await file.close(); }
      active(context);
      const directory = await this.directory();
      try { await this.io.syncDirectory(directory); } finally { await directory.close(); }
      return { ...owned(context), token: Object.freeze({ id: tokenId(token) }), durable: true };
    });
  }
  read(token: RecoveryToken, context: WorkContext): Promise<PreparedAudio> {
    return this.run(async () => {
      active(context);
      const audio = await this.samples(token, true, context);
      active(context);
      return Object.freeze({ ...owned(context), sampleRate: 16000, sampleCount: audio.sampleCount,
        chunks: Object.freeze(audio.chunks) });
    });
  }
  remove(token: RecoveryToken, context: WorkContext): Promise<Ownership> {
    return this.run(async () => {
      active(context);
      const directory = await this.directory();
      try {
        // Reject unsafe aliases before unlink; a previously confirmed removal is idempotent.
        const path = this.filename(token);
        const stats = await lstat(path, { bigint: true }).catch((error: unknown) => { if (missing(error)) return null; throw error; });
        if (stats && (!stats.isFile() || stats.uid !== BigInt(process.getuid?.() ?? -1)
            || stats.nlink !== 1n || (stats.mode & 0o7777n) !== 0o600n)) throw new RecoveryError("UNSAFE_STORAGE");
        active(context); await directoryIdentity(this.path, this.identity);
        await unlink(path).catch((error: unknown) => { if (!missing(error)) throw error; });
        // If this fails, retry confirms deletion; it never recreates or re-infers the removed record.
        await this.io.syncDirectory(directory);
        return owned(context);
      } finally { await directory.close(); }
    });
  }
}

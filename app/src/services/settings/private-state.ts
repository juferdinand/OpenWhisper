import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ZodType } from "zod";

interface ParentIdentity { readonly dev: number; readonly ino: number }
export interface PrivateStateOpenPolicy {
  readonly invalidContent?: "reject" | "preserve-and-default";
  readonly requireExisting?: boolean;
}

async function privateParent(path: string, expected?: ParentIdentity): Promise<ParentIdentity> {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(path) || path.includes("\0") || resolve(path) !== path) {
    throw new Error("Private development state requires a fixed absolute path.");
  }
  const parent = dirname(path);
  const paths: string[] = [];
  for (let cursor = parent;; cursor = dirname(cursor)) {
    paths.push(cursor);
    if (dirname(cursor) === cursor) break;
  }
  let identity: ParentIdentity | undefined;
  try {
    for (const ancestor of paths.reverse()) {
      const stats = await lstat(ancestor);
      const mode = stats.mode & 0o7777;
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error();
      if (ancestor === parent) {
        if (stats.uid !== uid || mode !== 0o700 || (expected !== undefined &&
            (stats.dev !== expected.dev || stats.ino !== expected.ino))) throw new Error();
        identity = { dev: stats.dev, ino: stats.ino };
      } else {
        const sharedTemporaryAncestor = stats.uid === 0 && (mode & 0o1000) !== 0;
        if ((stats.uid !== uid && stats.uid !== 0) ||
            ((mode & 0o022) !== 0 && !sharedTemporaryAncestor)) throw new Error();
      }
    }
  } catch { throw new Error("Private development state directory is unsafe."); }
  if (!identity) throw new Error("Private development state directory is unsafe.");
  return identity;
}

/** Private, bounded JSON for a fixed host-selected file; never a renderer-selected path. */
export class PrivateStateStore<T> {
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string, private readonly schema: ZodType<T>,
                      private value: T, private readonly maximumBytes: number,
                      private readonly parent: ParentIdentity, private invalid: boolean) {}

  static async open<T>(path: string, schema: ZodType<T>, defaults: T, maximumBytes = 1024 * 1024,
                       policy: PrivateStateOpenPolicy = {}): Promise<PrivateStateStore<T>> {
    if (!Number.isInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > 8 * 1024 * 1024) {
      throw new Error("Invalid private-state size limit.");
    }
    const parent = await privateParent(path);
    let value = schema.parse(defaults);
    let invalid = false;
    const invalidContent = (): void => {
      if (policy.invalidContent !== "preserve-and-default") {
        throw new Error("Private development state content is invalid or exceeds its size limit.");
      }
      invalid = true;
    };
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Private development state could not be opened safely.");
      }
      if (policy.requireExisting) throw new Error("Required private state is missing.");
    }
    if (file) {
      try {
        await privateParent(path, parent);
        const stats = await file.stat();
        if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== process.getuid?.() ||
            (stats.mode & 0o7777) !== 0o600) {
          throw new Error("Private development state is unsafe.");
        }
        if (stats.size > maximumBytes) invalidContent();
        else {
          const bytes = Buffer.alloc(maximumBytes + 1);
          let length = 0;
          while (length < bytes.length) {
            const result = await file.read(bytes, length, Math.min(65536, bytes.length - length), null);
            if (!result.bytesRead) break;
            length += result.bytesRead;
          }
          if (length > maximumBytes) invalidContent();
          else {
            try {
              const input: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, length)));
              value = schema.parse(input);
            } catch { invalidContent(); }
          }
        }
      } finally { await file.close(); }
    }
    await privateParent(path, parent);
    return new PrivateStateStore(path, schema, value, maximumBytes, parent, invalid);
  }

  /** Optional corrupt feature bytes are preserved until a valid explicit update commits. */
  get invalidContent(): boolean { return this.invalid; }
  snapshot(): T { return structuredClone(this.value); }

  update(reducer: (current: T) => unknown): Promise<T> {
    const result = this.queue.then(async () => {
      // Revalidate aliases and the original directory identity before each effect.
      // This detects accidental changes; it is not a sandbox against this UID.
      await privateParent(this.path, this.parent);
      const value = this.schema.parse(reducer(this.snapshot()));
      const bytes = Buffer.from(JSON.stringify(value), "utf8");
      if (bytes.length > this.maximumBytes) throw new Error("Private development state exceeds its size limit.");
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await privateParent(this.path, this.parent);
        await file.writeFile(bytes);
        await file.sync();
        await file.close();
        file = undefined;
        await privateParent(this.path, this.parent);
        await rename(temporary, this.path);
        this.value = value;
        this.invalid = false;
        return this.snapshot();
      } finally {
        await file?.close();
        await privateParent(this.path, this.parent);
        await rm(temporary, { force: true });
      }
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}

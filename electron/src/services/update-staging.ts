import type { BigIntStats } from "node:fs";
import { lstat, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const MAX_UPDATE_STAGE_BYTES = 1024 * 1024 * 1024;
export type UpdateArtifactName = "OpenWhisper-Linux-amd64.deb" | "OpenWhisper-Linux-x86_64.AppImage" | "OpenWhisper-macOS.zip";
type Failure = "INVALID_INPUT" | "UNSAFE_STAGING" | "FILE_CHANGED" | "PAYLOAD_TOO_LARGE" | "READ_FAILED" | "CLEANUP_FAILED";
export class UpdateStagingError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "UpdateStagingError"; }
}
const fail = (code: Failure): never => { throw new UpdateStagingError(code); };
export interface OwnedUpdateFileInput {
  /** Settled original descriptor, created with O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW under a unique private stage.
   * The producer uses positioned writes, preserving its initial implicit offset zero for inherited Mac ZIP fd3.
   * Admission cannot inspect/reset that cursor; borrowers must use positioned reads or the fixed consumer. */
  readonly file: FileHandle;
  readonly stageDirectory: string;
  readonly artifactName: UpdateArtifactName;
  readonly maximumBytes?: number;
}
export interface UpdateFileObservation {
  readonly bytes: number;
  assertUnchanged(): Promise<void>;
}
/** Staged bytes are unauthenticated. Consumers borrow the original descriptor; it is not installation authority. */
export interface OwnedUpdateDownload extends UpdateFileObservation {
  readonly file: FileHandle;
  readonly stageDirectory: string;
  readonly artifactName: UpdateArtifactName;
  /** Call only after all original writes and consuming operations settle. Removes no extraction child or replacement. */
  cleanup(): Promise<void>;
}
function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameDirectory(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function ownedFile(value: BigIntStats, uid: bigint): boolean {
  return value.isFile() && !value.isSymbolicLink() && value.uid === uid && value.nlink === 1n && (value.mode & 0o7777n) === 0o600n;
}
async function ancestry(stage: string, uid: bigint): Promise<readonly BigIntStats[]> {
  const values: BigIntStats[] = [];
  for (let cursor = stage;; cursor = dirname(cursor)) {
    const value = await lstat(cursor, { bigint: true }).catch(() => fail("UNSAFE_STAGING"));
    const mode = value.mode & 0o7777n;
    if (!value.isDirectory() || value.isSymbolicLink() ||
        (cursor === stage ? value.uid !== uid || mode !== 0o700n :
          (value.uid !== 0n && value.uid !== uid) || ((mode & 0o022n) !== 0n && !(value.uid === 0n && (mode & 0o1000n) !== 0n)))) return fail("UNSAFE_STAGING");
    values.push(value);
    if (dirname(cursor) === cursor) break;
  }
  return values;
}
async function assertDirectories(stage: string, uid: bigint, before: readonly BigIntStats[]): Promise<void> {
  const after = await ancestry(stage, uid);
  if (after.length !== before.length || after.some((value, index) => !before[index] || !sameDirectory(value, before[index]))) return fail("FILE_CHANGED");
}
/** Pre-acquisition guard for the admitted private cache or stage; no file or cleanup ownership is acquired. */
export async function assertPrivateUpdateDirectory(path: string): Promise<Readonly<{ assertUnchanged(): Promise<void> }>> {
  const user = process.getuid?.();
  if (!["linux", "darwin"].includes(process.platform) || user === undefined || typeof path !== "string" ||
      !isAbsolute(path) || resolve(path) !== path || path.includes("\0")) return fail("INVALID_INPUT");
  const uid = BigInt(user), before = await ancestry(path, uid);
  return Object.freeze({ assertUnchanged: () => assertDirectories(path, uid, before) });
}
async function capture(input: OwnedUpdateFileInput) {
  const { file, stageDirectory, artifactName } = input;
  const maximum = input.maximumBytes ?? MAX_UPDATE_STAGE_BYTES, user = process.getuid?.();
  if (!["linux", "darwin"].includes(process.platform) || user === undefined || typeof stageDirectory !== "string" ||
      !isAbsolute(stageDirectory) || resolve(stageDirectory) !== stageDirectory || stageDirectory.includes("\0") ||
      !["OpenWhisper-Linux-amd64.deb", "OpenWhisper-Linux-x86_64.AppImage", "OpenWhisper-macOS.zip"].includes(artifactName) ||
      !Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_UPDATE_STAGE_BYTES) return fail("INVALID_INPUT");
  const uid = BigInt(user), path = join(stageDirectory, artifactName), directories = await ancestry(stageDirectory, uid);
  const before = await file.stat({ bigint: true }).catch(() => fail("READ_FAILED"));
  const named = await lstat(path, { bigint: true }).catch(() => fail("FILE_CHANGED"));
  if (!ownedFile(before, uid) || !ownedFile(named, uid)) return fail("UNSAFE_STAGING");
  if (!sameFile(before, named) || before.size < 1n) return fail("FILE_CHANGED");
  if (before.size > BigInt(maximum)) return fail("PAYLOAD_TOO_LARGE");
  const assertStage = (): Promise<void> => assertDirectories(stageDirectory, uid, directories);
  const assertUnchanged = async (): Promise<void> => {
    const current = await file.stat({ bigint: true }).catch(() => fail("READ_FAILED"));
    const name = await lstat(path, { bigint: true }).catch(() => fail("FILE_CHANGED"));
    if (!sameFile(before, current) || !sameFile(before, name) || !ownedFile(current, uid) || !ownedFile(name, uid)) return fail("FILE_CHANGED");
    await assertStage();
  };
  // Recheck ancestry after the awaited handle/path acquisition as well as after consumption.
  await assertStage();
  return { bytes: Number(before.size), assertUnchanged, assertDirectories: assertStage, before, path, uid };
}
/** Borrows an already-settled file. Admission and observation never close or delete it. */
export async function inspectOwnedUpdateFile(input: OwnedUpdateFileInput): Promise<Readonly<UpdateFileObservation>> {
  const observed = await capture(input);
  return Object.freeze({ bytes: observed.bytes, assertUnchanged: observed.assertUnchanged });
}
/** Ownership transfers only on success. The producer retains every acquired resource if admission refuses. */
export async function retainOwnedUpdateDownload(input: OwnedUpdateFileInput): Promise<Readonly<OwnedUpdateDownload>> {
  const { file, stageDirectory, artifactName } = input;
  const observed = await capture(input);
  let closing: Promise<void> | undefined, cleaning: Promise<void> | undefined, complete = false;
  const cleanup = (): Promise<void> => {
    cleaning ??= Promise.resolve().then(async () => {
      if (complete) return;
      closing ??= Promise.resolve().then(() => file.close());
      await closing;
      await observed.assertDirectories();
      const named = await lstat(observed.path, { bigint: true }).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (named) {
        if (!ownedFile(named, observed.uid) || !sameFile(named, observed.before)) return fail("FILE_CHANGED");
        await unlink(observed.path);
      }
      await observed.assertDirectories();
      await rmdir(stageDirectory);
      complete = true;
    }).catch(() => { throw new UpdateStagingError("CLEANUP_FAILED"); });
    const original = cleaning;
    void original.catch(() => { if (cleaning === original) cleaning = undefined; });
    return original;
  };
  return Object.freeze({ file, stageDirectory, artifactName,
    bytes: observed.bytes, assertUnchanged: observed.assertUnchanged, cleanup });
}

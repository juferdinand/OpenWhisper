import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import type { BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { LinuxInstalledLaunch } from "../../../main/linux-installed-launch.js";
import { verifyOwnedLinuxUpdateFile } from "./linux-update-file.js";
import { LinuxUpdateSignatureError, MAX_LINUX_UPDATE_BYTES, verifyLinuxUpdateStream } from "./linux-update-signature.js";
import { appImageLauncher } from "./linux-appimage-launcher.js";
import { isNewerUpdateVersion, parseUpdateVersion, UPDATE_POLICY_LIMITS } from "../common/update-policy.js";
import { assertPrivateUpdateDirectory, inspectOwnedUpdateFile, type OwnedUpdateDownload } from "../common/update-staging.js";

// Use physical files even when this consumer runs in embedded Electron Node.
const physicalFs = process.versions["electron"] ? createRequire(import.meta.url)("original-fs") as typeof nodeFs : nodeFs;
const { constants } = physicalFs;
const { link, lstat, mkdtemp, open, readdir, realpath, rename, rmdir, unlink } = physicalFs.promises;

type Failure = "INVALID_INPUT" | "INVALID_PACKAGE" | "SOURCE_CHANGED" | "PREPARE_FAILED" | "INSTALL_FAILED" | "ROLLBACK_FAILED" | "CLEANUP_FAILED" | "INVALID_STATE";
export class LinuxAppImageUpdateError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "LinuxAppImageUpdateError"; }
}
function fail(code: Failure): never { throw new LinuxAppImageUpdateError(code); }
const artifactName = "OpenWhisper-Linux-x86_64.AppImage";
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sameBytes = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.size === b.size && a.mtimeNs === b.mtimeNs;
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
async function optional(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }); } catch (error: unknown) { if (missing(error)) return undefined; throw error; }
}
/** A format check only. The fixed publisher signature is independently required. */
export function validateAppImageUpdateHeader(bytes: Buffer): void {
  if (bytes.length < 64 || !bytes.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])) ||
      !bytes.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2])) || ![2, 3].includes(bytes.readUInt16LE(16)) ||
      bytes.readUInt16LE(18) !== 62 || bytes.readUInt32LE(20) !== 1) fail("INVALID_PACKAGE");
}
async function observe(file: FileHandle, path: string, uid: bigint, mode: bigint, before?: BigIntStats,
  ownMetadataChange = false, links = 1n): Promise<BigIntStats> {
  const current = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
  if (!current.isFile() || !same(current, named) || current.uid !== uid || current.nlink !== links ||
      (current.mode & 0o7777n) !== mode || (before && (ownMetadataChange ? !sameBytes(before, current) : !same(before, current)))) fail("SOURCE_CHANGED");
  return current;
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function readBounded(file: FileHandle, path: string, uid: bigint, mode: bigint, identity: BigIntStats, limit: number): Promise<Buffer> {
  if (identity.size < 1n || identity.size > BigInt(limit)) fail("SOURCE_CHANGED");
  await observe(file, path, uid, mode, identity);
  const bytes = Buffer.alloc(Number(identity.size) + 1); let position = 0;
  while (position < bytes.length) {
    const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
    if (!bytesRead) break; position += bytesRead;
  }
  if (position !== Number(identity.size)) fail("SOURCE_CHANGED");
  await observe(file, path, uid, mode, identity); return bytes.subarray(0, position);
}
async function* fileChunks(file: FileHandle, path: string, uid: bigint, mode: bigint, identity: BigIntStats,
  guard: () => Promise<void>): AsyncGenerator<Buffer> {
  if (identity.size < 1n || identity.size > BigInt(MAX_LINUX_UPDATE_BYTES)) fail("SOURCE_CHANGED");
  const block = Buffer.alloc(64 * 1024), bytes = Number(identity.size); let position = 0;
  while (position < bytes) {
    await guard(); await observe(file, path, uid, mode, identity);
    const wanted = Math.min(block.length, bytes - position), { bytesRead } = await file.read(block, 0, wanted, position);
    if (bytesRead <= 0 || bytesRead > wanted) fail("SOURCE_CHANGED");
    position += bytesRead; yield block.subarray(0, bytesRead);
  }
  if ((await file.read(block, 0, 1, position)).bytesRead !== 0) fail("SOURCE_CHANGED");
  await guard(); await observe(file, path, uid, mode, identity);
}
function directories(directory: string, home: string, uid: bigint): ReadonlyMap<string, BigIntStats> {
  const result = new Map<string, BigIntStats>();
  for (let cursor = directory;; cursor = dirname(cursor)) {
    const value = physicalFs.lstatSync(cursor, { bigint: true }), mode = value.mode & 0o7777n;
    if (!value.isDirectory() || value.isSymbolicLink() || (value.uid !== uid && value.uid !== 0n) ||
        ((mode & 0o022n) !== 0n && !(value.uid === 0n && (mode & 0o1000n) !== 0n)) ||
        ((cursor === home || cursor.startsWith(`${home}/`)) && value.uid !== uid)) fail("SOURCE_CHANGED");
    result.set(cursor, value); if (dirname(cursor) === cursor) return result;
  }
}
function assertDirectories(before: ReadonlyMap<string, BigIntStats>): void {
  for (const [path, value] of before) {
    const current = physicalFs.lstatSync(path, { bigint: true });
    if (value.dev !== current.dev || value.ino !== current.ino || value.uid !== current.uid || value.mode !== current.mode) fail("SOURCE_CHANGED");
  }
}
/** Fixed current pair authentication only. Missing/stale signatures refuse this capability, not ordinary V1 launch.
 * The caller must separately supply genuine live installed-launch admission; metadata is not publisher authentication. */
export async function admitSignedAppImageLaunch(input: { readonly home: string; readonly version: string;
  readonly launch: Extract<LinuxInstalledLaunch, { kind: "appimage" }> }): Promise<Readonly<{ assertUnchanged(): void }>> {
  const { home, version, launch } = input, user = process.getuid?.();
  const image = join(home, ".local/lib/whisperfree/OpenWhisper.AppImage"), launcher = join(dirname(image), "openwhisper-launch"), signed = `${image}.sig`;
  try { parseUpdateVersion(version); } catch { return fail("INVALID_INPUT"); }
  if (process.platform !== "linux" || process.arch !== "x64" || user === undefined || user === 0 || !isAbsolute(home) ||
      resolve(home) !== home || /[\p{Cc}]/u.test(home) || await realpath(home).catch(() => fail("INVALID_INPUT")) !== home || launch.kind !== "appimage" ||
      launch.executable !== launcher || launch.arguments.length !== 1 || launch.arguments[0] !== image) fail("INVALID_INPUT");
  const uid = BigInt(user);
  let ancestors: ReadonlyMap<string, BigIntStats>;
  try { ancestors = directories(dirname(image), home, uid); } catch { return fail("SOURCE_CHANGED"); }
  let file: FileHandle | undefined, signatureFile: FileHandle | undefined, launcherFile: FileHandle | undefined;
  try {
    launch.assertUnchanged();
    file = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await file.stat({ bigint: true }), mode = initial.mode & 0o7777n;
    if ((mode & 0o7022n) !== 0n || (mode & 0o111n) === 0n) fail("SOURCE_CHANGED");
    const imageIdentity = await observe(file, image, uid, mode, initial);
    signatureFile = await open(signed, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const signatureIdentity = await signatureFile.stat({ bigint: true }), signatureMode = signatureIdentity.mode & 0o7777n;
    if (signatureMode !== 0o600n && signatureMode !== 0o644n) fail("SOURCE_CHANGED");
    const signatureBytes = await readBounded(signatureFile, signed, uid, signatureMode, signatureIdentity, UPDATE_POLICY_LIMITS.signatureBytes);
    launcherFile = await open(launcher, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const launcherIdentity = await launcherFile.stat({ bigint: true }), launcherMode = launcherIdentity.mode & 0o7777n;
    if ((launcherMode & 0o7022n) !== 0n || !(launcherMode & 0o111n) ||
        !(await readBounded(launcherFile, launcher, uid, launcherMode, launcherIdentity, 16 * 1024)).equals(Buffer.from(appImageLauncher()))) fail("SOURCE_CHANGED");
    const guard = async (): Promise<void> => { launch.assertUnchanged(); assertDirectories(ancestors);
      await observe(signatureFile!, signed, uid, signatureMode, signatureIdentity); };
    const header = Buffer.alloc(64);
    if ((await file.read(header, 0, 64, 0)).bytesRead !== 64) fail("INVALID_PACKAGE");
    validateAppImageUpdateHeader(header);
    await verifyLinuxUpdateStream(fileChunks(file, image, uid, mode, imageIdentity, guard), signatureBytes.toString("utf8"), version);
    const assertUnchanged = (): void => {
      try { launch.assertUnchanged(); assertDirectories(ancestors);
        for (const [path, identity] of [[image, imageIdentity], [signed, signatureIdentity], [launcher, launcherIdentity]] as const) {
          if (!same(identity, physicalFs.lstatSync(path, { bigint: true }))) fail("SOURCE_CHANGED");
        }
      } catch { fail("SOURCE_CHANGED"); }
    };
    assertUnchanged(); return Object.freeze({ assertUnchanged });
  } catch (error: unknown) {
    if (error instanceof LinuxUpdateSignatureError) throw error;
    if (error instanceof LinuxAppImageUpdateError) throw error; return fail("SOURCE_CHANGED");
  } finally {
    const closed = await Promise.allSettled([file?.close(), signatureFile?.close(), launcherFile?.close()]);
    if (closed.some((result) => result.status === "rejected")) fail("CLEANUP_FAILED");
  }
}
/** Explicit-check repair only. Supplied signature text grants no authority until the original current image verifies.
 * Missing/stale safely owned sidecars may be repaired; unexpected files and foreign publication races are preserved. */
export async function repairSignedAppImageLaunch(input: { readonly home: string; readonly version: string;
  readonly launch: Extract<LinuxInstalledLaunch, { kind: "appimage" }>; readonly signature: unknown },
  effects: Partial<AppImageUpdateEffects> = {}): Promise<Readonly<{ assertUnchanged(): void }>> {
  const { home, version, launch, signature } = input, user = process.getuid?.();
  const image = join(home, ".local/lib/whisperfree/OpenWhisper.AppImage"), launcher = join(dirname(image), "openwhisper-launch"), signed = `${image}.sig`;
  try { parseUpdateVersion(version); } catch { return fail("INVALID_INPUT"); }
  if (process.platform !== "linux" || process.arch !== "x64" || user === undefined || user === 0 || typeof signature !== "string" ||
      !isAbsolute(home) || resolve(home) !== home || /[\p{Cc}]/u.test(home) || await realpath(home) !== home ||
      launch.kind !== "appimage" || launch.executable !== launcher || launch.arguments.length !== 1 || launch.arguments[0] !== image) fail("INVALID_INPUT");
  const uid = BigInt(user), ancestors = directories(dirname(image), home, uid), io = { move: rename, publish: link, ...effects };
  let file: FileHandle | undefined, old: FileHandle | undefined, copy: FileHandle | undefined, launcherFile: FileHandle | undefined;
  let oldIdentity: BigIntStats | undefined, copyIdentity: BigIntStats | undefined, backupIdentity: BigIntStats | undefined;
  let stage: string | undefined, source = "", backup = "", publicationAttempted = false, committed = false;
  let stageGuard: Awaited<ReturnType<typeof assertPrivateUpdateDirectory>> | undefined;
  let admitted: Readonly<{ assertUnchanged(): void }> | undefined;
  const guard = async (): Promise<void> => { launch.assertUnchanged(); assertDirectories(ancestors); await stageGuard?.assertUnchanged(); };
  const removeCopy = async (): Promise<void> => {
    if (!copy || !copyIdentity || !await optional(source)) return;
    await guard();
    const current = await observe(copy, source, uid, copyIdentity.mode & 0o7777n);
    if (current.dev !== copyIdentity.dev || current.ino !== copyIdentity.ino) fail("SOURCE_CHANGED"); await unlink(source);
  };
  try {
    await guard();
    file = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const initial = await file.stat({ bigint: true }), mode = initial.mode & 0o7777n;
    if ((mode & 0o7022n) !== 0n || !(mode & 0o111n)) fail("SOURCE_CHANGED");
    const imageIdentity = await observe(file, image, uid, mode, initial);
    launcherFile = await open(launcher, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const launcherIdentity = await launcherFile.stat({ bigint: true }), launcherMode = launcherIdentity.mode & 0o7777n;
    if ((launcherMode & 0o7022n) !== 0n || !(launcherMode & 0o111n) ||
        !(await readBounded(launcherFile, launcher, uid, launcherMode, launcherIdentity, 16 * 1024)).equals(Buffer.from(appImageLauncher()))) fail("SOURCE_CHANGED");
    oldIdentity = await optional(signed);
    if (oldIdentity) {
      old = await open(signed, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const oldMode = oldIdentity.mode & 0o7777n;
      if (oldMode !== 0o600n && oldMode !== 0o644n) fail("SOURCE_CHANGED");
      await readBounded(old, signed, uid, oldMode, oldIdentity, UPDATE_POLICY_LIMITS.signatureBytes);
    }
    const current = async (): Promise<void> => {
      await guard(); await observe(launcherFile!, launcher, uid, launcherMode, launcherIdentity);
      if (old && oldIdentity) await observe(old, signed, uid, oldIdentity.mode & 0o7777n, oldIdentity);
      else if (await optional(signed)) fail("SOURCE_CHANGED");
    };
    const header = Buffer.alloc(64);
    if ((await file.read(header, 0, 64, 0)).bytesRead !== 64) fail("INVALID_PACKAGE"); validateAppImageUpdateHeader(header);
    await verifyLinuxUpdateStream(fileChunks(file, image, uid, mode, imageIdentity, current), signature, version);
    await current();
    // No sidecar or stage mutation happens before authentication of the original current image.
    stage = await mkdtemp(join(dirname(image), ".openwhisper-signature-"));
    stageGuard = await assertPrivateUpdateDirectory(stage); source = join(stage, "current.sig"); backup = join(stage, "previous.sig");
    copy = await open(source, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    copyIdentity = await observe(copy, source, uid, 0o600n);
    const bytes = Buffer.from(signature); let position = 0;
    while (position < bytes.length) {
      const { bytesWritten } = await copy.write(bytes, position, bytes.length - position, position);
      if (bytesWritten < 1 || bytesWritten > bytes.length - position) fail("PREPARE_FAILED"); position += bytesWritten;
    }
    copyIdentity = await observe(copy, source, uid, 0o600n); await copy.sync();
    await copy.chmod(0o644); copyIdentity = await observe(copy, source, uid, 0o644n, copyIdentity, true);
    await current(); await observe(file, image, uid, mode, imageIdentity);
    if (old && oldIdentity) {
      await io.move(signed, backup);
      backupIdentity = await observe(old, backup, uid, oldIdentity.mode & 0o7777n, oldIdentity, true);
    }
    await guard(); await observe(file, image, uid, mode, imageIdentity);
    publicationAttempted = true; await io.publish(source, signed);
    const linked = await observe(copy, signed, uid, 0o644n, copyIdentity, true, 2n);
    await observe(copy, source, uid, 0o644n, linked, false, 2n); await unlink(source);
    copyIdentity = await observe(copy, signed, uid, 0o644n, linked, true);
    await syncDirectory(dirname(image)); await syncDirectory(stage);
    admitted = await admitSignedAppImageLaunch({ home, version, launch }); admitted.assertUnchanged(); committed = true;
    if (old && oldIdentity && backupIdentity) {
      await guard(); await observe(old, backup, uid, oldIdentity.mode & 0o7777n, backupIdentity); await unlink(backup); backupIdentity = undefined;
    }
    await guard(); await rmdir(stage); stage = undefined;
  } catch (error: unknown) {
    if (committed) return fail("CLEANUP_FAILED");
    try {
      await guard();
      // A move/publish effect may finish and then throw. Inspect only the original owned descriptors/inodes.
      if (!backupIdentity && old && oldIdentity && backup && await optional(backup)) {
        backupIdentity = await observe(old, backup, uid, oldIdentity.mode & 0o7777n, oldIdentity, true);
      }
      if (publicationAttempted && copy && copyIdentity && await optional(signed)) {
        const staged = await optional(source), links = staged ? 2n : 1n;
        const published = await observe(copy, signed, uid, 0o644n, copyIdentity, true, links);
        if (!staged) {
          await link(signed, source);
          await observe(copy, source, uid, 0o644n, published, true, 2n);
        }
        await unlink(signed); copyIdentity = await observe(copy, source, uid, 0o644n, published, true);
      }
      if (old && oldIdentity && backupIdentity) {
        if (await optional(signed)) fail("ROLLBACK_FAILED");
        await observe(old, backup, uid, oldIdentity.mode & 0o7777n, backupIdentity);
        await link(backup, signed);
        const linked = await observe(old, signed, uid, oldIdentity.mode & 0o7777n, backupIdentity, true, 2n);
        await observe(old, backup, uid, oldIdentity.mode & 0o7777n, linked, false, 2n); await unlink(backup); backupIdentity = undefined;
      }
      await removeCopy();
      if (stage) { await guard(); await rmdir(stage); stage = undefined; }
    } catch { return fail("ROLLBACK_FAILED"); }
    if (error instanceof LinuxUpdateSignatureError || error instanceof LinuxAppImageUpdateError) throw error;
    return fail("PREPARE_FAILED");
  } finally {
    const results = await Promise.allSettled([file?.close(), old?.close(), copy?.close(), launcherFile?.close()]);
    if (results.some((result) => result.status === "rejected")) fail("CLEANUP_FAILED");
  }
  if (!admitted) fail("PREPARE_FAILED"); admitted.assertUnchanged(); return admitted;
}
/** Synthetic filesystem faults only; production uses fixed same-filesystem rename/link operations. */
export interface AppImageUpdateEffects { move(from: string, to: string): Promise<void>; publish(from: string, to: string): Promise<void> }
export interface PreparedAppImageUpdate {
  readonly version: string; readonly bytes: number;
  /** One original transaction; success does not establish application retirement or restart. */
  install(): Promise<void>;
  assertInstalled(): Promise<void>;
  /** Restore only this transaction's retained predecessor, never overwrite a foreign destination. */
  rollback(): Promise<void>;
  /** Caller explicitly accepts the installed handoff before removing the retained predecessor. */
  commit(): Promise<void>;
  /** Cancel preparation or clean a failed transaction whose predecessor was restored. */
  discard(): Promise<void>;
  /** Preserve a private recovery hint and predecessor; no successful exec or next-generation acceptance is implied. */
  prepareExecContinuation(): Promise<Readonly<AppImageExecContinuation>>;
}
export interface AppImageExecContinuation {
  /** Reauthenticate the fixed installed image, settling all temporary descriptors before returning. */
  assertInstalledForExec(): Promise<void>;
  /** Synchronous physical metadata observation after full reauthentication and descriptor settlement; no CAS/adversary claim. */
  assertForExec(): void;
  /** Same original parent only, after exec refused; never reads a persisted record as authority. */
  rollbackBeforeExec(): Promise<void>;
}

/** Inactive host consumer. Production must first obtain admitSignedAppImageLaunch and recheck it through preparation/install.
 * This transaction preserves predecessor bytes/metadata; its inert filesystem tests do not grant signed-current admission.
 * The caller retains the original download and parent-owned restart/signature handoff. */
export async function prepareAppImageUpdate(input: {
  readonly download: OwnedUpdateDownload; readonly signature: unknown; readonly expectedVersion: string; readonly currentVersion: string;
  readonly home: string; readonly launch: Extract<LinuxInstalledLaunch, { kind: "appimage" }>;
}, effects: Partial<AppImageUpdateEffects> = {}): Promise<Readonly<PreparedAppImageUpdate>> {
  const { download, signature, expectedVersion, currentVersion, home, launch } = input, user = process.getuid?.();
  const image = join(home, ".local/lib/whisperfree/OpenWhisper.AppImage"), launcher = join(dirname(image), "openwhisper-launch"), signaturePath = `${image}.sig`;
  if (process.platform !== "linux" || process.arch !== "x64" || user === undefined || user === 0 || download.artifactName !== artifactName ||
      !isNewerUpdateVersion(expectedVersion, currentVersion) || !isAbsolute(home) || resolve(home) !== home || /[\p{Cc}]/u.test(home) ||
      launch.kind !== "appimage" || launch.executable !== launcher || launch.arguments.length !== 1 || launch.arguments[0] !== image ||
      await realpath(home) !== home) return fail("INVALID_INPUT");
  const uid = BigInt(user), io: AppImageUpdateEffects = { move: rename, publish: link, ...effects };
  const original = await inspectOwnedUpdateFile(download);
  await verifyOwnedLinuxUpdateFile({ ...download, artifactName, signature, version: expectedVersion });
  if (typeof signature !== "string") fail("INVALID_INPUT");
  let oldSignature: FileHandle | undefined, signatureCopy: FileHandle | undefined, signatureCopyIdentity: BigIntStats | undefined;
  let oldSignatureIdentity: BigIntStats | undefined, installedSignature: BigIntStats | undefined, backupSignatureIdentity: BigIntStats | undefined;
  const assertOriginal = async (): Promise<void> => {
    try { launch.assertUnchanged(); await original.assertUnchanged(); await download.assertUnchanged();
      if (oldSignature && oldSignatureIdentity) await observe(oldSignature, signaturePath, uid, oldSignatureIdentity.mode & 0o7777n, oldSignatureIdentity); }
    catch { fail("SOURCE_CHANGED"); }
  };
  await assertOriginal();
  const launcherIdentity = await lstat(launcher, { bigint: true });
  const old = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let signatureSource = "", signatureBackup = "";
  let continuationDirectories: ReadonlyMap<string, BigIntStats> | undefined;
  let copy: FileHandle | undefined, directory: string | undefined, directoryGuard: Awaited<ReturnType<typeof assertPrivateUpdateDirectory>> | undefined;
  let oldIdentity: BigIntStats, copyIdentity: BigIntStats | undefined;
  let source: string | undefined, backup: string | undefined, backupIdentity: BigIntStats | undefined;
  const guard = async (): Promise<void> => {
    try {
      await directoryGuard?.assertUnchanged();
      if (!same(launcherIdentity, await lstat(launcher, { bigint: true }))) fail("SOURCE_CHANGED");
    } catch { fail("SOURCE_CHANGED"); }
  };
  let closing: Promise<void> | undefined;
  const closeOwned = (): Promise<void> => closing ??= Promise.allSettled([copy?.close(), old.close(), signatureCopy?.close(), oldSignature?.close()]).then((results) => {
    if (results.some((result) => result.status === "rejected")) fail("CLEANUP_FAILED");
  });
  const removeCopy = async (file = copy, signedFile = signatureCopy): Promise<void> => {
    if (signedFile && signatureSource && signatureCopyIdentity && await optional(signatureSource)) {
      await guard(); await observe(signedFile, signatureSource, uid, signatureCopyIdentity.mode & 0o7777n); await unlink(signatureSource);
    }
    if (!file || !source || !copyIdentity) return;
    await guard(); const named = await optional(source);
    // Cleanup owns this descriptor/inode; partial own writes are not installation authority.
    if (named) { await observe(file, source, uid, copyIdentity.mode & 0o7777n); await unlink(source); }
  };
  try {
    const initial = await old.stat({ bigint: true }), mode = initial.mode & 0o7777n;
    if ((mode & 0o7022n) !== 0n || (mode & 0o111n) === 0n) fail("SOURCE_CHANGED");
    oldIdentity = await observe(old, image, uid, mode, initial);
    oldSignature = await open(signaturePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    oldSignatureIdentity = await oldSignature.stat({ bigint: true });
    const signatureMode = oldSignatureIdentity.mode & 0o7777n;
    if (signatureMode !== 0o600n && signatureMode !== 0o644n) fail("SOURCE_CHANGED");
    await readBounded(oldSignature, signaturePath, uid, signatureMode, oldSignatureIdentity, UPDATE_POLICY_LIMITS.signatureBytes);
    await assertOriginal();
    directory = await mkdtemp(join(dirname(image), ".openwhisper-update-"));
    directoryGuard = await assertPrivateUpdateDirectory(directory);
    continuationDirectories = directories(directory, home, uid);
    source = join(directory, artifactName); backup = join(directory, "previous.AppImage");
    signatureSource = `${source}.sig`; signatureBackup = `${backup}.sig`;
    signatureCopy = await open(signatureSource, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    signatureCopyIdentity = await observe(signatureCopy, signatureSource, uid, 0o600n);
    const signatureBytes = Buffer.from(signature); let signaturePosition = 0;
    while (signaturePosition < signatureBytes.length) {
      const { bytesWritten } = await signatureCopy.write(signatureBytes, signaturePosition, signatureBytes.length - signaturePosition, signaturePosition);
      if (!bytesWritten) fail("PREPARE_FAILED"); signaturePosition += bytesWritten;
    }
    signatureCopyIdentity = await observe(signatureCopy, signatureSource, uid, 0o600n);
    await signatureCopy.sync();
    copy = await open(source, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const acquiredCopy = await observe(copy, source, uid, 0o600n);
    copyIdentity = acquiredCopy;
    const block = Buffer.alloc(64 * 1024); let position = 0;
    while (position < original.bytes) {
      const wanted = Math.min(block.length, original.bytes - position), { bytesRead } = await download.file.read(block, 0, wanted, position);
      if (bytesRead <= 0 || bytesRead > wanted) fail("SOURCE_CHANGED");
      let written = 0;
      while (written < bytesRead) {
        const result = await copy.write(block, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) fail("PREPARE_FAILED"); written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if ((await download.file.read(block, 0, 1, position)).bytesRead !== 0) fail("SOURCE_CHANGED");
    // Own positioned writes change only this newly acquired file. Capture them before verification/cleanup.
    copyIdentity = await observe(copy, source, uid, 0o600n);
    if (copyIdentity.dev !== acquiredCopy.dev || copyIdentity.ino !== acquiredCopy.ino) fail("SOURCE_CHANGED");
    await assertOriginal(); await copy.sync();
    await verifyOwnedLinuxUpdateFile({ file: copy, stageDirectory: directory, artifactName, signature, version: expectedVersion });
    const header = Buffer.alloc(64);
    if ((await copy.read(header, 0, header.length, 0)).bytesRead !== header.length) fail("INVALID_PACKAGE");
    validateAppImageUpdateHeader(header);
    copyIdentity = await observe(copy, source, uid, 0o600n);
    await copy.chmod(0o755); copyIdentity = await observe(copy, source, uid, 0o755n, copyIdentity, true);
    await copy.sync(); await guard(); await assertOriginal();
  } catch (error: unknown) {
    // Never recursively remove this stage or delete an uncertain replacement.
    try { await removeCopy(); } catch { /* Preserve uncertain owned stage for diagnosis. */ }
    await closeOwned().catch(() => {}); if (directory) await rmdir(directory).catch(() => {});
    if (error instanceof LinuxAppImageUpdateError) throw error;
    return fail("PREPARE_FAILED");
  }
  const candidate = copy!, stage = directory!, preparedPath = source!, previousPath = backup!;
  let phase: "prepared" | "installing" | "installed" | "continuing" | "continued" | "rolling-back" | "failed" | "closed" = "prepared", installed: BigIntStats | undefined;
  let installing: Promise<void> | undefined, finishing: { kind: "rollback" | "commit" | "discard"; promise: Promise<void> } | undefined;
  const assertCandidate = async (): Promise<void> => {
    if (!installed) fail("INVALID_STATE");
    await guard(); await observe(candidate, image, uid, 0o755n, installed);
    if (!installedSignature || !signatureCopy) fail("SOURCE_CHANGED");
    await observe(signatureCopy, signaturePath, uid, 0o644n, installedSignature);
  };
  const assertInstalled = async (): Promise<void> => {
    if (phase !== "installed") fail("INVALID_STATE");
    await assertCandidate();
  };
  const restore = async (predecessor = old): Promise<void> => {
    if (!backupIdentity) fail("ROLLBACK_FAILED");
    await guard(); await observe(predecessor, previousPath, uid, oldIdentity.mode & 0o7777n, backupIdentity);
    if (await optional(image)) fail("ROLLBACK_FAILED");
    await link(previousPath, image);
    const linked = await observe(predecessor, image, uid, oldIdentity.mode & 0o7777n, backupIdentity, true, 2n);
    await observe(predecessor, previousPath, uid, oldIdentity.mode & 0o7777n, linked, false, 2n);
    await unlink(previousPath); oldIdentity = await observe(predecessor, image, uid, oldIdentity.mode & 0o7777n, linked, true);
    backupIdentity = undefined; await syncDirectory(dirname(image)); await syncDirectory(stage);
  };
  const restoreSignature = async (predecessor = oldSignature): Promise<void> => {
    if (!oldSignatureIdentity || !predecessor) fail("ROLLBACK_FAILED");
    const mode = oldSignatureIdentity.mode & 0o7777n;
    if (!backupSignatureIdentity) { await observe(predecessor, signaturePath, uid, mode, oldSignatureIdentity); return; }
    await guard(); await observe(predecessor, signatureBackup, uid, mode, backupSignatureIdentity);
    if (await optional(signaturePath)) fail("ROLLBACK_FAILED");
    await link(signatureBackup, signaturePath);
    const linked = await observe(predecessor, signaturePath, uid, mode, backupSignatureIdentity, true, 2n);
    await observe(predecessor, signatureBackup, uid, mode, linked, false, 2n);
    await unlink(signatureBackup); oldSignatureIdentity = await observe(predecessor, signaturePath, uid, mode, linked, true);
    backupSignatureIdentity = undefined; await syncDirectory(dirname(image)); await syncDirectory(stage);
  };
  const withdrawSignature = async (published = signatureCopy): Promise<void> => {
    if (!backupSignatureIdentity) return;
    await guard(); if (!await optional(signaturePath)) return;
    if (!published || !signatureCopyIdentity) fail("ROLLBACK_FAILED");
    const staged = await optional(signatureSource), links = staged ? 2n : 1n;
    const current = await observe(published, signaturePath, uid, 0o644n, installedSignature ?? signatureCopyIdentity, true, links);
    if (staged) { await observe(published, signatureSource, uid, 0o644n, current, false, 2n); await unlink(signaturePath); }
    else await io.move(signaturePath, signatureSource);
    signatureCopyIdentity = await observe(published, signatureSource, uid, 0o644n, current, true);
  };
  const withdrawCandidate = async (published = candidate): Promise<void> => {
    await guard();
    const target = await optional(image);
    if (!target) return;
    const expected = installed ?? copyIdentity;
    if (!expected) fail("ROLLBACK_FAILED");
    const staged = await optional(preparedPath), links = staged ? 2n : 1n;
    const observed = await observe(published, image, uid, 0o755n, expected, true, links);
    if (staged) {
      await observe(published, preparedPath, uid, 0o755n, observed, false, 2n);
      await unlink(image);
    } else await io.move(image, preparedPath);
    copyIdentity = await observe(published, preparedPath, uid, 0o755n, observed, true);
  };
  const install = (): Promise<void> => {
    if (installing) return installing;
    if (phase !== "prepared" || finishing) return Promise.reject(new LinuxAppImageUpdateError("INVALID_STATE"));
    // Claim the transaction synchronously; discard cannot race an awaited installation guard.
    phase = "installing";
    return installing = Promise.resolve().then(async () => {
    try {
      await assertOriginal(); await guard(); await observe(old, image, uid, oldIdentity.mode & 0o7777n, oldIdentity);
      copyIdentity = await observe(candidate, preparedPath, uid, 0o755n, copyIdentity);
      await io.move(image, previousPath);
      backupIdentity = await observe(old, previousPath, uid, oldIdentity.mode & 0o7777n, oldIdentity, true);
      if (!oldSignature || !oldSignatureIdentity || !signatureCopy || !signatureCopyIdentity) fail("SOURCE_CHANGED");
      await io.move(signaturePath, signatureBackup);
      backupSignatureIdentity = await observe(oldSignature, signatureBackup, uid, oldSignatureIdentity.mode & 0o7777n, oldSignatureIdentity, true);
      await guard(); await io.publish(preparedPath, image);
      const linked = await observe(candidate, image, uid, 0o755n, copyIdentity, true, 2n);
      await observe(candidate, preparedPath, uid, 0o755n, linked, false, 2n);
      await unlink(preparedPath);
      installed = await observe(candidate, image, uid, 0o755n, linked, true);
      await observe(signatureCopy, signatureSource, uid, 0o600n, signatureCopyIdentity);
      await signatureCopy.chmod(0o644); signatureCopyIdentity = await observe(signatureCopy, signatureSource, uid, 0o644n, signatureCopyIdentity, true);
      await io.publish(signatureSource, signaturePath);
      const signedLinked = await observe(signatureCopy, signaturePath, uid, 0o644n, signatureCopyIdentity, true, 2n);
      await observe(signatureCopy, signatureSource, uid, 0o644n, signedLinked, false, 2n);
      await unlink(signatureSource); installedSignature = await observe(signatureCopy, signaturePath, uid, 0o644n, signedLinked, true);
      await syncDirectory(dirname(image)); await syncDirectory(stage); phase = "installed"; await assertInstalled();
    } catch {
      phase = "failed";
      try {
        // A filesystem effect may complete its rename and then report failure. Admit only our old inode.
        if (!backupIdentity && await optional(previousPath)) {
          backupIdentity = await observe(old, previousPath, uid, oldIdentity.mode & 0o7777n, oldIdentity, true);
        }
        if (!backupSignatureIdentity && oldSignature && oldSignatureIdentity && await optional(signatureBackup)) {
          backupSignatureIdentity = await observe(oldSignature, signatureBackup, uid, oldSignatureIdentity.mode & 0o7777n, oldSignatureIdentity, true);
        }
        if (backupIdentity) { await withdrawSignature(); await withdrawCandidate(); await restore(); await restoreSignature(); }
      } catch {
        await closeOwned().catch(() => {}); return fail("ROLLBACK_FAILED");
      }
      return fail(backupIdentity ? "ROLLBACK_FAILED" : "INSTALL_FAILED");
    }
    });
  };
  const finish = (kind: "rollback" | "commit" | "discard"): Promise<void> => {
    if (finishing) return finishing.kind === kind ? finishing.promise : Promise.reject(new LinuxAppImageUpdateError("INVALID_STATE"));
    if (kind === "discard" ? (phase !== "prepared" && phase !== "failed") || backupIdentity !== undefined : phase !== "installed") return Promise.reject(new LinuxAppImageUpdateError("INVALID_STATE"));
    const promise = Promise.resolve().then(async () => {
      try {
        await guard();
        if (kind !== "discard") {
          await assertInstalled();
          if (kind === "rollback") {
            await withdrawSignature(); await withdrawCandidate();
            await restore(); await restoreSignature();
          } else {
            if (!backupIdentity) fail("INVALID_STATE");
            if (!oldSignature || !oldSignatureIdentity || !backupSignatureIdentity) fail("SOURCE_CHANGED");
            await observe(oldSignature, signatureBackup, uid, oldSignatureIdentity.mode & 0o7777n, backupSignatureIdentity);
            await observe(old, previousPath, uid, oldIdentity.mode & 0o7777n, backupIdentity);
            await unlink(previousPath); backupIdentity = undefined; await unlink(signatureBackup); backupSignatureIdentity = undefined;
          }
        }
        await removeCopy(); await closeOwned(); await guard(); await rmdir(stage); await syncDirectory(dirname(image)); phase = "closed";
      } catch {
        await closeOwned().catch(() => {});
        return fail(kind === "rollback" ? "ROLLBACK_FAILED" : "CLEANUP_FAILED");
      }
    });
    finishing = { kind, promise }; return promise;
  };
  const recordPath = join(stage, "continuation.json");
  let recordIdentity: BigIntStats | undefined, continuing: Promise<Readonly<AppImageExecContinuation>> | undefined;
  const authenticateInstalled = async (file: FileHandle): Promise<void> => {
    const identity = installed ?? fail("INVALID_STATE");
    if (!installedSignature) fail("SOURCE_CHANGED");
    const signedFile = await open(signaturePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const currentSignature = await readBounded(signedFile, signaturePath, uid, 0o644n, installedSignature, UPDATE_POLICY_LIMITS.signatureBytes);
      if (!currentSignature.equals(Buffer.from(signature))) fail("SOURCE_CHANGED");
      await verifyLinuxUpdateStream(fileChunks(file, image, uid, 0o755n, identity, guard), currentSignature.toString("utf8"), expectedVersion);
      await observe(signedFile, signaturePath, uid, 0o644n, installedSignature);
    } finally { await signedFile.close(); }
  };
  const assertLauncher = async (): Promise<void> => {
    await guard();
    const file = await open(launcher, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const template = Buffer.from(appImageLauncher());
      if (launcherIdentity.size !== BigInt(template.length)) fail("SOURCE_CHANGED");
      if (!(await readBounded(file, launcher, uid, launcherIdentity.mode & 0o7777n, launcherIdentity, 16 * 1024)).equals(template)) fail("SOURCE_CHANGED");
      await observe(file, launcher, uid, launcherIdentity.mode & 0o7777n, launcherIdentity); await guard();
    } finally { await file.close(); }
  };
  const assertRecord = async (): Promise<void> => {
    await guard();
    const names = (await readdir(stage)).sort();
    if (!recordIdentity || !same(recordIdentity, await lstat(recordPath, { bigint: true })) ||
        !backupIdentity || !same(backupIdentity, await lstat(previousPath, { bigint: true })) ||
        !backupSignatureIdentity || !same(backupSignatureIdentity, await lstat(signatureBackup, { bigint: true })) ||
        names.length !== 3 || names[0] !== "continuation.json" || names[1] !== "previous.AppImage" || names[2] !== "previous.AppImage.sig") fail("SOURCE_CHANGED");
  };
  const encodeIdentity = (value: BigIntStats) => Object.fromEntries(
    (["dev", "ino", "uid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const).map((key) => [key, value[key].toString()]));
  const prepareExecContinuation = (): Promise<Readonly<AppImageExecContinuation>> => {
    if (continuing) return continuing;
    if (phase !== "installed" || finishing) return Promise.reject(new LinuxAppImageUpdateError("INVALID_STATE"));
    phase = "continuing";
    return continuing = Promise.resolve().then(async () => {
      let record: FileHandle | undefined, recordClosing: Promise<void> | undefined;
      try {
        await assertCandidate(); await assertLauncher();
        const predecessorIdentity = backupIdentity ?? fail("SOURCE_CHANGED");
        if ((await readdir(stage)).sort().join() !== "previous.AppImage,previous.AppImage.sig") fail("SOURCE_CHANGED");
        await observe(old, previousPath, uid, oldIdentity.mode & 0o7777n, predecessorIdentity);
        await authenticateInstalled(candidate);
        const hash = createHash("sha256");
        for await (const chunk of fileChunks(old, previousPath, uid, oldIdentity.mode & 0o7777n, predecessorIdentity, guard)) hash.update(chunk);
        const directoryIdentity = await lstat(stage, { bigint: true });
        const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, artifact: artifactName, stage: basename(stage),
          predecessorVersion: currentVersion, installedVersion: expectedVersion, signature,
          directory: { dev: directoryIdentity.dev.toString(), ino: directoryIdentity.ino.toString(),
            uid: directoryIdentity.uid.toString(), mode: directoryIdentity.mode.toString() },
          launcher: encodeIdentity(launcherIdentity), installed: encodeIdentity(installed!),
          installedSignature: encodeIdentity(installedSignature!), predecessorSignature: encodeIdentity(backupSignatureIdentity!),
          predecessor: encodeIdentity(predecessorIdentity), predecessorSha256: hash.digest("hex") }));
        if (bytes.length > 32 * 1024) fail("INVALID_INPUT");
        await guard();
        record = await open(recordPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        recordIdentity = await observe(record, recordPath, uid, 0o600n);
        let position = 0;
        while (position < bytes.length) {
          const { bytesWritten } = await record.write(bytes, position, bytes.length - position, position);
          if (!bytesWritten) fail("PREPARE_FAILED"); position += bytesWritten;
        }
        recordIdentity = await observe(record, recordPath, uid, 0o600n);
        await record.sync(); await syncDirectory(stage); await syncDirectory(dirname(image));
        await assertRecord(); await assertCandidate(); await observe(old, previousPath, uid, oldIdentity.mode & 0o7777n, backupIdentity);
        recordClosing = record.close(); await recordClosing; record = undefined;
        await closeOwned(); phase = "continued";
      } catch (error: unknown) {
        // Until original closure starts, the existing same-parent rollback still owns its original handles.
        let uncertain = false;
        if (record && !recordClosing) {
          try { await guard(); await observe(record, recordPath, uid, 0o600n); await unlink(recordPath); }
          catch { uncertain = true; }
          await record.close().catch(() => { uncertain = true; });
        } else if (recordClosing && record) {
          uncertain = true;
        } else if (recordIdentity && !closing) {
          try { await guard(); if (!same(recordIdentity, await lstat(recordPath, { bigint: true }))) fail("SOURCE_CHANGED"); await unlink(recordPath); }
          catch { uncertain = true; }
        }
        phase = closing || uncertain ? "failed" : "installed";
        if (phase === "failed") await closeOwned().catch(() => {});
        if (error instanceof LinuxAppImageUpdateError) throw error;
        return fail("PREPARE_FAILED");
      }
      let checking: Promise<void> | undefined, rollingBack: Promise<void> | undefined;
      let finalDirectories: ReadonlyMap<string, BigIntStats> | undefined;
      const assertForExec = (): void => {
        if (phase !== "continued" || !finalDirectories) fail("INVALID_STATE");
        try {
          assertDirectories(finalDirectories);
          for (const [path, identity] of [[image, installed], [signaturePath, installedSignature], [launcher, launcherIdentity],
            [recordPath, recordIdentity], [previousPath, backupIdentity], [signatureBackup, backupSignatureIdentity]] as const) {
            if (!identity || !same(identity, physicalFs.lstatSync(path, { bigint: true }))) fail("SOURCE_CHANGED");
          }
          if (physicalFs.readdirSync(stage).sort().join() !== "continuation.json,previous.AppImage,previous.AppImage.sig") fail("SOURCE_CHANGED");
        } catch { finalDirectories = undefined; fail("SOURCE_CHANGED"); }
      };
      const assertInstalledForExec = (): Promise<void> => {
        if (phase !== "continued") return Promise.reject(new LinuxAppImageUpdateError("INVALID_STATE"));
        if (checking) return checking;
        finalDirectories = undefined;
        const operation = Promise.resolve().then(async () => {
          await assertRecord(); await assertLauncher();
          const file = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { await authenticateInstalled(file); await assertRecord(); }
          finally { await file.close(); }
          // All original candidate/predecessor and temporary authentication descriptors are closed.
          finalDirectories = continuationDirectories; assertForExec();
        });
        checking = operation;
        void operation.finally(() => { if (checking === operation) checking = undefined; }).catch(() => {});
        return operation;
      };
      const rollbackBeforeExec = (): Promise<void> => {
        if (rollingBack) return rollingBack;
        if (phase !== "continued") return Promise.reject(new LinuxAppImageUpdateError("INVALID_STATE"));
        phase = "rolling-back"; finalDirectories = undefined;
        const originalCheck = checking;
        return rollingBack = Promise.resolve().then(async () => {
          let published: FileHandle | undefined, predecessor: FileHandle | undefined,
            publishedSignature: FileHandle | undefined, predecessorSignature: FileHandle | undefined;
          try {
            await originalCheck; await assertRecord(); await assertLauncher();
            published = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            predecessor = await open(previousPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            publishedSignature = await open(signaturePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            predecessorSignature = await open(signatureBackup, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            await authenticateInstalled(published);
            if (!backupIdentity) fail("ROLLBACK_FAILED");
            await observe(predecessor, previousPath, uid, oldIdentity.mode & 0o7777n, backupIdentity);
            await assertRecord(); await withdrawSignature(publishedSignature); await withdrawCandidate(published);
            await restore(predecessor); await restoreSignature(predecessorSignature); await removeCopy(published, publishedSignature);
            if (!recordIdentity || !same(recordIdentity, await lstat(recordPath, { bigint: true }))) fail("SOURCE_CHANGED");
            await unlink(recordPath);
          } catch { fail("ROLLBACK_FAILED"); }
          finally {
            const results = await Promise.allSettled([published?.close(), predecessor?.close(), publishedSignature?.close(), predecessorSignature?.close()]);
            if (results.some((result) => result.status === "rejected")) fail("CLEANUP_FAILED");
          }
          await guard(); await rmdir(stage); await syncDirectory(dirname(image)); phase = "closed";
        });
      };
      return Object.freeze({ assertInstalledForExec, assertForExec, rollbackBeforeExec });
    });
  };
  return Object.freeze({ version: expectedVersion, bytes: original.bytes, install, assertInstalled, prepareExecContinuation,
    rollback: () => finish("rollback"), commit: () => finish("commit"), discard: () => finish("discard") });
}

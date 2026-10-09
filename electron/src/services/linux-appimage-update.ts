import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdtemp, open, readdir, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { LinuxInstalledLaunch } from "../main/linux-installed-launch.js";
import { verifyOwnedLinuxUpdateFile } from "./linux-update-file.js";
import { MAX_LINUX_UPDATE_BYTES, verifyLinuxUpdateStream } from "./linux-update-signature.js";
import { appImageLauncher } from "./linux-appimage-launcher.js";
import { isNewerUpdateVersion } from "./update-policy.js";
import { assertPrivateUpdateDirectory, inspectOwnedUpdateFile, type OwnedUpdateDownload } from "./update-staging.js";

type Failure = "INVALID_INPUT" | "INVALID_PACKAGE" | "SOURCE_CHANGED" | "PREPARE_FAILED" | "INSTALL_FAILED" | "ROLLBACK_FAILED" | "CLEANUP_FAILED" | "INVALID_STATE";
export class LinuxAppImageUpdateError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "LinuxAppImageUpdateError"; }
}
const fail = (code: Failure): never => { throw new LinuxAppImageUpdateError(code); };
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
  /** Same original parent only, after exec refused; never reads a persisted record as authority. */
  rollbackBeforeExec(): Promise<void>;
}

/** Inactive host consumer. The caller retains the original download and parent-owned restart/signature handoff. */
export async function prepareAppImageUpdate(input: {
  readonly download: OwnedUpdateDownload; readonly signature: unknown; readonly expectedVersion: string; readonly currentVersion: string;
  readonly home: string; readonly launch: Extract<LinuxInstalledLaunch, { kind: "appimage" }>;
}, effects: Partial<AppImageUpdateEffects> = {}): Promise<Readonly<PreparedAppImageUpdate>> {
  const { download, signature, expectedVersion, currentVersion, home, launch } = input, user = process.getuid?.();
  const image = join(home, ".local/lib/whisperfree/OpenWhisper.AppImage"), launcher = join(dirname(image), "openwhisper-launch");
  if (process.platform !== "linux" || process.arch !== "x64" || user === undefined || user === 0 || download.artifactName !== artifactName ||
      !isNewerUpdateVersion(expectedVersion, currentVersion) || !isAbsolute(home) || resolve(home) !== home || /[\p{Cc}]/u.test(home) ||
      launch.kind !== "appimage" || launch.executable !== launcher || launch.arguments.length !== 1 || launch.arguments[0] !== image ||
      await realpath(home) !== home) return fail("INVALID_INPUT");
  const uid = BigInt(user), io: AppImageUpdateEffects = { move: rename, publish: link, ...effects };
  const original = await inspectOwnedUpdateFile(download);
  await verifyOwnedLinuxUpdateFile({ ...download, artifactName, signature, version: expectedVersion });
  const assertOriginal = async (): Promise<void> => {
    try { launch.assertUnchanged(); await original.assertUnchanged(); await download.assertUnchanged(); }
    catch { fail("SOURCE_CHANGED"); }
  };
  await assertOriginal();
  const launcherIdentity = await lstat(launcher, { bigint: true });
  const old = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
  const closeOwned = (): Promise<void> => closing ??= Promise.allSettled([copy?.close(), old.close()]).then((results) => {
    if (results.some((result) => result.status === "rejected")) fail("CLEANUP_FAILED");
  });
  const removeCopy = async (file = copy): Promise<void> => {
    if (!file || !source || !copyIdentity) return;
    await guard(); const named = await optional(source);
    // Cleanup owns this descriptor/inode; partial own writes are not installation authority.
    if (named) { await observe(file, source, uid, copyIdentity.mode & 0o7777n); await unlink(source); }
  };
  try {
    const initial = await old.stat({ bigint: true }), mode = initial.mode & 0o7777n;
    if ((mode & 0o7022n) !== 0n || (mode & 0o111n) === 0n) fail("SOURCE_CHANGED");
    oldIdentity = await observe(old, image, uid, mode, initial);
    await assertOriginal();
    directory = await mkdtemp(join(dirname(image), ".openwhisper-update-"));
    directoryGuard = await assertPrivateUpdateDirectory(directory);
    source = join(directory, artifactName); backup = join(directory, "previous.AppImage");
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
      await guard(); await io.publish(preparedPath, image);
      const linked = await observe(candidate, image, uid, 0o755n, copyIdentity, true, 2n);
      await observe(candidate, preparedPath, uid, 0o755n, linked, false, 2n);
      await unlink(preparedPath);
      installed = await observe(candidate, image, uid, 0o755n, linked, true);
      await syncDirectory(dirname(image)); await syncDirectory(stage); phase = "installed"; await assertInstalled();
    } catch {
      phase = "failed";
      try {
        // A filesystem effect may complete its rename and then report failure. Admit only our old inode.
        if (!backupIdentity && await optional(previousPath)) {
          backupIdentity = await observe(old, previousPath, uid, oldIdentity.mode & 0o7777n, oldIdentity, true);
        }
        if (backupIdentity) { await withdrawCandidate(); await restore(); }
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
            await withdrawCandidate();
            await restore();
          } else {
            if (!backupIdentity) fail("INVALID_STATE");
            await observe(old, previousPath, uid, oldIdentity.mode & 0o7777n, backupIdentity); await unlink(previousPath); backupIdentity = undefined;
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
  async function* chunks(file: FileHandle, path: string, mode: bigint, identity: BigIntStats): AsyncGenerator<Buffer> {
    if (identity.size < 1n || identity.size > BigInt(MAX_LINUX_UPDATE_BYTES)) fail("SOURCE_CHANGED");
    const block = Buffer.alloc(64 * 1024), bytes = Number(identity.size);
    let position = 0;
    while (position < bytes) {
      await guard(); await observe(file, path, uid, mode, identity);
      const wanted = Math.min(block.length, bytes - position), { bytesRead } = await file.read(block, 0, wanted, position);
      if (bytesRead <= 0 || bytesRead > wanted) fail("SOURCE_CHANGED");
      position += bytesRead; yield block.subarray(0, bytesRead);
    }
    if ((await file.read(block, 0, 1, position)).bytesRead !== 0) fail("SOURCE_CHANGED");
    await guard(); await observe(file, path, uid, mode, identity);
  }
  const authenticateInstalled = async (file: FileHandle): Promise<void> => {
    const identity = installed ?? fail("INVALID_STATE");
    await verifyLinuxUpdateStream(chunks(file, image, 0o755n, identity), signature, expectedVersion);
  };
  const assertLauncher = async (): Promise<void> => {
    await guard();
    const file = await open(launcher, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const template = Buffer.from(appImageLauncher());
      if (launcherIdentity.size !== BigInt(template.length)) fail("SOURCE_CHANGED");
      await observe(file, launcher, uid, launcherIdentity.mode & 0o7777n, launcherIdentity);
      const bytes = Buffer.alloc(template.length); let position = 0;
      while (position < bytes.length) {
        const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
        if (!bytesRead) fail("SOURCE_CHANGED"); position += bytesRead;
      }
      if (!bytes.equals(template)) fail("SOURCE_CHANGED");
      await observe(file, launcher, uid, launcherIdentity.mode & 0o7777n, launcherIdentity); await guard();
    } finally { await file.close(); }
  };
  const assertRecord = async (): Promise<void> => {
    await guard();
    const names = (await readdir(stage)).sort();
    if (!recordIdentity || !same(recordIdentity, await lstat(recordPath, { bigint: true })) ||
        !backupIdentity || !same(backupIdentity, await lstat(previousPath, { bigint: true })) ||
        names.length !== 2 || names[0] !== "continuation.json" || names[1] !== "previous.AppImage") fail("SOURCE_CHANGED");
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
        if ((await readdir(stage)).join() !== "previous.AppImage") fail("SOURCE_CHANGED");
        await observe(old, previousPath, uid, oldIdentity.mode & 0o7777n, predecessorIdentity);
        await authenticateInstalled(candidate);
        const hash = createHash("sha256");
        for await (const chunk of chunks(old, previousPath, oldIdentity.mode & 0o7777n, predecessorIdentity)) hash.update(chunk);
        const directoryIdentity = await lstat(stage, { bigint: true });
        const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, artifact: artifactName, stage: basename(stage),
          predecessorVersion: currentVersion, installedVersion: expectedVersion, signature,
          directory: { dev: directoryIdentity.dev.toString(), ino: directoryIdentity.ino.toString(),
            uid: directoryIdentity.uid.toString(), mode: directoryIdentity.mode.toString() },
          launcher: encodeIdentity(launcherIdentity), installed: encodeIdentity(installed!),
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
      const assertInstalledForExec = (): Promise<void> => {
        if (phase !== "continued") return Promise.reject(new LinuxAppImageUpdateError("INVALID_STATE"));
        if (checking) return checking;
        const operation = Promise.resolve().then(async () => {
          await assertRecord(); await assertLauncher();
          const file = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { await authenticateInstalled(file); await assertRecord(); }
          finally { await file.close(); }
        });
        checking = operation;
        void operation.finally(() => { if (checking === operation) checking = undefined; }).catch(() => {});
        return operation;
      };
      const rollbackBeforeExec = (): Promise<void> => {
        if (rollingBack) return rollingBack;
        if (phase !== "continued") return Promise.reject(new LinuxAppImageUpdateError("INVALID_STATE"));
        phase = "rolling-back";
        const originalCheck = checking;
        return rollingBack = Promise.resolve().then(async () => {
          let published: FileHandle | undefined, predecessor: FileHandle | undefined;
          try {
            await originalCheck; await assertRecord(); await assertLauncher();
            published = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            predecessor = await open(previousPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            await authenticateInstalled(published);
            if (!backupIdentity) fail("ROLLBACK_FAILED");
            await observe(predecessor, previousPath, uid, oldIdentity.mode & 0o7777n, backupIdentity);
            await assertRecord(); await withdrawCandidate(published); await restore(predecessor); await removeCopy(published);
            if (!recordIdentity || !same(recordIdentity, await lstat(recordPath, { bigint: true }))) fail("SOURCE_CHANGED");
            await unlink(recordPath);
          } catch { fail("ROLLBACK_FAILED"); }
          finally {
            const results = await Promise.allSettled([published?.close(), predecessor?.close()]);
            if (results.some((result) => result.status === "rejected")) fail("CLEANUP_FAILED");
          }
          await guard(); await rmdir(stage); await syncDirectory(dirname(image)); phase = "closed";
        });
      };
      return Object.freeze({ assertInstalledForExec, rollbackBeforeExec });
    });
  };
  return Object.freeze({ version: expectedVersion, bytes: original.bytes, install, assertInstalled, prepareExecContinuation,
    rollback: () => finish("rollback"), commit: () => finish("commit"), discard: () => finish("discard") });
}

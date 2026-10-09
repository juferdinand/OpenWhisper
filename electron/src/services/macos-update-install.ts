import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import type { BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildIdentitySchema } from "../contracts/build-identity.js";
import { validateMacBundleMetadata } from "../main/build-selection.js";
import type { ExtractedMacUpdate } from "./macos-update-archive.js";
import { MacosUpdateSignatureError, verifyMacosUpdateSignature } from "./macos-update-signature.js";
import { isNewerUpdateVersion } from "./update-policy.js";
import { MAX_UPDATE_STAGE_BYTES, type OwnedUpdateDownload } from "./update-staging.js";

const fs = process.versions["electron"] ? createRequire(import.meta.url)("original-fs") as typeof nodeFs : nodeFs;
type Failure = "INVALID_INPUT" | "SOURCE_CHANGED" | "PREPARE_FAILED" | "INSTALL_FAILED" | "ROLLBACK_FAILED" | "CLEANUP_FAILED" | "INVALID_STATE";
export class MacosUpdateInstallError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "MacosUpdateInstallError"; }
}
function fail(code: Failure): never { throw new MacosUpdateInstallError(code); }
type Entry = Readonly<{ stat: BigIntStats; link?: string; digest?: string }>;
type Tree = ReadonlyMap<string, Entry>;
const same = (a: BigIntStats, b: BigIntStats, renamed = false): boolean => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && (renamed || a.ctimeNs === b.ctimeNs);
function exists(path: string): boolean {
  try { fs.lstatSync(path); return true; } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error;
  }
}
function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\p{Cc}]/u.test(path) || fs.realpathSync(path) !== path) fail("INVALID_INPUT");
}
function tree(path: string, hash = false): Tree {
  const result = new Map<string, Entry>(), pending = [""]; let bytes = 0n;
  while (pending.length) {
    const name = pending.pop()!, file = join(path, name), stat = fs.lstatSync(file, { bigint: true });
    if (result.size >= 100_000 || (stat.uid !== BigInt(process.getuid!()) && stat.uid !== 0n) ||
        (!stat.isSymbolicLink() && (stat.mode & 0o7022n) !== 0n)) fail("SOURCE_CHANGED");
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(file), target = fs.realpathSync(file);
      if (!target.startsWith(`${path}/`) || Buffer.byteLength(link) > 4096) fail("SOURCE_CHANGED");
      result.set(name, { stat, link });
    } else if (stat.isDirectory()) {
      result.set(name, { stat }); for (const child of fs.readdirSync(file)) pending.push(join(name, child));
    } else if (stat.isFile() && stat.nlink === 1n) {
      bytes += stat.size; if (bytes > BigInt(MAX_UPDATE_STAGE_BYTES)) fail("SOURCE_CHANGED");
      if (!hash) { result.set(name, { stat }); continue; }
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const digest = createHash("sha256"), block = Buffer.alloc(64 * 1024); let position = 0;
        while (BigInt(position) < stat.size) {
          const count = fs.readSync(fd, block, 0, Math.min(block.length, Number(stat.size) - position), position);
          if (count <= 0) fail("SOURCE_CHANGED"); digest.update(block.subarray(0, count)); position += count;
        }
        if (fs.readSync(fd, block, 0, 1, position) !== 0 || !same(stat, fs.fstatSync(fd, { bigint: true }))) fail("SOURCE_CHANGED");
        result.set(name, { stat, digest: digest.digest("hex") });
      } finally { fs.closeSync(fd); }
    } else fail("SOURCE_CHANGED");
  }
  return result;
}
function assertTree(path: string, before: Tree, renamed = false): Tree {
  const now = tree(path);
  if (now.size !== before.size) fail("SOURCE_CHANGED");
  for (const [name, entry] of before) {
    const current = now.get(name);
    if (!current || !same(entry.stat, current.stat, renamed && name === "") || entry.link !== current.link) fail("SOURCE_CHANGED");
  }
  return now;
}
function parents(path: string): ReadonlyMap<string, BigIntStats> {
  const result = new Map<string, BigIntStats>(), uid = BigInt(process.getuid!());
  for (let cursor = path;; cursor = dirname(cursor)) {
    const stat = fs.lstatSync(cursor, { bigint: true }), mode = stat.mode & 0o7777n;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0n && stat.uid !== uid) ||
        ((mode & 0o002n) !== 0n && !(stat.uid === 0n && (mode & 0o1000n) !== 0n))) fail("SOURCE_CHANGED");
    result.set(cursor, stat); if (dirname(cursor) === cursor) return result;
  }
}
function assertParents(before: ReadonlyMap<string, BigIntStats>): void {
  for (const [path, stat] of before) {
    const now = fs.lstatSync(path, { bigint: true });
    if (stat.dev !== now.dev || stat.ino !== now.ino || stat.uid !== now.uid || stat.gid !== now.gid || stat.mode !== now.mode) fail("SOURCE_CHANGED");
  }
}
function syncDirectory(path: string): void {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function command(tool: "/usr/bin/ditto" | "/usr/bin/plutil", args: readonly string[]): Promise<string> {
  return new Promise((accept, reject) => {
    let failed = false, output = Buffer.alloc(0);
    const child = spawn(tool, [...args], { shell: false, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"], timeout: tool === "/usr/bin/ditto" ? 120_000 : 10_000, killSignal: "SIGKILL" });
    child.on("error", () => { failed = true; }); child.stdout.on("error", () => { failed = true; child.kill("SIGKILL"); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 1024 * 1024) { failed = true; child.kill("SIGKILL"); }
      else output = Buffer.concat([output, chunk]);
    });
    child.once("close", (code, signal) => {
      if (failed || code !== 0 || signal !== null) reject(new MacosUpdateInstallError("PREPARE_FAILED")); else accept(output.toString("utf8"));
    });
  });
}
/** The same public Darwin no-replace primitive used by stable profile publication. */
function moveExclusive(from: string, to: string, expected: ReadonlyMap<string, BigIntStats>): void {
  if (process.platform !== "darwin") fail("INSTALL_FAILED");
  const ffi = createRequire(import.meta.url)("koffi") as typeof import("koffi"), library = ffi.load("/usr/lib/libSystem.B.dylib");
  let source: number | undefined, destination: number | undefined;
  try {
    const move = library.func("int renameatx_np(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)");
    source = fs.openSync(dirname(from), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    destination = fs.openSync(dirname(to), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    for (const [fd, path] of [[source, dirname(from)], [destination, dirname(to)]] as const) {
      const before = expected.get(path), opened = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(path, { bigint: true });
      if (!before || !opened.isDirectory() || before.dev !== opened.dev || before.ino !== opened.ino || before.uid !== opened.uid ||
          before.gid !== opened.gid || before.mode !== opened.mode || opened.dev !== named.dev || opened.ino !== named.ino) fail("SOURCE_CHANGED");
    }
    if (move(source, basename(from), destination, basename(to), 4) !== 0) fail("INSTALL_FAILED");
  } finally {
    try { if (source !== undefined) fs.closeSync(source); }
    finally { try { if (destination !== undefined) fs.closeSync(destination); } finally { library.unload(); } }
  }
}
/** Trusted filesystem/authority seams for owned tests only; never renderer or preference values. */
export interface MacosUpdateInstallEffects {
  copy(source: string, destination: string): Promise<void>;
  metadata(bundle: string): Promise<unknown>;
  authenticate(bundle: string): void;
  moveExclusive(source: string, destination: string): void;
}
export interface PreparedMacosUpdateInstall {
  readonly version: string;
  /** Caller must first finish original capture/speech/native owner cleanup. */
  install(): Promise<void>;
  /** Physical final observation only, after installation/owned descriptor settlement; caller owns relaunch. */
  assertForRelaunch(): void;
  /** Same in-memory transaction only, before caller relinquishes ownership. */
  rollback(): Promise<void>;
  /** Remove only this transaction's prepared child after preparation or successful rollback. */
  discard(): Promise<void>;
}

export interface MacosUpdateInstallInput {
  readonly download: OwnedUpdateDownload; readonly extracted: ExtractedMacUpdate; readonly build: unknown;
  readonly currentBundle: string; readonly currentVersion: string; readonly expectedVersion: string;
}
/** Caller supplies the admitted actual running bundle. This is not a public installation/path authority.
 * Does not clean the caller's original archive/extraction, relaunch or interpret persisted records. */
export async function prepareMacosUpdateInstall(input: MacosUpdateInstallInput,
  effects: Partial<MacosUpdateInstallEffects> = {}): Promise<Readonly<PreparedMacosUpdateInstall>> {
  try { return await prepare(input, effects); }
  catch (error: unknown) {
    if (error instanceof MacosUpdateInstallError || error instanceof MacosUpdateSignatureError) throw error;
    return fail("PREPARE_FAILED");
  }
}
async function prepare(input: MacosUpdateInstallInput,
  effects: Partial<MacosUpdateInstallEffects>): Promise<Readonly<PreparedMacosUpdateInstall>> {
  const { download, extracted, build, currentBundle, currentVersion, expectedVersion } = input;
  const identity = buildIdentitySchema.safeParse(build), uid = process.getuid?.();
  if (!identity.success || identity.data.kind !== "stable" || uid === undefined || uid === 0 || download.artifactName !== "OpenWhisper-macOS.zip" ||
      extracted.version !== expectedVersion || !isNewerUpdateVersion(expectedVersion, currentVersion)) fail("INVALID_INPUT");
  canonical(currentBundle); canonical(extracted.bundlePath);
  const source = extracted.bundlePath, parent = dirname(currentBundle);
  if (basename(currentBundle) !== "OpenWhisper.app" || !source.startsWith(`${download.stageDirectory}/`) ||
      source === currentBundle || relative(currentBundle, source).startsWith(`..`) === false) fail("INVALID_INPUT");
  const io: MacosUpdateInstallEffects = { copy: async (from, to) => { await command("/usr/bin/ditto", [from, to]); },
    metadata: async (bundle) => JSON.parse(await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(bundle, "Contents/Info.plist")])) as unknown,
    authenticate: verifyMacosUpdateSignature,
    moveExclusive: (from, to) => moveExclusive(from, to, new Map([...ancestry, [stage, stageIdentity]])), ...effects };
  const ancestry = parents(parent), original = tree(currentBundle), sourceTree = tree(source, true);
  await download.assertUnchanged();
  validateMacBundleMetadata(identity.data, currentVersion, await io.metadata(currentBundle));
  validateMacBundleMetadata(identity.data, expectedVersion, await io.metadata(source)); io.authenticate(source);
  assertTree(currentBundle, original); assertTree(source, sourceTree); assertParents(ancestry);
  const stage = fs.mkdtempSync(join(parent, ".openwhisper-update-")); fs.chmodSync(stage, 0o700);
  const stageIdentity = fs.lstatSync(stage, { bigint: true }), prepared = join(stage, "OpenWhisper.app"), previous = join(stage, "previous.app");
  let candidate: Tree;
  try {
    await io.copy(source, prepared); candidate = tree(prepared, true);
    if (candidate.size !== sourceTree.size) fail("SOURCE_CHANGED");
    for (const [name, entry] of sourceTree) {
      const copied = candidate.get(name);
      if (!copied || entry.link !== copied.link || entry.digest !== copied.digest || entry.stat.mode !== copied.stat.mode ||
          (entry.stat.isFile() && entry.stat.size !== copied.stat.size)) fail("SOURCE_CHANGED");
    }
    validateMacBundleMetadata(identity.data, expectedVersion, await io.metadata(prepared)); io.authenticate(prepared);
    await download.assertUnchanged(); assertTree(source, sourceTree); assertTree(currentBundle, original); assertTree(prepared, candidate); assertParents(ancestry);
    syncDirectory(stage);
  } catch (error: unknown) {
    // Partial or uncertain copies stay private; failed preparation grants no recursive cleanup authority.
    if (error instanceof MacosUpdateInstallError) throw error; return fail("PREPARE_FAILED");
  }
  let phase: "prepared" | "installed" | "rolled-back" | "failed" | "closed" = "prepared";
  let operation: { kind: "install" | "rollback" | "discard"; promise: Promise<void> } | undefined;
  let installed: Tree | undefined, backup: Tree | undefined;
  const guard = (names: readonly string[]): void => {
    assertParents(ancestry);
    const now = fs.lstatSync(stage, { bigint: true });
    if (now.dev !== stageIdentity.dev || now.ino !== stageIdentity.ino || now.uid !== BigInt(uid) || (now.mode & 0o7777n) !== 0o700n ||
        fs.readdirSync(stage).sort().join("\0") !== [...names].sort().join("\0")) fail("SOURCE_CHANGED");
  };
  const recover = (): void => {
    // An effect may move successfully and then throw. Root inode identity, not a pathname, establishes ownership.
    if (exists(previous)) backup = assertTree(previous, backup ?? original, !backup);
    if (!backup) { assertTree(currentBundle, original); return; }
    if (exists(currentBundle)) {
      const owned = assertTree(currentBundle, installed ?? candidate, !installed);
      guard(["previous.app"]); if (exists(prepared)) fail("ROLLBACK_FAILED");
      io.moveExclusive(currentBundle, prepared); candidate = assertTree(prepared, owned, true);
    }
    guard(exists(prepared) ? ["OpenWhisper.app", "previous.app"] : ["previous.app"]);
    if (exists(currentBundle)) fail("ROLLBACK_FAILED");
    io.moveExclusive(previous, currentBundle); assertTree(currentBundle, backup, true); backup = undefined; installed = undefined;
    syncDirectory(parent); syncDirectory(stage);
  };
  const assertForRelaunch = (): void => {
    if (phase !== "installed" || operation || !installed || !backup) fail("INVALID_STATE");
    try { guard(["previous.app"]); assertTree(currentBundle, installed); assertTree(previous, backup); }
    catch { fail("SOURCE_CHANGED"); }
  };
  const run = (kind: "install" | "rollback" | "discard", work: () => void): Promise<void> => {
    if (operation) return operation.kind === kind ? operation.promise : Promise.reject(new MacosUpdateInstallError("INVALID_STATE"));
    const promise = Promise.resolve().then(work);
    operation = { kind, promise };
    void promise.then(() => { if (operation?.promise === promise) operation = undefined; }, () => { if (operation?.promise === promise) operation = undefined; });
    return promise;
  };
  const install = (): Promise<void> => {
    if (operation?.kind === "install") return operation.promise;
    if (phase !== "prepared") return Promise.reject(new MacosUpdateInstallError("INVALID_STATE"));
    return run("install", () => {
      try {
        guard(["OpenWhisper.app"]); assertTree(currentBundle, original); assertTree(prepared, candidate);
        io.moveExclusive(currentBundle, previous); backup = assertTree(previous, original, true);
        guard(["OpenWhisper.app", "previous.app"]); assertTree(prepared, candidate);
        io.moveExclusive(prepared, currentBundle); installed = assertTree(currentBundle, candidate, true);
        syncDirectory(parent); syncDirectory(stage); guard(["previous.app"]); assertTree(previous, backup); phase = "installed";
      } catch {
        phase = "failed";
        try { recover(); phase = "rolled-back"; } catch { return fail("ROLLBACK_FAILED"); }
        fail("INSTALL_FAILED");
      }
    });
  };
  const rollback = (): Promise<void> => {
    if (operation?.kind === "rollback") return operation.promise;
    if (phase !== "installed" && phase !== "failed") return Promise.reject(new MacosUpdateInstallError("INVALID_STATE"));
    return run("rollback", () => { phase = "failed"; try { recover(); phase = "rolled-back"; } catch { fail("ROLLBACK_FAILED"); } });
  };
  const discard = (): Promise<void> => {
    if (operation?.kind === "discard") return operation.promise;
    if (phase !== "prepared" && phase !== "rolled-back") return Promise.reject(new MacosUpdateInstallError("INVALID_STATE"));
    return run("discard", () => {
      try {
        guard(["OpenWhisper.app"]); assertTree(prepared, candidate);
        fs.rmSync(prepared, { recursive: true }); guard([]); fs.rmdirSync(stage); syncDirectory(parent); phase = "closed";
      } catch { fail("CLEANUP_FAILED"); }
    });
  };
  return Object.freeze({ version: expectedVersion, install, assertForRelaunch, rollback, discard });
}

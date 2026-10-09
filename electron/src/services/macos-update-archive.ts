import { spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import type { BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { buildIdentitySchema } from "../contracts/build-identity.js";
import { validateMacBundleMetadata } from "../main/build-selection.js";
import { verifyMacosUpdateSignature, MacosUpdateSignatureError } from "./macos-update-signature.js";
import { isNewerUpdateVersion } from "./update-policy.js";
import { assertPrivateUpdateDirectory, type OwnedUpdateDownload } from "./update-staging.js";

// Bundle checks and removal operate on physical files, including Electron's ASAR archives.
// https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file
const physicalFs = process.versions["electron"]
  ? createRequire(import.meta.url)("original-fs") as typeof nodeFs : nodeFs;
const { lstat, mkdtemp, readdir, realpath, rm } = physicalFs.promises;

type Failure = "INVALID_INPUT" | "UNSUPPORTED_HOST" | "INVALID_ARCHIVE" | "INVALID_BUNDLE" | "EXTRACTION_FAILED" | "CLEANUP_FAILED";
type CleanupPhase = "PRIVATE_STAGE" | "CHILD_IDENTITY" | "REMOVE_TREE";
const cleanupCauses = ["EACCES", "EPERM", "ENOTEMPTY", "EBUSY", "ENOENT", "ENOTDIR", "ELOOP", "EIO", "FILE_CHANGED", "UNSAFE_STAGING", "CLEANUP_FAILED"] as const;
type CleanupCause = typeof cleanupCauses[number] | "UNCLASSIFIED";
export class MacosUpdateArchiveError extends Error {
  constructor(readonly code: Failure, readonly cleanupPhase?: CleanupPhase, readonly cleanupCause?: CleanupCause) {
    super(cleanupPhase ? `${code}:${cleanupPhase}:${cleanupCause ?? "UNCLASSIFIED"}` : code);
    this.name = "MacosUpdateArchiveError";
  }
}
const fail = (code: Failure): never => { throw new MacosUpdateArchiveError(code); };
function cleanupFailure(phase: CleanupPhase, error: unknown): MacosUpdateArchiveError {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const cause = cleanupCauses.find((candidate) => candidate === code) ?? "UNCLASSIFIED";
  return new MacosUpdateArchiveError("CLEANUP_FAILED", phase, cause);
}

/** Inspect without following directory links. Internal framework links remain intact. */
export async function validateMacUpdateBundleFiles(bundle: string): Promise<void> {
  if (!isAbsolute(bundle) || resolve(bundle) !== bundle || !bundle.endsWith(".app") || /[\u0000-\u001f\u007f]/u.test(bundle)) fail("INVALID_INPUT");
  try {
    const root = await lstat(bundle);
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(bundle) !== bundle) fail("INVALID_BUNDLE");
    const pending = [bundle]; let entries = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const name of await readdir(directory)) {
        if (++entries > 100_000) fail("INVALID_BUNDLE");
        const path = join(directory, name), metadata = await lstat(path);
        if (metadata.isSymbolicLink()) {
          if (!(await realpath(path)).startsWith(`${bundle}/`)) fail("INVALID_BUNDLE");
        } else if (metadata.isDirectory()) pending.push(path);
        else if (!metadata.isFile()) fail("INVALID_BUNDLE");
      }
    }
  } catch (error: unknown) {
    if (error instanceof MacosUpdateArchiveError) throw error;
    fail("INVALID_BUNDLE");
  }
}

/** Fixed system commands, with no shell, diagnostic logging or inherited loader environment. */
function command(executable: "/usr/bin/tar" | "/usr/bin/plutil", args: readonly string[], descriptor?: number): Promise<string> {
  return new Promise((accept, reject) => {
    let failed = false, output = Buffer.alloc(0);
    const child = spawn(executable, [...args], { shell: false,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      stdio: descriptor === undefined ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore", descriptor],
      timeout: executable === "/usr/bin/tar" ? 120_000 : 10_000, killSignal: "SIGKILL" });
    child.on("error", () => { failed = true; });
    child.stdout?.on("error", () => { failed = true; child.kill("SIGKILL"); });
    child.stdout?.on("data", (bytes: Buffer) => {
      if (bytes.length > 64 * 1024 - output.length) { failed = true; child.kill("SIGKILL"); }
      else output = Buffer.concat([output, bytes]);
    });
    // Cleanup is permitted only after the original child and its stdio actually close.
    child.once("close", (code, signal) => {
      if (failed || code !== 0 || signal !== null) reject(new MacosUpdateArchiveError("EXTRACTION_FAILED"));
      else accept(output.toString("utf8"));
    });
  });
}

export interface ExtractedMacUpdate {
  readonly bundlePath: string;
  readonly version: string;
  /** Remove the extraction child after installation/consumer settlement, before download cleanup. */
  cleanup(): Promise<void>;
}

/** Preserve an extraction cleanup failure while still closing the original download descriptor.
 * Download cleanup refuses to remove a stage with a retained extraction child. */
export async function cleanupMacUpdateArchiveDownload(extracted: Pick<ExtractedMacUpdate, "cleanup"> | undefined,
  download: OwnedUpdateDownload): Promise<void> {
  let failed = false, failure: unknown;
  try { await extracted?.cleanup(); } catch (error: unknown) { failed = true; failure = error; }
  try { await download.cleanup(); } catch (error: unknown) { if (!failed) { failed = true; failure = error; } }
  if (failed) throw failure;
}

/** The caller holds the original stage throughout. Its producer uses positioned writes from zero;
 * fd3 inherits that descriptor's cursor, and no other borrower may advance it during extraction.
 * Signature/version observation is not authorization to replace the running installation. */
export async function extractVerifiedMacUpdateArchive(input: {
  readonly download: OwnedUpdateDownload; readonly build: unknown;
  readonly expectedVersion: string; readonly currentVersion: string;
}): Promise<Readonly<ExtractedMacUpdate>> {
  if (process.platform !== "darwin") return fail("UNSUPPORTED_HOST");
  const build = buildIdentitySchema.safeParse(input.build);
  if (!build.success || input.download.artifactName !== "OpenWhisper-macOS.zip" ||
      !isNewerUpdateVersion(input.expectedVersion, input.currentVersion)) return fail("INVALID_INPUT");
  await input.download.assertUnchanged();
  const stageGuard = await assertPrivateUpdateDirectory(input.download.stageDirectory);
  let directory: string, original: BigIntStats;
  try {
    directory = await mkdtemp(join(input.download.stageDirectory, "unpacked-"));
    original = await lstat(directory, { bigint: true });
  } catch {
    // An unidentified child is retained; a preparation failure does not authorize pathname cleanup.
    return fail("EXTRACTION_FAILED");
  }
  const bundlePath = join(directory, `${build.data.productName}.app`);
  let closing: Promise<void> | undefined;
  const cleanup = (): Promise<void> => closing ??= (async () => {
    let phase: CleanupPhase = "PRIVATE_STAGE";
    try {
      // Cleanup needs the private directory identity, even when archive bytes changed during extraction.
      await stageGuard.assertUnchanged();
      phase = "CHILD_IDENTITY";
      const current = await lstat(directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev ||
          current.ino !== original.ino || current.uid !== original.uid) fail("CLEANUP_FAILED");
      phase = "REMOVE_TREE";
      await rm(directory, { recursive: true });
    } catch (error: unknown) { throw cleanupFailure(phase, error); }
  })();
  try {
    // Preserve bsdtar's traversal protections: never pass -P or reopen the ZIP pathname.
    await command("/usr/bin/tar", ["-x", "-f", "/dev/fd/3", "-C", directory, "--no-same-owner"], input.download.file.fd);
    await input.download.assertUnchanged();
    await validateMacUpdateBundleFiles(bundlePath);
    let metadata: unknown;
    try { metadata = JSON.parse(await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(bundlePath, "Contents/Info.plist")])); }
    catch { fail("INVALID_BUNDLE"); }
    try { validateMacBundleMetadata(build.data, input.expectedVersion, metadata); } catch { fail("INVALID_BUNDLE"); }
    verifyMacosUpdateSignature(bundlePath);
    await input.download.assertUnchanged();
    return Object.freeze({ bundlePath, version: input.expectedVersion, cleanup });
  } catch (error: unknown) {
    await cleanup();
    if (error instanceof MacosUpdateArchiveError || error instanceof MacosUpdateSignatureError) throw error;
    return fail("INVALID_ARCHIVE");
  }
}

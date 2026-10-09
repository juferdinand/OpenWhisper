import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import type { BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { Parser, type ReadEntry } from "tar";
import { z } from "zod";
import { parseApplicationBuildModule } from "../../../contracts/application/build-identity.js";
import { linuxSupervisorLauncher } from "../../../cli/linux-supervisor.js";
import { developmentRecordingDescriptorSchema } from "../../../main/development-recording-descriptor.js";
import { validateDebianUpdateMetadata } from "./linux-debian-update.js";
import { verifyOwnedLinuxUpdateFile } from "./linux-update-file.js";
import { parseUpdateVersion } from "../common/update-policy.js";
import { inspectOwnedUpdateFile, type OwnedUpdateDownload } from "../common/update-staging.js";

// Installed ASAR files must be inspected as physical files under Electron.
const physicalFs = process.versions["electron"] ? createRequire(import.meta.url)("original-fs") as typeof nodeFs : nodeFs;
const { lstat, open, readdir } = physicalFs.promises;
export const DEBIAN_AUDIT_LIMITS = Object.freeze({ entries: 10_000, bytes: 2 * 1024 ** 3,
  metadataBytes: 4096, pathBytes: 4096, depth: 32, textBytes: 1024 ** 2, milliseconds: 120_000 });
type Failure = "INVALID_INPUT" | "INVALID_ARCHIVE" | "LIMIT_EXCEEDED" | "INVALID_LAYOUT" |
  "SOURCE_CHANGED" | "TOOL_FAILED" | "INSTALLED_MISMATCH" | "CANCELED" | "TIMEOUT" | "CLOSE_FAILED";
export class DebianInstalledAuditError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "DebianInstalledAuditError"; }
}
function fail(code: Failure): never { throw new DebianInstalledAuditError(code); }
function check(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted) fail("CANCELED");
  if (performance.now() >= deadline) fail("TIMEOUT");
}
const payload = "opt/openwhisper", application = `${payload}/resources/app`;
const external = ["usr/bin/openwhisper-desktop", "usr/share/applications/io.github.whisperfree.desktop",
  "usr/share/icons/hicolor/256x256/apps/io.github.whisperfree.png", "usr/share/doc/io-github-whisperfree/copyright"];
const texts = new Set([`${payload}/openwhisper-launch`, external[0]!, `${application}/package.json`,
  `${application}/dist/resources/VERSION`, `${application}/dist/main/application-build.js`,
  `${application}/dist/main/development-recording-build.js`]);
const structural = new Set(["", "opt", "usr", ...external.flatMap((path) => {
  const result: string[] = []; for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) result.push(parent);
  return result;
})]);
export interface DebianInventoryEntry {
  readonly path: string; readonly type: "file" | "directory"; readonly mode: number; readonly bytes: number;
  readonly sha256?: string; readonly text?: string;
}
export interface DebianDataInventory { readonly entries: readonly DebianInventoryEntry[]; readonly bytes: number }
function canonical(raw: string, directory: boolean): string {
  if (raw === "." || raw === "./") { if (directory) return ""; fail("INVALID_ARCHIVE"); }
  const path = raw.startsWith("./") ? raw.slice(2) : raw;
  const name = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!name || Buffer.byteLength(name) > DEBIAN_AUDIT_LIMITS.pathBytes || name.split("/").length > DEBIAN_AUDIT_LIMITS.depth ||
      /[\p{Cc}\\\uFFFD]/u.test(name) || name.startsWith("/") || posix.normalize(name) !== name || name === ".." || name.startsWith("../")) fail("INVALID_ARCHIVE");
  if (!(name === payload || name.startsWith(`${payload}/`) || external.includes(name) || (directory && structural.has(name)))) fail("INVALID_LAYOUT");
  return name;
}

/** Raw tar inspection only. This public inventory is unauthenticated and never installation/restart authority. */
export async function inspectDebianDataTar(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Readonly<DebianDataInventory>> {
  const deadline = performance.now() + DEBIAN_AUDIT_LIMITS.milliseconds, entries: DebianInventoryEntry[] = [], names = new Set<string>();
  let failure: DebianInstalledAuditError | undefined, total = 0, rawBytes = 0, eof = false, longName: string | undefined;
  const active = new Set<ReadEntry>();
  const parser = new Parser({ strict: true, maxMetaEntrySize: DEBIAN_AUDIT_LIMITS.metadataBytes, brotli: false, zstd: false });
  const stop = (code: Failure): void => {
    if (failure) return; failure = new DebianInstalledAuditError(code);
    parser.abort(failure); for (const entry of active) entry.destroy(); active.clear();
  };
  parser.on("error", () => { if (!failure) stop("INVALID_ARCHIVE"); });
  parser.on("warn", () => stop("INVALID_ARCHIVE")); parser.on("ignoredEntry", () => stop("INVALID_ARCHIVE"));
  parser.on("eof", () => { eof = true; });
  parser.on("meta", (value: unknown) => {
    // Only a bounded GNU next-file pathname is accepted. No authored PAX/header decoder.
    if (typeof value !== "string" || longName !== undefined || !value.endsWith("\0") || value.indexOf("\0") !== value.length - 1 ||
        Buffer.byteLength(value) > DEBIAN_AUDIT_LIMITS.metadataBytes) { stop("INVALID_ARCHIVE"); return; }
    longName = value.slice(0, -1);
  });
  parser.on("entry", (entry: ReadEntry) => {
    active.add(entry); entry.on("error", () => stop("INVALID_ARCHIVE"));
    try {
      check(signal, deadline);
      const directory = entry.type === "Directory";
      if ((!directory && entry.type !== "File" && entry.type !== "OldFile") || entry.globalExtended ||
          (entry.extended && (Object.keys(entry.extended).some((key) => key !== "path") || entry.extended.path !== longName)) ||
          (longName !== undefined && entry.path !== longName) || entry.linkpath || entry.uid !== 0 || entry.gid !== 0 ||
          !Number.isSafeInteger(entry.mode) || ![0o644, 0o755].includes(entry.mode!) || (directory && entry.mode !== 0o755) ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || (directory && entry.size !== 0)) fail("INVALID_ARCHIVE");
      longName = undefined;
      const path = canonical(entry.path, directory);
      if (names.has(path)) fail("INVALID_ARCHIVE"); names.add(path);
      if (names.size > DEBIAN_AUDIT_LIMITS.entries || entry.size > DEBIAN_AUDIT_LIMITS.bytes - total) fail("LIMIT_EXCEEDED");
      total += entry.size;
      if (texts.has(path) && entry.size > DEBIAN_AUDIT_LIMITS.textBytes) fail("LIMIT_EXCEEDED");
      const hash = createHash("sha256"), text: Buffer[] = []; let count = 0;
      entry.on("data", (bytes: Buffer) => {
        if (failure) return;
        try { check(signal, deadline); count += bytes.length; if (count > entry.size) fail("INVALID_ARCHIVE");
          hash.update(bytes); if (texts.has(path)) text.push(Buffer.from(bytes));
        } catch (error: unknown) { stop(error instanceof DebianInstalledAuditError ? error.code : "INVALID_ARCHIVE"); }
      });
      entry.on("end", () => {
        active.delete(entry); if (failure) return;
        try {
          if (count !== entry.size) fail("INVALID_ARCHIVE");
          entries.push(Object.freeze({ path, type: directory ? "directory" : "file", mode: entry.mode!, bytes: count,
            ...(!directory ? { sha256: hash.digest("hex") } : {}),
            ...(texts.has(path) ? { text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(text)) } : {}) }));
        } catch { stop("INVALID_ARCHIVE"); }
      });
      entry.resume();
    } catch (error: unknown) { stop(error instanceof DebianInstalledAuditError ? error.code : "INVALID_ARCHIVE"); }
  });
  const onAbort = (): void => stop("CANCELED"); signal?.addEventListener("abort", onAbort, { once: true });
  let pending = Buffer.alloc(0), first = true;
  try {
    check(signal, deadline);
    // Framing only: the library decodes every header and emits EOF; no format fields are decoded here.
    for await (const value of source) {
      check(signal, deadline); if (failure) throw failure;
      if (!(value instanceof Uint8Array) || value.buffer instanceof SharedArrayBuffer) fail("INVALID_INPUT");
      if (value.byteLength > DEBIAN_AUDIT_LIMITS.bytes + 64 * 1024 * 1024 - rawBytes) fail("LIMIT_EXCEEDED");
      rawBytes += value.byteLength;
      for (let offset = 0; offset < value.byteLength;) {
        let block: Buffer;
        if (!pending.length && value.byteLength - offset >= 512) {
          block = Buffer.from(value.buffer, value.byteOffset + offset, 512); offset += 512;
        } else {
          const count = Math.min(512 - pending.length, value.byteLength - offset);
          pending = Buffer.concat([pending, value.subarray(offset, offset + count)]); offset += count;
          if (pending.length !== 512) continue;
          block = pending; pending = Buffer.alloc(0);
        }
        check(signal, deadline);
        if (first && block[0] === 0x1f && block[1] === 0x8b) fail("INVALID_ARCHIVE"); first = false;
        if (eof) { if (block.some((byte) => byte !== 0)) fail("INVALID_ARCHIVE"); }
        else parser.write(block);
        if (failure) throw failure;
      }
    }
    if (failure) throw failure;
    if (pending.length || !eof || longName !== undefined) fail("INVALID_ARCHIVE");
    const closed = new Promise<void>((accept) => parser.once("close", accept)); parser.end(); await closed;
    if (failure) throw failure;
    const files = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.path));
    for (const entry of entries) for (let parent = posix.dirname(entry.path); parent !== "."; parent = posix.dirname(parent)) {
      if (files.has(parent)) fail("INVALID_ARCHIVE");
    }
    return Object.freeze({ entries: Object.freeze(entries), bytes: total });
  } catch (error: unknown) {
    stop(error instanceof DebianInstalledAuditError ? error.code : "INVALID_ARCHIVE"); throw failure!;
  } finally { signal?.removeEventListener("abort", onAbort); }
}

const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid &&
  a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
/** Pure ownership policy; synthetic metadata tests do not establish an actual root-owned installation. */
export function validateDebianInstalledMetadata(value: BigIntStats, expected: DebianInventoryEntry, original?: BigIntStats): void {
  if (value.uid !== 0n || value.gid !== 0n || value.isSymbolicLink() || (value.mode & 0o7777n) !== BigInt(expected.mode) ||
      (expected.type === "directory" ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n || value.size !== BigInt(expected.bytes)) ||
      (original !== undefined && !same(original, value))) fail("INSTALLED_MISMATCH");
}
/** Borrowed byte comparison only; a caller-supplied hash is not publisher authentication. Never closes the caller's handle. */
export async function inspectDebianFileBytes(file: { stat(options: { bigint: true }): Promise<BigIntStats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }, path: string,
  expected: Pick<DebianInventoryEntry, "bytes" | "sha256">, signal?: AbortSignal): Promise<BigIntStats> {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > DEBIAN_AUDIT_LIMITS.bytes ||
      typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expected.sha256)) fail("INVALID_INPUT");
  const deadline = performance.now() + DEBIAN_AUDIT_LIMITS.milliseconds; check(signal, deadline);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expected.bytes) ||
      expected.bytes > DEBIAN_AUDIT_LIMITS.bytes || !same(before, await file.stat({ bigint: true }))) fail("INSTALLED_MISMATCH");
  const hash = createHash("sha256"), bytes = Buffer.alloc(64 * 1024); let position = 0;
  while (position < expected.bytes) {
    check(signal, deadline); const wanted = Math.min(bytes.length, expected.bytes - position);
    const result = await file.read(bytes, 0, wanted, position); check(signal, deadline);
    if (result.bytesRead <= 0 || result.bytesRead > wanted) fail("INSTALLED_MISMATCH");
    position += result.bytesRead; hash.update(bytes.subarray(0, result.bytesRead));
  }
  if ((await file.read(bytes, 0, 1, position)).bytesRead !== 0 || hash.digest("hex") !== expected.sha256 ||
      !same(before, await file.stat({ bigint: true })) || !same(before, await lstat(path, { bigint: true }))) fail("INSTALLED_MISMATCH");
  check(signal, deadline); return before;
}
async function rootAncestry(path: string): Promise<Map<string, BigIntStats>> {
  const result = new Map<string, BigIntStats>();
  for (let cursor = path;; cursor = dirname(cursor)) {
    const value = await lstat(cursor, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== 0n || value.gid !== 0n || (value.mode & 0o7022n) !== 0n) fail("INSTALLED_MISMATCH");
    result.set(cursor, value); if (cursor === dirname(cursor)) break;
  }
  return result;
}
async function assertAncestors(before: ReadonlyMap<string, BigIntStats>): Promise<void> {
  for (const [path, original] of before) {
    const current = await lstat(path, { bigint: true });
    if (current.dev !== original.dev || current.ino !== original.ino || current.mode !== original.mode || current.uid !== original.uid || current.gid !== original.gid) fail("INSTALLED_MISMATCH");
  }
}
async function tool<T>(executable: "/usr/bin/dpkg-deb" | "/usr/bin/dpkg-query", args: readonly string[],
  consume: (source: AsyncIterable<Uint8Array>) => Promise<T>, signal?: AbortSignal, descriptor?: number): Promise<T> {
  try {
    check(signal, Infinity); const ancestors = await rootAncestry(dirname(executable)), original = await lstat(executable, { bigint: true });
    validateDebianInstalledMetadata(original, { path: executable, type: "file", mode: 0o755, bytes: Number(original.size) });
    if (executable === "/usr/bin/dpkg-query") await rootAncestry("/var/lib/dpkg");
    check(signal, Infinity);
    const child = spawn(executable, [...args], { shell: false, detached: true,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      stdio: descriptor === undefined ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "ignore", descriptor] });
    let failed = false, timeout = false, live = true;
    const closed = new Promise<void>((accept) => {
      child.on("error", () => { failed = true; }); child.once("close", (code, signal) => { live = false; if (code !== 0 || signal !== null) failed = true; accept(); });
    });
    const stop = (): void => { if (live && child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Await the original child close. */ } };
    const timer = setTimeout(() => { timeout = true; stop(); }, DEBIAN_AUDIT_LIMITS.milliseconds);
    signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
    try {
      if (!child.stdout) fail("TOOL_FAILED");
      const result = await consume(child.stdout!); await closed;
      check(signal, Infinity); if (timeout) fail("TIMEOUT"); if (failed) fail("TOOL_FAILED");
      await assertAncestors(ancestors); if (!same(original, await lstat(executable, { bigint: true }))) fail("TOOL_FAILED");
      return result;
    } finally { stop(); child.stdout?.destroy(); await closed; clearTimeout(timer); signal?.removeEventListener("abort", stop); }
  } catch (error: unknown) { if (error instanceof DebianInstalledAuditError) throw error; fail("TOOL_FAILED"); }
}
async function textOutput(source: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of source) { bytes += chunk.length; if (bytes > 4096) fail("LIMIT_EXCEEDED"); parts.push(Buffer.from(chunk)); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)); } catch { return fail("TOOL_FAILED"); }
}
/** Current installed package admission only; this query does not authenticate an update candidate. */
export async function assertCanonicalInstalledDebianVersion(version: string): Promise<void> {
  try { parseUpdateVersion(version); } catch { return fail("INVALID_INPUT"); }
  if (process.platform !== "linux" || process.arch !== "x64" || !process.getuid?.()) fail("INVALID_INPUT");
  const status = await tool("/usr/bin/dpkg-query", ["--admindir=/var/lib/dpkg", "--no-pager",
    "--showformat=${Package}\\n${Version}\\n${Architecture}\\n${Status}\\n", "--show", "io-github-whisperfree"], textOutput);
  if (status !== `io-github-whisperfree\n${version}\namd64\ninstall ok installed\n`) fail("INSTALLED_MISMATCH");
}
function validateLayout(inventory: DebianDataInventory, version: string): void {
  const entries = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  const text = (path: string): string => entries.get(path)?.text ?? fail("INVALID_LAYOUT");
  if (parseApplicationBuildModule(text(`${application}/dist/main/application-build.js`)).kind !== "stable" ||
      ![version, `${version}\n`].includes(text(`${application}/dist/resources/VERSION`)) ||
      z.object({ version: z.literal(version), main: z.literal("dist/main/index.js"), type: z.literal("module") }).safeParse(JSON.parse(text(`${application}/package.json`))).success !== true ||
      text(`${payload}/openwhisper-launch`) !== linuxSupervisorLauncher("debian") ||
      text(external[0]!) !== '#!/bin/sh\nexec /opt/openwhisper/openwhisper-launch "$@"\n') fail("INVALID_LAYOUT");
  const literal = /(?:export\s+)?const DEVELOPMENT_RECORDING_BUILD(?:\s*:\s*unknown)?\s*=\s*(\{[^]*?\});/u.exec(text(`${application}/dist/main/development-recording-build.js`))?.[1];
  if (!literal) fail("INVALID_LAYOUT");
  const descriptor = developmentRecordingDescriptorSchema.parse(JSON.parse(literal!));
  if (descriptor.platform !== "linux" || descriptor.architecture !== "x64" || !descriptor.platformServices) fail("INVALID_LAYOUT");
  for (const name of [...external, `${payload}/openwhisper`, `${application}/dist/main/index.js`, `${application}/dist/cli/linux-supervisor-bootstrap.js`]) {
    if (entries.get(name)?.type !== "file") fail("INVALID_LAYOUT");
  }
  for (const name of [`${payload}/openwhisper`, `${payload}/openwhisper-launch`, external[0]!]) {
    if (entries.get(name)?.mode !== 0o755 || !entries.get(name)?.bytes) fail("INVALID_LAYOUT");
  }
  for (const entry of [...descriptor.speechEntryGraph.entries,
    { path: "dist/native/capture/openwhisper_capture.node", ...descriptor.capture },
    { path: "dist/workers/capture-entry.js", ...descriptor.captureEntry },
    ...descriptor.speech.entries.map((entry) => ({ path: `dist/native/speech/${entry.backend}/openwhisper_speech.node`, ...entry })),
    { path: "dist/workers/platform-entry.js", ...descriptor.platformServices!.entry },
    { path: "dist/native/openwhisper_linux_bus.node", ...descriptor.platformServices!.bus }]) {
    const actual = entries.get(`${application}/${entry.path}`);
    if (actual?.type !== "file" || actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) fail("INVALID_LAYOUT");
  }
}

/** Inactive host boundary. Only this freshly authenticated original package creates an installed-audit closure. */
export async function prepareDebianInstalledAudit(input: { readonly download: OwnedUpdateDownload; readonly signature: unknown;
  readonly expectedVersion: string; readonly signal?: AbortSignal }): Promise<Readonly<{
    assertInstalled(signal?: AbortSignal): Promise<void>;
    /** Synchronous metadata observation only, after a successful full audit. No root/same-UID adversary or CAS claim.
     * Independent of the original download FD; call immediately before fixed exec, after download cleanup. */
    assertForExec(): void;
  }>> {
  const { download, signature, expectedVersion, signal: preparationSignal } = input;
  if (process.platform !== "linux" || process.arch !== "x64" || !process.getuid?.() || download.artifactName !== "OpenWhisper-Linux-amd64.deb") fail("INVALID_INPUT");
  parseUpdateVersion(expectedVersion); check(preparationSignal, Infinity);
  const observed = await inspectOwnedUpdateFile(download);
  await verifyOwnedLinuxUpdateFile({ ...download, signature: signature, version: expectedVersion,
    artifactName: "OpenWhisper-Linux-amd64.deb" }); check(preparationSignal, Infinity);
  await download.assertUnchanged(); await observed.assertUnchanged();
  const metadata = await tool("/usr/bin/dpkg-deb", ["--showformat=${Package}\\n${Version}\\n${Architecture}\\n", "--show", "/proc/self/fd/3"], textOutput, preparationSignal, download.file.fd);
  validateDebianUpdateMetadata(metadata, expectedVersion);
  const inventory = await tool("/usr/bin/dpkg-deb", ["--fsys-tarfile", "/proc/self/fd/3"],
    (source) => inspectDebianDataTar(source, preparationSignal), preparationSignal, download.file.fd);
  await download.assertUnchanged(); await observed.assertUnchanged();
  try { validateLayout(inventory, expectedVersion); } catch { fail("INVALID_LAYOUT"); }
  let auditGeneration = 0, auditing = false;
  let execSnapshot: { observations: ReadonlyMap<string, BigIntStats>; ancestors: ReadonlyMap<string, BigIntStats>; status: BigIntStats } | undefined;
  const assertInstalled = async (signal?: AbortSignal): Promise<void> => {
    const generation = ++auditGeneration; execSnapshot = undefined;
    if (auditing) fail("INSTALLED_MISMATCH"); auditing = true;
    const deadline = performance.now() + DEBIAN_AUDIT_LIMITS.milliseconds;
    try {
      check(signal, deadline); await download.assertUnchanged(); await observed.assertUnchanged();
      const observations = new Map<string, BigIntStats>(), ancestors = await rootAncestry("/var/lib/dpkg");
      const database = await lstat("/var/lib/dpkg/status", { bigint: true });
      validateDebianInstalledMetadata(database, { path: "/var/lib/dpkg/status", type: "file", mode: 0o644, bytes: Number(database.size) });
      const status = await tool("/usr/bin/dpkg-query", ["--admindir=/var/lib/dpkg", "--no-pager",
        "--showformat=${Package}\\n${Version}\\n${Architecture}\\n${Status}\\n", "--show", "io-github-whisperfree"], textOutput, signal);
      if (status !== `io-github-whisperfree\n${expectedVersion}\namd64\ninstall ok installed\n`) fail("INSTALLED_MISMATCH");
      for (const entry of inventory.entries) {
        check(signal, deadline); if (!entry.path) continue;
        const path = join("/", entry.path);
        for (const [name, value] of await rootAncestry(dirname(path))) {
          const previous = ancestors.get(name); if (previous && !same(previous, value)) fail("INSTALLED_MISMATCH"); ancestors.set(name, value);
        }
        const value = await lstat(path, { bigint: true }); validateDebianInstalledMetadata(value, entry);
        if (entry.type === "file") {
          const file = await open(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK);
          try { if (!same(value, await inspectDebianFileBytes(file, path, entry, signal))) fail("INSTALLED_MISMATCH"); }
          finally { try { await file.close(); } catch { fail("CLOSE_FAILED"); } }
        }
        observations.set(path, value);
      }
      const expected = new Set(inventory.entries.filter((entry) => entry.path === payload || entry.path.startsWith(`${payload}/`)).map((entry) => `/${entry.path}`));
      const pending = ["/opt/openwhisper"]; let count = 0;
      while (pending.length) {
        check(signal, deadline); const directory = pending.pop()!;
        for (const name of await readdir(directory)) {
          if (++count > DEBIAN_AUDIT_LIMITS.entries) fail("LIMIT_EXCEEDED"); const path = join(directory, name);
          if (!expected.delete(path)) fail("INSTALLED_MISMATCH");
          if ((await lstat(path, { bigint: true })).isDirectory()) pending.push(path);
        }
      }
      expected.delete("/opt/openwhisper"); if (expected.size) fail("INSTALLED_MISMATCH");
      for (const [path, before] of observations) {
        check(signal, deadline); const current = await lstat(path, { bigint: true });
        if (!same(before, current)) fail("INSTALLED_MISMATCH"); observations.set(path, current);
      }
      const currentDatabase = await lstat("/var/lib/dpkg/status", { bigint: true });
      if (!same(database, currentDatabase)) fail("INSTALLED_MISMATCH");
      await assertAncestors(ancestors); await observed.assertUnchanged(); await download.assertUnchanged(); check(signal, deadline);
      if (generation !== auditGeneration) fail("INSTALLED_MISMATCH");
      // Every original file close above has settled before this private snapshot becomes usable.
      execSnapshot = { observations, ancestors, status: currentDatabase };
    } catch (error: unknown) { execSnapshot = undefined; if (error instanceof DebianInstalledAuditError) throw error; fail("INSTALLED_MISMATCH"); }
    finally { auditing = false; }
  };
  const assertForExec = (): void => {
    const snapshot = execSnapshot;
    if (!snapshot) fail("INSTALLED_MISMATCH");
    try {
      for (const entry of inventory.entries) {
        if (!entry.path) continue;
        const path = join("/", entry.path), before = snapshot.observations.get(path);
        if (!before) fail("INSTALLED_MISMATCH");
        validateDebianInstalledMetadata(physicalFs.lstatSync(path, { bigint: true }), entry, before);
      }
      for (const [path, before] of snapshot.ancestors) {
        const current = physicalFs.lstatSync(path, { bigint: true });
        if (current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode ||
            current.uid !== before.uid || current.gid !== before.gid) fail("INSTALLED_MISMATCH");
      }
      // Conservative refusal of concurrent package-state changes; no DB hash or package-manager CAS.
      if (!same(snapshot.status, physicalFs.lstatSync("/var/lib/dpkg/status", { bigint: true }))) fail("INSTALLED_MISMATCH");
    } catch { execSnapshot = undefined; fail("INSTALLED_MISMATCH"); }
  };
  return Object.freeze({ assertInstalled, assertForExec });
}

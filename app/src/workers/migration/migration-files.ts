import { createHash } from "node:crypto";
import { constants, lstatSync, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { MAX_UI_REQUEST_BYTES } from "../../contracts/ui/state.js";
import { StableMigrationError } from "../../contracts/migration/stable-migration.js";

export interface Source { readonly path: string; readonly stats: BigIntStats }
export interface ByteSource { readonly source: Source | undefined; readonly bytes: Buffer | undefined }
export interface JsonSource extends ByteSource { readonly value: unknown }
export const fail = (code: StableMigrationError["code"]): never => { throw new StableMigrationError(code); };
export const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
export const sameDirectory = (a: BigIntStats, b: BigIntStats): boolean => a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
export async function optional(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }); } catch (error: unknown) { if (missing(error)) return undefined; throw error; }
}
export function safeFile(stats: BigIntStats, privateFile: boolean): void {
  const mode = stats.mode & 0o7777n;
  if (!stats.isFile() || stats.uid !== BigInt(process.getuid!()) || stats.nlink !== 1n ||
    (privateFile ? mode !== 0o600n : mode !== 0o600n && mode !== 0o644n)) fail("UNSAFE_SOURCE");
}
export function safeDirectory(stats: BigIntStats, privateDirectory: boolean): void {
  if (!stats.isDirectory() || stats.uid !== BigInt(process.getuid!()) ||
    (privateDirectory ? (stats.mode & 0o7777n) !== 0o700n : (stats.mode & 0o022n) !== 0n)) fail("UNSAFE_SOURCE");
}
export async function sourceFile(path: string, privateFile: boolean): Promise<{ source: Source; file: FileHandle }> {
  const stats = await lstat(path, { bigint: true }); safeFile(stats, privateFile);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const opened = await file.stat({ bigint: true }); safeFile(opened, privateFile);
    if (!same(stats, opened)) fail("SOURCE_CHANGED"); return { source: { path, stats }, file };
  } catch (error: unknown) { await file.close(); throw error; }
}
export function unchanged(source: Source): void {
  try { if (same(source.stats, lstatSync(source.path, { bigint: true }))) return; } catch { /* Categorize disappearance without exposing the path. */ }
  fail("SOURCE_CHANGED");
}
export function directoryUnchanged(path: string, original: BigIntStats): boolean {
  try { return sameDirectory(original, lstatSync(path, { bigint: true })); } catch { return false; }
}
export function stillAbsent(path: string): void {
  try { lstatSync(path); } catch (error: unknown) { if (missing(error)) return; throw error; }
  fail("SOURCE_CHANGED");
}
/** Read one bounded raw snapshot, retaining identity checks for final publication. */
export async function byteSource(path: string, privateFile: boolean, absent = false): Promise<ByteSource> {
  if (absent && !(await optional(path))) return { source: undefined, bytes: undefined };
  const { source, file } = await sourceFile(path, privateFile);
  try {
    if (source.stats.size > BigInt(MAX_UI_REQUEST_BYTES)) fail("INVALID_DATA");
    const buffer = Buffer.alloc(Number(source.stats.size) + 1); let size = 0;
    while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break; size += read.bytesRead; }
    if (BigInt(size) !== source.stats.size || !same(source.stats, await file.stat({ bigint: true }))) fail("SOURCE_CHANGED");
    unchanged(source); return { source, bytes: buffer.subarray(0, size) };
  } finally { await file.close(); }
}
export async function jsonSource(path: string, privateFile: boolean, absent = false): Promise<JsonSource> {
  const raw = await byteSource(path, privateFile, absent);
  if (!raw.bytes) return { ...raw, value: undefined };
  let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes)); }
  catch { fail("INVALID_DATA"); }
  return { ...raw, value };
}
export async function writeFile(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
export function jsonBytes(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), "utf8"); if (bytes.length > MAX_UI_REQUEST_BYTES) fail("INVALID_DATA"); return bytes;
}
export async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

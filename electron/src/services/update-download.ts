import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createUpdateDownloadTransport, MODEL_DOWNLOAD_CHUNK_BYTES, type DownloadHeaders, type ModelDownloadTransport } from "./model-download-transport.js";
import { projectLinuxUpdateFeed, projectMacosUpdateRelease, type LinuxUpdateCandidate, type MacosUpdateCandidate } from "./update-policy.js";
import { assertPrivateUpdateDirectory, MAX_UPDATE_STAGE_BYTES, retainOwnedUpdateDownload, type OwnedUpdateDownload, type UpdateArtifactName } from "./update-staging.js";

type Failure = "INVALID_INPUT" | "CANCELLED" | "TIMEOUT" | "REDIRECT_FAILED" | "METADATA_FAILED" | "PAYLOAD_TOO_LARGE" | "TRANSPORT_FAILED" | "WRITE_FAILED" | "CLEANUP_FAILED";
export class UpdateDownloadError extends Error {
  readonly cleanup: (() => Promise<void>) | undefined;
  readonly ownersSettled: (() => boolean) | undefined;
  constructor(readonly code: Failure, cleanup?: () => Promise<void>, ownersSettled?: () => boolean) {
    super(code); this.name = "UpdateDownloadError"; this.cleanup = cleanup; this.ownersSettled = ownersSettled;
  }
}
const fail = (code: Failure): never => { throw new UpdateDownloadError(code); };
export interface UpdateDownloadInput {
  readonly candidate: LinuxUpdateCandidate | MacosUpdateCandidate;
  readonly currentVersion: string;
  /** Admitted Mac build repository, never a preference or renderer-selected source. */
  readonly repository?: string;
  readonly cacheDirectory: string;
  readonly signal?: AbortSignal;
  readonly maximumBytes?: number;
  readonly limits?: Readonly<{ headersMs?: number; idleMs?: number; totalMs?: number }>;
}
/** Host-test effects only. Production always uses the fixed public HTTPS factory and positioned original writes. */
export interface UpdateDownloadEffects {
  transport(): ModelDownloadTransport;
  write(file: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number): Promise<number>;
  sync(file: FileHandle): Promise<void>;
}
function candidate(input: UpdateDownloadInput): LinuxUpdateCandidate | MacosUpdateCandidate {
  try {
    const value = input.candidate;
    if (!value || value.authentication !== "unauthenticated" || typeof value.version !== "string") return fail("INVALID_INPUT");
    if (value.package === "macos") {
      if (value.repository !== input.repository) return fail("INVALID_INPUT");
      return projectMacosUpdateRelease({ repository: input.repository, currentVersion: input.currentVersion,
        release: { tag_name: `v${value.version}`, html_url: value.pageURL, body: value.notes, draft: false, prerelease: false,
          assets: [{ name: value.assetName, browser_download_url: value.assetURL }] } });
    }
    const projected = projectLinuxUpdateFeed({ sourceURL: value.feedURL, package: value.package, currentVersion: input.currentVersion,
      feed: { version: value.version, notes: value.notes, platforms: { [value.target]: { url: value.assetURL, signature: value.signature } } } });
    if (projected.assetName !== value.assetName || projected.pageURL !== value.pageURL) return fail("INVALID_INPUT");
    return projected;
  } catch { return fail("INVALID_INPUT"); }
}
function milliseconds(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) return fail("INVALID_INPUT");
  return result;
}
function headers(input: DownloadHeaders): Map<string, string> {
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599 || input.raw.length % 2) return fail("METADATA_FAILED");
  const result = new Map<string, string>(); let size = 0;
  for (let index = 0; index < input.raw.length; index += 2) {
    const key = input.raw[index], value = input.raw[index + 1];
    if (typeof key !== "string" || typeof value !== "string" || !/^[a-z0-9-]+$/iu.test(key) || /[\u0000-\u001f\u007f]/u.test(value)) return fail("METADATA_FAILED");
    size += Buffer.byteLength(key) + Buffer.byteLength(value); if (size > 16 * 1024) return fail("METADATA_FAILED");
    const name = key.toLowerCase();
    if (result.has(name) && ["location", "content-length", "content-encoding", "transfer-encoding"].includes(name)) return fail("METADATA_FAILED");
    result.set(name, value);
  }
  const encoding = result.get("content-encoding");
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") return fail("METADATA_FAILED");
  return result;
}
function redirect(location: string | undefined, previous: URL, initial: string): URL {
  if (!location || location.length > 8192 || /[\\\s\u0000-\u001f\u007f]/u.test(location)) return fail("REDIRECT_FAILED");
  let url: URL; try { url = new URL(location, previous); } catch { return fail("REDIRECT_FAILED"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash ||
      (url.hostname === "github.com" ? url.href !== initial : url.hostname !== "release-assets.githubusercontent.com")) return fail("REDIRECT_FAILED");
  return url;
}
const absent = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;

/** One bounded transfer into a private original file. No metadata fetch, signature success or installation state is produced. */
export async function downloadUpdateCandidate(input: UpdateDownloadInput, effects: Partial<UpdateDownloadEffects> = {}): Promise<Readonly<OwnedUpdateDownload>> {
  const projected = candidate(input), maximum = input.maximumBytes ?? MAX_UPDATE_STAGE_BYTES, signal = input.signal;
  const headersMs = milliseconds(input.limits?.headersMs, 15_000), idleMs = milliseconds(input.limits?.idleMs, 30_000);
  const totalMs = milliseconds(input.limits?.totalMs, 3_600_000);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_UPDATE_STAGE_BYTES || signal?.aborted) return fail(signal?.aborted ? "CANCELLED" : "INVALID_INPUT");
  const cache = input.cacheDirectory, artifactName = projected.assetName as UpdateArtifactName;
  const io: UpdateDownloadEffects = { transport: createUpdateDownloadTransport,
    write: async (file, bytes, offset, length, position) => (await file.write(bytes, offset, length, position)).bytesWritten,
    sync: (file) => file.sync(), ...effects };
  const controller = new AbortController(); let stoppedCode: "CANCELLED" | "TIMEOUT" | undefined;
  let rejectStopped!: (error: UpdateDownloadError) => void;
  const stopped = new Promise<never>((_accept, reject) => { rejectStopped = reject; }); void stopped.catch(() => {});
  const stop = (code: "CANCELLED" | "TIMEOUT"): void => {
    if (stoppedCode) return; stoppedCode = code; rejectStopped(new UpdateDownloadError(code)); controller.abort();
  };
  const cancelled = (): void => stop("CANCELLED");
  signal?.addEventListener("abort", cancelled, { once: true });
  if (signal?.aborted) cancelled();
  const totalTimer = setTimeout(() => { stop("TIMEOUT"); }, totalMs);
  const active = (): void => { if (stoppedCode) fail(stoppedCode); };
  const wait = async <T>(operation: Promise<T>, timeout: number): Promise<T> => {
    const timer = setTimeout(() => { stop("TIMEOUT"); }, timeout);
    try { const result = await Promise.race([operation, stopped]); active(); return result; }
    finally { clearTimeout(timer); }
  };
  let cacheGuard: Awaited<ReturnType<typeof assertPrivateUpdateDirectory>> | undefined;
  let stageGuard: Awaited<ReturnType<typeof assertPrivateUpdateDirectory>> | undefined;
  let stageDirectory: string | undefined, file: FileHandle | undefined, path: string | undefined;
  let stageIdentity: BigIntStats | undefined, fileIdentity: BigIntStats | undefined;
  let transport: ModelDownloadTransport | undefined, transportClosing: Promise<void> | undefined, fileClosing: Promise<void> | undefined;
  let reading: Promise<IteratorResult<Uint8Array>> | undefined, retained: Readonly<OwnedUpdateDownload> | undefined;
  let transportClosed = false, readSettled = false, fileClosed = false;
  const ownersSettled = (): boolean => (!transport || transportClosed) && (!reading || readSettled) &&
    (!file || (retained ? retained.ownersSettled?.() === true : fileClosed));
  let cleaning: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleaning ??= Promise.resolve().then(async () => {
      if (transport) { transportClosing ??= Promise.resolve().then(() => transport!.close()); await transportClosing; transportClosed = true; }
      await reading?.catch(() => {}); readSettled = true;
      if (retained) { await retained.cleanup(); return; }
      if (file) { fileClosing ??= Promise.resolve().then(() => file!.close()); await fileClosing; fileClosed = true; }
      if (!stageDirectory) return;
      await cacheGuard?.assertUnchanged();
      const currentStage = await lstat(stageDirectory, { bigint: true });
      if (!stageIdentity || !same(currentStage, stageIdentity) || !currentStage.isDirectory() || currentStage.isSymbolicLink() ||
          currentStage.uid !== BigInt(process.getuid?.() ?? -1) || (currentStage.mode & 0o7777n) !== 0o700n) return fail("CLEANUP_FAILED");
      await stageGuard?.assertUnchanged();
      if (path) {
        const named = await lstat(path, { bigint: true }).catch((error: unknown) => { if (absent(error)) return undefined; throw error; });
        if (named) {
          if (!fileIdentity || !same(named, fileIdentity) || !named.isFile() || named.nlink !== 1n ||
              named.uid !== BigInt(process.getuid?.() ?? -1) || (named.mode & 0o7777n) !== 0o600n) return fail("CLEANUP_FAILED");
          await unlink(path);
        }
      }
      await stageGuard?.assertUnchanged(); await cacheGuard?.assertUnchanged();
      if (!same(await lstat(stageDirectory, { bigint: true }), stageIdentity)) return fail("CLEANUP_FAILED");
      await rmdir(stageDirectory); stageDirectory = undefined;
    }).catch(() => { throw new UpdateDownloadError("CLEANUP_FAILED", cleanup, ownersSettled); });
    const original = cleaning; void original.catch(() => { if (cleaning === original) cleaning = undefined; }); return original;
  };
  try {
    active(); cacheGuard = await assertPrivateUpdateDirectory(cache); active();
    stageDirectory = await mkdtemp(join(cache, "update-download-"));
    stageIdentity = await lstat(stageDirectory, { bigint: true });
    stageGuard = await assertPrivateUpdateDirectory(stageDirectory); await cacheGuard.assertUnchanged(); active();
    path = join(stageDirectory, artifactName);
    file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fileIdentity = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (!same(named, fileIdentity) || !named.isFile() || named.nlink !== 1n || named.uid !== BigInt(process.getuid?.() ?? -1) ||
        (named.mode & 0o7777n) !== 0o600n) return fail("WRITE_FAILED");
    await stageGuard.assertUnchanged(); await cacheGuard.assertUnchanged(); active();
    transport = io.transport(); let url = new URL(projected.assetURL), received = 0;
    const seen = new Set<string>(); let hops = 0;
    while (true) {
      active(); if (seen.has(url.href)) return fail("REDIRECT_FAILED"); seen.add(url.href);
      const exchange = transport.request(url, "GET", controller.signal), response = await wait(exchange.headers, headersMs);
      const values = headers(response);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (++hops > 5) return fail("REDIRECT_FAILED");
        const next = redirect(values.get("location"), url, projected.assetURL);
        await exchange.close(); active(); url = next; continue;
      }
      if (response.status !== 200) return fail("METADATA_FAILED");
      const length = values.get("content-length"); let expected: number | undefined;
      if (length !== undefined) {
        if (!/^[1-9][0-9]*$/u.test(length)) return fail("METADATA_FAILED"); expected = Number(length);
        if (!Number.isSafeInteger(expected)) return fail("METADATA_FAILED");
        if (expected > maximum) return fail("PAYLOAD_TOO_LARGE");
      }
      const iterator = exchange.body[Symbol.asyncIterator]();
      while (true) {
        reading = iterator.next(); const next = await wait(reading, idleMs); reading = undefined;
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > MODEL_DOWNLOAD_CHUNK_BYTES) return fail("TRANSPORT_FAILED");
        if (chunk.length > maximum - received || (expected !== undefined && chunk.length > expected - received)) return fail("PAYLOAD_TOO_LARGE");
        let offset = 0;
        while (offset < chunk.length) {
          active();
          const written = await io.write(file, chunk, offset, chunk.length - offset, received + offset).catch(() => fail("WRITE_FAILED"));
          active(); if (!Number.isInteger(written) || written < 1 || written > chunk.length - offset) return fail("WRITE_FAILED"); offset += written;
        }
        received += chunk.length;
      }
      await exchange.close(); active();
      const completed = exchange.completion();
      if (!completed.complete || completed.failed || !received || (expected !== undefined && expected !== received)) return fail("TRANSPORT_FAILED");
      break;
    }
    await io.sync(file).catch(() => fail("WRITE_FAILED")); active();
    await cacheGuard.assertUnchanged(); await stageGuard.assertUnchanged(); active();
    retained = await retainOwnedUpdateDownload({ file, stageDirectory, artifactName, maximumBytes: maximum }); active();
    if (retained.bytes !== received) return fail("TRANSPORT_FAILED");
    transportClosing ??= Promise.resolve().then(() => transport!.close()); await transportClosing; transportClosed = true; active();
    return retained;
  } catch (error: unknown) {
    controller.abort(); await cleanup();
    if (error instanceof UpdateDownloadError) throw error;
    throw new UpdateDownloadError(stoppedCode ?? "TRANSPORT_FAILED");
  } finally { clearTimeout(totalTimer); signal?.removeEventListener("abort", cancelled); }
}

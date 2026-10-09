import { createUpdateFeedTransport, MODEL_DOWNLOAD_CHUNK_BYTES, type DownloadHeaders, type ModelDownloadTransport } from "./model-download-transport.js";
import { LINUX_UPDATE_FEED_URL, LINUX_UPDATE_REPOSITORY, macosUpdateEndpoint, parseUpdateVersion,
  projectLinuxUpdateFeed, projectMacosUpdateRelease, UpdatePolicyError, type LinuxUpdateCandidate, type MacosUpdateCandidate } from "./update-policy.js";

export const UPDATE_FEED_BYTES = 1024 * 1024;
type Failure = "INVALID_INPUT" | "CANCELLED" | "TIMEOUT" | "INVALID_METADATA" | "INVALID_REDIRECT" | "TRANSPORT_FAILED" | "CLEANUP_FAILED";
export class UpdateFeedError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "UpdateFeedError"; }
}
const fail = (code: Failure): never => { throw new UpdateFeedError(code); };
export type UpdateFeedInput = Readonly<{ package: "deb" | "appimage"; currentVersion: string; signal?: AbortSignal }> |
  Readonly<{ package: "macos"; repository: string; currentVersion: string; signal?: AbortSignal }>;
/** Host-only test seam; requests always receive endpoints projected by the reader. */
export interface UpdateFeedEffects { transport(): ModelDownloadTransport }
function metadataHeaders(value: DownloadHeaders): Map<string, string> {
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599 || value.raw.length % 2) fail("INVALID_METADATA");
  const result = new Map<string, string>(); let bytes = 0;
  for (let index = 0; index < value.raw.length; index += 2) {
    const name = value.raw[index], field = value.raw[index + 1];
    if (!name || field === undefined || !/^[a-z0-9-]+$/iu.test(name) || /[\u0000-\u001f\u007f]/u.test(field)) return fail("INVALID_METADATA");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(field); if (bytes > 16 * 1024) fail("INVALID_METADATA");
    const key = name.toLowerCase();
    if (result.has(key) && ["location", "content-length", "content-encoding", "transfer-encoding"].includes(key)) fail("INVALID_METADATA");
    result.set(key, field);
  }
  const encoding = result.get("content-encoding");
  if (encoding !== undefined && encoding.toLowerCase() !== "identity") fail("INVALID_METADATA");
  return result;
}
function nextLinuxURL(location: string | undefined, previous: URL): { url: URL; version?: string } {
  if (!location || location.length > 8192 || /[\\\s\u0000-\u001f\u007f]/u.test(location)) return fail("INVALID_REDIRECT");
  let url: URL; try { url = new URL(location, previous); } catch { return fail("INVALID_REDIRECT"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash) fail("INVALID_REDIRECT");
  if (url.hostname === "release-assets.githubusercontent.com") return { url };
  const prefix = `${LINUX_UPDATE_REPOSITORY}/releases/download/v`, suffix = "/latest.json";
  if (!url.href.startsWith(prefix) || !url.href.endsWith(suffix)) return fail("INVALID_REDIRECT");
  const version = url.href.slice(prefix.length, -suffix.length);
  try { parseUpdateVersion(version); } catch { return fail("INVALID_REDIRECT"); }
  if (url.href !== `${prefix}${version}${suffix}`) return fail("INVALID_REDIRECT");
  return { url, version };
}

/** Bounded public metadata only. Returned candidates still require artifact authentication and installation admission. */
export async function readUpdateFeed(input: UpdateFeedInput, effects: UpdateFeedEffects = { transport: createUpdateFeedTransport }): Promise<LinuxUpdateCandidate | MacosUpdateCandidate | undefined> {
  let endpoint: string;
  try {
    parseUpdateVersion(input.currentVersion);
    if (input.package === "macos") endpoint = macosUpdateEndpoint(input.repository);
    else if (input.package === "deb" || input.package === "appimage") endpoint = LINUX_UPDATE_FEED_URL;
    else return fail("INVALID_INPUT");
  } catch { return fail("INVALID_INPUT"); }
  if (input.signal?.aborted) return fail("CANCELLED");
  const controller = new AbortController(); let failure: "CANCELLED" | "TIMEOUT" | undefined;
  let rejectStopped!: (error: UpdateFeedError) => void;
  const stopped = new Promise<never>((_accept, reject) => { rejectStopped = reject; }); void stopped.catch(() => {});
  const stop = (code: "CANCELLED" | "TIMEOUT"): void => {
    if (failure) return; failure = code; controller.abort(); rejectStopped(new UpdateFeedError(code));
  };
  const cancel = (): void => stop("CANCELLED"); input.signal?.addEventListener("abort", cancel, { once: true });
  if (input.signal?.aborted) cancel();
  const total = setTimeout(() => stop("TIMEOUT"), 60_000);
  let transport: ModelDownloadTransport | undefined, pending: Promise<unknown> | undefined;
  const active = (): void => { if (failure) fail(failure); };
  const wait = async <T>(operation: Promise<T>, budget: number): Promise<T> => {
    pending = operation; const timer = setTimeout(() => stop("TIMEOUT"), budget);
    try { const value = await Promise.race([operation, stopped]); pending = undefined; active(); return value; }
    finally { clearTimeout(timer); }
  };
  try {
    active(); transport = effects.transport(); let url = new URL(endpoint), version: string | undefined;
    const seen = new Set<string>(); let hops = 0;
    while (true) {
      active(); if (seen.has(url.href)) fail("INVALID_REDIRECT"); seen.add(url.href);
      const exchange = transport.request(url, "GET", controller.signal), headers = await wait(exchange.headers, 15_000);
      const fields = metadataHeaders(headers);
      if ([301, 302, 303, 307, 308].includes(headers.status)) {
        if (input.package === "macos" || ++hops > 5) fail("INVALID_REDIRECT");
        const next = nextLinuxURL(fields.get("location"), url);
        if (next.version) { if (version && version !== next.version) fail("INVALID_REDIRECT"); version = next.version; }
        await exchange.close(); active(); url = next.url; continue;
      }
      if (headers.status !== 200) fail("INVALID_METADATA");
      const length = fields.get("content-length"); let expected: number | undefined;
      if (length !== undefined) {
        if (!/^[1-9][0-9]*$/u.test(length)) fail("INVALID_METADATA"); expected = Number(length);
        if (!Number.isSafeInteger(expected) || expected > UPDATE_FEED_BYTES) fail("INVALID_METADATA");
      }
      const chunks: Buffer[] = []; let size = 0;
      const iterator = exchange.body[Symbol.asyncIterator]();
      while (true) {
        const part = await wait(iterator.next(), 30_000); if (part.done) break;
        if (!(part.value instanceof Uint8Array) || !part.value.length || part.value.length > MODEL_DOWNLOAD_CHUNK_BYTES ||
          part.value.length > UPDATE_FEED_BYTES - size || (expected !== undefined && part.value.length > expected - size)) fail("INVALID_METADATA");
        chunks.push(Buffer.from(part.value)); size += part.value.length;
      }
      await exchange.close(); active();
      const completion = exchange.completion();
      if (!completion.complete || completion.failed || !size || (expected !== undefined && expected !== size)) fail("TRANSPORT_FAILED");
      let metadata: unknown;
      try { metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown; }
      catch { return fail("INVALID_METADATA"); }
      if (version && (typeof metadata !== "object" || metadata === null || Reflect.get(metadata, "version") !== version)) fail("INVALID_METADATA");
      try {
        return input.package === "macos" ? projectMacosUpdateRelease({ repository: input.repository, currentVersion: input.currentVersion, release: metadata }) :
          projectLinuxUpdateFeed({ sourceURL: endpoint, package: input.package, currentVersion: input.currentVersion, feed: metadata });
      } catch (error: unknown) {
        if (error instanceof UpdatePolicyError && error.code === "NOT_NEWER") return undefined;
        return fail("INVALID_METADATA");
      }
    }
  } catch (error: unknown) {
    if (error instanceof UpdateFeedError) throw error;
    return fail(failure ?? "TRANSPORT_FAILED");
  } finally {
    controller.abort(); clearTimeout(total); input.signal?.removeEventListener("abort", cancel);
    const settled = await Promise.allSettled([Promise.resolve().then(() => transport?.close()), pending?.catch(() => {})]);
    if (settled.some((result) => result.status === "rejected")) fail("CLEANUP_FAILED");
  }
}

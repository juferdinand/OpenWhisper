import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const IMAGE = "sha256:3031f986bb255608939c32b3929435c929efb4ce9be398786e369b1111d73431";
export const NODE_VERSION = "24.21.0";
export const NODE_ARCHIVE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";
export const NODE_BINARY_SHA256 = "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c";
export const REVIEW_TOKEN = "reviewed-owned-loopback-tls-v1";
export const HOME = "/fixtures/openwhisper-owned-tls";
export const ORIGINAL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin";
export const REDIRECT = "https://us.aws.cdn.hf.co/openwhisper-owned-tls.bin";
export const BODY_BYTES = 1_000_017;
export const CHUNK_BYTES = 16_384;
export const BOUNDS = Object.freeze({ toolMs: 4000, caseMs: 6000, cleanupMs: 1500,
  fixtureMs: 150_000, dockerMs: 10_000, executeMs: 170_000, outerMs: 280_000 });
export const CASES = ["success", "untrusted-ca", "wrong-san", "truncated", "late-local-error", "cancel-headers", "cancel-body",
  "deadline-headers", "deadline-idle", "deadline-total", "held-request", "held-response", "held-socket"] as const;
export const caseSchema = z.enum(CASES);
export type Case = z.infer<typeof caseSchema>;
export type Component = "request" | "response" | "socket";
export class FixtureError extends Error { constructor() { super("OWNED_TLS_FAILED"); } }
export const PREPARED_CACHE_ENTRIES = ["control", "locks", "session"] as const;
/** A prepared Dev profile intentionally retains these empty directories.
 * Download cleanup must reject every additional staging entry. */
export async function validatePreparedCache(path: string, uid: number): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0") || !Number.isSafeInteger(uid) || uid < 0) throw new FixtureError();
  const privateDirectory = async (directory: string): Promise<void> => {
    if (await realpath(directory) !== directory) throw new FixtureError();
    const value = await lstat(directory);
    if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== uid || (value.mode & 0o7777) !== 0o700) throw new FixtureError();
  };
  await privateDirectory(path);
  if (JSON.stringify((await readdir(path)).sort()) !== JSON.stringify(PREPARED_CACHE_ENTRIES)) throw new FixtureError();
  for (const name of PREPARED_CACHE_ENTRIES) {
    const directory = join(path, name); await privateDirectory(directory);
    if ((await readdir(directory)).length !== 0) throw new FixtureError();
  }
}
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const inputSchema = z.strictObject({ version: z.literal(1), image: z.literal(IMAGE), node: z.literal(NODE_VERSION),
  nodeArchiveSha256: z.literal(NODE_ARCHIVE_SHA256), nodeBinarySha256: z.literal(NODE_BINARY_SHA256),
  fixtureSha256: digest, catalogSha256: digest, zodLicenseSha256: digest,
  sources: z.record(z.string().regex(/^(?:electron|shared)\/[A-Za-z0-9_./-]+$/u), digest),
  authoredLanguage: z.literal("TypeScript"), runtimeReviewedSeparately: z.literal(true) });
export function bodyChunk(position: number, maximum = CHUNK_BYTES): Buffer {
  if (!Number.isSafeInteger(position) || position < 0 || position > BODY_BYTES || !Number.isInteger(maximum) || maximum < 1 || maximum > CHUNK_BYTES) throw new FixtureError();
  const out = Buffer.alloc(Math.min(maximum, BODY_BYTES - position));
  for (let i = 0; i < out.length; i++) out[i] = ((position + i) * 17 + 31) & 255;
  return out;
}
export function bodyHash(): string {
  const digest = createHash("sha256");
  for (let p = 0; p < BODY_BYTES; p += CHUNK_BYTES) digest.update(bodyChunk(p));
  return digest.digest("hex");
}
export function route(url: URL, method: unknown): "resolve" | "payload" {
  if (method !== "HEAD" && method !== "GET") throw new FixtureError();
  if (url.href === ORIGINAL) return "resolve";
  if (url.href === REDIRECT && method === "GET") return "payload";
  throw new FixtureError();
}
export const errorSchema = z.enum(["CANCELLED", "TIMEOUT", "TRANSPORT_FAILED", "INTEGRITY_FAILED", "CLEANUP_FAILED"]);
const count = z.number().int().nonnegative().max(256);
export const witnessSchema = z.strictObject({ acquired: count, closed: count, errors: count });
export const resultSchema = z.strictObject({ case: caseSchema, status: z.literal("PASS"), outcome: z.union([z.literal("installed"), errorSchema]),
  bodyBytes: z.literal(BODY_BYTES), bodySha256: z.string().regex(/^[a-f0-9]{64}$/u), maximumChunkBytes: z.number().int().nonnegative().max(65_536),
  requestCount: count, serverRequestCount: count, request: witnessSchema, response: witnessSchema, socket: witnessSchema,
  serverAcquired: count, serverClosed: count, serverCloseObserved: z.literal(true), serverConnections: z.literal(0),
  cleanupFinalized: z.literal(true), notificationBarrier: z.enum(["none", "request", "response", "socket"]),
  notificationOnly: z.boolean(), apparentEOFObserved: z.boolean(), localErrorObserved: z.boolean(),
  parserIncompleteObserved: z.boolean(),
  elapsedMilliseconds: z.number().finite().nonnegative().max(BOUNDS.caseMs + BOUNDS.cleanupMs) });
export const suiteSchema = z.strictObject({ scope: z.literal("owned-loopback-tls-with-fixture-routing-and-ca"), node: z.literal(NODE_VERSION),
  image: z.literal(IMAGE), cases: z.array(resultSchema).length(CASES.length), noProductionTrustOverride: z.literal(true),
  noProviderDownload: z.literal(true), noElectronRuntime: z.literal(true), privateProfileOnly: z.literal(true) });
export function validateSuite(input: unknown): z.infer<typeof suiteSchema> {
  const value = suiteSchema.parse(input);
  if (value.cases.some((item, i) => item.case !== CASES[i] || item.bodySha256 !== bodyHash() ||
    item.request.closed !== item.request.acquired || item.response.closed !== item.response.acquired || item.socket.closed !== item.socket.acquired ||
    item.serverAcquired !== item.serverClosed || item.notificationOnly !== (item.notificationBarrier !== "none"))) throw new FixtureError();
  for (const item of value.cases) {
    const expected = item.case === "success" ? "installed" : item.case.startsWith("held-") ? "CLEANUP_FAILED" :
      item.case.startsWith("cancel-") ? "CANCELLED" : item.case.startsWith("deadline-") ? "TIMEOUT" : "TRANSPORT_FAILED";
    if (item.outcome !== expected || item.request.acquired !== item.requestCount || !item.requestCount ||
      item.notificationBarrier !== (item.case.startsWith("held-") ? item.case.slice(5) : "none") ||
      (item.case === "success" && (item.maximumChunkBytes === 0 || item.requestCount !== 3 || item.serverRequestCount !== 3)) ||
      ((item.case === "wrong-san" || item.case === "untrusted-ca") && item.serverRequestCount !== 0) ||
      (item.case === "truncated" && !item.parserIncompleteObserved) ||
      (item.case === "late-local-error" && (!item.apparentEOFObserved || !item.localErrorObserved))) throw new FixtureError();
  }
  return value;
}
/** Every asynchronous bound checks elapsed time as well as timer ordering. */
export async function bounded<T>(work: Promise<T>, milliseconds: number, now: () => number = performance.now.bind(performance)): Promise<T> {
  const deadline = now() + milliseconds; let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new FixtureError()); }, milliseconds); })]);
    if (now() >= deadline) throw new FixtureError(); return value;
  } finally { if (timer) clearTimeout(timer); }
}

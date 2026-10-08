import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { z } from "zod";
import { modelDownloadURL, type CatalogModel } from "../core/model-catalog.js";
import { MAX_MODEL_BYTES, ModelInventory, ModelInventoryError, type ImportedModel, type ModelPublicationReceipt } from "./model-inventory.js";
import { prepareHostProfile, type HostProfile } from "./host-profile.js";
import { createModelDownloadTransport, MODEL_DOWNLOAD_CHUNK_BYTES, type DownloadHeaders, type ModelDownloadExchange,
  type ModelDownloadTransport } from "./model-download-transport.js";

export type ModelDownloadFailure = "INVALID_PROFILE" | "INVALID_ID" | "BUSY" | "EXISTS" | "CANCELLED" | "TIMEOUT" |
  "UNSAFE_STAGING" | "TRANSPORT_FAILED" | "METADATA_FAILED" | "REDIRECT_FAILED" | "INTEGRITY_FAILED" |
  "STORAGE_FAILED" | "PUBLICATION_FAILED" | "COMMITTED_UNCERTAIN" | "CLEANUP_FAILED";
export class ModelDownloadError extends Error {
  constructor(readonly code: ModelDownloadFailure) { super(code); this.name = "ModelDownloadError"; }
}
export interface DownloadedCatalogModel {
  readonly installed: ImportedModel;
  readonly integrity: Readonly<{ verification: "server-integrity"; bytes: number; sha256: string; finalHost: string }>;
  /** A committed model and an unretired private staging obligation are distinct. */
  readonly cleanupPending: boolean;
}
export interface ModelDownloadProgress { readonly received: number; readonly total: number }
export interface ModelDownloadIO {
  write(file: FileHandle, bytes: Uint8Array): Promise<void>;
  sync(file: FileHandle): Promise<void>;
  close(file: FileHandle): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}
/** Host construction only. These effects are never accepted as download input. */
export interface ModelDownloadHost {
  readonly transport?: () => ModelDownloadTransport;
  readonly io?: Partial<ModelDownloadIO>;
  readonly progress?: (progress: ModelDownloadProgress) => void;
  readonly limits?: Readonly<{ headersMs?: number; idleMs?: number; totalMs?: number; cleanupMs?: number }>;
}
const limitsSchema = z.strictObject({ headersMs: z.number().int().positive().max(300_000).default(15_000),
  idleMs: z.number().int().positive().max(300_000).default(30_000), totalMs: z.number().int().positive().max(3_600_000).default(3_600_000),
  cleanupMs: z.number().int().positive().max(60_000).default(8000) });
type Limits = z.infer<typeof limitsSchema>;
interface Inode { readonly dev: bigint; readonly ino: bigint }
const same = (a: Inode, b: Inode): boolean => a.dev === b.dev && a.ino === b.ino;
const inode = (s: BigIntStats): Inode => ({ dev: s.dev, ino: s.ino });
function fail(code: ModelDownloadFailure): never { throw new ModelDownloadError(code); }
const enoent = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const redirects = new Set([301, 302, 303, 307, 308]);

export function validateModelDownloadURL(url: URL): void {
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash ||
    isIP(url.hostname) || url.hostname.startsWith("[") || url.hostname.endsWith(".") ||
    !["hf.co", "huggingface.co"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) fail("REDIRECT_FAILED");
}
function headers(input: DownloadHeaders): Map<string, string[]> {
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599 || input.raw.length % 2 ||
    input.raw.reduce((size, value) => size + Buffer.byteLength(value), 0) > 16 * 1024) fail("METADATA_FAILED");
  const values = new Map<string, string[]>();
  for (let i = 0; i < input.raw.length; i += 2) {
    const key = input.raw[i], value = input.raw[i + 1];
    if (!key || value === undefined || !/^[a-z0-9-]+$/iu.test(key) || /[\u0000-\u001f\u007f]/u.test(value)) fail("METADATA_FAILED");
    const name = key.toLowerCase(), old = values.get(name) ?? []; old.push(value); values.set(name, old);
  }
  return values;
}
function one(values: Map<string, string[]>, key: string, required = false): string | undefined {
  const found = values.get(key);
  if (!found) { if (required) fail("METADATA_FAILED"); return undefined; }
  if (found.length !== 1) fail("METADATA_FAILED"); return found[0];
}
function encoding(values: Map<string, string[]>): void {
  const value = one(values, "content-encoding"); if (value !== undefined && value.toLowerCase() !== "identity") fail("METADATA_FAILED");
}
function integer(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) fail("METADATA_FAILED");
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed > MAX_MODEL_BYTES) fail("METADATA_FAILED"); return parsed;
}
/** Server-linked integrity metadata, not a project signature or weight check. */
export function parseModelDownloadMetadata(input: DownloadHeaders): Readonly<{ bytes: number; sha256: string }> {
  if (!(input.status >= 200 && input.status < 300) && !redirects.has(input.status)) fail("METADATA_FAILED");
  const values = headers(input); encoding(values);
  const digest = one(values, "x-linked-etag", true), size = integer(one(values, "x-linked-size", true));
  if (!digest || !/^(?:[a-f0-9]{64}|"[a-f0-9]{64}")$/u.test(digest) || size < 1_000_000) fail("METADATA_FAILED");
  // HEAD Content-Length describes the redirect representation, not the model.
  const contentLength = one(values, "content-length"); if (contentLength !== undefined && !/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) fail("METADATA_FAILED");
  return Object.freeze({ bytes: size, sha256: digest.startsWith('"') ? digest.slice(1, -1) : digest });
}
async function directory(path: string, expected?: Inode): Promise<Inode> {
  const uid = process.getuid?.(); if (uid === undefined) fail("UNSAFE_STAGING");
  const ancestors: string[] = [];
  for (let cursor = path;; cursor = dirname(cursor)) { ancestors.push(cursor); if (dirname(cursor) === cursor) break; }
  let result: Inode | undefined;
  try {
    for (const name of ancestors.reverse()) {
      const stats = await lstat(name, { bigint: true }), mode = stats.mode & 0o7777n;
      if (!stats.isDirectory() || stats.isSymbolicLink()) fail("UNSAFE_STAGING");
      if (name === path) {
        if (stats.uid !== BigInt(uid) || mode !== 0o700n || (expected && !same(stats, expected))) fail("UNSAFE_STAGING"); result = inode(stats);
      } else if ((stats.uid !== 0n && stats.uid !== BigInt(uid)) ||
        ((mode & 0o022n) && !(stats.uid === 0n && (mode & 0o1000n)))) fail("UNSAFE_STAGING");
    }
  } catch { fail("UNSAFE_STAGING"); }
  if (!result) fail("UNSAFE_STAGING"); return result;
}
function ownedFile(stats: BigIntStats, expected: Inode): void {
  if (!stats.isFile() || stats.isSymbolicLink() || !same(stats, expected) || stats.uid !== BigInt(process.getuid?.() ?? -1) ||
    (stats.mode & 0o7777n) !== 0o600n || stats.nlink !== 1n) fail("UNSAFE_STAGING");
}
async function write(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, null);
    if (!result.bytesWritten || result.bytesWritten > bytes.length - offset) fail("STORAGE_FAILED"); offset += result.bytesWritten;
  }
}
interface Attempt {
  readonly owner: symbol; readonly model: CatalogModel; readonly controller: AbortController;
  readonly receipt: ModelPublicationReceipt;
  driver?: Promise<void>; transport?: ModelDownloadTransport; transportClosing?: Promise<void>;
  stage?: string; stageIdentity?: Inode; file?: FileHandle; filePath?: string; fileIdentity?: Inode; fileClosing?: Promise<void>;
  imported?: ImportedModel; metadata?: Readonly<{ bytes: number; sha256: string }>; finalHost?: string;
  cleanupWork?: Promise<void>; publicationConfirming?: Promise<ImportedModel>;
  publicationError?: ModelInventoryError; cleanupComplete: boolean; completed: boolean; error?: ModelDownloadError;
}
interface DownloadState { readonly parent: Inode; readonly models: string; attempt?: Attempt }
// Host-process cooperation only; this is not an interprocess crash-recovery lock.
const downloads = new Map<string, DownloadState>();

export class ModelDownloads {
  private readonly owner = Symbol("catalog download service");
  private constructor(private readonly profile: HostProfile, private readonly inventory: ModelInventory,
    private readonly state: DownloadState, private readonly host: ModelDownloadHost, private readonly limits: Limits,
    private readonly io: ModelDownloadIO) {}
  static async open(profile: HostProfile, inventory: ModelInventory, host: ModelDownloadHost = {}): Promise<ModelDownloads> {
    try { prepareHostProfile(profile); if (!inventory.belongsToProfile(profile)) fail("INVALID_PROFILE"); }
    catch { fail("INVALID_PROFILE"); }
    const limits = limitsSchema.parse(host.limits ?? {}), parent = await directory(profile.paths.cache);
    let state = downloads.get(profile.paths.cache);
    if (state && (!same(state.parent, parent) || state.models !== profile.paths.models)) {
      if (state.attempt) fail("UNSAFE_STAGING"); state = undefined;
    }
    state ??= { parent, models: profile.paths.models }; downloads.set(profile.paths.cache, state);
    return new ModelDownloads(profile, inventory, state, host, limits, { write: host.io?.write ?? write,
      sync: host.io?.sync ?? ((file) => file.sync()), close: host.io?.close ?? ((file) => file.close()),
      unlink: host.io?.unlink ?? unlink, rmdir: host.io?.rmdir ?? rmdir });
  }
  private active(attempt: Attempt): void {
    if (attempt.controller.signal.aborted) fail(attempt.error?.code === "TIMEOUT" ? "TIMEOUT" : "CANCELLED");
    if (this.state.attempt !== attempt) fail("BUSY");
  }
  private async bound<T>(effect: Promise<T>, milliseconds: number, code: ModelDownloadFailure): Promise<T> {
    const deadline = performance.now() + milliseconds; let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([effect, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new ModelDownloadError(code)); }, milliseconds);
      })]);
      if (performance.now() >= deadline) fail(code); return value;
    } finally { if (timer) clearTimeout(timer); }
  }
  private async closeExchange(exchange: ModelDownloadExchange): Promise<void> {
    try { await this.bound(exchange.close(), this.limits.cleanupMs, "CLEANUP_FAILED"); }
    catch { fail("CLEANUP_FAILED"); }
  }
  private request(attempt: Attempt, url: URL, method: "HEAD" | "GET"): ModelDownloadExchange {
    this.active(attempt); if (!attempt.transport) fail("TRANSPORT_FAILED");
    try { return attempt.transport.request(url, method, attempt.controller.signal); }
    catch { this.active(attempt); fail("TRANSPORT_FAILED"); }
  }
  private async getHeaders(attempt: Attempt, exchange: ModelDownloadExchange): Promise<DownloadHeaders> {
    try { const result = await this.bound(exchange.headers, this.limits.headersMs, "TIMEOUT"); this.active(attempt); return result; }
    catch (error: unknown) {
      if (error instanceof ModelDownloadError) throw error; this.active(attempt); fail("TRANSPORT_FAILED");
    }
  }
  private async consume(attempt: Attempt, exchange: ModelDownloadExchange, maximum: number,
    accept: (chunk: Uint8Array) => Promise<void>): Promise<number> {
    const iterator = exchange.body[Symbol.asyncIterator](); let total = 0;
    for (;;) {
      this.active(attempt);
      let value: IteratorResult<Uint8Array>;
      try { value = await this.bound(iterator.next(), this.limits.idleMs, "TIMEOUT"); }
      catch (error: unknown) { if (error instanceof ModelDownloadError) throw error; this.active(attempt); fail("TRANSPORT_FAILED"); }
      this.active(attempt); if (value.done) break;
      const chunk = value.value;
      if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > MODEL_DOWNLOAD_CHUNK_BYTES || total + chunk.length > maximum) fail("INTEGRITY_FAILED");
      await accept(chunk); this.active(attempt); total += chunk.length;
    }
    await this.closeExchange(exchange); this.active(attempt);
    const complete = exchange.completion(); if (!complete.complete || complete.failed) fail("TRANSPORT_FAILED"); return total;
  }
  private closeFile(attempt: Attempt): Promise<void> {
    const file = attempt.file; if (!file) return Promise.resolve();
    attempt.fileClosing ??= Promise.resolve().then(() => this.io.close(file));
    return attempt.fileClosing;
  }
  private async cleanup(attempt: Attempt): Promise<void> {
    if (!attempt.cleanupWork) {
      const work = this.performCleanup(attempt); attempt.cleanupWork = work;
      void work.catch(() => { if (attempt.cleanupWork === work) delete attempt.cleanupWork; });
    }
    await this.bound(attempt.cleanupWork, this.limits.cleanupMs, "CLEANUP_FAILED");
  }
  private async performCleanup(attempt: Attempt): Promise<void> {
    if (attempt.cleanupComplete) return;
    // Do not delete a file while a late write/import is still running. Cleanup is
    // entered by the retained driver, or explicitly after that driver settles.
    const transport = attempt.transport;
    if (transport) {
      attempt.transportClosing ??= Promise.resolve().then(() => transport.close());
      await this.bound(attempt.transportClosing, this.limits.cleanupMs, "CLEANUP_FAILED");
    }
    await this.bound(this.closeFile(attempt), this.limits.cleanupMs, "CLEANUP_FAILED");
    await this.bound(this.inventory.finishImportCleanup(attempt.receipt), this.limits.cleanupMs, "CLEANUP_FAILED");
    await directory(this.profile.paths.cache, this.state.parent);
    if (attempt.stage) {
      if (!attempt.stageIdentity) fail("CLEANUP_FAILED");
      try { await lstat(attempt.stage); }
      catch (error: unknown) { if (enoent(error)) { attempt.cleanupComplete = true; return; } throw error; }
      await directory(attempt.stage, attempt.stageIdentity);
      if (attempt.filePath) {
        if (!attempt.fileIdentity) fail("CLEANUP_FAILED");
        try { ownedFile(await lstat(attempt.filePath, { bigint: true }), attempt.fileIdentity); await this.io.unlink(attempt.filePath); }
        catch (error: unknown) { if (!enoent(error)) fail("CLEANUP_FAILED"); }
      }
      await directory(attempt.stage, attempt.stageIdentity); await this.io.rmdir(attempt.stage);
    }
    attempt.cleanupComplete = true;
  }
  private result(attempt: Attempt): DownloadedCatalogModel {
    if (!attempt.imported || !attempt.metadata || !attempt.finalHost) fail("PUBLICATION_FAILED");
    return Object.freeze({ installed: attempt.imported, integrity: Object.freeze({ verification: "server-integrity",
      ...attempt.metadata, finalHost: attempt.finalHost }), cleanupPending: !attempt.cleanupComplete });
  }
  private retire(attempt: Attempt): void {
    // A late/concurrent finalizer must never clear a newer profile owner.
    if (this.state.attempt === attempt) delete this.state.attempt;
  }
  private async drive(attempt: Attempt): Promise<void> {
    try {
      this.active(attempt);
      if ((await this.inventory.installed()).some((item) => item.model.id === attempt.model.id)) fail("EXISTS"); this.active(attempt);
      await directory(this.profile.paths.cache, this.state.parent);
      attempt.stage = await mkdtemp(join(this.profile.paths.cache, "model-download-"));
      attempt.stageIdentity = await directory(attempt.stage);
      attempt.filePath = join(attempt.stage, attempt.model.file);
      attempt.file = await open(attempt.filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      attempt.fileIdentity = inode(await attempt.file.stat({ bigint: true })); this.active(attempt);
      try { attempt.transport = (this.host.transport ?? createModelDownloadTransport)(); }
      catch { fail("TRANSPORT_FAILED"); } this.active(attempt);
      const original = new URL(modelDownloadURL(attempt.model) as string); validateModelDownloadURL(original);
      const head = this.request(attempt, original, "HEAD");
      attempt.metadata = parseModelDownloadMetadata(await this.getHeaders(attempt, head));
      await this.consume(attempt, head, 16 * 1024, async () => {});
      let current = original, hops = 0; const seen = new Set([original.href]);
      for (;;) {
        this.active(attempt); validateModelDownloadURL(current);
        const get = this.request(attempt, current, "GET"), reply = await this.getHeaders(attempt, get);
        const values = headers(reply); encoding(values);
        if (redirects.has(reply.status)) {
          const location = one(values, "location", true); if (!location || /[\\\u0000-\u0020\u007f]/u.test(location) || ++hops > 5) fail("REDIRECT_FAILED");
          let next: URL; try { next = new URL(location, current); } catch { fail("REDIRECT_FAILED"); }
          validateModelDownloadURL(next); if (seen.has(next.href)) fail("REDIRECT_FAILED"); seen.add(next.href);
          await this.closeExchange(get); this.active(attempt); current = next; continue;
        }
        if (reply.status !== 200 || values.has("content-range")) fail("TRANSPORT_FAILED");
        const length = one(values, "content-length");
        if (length !== undefined && integer(length) !== attempt.metadata.bytes) fail("INTEGRITY_FAILED");
        const digest = createHash("sha256"); let received = 0, lastProgress = -Infinity;
        const bytes = await this.consume(attempt, get, attempt.metadata.bytes, async (chunk) => {
          if (!attempt.file) fail("STORAGE_FAILED"); await this.io.write(attempt.file, chunk); this.active(attempt);
          digest.update(chunk); received += chunk.length;
          if (this.host.progress && performance.now() - lastProgress >= 100) {
            lastProgress = performance.now(); this.host.progress(Object.freeze({ received, total: attempt.metadata?.bytes ?? 0 }));
          }
        });
        if (bytes !== attempt.metadata.bytes || digest.digest("hex") !== attempt.metadata.sha256) fail("INTEGRITY_FAILED");
        attempt.finalHost = current.hostname; break;
      }
      this.active(attempt); await this.io.sync(attempt.file); this.active(attempt);
      ownedFile(await attempt.file.stat({ bigint: true }), attempt.fileIdentity);
      if ((await attempt.file.stat({ bigint: true })).size !== BigInt(attempt.metadata.bytes)) fail("INTEGRITY_FAILED");
      await this.closeFile(attempt); this.active(attempt);
      await directory(this.profile.paths.cache, this.state.parent); await directory(attempt.stage, attempt.stageIdentity);
      ownedFile(await lstat(attempt.filePath, { bigint: true }), attempt.fileIdentity); this.active(attempt);
      attempt.imported = await this.inventory.import(attempt.filePath, { expected: attempt.metadata, receipt: attempt.receipt,
        signal: attempt.controller.signal });
    } catch (error: unknown) {
      if (error instanceof ModelInventoryError) {
        // Never adopt or finish an unrelated same-ID uncertain publication.
        if (error.receipt === attempt.receipt) attempt.publicationError = error;
        attempt.error = new ModelDownloadError(error.code === "COMMITTED_UNCERTAIN" ? "COMMITTED_UNCERTAIN" :
          error.code === "INTEGRITY_FAILED" ? "INTEGRITY_FAILED" : "PUBLICATION_FAILED");
      } else attempt.error = error instanceof ModelDownloadError ? error : new ModelDownloadError("STORAGE_FAILED");
      attempt.controller.abort();
    } finally {
      try { await this.cleanup(attempt); } catch { attempt.error = new ModelDownloadError("CLEANUP_FAILED"); }
      attempt.completed = true;
    }
  }
  /** Catalog ID + optional cancellation only. No target or network options. */
  async download(input: unknown, signal?: AbortSignal): Promise<DownloadedCatalogModel> {
    if (typeof input !== "string" || !(signal === undefined || signal instanceof AbortSignal)) fail("INVALID_ID");
    const model = this.inventory.catalog.models.find((entry) => entry.id === input);
    if (!model || !modelDownloadURL(model)) fail("INVALID_ID");
    if (signal?.aborted) fail("CANCELLED"); if (this.state.attempt) fail("BUSY");
    const attempt: Attempt = { owner: this.owner, model, controller: new AbortController(),
      receipt: this.inventory.createPublicationReceipt(model.id), cleanupComplete: false, completed: false };
    this.state.attempt = attempt;
    const abort = (): void => { attempt.controller.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    attempt.driver = this.drive(attempt);
    void attempt.driver.finally(() => { signal?.removeEventListener("abort", abort); });
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => { cancel = () => { reject(new ModelDownloadError("CANCELLED")); };
      attempt.controller.signal.addEventListener("abort", cancel, { once: true }); });
    try {
      await this.bound(Promise.race([attempt.driver, cancelled]), this.limits.totalMs, "TIMEOUT");
      if (attempt.imported) {
        const result = this.result(attempt); if (attempt.cleanupComplete) this.retire(attempt); return result;
      }
      throw attempt.error ?? new ModelDownloadError("PUBLICATION_FAILED");
    } catch (error: unknown) {
      if (error instanceof ModelDownloadError && error.code === "TIMEOUT") attempt.error = error;
      attempt.controller.abort();
      // A categorical pipeline failure beats its internal abort notification.
      throw attempt.error ?? (error instanceof ModelDownloadError ? error : new ModelDownloadError("STORAGE_FAILED"));
    } finally { attempt.controller.signal.removeEventListener("abort", cancel); }
  }
  /** Explicitly finish only this service's retained owner. No request or import
   * is retried, and no ID-based uncertain publication is adopted. */
  async finalize(): Promise<DownloadedCatalogModel | null> {
    const attempt = this.state.attempt; if (!attempt) return null;
    if (attempt.owner !== this.owner) fail("BUSY");
    if (attempt.driver) await this.bound(attempt.driver, this.limits.cleanupMs, "CLEANUP_FAILED");
    if (attempt.publicationError?.receipt === attempt.receipt && !attempt.imported) {
      try {
        if (!attempt.publicationConfirming) {
          const work = this.inventory.ensurePublicationCommitted(attempt.receipt); attempt.publicationConfirming = work;
          void work.catch(() => { if (attempt.publicationConfirming === work) delete attempt.publicationConfirming; });
        }
        attempt.imported = await this.bound(attempt.publicationConfirming, this.limits.cleanupMs, "COMMITTED_UNCERTAIN");
      }
      catch { fail("COMMITTED_UNCERTAIN"); }
    }
    try { await this.cleanup(attempt); } catch { fail("CLEANUP_FAILED"); }
    this.retire(attempt); return attempt.imported ? this.result(attempt) : null;
  }
}

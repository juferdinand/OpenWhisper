import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { SpeechWorkerError } from "./speech-client.js";

export const resourceBackendSchema = z.enum(["cpu", "vulkan", "metal"]);
export type ResourceBackend = z.infer<typeof resourceBackendSchema>;
const hostSchema = z.strictObject({ platform: z.enum(["linux", "darwin"]), architecture: z.enum(["x64", "arm64"]) });
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const entrySchema = z.strictObject({ backend: resourceBackendSchema, bytes: z.number().int().positive().max(512 * 1024 * 1024), sha256: digest });
export const speechResourceCatalogSchema = z.strictObject({ version: z.literal(1), ...hostSchema.shape,
  napiVersion: z.literal(8), speechRevision: z.literal("927cfce34f31707e17f2bff35c349632fb9e2c3a"),
  speechSourceSha256: z.literal("41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde"),
  entries: z.array(entrySchema).min(1).max(3),
}).superRefine((value, context) => {
  const backends = value.entries.map((entry) => entry.backend);
  if (!backends.includes("cpu") || new Set(backends).size !== backends.length ||
    (value.platform === "linux" && backends.includes("metal")) || (value.platform === "darwin" && backends.includes("vulkan"))) {
    context.addIssue({ code: "custom", message: "Resource catalog backends must agree with the host." });
  }
});

const catalogBrand: unique symbol = Symbol("prepared-speech-resources");
export interface PreparedSpeechResources { readonly [catalogBrand]: true }
export interface VerifiedSpeechResource {
  readonly backend: ResourceBackend;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
/** Host-only effects for private filesystem fault tests; never selected by IPC. */
export interface SpeechResourceFiles {
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: number): Promise<Pick<FileHandle, "stat" | "read" | "close">>;
}
const actualFiles: SpeechResourceFiles = { lstat: (path) => lstat(path, { bigint: true }), realpath, open };
interface RootOwner {
  readonly root: string;
  readonly identity: BigIntStats;
  readonly files: SpeechResourceFiles;
  queue: Promise<void>;
  failedClosure?: Promise<void>;
  heldFile?: Pick<FileHandle, "stat" | "read" | "close">;
}
interface CatalogState {
  readonly owner: RootOwner;
  readonly entries: ReadonlyMap<ResourceBackend, z.infer<typeof entrySchema>>;
}
const prepared = new WeakMap<PreparedSpeechResources, CatalogState>();
// Cooperating catalog handles cannot escape an earlier descriptor-close failure.
const roots = new Map<string, RootOwner>();
const rootPaths = new Map<string, RootOwner>();
function failure(code: "INTEGRITY_FAILED" | "TEARDOWN_FAILED" = "INTEGRITY_FAILED"): SpeechWorkerError {
  return new SpeechWorkerError(code);
}
function safeDirectory(stat: BigIntStats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022n) === 0n;
}
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Input originates in trusted host code; a mutable sidecar never establishes release authenticity. */
export async function prepareSpeechResources(root: string, input: unknown,
  host: unknown = { platform: process.platform, architecture: process.arch }, files: SpeechResourceFiles = actualFiles): Promise<PreparedSpeechResources> {
  try {
    const environment = hostSchema.parse(host), catalog = speechResourceCatalogSchema.parse(input);
    if (catalog.platform !== environment.platform || catalog.architecture !== environment.architecture || !isAbsolute(root) ||
      root.includes("\0") || root !== resolve(root)) throw failure();
    // Replacing this directory must not create a new owner while the original
    // descriptor remains held. Keep logical-path and physical-identity fences.
    const previous = rootPaths.get(root);
    if (previous?.failedClosure) throw failure("TEARDOWN_FAILED");
    const identity = await files.lstat(root);
    if (!safeDirectory(identity) || await files.realpath(root) !== root) throw failure();
    const key = `${identity.dev}:${identity.ino}`;
    // Another preparation may register an owner while filesystem checks await.
    // Re-read the logical fence in this synchronous lookup/registration turn.
    let owner = rootPaths.get(root) ?? roots.get(key);
    if (owner) {
      if (owner.failedClosure) throw failure("TEARDOWN_FAILED");
      if (owner.root !== root || owner.files !== files || !sameIdentity(owner.identity, identity)) throw failure();
    } else {
      owner = { root, identity, files, queue: Promise.resolve() }; roots.set(key, owner);
    }
    rootPaths.set(root, owner);
    const token = Object.freeze({ [catalogBrand]: true as const });
    prepared.set(token, { owner, entries: new Map(catalog.entries.map((entry) => [entry.backend, Object.freeze(entry)])) });
    return token;
  } catch (error) { if (error instanceof SpeechWorkerError) throw error; throw failure(); }
}

async function ancestors(owner: RootOwner, backend: ResourceBackend): Promise<readonly BigIntStats[]> {
  const root = await owner.files.lstat(owner.root);
  if (!safeDirectory(root) || !sameIdentity(owner.identity, root) || await owner.files.realpath(owner.root) !== owner.root) throw failure();
  const result: BigIntStats[] = [root];
  for (const parts of [["native"], ["native", "speech"], ["native", "speech", backend]]) {
    const path = join(owner.root, ...parts), stat = await owner.files.lstat(path);
    if (!safeDirectory(stat) || await owner.files.realpath(path) !== path) throw failure();
    result.push(stat);
  }
  return result;
}

/** Verify only the selected fixed artifact. This is detection, not a lease against later same-UID mutation. */
export async function verifySpeechResource(handle: PreparedSpeechResources, input: unknown): Promise<VerifiedSpeechResource> {
  const state = prepared.get(handle);
  if (!state) throw failure();
  let backend: ResourceBackend;
  try { backend = resourceBackendSchema.parse(input); } catch { throw failure(); }
  const entry = state.entries.get(backend);
  if (!entry) throw failure();
  const owner = state.owner;
  const result = owner.queue.then(async () => {
    if (owner.failedClosure) throw failure("TEARDOWN_FAILED");
    const beforeAncestors = await ancestors(owner, backend), path = join(owner.root, "native", "speech", backend, "openwhisper_speech.node");
    const before = await owner.files.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n ||
      before.size !== BigInt(entry.bytes) || await owner.files.realpath(path) !== path) throw failure();
    const file = await owner.files.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let hash: string;
    try {
      const opened = await file.stat({ bigint: true });
      if (!sameFile(before, opened)) throw failure();
      const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let count = 0;
      for (;;) {
        const read = await file.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        count += read.bytesRead;
        if (count > entry.bytes) throw failure();
        digest.update(buffer.subarray(0, read.bytesRead));
      }
      if (count !== entry.bytes || !sameFile(before, await file.stat({ bigint: true }))) throw failure();
      hash = digest.digest("hex");
      if (hash !== entry.sha256) throw failure();
    } finally {
      let closing: Promise<void>;
      try { closing = Promise.resolve(file.close()); }
      catch { closing = Promise.reject(failure("TEARDOWN_FAILED")); }
      try { await closing; }
      catch {
        owner.heldFile = file; owner.failedClosure = closing;
        // Retain the exact rejected close; another handle cannot retry an unconfirmed descriptor.
        throw failure("TEARDOWN_FAILED");
      }
    }
    if (!sameFile(before, await owner.files.lstat(path))) throw failure();
    const afterAncestors = await ancestors(owner, backend);
    if (afterAncestors.some((value, index) => !sameIdentity(value, beforeAncestors[index]!))) throw failure();
    return Object.freeze({ backend, path, bytes: entry.bytes, sha256: hash });
  }).catch((error: unknown) => { if (error instanceof SpeechWorkerError) throw error; throw failure(); });
  owner.queue = result.then(() => {}, () => {});
  return result;
}

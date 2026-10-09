import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { SpeechWorkerError } from "./speech-client.js";

export const SPEECH_ENTRY_FILES = Object.freeze(["package.json", "dist/workers/speech-entry.js", "dist/workers/speech/speech-bootstrap.js",
  "dist/workers/speech/speech-control.js", "dist/workers/speech/speech-protocol.js", "dist/workers/speech/native-speech.js", "dist/contracts/speech/speech.js"]);
const pathSchema = z.string().max(512).refine((path) => SPEECH_ENTRY_FILES.includes(path) ||
  /^node_modules\/zod\/(?:[A-Za-z0-9_-]+\/)*(?:[A-Za-z0-9_-]+\.(?:js|cjs|mjs)|package\.json)$/u.test(path));
export const speechEntryGraphSchema = z.strictObject({ version: z.literal(1), zodVersion: z.literal("4.6.5"),
  entries: z.array(z.strictObject({ path: pathSchema, bytes: z.number().int().positive().max(4 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).readonly()).min(9).max(512),
}).superRefine((value, context) => {
  const names = value.entries.map((entry) => entry.path);
  if (new Set(names).size !== names.length || SPEECH_ENTRY_FILES.some((name) => !names.includes(name)) ||
    !names.includes("node_modules/zod/package.json") || !names.includes("node_modules/zod/index.js") ||
    value.entries.reduce((sum, entry) => sum + entry.bytes, 0) > 32 * 1024 * 1024) {
    context.addIssue({ code: "custom", message: "A complete bounded fixed speech graph is required." });
  }
});
export type SpeechEntryGraphRecord = z.infer<typeof speechEntryGraphSchema>;
export interface SpeechEntryFiles {
  lstat(path: string): Promise<BigIntStats>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<readonly Pick<Dirent, "name" | "isFile" | "isDirectory" | "isSymbolicLink">[]>;
  open(path: string, flags: number): Promise<Pick<FileHandle, "stat" | "read" | "close">>;
}
const actual: SpeechEntryFiles = { lstat: (path) => lstat(path, { bigint: true }), realpath,
  readdir: (path) => readdir(path, { withFileTypes: true }), open };
const brand: unique symbol = Symbol("prepared-speech-entry-graph");
export interface PreparedSpeechEntryGraph { readonly [brand]: true }
interface Owner { readonly root: string; readonly identity: BigIntStats; readonly files: SpeechEntryFiles;
  queue: Promise<void>; pending: number; failed?: Promise<void>; held?: object[] }
const paths = new Map<string, Owner>(), physical = new Map<string, Owner>();
const failedBuildOwners = new Set<Owner>();
const prepared = new WeakMap<PreparedSpeechEntryGraph, { owner: Owner; record: SpeechEntryGraphRecord }>();
const fail = (code: "INTEGRITY_FAILED" | "TEARDOWN_FAILED" = "INTEGRITY_FAILED") => new SpeechWorkerError(code);
const key = (value: BigIntStats) => `${value.dev}:${value.ino}`;
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
const sameFile = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const safeDirectory = (value: BigIntStats) => value.isDirectory() && !value.isSymbolicLink() && (value.mode & 0o022n) === 0n;
function claim(owner: Owner): void {
  const current = physical.get(key(owner.identity));
  if (current && current !== owner && (current.pending || current.failed)) throw fail(current.failed ? "TEARDOWN_FAILED" : "INTEGRITY_FAILED");
  physical.set(key(owner.identity), owner);
}
async function inventory(root: string, files: SpeechEntryFiles): Promise<string[]> {
  const names = [...SPEECH_ENTRY_FILES]; let visited = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 8) throw fail();
    const path = join(root, relative), status = await files.lstat(path);
    if (!safeDirectory(status) || await files.realpath(path) !== path) throw fail();
    for (const entry of await files.readdir(path)) {
      if (++visited > 4096 || entry.isSymbolicLink() || !/^[A-Za-z0-9_.-]+$/u.test(entry.name) || entry.name === "." || entry.name === "..") throw fail();
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile() && (entry.name === "package.json" || /\.(?:js|cjs|mjs)$/u.test(entry.name))) {
        if (!pathSchema.safeParse(child).success || names.length >= 512) throw fail(); names.push(child);
      } else if (!entry.isFile()) throw fail();
    }
  };
  await walk("node_modules/zod", 0); return names.sort();
}
async function ancestry(owner: Owner, relative: string): Promise<BigIntStats[]> {
  const result: BigIntStats[] = [];
  const segments = relative.split("/"); segments.pop();
  for (let index = 0; index <= segments.length; index++) {
    const path = join(owner.root, ...segments.slice(0, index)), value = await owner.files.lstat(path);
    if (!safeDirectory(value) || await owner.files.realpath(path) !== path || (index === 0 && !same(value, owner.identity))) throw fail();
    // A nearer application package scope would change .js resolution semantics.
    if (index > 0 && !path.includes(`${join(owner.root, "node_modules")}/`)) {
      try { await owner.files.lstat(join(path, "package.json")); throw fail(); }
      catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    result.push(value);
  }
  return result;
}
async function read(owner: Owner, relative: string, expected?: { bytes: number; sha256: string }): Promise<{ bytes: number; sha256: string }> {
  const beforeAncestors = await ancestry(owner, relative), path = join(owner.root, relative), before = await owner.files.lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n ||
    before.size < 1n || before.size > 4n * 1024n * 1024n || await owner.files.realpath(path) !== path ||
    (expected && before.size !== BigInt(expected.bytes))) throw fail();
  const file = await owner.files.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: { bytes: number; sha256: string } | undefined;
  try {
    if (!sameFile(before, await file.stat({ bigint: true }))) throw fail();
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let count = 0;
    for (;;) {
      const result = await file.read(buffer, 0, buffer.length, null);
      if (!Number.isInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length) throw fail();
      if (!result.bytesRead) break; count += result.bytesRead;
      if (count > Number(before.size)) throw fail(); hash.update(buffer.subarray(0, result.bytesRead));
    }
    const sha256 = hash.digest("hex");
    if (count !== Number(before.size) || (expected && sha256 !== expected.sha256) || !sameFile(before, await file.stat({ bigint: true })) ||
      !sameFile(before, await owner.files.lstat(path))) throw fail();
    const after = await ancestry(owner, relative);
    if (after.some((value, index) => !beforeAncestors[index] || !same(value, beforeAncestors[index]))) throw fail();
    value = { bytes: count, sha256 };
  } finally {
    const closing = Promise.resolve().then(() => file.close());
    try { await closing; } catch { owner.failed = closing; (owner.held ??= []).push(file); throw fail("TEARDOWN_FAILED"); }
  }
  if (!value || !sameFile(before, await owner.files.lstat(path))) throw fail();
  const afterClose = await ancestry(owner, relative);
  if (afterClose.some((item, index) => !beforeAncestors[index] || !same(item, beforeAncestors[index]))) throw fail();
  return value;
}
/** Build phase ONLY. This captures bytes for subsequent independent review; it
 * must never replace expected input with runtime self-hashing during admission. */
export async function captureSpeechEntryGraph(root: string): Promise<SpeechEntryGraphRecord> {
  const identity = await actual.lstat(root);
  if (!isAbsolute(root) || root !== resolve(root) || !safeDirectory(identity) || await actual.realpath(root) !== root) throw fail();
  const owner: Owner = { root, identity, files: actual, queue: Promise.resolve(), pending: 0 };
  try {
    const entries = [];
    for (const path of await inventory(root, actual)) entries.push({ path, ...await read(owner, path) });
    return speechEntryGraphSchema.parse({ version: 1, zodVersion: "4.6.5", entries });
  } catch (error: unknown) { if (owner.failed) failedBuildOwners.add(owner); throw error; }
}
/** Fixed host build input, never a renderer-supplied graph or authenticity claim. */
export async function prepareSpeechEntryGraph(root: string, input: unknown, files: SpeechEntryFiles = actual): Promise<PreparedSpeechEntryGraph> {
  try {
    const record = speechEntryGraphSchema.parse(input);
    if (!isAbsolute(root) || root !== resolve(root) || root.includes("\0")) throw fail();
    if (paths.get(root)?.failed) throw fail("TEARDOWN_FAILED");
    if ([...failedBuildOwners].some((owner) => owner.root === root)) throw fail("TEARDOWN_FAILED");
    const identity = await files.lstat(root);
    if (!safeDirectory(identity) || await files.realpath(root) !== root) throw fail();
    const previous = paths.get(root), other = physical.get(key(identity));
    if (other && other !== previous && (other.pending || other.failed)) throw fail(other.failed ? "TEARDOWN_FAILED" : "INTEGRITY_FAILED");
    if (previous && (previous.files !== files || !same(previous.identity, identity))) throw fail();
    const owner = previous ?? { root, identity, files, queue: Promise.resolve(), pending: 0 };
    if (owner.failed) throw fail("TEARDOWN_FAILED"); claim(owner); paths.set(root, owner);
    const token = Object.freeze({ [brand]: true as const }); prepared.set(token, { owner, record }); return token;
  } catch (error: unknown) { throw error instanceof SpeechWorkerError ? error : fail(); }
}
export async function verifySpeechEntryGraph(token: PreparedSpeechEntryGraph): Promise<Readonly<{ entry: string }>> {
  const state = prepared.get(token); if (!state) throw fail(); const { owner, record } = state;
  if (owner.failed) throw fail("TEARDOWN_FAILED"); claim(owner); owner.pending++;
  const operation = owner.queue.then(async () => {
    if (owner.failed) throw fail("TEARDOWN_FAILED");
    const directory = await owner.files.open(owner.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!same(owner.identity, await directory.stat({ bigint: true }))) throw fail();
      const names = await inventory(owner.root, owner.files);
      if (JSON.stringify(names) !== JSON.stringify(record.entries.map((value) => value.path).sort())) throw fail();
      const before = new Map<string, BigIntStats>();
      for (const name of names) before.set(name, await owner.files.lstat(join(owner.root, name)));
      for (const entry of record.entries) await read(owner, entry.path, entry);
      for (const name of names) {
        const first = before.get(name);
        if (!first || !sameFile(first, await owner.files.lstat(join(owner.root, name)))) throw fail();
      }
      if (!same(owner.identity, await owner.files.lstat(owner.root)) ||
        JSON.stringify(await inventory(owner.root, owner.files)) !== JSON.stringify(names)) throw fail();
      return Object.freeze({ entry: join(owner.root, "dist/workers/speech-entry.js") });
    } finally {
      if (owner.failed) (owner.held ??= []).push(directory);
      else {
        const closing = Promise.resolve().then(() => directory.close());
        try { await closing; } catch { owner.failed = closing; (owner.held ??= []).push(directory); throw fail("TEARDOWN_FAILED"); }
      }
    }
  }).catch((error: unknown) => { throw error instanceof SpeechWorkerError ? error : fail(); }).finally(() => { owner.pending--; });
  owner.queue = operation.then(() => {}, () => {}); return operation;
}

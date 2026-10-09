import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileInventorySchema, type BuildManifest } from "./contract.js";

export type RawFiles = Readonly<Pick<typeof import("node:fs/promises"), "lstat" | "open">>;
export const ordinaryFiles: RawFiles = { lstat, open };
export async function describe(path: string, limit = 512 * 1024 * 1024, io: RawFiles = ordinaryFiles) {
  const before = await io.lstat(path, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(limit));
  const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const same = (value: typeof before) => value.dev === before.dev && value.ino === before.ino && value.uid === before.uid && value.mode === before.mode &&
    value.nlink === before.nlink && value.size === before.size && value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
  let count = 0; const hash = createHash("sha256");
  try {
    assert.ok(same(await file.stat({ bigint: true }))); const buffer = Buffer.alloc(64 * 1024);
    for (;;) { const read = await file.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; count += read.bytesRead; assert.ok(count <= Number(before.size)); hash.update(buffer.subarray(0, read.bytesRead)); }
    assert.ok(same(await file.stat({ bigint: true })));
  } finally { await file.close(); }
  assert.ok(same(await io.lstat(path, { bigint: true }))); assert.equal(count, Number(before.size)); return { bytes: count, sha256: hash.digest("hex") };
}
export async function boundedJson(path: string, limit = 256 * 1024): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const status = await file.stat({ bigint: true }); assert.ok(status.isFile() && status.nlink === 1n && status.size <= BigInt(limit));
    const buffer = Buffer.alloc(limit + 1); let used = 0;
    while (used < buffer.length) { const read = await file.read(buffer, used, buffer.length - used, null); if (!read.bytesRead) break; used += read.bytesRead; }
    const after = await file.stat({ bigint: true });
    assert.equal(used, Number(status.size)); assert.ok(used <= limit && status.ino === after.ino && status.mtimeNs === after.mtimeNs && status.ctimeNs === after.ctimeNs);
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used))); return result;
  } finally { await file.close(); }
}
export async function inventory(root: string) {
  assert.equal(await realpath(root), root); const records: Record<string, Awaited<ReturnType<typeof describe>>> = {}; let visited = 0;
  const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
    assert.ok(depth <= 12); const status = await lstat(path); assert.ok(status.isDirectory() && !status.isSymbolicLink());
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      assert.ok(++visited <= 4096 && !entry.isSymbolicLink()); const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name, depth + 1);
      else { assert.ok(entry.isFile()); records[name] = await describe(join(path, entry.name)); }
    }
  };
  await walk(root, "", 0); return fileInventorySchema.parse(records);
}
export async function verifyPayload(root: string, manifest: BuildManifest): Promise<void> {
  for (const [name, expected] of Object.entries(manifest.payloadFiles)) assert.deepEqual(await describe(join(root, name)), expected);
}

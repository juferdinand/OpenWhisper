import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseModelCatalog, type Catalog } from "../src/core/model-catalog.js";
import { developmentProfileSchema, prepareDevelopmentProfile, resolveDevelopmentProfile, type DevelopmentProfile } from "../src/services/profiles.js";
import { MAX_INVENTORY_MODELS, MAX_MODEL_BYTES, MODEL_COPY_BYTES, ModelInventory, ModelInventoryError, type ModelInventoryFailure, type ModelInventoryIO } from "../src/services/model-inventory.js";

const catalog = parseModelCatalog(JSON.parse(await readFile(new URL("../../shared/models.json", import.meta.url), "utf8")));
const fail = (code: ModelInventoryFailure) => (error: unknown): boolean =>
  error instanceof ModelInventoryError && error.code === code && error.message === code;
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function deferred() {
  let resolve: () => void = () => { throw new Error("Deferred not initialized."); };
  const promise = new Promise<void>((accept) => { resolve = accept; }); return { promise, resolve };
}
interface Fixture { readonly root: string; readonly profile: DevelopmentProfile; readonly directory: string;
  readonly selected: string; open(effects?: Partial<ModelInventoryIO>): Promise<ModelInventory> }
async function fixture(run: (context: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-model-inventory-")));
  const home = join(root, "home"), selected = join(root, "selected");
  await mkdir(home, { mode: 0o700 }); await mkdir(selected, { mode: 0o700 });
  const profile = resolveDevelopmentProfile({ home }); prepareDevelopmentProfile(profile);
  const context = { root, profile, selected, directory: profile.paths.models,
    open: (effects?: Partial<ModelInventoryIO>) => ModelInventory.open(profile, catalog, effects) };
  try { await run(context); } finally { await rm(root, { recursive: true, force: true }); }
}
async function source(root: string, name = "custom.bin", bytes: Buffer = Buffer.from("complete fixture model bytes")): Promise<string> {
  const path = join(root, name); await writeFile(path, bytes, { mode: 0o644 }); return path;
}
async function installed(root: string, name = "custom.bin", bytes: Buffer = Buffer.from("original private model")): Promise<string> {
  const path = join(root, name); await writeFile(path, bytes, { mode: 0o600 }); return path;
}
const noParts = async (directory: string): Promise<void> => { assert.equal((await readdir(directory)).some((name) => name.endsWith(".model.part")), false); };

test("model inventory requires genuine profile provenance and a unique safe catalog before effects", async () => fixture(async (ctx) => {
  const forged = developmentProfileSchema.parse(ctx.profile);
  await assert.rejects(ModelInventory.open(forged, catalog), fail("INVALID_PROFILE"));
  const first = catalog.models[0]; assert.ok(first);
  const duplicate = { ...catalog, models: catalog.models.map((item, index) => index === 1 ? { ...item, file: first.file } : item) };
  await assert.rejects(ModelInventory.open(ctx.profile, duplicate), fail("INVALID_CATALOG"));
  await assert.rejects(ModelInventory.open(ctx.profile, { ...catalog, unexpected: true }), fail("INVALID_CATALOG"));
  await assert.rejects(ModelInventory.open(ctx.profile, { ...catalog, models: [{ ...first, file: "../outside.bin" }] }), fail("INVALID_CATALOG"));
  assert.deepEqual(await readdir(ctx.directory), []);
}));

test("inventory enumerates exact catalog/custom names without aliasing unsafe files or claiming weight validity", { timeout: 5000 }, async () => fixture(async (ctx) => {
  await installed(ctx.directory, "ggml-tiny.bin");
  await installed(ctx.directory, "日本語 👩‍💻..custom.bin");
  await installed(ctx.directory, "My PARAKEET..model.bin");
  await installed(ctx.directory, "upper.BIN"); await installed(ctx.directory, "unfinished.bin.part");
  await installed(ctx.directory, "tiny.bin");
  const sentinel = await source(ctx.selected, "outside.bin");
  await symlink(sentinel, join(ctx.directory, "alias.bin"));
  const hard = await installed(ctx.directory, "hard.bin"); await link(hard, join(ctx.directory, "hard-two.bin"));
  const publicFile = await installed(ctx.directory, "public.bin"); await chmod(publicFile, 0o644);
  await promisify(execFile)("mkfifo", ["-m", "600", join(ctx.directory, "blocking.bin")]);
  const service = await ctx.open(), values = await service.installed();
  assert.deepEqual(values.map((item) => item.model.id), ["My PARAKEET..model", "tiny", "日本語 👩‍💻..custom"]);
  assert.equal(values.find((item) => item.model.id.startsWith("My"))?.model.family, "parakeet");
  assert.ok(values.every((item) => item.verification === "private-file"));
  assert.equal((await readFile(sentinel)).toString(), "complete fixture model bytes");
  assert.equal((await lstat(publicFile)).mode & 0o7777, 0o644);
}));

test("complete import uses bounded partial reads, exact bytes/hash and private atomic publication", async () => fixture(async (ctx) => {
  const bytes = Buffer.alloc(MODEL_COPY_BYTES * 3 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const input = await source(ctx.selected, "日本語 👩‍💻..weights.gguf", bytes); let maximumRead = 0, writes = 0;
  const service = await ctx.open({ async read(file, buffer, position) {
    maximumRead = Math.max(maximumRead, buffer.length);
    return (await file.read(buffer, 0, Math.min(7777, buffer.length), position)).bytesRead;
  }, async write(file, chunk) { writes++; await file.writeFile(chunk); } });
  const result = await service.import(input);
  assert.equal(result.model.id, "日本語 👩‍💻..weights"); assert.equal(result.model.file, "日本語 👩‍💻..weights.bin");
  assert.equal(result.copiedSha256, hash(bytes)); assert.equal(result.bytes, bytes.length);
  assert.equal(maximumRead, MODEL_COPY_BYTES); assert.ok(writes > 3);
  const target = join(ctx.directory, result.model.file);
  assert.deepEqual(await readFile(target), bytes); assert.deepEqual(await readFile(input), bytes);
  assert.equal((await lstat(input)).mode & 0o7777, 0o644);
  const stats = await lstat(target); assert.equal(stats.mode & 0o7777, 0o600); assert.equal(stats.nlink, 1); assert.equal(stats.uid, process.getuid?.());
  await noParts(ctx.directory);
  const reopened = await ctx.open(); assert.equal((await reopened.installed())[0]?.verification, "private-file");
  assert.equal("copiedSha256" in ((await reopened.installed())[0] ?? {}), false);
}));

test("Mac last-extension import policy maps exact catalog filenames and refuses custom catalog-ID collisions", async () => fixture(async (ctx) => {
  const service = await ctx.open();
  for (const [inputName, id, file] of [["ggml-tiny.gguf", "tiny", "ggml-tiny.bin"], ["my.parakeet.DATA", "my.parakeet", "my.parakeet.bin"],
    ["noextension", "noextension", "noextension.bin"], ["my..model.bin", "my..model", "my..model.bin"]]) {
    assert.ok(inputName && id && file);
    const imported = await service.import(await source(ctx.selected, inputName));
    assert.equal(imported.model.id, id); assert.equal(imported.model.file, file);
  }
  await assert.rejects(service.import(await source(ctx.selected, "tiny.gguf")), fail("INVALID_ID"));
  assert.equal((await service.installed()).find((item) => item.model.id === "tiny")?.model.file, "ggml-tiny.bin");
}));

test("malformed IDs/options and source symlinks or FIFOs fail without outside-file effects", { timeout: 5000 }, async () => fixture(async (ctx) => {
  const service = await ctx.open(), sentinel = await source(ctx.selected, "sentinel.bin");
  for (const id of [".", "..", "../outside", sentinel, "zero\0byte", { id: "tiny" }]) {
    await assert.rejects(service.acquire(id, { gpu: false }), fail("INVALID_ID"));
    await assert.rejects(service.remove(id), fail("INVALID_ID"));
  }
  await assert.rejects(service.import("relative"), fail("INVALID_SOURCE"));
  await assert.rejects(service.import(sentinel, { arbitrary: true }), fail("INVALID_SOURCE"));
  const alias = join(ctx.selected, "alias.bin"); await symlink(sentinel, alias);
  await assert.rejects(service.import(alias), fail("INVALID_SOURCE"));
  const fifo = join(ctx.selected, "fifo.bin"); await promisify(execFile)("mkfifo", ["-m", "600", fifo]);
  await assert.rejects(service.import(fifo), fail("INVALID_SOURCE"));
  assert.equal((await readFile(sentinel)).toString(), "complete fixture model bytes");
  assert.deepEqual(await readdir(ctx.directory), []);
}));

test("leases capture immutable user GPU choice and gate all cooperating instances on confirmed reap", async () => fixture(async (ctx) => {
  const target = await installed(ctx.directory), input = await source(ctx.selected);
  const service = await ctx.open(), reopened = await ctx.open(); const choice = { gpu: false };
  const lease = await service.acquire("custom", choice); choice.gpu = true;
  assert.equal(lease.model.gpu, false); assert.ok(Object.isFrozen(lease.model)); await lease.validate();
  const other = await reopened.acquire("custom", { gpu: true }); assert.equal(other.model.gpu, true);
  await assert.rejects(reopened.remove("custom"), fail("LEASED"));
  await assert.rejects(service.import(input, { replace: true }), fail("LEASED"));
  await assert.rejects(lease.release(Promise.reject(new Error("Unconfirmed private worker detail"))), fail("RELEASE_FAILED"));
  await assert.rejects(service.remove("custom"), fail("LEASED"));
  const reaped = deferred(), released = lease.release(reaped.promise);
  await assert.rejects(reopened.remove("custom"), fail("LEASED")); reaped.resolve(); await released;
  await assert.rejects(service.remove("custom"), fail("LEASED"));
  await other.release(Promise.resolve()); await lease.release(Promise.resolve());
  await reopened.remove("custom"); await assert.rejects(lstat(target));
}));

test("lease validation detects replacement and same-length edits while retaining the held owner", async () => fixture(async (ctx) => {
  const path = await installed(ctx.directory, "custom.bin", Buffer.from("original"));
  const service = await ctx.open(), lease = await service.acquire("custom", { gpu: false });
  await writeFile(path, "modified"); await assert.rejects(lease.validate(), fail("MODEL_CHANGED"));
  await assert.rejects(service.remove("custom"), fail("LEASED"));
  await lease.release(Promise.resolve());
  const next = await service.acquire("custom", { gpu: false });
  await unlink(path); await installed(ctx.directory, "custom.bin", Buffer.from("another!"));
  await assert.rejects(next.validate(), fail("MODEL_CHANGED")); await next.release(Promise.resolve());
}));

test("acquisition during stalled replacement prevents commit without blocking the original model lease", async () => fixture(async (ctx) => {
  const target = await installed(ctx.directory), before = await readFile(target);
  const input = await source(ctx.selected, "custom.bin", Buffer.alloc(MODEL_COPY_BYTES + 1, 9));
  const began = deferred(), proceed = deferred(); let first = true;
  const service = await ctx.open({ async read(file, bytes, position) {
    const result = await file.read(bytes, 0, bytes.length, position);
    if (first) { first = false; began.resolve(); await proceed.promise; } return result.bytesRead;
  } });
  const importing = service.import(input, { replace: true }); const rejected = assert.rejects(importing, fail("LEASED"));
  await began.promise;
  const lease = await service.acquire("custom", { gpu: false });
  await assert.rejects(service.import(input, { replace: true }), fail("BUSY"));
  proceed.resolve(); await rejected; assert.deepEqual(await readFile(target), before);
  await noParts(ctx.directory); await lease.release(Promise.resolve());
}));

test("source content, size or pathname mutation rejects complete copy and preserves original target", async () => {
  for (const phase of ["overwrite", "append", "replace"] as const) await fixture(async (ctx) => {
    const target = await installed(ctx.directory), before = await readFile(target);
    const original = Buffer.alloc(MODEL_COPY_BYTES * 2 + 1, 42), input = await source(ctx.selected, "custom.bin", original);
    let first = true;
    const service = await ctx.open({ async read(file, bytes, position) {
      const result = await file.read(bytes, 0, bytes.length, position);
      if (first) { first = false;
        if (phase === "replace") await unlink(input);
        await writeFile(input, phase === "append" ? Buffer.concat([original, Buffer.from([1])]) : Buffer.alloc(original.length, 43));
      } return result.bytesRead;
    } });
    await assert.rejects(service.import(input, { replace: true }), fail("SOURCE_CHANGED"));
    assert.deepEqual(await readFile(target), before); await noParts(ctx.directory);
  });
});

test("cancel before publication preserves exact old bytes and removes only its owned part", async () => fixture(async (ctx) => {
  const target = await installed(ctx.directory), before = await readFile(target);
  const input = await source(ctx.selected, "custom.bin", Buffer.alloc(MODEL_COPY_BYTES + 100, 7));
  const controller = new AbortController();
  const service = await ctx.open({ async read(file, buffer, position) {
    const result = await file.read(buffer, 0, buffer.length, position); controller.abort(); return result.bytesRead;
  } });
  await assert.rejects(service.import(input, { replace: true, signal: controller.signal }), fail("CANCELLED"));
  assert.deepEqual(await readFile(target), before); await noParts(ctx.directory);
  await assert.rejects(service.import(input, { signal: controller.signal }), fail("CANCELLED"));
}));

test("prepublication write, file-sync or replace failures keep the old destination and safe error codes", async () => {
  for (const phase of ["write", "sync", "rename"] as const) await fixture(async (ctx) => {
    const target = await installed(ctx.directory), before = await readFile(target), input = await source(ctx.selected);
    const detail = () => { throw new Error("Private source/weights/path detail must not escape"); };
    const service = await ctx.open(phase === "write" ? { write: detail } : phase === "sync" ? { syncFile: detail } : { rename: detail });
    await assert.rejects(service.import(input, { replace: true }), fail("STORAGE_FAILED"));
    assert.deepEqual(await readFile(target), before); await noParts(ctx.directory);
  });
});

test("source and part close failures still clear the import owner and preserve the old destination", async () => {
  for (const phase of ["source", "part"] as const) await fixture(async (ctx) => {
    const target = await installed(ctx.directory), before = await readFile(target), input = await source(ctx.selected);
    let inject = true, closeAttempts = 0;
    const service = await ctx.open({ async read(file, buffer, position) {
      if (phase === "source" && inject) {
        inject = false; const close = file.close.bind(file);
        file.close = async () => { closeAttempts++; await close(); throw new Error("Private source close detail"); };
      }
      return (await file.read(buffer, 0, buffer.length, position)).bytesRead;
    }, async syncFile(file) {
      await file.sync();
      if (phase === "part" && inject) {
        inject = false; const close = file.close.bind(file);
        file.close = async () => { closeAttempts++; await close(); throw new Error("Private part close detail"); };
      }
    } });
    await assert.rejects(service.import(input, { replace: true }), fail("STORAGE_FAILED"));
    assert.deepEqual(await readFile(target), before); await noParts(ctx.directory); assert.ok(closeAttempts >= 2);
    const retry = await service.import(input, { replace: true });
    assert.equal(retry.copiedSha256, hash(await readFile(input))); await noParts(ctx.directory);
  });
});

test("empty and oversized sparse sources reject before copying or changing any target", async () => fixture(async (ctx) => {
  const target = await installed(ctx.directory), before = await readFile(target); let reads = 0;
  const service = await ctx.open({ async read() { reads++; throw new Error("Source bound must precede copying"); } });
  for (const size of [0, MAX_MODEL_BYTES + 1]) {
    const input = await source(ctx.selected); await truncate(input, size);
    await assert.rejects(service.import(input, { replace: true }), fail("INVALID_SOURCE"));
    assert.deepEqual(await readFile(target), before); await noParts(ctx.directory);
  }
  assert.equal(reads, 0);
}));

test("atomic no-replace never overwrites a destination appearing during publication", async () => fixture(async (ctx) => {
  const input = await source(ctx.selected), competitor = Buffer.from("later owner preserved");
  const service = await ctx.open({ async link(from, to) { await writeFile(to, competitor, { mode: 0o600 }); await link(from, to); } });
  await assert.rejects(service.import(input), fail("EXISTS"));
  assert.deepEqual(await readFile(join(ctx.directory, "custom.bin")), competitor); await noParts(ctx.directory);
}));

test("postpublication directory-sync uncertainty retains bytes and retries durability without copying again", async () => fixture(async (ctx) => {
  const input = await source(ctx.selected); let failing = true, writes = 0;
  const service = await ctx.open({ async write(file, bytes) { writes++; await file.writeFile(bytes); }, async syncDirectory(file) {
    if (failing) throw new Error("Synthetic sync failure"); await file.sync();
  } });
  await assert.rejects(service.import(input), fail("COMMITTED_UNCERTAIN"));
  const path = join(ctx.directory, "custom.bin"), bytes = await readFile(path), before = await lstat(path);
  assert.equal((await service.installed()).length, 0);
  const reopened = await ctx.open(); await assert.rejects(reopened.acquire("custom", { gpu: false }), fail("COMMITTED_UNCERTAIN"));
  await unlink(input); failing = false;
  const recovered = await service.ensureCommitted("custom"); assert.ok(recovered);
  assert.equal(recovered.copiedSha256, hash(bytes)); assert.equal(writes, 1);
  assert.equal((await lstat(path)).ino, before.ino); assert.deepEqual(await readFile(path), bytes);
  assert.equal((await reopened.installed()).length, 1); await noParts(ctx.directory);
}));

test("postpublication directory close failure retains the exact publication until durability retry", async () => fixture(async (ctx) => {
  const input = await source(ctx.selected); let inject = true;
  const service = await ctx.open({ async syncDirectory(file) {
    await file.sync();
    if (inject) { inject = false; const close = file.close.bind(file);
      file.close = async () => { await close(); throw new Error("Private directory close detail"); };
    }
  } });
  await assert.rejects(service.import(input), fail("COMMITTED_UNCERTAIN"));
  assert.equal((await service.installed()).length, 0);
  await assert.rejects(service.acquire("custom", { gpu: false }), fail("COMMITTED_UNCERTAIN"));
  const path = join(ctx.directory, "custom.bin"), inode = (await lstat(path)).ino;
  const committed = await service.ensureCommitted("custom"); assert.ok(committed);
  assert.equal((await lstat(path)).ino, inode); assert.equal(committed.copiedSha256, hash(await readFile(input)));
  assert.equal((await service.installed()).length, 1); await noParts(ctx.directory);
}));

test("publication or temporary-unlink reply loss retains only the exact new owner for cleanup", async () => {
  for (const phase of ["link", "rename", "unlink"] as const) await fixture(async (ctx) => {
    const input = await source(ctx.selected); if (phase === "rename") await installed(ctx.directory);
    let failing = true;
    const service = await ctx.open({ async link(from, to) { await link(from, to); if (phase === "link" && failing) throw new Error("Synthetic postlink loss"); },
      async rename(from, to) { await rename(from, to); if (phase === "rename" && failing) throw new Error("Synthetic postrename loss"); },
      async unlink(path) { if (phase === "unlink" && failing) throw new Error("Synthetic part unlink failure"); await unlink(path); } });
    await assert.rejects(service.import(input, { replace: phase === "rename" }), fail("COMMITTED_UNCERTAIN"));
    const path = join(ctx.directory, "custom.bin"), before = await lstat(path), bytes = await readFile(path);
    assert.equal((await service.installed()).length, 0); failing = false;
    const completed = await service.ensureCommitted("custom"); assert.ok(completed);
    assert.equal(completed.copiedSha256, hash(bytes)); assert.equal((await lstat(path)).ino, before.ino);
    assert.equal((await lstat(path)).nlink, 1); await noParts(ctx.directory);
  });
});

test("late cancel cannot pretend to roll back already published complete model bytes", async () => fixture(async (ctx) => {
  const input = await source(ctx.selected), controller = new AbortController();
  const service = await ctx.open({ async link(from, to) { await link(from, to); controller.abort(); } });
  const result = await service.import(input, { signal: controller.signal });
  assert.equal(controller.signal.aborted, true); assert.equal(result.copiedSha256, hash(await readFile(input)));
  assert.equal((await service.installed()).length, 1); await noParts(ctx.directory);
}));

test("pending cleanup never removes a replacement path owned by a later writer", async () => fixture(async (ctx) => {
  const input = await source(ctx.selected); let failed = true;
  const service = await ctx.open({ async syncDirectory(file) { if (failed) throw new Error("Synthetic sync failure"); await file.sync(); } });
  await assert.rejects(service.import(input), fail("COMMITTED_UNCERTAIN"));
  const path = join(ctx.directory, "custom.bin"); await unlink(path); await installed(ctx.directory, "custom.bin", Buffer.from("new unrelated owner"));
  failed = false; await assert.rejects(service.ensureCommitted("custom"), fail("COMMITTED_UNCERTAIN"));
  assert.equal(await readFile(path, "utf8"), "new unrelated owner");
}));

test("directory replacement or unsafe permissions invalidate the store without repairing other paths", async () => fixture(async (ctx) => {
  const service = await ctx.open(); await installed(ctx.directory);
  await chmod(ctx.directory, 0o755); await assert.rejects(service.installed(), fail("UNSAFE_DIRECTORY"));
  assert.equal((await lstat(ctx.directory)).mode & 0o7777, 0o755); await chmod(ctx.directory, 0o700);
  const lease = await service.acquire("custom", { gpu: false });
  await rename(ctx.directory, join(ctx.root, "displaced")); await mkdir(ctx.directory, { mode: 0o700 });
  await assert.rejects(service.installed(), fail("UNSAFE_DIRECTORY"));
  await assert.rejects(ctx.open(), fail("UNSAFE_DIRECTORY"));
  await lease.release(Promise.resolve()); assert.deepEqual(await readdir(ctx.directory), []);
  assert.equal((await readdir(join(ctx.root, "displaced"))).length, 1);
}));

test("inventory limits reject overflow explicitly without dropping or truncating installed files", async () => fixture(async (ctx) => {
  await Promise.all(Array.from({ length: 120 }, (_, i) => installed(ctx.directory, `custom-${i}.bin`, Buffer.from([i]))));
  const service = await ctx.open(); await assert.rejects(service.installed(), fail("CAPACITY"));
  assert.equal((await readdir(ctx.directory)).length, 120);
  assert.deepEqual(await readFile(join(ctx.directory, "custom-119.bin")), Buffer.from([119]));
}));

test("uncertain publications reserve capacity until durability finishes without accepting an extra model", async () => fixture(async (ctx) => {
  const initial = MAX_INVENTORY_MODELS - catalog.models.length - 1;
  await Promise.all(Array.from({ length: initial }, (_, i) => installed(ctx.directory, `custom-${i}.bin`, Buffer.from([i]))));
  let failing = true;
  const service = await ctx.open({ async syncDirectory(file) { if (failing) throw new Error("Synthetic reserved-slot uncertainty"); await file.sync(); } });
  await assert.rejects(service.import(await source(ctx.selected, "reserved.bin")), fail("COMMITTED_UNCERTAIN"));
  assert.equal((await service.installed()).length, initial);
  await assert.rejects(service.import(await source(ctx.selected, "extra.bin")), fail("CAPACITY"));
  failing = false; await service.ensureCommitted("reserved");
  assert.equal((await service.installed()).length, initial + 1);
  await assert.rejects(lstat(join(ctx.directory, "extra.bin"))); await noParts(ctx.directory);
}));

test("delete durability retry does not delete a new file appearing after its owned unlink", async () => fixture(async (ctx) => {
  const path = await installed(ctx.directory); let failing = true;
  const service = await ctx.open({ async syncDirectory(file) { if (failing) throw new Error("Synthetic delete sync failure"); await file.sync(); } });
  await assert.rejects(service.remove("custom"), fail("COMMITTED_UNCERTAIN"));
  await assert.rejects(lstat(path)); await installed(ctx.directory, "custom.bin", Buffer.from("later file")); failing = false;
  await assert.rejects(service.ensureCommitted("custom"), fail("COMMITTED_UNCERTAIN"));
  assert.equal(await readFile(path, "utf8"), "later file");
}));

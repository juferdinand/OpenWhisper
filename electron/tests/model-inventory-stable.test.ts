import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelInventory, ModelInventoryError, type ModelInventoryIO } from "../src/services/model-inventory.js";
import { ModelDownloads, ModelDownloadError } from "../src/services/model-download.js";
import { prepareStableProfile, resolveStableProfile, stableProfileSchema, type StableProfile } from "../src/services/stable-profile.js";
import { bytes, catalog, FakeTransport, scripts } from "./model-download-fixtures.js";

async function fixture(platform: "linux" | "darwin", run: (context: { profile: StableProfile; root: string;
  open(effects?: Partial<ModelInventoryIO>): Promise<ModelInventory> }) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-stable-models-"))), home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const profile = resolveStableProfile({ home, platform }); prepareStableProfile(profile); await chmod(profile.paths.models, 0o755);
  try { await run({ profile, root, open: (effects) => ModelInventory.open(profile, catalog, effects) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const inventoryFailure = (code: string) => (error: unknown): boolean => error instanceof ModelInventoryError && error.code === code;
const downloadFailure = (code: string) => (error: unknown): boolean => error instanceof ModelDownloadError && error.code === code;

for (const platform of ["linux", "darwin"] as const) test(`${platform} stable inventory leases legacy models in place without changing bytes, modes or identity`, async () => fixture(platform, async (ctx) => {
  const path = join(ctx.profile.paths.models, "ggml-tiny.bin"), original = Buffer.from("inert legacy weights");
  await writeFile(path, original, { mode: 0o644 }); const before = await lstat(path, { bigint: true });
  const inventory = await ctx.open(), values = await inventory.installed();
  assert.equal(values.length, 1); assert.equal(values[0]?.model.id, "tiny"); assert.equal(values[0]?.verification, "legacy-owned-file");
  assert.equal((await lstat(ctx.profile.paths.models)).mode & 0o7777, 0o755);
  const lease = await inventory.acquire("tiny", { gpu: false }); assert.equal(lease.model.path, path); await lease.validate();
  assert.equal(inventory.belongsToProfile(ctx.profile), true);
  const other = await ctx.open(); await assert.rejects(other.remove("tiny"), inventoryFailure("LEASED"));
  const source = join(ctx.root, "ggml-tiny.bin"); await writeFile(source, "new inert weights", { mode: 0o644 });
  await assert.rejects(other.import(source, { replace: true }), inventoryFailure("LEASED"));
  await lease.release(Promise.resolve());
  assert.deepEqual(await lstat(path, { bigint: true }), before); assert.deepEqual(await readFile(path), original);
  assert.deepEqual(await readdir(ctx.profile.paths.models), ["ggml-tiny.bin"]);
}));

test("stable legacy acceptance retains symlink, hardlink, writable-file and unsafe-directory refusals", async () => fixture("linux", async (ctx) => {
  const normal = join(ctx.profile.paths.models, "good.bin"); await writeFile(normal, "owned weights", { mode: 0o644 });
  for (const [name, mode] of [["group-write.bin", 0o664], ["other-write.bin", 0o646], ["setuid.bin", 0o4644]] as const) {
    const path = join(ctx.profile.paths.models, name); await writeFile(path, "unsafe owned fixture", { mode: 0o600 }); await chmod(path, mode);
  }
  await symlink(normal, join(ctx.profile.paths.models, "alias.bin"));
  const hard = join(ctx.profile.paths.models, "hard.bin"); await writeFile(hard, "hardlinked weights", { mode: 0o644 }); await link(hard, join(ctx.profile.paths.models, "hard-two.bin"));
  await mkdir(join(ctx.profile.paths.models, "directory.bin"), { mode: 0o700 });
  const service = await ctx.open(); assert.deepEqual((await service.installed()).map((value) => value.model.id), ["good"]);
  for (const id of ["group-write", "other-write", "setuid", "alias", "hard", "hard-two", "directory"]) {
    await assert.rejects(service.acquire(id, { gpu: false }), inventoryFailure("UNSAFE_FILE"));
  }
  await chmod(ctx.profile.paths.models, 0o775); await assert.rejects(service.installed(), inventoryFailure("UNSAFE_DIRECTORY"));
  assert.equal((await lstat(ctx.profile.paths.models)).mode & 0o7777, 0o775); assert.equal((await lstat(normal)).mode & 0o7777, 0o644);
}));

test("stable model leases detect permission and byte changes even when the new legacy mode remains safe", async () => fixture("darwin", async (ctx) => {
  const path = join(ctx.profile.paths.models, "custom.bin"); await writeFile(path, "initial weights", { mode: 0o644 });
  const service = await ctx.open(), lease = await service.acquire("custom", { gpu: false });
  await chmod(path, 0o600); await assert.rejects(lease.validate(), inventoryFailure("MODEL_CHANGED"));
  await lease.release(Promise.resolve());
  const next = await service.acquire("custom", { gpu: false }); await writeFile(path, "different weights");
  await assert.rejects(next.validate(), inventoryFailure("MODEL_CHANGED")); await next.release(Promise.resolve());
}));

test("stable imports create private models while leaving unrelated legacy models and directories unchanged", async () => fixture("darwin", async (ctx) => {
  const old = join(ctx.profile.paths.models, "old.bin"); await writeFile(old, "old weights", { mode: 0o644 }); const before = await lstat(old, { bigint: true });
  const source = join(ctx.root, "new.bin"); await writeFile(source, "new imported weights", { mode: 0o644 });
  const service = await ctx.open(), imported = await service.import(source);
  assert.equal(imported.verification, "private-file"); assert.equal((await lstat(join(ctx.profile.paths.models, "new.bin"))).mode & 0o7777, 0o600);
  assert.deepEqual(await readFile(join(ctx.profile.paths.models, "new.bin")), await readFile(source));
  assert.deepEqual(await lstat(old, { bigint: true }), before); assert.equal((await lstat(ctx.profile.paths.models)).mode & 0o7777, 0o755);
  assert.equal((await readdir(ctx.profile.paths.models)).some((name) => name.endsWith(".model.part")), false);
}));

test("stable publication cannot admit a newly imported file changed to a legacy-readable mode", async () => fixture("linux", async (ctx) => {
  const source = join(ctx.root, "new.bin"); await writeFile(source, "new owned source", { mode: 0o644 });
  const service = await ctx.open({ async link(from, to) { await link(from, to); await chmod(to, 0o644); } });
  await assert.rejects(service.import(source), inventoryFailure("COMMITTED_UNCERTAIN"));
  assert.deepEqual(await service.installed(), []); await assert.rejects(service.acquire("new", { gpu: false }), inventoryFailure("COMMITTED_UNCERTAIN"));
  const target = join(ctx.profile.paths.models, "new.bin"); assert.equal((await lstat(target)).mode & 0o7777, 0o644);
  await chmod(target, 0o600); const confirmed = await service.ensureCommitted("new"); assert.equal(confirmed?.verification, "private-file");
  assert.deepEqual(await readFile(target), await readFile(source));
}));

test("stable downloads recognize an existing legacy catalog model without a duplicate download", async () => fixture("darwin", async (ctx) => {
  const target = join(ctx.profile.paths.models, "ggml-tiny.bin"); await writeFile(target, "existing catalog model", { mode: 0o644 });
  const before = await lstat(target, { bigint: true }); let factories = 0;
  const service = await ModelDownloads.open(ctx.profile, await ctx.open(), { transport: () => { factories++; return new FakeTransport([]); } });
  await assert.rejects(service.download("tiny"), downloadFailure("EXISTS")); assert.equal(await service.finalize(), null);
  assert.equal(factories, 0); assert.deepEqual(await lstat(target, { bigint: true }), before); assert.deepEqual(await readdir(ctx.profile.paths.cache), []);
}));

test("stable downloads preserve private staging and publish 0600 models into the original legacy directory", async () => fixture("linux", async (ctx) => {
  const old = join(ctx.profile.paths.models, "old.bin"); await writeFile(old, "old weights", { mode: 0o644 }); const before = await lstat(old, { bigint: true });
  const transport = new FakeTransport(scripts()), inventory = await ctx.open();
  const service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport, io: { async write(file, chunk) {
    assert.equal((await file.stat()).mode & 0o7777, 0o600); await file.writeFile(chunk);
  } } });
  const result = await service.download("tiny"); assert.equal(result.cleanupPending, false); assert.equal(result.installed.verification, "private-file");
  const target = join(ctx.profile.paths.models, "ggml-tiny.bin"); assert.deepEqual(await readFile(target), bytes);
  assert.equal((await lstat(target)).mode & 0o7777, 0o600); assert.equal((await lstat(ctx.profile.paths.models)).mode & 0o7777, 0o755);
  assert.deepEqual(await lstat(old, { bigint: true }), before); assert.equal((await lstat(ctx.profile.paths.cache)).mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(ctx.profile.paths.cache), []); assert.equal(await service.finalize(), null);
  await chmod(ctx.profile.paths.cache, 0o755);
  await assert.rejects(ModelDownloads.open(ctx.profile, inventory), downloadFailure("INVALID_PROFILE"));
  assert.equal((await lstat(ctx.profile.paths.cache)).mode & 0o7777, 0o755);
}));

test("serialized stable profiles cannot authorize inventory or download effects", async () => fixture("linux", async (ctx) => {
  const forged = stableProfileSchema.parse(ctx.profile), inventory = await ctx.open();
  await assert.rejects(ModelInventory.open(forged, catalog), inventoryFailure("INVALID_PROFILE"));
  await assert.rejects(ModelDownloads.open(forged, inventory), downloadFailure("INVALID_PROFILE"));
  assert.deepEqual(await readdir(ctx.profile.paths.models), []); assert.deepEqual(await readdir(ctx.profile.paths.cache), []);
}));

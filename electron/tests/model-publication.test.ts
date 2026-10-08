import assert from "node:assert/strict";
import { link, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ModelInventoryError } from "../src/services/model-inventory.js";
import { deferred, digest, fixture } from "./model-download-fixtures.js";

const failure = (code: string) => (error: unknown) => error instanceof ModelInventoryError && error.code === code;
test("expected copied integrity rejects before publication and preserves unrelated bytes", async () => fixture(async (ctx) => {
  const input = join(ctx.source, "ggml-tiny.bin"), data = Buffer.from("inert copied model bytes"); await writeFile(input, data);
  let links = 0; const inventory = await ctx.inventory({ async link(from, to) { links++; await link(from, to); } });
  const sentinel = join(ctx.profile.paths.models, "unrelated.part"); await writeFile(sentinel, "preserved", { mode: 0o600 });
  for (const expected of [{ bytes: data.length + 1, sha256: digest(data) }, { bytes: data.length, sha256: "0".repeat(64) }]) {
    const receipt = inventory.createPublicationReceipt("tiny");
    await assert.rejects(inventory.import(input, { expected, receipt }), failure("INTEGRITY_FAILED"));
    await inventory.finishImportCleanup(receipt);
  }
  assert.equal(links, 0); assert.deepEqual(await inventory.installed(), []);
  assert.deepEqual(await readdir(ctx.profile.paths.models), ["unrelated.part"]);
  assert.equal(await readFile(sentinel, "utf8"), "preserved");
}));
test("exact publication receipt confirms only its copied durable file and is single-use", async () => fixture(async (ctx) => {
  const data = Buffer.from("exact expected copied bytes"), input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, data);
  const inventory = await ctx.inventory(), receipt = inventory.createPublicationReceipt("tiny");
  const imported = await inventory.import(input, { receipt, expected: { bytes: data.length, sha256: digest(data) } });
  assert.equal(imported.copiedSha256, digest(data)); assert.equal(imported.verification, "private-file");
  assert.equal(await inventory.ensurePublicationCommitted(receipt), imported);
  await assert.rejects(inventory.ensurePublicationCommitted({ ...receipt }), failure("INVALID_RECEIPT"));
  await assert.rejects(inventory.import(input, { receipt }), failure("INVALID_RECEIPT"));
  await writeFile(join(ctx.profile.paths.models, "ggml-tiny.bin"), "same file changed");
  await assert.rejects(inventory.ensurePublicationCommitted(receipt), failure("MODEL_CHANGED"));
}));
test("a new receipt cannot adopt an unrelated same-ID uncertain publication", async () => fixture(async (ctx) => {
  const data = Buffer.from("original uncertain owner"), input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, data);
  const inventory = await ctx.inventory({ async syncDirectory() { throw new Error("Inert directory fault."); } });
  await assert.rejects(inventory.import(input), (error: unknown) => failure("COMMITTED_UNCERTAIN")(error) && error instanceof ModelInventoryError && error.receipt === undefined);
  const receipt = inventory.createPublicationReceipt("tiny");
  await assert.rejects(inventory.import(input, { receipt }), (error: unknown) => failure("COMMITTED_UNCERTAIN")(error) && error instanceof ModelInventoryError && error.receipt === undefined);
  await assert.rejects(inventory.ensurePublicationCommitted(receipt), failure("INVALID_RECEIPT"));
  assert.deepEqual(await inventory.installed(), []); assert.deepEqual(await readFile(join(ctx.profile.paths.models, "ggml-tiny.bin")), data);
}));
test("own post-publication fsync uncertainty retries the exact receipt without another copy", async () => fixture(async (ctx) => {
  const data = Buffer.from("own uncertain copy"), input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, data);
  let broken = true, reads = 0, links = 0;
  const inventory = await ctx.inventory({ async read(file, buf, position) { reads++; return (await file.read(buf, 0, buf.length, position)).bytesRead; },
    async link(from, to) { links++; await link(from, to); }, async syncDirectory(file) { if (broken) throw new Error("Inert fsync fault."); await file.sync(); } });
  const receipt = inventory.createPublicationReceipt("tiny");
  await assert.rejects(inventory.import(input, { receipt, expected: { bytes: data.length, sha256: digest(data) } }),
    (error: unknown) => error instanceof ModelInventoryError && error.code === "COMMITTED_UNCERTAIN" && error.receipt === receipt);
  const count = reads; broken = false; const result = await inventory.ensurePublicationCommitted(receipt);
  assert.equal(result.copiedSha256, digest(data)); assert.equal(reads, count); assert.equal(links, 1);
}));
test("receipt-owned failed descriptor close is never reissued and keeps import reservation", async () => fixture(async (ctx) => {
  const input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, "inert private source"); let closes = 0;
  const inventory = await ctx.inventory({ async syncFile(file) {
    await file.sync(); const original = file.close.bind(file);
    file.close = async () => { closes++; await original(); throw new Error("Inert close receipt failure."); };
  } });
  const receipt = inventory.createPublicationReceipt("tiny");
  await assert.rejects(inventory.import(input, { receipt }), failure("STORAGE_FAILED"));
  await assert.rejects(inventory.finishImportCleanup(receipt), failure("STORAGE_FAILED"));
  await assert.rejects((await ctx.inventory()).import(input), failure("BUSY")); assert.equal(closes, 1);
}));
test("receipt cleanup retries only its captured part after unlink failure", async () => fixture(async (ctx) => {
  const input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, "inert source"); let broken = true;
  const inventory = await ctx.inventory({ async write() { throw new Error("Inert write fault."); }, async unlink(path) {
    if (broken) throw new Error("Inert unlink fault."); await unlink(path);
  } });
  const sentinel = join(ctx.profile.paths.models, "sentinel.part"); await writeFile(sentinel, "untouched", { mode: 0o600 });
  const receipt = inventory.createPublicationReceipt("tiny");
  await assert.rejects(inventory.import(input, { receipt }), failure("STORAGE_FAILED"));
  await assert.rejects((await ctx.inventory()).import(input), failure("BUSY"));
  broken = false; await inventory.finishImportCleanup(receipt); await inventory.finishImportCleanup(receipt);
  assert.deepEqual(await readdir(ctx.profile.paths.models), ["sentinel.part"]);
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
  await (await ctx.inventory()).import(input);
}));
test("held receipt source close blocks cleanup and never transfers ownership early", { timeout: 5000 }, async () => fixture(async (ctx) => {
  const input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, "inert source");
  const entered = deferred<void>(), release = deferred<void>(); let closes = 0;
  const inventory = await ctx.inventory({ async read(file, buf, position) {
    if (!position) { const original = file.close.bind(file); file.close = async () => {
      closes++; entered.accept(); await release.promise; await original();
    }; } return (await file.read(buf, 0, buf.length, position)).bytesRead;
  } });
  const receipt = inventory.createPublicationReceipt("tiny"), importing = inventory.import(input, { receipt });
  await entered.promise;
  // The publication queue is itself held by the source fence. A competing
  // operation cannot settle until that fence; after it settles the import still
  // owns its cleanup reservation, so the queued competitor is refused.
  let completed = false;
  const rejected = assert.rejects((await ctx.inventory()).import(input), failure("BUSY")).then(() => { completed = true; });
  await new Promise<void>((accept) => { setImmediate(accept); }); assert.equal(completed, false);
  release.accept(); await importing; await rejected;
  await inventory.finishImportCleanup(receipt); assert.equal(closes, 1);
}));
test("receipt publication never certifies a new directory while its original close failed", async () => fixture(async (ctx) => {
  const input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, "inert complete copy");
  let closes = 0, syncs = 0;
  const inventory = await ctx.inventory({ async syncDirectory(file) {
    syncs++; await file.sync(); const original = file.close.bind(file);
    file.close = async () => { closes++; await original(); throw new Error("Inert directory retirement failure."); };
  } });
  const receipt = inventory.createPublicationReceipt("tiny");
  await assert.rejects(inventory.import(input, { receipt }), failure("COMMITTED_UNCERTAIN"));
  await assert.rejects(inventory.ensurePublicationCommitted(receipt), failure("COMMITTED_UNCERTAIN"));
  assert.equal(closes, 1); assert.equal(syncs, 1); assert.deepEqual(await inventory.installed(), []);
}));
test("synchronous receipt part close refusal retains its exact cleanup and import owner", async () => fixture(async (ctx) => {
  const input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, "owned synchronous part close");
  let closes = 0; let original: (() => Promise<void>) | undefined;
  const inventory = await ctx.inventory({ async syncFile(file) {
    await file.sync(); original = file.close.bind(file);
    file.close = () => { closes++; if (closes === 1) throw new Error("Owned synchronous part refusal."); return original!(); };
  } });
  const receipt = inventory.createPublicationReceipt("tiny");
  try {
    await assert.rejects(inventory.import(input, { receipt }), failure("STORAGE_FAILED"));
    await assert.rejects(inventory.finishImportCleanup(receipt), failure("STORAGE_FAILED"));
    await assert.rejects(inventory.finishImportCleanup(receipt), failure("STORAGE_FAILED"));
    assert.equal(closes, 1);
    assert.deepEqual(await inventory.installed(), []);
    await assert.rejects((await ctx.inventory()).import(input), failure("BUSY"));
    assert.equal((await readdir(ctx.profile.paths.models)).filter((name) => name.endsWith(".model.part")).length, 1);
  } finally { await original?.(); }
}));

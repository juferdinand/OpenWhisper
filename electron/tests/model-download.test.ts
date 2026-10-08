import assert from "node:assert/strict";
import { lstat, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ModelDownloads, ModelDownloadError, parseModelDownloadMetadata, validateModelDownloadURL } from "../src/services/model-download.js";
import { bytes, deferred, digest, FakeTransport, fixture, metadata, scripts } from "./model-download-fixtures.js";
import type { ModelLease } from "../src/services/model-inventory.js";

const failure = (code: string) => (error: unknown) => error instanceof ModelDownloadError && error.code === code && error.message === code;
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!condition()) { assert.ok(performance.now() < deadline); await new Promise<void>((accept) => { setImmediate(accept); }); }
}
test("linked metadata accepts bare or ordinary quoted SHA and ignores HEAD redirect representation size", () => {
  assert.deepEqual(parseModelDownloadMetadata(metadata()), { bytes: bytes.length, sha256: digest(bytes) });
  assert.equal(parseModelDownloadMetadata({ status: 200, raw: ["x-linked-etag", digest(bytes), "x-linked-size", String(bytes.length)] }).sha256, digest(bytes));
  for (const raw of [
    ["x-linked-etag", `W/\"${digest(bytes)}\"`, "x-linked-size", String(bytes.length)],
    ["x-linked-etag", `\\\"${digest(bytes)}\\\"`, "x-linked-size", String(bytes.length)],
    ["x-linked-etag", `${digest(bytes)},${digest(bytes)}`, "x-linked-size", String(bytes.length)],
    [...metadata().raw, "X-Linked-Size", String(bytes.length)],
    [...metadata().raw, "Content-Encoding", "gzip"],
    ["x-linked-etag", digest(bytes).toUpperCase(), "x-linked-size", String(bytes.length)],
    ["x-linked-etag", digest(bytes), "x-linked-size", "999999"],
    ["x-linked-etag", digest(bytes), "x-linked-size", "4000000001"],
  ]) assert.throws(() => parseModelDownloadMetadata({ status: 302, raw }), failure("METADATA_FAILED"));
});
test("fixed redirect authority rejects downgrade credentials ports IP suffix tricks and fragments", () => {
  for (const value of ["http://hf.co/file", "https://hf.co:444/file", "https://user:pass@hf.co/file", "https://127.0.0.1/file",
    "https://hf.co./file", "https://hf.co.evil.invalid/file", "https://nothf.co/file", "https://hf.co/file#secret"]) {
    assert.throws(() => validateModelDownloadURL(new URL(value)), failure("REDIRECT_FAILED"));
  }
  for (const value of ["https://hf.co/file", "https://us.aws.cdn.hf.co/fixture?inert=signature", "https://huggingface.co/file"]) validateModelDownloadURL(new URL(value));
});
test("catalog download streams bounded chunks into private cache then exact durable inventory publication", async () => fixture(async (ctx) => {
  const existingCache = await readdir(ctx.profile.paths.cache);
  const transport = new FakeTransport(scripts()); const progress: { received: number; total: number }[] = [];
  const inventory = await ctx.inventory(), downloads = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport,
    progress: (value) => { progress.push(value); } });
  const result = await downloads.download("tiny");
  assert.equal(result.cleanupPending, false); assert.equal(result.installed.model.id, "tiny"); assert.equal(result.installed.verification, "private-file");
  assert.deepEqual(result.integrity, { verification: "server-integrity", bytes: bytes.length, sha256: digest(bytes), finalHost: "huggingface.co" });
  assert.deepEqual(await readFile(join(ctx.profile.paths.models, "ggml-tiny.bin")), bytes);
  const stats = await lstat(join(ctx.profile.paths.models, "ggml-tiny.bin")); assert.equal(stats.mode & 0o7777, 0o600); assert.equal(stats.nlink, 1);
  assert.deepEqual(await readdir(ctx.profile.paths.cache), existingCache); assert.deepEqual(await readdir(ctx.profile.paths.downloads), []);
  assert.deepEqual(transport.requests.map((r) => r.method), ["HEAD", "GET"]); assert.equal(transport.closes, 1);
  assert.ok(progress.length > 0); assert.ok(progress.every((p) => Number.isFinite(p.received) && p.received >= 0 && p.received <= p.total && p.total === bytes.length));
  assert.equal(await downloads.finalize(), null);
}));
test("unknown custom IDs URLs objects and aborted requests perform zero transport effects", async () => fixture(async (ctx) => {
  const existingCache = await readdir(ctx.profile.paths.cache);
  let factories = 0; const service = await ModelDownloads.open(ctx.profile, await ctx.inventory(), { transport: () => { factories++; return new FakeTransport([]); } });
  for (const id of ["custom", "https://hf.co/file", "../tiny", { id: "tiny" }]) await assert.rejects(service.download(id), failure("INVALID_ID"));
  const controller = new AbortController(); controller.abort(); await assert.rejects(service.download("tiny", controller.signal), failure("CANCELLED"));
  assert.equal(factories, 0); assert.deepEqual(await readdir(ctx.profile.paths.cache), existingCache);
}));
test("redirect closes its old owner before next GET and retains only final hostname", async () => fixture(async (ctx) => {
  const initial = scripts(); assert.ok(initial[0] && initial[1]);
  const transport = new FakeTransport([initial[0], { headers: { status: 302, raw: ["Location", "https://us.aws.cdn.hf.co/inert?notRetained=signed"] } }, initial[1]]);
  const service = await ModelDownloads.open(ctx.profile, await ctx.inventory(), { transport: () => transport });
  const result = await service.download("tiny"); assert.equal(result.integrity.finalHost, "us.aws.cdn.hf.co");
  assert.equal(JSON.stringify(result.integrity).includes("notRetained"), false); assert.equal(transport.requests.length, 3);
}));
test("forbidden redirect or loop cannot issue a request to its target", async () => {
  for (const location of ["http://hf.co/model", "https://evil.invalid/file", "https://user@hf.co/file", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"]) {
    await fixture(async (ctx) => {
      const first = scripts()[0]; assert.ok(first);
      const transport = new FakeTransport([first, { headers: { status: 302, raw: ["Location", location] } }]);
      const service = await ModelDownloads.open(ctx.profile, await ctx.inventory(), { transport: () => transport });
      await assert.rejects(service.download("tiny"), failure("REDIRECT_FAILED")); await service.finalize();
      assert.equal(transport.requests.length, 2); assert.deepEqual(await readdir(ctx.profile.paths.models), []);
    });
  }
});
test("five redirect hops are the maximum and HEAD never follows its Location", async () => fixture(async (ctx) => {
  const first = scripts()[0]; assert.ok(first);
  const transport = new FakeTransport([{ headers: { ...first.headers, raw: [...first.headers.raw, "Location", "https://evil.invalid/not-followed"] } },
    ...Array.from({ length: 6 }, (_, index) => ({ headers: { status: 302, raw: ["Location", `https://cdn.hf.co/inert/${index}`] } }))]);
  const service = await ModelDownloads.open(ctx.profile, await ctx.inventory(), { transport: () => transport });
  await assert.rejects(service.download("tiny"), failure("REDIRECT_FAILED")); await service.finalize();
  assert.equal(transport.requests.length, 7);
  assert.equal(transport.requests[0]?.url.hostname, "huggingface.co"); assert.equal(transport.requests[1]?.url.hostname, "huggingface.co");
  assert.ok(transport.requests.every((r) => r.url.hostname !== "evil.invalid"));
}));
test("overflow truncation hash mismatch encoding and terminal EOF error cannot publish", async () => {
  for (const kind of ["overflow", "chunk", "truncated", "hash", "encoding", "length", "terminal"] as const) await fixture(async (ctx) => {
    const records = scripts(); assert.ok(records[0] && records[1]);
    if (kind === "overflow") records[1] = { ...records[1], chunks: [...(records[1].chunks ?? []), Buffer.from("x")] };
    if (kind === "chunk") records[1] = { ...records[1], chunks: [Buffer.alloc(65_537)] };
    if (kind === "truncated") records[1] = { ...records[1], chunks: records[1].chunks?.slice(0, -1) ?? [] };
    if (kind === "hash") records[0] = { headers: { ...metadata(), raw: ["x-linked-etag", "0".repeat(64), "x-linked-size", String(bytes.length)] } };
    if (kind === "encoding") records[1] = { ...records[1], headers: { status: 200, raw: ["Content-Encoding", "gzip"] } };
    if (kind === "length") records[1] = { ...records[1], headers: { status: 200, raw: ["Content-Length", String(bytes.length - 1)] } };
    if (kind === "terminal") records[1] = { ...records[1], failed: true };
    let links = 0; const inventory = await ctx.inventory({ async link() { links++; throw new Error("Must not publish."); } });
    const transport = new FakeTransport(records), service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport });
    await assert.rejects(service.download("tiny"), failure(kind === "encoding" ? "METADATA_FAILED" : kind === "terminal" ? "TRANSPORT_FAILED" : "INTEGRITY_FAILED"));
    await service.finalize(); assert.equal(links, 0); assert.deepEqual(await readdir(ctx.profile.paths.models), []);
  });
});
test("cancellation during held write sync or close retains one owner and never publishes late", { timeout: 10_000 }, async () => {
  for (const phase of ["write", "sync", "close"] as const) await fixture(async (ctx) => {
    const existingCache = await readdir(ctx.profile.paths.cache);
    const entered = deferred<void>(), release = deferred<void>(), controller = new AbortController(); let held = false, closes = 0;
    const wait = async () => { if (!held) { held = true; entered.accept(); await release.promise; } };
    const transport = new FakeTransport(scripts()), inventory = await ctx.inventory();
    const service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport, io: {
      async write(file, chunk) { await file.writeFile(chunk); if (phase === "write") await wait(); },
      async sync(file) { await file.sync(); if (phase === "sync") await wait(); },
      async close(file) { closes++; if (phase === "close") await wait(); await file.close(); },
    } });
    const other = await ModelDownloads.open(ctx.profile, inventory, { transport: () => new FakeTransport([]) });
    const rejection = assert.rejects(service.download("tiny", controller.signal), failure("CANCELLED"));
    await entered.promise; controller.abort(); await rejection;
    await assert.rejects(other.download("tiny"), failure("BUSY")); await assert.rejects(other.finalize(), failure("BUSY"));
    release.accept(); assert.equal(await service.finalize(), null); assert.equal(closes, 1);
    assert.deepEqual(await readdir(ctx.profile.paths.cache), existingCache); assert.deepEqual(await inventory.installed(), []);
  });
});
test("held headers and separate idle or whole deadlines issue no late additional requests", { timeout: 10_000 }, async () => {
  for (const kind of ["headers", "idle", "whole"] as const) await fixture(async (ctx) => {
    const gate = deferred<void>(), records = scripts(); assert.ok(records[0] && records[1]);
    if (kind === "headers" || kind === "whole") records[0] = { ...records[0], headersGate: gate.promise };
    else records[1] = { ...records[1], bodyGate: gate.promise };
    const transport = new FakeTransport(records), service = await ModelDownloads.open(ctx.profile, await ctx.inventory(), {
      transport: () => transport, limits: { headersMs: kind === "headers" ? 15 : 1000, idleMs: 15, totalMs: kind === "whole" ? 15 : 2000 } });
    await assert.rejects(service.download("tiny"), failure("TIMEOUT"));
    const requestsAtExpiry = transport.requests.length;
    // The whole deadline includes private preparation, so it may expire before HEAD.
    if (kind === "whole") assert.ok(requestsAtExpiry === 0 || requestsAtExpiry === 1);
    else assert.equal(requestsAtExpiry, kind === "idle" ? 2 : 1);
    await assert.rejects(service.download("tiny"), failure("BUSY")); gate.accept(); assert.equal(await service.finalize(), null);
    assert.equal(transport.requests.length, requestsAtExpiry); assert.deepEqual(await readdir(ctx.profile.paths.models), []);
  });
});
test("held transport closure prevents a second download until the same close settles", { timeout: 5000 }, async () => fixture(async (ctx) => {
  const gate = deferred<void>(), records = scripts(); assert.ok(records[0]);
  records[0] = { headers: { status: 500, raw: [] } };
  const transport = new FakeTransport(records, gate.promise), inventory = await ctx.inventory();
  const service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport, limits: { cleanupMs: 20 } });
  await assert.rejects(service.download("tiny"), failure("METADATA_FAILED"));
  await assert.rejects(service.finalize(), failure("CLEANUP_FAILED"));
  await assert.rejects((await ModelDownloads.open(ctx.profile, inventory)).download("tiny"), failure("BUSY"));
  gate.accept(); await service.finalize(); assert.equal(transport.closes, 1);
}));
test("uncertain publication finalizes the exact receipt without new requests or copying", async () => fixture(async (ctx) => {
  let broken = true, reads = 0;
  const inventory = await ctx.inventory({ async syncDirectory(file) { if (broken) throw new Error("Inert directory fault."); await file.sync(); },
    async read(file, chunk, position) { reads++; return (await file.read(chunk, 0, chunk.length, position)).bytesRead; } });
  const transport = new FakeTransport(scripts()), service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport });
  await assert.rejects(service.download("tiny"), failure("COMMITTED_UNCERTAIN"));
  assert.deepEqual(await inventory.installed(), []); broken = false; const count = reads;
  const result = await service.finalize(); assert.ok(result); assert.equal(result.cleanupPending, false);
  assert.equal(result.installed.copiedSha256, digest(bytes)); assert.equal(reads, count); assert.equal(transport.requests.length, 2);
}));
test("unrelated same-ID uncertainty cannot be adopted by a later download finalizer", async () => fixture(async (ctx) => {
  const old = Buffer.from("unrelated pending bytes"), input = join(ctx.source, "ggml-tiny.bin"); await writeFile(input, old);
  const inventory = await ctx.inventory({ async syncDirectory() { throw new Error("Inert pending owner."); } });
  await assert.rejects(inventory.import(input));
  const transport = new FakeTransport(scripts()), service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport });
  await assert.rejects(service.download("tiny"), failure("COMMITTED_UNCERTAIN"));
  assert.equal(await service.finalize(), null); assert.deepEqual(await inventory.installed(), []);
  assert.deepEqual(await readFile(join(ctx.profile.paths.models, "ggml-tiny.bin")), old);
}));
test("mutation of staged bytes before import fails the copied integrity gate", async () => fixture(async (ctx) => {
  let links = 0; const inventory = await ctx.inventory({ async link() { links++; throw new Error("Must not publish."); } });
  const transport = new FakeTransport(scripts()), service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport,
    io: { async sync(file) { await file.sync(); await file.write(Buffer.from([12]), 0, 1, 0); } } });
  await assert.rejects(service.download("tiny"), failure("INTEGRITY_FAILED")); await service.finalize(); assert.equal(links, 0);
}));
test("committed output survives a separate staging cleanup failure without deleting unrelated files", async () => fixture(async (ctx) => {
  let sentinel: string | undefined;
  const transport = new FakeTransport(scripts()), service = await ModelDownloads.open(ctx.profile, await ctx.inventory(), { transport: () => transport,
    io: { async sync(file) { await file.sync(); const name = (await readdir(ctx.profile.paths.cache)).find((item) => item.startsWith("model-download-")); assert.ok(name);
      sentinel = join(ctx.profile.paths.cache, name, "unrelated.part"); await writeFile(sentinel, "preserved", { mode: 0o600 }); } } });
  const result = await service.download("tiny"); assert.equal(result.cleanupPending, true); assert.ok(sentinel);
  assert.equal(await readFile(sentinel, "utf8"), "preserved");
  await assert.rejects(service.download("tiny"), failure("BUSY")); await assert.rejects(service.finalize(), failure("CLEANUP_FAILED"));
  await unlink(sentinel); const finalized = await service.finalize(); assert.equal(finalized?.cleanupPending, false);
  assert.deepEqual(await readFile(join(ctx.profile.paths.models, "ggml-tiny.bin")), bytes); assert.equal(transport.requests.length, 2);
}));
test("cache parent alias is rejected without repairing or deleting its replacement", async () => fixture(async (ctx) => {
  const inventory = await ctx.inventory(), original = ctx.profile.paths.cache, saved = join(ctx.root, "saved-cache");
  const service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => { throw new Error("No transport allowed."); } });
  await rename(original, saved); await symlink(saved, original);
  await assert.rejects(service.download("tiny"), failure("UNSAFE_STAGING"));
  assert.ok((await lstat(original)).isSymbolicLink()); await unlink(original); await rename(saved, original); await service.finalize();
}));
test("a lease acquired during transport preserves its later target and prevents download replacement", async () => fixture(async (ctx) => {
  let lease: ModelLease | undefined; const inventory = await ctx.inventory(), target = join(ctx.profile.paths.models, "ggml-tiny.bin");
  const records = scripts(); assert.ok(records[1]);
  const entered = deferred<void>(), release = deferred<void>(); records[1] = { ...records[1], bodyGate: release.promise };
  const transport = new FakeTransport(records), service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport });
  const rejection = assert.rejects(service.download("tiny"), failure("PUBLICATION_FAILED"));
  await until(() => transport.requests.length === 2); entered.accept();
  await writeFile(target, "later private model", { mode: 0o600 }); lease = await inventory.acquire("tiny", { gpu: false });
  release.accept(); await rejection; await service.finalize();
  assert.equal(await readFile(target, "utf8"), "later private model"); await lease.release(Promise.resolve());
}));
test("cancel during copied import retains the late copy fence and publishes no stopped operation", { timeout: 5000 }, async () => fixture(async (ctx) => {
  const entered = deferred<void>(), release = deferred<void>(), controller = new AbortController(); let first = true;
  const inventory = await ctx.inventory({ async read(file, chunk, position) {
    const result = await file.read(chunk, 0, chunk.length, position);
    if (first) { first = false; entered.accept(); await release.promise; } return result.bytesRead;
  } });
  const transport = new FakeTransport(scripts()), service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport });
  const rejection = assert.rejects(service.download("tiny", controller.signal), failure("CANCELLED"));
  await entered.promise; controller.abort(); await rejection; await assert.rejects(service.download("tiny"), failure("BUSY"));
  release.accept(); assert.equal(await service.finalize(), null); assert.deepEqual(await inventory.installed(), []);
}));
test("cancel after publication cannot erase its late committed result and explicit finalization needs no GET", { timeout: 5000 }, async () => fixture(async (ctx) => {
  const entered = deferred<void>(), release = deferred<void>(), controller = new AbortController();
  const inventory = await ctx.inventory({ async syncDirectory(file) { entered.accept(); await release.promise; await file.sync(); } });
  const transport = new FakeTransport(scripts()), service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport });
  const rejection = assert.rejects(service.download("tiny", controller.signal), failure("CANCELLED"));
  await entered.promise; controller.abort(); await rejection; await assert.rejects(service.download("tiny"), failure("BUSY"));
  release.accept(); const result = await service.finalize(); assert.ok(result);
  assert.equal(result.installed.copiedSha256, digest(bytes)); assert.equal(result.cleanupPending, false); assert.equal(transport.requests.length, 2);
}));
test("a failed staging descriptor certificate is retained without double close or another owner", async () => fixture(async (ctx) => {
  let closes = 0; const transport = new FakeTransport(scripts()), inventory = await ctx.inventory();
  const service = await ModelDownloads.open(ctx.profile, inventory, { transport: () => transport, io: { async close(file) {
    closes++; await file.close(); throw new Error("Inert failed close certificate.");
  } } });
  await assert.rejects(service.download("tiny"), failure("STORAGE_FAILED"));
  await assert.rejects(service.finalize(), failure("CLEANUP_FAILED"));
  await assert.rejects((await ModelDownloads.open(ctx.profile, inventory)).download("tiny"), failure("BUSY"));
  assert.equal(closes, 1); assert.deepEqual(await inventory.installed(), []);
  assert.equal((await readdir(ctx.profile.paths.cache)).filter((name) => name.startsWith("model-download-")).length, 1);
}));

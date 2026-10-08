import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import type { Agent } from "node:https";
import { join } from "node:path";
import test from "node:test";
import { createModelDownloadTransport } from "../src/services/model-download-transport.js";
import { ModelInventoryError } from "../src/services/model-inventory.js";
import { fixture } from "./model-download-fixtures.js";

const uncertain = (error: unknown): boolean => error instanceof ModelInventoryError && error.code === "COMMITTED_UNCERTAIN";

test("destroyed socket still owns its actual close event when delivered to the request", async () => {
  const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy(): void };
  socket.destroyed = true;
  socket.destroy = () => {};
  const request = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy(): void; end(): void };
  request.destroyed = false;
  request.destroy = () => { request.destroyed = true; queueMicrotask(() => { request.emit("close"); }); };
  request.end = () => { queueMicrotask(() => { request.emit("socket", socket); }); };
  const transport = createModelDownloadTransport({ createAgent: () => ({ destroy() {} }) as unknown as Agent,
    request: () => request as unknown as ClientRequest });
  const exchange = transport.request(new URL("https://hf.co/inert"), "HEAD", new AbortController().signal);
  await new Promise<void>((accept) => { setImmediate(accept); });
  const closing = exchange.close(); let settled = false;
  void closing.then(() => { settled = true; });
  try {
    await new Promise<void>((accept) => { setImmediate(accept); });
    assert.equal(settled, false, "Destroy intent is not a socket close certificate.");
  } finally { socket.emit("close"); await closing; await transport.close(); }
});

test("synchronous receipt directory close refusal is retained without a second certificate", async () => fixture(async (ctx) => {
  const source = join(ctx.source, "ggml-tiny.bin"); await writeFile(source, "owned synchronous directory close");
  let closes = 0;
  const handles: { close(): Promise<void> }[] = [];
  const inventory = await ctx.inventory({ async syncDirectory(file) {
    await file.sync(); const original = file.close.bind(file); handles.push({ close: original });
    file.close = () => { closes++; if (closes === 1) throw new Error("Owned synchronous refusal."); return original(); };
  } });
  const receipt = inventory.createPublicationReceipt("tiny");
  try {
    await assert.rejects(inventory.import(source, { receipt }), uncertain);
    await assert.rejects(inventory.ensurePublicationCommitted(receipt), uncertain);
    assert.equal(closes, 1);
    assert.deepEqual(await inventory.installed(), []);
  } finally { await Promise.allSettled(handles.map((file) => file.close())); }
}));

test("synchronous receipt source close refusal cannot be retried by final cleanup", async () => fixture(async (ctx) => {
  const source = join(ctx.source, "ggml-tiny.bin"); await writeFile(source, "owned synchronous source close");
  let closes = 0;
  let original: (() => Promise<void>) | undefined;
  const inventory = await ctx.inventory({ async read(file, buffer, position) {
    if (position === 0) {
      original = file.close.bind(file);
      file.close = () => { closes++; if (closes === 1) throw new Error("Owned synchronous refusal."); return original!(); };
    }
    return (await file.read(buffer, 0, buffer.length, position)).bytesRead;
  } });
  const receipt = inventory.createPublicationReceipt("tiny");
  try {
    await assert.rejects(inventory.import(source, { receipt }), (error: unknown) => error instanceof ModelInventoryError && error.code === "STORAGE_FAILED");
    await assert.rejects(inventory.finishImportCleanup(receipt), (error: unknown) => error instanceof ModelInventoryError && error.code === "STORAGE_FAILED");
    assert.equal(closes, 1);
    await assert.rejects((await ctx.inventory()).import(source), (error: unknown) => error instanceof ModelInventoryError && error.code === "BUSY");
  } finally { await original?.(); }
}));

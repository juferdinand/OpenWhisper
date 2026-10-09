import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { createLinuxRestartWriter, LINUX_RESTART_FRAME_BYTES, LinuxRestartError, openLinuxRestartWriter, readLinuxRestartReceipt } from "../src/main/linux-restart.js";

const nonce = "a".repeat(64), current = "0.3.0";
const frame = (overrides: Record<string, unknown> = {}): Buffer => Buffer.from(`${JSON.stringify({ version: 1, type: "restart", nonce, installedVersion: "0.3.1", ...overrides })}\n`);

test("restart pipe accepts fragmented exact frame only after EOF and original stream close", async () => {
  const pipe = new PassThrough({ autoDestroy: false }), result = readLinuxRestartReceipt(pipe, current, nonce);
  let settled = false; void result.then(() => { settled = true; });
  const bytes = frame(); pipe.write(bytes.subarray(0, 23)); pipe.end(bytes.subarray(23));
  await new Promise<void>((accept) => setImmediate(accept)); assert.equal(settled, false);
  pipe.destroy(); assert.deepEqual(await result, { version: 1, type: "restart", nonce, installedVersion: "0.3.1" });
});

test("empty closed pipe is ordinary quit; malformed, duplicate, foreign or non-newer receipts are private refusals", async () => {
  const empty = new PassThrough(), ordinary = readLinuxRestartReceipt(empty, current, nonce); empty.end(); assert.equal(await ordinary, undefined);
  const cases = [frame({ nonce: "b".repeat(64) }), frame({ installedVersion: "0.3.0" }), frame({ installedVersion: "03.1.0" }),
    frame({ installedVersion: "18446744073709551616.0.0" }), frame({ executable: "/bin/true" }), frame({ version: 2 }),
    Buffer.concat([frame(), frame()]), frame().subarray(0, -1), Buffer.from([0xff, 0x0a]), Buffer.alloc(LINUX_RESTART_FRAME_BYTES + 1, 0x61)];
  for (const bytes of cases) {
    const pipe = new PassThrough(), received = readLinuxRestartReceipt(pipe, current, nonce); pipe.end(bytes);
    await assert.rejects(received, { code: "CHANNEL_FAILED", message: "CHANNEL_FAILED" });
  }
});

test("original pipe errors or close without EOF refuse instead of authorizing restart", async () => {
  for (const cause of [undefined, new Error("Owned failure; contents must not escape")]) {
    const pipe = new PassThrough(), received = readLinuxRestartReceipt(pipe, current, nonce); pipe.destroy(cause);
    await assert.rejects(received, { code: "CHANNEL_FAILED", message: "CHANNEL_FAILED" });
  }
});

test("writer flushes one complete nonce-bound receipt and preserves caller artifact ownership", async () => {
  const pipe = new PassThrough(), received = readLinuxRestartReceipt(pipe, current, nonce), writer = createLinuxRestartWriter(pipe, current, nonce);
  await writer.requestRestart("0.3.1"); assert.equal((await received)?.installedVersion, "0.3.1");
  await assert.rejects(writer.requestRestart("0.3.2"), { code: "INVALID_REQUEST" });
  const output = new Writable({ write(_bytes, _encoding, done) { done(new Error("Owned write error")); } });
  await assert.rejects(createLinuxRestartWriter(output, current, nonce).requestRestart("0.3.1"), { code: "CHANNEL_FAILED", message: "CHANNEL_FAILED" });
});

test("invalid versions or contexts never write a frame and inherited writer is unavailable without its channel context", async () => {
  const pipe = new PassThrough(), writer = createLinuxRestartWriter(pipe, current, nonce); let bytes = 0; pipe.on("data", (value: Buffer) => { bytes += value.length; });
  await assert.rejects(writer.requestRestart("0.2.5"), { code: "INVALID_REQUEST" }); assert.equal(bytes, 0); pipe.destroy();
  assert.throws(() => createLinuxRestartWriter(new PassThrough(), current, "invalid"), LinuxRestartError);
  assert.throws(() => openLinuxRestartWriter("invalid"), { code: "UNAVAILABLE" });
});

test("late writer finish cannot beat its absolute deadline when the timer has not run", async (t) => {
  let now = 0, finishWrite!: () => void; t.mock.method(performance, "now", () => now);
  const output = new Writable({ write(_bytes, _encoding, done) { finishWrite = done; } });
  const result = createLinuxRestartWriter(output, current, nonce).requestRestart("0.3.1"); void result.catch(() => {});
  now = 5000; finishWrite(); await assert.rejects(result, { code: "CHANNEL_FAILED" }); output.destroy();
});

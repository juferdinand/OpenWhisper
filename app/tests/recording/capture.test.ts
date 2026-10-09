import assert from "node:assert/strict";
import test from "node:test";
import { NativeCaptureBoundary } from "../../src/services/recording/capture.js";
import { captureMetadataSchema, checkedCaptureSelection, loadNativeCapture,
  type CaptureMetadata, type NativeCaptureSession } from "../../src/workers/native-capture.js";
import { captureReplySchema, captureRequestSchema } from "../../src/workers/capture-protocol.js";

const initial: CaptureMetadata = { generation: 1, running: false, streamClosed: false, finalSamplesFenced: false,
  failed: false, frameCount: "0", sequence: "0", sampleRate: 48000, channels: 1, level: 0 };
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve };
}
function fixture(): { native: NativeCaptureSession; calls: string[] } {
  const calls: string[] = [];
  return { calls, native: { generation: 1,
    start: async () => { calls.push("start"); return { ...initial, running: true }; },
    closeAndFence: async () => { calls.push("close"); return { ...initial, streamClosed: true, finalSamplesFenced: true }; },
    prepare: async () => { calls.push("prepare"); return { ...initial, streamClosed: true, finalSamplesFenced: true, sampleCount: 3, chunkCount: 1 }; },
    readPreparedChunk: () => new Float32Array([0.25, -0.125, 0.5]), status: () => initial,
    release: async () => { calls.push("release"); return { ...initial, streamClosed: true, finalSamplesFenced: true }; },
    feed: () => {}, feedHole: () => {}, injectError: () => {}, abortStart: () => {},
  } };
}
function session(native: NativeCaptureSession) {
  return new NativeCaptureBoundary({ create: () => native }, { mode: "synthetic", sampleRate: 48000, channels: 1 })
    .create({ generation: 1, onLevel: () => {}, onError: () => {} });
}
test("capture selections require an explicit local Pulse transport and safe source", () => {
  for (const server of ["default", "tcp:127.0.0.1", "unix:relative", "unix:/owned/\0socket"]) {
    assert.throws(() => checkedCaptureSelection({ mode: "pulse", source: "owned.monitor", server }));
  }
  assert.throws(() => checkedCaptureSelection({ mode: "pulse", source: "", server: "unix:/owned/pulse/native" }));
  assert.equal(checkedCaptureSelection({ mode: "pulse", source: "owned.monitor", server: "unix:/owned/pulse/native" }).mode, "pulse");
  assert.throws(() => checkedCaptureSelection({ mode: "synthetic", sampleRate: 0, channels: 1 }));
});
test("capture control frames carry metadata only and reject arbitrary audio or commands", () => {
  const envelope = { version: 1, id: "eb25fcab-7cdd-4e2e-9efc-d4fe2b6e1d25", generation: 1 };
  assert.equal(captureRequestSchema.safeParse({ ...envelope, command: "status" }).success, true);
  assert.equal(captureRequestSchema.safeParse({ ...envelope, command: "prepare" }).success, false);
  assert.equal(captureReplySchema.safeParse({ ...envelope, ok: true, value: initial, samples: new Float32Array(1) }).success, false);
  assert.equal(captureMetadataSchema.safeParse({ ...initial, frameCount: "18446744073709551616" }).success, false);
  assert.equal(captureMetadataSchema.safeParse({ ...initial, failureKind: "private device name" }).success, false);
});

test("owned native Pulse hole visitor preserves bounded silent frames and rejects misaligned fragments", {
  skip: !process.env.OPENWHISPER_CAPTURE_SYNTHETIC_ADDON,
}, async () => {
  const path = process.env.OPENWHISPER_CAPTURE_SYNTHETIC_ADDON; assert.ok(path);
  const native = loadNativeCapture(path), capture = native.create(72, { mode: "synthetic", sampleRate: 16000, channels: 2 });
  await capture.start(); capture.feed(new Float32Array([0.25, 0.75]));
  assert.throws(() => capture.feedHole(7)); assert.equal(capture.status().frameCount, "1");
  capture.feedHole(5003 * 2 * 4);
  assert.equal(capture.status().frameCount, "5004");
  capture.feed(new Float32Array([0.5, 0.5]));
  const closed = await capture.closeAndFence(); assert.equal(closed.failed, false); assert.equal(closed.failureKind, "none");
  assert.equal(closed.frameCount, "5005");
  const prepared = await capture.prepare(), all = new Float32Array(prepared.sampleCount); let count = 0;
  for (let i = 0; i < prepared.chunkCount; i++) {
    const chunk = capture.readPreparedChunk(i); all.set(chunk, count); count += chunk.length;
  }
  assert.equal(count, 5005); assert.equal(all[0], 0.5); assert.equal(all[5004], 0.5);
  assert.ok(all.subarray(1, 5004).every((sample) => sample === 0));
  await capture.release(); assert.throws(() => capture.feedHole(8));
});
test("native adapter fences closure before preparation and retains explicit release ownership", async () => {
  const { native, calls } = fixture(), capture = session(native), controller = new AbortController();
  await capture.start(controller.signal); const fenced = await capture.closeAndFence();
  assert.deepEqual(calls, ["start", "close"]); assert.ok(fenced.captured);
  const audio = await capture.prepare(fenced.captured, { generation: 1, attempt: 7, signal: controller.signal });
  assert.equal(audio.sampleCount, 3); assert.equal(audio.attempt, 7);
  assert.deepEqual(calls, ["start", "close", "prepare"]);
  await capture.release(); await capture.release(); assert.equal(calls.filter((c) => c === "release").length, 1);
});
test("cancelled startup keeps native ownership until transaction settles before rollback", async () => {
  const { native, calls } = fixture(), pending = deferred<CaptureMetadata>();
  native.start = async () => { calls.push("start"); return pending.promise; };
  const capture = session(native), controller = new AbortController();
  const startup = capture.start(controller.signal); const rejected = assert.rejects(startup); controller.abort();
  const closing = capture.closeAndFence(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["start"]);
  await rejected; pending.resolve({ ...initial, running: true });
  assert.equal((await closing).streamClosed, true); assert.deepEqual(calls, ["start", "close"]);
});
test("startup and native close deadlines report failure while retaining a single unsettled owner", async () => {
  const { native, calls } = fixture(), pending = deferred<CaptureMetadata>();
  native.start = async () => { calls.push("start"); return pending.promise; };
  native.abortStart = () => { calls.push("abort-start"); };
  const capture = new NativeCaptureBoundary({ create: () => native }, { mode: "synthetic", sampleRate: 48000, channels: 1 },
    { startupMs: 2, closeMs: 2 }).create({ generation: 1, onError: () => {}, onLevel: () => {} });
  await assert.rejects(capture.start(new AbortController().signal));
  await assert.rejects(capture.closeAndFence()); assert.equal(calls.includes("close"), false);
  pending.resolve({ ...initial, running: true });
  assert.equal((await capture.closeAndFence()).streamClosed, true); await capture.release();

  const second = fixture(), closure = deferred<CaptureMetadata>(); let closes = 0;
  second.native.closeAndFence = async () => { closes++; return closure.promise; };
  const waiting = new NativeCaptureBoundary({ create: () => second.native }, { mode: "synthetic", sampleRate: 48000, channels: 1 },
    { startupMs: 2, closeMs: 2 }).create({ generation: 1, onError: () => {}, onLevel: () => {} });
  await waiting.start(new AbortController().signal); await assert.rejects(waiting.closeAndFence());
  await assert.rejects(waiting.closeAndFence()); assert.equal(closes, 1);
  closure.resolve({ ...initial, streamClosed: true, finalSamplesFenced: true });
  assert.equal((await waiting.closeAndFence()).streamClosed, true); await waiting.release();
});
test("release timeout retains the same native cleanup and retries without freeing a later owner", async () => {
  const { native } = fixture(), pending = deferred<CaptureMetadata>(); let releases = 0;
  native.release = async () => { releases++; return pending.promise; };
  const capture = new NativeCaptureBoundary({ create: () => native }, { mode: "synthetic", sampleRate: 48000, channels: 1 },
    { startupMs: 5, closeMs: 5 }).create({ generation: 1, onError: () => {}, onLevel: () => {} });
  await capture.start(new AbortController().signal); await capture.closeAndFence();
  await assert.rejects(capture.release()); await assert.rejects(capture.release()); assert.equal(releases, 1);
  pending.resolve({ ...initial, streamClosed: true, finalSamplesFenced: true });
  await capture.release(); await capture.release(); assert.equal(releases, 1);
});
test("failed close remains retryable and does not release raw samples", async () => {
  const { native, calls } = fixture(); let attempts = 0;
  native.closeAndFence = async () => { calls.push("close"); if (++attempts === 1) throw new Error("failure");
    return { ...initial, streamClosed: true, finalSamplesFenced: true, failed: true }; };
  const capture = session(native); await capture.start(new AbortController().signal);
  await assert.rejects(capture.closeAndFence()); const retry = await capture.closeAndFence();
  assert.equal(retry.error, "capture_failed"); assert.ok(retry.captured);
  assert.equal(calls.includes("release"), false);
  const audio = await capture.prepare(retry.captured, { generation: 1, attempt: 1, signal: new AbortController().signal });
  assert.equal(audio.sampleCount, 3);
  await assert.rejects(capture.prepare({ ...retry.captured }, { generation: 1, attempt: 2, signal: new AbortController().signal }));
  await capture.release();
});
test("capture generation mismatch and pre-start cancellation cannot acquire a stream", async () => {
  const { native, calls } = fixture(), capture = session(native), controller = new AbortController(); controller.abort();
  await assert.rejects(capture.start(controller.signal)); assert.deepEqual(calls, []);
  native.closeAndFence = async () => ({ ...initial, generation: 2, streamClosed: true, finalSamplesFenced: true });
  await assert.rejects(capture.closeAndFence(), /OWNERSHIP_FAILED/);
});
test("an unconfirmed native fence remains busy and later close retries instead of caching success", async () => {
  const { native, calls } = fixture(); let attempts = 0;
  native.closeAndFence = async () => { calls.push("close"); return { ...initial, streamClosed: ++attempts > 1,
    finalSamplesFenced: attempts > 1, failed: true }; };
  const capture = session(native); await capture.start(new AbortController().signal);
  const incomplete = await capture.closeAndFence(); assert.equal(incomplete.captured, null);
  const retried = await capture.closeAndFence(); assert.ok(retried.captured); assert.equal(attempts, 2);
  await capture.release();
});

test("owned native synthetic capture preserves every partial tail and supports retry without devices", {
  skip: !process.env.OPENWHISPER_CAPTURE_SYNTHETIC_ADDON,
}, async () => {
  const path = process.env.OPENWHISPER_CAPTURE_SYNTHETIC_ADDON; assert.ok(path);
  const native = loadNativeCapture(path);
  for (const rate of [8000, 16000, 44100, 48000, 96000]) {
    const capture = native.create(rate, { mode: "synthetic", sampleRate: rate, channels: 2 });
    await assert.rejects(capture.prepare()); await capture.start();
    const frames = rate + 17;
    for (let offset = 0; offset < frames; offset += 997) {
      const block = new Float32Array(Math.min(997, frames - offset) * 2).fill(0.25); capture.feed(block);
    }
    const before = capture.status(); const fenced = await capture.closeAndFence();
    assert.equal(fenced.frameCount, String(frames)); assert.equal(fenced.sequence, before.sequence);
    assert.equal(fenced.streamClosed && fenced.finalSamplesFenced, true);
    assert.throws(() => capture.feed(new Float32Array(2)));
    const first = await capture.prepare(); assert.equal(first.sampleCount, Math.floor(frames * 16000 / rate));
    let count = 0, tailEnergy = 0;
    for (let i = 0; i < first.chunkCount; i++) {
      const chunk = capture.readPreparedChunk(i);
      for (const value of chunk) { if (count > first.sampleCount - 64) tailEnergy += value * value; count++; }
    }
    assert.equal(count, first.sampleCount); assert.ok(tailEnergy > 0.5, `Converted tail survives at ${rate}Hz.`);
    const retry = await capture.prepare(); assert.equal(retry.sampleCount, first.sampleCount);
    await capture.release();
  }
  const damaged = native.create(99, { mode: "synthetic", sampleRate: 16000, channels: 1 });
  await damaged.start(); damaged.feed(new Float32Array([0.125, -0.25, 0.5])); damaged.injectError();
  assert.equal((await damaged.closeAndFence()).failed, true);
  const salvage = await damaged.prepare(); assert.equal(salvage.sampleCount, 3);
  assert.deepEqual([...damaged.readPreparedChunk(0)], [0.125, -0.25, 0.5]); await damaged.release();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RecordingCoordinator } from "../src/core/recording.js";
import type { CapturedHandle, PreparedAudio, RecoveryToken, WorkContext } from "../src/core/recording.js";
import { PrivateAudioRecovery, RecoveryError, recoveryWavHeader } from "../src/workers/recovery.js";

function context(attempt = 1): WorkContext { return { generation: 1, attempt, signal: new AbortController().signal }; }
function audio(ctx: WorkContext = context()): PreparedAudio {
  const chunks = [new Float32Array([0, -0, 0.25, -0.5]), new Float32Array(4097).fill(0.125)];
  return { generation: ctx.generation, attempt: ctx.attempt, sampleRate: 16000,
    sampleCount: 4101, chunks };
}
const filename = (root: string, token: RecoveryToken): string => join(root, `recording-${token.id}.wav`);
const code = (expected: RecoveryError["code"]) => (error: unknown): boolean =>
  error instanceof RecoveryError && error.code === expected && error.message === expected;
async function fixture<T>(run: (root: string, directory: string) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-recovery-test-")));
  const directory = join(root, "private"); await mkdir(directory, { mode: 0o700 });
  try { return await run(root, directory); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("recovery header preserves the legacy RIFF/RF64 transition without a duration cutoff", () => {
  assert.equal(recoveryWavHeader(0n).toString("hex"),
    "524946462400000057415645666d74201000000003000100803e000000fa0000040020006461746100000000");
  const last = recoveryWavHeader(1073741814n);
  assert.equal(last.length, 44); assert.equal(last.readUInt32LE(4), 4294967292);
  const first = recoveryWavHeader(1073741815n);
  assert.equal(first.length, 80); assert.equal(first.toString("ascii", 0, 4), "RF64");
  assert.equal(first.readBigUInt64LE(20), 4294967332n);
  assert.equal(first.readBigUInt64LE(28), 4294967260n);
  assert.equal(first.readBigUInt64LE(36), 1073741815n);
  const huge = recoveryWavHeader(16000n * 60n * 60n * 100000n);
  assert.equal(huge.readBigUInt64LE(36), 5760000000000n);
  assert.throws(() => recoveryWavHeader(-1n), code("INVALID_AUDIO"));
  assert.throws(() => recoveryWavHeader(1n << 64n), code("INVALID_AUDIO"));
});

test("private recovery streams exact complete samples and survives a new store instance", async () => fixture(async (_root, directory) => {
  const service = await PrivateAudioRecovery.open(directory); const original = audio();
  const saved = await service.save(original, context());
  assert.equal(saved.durable, true);
  const path = filename(directory, saved.token); const bytes = await readFile(path);
  assert.equal(bytes.length, 44 + original.sampleCount * 4);
  assert.deepEqual(bytes.subarray(0, 44), recoveryWavHeader(BigInt(original.sampleCount)));
  const stats = await lstat(path);
  assert.equal(stats.mode & 0o7777, 0o600); assert.equal(stats.uid, process.getuid?.()); assert.equal(stats.nlink, 1);
  assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
  const restarted = await PrivateAudioRecovery.open(directory);
  assert.deepEqual(await restarted.latest(), saved.token);
  const restored = await restarted.read(saved.token, context(2));
  assert.equal(restored.attempt, 2); assert.equal(restored.sampleCount, original.sampleCount);
  assert.ok(restored.chunks.every((chunk) => chunk.length <= 4096));
  assert.deepEqual(restored.chunks.flatMap((chunk) => [...chunk]), original.chunks.flatMap((chunk) => [...chunk]));
  assert.ok(Object.is(restored.chunks[0]?.[1], -0));
  await restarted.remove(saved.token, context(3)); await restarted.remove(saved.token, context(4));
  assert.deepEqual(await readdir(directory), []); assert.equal(await restarted.latest(), null);
}));

test("damaged headers, incomplete files and nonfinite backups remain intact while older audio is discoverable", async () => fixture(async (_root, directory) => {
  const service = await PrivateAudioRecovery.open(directory);
  const good = await service.save(audio(), context()); const bytes = await readFile(filename(directory, good.token));
  for (const kind of ["header", "incomplete", "nonfinite"] as const) {
    const token = { id: randomUUID() }; const bad = Buffer.from(bytes);
    if (kind === "header") bad.writeUInt16LE(1, 20);
    if (kind === "nonfinite") bad.writeFloatLE(Number.NaN, 44);
    const contents = kind === "incomplete" ? bad.subarray(0, bad.length - 1) : bad;
    await writeFile(filename(directory, token), contents, { mode: 0o600 });
    await assert.rejects(service.read(token, context()), code("INVALID_AUDIO"));
    assert.deepEqual(await service.latest(), good.token);
    assert.deepEqual(await readFile(filename(directory, token)), contents);
  }
  assert.equal((await readdir(directory)).length, 4);
}));

test("recovery rejects directory aliases, identity replacement and public permissions without repairs", async () => fixture(async (root, directory) => {
  const alias = join(root, "alias"); await symlink(directory, alias);
  await assert.rejects(PrivateAudioRecovery.open(alias), code("UNSAFE_STORAGE"));
  await chmod(directory, 0o755);
  await assert.rejects(PrivateAudioRecovery.open(directory), code("UNSAFE_STORAGE"));
  assert.equal((await lstat(directory)).mode & 0o7777, 0o755);
  await chmod(directory, 0o700);
  const service = await PrivateAudioRecovery.open(directory);
  await rename(directory, join(root, "displaced")); await mkdir(directory, { mode: 0o700 });
  await assert.rejects(service.save(audio(), context()), code("UNSAFE_STORAGE"));
  await assert.rejects(service.latest(), code("UNSAFE_STORAGE"));
  assert.deepEqual(await readdir(directory), []);
}));

test("opaque recovery tokens cannot select paths, symlinks, hardlinks or blocking FIFOs", async () => fixture(async (root, directory) => {
  const service = await PrivateAudioRecovery.open(directory);
  const sentinel = join(root, "sentinel"); await writeFile(sentinel, "Owned unchanged sentinel", { mode: 0o600 });
  const alias = { id: randomUUID() }; await symlink(sentinel, filename(directory, alias));
  await assert.rejects(service.read(alias, context()), code("INVALID_AUDIO"));
  await assert.rejects(service.remove(alias, context()), code("UNSAFE_STORAGE"));
  assert.equal(await readFile(sentinel, "utf8"), "Owned unchanged sentinel");
  const saved = await service.save(audio(), context());
  const hard = { id: randomUUID() }; await link(filename(directory, saved.token), filename(directory, hard));
  await assert.rejects(service.read(hard, context()), code("INVALID_AUDIO"));
  await assert.rejects(service.remove(hard, context()), code("UNSAFE_STORAGE"));
  const fifo = { id: randomUUID() }; await promisify(execFile)("mkfifo", ["-m", "600", filename(directory, fifo)]);
  await assert.rejects(service.read(fifo, context()), code("INVALID_AUDIO"));
  for (const id of ["../sentinel", sentinel, `${randomUUID()}/extra`, ""]) {
    await assert.rejects(service.read({ id }, context()), code("INVALID_AUDIO"));
    await assert.rejects(service.remove({ id }, context()), code("INVALID_AUDIO"));
  }
  assert.equal((await readdir(directory)).length, 4);
}));

test("write or file-sync failures before rename preserve RAM and leave no committed record", async () => fixture(async (_root, directory) => {
  const original = audio(); const before = original.chunks.flatMap((chunk) => [...chunk]);
  for (const phase of ["write", "sync"] as const) {
    let writes = 0;
    const service = await PrivateAudioRecovery.open(directory, phase === "write" ? {
      async write(file, bytes) { if (++writes > 1) throw new Error("Synthetic private ENOSPC detail"); await file.writeFile(bytes); },
    } : { async syncFile() { throw new Error("Synthetic private file-sync detail"); } });
    await assert.rejects(service.save(original, context()), code("STORAGE_FAILED"));
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(original.chunks.flatMap((chunk) => [...chunk]), before);
  }
  const service = await PrivateAudioRecovery.open(directory);
  await assert.rejects(service.save({ ...original, sampleCount: original.sampleCount + 1 }, context()), code("INVALID_AUDIO"));
  await assert.rejects(service.save({ ...original, chunks: [new Float32Array([Infinity])], sampleCount: 1 }, context()), code("INVALID_AUDIO"));
  assert.deepEqual(await readdir(directory), []);
}));

test("postrename failure and cancellation return the owned token and retry durability without rewriting", async () => fixture(async (_root, directory) => {
  const controller = new AbortController(); const first: WorkContext = { generation: 1, attempt: 1, signal: controller.signal };
  let failing = true; let writes = 0;
  const service = await PrivateAudioRecovery.open(directory, {
    async write(file, bytes) { writes++; await file.writeFile(bytes); },
    async syncDirectory(file) {
      if (failing) { controller.abort(); throw new Error("Synthetic private directory-sync detail"); }
      await file.sync();
    },
  });
  const saved = await service.save(audio(first), first);
  assert.equal(saved.durable, false); assert.equal(controller.signal.aborted, true);
  assert.equal((await readdir(directory)).length, 1);
  const before = await readFile(filename(directory, saved.token)); const originalWrites = writes;
  await assert.rejects(service.read(saved.token, first), code("CANCELLED"));
  failing = false;
  const confirmed = await service.ensureCommitted(saved.token, context(2));
  assert.equal(confirmed.durable, true); assert.deepEqual(confirmed.token, saved.token);
  assert.equal(writes, originalWrites); assert.deepEqual(await readFile(filename(directory, saved.token)), before);
  assert.equal((await service.read(saved.token, context(2))).sampleCount, 4101);
  await service.remove(saved.token, context(3));
  assert.deepEqual(await readdir(directory), []);
}));

test("cancellation before rename leaves no record and deletion retries never recreate audio", async () => fixture(async (_root, directory) => {
  const controller = new AbortController(); const ctx: WorkContext = { generation: 1, attempt: 1, signal: controller.signal };
  const cancelled = await PrivateAudioRecovery.open(directory, {
    async syncFile(file) { await file.sync(); controller.abort(); },
  });
  await assert.rejects(cancelled.save(audio(ctx), ctx), code("CANCELLED"));
  assert.deepEqual(await readdir(directory), []);
  let failDeletion = false;
  const service = await PrivateAudioRecovery.open(directory, {
    async syncDirectory(file) { if (failDeletion) throw new Error("Synthetic unlink-sync failure"); await file.sync(); },
  });
  const saved = await service.save(audio(), context()); failDeletion = true;
  await assert.rejects(service.remove(saved.token, context()), code("STORAGE_FAILED"));
  assert.deepEqual(await readdir(directory), []);
  failDeletion = false; await service.remove(saved.token, context(2));
  assert.deepEqual(await readdir(directory), []);
}));

test("the real recovery adapter prevents inference until the same postcommit record is durable", async () => fixture(async (_root, directory) => {
  let failSync = true; let inference = 0; let delivery = 0;
  const recovery = await PrivateAudioRecovery.open(directory, {
    async syncDirectory(file) {
      // Start's empty recovery discovery remains independently runnable.
      if (failSync && (await readdir(directory)).length) throw new Error("Synthetic postcommit failure");
      await file.sync();
    },
  });
  const coordinator = new RecordingCoordinator<CapturedHandle>({
    platform: "linux", recovery, clock: { now: () => 0 },
    capture: { create(callbacks) { return {
      async start() {},
      async closeAndFence() { return { generation: callbacks.generation, streamClosed: true,
        finalSamplesFenced: true, error: null, captured: { generation: callbacks.generation } }; },
      async prepare(_captured, ctx) { return audio(ctx); },
    }; } },
    speech: { async transcribe(_audio, _request, ctx) { inference++; return { generation: ctx.generation, attempt: ctx.attempt, text: "Owned complete text" }; } },
    delivery: { async deliver(_text, ctx) { delivery++; return { generation: ctx.generation, attempt: ctx.attempt,
      outcome: "clipboard", clipboardConfirmed: true }; } },
  });
  await coordinator.start({ model: { path: "/owned/fixture.bin", family: "whisper", gpu: false }, language: "de", vocabulary: "" });
  await coordinator.stop(); await coordinator.completion();
  assert.equal(coordinator.snapshot().error, "RECOVERY_SAVE_FAILED");
  assert.equal(inference, 0); assert.equal(delivery, 0);
  const names = await readdir(directory); assert.equal(names.length, 1);
  failSync = false; coordinator.retry(); await coordinator.completion();
  assert.equal(coordinator.snapshot().phase, "done"); assert.equal(inference, 1); assert.equal(delivery, 1);
  assert.deepEqual(await readdir(directory), []);
}));

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadNativeMacCapture } from "../../src/workers/native-macos-capture.js";
import type { MacCaptureSession } from "../../src/workers/native-macos-capture.js";
import { caseSchema, resultSchema } from "./contracts.js";
import type { CaptureCase, CaptureResult } from "./contracts.js";

function untouched(session: MacCaptureSession): void {
  const metadata = session.diagnostics();
  assert.equal(metadata.engineAllocations, 0); assert.equal(metadata.inputNodeOperations, 0);
  assert.equal(metadata.permissionQueries, 0); assert.equal(metadata.permissionRequests, 0); assert.equal(metadata.diskOperations, 0);
}
function pcm(frames: number, channels = 1, phase = 0): Float32Array {
  const samples = new Float32Array(frames * channels);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    samples[frame * channels + channel] = Math.sin((frame + phase) * 0.021 + channel * 0.4) * 0.2;
  }
  return samples;
}
function read(session: MacCaptureSession, chunks: number, reference: boolean): Float32Array[] {
  return Array.from({ length: chunks }, (_, index) => reference ? session.readReferenceChunk(index) : session.readPreparedChunk(index));
}
function digest(chunks: readonly Float32Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  return hash.digest("hex");
}
function compare(actual: readonly Float32Array[], expected: readonly Float32Array[]): number {
  assert.equal(actual.reduce((total, part) => total + part.length, 0), expected.reduce((total, part) => total + part.length, 0));
  let part = 0, offset = 0, difference = 0;
  for (const chunk of actual) for (const value of chunk) {
    let target = expected[part]; assert.ok(target);
    if (offset === target.length) { part++; offset = 0; target = expected[part]; assert.ok(target); }
    const sample = target[offset++]; assert.notEqual(sample, undefined);
    difference = Math.max(difference, Math.abs(value - (sample ?? Number.NaN)));
  }
  // Both paths use Apple's converter with identical defaults and ordered PCM. A small
  // numerical tolerance allows output-buffer-size differences, but not omitted tails.
  assert.ok(difference <= 0.000002, "Independent Apple conversion differs.");
  return difference;
}
function report(name: CaptureCase["name"], session: MacCaptureSession, samples = 0, hash: string | null = null,
  referenceSamples = 0, maximumDifference = 0): CaptureCase {
  untouched(session); const status = session.status();
  return caseSchema.parse({ name, frames: Number(status.frameCount), samples, sha256: hash, referenceSamples,
    maximumDifference, engineAllocations: 0, inputNodeOperations: 0, permissionQueries: 0, permissionRequests: 0, diskOperations: 0 });
}
async function conversion(name: CaptureCase["name"], session: MacCaptureSession): Promise<CaptureCase> {
  const stopped = await session.closeAndFence();
  assert.equal(stopped.streamClosed, true); assert.equal(stopped.finalSamplesFenced, true);
  assert.equal(session.diagnostics().activeCallbacks, 0);
  const prepared = await session.prepare(), reference = await session.reference();
  assert.equal(prepared.sampleCount, reference.sampleCount);
  const chunks = read(session, prepared.chunkCount, false), expected = read(session, reference.chunkCount, true);
  assert.equal(chunks.reduce((total, part) => total + part.length, 0), prepared.sampleCount);
  const result = report(name, session, prepared.sampleCount, digest(chunks), reference.sampleCount, compare(chunks, expected));
  await session.release(); await session.release(); assert.equal(session.diagnostics().released, true); untouched(session);
  return result;
}

/** Runs only inside an explicitly created Electron utility on an owned CI Apple VM.
 * Generated PCM represents duration; this is neither wall-clock microphone capture nor TCC acceptance. */
export async function probeMacCapture(binding: string, progress: (phase: CaptureCase["name"]) => void = () => {}): Promise<CaptureResult> {
  const native = loadNativeMacCapture(binding); const cases: CaptureCase[] = [];
  let generation = 0;
  const create = (sampleRate = 16000, channels = 1): MacCaptureSession => native.create(++generation, { mode: "synthetic", sampleRate, channels });

  progress("identity-tail"); const identity = create(); untouched(identity); await identity.start();
  const input = pcm(32_003); input.set(new Float32Array(17).fill(0.75), input.length - 17);
  for (let offset = 0; offset < input.length; offset += 997) identity.feed(input.slice(offset, offset + 997));
  assert.equal(identity.status().frameCount, String(input.length));
  const identityResult = await conversion("identity-tail", identity);
  assert.equal(identityResult.samples, input.length); assert.equal(identityResult.sha256, digest([input])); cases.push(identityResult);

  progress("format-transition"); const transition = create(48000, 2); await transition.start();
  for (const [rate, channels, interleaved, frames] of [[48000, 2, true, 48_017], [44100, 2, false, 44_117],
    [16000, 1, false, 16_017]] as const) {
    const samples = pcm(frames, channels); samples.fill(0.5, samples.length - 17 * channels);
    for (let frame = 0; frame < frames; frame += 1021) await transition.feedFormat(samples.slice(frame * channels, Math.min(frame + 1021, frames) * channels),
      { sampleRate: rate, channels, interleaved });
  }
  assert.equal(transition.status().frameCount, "108151");
  const formatResult = await conversion("format-transition", transition); assert.ok(formatResult.samples >= 48_000); cases.push(formatResult);

  progress("long-ledger"); const long = create(48000); await long.start();
  for (let second = 0; second < 305; second++) await long.feedFormat(pcm(48000, 1, second * 48000),
    { sampleRate: 48000, channels: 1, interleaved: false });
  await long.feedFormat(new Float32Array(17).fill(0.75), { sampleRate: 48000, channels: 1, interleaved: false });
  assert.equal(long.status().running, true); assert.equal(long.status().frameCount, "14640017");
  const longResult = await conversion("long-ledger", long); assert.ok(longResult.samples >= 4_880_000); cases.push(longResult);

  progress("held-callback"); const held = create(); await held.start(); held.holdCallback(true);
  const accepted = held.feedFormat(pcm(997), { sampleRate: 16000, channels: 1, interleaved: false });
  const deadline = performance.now() + 3000;
  while (held.diagnostics().activeCallbacks !== 1 && performance.now() < deadline) await delay(5);
  assert.equal(held.diagnostics().activeCallbacks, 1);
  let acknowledged = false;
  const closing = held.closeAndFence().then((value) => { acknowledged = true; return value; });
  await delay(25); assert.equal(acknowledged, false); assert.equal(held.status().finalSamplesFenced, false);
  held.holdCallback(false); await accepted; const fenced = await closing;
  assert.equal(fenced.finalSamplesFenced, true); assert.equal(fenced.frameCount, "997");
  held.feed(pcm(100)); assert.equal(held.status().frameCount, "997"); cases.push(await conversion("held-callback", held));

  progress("cancel-race"); let acceptedFrames = 0;
  for (let round = 0; round < 50; round++) {
    const prior = create(); await prior.start();
    const feed = prior.feedFormat(pcm(127), { sampleRate: 16000, channels: 1, interleaved: false });
    prior.abortStart(); await prior.closeAndFence(); await feed;
    const count = Number(prior.status().frameCount); assert.ok(count === 0 || count === 127); acceptedFrames += count;
    const next = create(); await next.start(); next.feed(pcm(17));
    prior.feed(pcm(511)); assert.equal(prior.status().frameCount, String(count)); assert.equal(next.status().frameCount, "17");
    await prior.release(); await next.closeAndFence(); await next.release(); untouched(prior); untouched(next);
  }
  const race = create(); await race.start(); await race.closeAndFence();
  cases.push(report("cancel-race", race, acceptedFrames)); await race.release();

  progress("allocation-failure"); const allocation = create(); allocation.failNextQueue(); await assert.rejects(allocation.start());
  assert.equal(allocation.status().running, false); assert.equal(allocation.status().failed, false); untouched(allocation);
  await allocation.start(); allocation.feed(pcm(4096)); allocation.failNextCopy(); allocation.feed(pcm(127));
  assert.equal(allocation.status().failed, true); assert.equal(allocation.status().failureKind, "allocation");
  assert.equal(allocation.status().frameCount, "4096");
  const failedFence = await allocation.closeAndFence(); assert.equal(failedFence.failed, true); assert.equal(failedFence.finalSamplesFenced, true);
  allocation.failNextQueue(); await assert.rejects(allocation.prepare()); assert.equal(allocation.status().frameCount, "4096");
  const allocationResult = await conversion("allocation-failure", allocation); assert.equal(allocationResult.samples, 4096); cases.push(allocationResult);

  progress("interruption"); const interrupted = create(); await interrupted.start(); interrupted.feed(pcm(1001)); interrupted.injectError();
  const interruptionFence = await interrupted.closeAndFence(); assert.equal(interruptionFence.failed, true);
  assert.equal(interruptionFence.failureKind, "interrupted"); cases.push(await conversion("interruption", interrupted));

  progress("start-rollback"); const rollback = create(); rollback.abortStart(); await assert.rejects(rollback.start());
  assert.equal(rollback.status().running, false); assert.equal(rollback.status().streamClosed, true);
  assert.equal(rollback.status().failed, true); cases.push(report("start-rollback", rollback)); await rollback.release();
  progress("exceptions"); assert.deepEqual(native.exceptionProbe(), { startExceptionContained: true, stopExceptionContained: true,
    stopAttemptedAfterRemovalException: true, engineStopExceptionContained: true });
  const exceptions = create(); await exceptions.closeAndFence(); cases.push(report("exceptions", exceptions)); await exceptions.release();

  return resultSchema.parse({ fixture: "macos-capture-result", platform: process.platform, architecture: process.arch, pid: process.pid,
    nativeScope: "synthetic-pcm-only", cases, noEngineOrPermissionOperations: true, noMacAudioDiskRetention: true,
    durationRepresentedSeconds: 305, longInputFrames: 14_640_017 });
}

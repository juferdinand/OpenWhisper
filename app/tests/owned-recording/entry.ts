import type {} from "electron";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RecordingCoordinator } from "../../src/core/recording/recording.js";
import type { PreparedAudio, RecoveryBoundary, RecoveryToken, WorkContext } from "../../src/core/recording/recording.js";
import { AdaptiveSpeechBoundary, createUtilitySpeechEffects } from "../../src/services/speech/adaptive-speech.js";
import { NativeCaptureBoundary } from "../../src/services/recording/capture.js";
import type { NativeCapturedHandle } from "../../src/services/recording/capture.js";
import { loadNativeCapture } from "../../src/workers/recording/native-capture.js";
import type { NativeCaptureSession } from "../../src/workers/recording/native-capture.js";
import { WorkerRecordingEffects } from "../../src/workers/recording/recording-effects.js";
import { PrivateAudioRecovery } from "../../src/workers/recording/recovery.js";
import { LinuxSpeechGate } from "../../src/workers/speech/speech-gate.js";
import { EXPANSION, MODEL, SAMPLE_COUNT, modeSchema, phaseSchema, readySchema, resultSchema, runSchema } from "./contracts.js";

const epoch = z.string().uuid().parse(process.argv[2]);
const mode = modeSchema.parse(process.argv[3]);
const recoveryPath = z.string().regex(/^\/tmp\/openwhisper-owned-recording-[A-Za-z0-9]+\/dev-profile\/data\/recovery$/)
  .parse(process.argv[4]);
const port = process.parentPort;
if (!port || process.platform !== "linux" || process.getuid?.() !== 1000) process.exit(1);
const messages = new Set<(input: unknown) => void>();
const exits = new Set<() => void>();
const rpc = new WorkerRecordingEffects({
  send: (request) => { port.postMessage(request); },
  onMessage: (listener) => { messages.add(listener); return () => { messages.delete(listener); }; },
  onExit: (listener) => { exits.add(listener); return () => { exits.delete(listener); }; },
}, epoch);
process.once("exit", () => { for (const listener of exits) listener(); });
let started = false;
port.on("message", (event) => {
  const input: unknown = event.data;
  if (runSchema.safeParse(input).success && !started) {
    started = true;
    void run().catch(() => { process.exit(1); });
  } else for (const listener of messages) listener(input);
});
port.postMessage(readySchema.parse({ fixture: "recording-ready", pid: process.pid }));

function phase(value: unknown): void { port.postMessage(phaseSchema.parse(value)); }
function hashAudio(audio: PreparedAudio): string {
  const hash = createHash("sha256");
  for (const chunk of audio.chunks) hash.update(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  return hash.digest("hex");
}
async function fixtureAudio(): Promise<Float32Array> {
  const bytes = await readFile("/fixtures/jfk.f32");
  assert.equal(bytes.byteLength, 704_000);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0");
  const input = new Float32Array(SAMPLE_COUNT);
  for (let repeat = 0; repeat < 3; repeat++) for (let index = 0; index < 176_000; index++) {
    input[repeat * 176_000 + index] = bytes.readFloatLE(index * 4);
  }
  for (let index = 528_000; index < SAMPLE_COUNT; index++) input[index] = index % 2 === 0 ? 0.125 : -0.125;
  return input;
}
async function run(): Promise<void> {
  const input = await fixtureAudio();
  const expectedHash = createHash("sha256").update(Buffer.from(input.buffer)).digest("hex");
  let stopAck = false, captureCreates = 0, released = false;
  let nativeSession: NativeCaptureSession | undefined;
  const native = mode === "capture-fail" ? loadNativeCapture("/owned-app/dist/native/openwhisper_capture.node") : undefined;
  const boundary = native ? new NativeCaptureBoundary({ create(generation, selection) {
    captureCreates++;
    const owned = native.create(generation, selection);
    nativeSession = owned;
    return Object.freeze({ ...owned, release: async () => { const value = await owned.release(); released = true; return value; } });
  } }, { mode: "synthetic", sampleRate: 16000, channels: 1 }) : undefined;
  const stored = await PrivateAudioRecovery.open(recoveryPath);
  const inspect = async (token: RecoveryToken, restored: boolean): Promise<void> => {
    const directory = await lstat(recoveryPath);
    const path = join(recoveryPath, `recording-${token.id}.wav`);
    const status = await lstat(path);
    assert.ok(status.isFile() && !status.isSymbolicLink());
    assert.equal(status.uid, 1000); assert.equal(status.nlink, 1); assert.equal(status.mode & 0o7777, 0o600);
    assert.equal(directory.mode & 0o7777, 0o700);
    const bytes = await readFile(path);
    assert.equal(bytes.length, SAMPLE_COUNT * 4 + 44);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.readUInt16LE(20), 3); assert.equal(bytes.readUInt32LE(24), 16000);
    assert.equal(bytes.readUInt32LE(40), SAMPLE_COUNT * 4);
    assert.equal(createHash("sha256").update(bytes.subarray(44)).digest("hex"), expectedHash);
    phase({ fixture: "recording-phase", phase: "recovery", token: token.id,
      sha256: createHash("sha256").update(bytes).digest("hex"), samples: SAMPLE_COUNT,
      bytes: bytes.length, fileMode: 0o600, directoryMode: 0o700, restored, captureCreates });
  };
  const validate = (audio: PreparedAudio): void => {
    assert.equal(audio.sampleCount, SAMPLE_COUNT);
    assert.equal(audio.chunks.reduce((total, chunk) => total + chunk.length, 0), SAMPLE_COUNT);
    assert.equal(hashAudio(audio), expectedHash);
  };
  const recovery: RecoveryBoundary = {
    latest: () => stored.latest(),
    save: async (audio, context) => {
      validate(audio);
      const result = await stored.save(audio, context);
      assert.notEqual(result.durable, false);
      await inspect(result.token, false);
      return result;
    },
    read: async (token, context) => {
      const audio = await stored.read(token, context);
      validate(audio); await inspect(token, true); return audio;
    },
    remove: (token, context) => stored.remove(token, context),
    ensureCommitted: (token, context) => stored.ensureCommitted(token, context),
  };
  const request = { model: { path: MODEL, family: "whisper" as const, gpu: false }, language: "en" as const,
    vocabulary: "COUNTRI", snippets: [{ id: "owned-fixture", trigger: "COUNTRI", expansion: EXPANSION, enabled: true }] };
  const coordinator = new RecordingCoordinator<NativeCapturedHandle>({ platform: "linux", recovery,
    capture: { create(callbacks) {
      if (!boundary) { captureCreates++; throw new Error("Restore must never create capture."); }
      const owned = boundary.create(callbacks);
      return {
        start: (signal) => owned.start(signal), closeAndFence: () => owned.closeAndFence(), release: () => owned.release(),
        prepare: async (handle, context) => {
          assert.equal(stopAck, true);
          assert.equal(nativeSession?.status().streamClosed, true);
          assert.equal(nativeSession?.status().finalSamplesFenced, true);
          const audio = await owned.prepare(handle, context); validate(audio);
          phase({ fixture: "recording-phase", phase: "prepared", sampleCount: SAMPLE_COUNT, chunkSamples: SAMPLE_COUNT,
            sha256: expectedHash, afterStopAck: true, fenced: true }); return audio;
        },
      };
    } }, clock: { now: () => performance.now() }, delivery: rpc.delivery, speechGate: new LinuxSpeechGate(),
    speech: { transcribe: async (audio, selected, context) => {
      validate(audio);
      const wire = rpc.infer(context);
      let firstWindow = true;
      const infer = { transcribeWindow: async (...arguments_: Parameters<typeof wire.transcribeWindow>) => {
        const [model, samples, language, vocabulary, signal] = arguments_;
        if (!firstWindow) return wire.transcribeWindow(model, samples, language, vocabulary, signal);
        firstWindow = false;
        const backing = new ArrayBuffer(16 * 1024 * 1024);
        const offsetView = new Float32Array(backing, 128, samples.length);
        offsetView.set(samples);
        assert.equal(createHash("sha256").update(Buffer.from(offsetView.buffer, offsetView.byteOffset, offsetView.byteLength)).digest("hex"),
          createHash("sha256").update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)).digest("hex"));
        phase({ fixture: "recording-phase", phase: "overbacked-source", backingBytes: backing.byteLength,
          byteOffset: offsetView.byteOffset, samples: offsetView.length, samplesCopiedExactly: true });
        return wire.transcribeWindow(model, offsetView, language, vocabulary, signal);
      } };
      const effects = createUtilitySpeechEffects({ gpuAvailable: false, infer,
        progress: (progress) => phase({ fixture: "recording-phase", phase: "progress", completedSamples: progress.completedSamples }) });
      const adaptive = new AdaptiveSpeechBoundary({ ...effects,
        read: async (all, range, owner) => {
          const value = await effects.read(all, range, owner);
          phase({ fixture: "recording-phase", phase: "window", start: range.start, end: range.end,
            samples: range.end - range.start }); return value;
        },
        process: async (parts, selectedRequest, owner) => {
          // A fixture marker proves cleaner -> vocabulary -> snippets without changing the native transcript.
          const value = z.strictObject({ generation: z.number(), attempt: z.number(), text: z.string() })
            .parse(await effects.process(["[Music]", ...parts], selectedRequest, owner));
          assert.ok(value.text.includes(EXPANSION)); assert.ok(!/countri/iu.test(value.text));
          assert.ok(!value.text.includes("[Music]"));
          phase({ fixture: "recording-phase", phase: "processed", sha256: createHash("sha256").update(value.text).digest("hex"),
            characters: value.text.length, vocabularyThenSnippet: true, cleanupApplied: true }); return value;
        },
      });
      return adaptive.transcribe(audio, selected, context);
    } },
  });
  if (mode === "capture-fail") {
    assert.equal((await coordinator.start(request)).ok, true);
    assert.ok(nativeSession);
    for (let offset = 0; offset < input.length; offset += 997) nativeSession.feed(input.slice(offset, Math.min(offset + 997, input.length)));
    assert.equal(nativeSession.status().frameCount, String(SAMPLE_COUNT));
    const stopped = await coordinator.stop((reply) => {
      assert.equal(reply.ok, true); assert.equal(nativeSession?.status().finalSamplesFenced, true);
      stopAck = true; return true;
    });
    assert.equal(stopped.ok, true);
  } else {
    assert.equal(await coordinator.restoreRecovery(request), true);
    assert.equal(captureCreates, 0); assert.equal(coordinator.retry().ok, true);
  }
  const snapshot = await coordinator.completion();
  assert.equal(snapshot.phase, mode === "capture-fail" ? "error" : "done");
  assert.equal(snapshot.error, mode === "capture-fail" ? "DELIVERY_FAILED" : null);
  assert.equal(snapshot.recoveryAvailable, mode === "capture-fail");
  const maps = await readFile(`/proc/${process.pid}/maps`, "utf8");
  await rpc.close();
  port.postMessage(resultSchema.parse({ fixture: "recording-result", mode, pid: process.pid,
    phase: snapshot.phase, error: snapshot.error, recoveryAvailable: snapshot.recoveryAvailable,
    captureCreates, sampleCount: SAMPLE_COUNT, nativeCaptureLoaded: maps.includes("openwhisper_capture.node"),
    nativeSpeechLoaded: maps.includes("openwhisper_speech.node"), stopAckBeforePrepare: stopAck,
    rawLedgerReleased: released, transcriptSha256: createHash("sha256").update(snapshot.transcript).digest("hex"),
    transcriptCharacters: snapshot.transcript.length }));
}

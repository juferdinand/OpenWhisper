import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { executeSpeechRequest, speechReplySchema, speechRequestSchema } from "../../src/workers/speech-protocol.js";
import type { NativeSpeech } from "../../src/workers/native-speech.js";

test("speech protocol validates both directions and contains private native failures", () => {
  const id = randomUUID();
  let calls = 0;
  const native: NativeSpeech = {
    gpuDevice: () => null,
    load: () => { calls += 1; throw new Error("Private model path and prompt must not escape."); },
    transcribe: () => "never", shutdown: () => {},
  };
  const valid = { version: 1, id, command: "transcribe", model: { path: "/owned/model.bin", family: "whisper", gpu: false },
    samples: new Float32Array([0.5]), language: "de", vocabulary: "Grüß Gott" };
  assert.equal(speechRequestSchema.safeParse({ ...valid, extra: "authority" }).success, false);
  assert.throws(() => executeSpeechRequest(native, { ...valid, samples: new Float32Array([Infinity]) }));
  assert.equal(calls, 0);
  const reply = executeSpeechRequest(native, valid);
  assert.deepEqual(reply, { version: 1, id, ok: false, code: "NATIVE_FAILED" });
  assert.equal(speechReplySchema.safeParse({ ...reply, private: "details" }).success, false);
});

test("speech protocol pads only short inference windows and preserves all supplied samples", () => {
  const samples = new Float32Array([0.25, -0.5, 0.125]);
  const native: NativeSpeech = {
    gpuDevice: () => null, load: () => {}, shutdown: () => {},
    transcribe: (input, language, vocabulary) => {
      assert.equal(input.length, 16000);
      assert.deepEqual(input.slice(0, samples.length), samples);
      assert.ok(input.slice(samples.length).every((value) => value === 0));
      assert.equal(language, "de"); assert.equal(vocabulary, "Tokyo 東京");
      return "Café 東京";
    },
  };
  const reply = executeSpeechRequest(native, { version: 1, id: randomUUID(), command: "transcribe",
    model: { path: "/owned/model.bin", family: "parakeet", gpu: false }, samples,
    language: "de", vocabulary: "Tokyo 東京" });
  assert.ok(reply.ok && reply.value.command === "transcribe");
  assert.equal(reply.value.text, "Café 東京");
  assert.equal(samples.length, 3);
});

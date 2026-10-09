import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { PreparedAudio, WorkContext } from "../../src/core/recording/recording.js";
import { LinuxSpeechGate } from "../../src/workers/speech/speech-gate.js";

function context(signal = new AbortController().signal): WorkContext {
  return { generation: 7, attempt: 3, signal };
}
function audio(chunks: readonly Float32Array[]): PreparedAudio {
  return { generation: 7, attempt: 3, sampleRate: 16000,
    sampleCount: chunks.reduce((sum, chunk) => sum + chunk.length, 0), chunks };
}

test("Linux speech gate applies the exact sample and Float32 energy thresholds", async () => {
  const gate = new LinuxSpeechGate();
  for (const [count, amplitude, expected] of [
    [0, 0, false], [3199, 1, false], [3200, 0, false],
    [3200, 0.00049999997, false], [3200, 0.0005, true], [3200, -0.0005, true],
  ] as const) {
    const result = await gate.classify(audio([new Float32Array(count).fill(amplitude)]), context());
    assert.deepEqual(result, { generation: 7, attempt: 3, hasSpeech: expected });
  }
  // A single loud sample does not satisfy the mean-square threshold for this whole recording.
  const sparse = new Float32Array(16000); sparse[0] = 0.01;
  assert.equal((await gate.classify(audio([sparse]), context())).hasSpeech, false);
});

test("Linux gate validates finite samples, complete counts, ownership and exclusive buffers", async () => {
  const gate = new LinuxSpeechGate();
  const inputs = [
    audio([new Float32Array([Number.NaN])]), audio([new Float32Array([Number.POSITIVE_INFINITY])]),
    { ...audio([new Float32Array(3200)]), sampleCount: 3199 },
    { ...audio([new Float32Array(3200)]), attempt: 4 },
    audio([new Float32Array(new SharedArrayBuffer(12800))]),
  ];
  for (const input of inputs) await assert.rejects(gate.classify(input, context()), /PREPARATION_FAILED/);
});

test("Linux gate yields and observes cancellation during a complete long ledger without modifying samples", async () => {
  const chunk = new Float32Array(16000).fill(0.25);
  const input = audio(Array.from({ length: 3601 }, () => chunk));
  const controller = new AbortController();
  const classification = new LinuxSpeechGate().classify(input, context(controller.signal));
  await setImmediate(); controller.abort();
  await assert.rejects(classification, /CANCELLED/);
  assert.equal(input.sampleCount, 57_616_000); assert.equal(chunk[0], 0.25); assert.equal(chunk.at(-1), 0.25);
});

test("Linux whole-recording classification preserves chunk boundaries and evaluates a complete long ledger", async () => {
  const second = new Float32Array(16000).fill(0.01); const tail = new Float32Array([0, -0.02, 0.02]);
  const input = audio([...Array.from({ length: 3601 }, () => second), tail]);
  const result = await new LinuxSpeechGate().classify(input, context());
  assert.equal(result.hasSpeech, true); assert.equal(input.sampleCount, 57_616_003);
  assert.strictEqual(input.chunks.at(-1), tail); assert.deepEqual([...tail], [0, Math.fround(-0.02), Math.fround(0.02)]);
});

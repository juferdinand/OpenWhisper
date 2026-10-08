import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { z } from "zod";
import { speechModelSchema, speechWindowSchema, speechLanguageSchema } from "../src/workers/native-speech.js";
import { recordingRequestSchema } from "../src/core/recording.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("native speech boundary refuses malformed models, nonfinite and oversized windows", () => {
  assert.equal(speechModelSchema.safeParse({ path: "relative.bin", family: "whisper", gpu: false }).success, false);
  assert.equal(speechModelSchema.safeParse({ path: "/owned/model.bin", family: "other", gpu: false }).success, false);
  assert.equal(speechWindowSchema.safeParse(new Float32Array([NaN])).success, false);
  assert.equal(speechWindowSchema.safeParse(new Float32Array(30 * 16000 + 1)).success, false);
  assert.equal(speechWindowSchema.safeParse(new Float32Array(new SharedArrayBuffer(4))).success, false);
  assert.equal(speechWindowSchema.safeParse(new Float32Array([0, -0.25, 0.5])).success, true);
  assert.equal(speechLanguageSchema.parse("yue"), "yue");
  assert.equal(recordingRequestSchema.parse({ model: { path: "/owned/model.bin", family: "whisper", gpu: false },
    language: "yue", vocabulary: "" }).language, "yue");
  assert.equal(speechLanguageSchema.safeParse("eng").success, false);
});

test("disposable native CPU probe recognizes the public fixture twice and releases its context", {
  skip: !process.env.OPENWHISPER_NATIVE_TEST_MODEL || !process.env.OPENWHISPER_NATIVE_TEST_AUDIO,
  timeout: 120_000,
}, async () => {
  const model = process.env.OPENWHISPER_NATIVE_TEST_MODEL;
  const audio = process.env.OPENWHISPER_NATIVE_TEST_AUDIO;
  assert.ok(model && audio);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx",
    join(root, "tests/fixtures/native-speech.ts"), join(root, "native/build/openwhisper_speech.node"), model, audio], {
    cwd: root, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
  });
  const raw: unknown = JSON.parse(stdout);
  const result = z.strictObject({ gpu: z.null(), first: z.string(), second: z.string(),
    wrongFamilyRejected: z.literal(true), reloaded: z.string() }).parse(raw);
  assert.match(result.first, /country/i);
  assert.match(result.second, /country/i);
  assert.match(result.reloaded, /country/i);
  assert.equal(stderr, "", "Native requests, replies, model paths and diagnostics must not be logged.");
});

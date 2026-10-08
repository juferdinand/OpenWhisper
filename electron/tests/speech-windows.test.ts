import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { MAX_WINDOW_SAMPLES, MIN_WINDOW_SAMPLES, SAMPLE_RATE, SpeechWindowError,
  planSpeechWindow, sampleRangeSchema, selectSpeechWindow, validateSpeechWindowPlan,
} from "../src/core/speech-windows.js";

// Executed against the unchanged Rust chunks.rs, including odd maxima and f32 energy.
// Generation/provenance is retained in the ignored p2-pipeline evidence packet.
const rustVectors = z.array(z.strictObject({
  name: z.string(), sampleCount: z.number().int().nonnegative(), start: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative(), pattern: z.enum(["constant", "pause", "varying"]),
  expected: sampleRangeSchema,
})).parse([
  { name: "empty", sampleCount: 0, start: 0, maximum: 480000, pattern: "constant", expected: { start: 0, end: 0 } },
  { name: "one", sampleCount: 1, start: 0, maximum: 480000, pattern: "constant", expected: { start: 0, end: 1 } },
  { name: "one-second", sampleCount: 16000, start: 0, maximum: 480000, pattern: "constant", expected: { start: 0, end: 16000 } },
  { name: "exact-maximum", sampleCount: 480000, start: 0, maximum: 480000, pattern: "constant", expected: { start: 0, end: 480000 } },
  { name: "just-over-maximum", sampleCount: 480001, start: 0, maximum: 480000, pattern: "constant", expected: { start: 0, end: 464001 } },
  { name: "pause", sampleCount: 976000, start: 0, maximum: 480000, pattern: "pause", expected: { start: 0, end: 447200 } },
  { name: "just-over-minimum", sampleCount: 16001, start: 0, maximum: 16000, pattern: "constant", expected: { start: 0, end: 7735 } },
  { name: "odd-maximum", sampleCount: 480001, start: 0, maximum: 100001, pattern: "constant", expected: { start: 0, end: 99335 } },
  { name: "offset-pause", sampleCount: 976000, start: 100000, maximum: 480000, pattern: "pause", expected: { start: 100000, end: 580000 } },
  { name: "varying", sampleCount: 976000, start: 12345, maximum: 120000, pattern: "varying", expected: { start: 12345, end: 129945 } },
  { name: "clamped-low", sampleCount: 40000, start: 100, maximum: 0, pattern: "varying", expected: { start: 100, end: 14234 } },
  { name: "clamped-high", sampleCount: 976000, start: 2345, maximum: 960000, pattern: "varying", expected: { start: 2345, end: 482345 } },
]);

for (const fixture of rustVectors) test(`Rust window parity: ${fixture.name}`, () => {
  const plan = planSpeechWindow(fixture.sampleCount, fixture.start, fixture.maximum);
  if (plan.kind === "tail") {
    assert.deepEqual(selectSpeechWindow(plan), fixture.expected);
    return;
  }
  const probe = new Float32Array(plan.probe.end - plan.probe.start);
  for (let i = 0; i < probe.length; i += 1) {
    const index = plan.probe.start + i;
    probe[i] = fixture.pattern === "varying" ? ((index % 97) - 48) / 100
      : fixture.pattern === "pause" && index >= 27 * SAMPLE_RATE && index < 28 * SAMPLE_RATE ? 0 : 0.2;
  }
  assert.deepEqual(selectSpeechWindow(plan, probe), fixture.expected);
});

test("all samples are covered once at original and reduced maxima through one logical hour", () => {
  for (const count of [0, 1, SAMPLE_RATE, MAX_WINDOW_SAMPLES, MAX_WINDOW_SAMPLES + 1,
    7 * 60 * SAMPLE_RATE + 17, 60 * 60 * SAMPLE_RATE + 17]) {
    for (const maximum of [MAX_WINDOW_SAMPLES, 7 * SAMPLE_RATE, MIN_WINDOW_SAMPLES]) {
      let start = 0;
      while (start < count) {
        const plan = planSpeechWindow(count, start, maximum);
        const range = selectSpeechWindow(plan, plan.kind === "search"
          ? new Float32Array(plan.probe.end - plan.probe.start).fill(0.2) : undefined);
        assert.equal(range.start, start);
        assert.ok(range.end > start && range.end - start <= maximum);
        start = range.end;
      }
      assert.equal(start, count);
    }
  }
});

test("equal silent energies prefer the latest candidate and retain the just-over-window tail", () => {
  const plan = planSpeechWindow(MAX_WINDOW_SAMPLES + 1, 0);
  assert.equal(plan.kind, "search");
  if (plan.kind !== "search") throw new Error("Expected an energy search.");
  assert.deepEqual(selectSpeechWindow(plan, new Float32Array(plan.probe.end - plan.probe.start)),
    { start: 0, end: 464001 });
  assert.ok(plan.sampleCount - plan.range.end >= MIN_WINDOW_SAMPLES);
});

test("metadata and probes stay bounded independently of whole-recording duration", () => {
  for (const count of [24 * 60 * 60 * SAMPLE_RATE, Number.MAX_SAFE_INTEGER]) {
    const start = count - 1_000_000;
    const plan = planSpeechWindow(count, start);
    assert.equal(plan.kind, "search");
    if (plan.kind !== "search") throw new Error("Expected an energy search.");
    assert.ok(plan.probe.end - plan.probe.start <= 82400);
    assert.ok(Number.isSafeInteger(plan.range.end));
    assert.deepEqual(selectSpeechWindow(plan, new Float32Array(plan.probe.end - plan.probe.start)),
      { start, end: start + MAX_WINDOW_SAMPLES });
  }
});

test("invalid, forged and nonfinite window inputs fail without exposing submitted data", () => {
  for (const [count, start, maximum] of [[NaN, 0, 1], [1, -1, 1], [1, 2, 1], [1, 0, Infinity],
    [Number.MAX_SAFE_INTEGER + 1, 0, 1], [2, 0.5, 1], [2, 0, 1.5]]) {
    assert.throws(() => planSpeechWindow(count ?? 0, start ?? 0, maximum ?? 0), SpeechWindowError);
  }
  const plan = planSpeechWindow(976000, 0);
  assert.equal(plan.kind, "search");
  if (plan.kind !== "search") throw new Error("Expected an energy search.");
  for (const malformed of [{ ...plan, extra: "private" }, { ...plan, range: { start: 0, end: 1 } },
    { ...plan, probe: { start: 0, end: 1 } }, { ...plan, firstBoundary: 0 },
    { ...plan, kind: "tail" }, { ...plan, maximum: NaN }]) {
    assert.throws(() => validateSpeechWindowPlan(malformed), SpeechWindowError);
  }
  assert.throws(() => selectSpeechWindow(plan), SpeechWindowError);
  assert.throws(() => selectSpeechWindow(plan, new Float32Array(1)), SpeechWindowError);
  const probe = new Float32Array(plan.probe.end - plan.probe.start);
  probe[0] = NaN;
  assert.throws(() => selectSpeechWindow(plan, probe), SpeechWindowError);
  probe[0] = Infinity;
  assert.throws(() => selectSpeechWindow(plan, probe), SpeechWindowError);
  assert.throws(() => selectSpeechWindow(plan,
    new Float32Array(new SharedArrayBuffer(probe.byteLength))), SpeechWindowError);
  assert.throws(() => selectSpeechWindow(planSpeechWindow(1, 0), new Float32Array(1)), SpeechWindowError);
});

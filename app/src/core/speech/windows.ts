import { z } from "zod";

export const SAMPLE_RATE = 16_000;
export const MAX_WINDOW_SAMPLES = 30 * SAMPLE_RATE;
export const MIN_WINDOW_SAMPLES = SAMPLE_RATE;
const ENERGY_WINDOW = SAMPLE_RATE / 10;
const ENERGY_STEP = ENERGY_WINDOW / 2;
const indexSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const sampleRangeSchema = z.strictObject({ start: indexSchema, end: indexSchema })
  .refine((range) => range.end >= range.start);
export type SampleRange = z.infer<typeof sampleRangeSchema>;
const common = {
  sampleCount: indexSchema, start: indexSchema,
  maximum: z.number().int().min(MIN_WINDOW_SAMPLES).max(MAX_WINDOW_SAMPLES),
  range: sampleRangeSchema,
};
export const speechWindowPlanSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("tail") }),
  z.strictObject({ ...common, kind: z.literal("search"), probe: sampleRangeSchema,
    firstBoundary: indexSchema }),
]);
export type SpeechWindowPlan = z.infer<typeof speechWindowPlanSchema>;

export class SpeechWindowError extends Error {
  constructor() { super("Invalid speech window or energy probe."); }
}

/** Metadata only. Energy selection belongs in a utility/worker, never the UI/main loop.
 * Port of linux/crates/speech/src/chunks.rs; windows do not limit recording duration. */
export function planSpeechWindow(sampleCount: number, start: number,
                                 maximum = MAX_WINDOW_SAMPLES): SpeechWindowPlan {
  if (!indexSchema.safeParse(sampleCount).success || !indexSchema.safeParse(start).success ||
      !indexSchema.safeParse(maximum).success || start > sampleCount) throw new SpeechWindowError();
  maximum = Math.max(MIN_WINDOW_SAMPLES, Math.min(MAX_WINDOW_SAMPLES, maximum));
  const remaining = sampleCount - start;
  if (remaining <= maximum) {
    return { kind: "tail", sampleCount, start, maximum, range: { start, end: sampleCount } };
  }
  const tail = Math.min(MIN_WINDOW_SAMPLES, Math.floor(maximum / 2));
  // Use the remaining count instead of start+maximum until the sum is known safe.
  const end = start + Math.min(maximum, remaining - tail);
  const search = Math.min(Math.floor(maximum / 6), 5 * SAMPLE_RATE);
  const firstBoundary = Math.max(end - search, start + ENERGY_WINDOW);
  return { kind: "search", sampleCount, start, maximum, range: { start, end },
    probe: { start: firstBoundary - ENERGY_WINDOW, end: end + ENERGY_STEP }, firstBoundary };
}

function sameRange(a: SampleRange, b: SampleRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Reject forged/outdated plans before a worker scans their bounded probe. */
export function validateSpeechWindowPlan(input: unknown): SpeechWindowPlan {
  const parsed = speechWindowPlanSchema.safeParse(input);
  if (!parsed.success) throw new SpeechWindowError();
  const plan = parsed.data;
  const expected = planSpeechWindow(plan.sampleCount, plan.start, plan.maximum);
  if (!sameRange(plan.range, expected.range) || plan.kind !== expected.kind ||
      (plan.kind === "search" && (expected.kind !== "search" ||
        !sameRange(plan.probe, expected.probe) || plan.firstBoundary !== expected.firstBoundary))) {
    throw new SpeechWindowError();
  }
  return plan;
}

/** Utility-local f64 energy policy. The probe is at most 5.15 seconds, independent of duration. */
export function selectSpeechWindow(input: unknown, probe?: Float32Array): SampleRange {
  const plan = validateSpeechWindowPlan(input);
  if (plan.kind === "tail") {
    if (probe !== undefined) throw new SpeechWindowError();
    return { ...plan.range };
  }
  if (!(probe instanceof Float32Array) || !(probe.buffer instanceof ArrayBuffer) ||
      probe.length !== plan.probe.end - plan.probe.start || !probe.every(Number.isFinite)) {
    throw new SpeechWindowError();
  }
  let bestEnd = plan.range.end;
  let bestEnergy = Infinity;
  for (let boundary = plan.firstBoundary; boundary <= plan.range.end; boundary += ENERGY_STEP) {
    let energy = 0;
    for (let index = boundary - ENERGY_WINDOW; index < boundary + ENERGY_STEP; index += 1) {
      const value = probe[index - plan.probe.start];
      if (value === undefined) throw new SpeechWindowError();
      energy += value * value;
    }
    // Rust uses <=: equal energies select the later candidate, including silence.
    if (energy <= bestEnergy) { bestEnergy = energy; bestEnd = boundary; }
  }
  return { start: plan.start, end: bestEnd };
}

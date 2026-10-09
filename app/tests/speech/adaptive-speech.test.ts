import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { z } from "zod";
import { recordingRequestSchema, type PreparedAudio, type RecordingRequest, type WorkContext } from "../../src/core/recording/recording.js";
import { MAX_WINDOW_SAMPLES, SAMPLE_RATE, planSpeechWindow, selectSpeechWindow, type SampleRange } from "../../src/core/speech/windows.js";
import { AdaptiveSpeechBoundary, AdaptiveSpeechError, createUtilitySpeechEffects, processRawSpeechParts,
  type AdaptiveSpeechEffects, type SpeechProgress } from "../../src/services/speech/adaptive-speech.js";
import { SpeechClient, SpeechWorkerError, type SpeechChannel } from "../../src/services/speech/speech-client.js";
import type { SpeechRequest } from "../../src/workers/speech/speech-protocol.js";

type Infer = AdaptiveSpeechEffects["infer"]["transcribeWindow"];
function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof AdaptiveSpeechError && error.code === expected
    && error.message === `Speech pipeline: ${expected}.`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
async function reached(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error("Expected owned synthetic stage was not reached.");
}
function fixture(count = 976000, options: { readonly gpu?: boolean; readonly gpuAvailable?: boolean;
  readonly family?: "whisper" | "parakeet"; readonly infer?: Infer; readonly chunkSize?: number } = {}) {
  const request = recordingRequestSchema.parse({ model: { path: "/owned/model.bin",
    family: options.family ?? "whisper", gpu: options.gpu ?? false }, language: "yue",
    vocabulary: "Kubernetes", snippets: [] });
  const chunks: Float32Array[] = [];
  for (let start = 0; start < count; start += options.chunkSize ?? 16384) {
    chunks.push(new Float32Array(Math.min(options.chunkSize ?? 16384, count - start)).fill(0.2));
  }
  const audio: PreparedAudio = Object.freeze({ generation: 1, attempt: 1, sampleRate: 16000,
    sampleCount: count, chunks: Object.freeze(chunks) });
  const controller = new AbortController();
  const context: WorkContext = { generation: 1, attempt: 1, signal: controller.signal };
  const plans: { start: number; maximum: number }[] = [];
  const ranges: SampleRange[] = [];
  const inference: { gpu: boolean; length: number; language: string; vocabulary: string }[] = [];
  const progress: SpeechProgress[] = [];
  const rawParts: string[][] = [];
  const base = createUtilitySpeechEffects({ gpuAvailable: options.gpuAvailable ?? false,
    infer: { transcribeWindow: async (model, samples, language, vocabulary, signal) => {
      inference.push({ gpu: model.gpu, length: samples.length, language, vocabulary });
      return options.infer ? await options.infer(model, samples, language, vocabulary, signal) : "text";
    } }, progress: (value) => { progress.push(value); } });
  const effects: AdaptiveSpeechEffects = { ...base,
    plan: async (input, start, maximum, owner) => {
      plans.push({ start, maximum }); return await base.plan(input, start, maximum, owner);
    },
    read: async (input, range, owner) => { ranges.push(range); return await base.read(input, range, owner); },
    process: async (parts, input, owner) => {
      rawParts.push([...parts]); return await base.process(parts, input, owner);
    },
  };
  return { request, audio, context, controller, plans, ranges, inference, progress, rawParts, effects };
}

test("utility reader preserves exact samples across segment partitions and returns owned copies", async () => {
  for (const chunkSize of [1, 4096, 16384, 50000]) {
    const f = fixture(60001, { chunkSize });
    let index = 0;
    for (const chunk of f.audio.chunks) for (let i = 0; i < chunk.length; i += 1) chunk[i] = (index++ % 97) / 100;
    const unknown = await f.effects.read(f.audio, { start: 16380, end: 33001 }, f.context);
    const reply = z.strictObject({ generation: z.literal(1), attempt: z.literal(1), samples: z.instanceof(Float32Array) }).parse(unknown);
    assert.equal(reply.samples.length, 16621);
    for (let i = 0; i < reply.samples.length; i += 1) assert.equal(reply.samples[i], Math.fround(((16380 + i) % 97) / 100));
    assert.ok(f.audio.chunks.every((chunk) => chunk.buffer !== reply.samples.buffer));
    reply.samples.fill(0);
    assert.equal(f.audio.chunks[Math.floor(16380 / chunkSize)]?.[16380 % chunkSize], Math.fround(16380 % 97 / 100));
    assert.equal(f.audio.chunks.at(-1)?.at(-1), Math.fround(60000 % 97 / 100));
  }
});

test("segment partitions do not change the quiet boundary selected by the Rust policy", async () => {
  const expectedPlan = planSpeechWindow(976000, 0);
  assert.equal(expectedPlan.kind, "search");
  if (expectedPlan.kind !== "search") throw new Error("Expected a search.");
  const probe = new Float32Array(expectedPlan.probe.end - expectedPlan.probe.start).fill(0.2);
  for (let i = 0; i < probe.length; i += 1) {
    const index = expectedPlan.probe.start + i;
    if (index >= 27 * SAMPLE_RATE && index < 28 * SAMPLE_RATE) probe[i] = 0;
  }
  const expected = selectSpeechWindow(expectedPlan, probe);
  for (const chunkSize of [4096, 16384, 50000]) {
    const f = fixture(976000, { chunkSize });
    let index = 0;
    for (const chunk of f.audio.chunks) for (let i = 0; i < chunk.length; i += 1) {
      if (index >= 27 * SAMPLE_RATE && index < 28 * SAMPLE_RATE) chunk[i] = 0;
      index += 1;
    }
    const range = z.strictObject({ generation: z.literal(1), attempt: z.literal(1), range: z.object({ start: z.number(), end: z.number() }) })
      .parse(await f.effects.plan(f.audio, 0, MAX_WINDOW_SAMPLES, f.context)).range;
    assert.deepEqual(range, expected);
  }
});

test("late failure retries only unfinished coverage and keeps its smaller maximum and raw order", async () => {
  let call = 0;
  const f = fixture(976000, { infer: async () => {
    call += 1;
    if (call === 2) throw new SpeechWorkerError("NATIVE_FAILED");
    return ` part${call} `;
  } });
  const result = await new AdaptiveSpeechBoundary(f.effects).transcribe(f.audio, f.request, f.context);
  assert.equal(result.text, "part1 part3 part4 part5");
  assert.deepEqual(f.plans, [{ start: 0, maximum: 480000 }, { start: 480000, maximum: 480000 },
    { start: 480000, maximum: 240000 }, { start: 720000, maximum: 240000 }, { start: 960000, maximum: 240000 }]);
  assert.deepEqual(f.progress.map((value) => value.completedSamples), [480000, 720000, 960000, 976000]);
  assert.equal(f.rawParts.length, 1);
  assert.deepEqual(f.rawParts[0], [" part1 ", " part3 ", " part4 ", " part5 "]);
  assert.ok(f.progress.every((value) => Object.isFrozen(value) && !value.gpuFallback));
});

for (const failure of ["START_FAILED", "WORKER_FAILED", "TIMEOUT", "NATIVE_FAILED"] as const) {
  test(`CPU ${failure} exhausts the exact six Rust maxima without changing the saved preference`, async () => {
    const f = fixture(16001, { gpu: false, gpuAvailable: true,
      infer: async () => { throw new SpeechWorkerError(failure); } });
    await assert.rejects(new AdaptiveSpeechBoundary(f.effects).transcribe(f.audio, f.request, f.context), code("EXHAUSTED"));
    assert.deepEqual(f.plans.map((plan) => plan.maximum), [480000, 240000, 120000, 60000, 30000, 16000]);
    assert.ok(f.plans.every((plan) => plan.start === 0));
    assert.ok(f.inference.every((call) => !call.gpu));
    assert.equal(f.request.model.gpu, false);
    assert.equal(f.rawParts.length, 0);
  });
}

test("GPU exhaustion resets to CPU once at the unfinished index and never rewrites preference", async () => {
  const f = fixture(16001, { gpu: true, gpuAvailable: true,
    infer: async () => { throw new SpeechWorkerError("NATIVE_FAILED"); } });
  await assert.rejects(new AdaptiveSpeechBoundary(f.effects).transcribe(f.audio, f.request, f.context), code("EXHAUSTED"));
  assert.deepEqual(f.plans.map((plan) => plan.maximum), [480000, 240000, 120000, 60000, 30000, 16000,
    480000, 240000, 120000, 60000, 30000, 16000]);
  assert.deepEqual(f.inference.map((call) => call.gpu), [true, true, true, true, true, true, false, false, false, false, false, false]);
  assert.equal(f.request.model.gpu, true);
  assert.deepEqual(f.progress, [{ generation: 1, attempt: 1, completedSamples: 0, gpuFallback: true }]);
});

test("GPU fallback after success preserves the completed prefix and produces one processed result", async () => {
  let call = 0;
  const f = fixture(976000, { gpu: true, gpuAvailable: true, infer: async (model) => {
    call += 1;
    if (call > 1 && model.gpu) throw new SpeechWorkerError("NATIVE_FAILED");
    return call === 1 ? "first" : "next";
  } });
  const result = await new AdaptiveSpeechBoundary(f.effects).transcribe(f.audio, f.request, f.context);
  assert.equal(result.text, "first next next");
  assert.equal(f.plans[0]?.start, 0);
  assert.ok(f.plans.slice(1, 8).every((plan) => plan.start === 480000));
  assert.equal(f.plans[7]?.maximum, 480000);
  assert.deepEqual(f.progress.map((value) => value.completedSamples), [480000, 480000, 960000, 976000]);
  assert.deepEqual(f.progress.map((value) => value.gpuFallback), [false, true, true, true]);
  assert.equal(f.request.model.gpu, true);
  assert.equal(f.rawParts.length, 1);
});

test("undetected GPU starts directly on CPU; Parakeet receives no prompt but postprocessing still applies", async () => {
  const f = fixture(1, { gpu: true, gpuAvailable: false, family: "parakeet", infer: async () => "Kubernetis" });
  const result = await new AdaptiveSpeechBoundary(f.effects).transcribe(f.audio, f.request, f.context);
  assert.equal(result.text, "Kubernetes");
  assert.deepEqual(f.inference, [{ gpu: false, length: 1, language: "yue", vocabulary: "" }]);
  assert.equal(f.audio.sampleCount, 1);
  assert.equal(f.audio.chunks[0]?.length, 1);
  assert.equal(f.request.model.gpu, true);
});

test("empty successful windows advance coverage while the final empty text stays a coordinator decision", async () => {
  const f = fixture(976000, { infer: async () => " \u0085\t" });
  const result = await new AdaptiveSpeechBoundary(f.effects).transcribe(f.audio, f.request, f.context);
  assert.equal(result.text, "");
  assert.equal(f.progress.at(-1)?.completedSamples, 976000);
  assert.equal(f.inference.length, 3);
  const empty = fixture(0);
  assert.equal((await new AdaptiveSpeechBoundary(empty.effects).transcribe(empty.audio, empty.request, empty.context)).text, "");
  assert.equal(empty.inference.length, 0);
});

test("explicit retry after exhaustion starts from retained audio without pretending durable partial checkpoints", async () => {
  let fail = true;
  const f = fixture(16001, { infer: async () => {
    if (fail) throw new SpeechWorkerError("NATIVE_FAILED");
    return "recovered";
  } });
  const service = new AdaptiveSpeechBoundary(f.effects);
  await assert.rejects(service.transcribe(f.audio, f.request, f.context), code("EXHAUSTED"));
  fail = false;
  const audio = { ...f.audio, attempt: 2 }, context = { ...f.context, attempt: 2 };
  const result = await service.transcribe(audio, f.request, context);
  assert.deepEqual(result, { generation: 1, attempt: 2, text: "recovered" });
  assert.deepEqual(f.plans.at(-1), { start: 0, maximum: 480000 });
  assert.equal(f.audio.chunks[0]?.length, 16001);
});

for (const phase of ["plan", "read", "infer", "process"] as const) {
  test(`cancel during ${phase} rejects promptly and a late completion cannot replace the next generation`, async () => {
    const blocked = deferred<unknown>(), infer = deferred<string>();
    let entered = false;
    const f = fixture(1, { infer: async () => "fresh" });
    const effects: AdaptiveSpeechEffects = { ...f.effects,
      plan: async (audio, start, maximum, owner) => {
        if (phase === "plan" && owner.generation === 1) { entered = true; return await blocked.promise; }
        return await f.effects.plan(audio, start, maximum, owner);
      },
      read: async (audio, range, owner) => {
        if (phase === "read" && owner.generation === 1) { entered = true; return await blocked.promise; }
        return await f.effects.read(audio, range, owner);
      },
      infer: { transcribeWindow: async (model, samples, language, vocabulary, signal) => {
        if (phase === "infer" && !entered) { entered = true; return await infer.promise; }
        return await f.effects.infer.transcribeWindow(model, samples, language, vocabulary, signal);
      } },
      process: async (parts, request, owner) => {
        if (phase === "process" && owner.generation === 1) { entered = true; return await blocked.promise; }
        return await f.effects.process(parts, request, owner);
      },
    };
    const service = new AdaptiveSpeechBoundary(effects);
    const pending = service.transcribe(f.audio, f.request, f.context);
    const rejected = assert.rejects(pending, code("CANCELLED"));
    await reached(() => entered);
    await assert.rejects(service.transcribe(f.audio, f.request, f.context), code("BUSY"));
    f.controller.abort(); await rejected;
    const next = { generation: 2, attempt: 2, signal: new AbortController().signal };
    assert.deepEqual(await service.transcribe({ ...f.audio, generation: 2, attempt: 2 }, f.request, next),
      { generation: 2, attempt: 2, text: "fresh" });
    const completedBeforeLate = f.progress.length;
    blocked.resolve(phase === "plan" ? { generation: 1, attempt: 1, range: { start: 0, end: 1 } }
      : phase === "read" ? { generation: 1, attempt: 1, samples: new Float32Array([0.25]) }
      : { generation: 1, attempt: 1, text: "stale" });
    infer.resolve("stale");
    await nextTurn();
    assert.equal(f.progress.length, completedBeforeLate);
    assert.equal(f.audio.chunks[0]?.length, 1);
  });
}

test("synchronous cancellation before the first microtask starts no effects", async () => {
  const f = fixture(1);
  const pending = new AdaptiveSpeechBoundary(f.effects).transcribe(f.audio, f.request, f.context);
  const rejected = assert.rejects(pending, code("CANCELLED"));
  f.controller.abort(); await rejected; await nextTurn();
  assert.deepEqual(f.plans, []);
  assert.deepEqual(f.inference, []);
  const pre = fixture(1); pre.controller.abort();
  await assert.rejects(new AdaptiveSpeechBoundary(pre.effects).transcribe(pre.audio, pre.request, pre.context), code("CANCELLED"));
  assert.deepEqual(pre.plans, []);
});

test("utility effects have finite deadlines and observe late rejection without raw-error leakage", async () => {
  for (const phase of ["plan", "read", "process"] as const) {
    const blocked = deferred<unknown>();
    // Observe the fixture promise even if an earlier assertion prevents entry.
    // The async effect's separate promise still exercises boundary containment.
    void blocked.promise.catch(() => {});
    const f = fixture(1);
    let entered = false;
    // Preparation must not yield and time out before the selected effect is reached.
    const effects: AdaptiveSpeechEffects = { ...f.effects,
      plan: async () => ({ generation: 1, attempt: 1, range: { start: 0, end: 1 } }),
      read: async () => ({ generation: 1, attempt: 1, samples: new Float32Array([0.2]) }),
      process: async () => ({ generation: 1, attempt: 1, text: "text" }),
      [phase]: async () => { entered = true; return await blocked.promise; },
    };
    await assert.rejects(new AdaptiveSpeechBoundary(effects, { effectTimeoutMs: 10 })
      .transcribe(f.audio, f.request, f.context), code("EFFECT_TIMEOUT"));
    assert.equal(entered, true, `The intended blocked ${phase} effect must be entered.`);
    blocked.reject(new Error("private worker body")); await nextTurn();
  }
  for (const deadline of [0, -1, NaN, Infinity, 600001, 1.5]) {
    assert.throws(() => new AdaptiveSpeechBoundary(fixture(0).effects, { effectTimeoutMs: deadline }), code("INVALID_INPUT"));
  }
});

test("utility effects time out during delayed preparation before a later phase is entered", async () => {
  const preparation = deferred<unknown>(), later = deferred<unknown>();
  void later.promise.catch(() => {});
  const f = fixture(1);
  let preparationEntered = false, laterEntered = false;
  const effects: AdaptiveSpeechEffects = { ...f.effects,
    plan: async () => ({ generation: 1, attempt: 1, range: { start: 0, end: 1 } }),
    read: async () => { preparationEntered = true; return await preparation.promise; },
    process: async () => { laterEntered = true; return await later.promise; },
  };
  await assert.rejects(new AdaptiveSpeechBoundary(effects, { effectTimeoutMs: 10 })
    .transcribe(f.audio, f.request, f.context), code("EFFECT_TIMEOUT"));
  assert.equal(preparationEntered, true); assert.equal(laterEntered, false);
  later.reject(new Error("private worker body"));
  preparation.resolve({ generation: 1, attempt: 1, samples: new Float32Array([0.2]) });
  await nextTurn();
  assert.equal(laterEntered, false);
});

test("malformed ranges, owners, samples and processing replies fail before publishing", async () => {
  for (const reply of [{ generation: 1, attempt: 1, range: { start: 0, end: 0 } },
    { generation: 1, attempt: 1, range: { start: 1, end: 2 } },
    { generation: 1, attempt: 1, range: { start: 0, end: 2 } },
    { generation: 1, attempt: 1, range: { start: 0, end: NaN } },
    { generation: 1, attempt: 1, range: { start: 0, end: 1 }, extra: "private" }]) {
    const f = fixture(1);
    await assert.rejects(new AdaptiveSpeechBoundary({ ...f.effects, plan: async () => reply })
      .transcribe(f.audio, f.request, f.context), code("INVALID_WINDOW"));
    assert.deepEqual(f.inference, []);
  }
  for (const samples of [new Float32Array(0), new Float32Array(2), new Float32Array([NaN]),
    new Float32Array([Infinity]), new Float32Array(new SharedArrayBuffer(4))]) {
    const f = fixture(1);
    await assert.rejects(new AdaptiveSpeechBoundary({ ...f.effects, read: async () => ({ generation: 1, attempt: 1, samples }) })
      .transcribe(f.audio, f.request, f.context), code("INVALID_WINDOW"));
    assert.deepEqual(f.inference, []);
  }
  for (const phase of ["plan", "read", "process"] as const) {
    const f = fixture(1);
    const reply = phase === "plan" ? { generation: 2, attempt: 1, range: { start: 0, end: 1 } }
      : phase === "read" ? { generation: 1, attempt: 2, samples: new Float32Array([0.25]) }
      : { generation: 2, attempt: 1, text: "unowned" };
    await assert.rejects(new AdaptiveSpeechBoundary({ ...f.effects, [phase]: async () => reply })
      .transcribe(f.audio, f.request, f.context), code("OWNERSHIP_FAILED"));
  }
  const f = fixture(1);
  await assert.rejects(new AdaptiveSpeechBoundary({ ...f.effects, process: async () => ({ generation: 1, attempt: 1, text: "private", extra: true }) })
    .transcribe(f.audio, f.request, f.context), code("EFFECT_FAILED"));
});

test("utility range reads reject incomplete retained segments and cancellation without shortening data", async () => {
  const f = fixture(1);
  const effects = createUtilitySpeechEffects({ gpuAvailable: false, infer: f.effects.infer });
  await assert.rejects(effects.read({ ...f.audio, sampleCount: 2 }, { start: 0, end: 2 }, f.context), code("INVALID_WINDOW"));
  await assert.rejects(effects.read(f.audio, { start: 0, end: 2 }, f.context), code("INVALID_WINDOW"));
  await assert.rejects(effects.read(f.audio, { start: 0, end: 1 }, { ...f.context, generation: 2 }), code("INVALID_INPUT"));
  f.controller.abort();
  await assert.rejects(effects.read(f.audio, { start: 0, end: 1 }, f.context), code("CANCELLED"));
  const active = fixture(60001);
  const pending = active.effects.read(active.audio, { start: 0, end: 60001 }, active.context);
  const cancelled = assert.rejects(pending, code("CANCELLED"));
  await nextTurn(); active.controller.abort(); await cancelled;
  assert.ok(active.audio.chunks.every((chunk) => chunk.length > 0 && chunk[0] === Math.fround(0.2)));
});

test("contract failures never trigger adaptive fallback; oversize text is rejected intact", async () => {
  for (const failure of ["CANCELLED", "BUSY", "INVALID_REPLY", "CLOSED", "TEARDOWN_FAILED"] as const) {
    const f = fixture(1, { infer: async () => { throw new SpeechWorkerError(failure); } });
    await assert.rejects(new AdaptiveSpeechBoundary(f.effects).transcribe(f.audio, f.request, f.context),
      code(failure === "CANCELLED" ? "CANCELLED" : "INFERENCE_FAILED"));
    assert.equal(f.plans.length, 1);
  }
  const secret = fixture(1, { infer: async () => { throw new Error("private native detail"); } });
  await assert.rejects(new AdaptiveSpeechBoundary(secret.effects).transcribe(secret.audio, secret.request, secret.context), code("EFFECT_FAILED"));
  assert.equal(secret.plans.length, 1);
  const large = fixture(1, { infer: async () => "α".repeat(2 * 1024 * 1024 + 1) });
  await assert.rejects(new AdaptiveSpeechBoundary(large.effects).transcribe(large.audio, large.request, large.context), code("INFERENCE_FAILED"));
  assert.equal(large.rawParts.length, 0);
  const request = { ...large.request, vocabulary: "a".repeat(4 * 1024 * 1024 + 1) };
  await assert.rejects(new AdaptiveSpeechBoundary(large.effects).transcribe(large.audio, request, large.context), code("INVALID_INPUT"));
});

test("raw parts use Rust whitespace semantics and preserve multilingual text without a final-text cutoff", () => {
  const f = fixture(0);
  assert.equal(processRawSpeechParts(["\u0085 日本語 👩‍💻 \u0085", "\ufeffالعربية\u200f\ufeff"], f.request),
    "日本語 👩‍💻 \ufeffالعربية\u200f\ufeff");
  const part = "あ".repeat(300000), parts = Array.from({ length: 6 }, () => part);
  const result = processRawSpeechParts(parts, f.request);
  assert.ok(new TextEncoder().encode(result).length > 4 * 1024 * 1024);
  assert.ok(result === parts.join(" "));
});

test("cleanup then vocabulary then snippets runs once after joining raw chunk boundaries", async () => {
  const f = fixture(480001);
  const request: RecordingRequest = recordingRequestSchema.parse({ ...f.request,
    snippets: [{ id: "owned", trigger: "Kubernetes", expansion: "$10\n日本語 👩‍💻", enabled: true }] });
  let call = 0;
  const effects: AdaptiveSpeechEffects = { ...f.effects, infer: { transcribeWindow: async () =>
    ++call === 1 ? "[BLANK_AUDIO]  Kubernetis" : "." } };
  assert.equal((await new AdaptiveSpeechBoundary(effects).transcribe(f.audio, request, f.context)).text, "$10\n日本語 👩‍💻");
  assert.equal(f.rawParts.length, 1);
  assert.deepEqual(f.rawParts[0], ["[BLANK_AUDIO]  Kubernetis", "."]);
  assert.equal(processRawSpeechParts(["Whisper", "Free"], { ...f.request, vocabulary: "WhisperFree" }), "WhisperFree");
});

test("runtime-validated shared processing fixtures pass through the utility processor for both families", async () => {
  const textCase = z.strictObject({ name: z.string(), input: z.string(), expected: z.string() });
  const schema = z.strictObject({ $comment: z.string().optional(), cleaner: z.array(textCase),
    vocabulary: z.strictObject({ terms: z.string(), cases: z.array(textCase) }),
    snippets: z.strictObject({ snippets: z.array(z.strictObject({ trigger: z.string(), expansion: z.string(), enabled: z.boolean() })),
      cases: z.array(textCase) }) });
  const unknown: unknown = JSON.parse(await readFile(new URL("../fixtures/text/vectors.json", import.meta.url), "utf8"));
  const vectors = schema.parse(unknown);
  for (const family of ["whisper", "parakeet"] as const) {
    const f = fixture(0, { family });
    for (const value of vectors.cleaner) assert.equal(processRawSpeechParts(value.input.split(" "),
      { ...f.request, vocabulary: "" }), value.expected);
    for (const value of vectors.vocabulary.cases) assert.equal(processRawSpeechParts(value.input.split(" "),
      { ...f.request, vocabulary: vectors.vocabulary.terms }), value.expected);
    const snippets = vectors.snippets.snippets.map((snippet, index) => ({ ...snippet, id: `owned-${index}` }));
    for (const value of vectors.snippets.cases) assert.equal(processRawSpeechParts(value.input.split(" "),
      { ...f.request, vocabulary: "", snippets }), value.expected);
  }
});

class RetryChannel implements SpeechChannel {
  private listener: ((value: unknown) => void) | undefined;
  constructor(private readonly fail: boolean, private readonly cleanup: Promise<void>) {}
  send(request: SpeechRequest): void {
    queueMicrotask(() => this.listener?.(this.fail ? { version: 1, id: request.id, ok: false, code: "NATIVE_FAILED" }
      : { version: 1, id: request.id, ok: true, value: request.command === "transcribe"
        ? { command: "transcribe", text: "recovered" } : { command: "shutdown" } }));
  }
  onMessage(listener: (value: unknown) => void): () => void {
    this.listener = listener; listener({ version: 1, type: "ready" });
    return () => { this.listener = undefined; };
  }
  onExit(): () => void { return () => {}; }
  async terminate(): Promise<void> { await this.cleanup; }
}

test("adaptive SpeechClient retry waits for confirmed prior-owner disposal before creating a replacement", async () => {
  const disposed = deferred<void>();
  let owners = 0;
  const client = new SpeechClient(async () => {
    owners += 1;
    return new RetryChannel(owners === 1, owners === 1 ? disposed.promise : Promise.resolve());
  });
  const f = fixture(1);
  const service = new AdaptiveSpeechBoundary({ ...f.effects, infer: client });
  const pending = service.transcribe(f.audio, f.request, f.context);
  await reached(() => f.plans.length === 2);
  await nextTurn();
  assert.equal(owners, 1);
  assert.equal(f.progress.length, 0);
  disposed.resolve();
  assert.equal((await pending).text, "recovered");
  assert.equal(owners, 2);
  await client.close();
});

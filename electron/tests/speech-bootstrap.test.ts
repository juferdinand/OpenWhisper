import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSpeechBootstrap, SpeechBootstrapError } from "../src/workers/speech-bootstrap.js";
import { MAX_SPEECH_CHALLENGES, speechBootstrapArgumentsSchema, speechChallengeReplySchema,
  speechChallengeRequestSchema } from "../src/workers/speech-control.js";
import { speechReplySchema } from "../src/workers/speech-protocol.js";
import type { NativeSpeech } from "../src/workers/native-speech.js";

function fixture() {
  const epoch = randomUUID(), binding = "/owned-app/dist/native/openwhisper_speech.node", pid = 123;
  const calls: string[] = [];
  const native: NativeSpeech = {
    gpuDevice: () => { calls.push("discover"); return null; },
    load: (model) => { calls.push(`model:${model.family}:${model.gpu}`); },
    transcribe: (_samples, language, vocabulary) => { calls.push(`transcribe:${language}:${vocabulary}`); return "Café 東京 👩‍💻"; },
    shutdown: () => { calls.push("shutdown"); },
  };
  let loadFailure = false;
  const kernel = createSpeechBootstrap({ binding, epoch, pid, load: (value) => {
    assert.equal(value, binding); calls.push("binding");
    if (loadFailure) throw new Error("Private binding path and loader details.");
    return native;
  } });
  const challenge = (nonce = randomUUID()) => ({ version: 1, type: "challenge", epoch, nonce });
  const control = () => { kernel.receive(challenge()); kernel.receive(challenge()); };
  return { kernel, native, calls, epoch, pid, challenge, control, failLoad: () => { loadFailure = true; } };
}
const request = (command: "discover" | "shutdown") => ({ version: 1, id: randomUUID(), command });
const failed = (code: string) => (error: unknown) => error instanceof SpeechBootstrapError && error.code === code;

test("bootstrap validates fixed argv and closed challenge identity in both directions", () => {
  const epoch = randomUUID(), nonce = randomUUID();
  assert.deepEqual(speechBootstrapArgumentsSchema.parse(["/owned/binding.node", epoch]), ["/owned/binding.node", epoch]);
  for (const args of [["relative.node", epoch], ["/owned/binding.node", "bad"], ["/owned/binding.node", epoch, "extra"],
    ["/owned/binding.node\0", epoch], ["/owned/model.bin", epoch]]) assert.equal(speechBootstrapArgumentsSchema.safeParse(args).success, false);
  const valid = { version: 1, type: "challenge", epoch, nonce };
  assert.equal(speechChallengeRequestSchema.safeParse(valid).success, true);
  assert.equal(speechChallengeRequestSchema.safeParse({ ...valid, extra: true }).success, false);
  for (const pid of [0, -1, 1.5, Infinity]) assert.equal(speechChallengeReplySchema.safeParse({ version: 1, epoch, nonce, pid }).success, false);
  assert.equal(speechChallengeReplySchema.safeParse({ version: 1, epoch, nonce, pid: 42, extra: true }).success, false);
});

test("ready and two fresh fixed-epoch challenges never invoke native code", () => {
  const f = fixture(); assert.deepEqual(f.kernel.ready, { version: 1, type: "ready" });
  const first = f.challenge(), second = f.challenge();
  assert.deepEqual(f.kernel.receive(first), { version: 1, epoch: f.epoch, nonce: first.nonce, pid: f.pid });
  assert.deepEqual(f.kernel.receive(second), { version: 1, epoch: f.epoch, nonce: second.nonce, pid: f.pid });
  assert.deepEqual(f.calls, []);
  f.kernel.close(); assert.deepEqual(f.calls, []);
});

for (const count of [0, 1]) test(`ordinary work before ${count === 0 ? "any" : "a second"} challenge cannot load a binding`, () => {
  const f = fixture(); if (count) f.kernel.receive(f.challenge());
  assert.throws(() => f.kernel.receive(request("discover")), failed("CONTROL_FAILED"));
  assert.deepEqual(f.calls, []);
  assert.throws(() => f.kernel.receive(f.challenge()), failed("CLOSED"));
});

for (const kind of ["epoch", "repeat", "extra", "malformed", "ordinary-extra"] as const) {
  test(`invalid ${kind} frame poisons the bootstrap without loading native`, () => {
    const f = fixture(), first = f.challenge(); f.kernel.receive(first);
    const value = kind === "epoch" ? { ...f.challenge(), epoch: randomUUID() }
      : kind === "repeat" ? first : kind === "extra" ? { ...f.challenge(), extra: "private" }
      : kind === "malformed" ? { ...f.challenge(), nonce: "private-invalid" }
      : { ...request("discover"), extra: "private" };
    assert.throws(() => f.kernel.receive(value), failed(kind === "epoch" || kind === "repeat" ? "CONTROL_FAILED" : "INVALID_FRAME"));
    assert.deepEqual(f.calls, []);
    assert.throws(() => f.kernel.receive(request("shutdown")), failed("CLOSED"));
  });
}

test("successful private challenges have a finite nonce budget", () => {
  const f = fixture();
  for (let i = 0; i < MAX_SPEECH_CHALLENGES; i++) f.kernel.receive(f.challenge());
  assert.throws(() => f.kernel.receive(f.challenge()), failed("CONTROL_FAILED")); assert.deepEqual(f.calls, []);
});

test("first ordinary work after two challenges lazily loads once and preserves multilingual native results", () => {
  const f = fixture(); f.control();
  const discover = speechReplySchema.parse(f.kernel.receive(request("discover")));
  assert.ok(discover.ok && discover.value.command === "discover"); assert.equal(discover.value.gpu, null);
  const transcribe = speechReplySchema.parse(f.kernel.receive({ version: 1, id: randomUUID(), command: "transcribe",
    model: { path: "/fixtures/model.bin", family: "parakeet", gpu: false }, samples: new Float32Array([0.25]), language: "yue", vocabulary: "词汇" }));
  assert.ok(transcribe.ok && transcribe.value.command === "transcribe"); assert.equal(transcribe.value.text, "Café 東京 👩‍💻");
  assert.deepEqual(f.calls, ["binding", "discover", "model:parakeet:false", "transcribe:yue:词汇"]);
  f.kernel.close(); f.kernel.close(); assert.equal(f.calls.filter((value) => value === "shutdown").length, 1);
});

for (const controlled of [false, true]) test(`shutdown ${controlled ? "after" : "before"} challenges acknowledges without native load`, () => {
  const f = fixture(); if (controlled) f.control(); const input = request("shutdown");
  assert.deepEqual(f.kernel.receive(input), { version: 1, id: input.id, ok: true, value: { command: "shutdown" } });
  assert.deepEqual(f.calls, []); f.kernel.close();
  assert.throws(() => f.kernel.receive(f.challenge()), failed("CLOSED"));
});

test("binding loader refusal is START_FAILED and never a null discovery or repeated require", () => {
  const f = fixture(); f.control(); f.failLoad();
  for (let i = 0; i < 2; i++) {
    const input = request("discover");
    assert.deepEqual(f.kernel.receive(input), { version: 1, id: input.id, ok: false, code: "START_FAILED" });
  }
  assert.deepEqual(f.calls, ["binding"]);
  assert.ok(speechReplySchema.parse(f.kernel.receive(request("shutdown"))).ok);
});

for (const operation of ["discover", "load", "transcribe", "shutdown"] as const) {
  test(`loaded ${operation} failure remains NATIVE_FAILED without diagnostic disclosure`, () => {
    const f = fixture(); f.control();
    f.native[operation === "discover" ? "gpuDevice" : operation] = () => { throw new Error("Private native details."); };
    const input = operation === "discover" || operation === "shutdown" ? request(operation)
      : { version: 1, id: randomUUID(), command: "transcribe", model: { path: "/fixtures/model.bin", family: "whisper", gpu: false },
        samples: new Float32Array([0.25]), language: "en", vocabulary: "" };
    if (operation === "shutdown") f.kernel.receive(request("discover"));
    assert.deepEqual(f.kernel.receive(input), { version: 1, id: input.id, ok: false, code: "NATIVE_FAILED" });
    assert.equal(f.calls.filter((value) => value === "binding").length, 1);
    f.kernel.close();
  });
}

test("invalid ordinary window after control cannot trigger binding load", () => {
  const f = fixture(); f.control();
  assert.throws(() => f.kernel.receive({ version: 1, id: randomUUID(), command: "transcribe",
    model: { path: "/fixtures/model.bin", family: "whisper", gpu: false }, samples: new Float32Array([Infinity]), language: "en", vocabulary: "" }),
  failed("INVALID_FRAME")); assert.deepEqual(f.calls, []);
});

test("invalid frame after lazy loading shuts down that single native context once", () => {
  const f = fixture(); f.control(); f.kernel.receive(request("discover"));
  assert.throws(() => f.kernel.receive(null), failed("INVALID_FRAME")); f.kernel.close();
  assert.deepEqual(f.calls, ["binding", "discover", "shutdown"]);
});

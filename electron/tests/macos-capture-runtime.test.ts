import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import { NativeCaptureBoundary } from "../src/services/capture.js";
import type { DeliveryIdentity } from "../src/core/recording.js";
import { MacCaptureRuntime, type MacCaptureRuntimeEffects } from "../src/workers/macos-capture-runtime.js";
import { macRecordingHostReplySchema, macRecordingHostRequestSchema,
  type MacRecordingConfiguration, type MacRecordingHostReply, type MacRecordingHostRequest } from "../src/workers/macos-recording-host-protocol.js";
import type { CaptureMetadata, NativeCaptureSession } from "../src/workers/native-capture.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve };
}
const request = { model: { path: "/owned/models/ggml-tiny.bin", family: "whisper" as const, gpu: false },
  language: "en" as const, vocabulary: "COUNTRI", snippets: [{ id: "owned", trigger: "COUNTRI", expansion: "literal ✅", enabled: true }] };
function fixture() {
  const epoch = randomUUID(), messages: MacRecordingHostReply[] = [], events: string[] = [], identities: DeliveryIdentity[] = [];
  let startLatch: ReturnType<typeof deferred<CaptureMetadata>> | undefined;
  let fenceLatch: ReturnType<typeof deferred<CaptureMetadata>> | undefined;
  let preparationLatch: ReturnType<typeof deferred<void>> | undefined;
  let deliveryLatch: ReturnType<typeof deferred<void>> | undefined;
  let failDelivery = false, failSpeech = false, failPreparation = false, failRelease = false, captureFailed = false, incompleteFence = false;
  let cleaned = 0;
  const inferred: { path: string; vocabulary: string }[] = [];
  const meta = (generation: number): CaptureMetadata => ({ generation, running: false, streamClosed: true,
    finalSamplesFenced: true, failed: false, frameCount: "4800", sequence: "4800", sampleRate: 16000, channels: 1, level: 0 });
  const effects: MacCaptureRuntimeEffects = {
    prepare: async () => {
      events.push("initialize");
      return NativeCaptureBoundary.fromSessionFactory((generation) => {
        events.push("create"); const base = meta(generation);
        const session: NativeCaptureSession = {
          generation,
          start: async () => { events.push("start"); return startLatch ? startLatch.promise : { ...base, running: true, streamClosed: false, finalSamplesFenced: false }; },
          closeAndFence: async () => { events.push("fence"); return fenceLatch ? fenceLatch.promise
            : { ...base, failed: captureFailed, streamClosed: !incompleteFence, finalSamplesFenced: !incompleteFence }; },
          prepare: async () => { events.push("prepare"); if (preparationLatch) await preparationLatch.promise;
            if (failPreparation) throw new Error("inert conversion failure"); return { ...base, sampleCount: 4800, chunkCount: 1 }; },
          readPreparedChunk: () => new Float32Array(4800).fill(0.1),
          status: () => ({ ...base, running: true, streamClosed: false, finalSamplesFenced: false }),
          release: async () => { events.push("release"); if (failRelease) throw new Error("inert cleanup failure"); return base; },
          abortStart: () => { events.push("abort-start"); }, feed: () => {}, feedHole: () => {}, injectError: () => {},
        }; return session;
      });
    },
    infer: () => ({ transcribeWindow: async (model, samples, _language, vocabulary) => {
      events.push("infer"); assert.equal(samples.byteOffset, 0); assert.equal(samples.byteLength, samples.buffer.byteLength);
      inferred.push({ path: model.path, vocabulary }); if (failSpeech) throw new Error("inert inference failure"); return "COUNTRI";
    } }),
    delivery: { deliver: async (text, context, identity) => {
      events.push("deliver"); assert.equal(text, "literal ✅"); identities.push(identity); if (deliveryLatch) await deliveryLatch.promise;
      return failDelivery ? { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false }
        : { generation: context.generation, attempt: context.attempt, outcome: "clipboard", clipboardConfirmed: true };
    } },
    close: async () => { cleaned++; events.push("effects-close"); },
  };
  const runtime = new MacCaptureRuntime({ epoch, pid: 123, effects, send: (reply) => {
    messages.push(reply); if (reply.kind === "control" && reply.command === "stop" && reply.reply.ok) events.push("stop-ack");
  } });
  const command = (name: Exclude<MacRecordingHostRequest["command"], "configure">) =>
    ({ version: 1 as const, channel: "recording-host" as const, epoch, id: randomUUID(), command: name });
  const configuration = (): MacRecordingConfiguration => ({ version: 1, channel: "recording-host", epoch, id: randomUUID(), command: "configure",
    capture: { bytes: 123, sha256: "a".repeat(64) }, request: structuredClone(request) });
  const last = () => messages.filter((reply) => reply.kind === "snapshot").at(-1)?.snapshot;
  async function terminal() {
    const until = performance.now() + 3000;
    while (!last() || last()?.busy) { assert.ok(performance.now() < until, "inert fixture did not settle"); await turn(); }
    return last();
  }
  return { epoch, runtime, effects, messages, events, identities, inferred, meta, command, configuration, last, terminal,
    cleanup: () => cleaned,
    startHold: () => { startLatch = deferred<CaptureMetadata>(); return startLatch; },
    fenceHold: () => { fenceLatch = deferred<CaptureMetadata>(); return fenceLatch; },
    prepareHold: () => { preparationLatch = deferred<void>(); return preparationLatch; },
    deliveryHold: () => { deliveryLatch = deferred<void>(); return deliveryLatch; },
    failDelivery: (value: boolean) => { failDelivery = value; }, failSpeech: (value: boolean) => { failSpeech = value; },
    failPreparation: (value: boolean) => { failPreparation = value; }, failRelease: (value: boolean) => { failRelease = value; },
    failedCapture: () => { captureFailed = true; }, incompleteFence: (value: boolean) => { incompleteFence = value; },
  };
}
test("Mac protocol admits only fixed CPU configuration and shared content-bounded control replies", () => {
  const f = fixture(), config = f.configuration(); macRecordingHostRequestSchema.parse(config);
  for (const changed of [{ ...config, binding: "/untrusted.node" }, { ...config, recoveryPath: "/owned/recovery" },
    { ...config, server: "unix:/owned/pulse/native" }, { ...config, source: "device" }, { ...config, selection: { mode: "synthetic" } },
    { ...config, request: { ...config.request, model: { ...config.request.model, gpu: true } } },
    { ...config, command: "enumerate-sources" }, { ...config, samples: new Float32Array(1) }]) {
    assert.equal(macRecordingHostRequestSchema.safeParse(changed).success, false);
  }
  const ready = f.messages[0]; assert.ok(ready); assert.equal(macRecordingHostReplySchema.safeParse({ ...ready, samples: new Float32Array(1) }).success, false);
  assert.deepEqual(f.events, []);
});
test("Mac initialization does not allocate capture or touch recovery before explicit Start", async () => {
  const f = fixture(); await f.runtime.receive(f.configuration()); assert.deepEqual(f.events, ["initialize"]);
  assert.equal(f.last()?.phase, "idle"); assert.equal(f.last()?.recoveryAvailable, false); await f.runtime.close(); assert.equal(f.cleanup(), 1);
});
test("Mac Stop waits for the final fence and acknowledges before conversion and inference", async () => {
  const f = fixture(); await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start"));
  const fence = f.fenceHold(), stopping = f.runtime.receive(f.command("stop")); await turn();
  assert.equal(f.events.includes("stop-ack"), false); assert.equal(f.events.includes("prepare"), false);
  fence.resolve(f.meta(1)); await stopping; assert.equal((await f.terminal())?.phase, "done");
  assert.ok(f.events.indexOf("fence") < f.events.indexOf("stop-ack")); assert.ok(f.events.indexOf("stop-ack") < f.events.indexOf("prepare"));
  assert.ok(f.events.indexOf("prepare") < f.events.indexOf("infer")); assert.deepEqual(f.identities, [{ kind: "memory", generation: 1 }]);
  assert.equal(f.messages.some((reply) => reply.kind === "recovery-removed"), false); assert.equal(f.events.filter((event) => event === "release").length, 1);
  assert.deepEqual(f.messages.filter((reply) => reply.kind === "memory-released").map(({ generation, attempt }) => ({ generation, attempt })), [{ generation: 1, attempt: 1 }]);
  await f.runtime.close();
});
test("failed Mac delivery remains in RAM through refused Quit and Retry uses the same capture and text", async () => {
  const f = fixture(); f.failDelivery(true); await f.runtime.receive(f.configuration());
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop")); assert.equal((await f.terminal())?.error, "DELIVERY_FAILED");
  await assert.rejects(f.runtime.close(), { code: "RECOVERY_PENDING" }); assert.equal(f.cleanup(), 0); assert.equal(f.events.includes("release"), false);
  await f.runtime.receive(f.command("close")); assert.equal(f.messages.at(-1)?.kind, "failed");
  f.failDelivery(false); await f.runtime.receive(f.command("retry")); assert.equal((await f.terminal())?.phase, "done");
  assert.equal(f.events.filter((event) => event === "create").length, 1); assert.equal(f.inferred.length, 1);
  assert.deepEqual(f.identities, [{ kind: "memory", generation: 1 }, { kind: "memory", generation: 1 }]); await f.runtime.close();
});
test("failed Mac inference Retry reuses stopped RAM and the captured model choices", async () => {
  const f = fixture(), config = f.configuration(); f.failSpeech(true); await f.runtime.receive(config);
  config.request.model.path = "/owned/changed.bin"; config.request.vocabulary = "changed";
  const snippet = config.request.snippets[0]; assert.ok(snippet); snippet.expansion = "changed";
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop")); assert.equal((await f.terminal())?.error, "SPEECH_FAILED");
  f.failSpeech(false); await f.runtime.receive(f.command("retry")); assert.equal((await f.terminal())?.phase, "done");
  assert.deepEqual(f.inferred, [{ path: request.model.path, vocabulary: request.vocabulary }, { path: request.model.path, vocabulary: request.vocabulary }]);
  assert.equal(f.events.filter((event) => event === "create").length, 1); assert.equal(f.events.filter((event) => event === "prepare").length, 1); await f.runtime.close();
});
test("Mac cancellation waits for the original late Start and rolls back its same session", async () => {
  const f = fixture(); await f.runtime.receive(f.configuration()); const held = f.startHold();
  const starting = f.runtime.receive(f.command("start")); await turn(); const cancelling = f.runtime.receive(f.command("cancel")); await turn();
  assert.equal(f.events.includes("fence"), false); assert.equal(f.events.includes("abort-start"), true);
  held.resolve({ ...f.meta(1), running: true, streamClosed: false, finalSamplesFenced: false }); await Promise.all([starting, cancelling]);
  assert.equal(f.events.filter((event) => event === "create").length, 1); assert.equal(f.events.includes("release"), true);
  assert.equal(f.last()?.recoveryAvailable, false); assert.equal(f.inferred.length, 0); await f.runtime.close();
});
test("failed Mac fence never acknowledges Stop success or releases the original session", async () => {
  const f = fixture(); await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start")); f.incompleteFence(true);
  await f.runtime.receive(f.command("stop")); assert.equal(f.last()?.error, "STOP_FAILED");
  assert.equal(f.events.includes("stop-ack"), false); assert.equal(f.events.includes("prepare"), false); assert.equal(f.events.includes("release"), false);
  f.incompleteFence(false); await f.runtime.receive(f.command("stop")); assert.equal((await f.terminal())?.phase, "done");
  assert.equal(f.events.filter((event) => event === "create").length, 1); await f.runtime.close();
});
test("capture error retains the complete fenced Mac RAM ledger until explicit Retry", async () => {
  const f = fixture(); await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start")); f.failedCapture();
  await f.runtime.receive(f.command("stop")); assert.equal((await f.terminal())?.error, "CAPTURE_FAILED");
  assert.equal(f.last()?.recoveryAvailable, true); assert.equal(f.inferred.length, 0); assert.equal(f.events.includes("stop-ack"), false);
  await f.runtime.receive(f.command("retry")); assert.equal((await f.terminal())?.phase, "done"); assert.equal(f.inferred.length, 1); await f.runtime.close();
});
test("failed conversion retains raw Mac RAM and Retry prepares the same native owner", async () => {
  const f = fixture(); f.failPreparation(true); await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start"));
  await f.runtime.receive(f.command("stop")); assert.equal((await f.terminal())?.error, "PREPARATION_FAILED");
  await assert.rejects(f.runtime.close(), { code: "RECOVERY_PENDING" }); f.failPreparation(false);
  await f.runtime.receive(f.command("retry")); assert.equal((await f.terminal())?.phase, "done");
  assert.equal(f.events.filter((event) => event === "create").length, 1); assert.equal(f.events.filter((event) => event === "prepare").length, 2); await f.runtime.close();
});
test("Mac Discard retains a failed release for explicit cleanup retry without delivery", async () => {
  const f = fixture(); f.failSpeech(true); await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start"));
  await f.runtime.receive(f.command("stop")); await f.terminal(); f.failRelease(true); await f.runtime.receive(f.command("discard"));
  assert.equal(f.last()?.error, "CAPTURE_RELEASE_FAILED"); assert.equal(f.last()?.recoveryAvailable, true);
  await assert.rejects(f.runtime.close(), { code: "RECOVERY_PENDING" }); f.failRelease(false); await f.runtime.receive(f.command("discard"));
  assert.equal(f.last()?.phase, "idle"); assert.equal(f.last()?.recoveryAvailable, false); assert.equal(f.identities.length, 0); await f.runtime.close();
});
test("cancel then Discard waits for original preparation and suppresses stale inference", async () => {
  const f = fixture(), held = f.prepareHold(); await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start"));
  await f.runtime.receive(f.command("stop")); await turn(); const cancel = f.runtime.receive(f.command("cancel")); await turn();
  assert.equal(f.events.includes("release"), false); held.resolve(); await cancel;
  await f.runtime.receive(f.command("discard")); assert.equal(f.last()?.phase, "idle"); assert.equal(f.inferred.length, 0);
  assert.equal(f.identities.length, 0); assert.equal(f.events.filter((event) => event === "release").length, 1); await f.runtime.close();
});
test("shutdown refuses newly retained RAM after cancellation failure without poisoning Retry or Discard", async () => {
  const f = fixture(); await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start")); f.failedCapture();
  await assert.rejects(f.runtime.close(), { code: "RECOVERY_PENDING" }); assert.equal(f.cleanup(), 0);
  await f.runtime.receive(f.command("discard")); assert.equal(f.last()?.phase, "idle"); await f.runtime.close(); assert.equal(f.cleanup(), 1);
});
test("late initialization remains owned through close without allocating a Mac session", async () => {
  const f = fixture(), boundary = await f.effects.prepare(f.configuration()), held = deferred<typeof boundary>(); f.events.length = 0;
  f.effects.prepare = async () => held.promise; const opening = f.runtime.receive(f.configuration()); await turn();
  const closing = f.runtime.close(); assert.equal(f.runtime.close(), closing); await turn(); assert.equal(f.cleanup(), 0);
  held.resolve(boundary); await opening; await closing; assert.equal(f.events.includes("create"), false); assert.equal(f.cleanup(), 1);
});
test("Mac duplicate stale and reconfiguration requests cannot replace an existing RAM owner", async () => {
  const f = fixture(), config = f.configuration(); await f.runtime.receive(config);
  await assert.rejects(f.runtime.receive(config), { code: "INVALID_FRAME" }); await assert.rejects(f.runtime.receive({ ...f.command("start"), epoch: randomUUID() }), { code: "INVALID_FRAME" });
  f.failDelivery(true); await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop")); await f.terminal();
  await f.runtime.receive(f.configuration()); assert.equal(f.messages.at(-1)?.kind, "failed"); assert.equal(f.events.filter((event) => event === "initialize").length, 1);
  await f.runtime.receive(f.command("discard")); await f.runtime.close();
});
test("shared native-session factory validates deadlines and does not call the factory until create", () => {
  let calls = 0;
  const factory = () => { calls++; throw new Error("inert creation"); };
  for (const invalid of [0, -1, Infinity, 60001]) assert.throws(() => NativeCaptureBoundary.fromSessionFactory(factory, { startupMs: invalid, closeMs: 1000 }));
  const boundary = NativeCaptureBoundary.fromSessionFactory(factory); assert.equal(calls, 0);
  assert.throws(() => boundary.create({ generation: 1, onError: () => {}, onLevel: () => {} })); assert.equal(calls, 1);
});
test("Mac failed release emits no receipt and cleanup Retry acknowledges the actual earlier delivery context", async () => {
  const f = fixture(); f.failRelease(true); await f.runtime.receive(f.configuration());
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop")); assert.equal((await f.terminal())?.error, "CAPTURE_RELEASE_FAILED");
  assert.equal(f.messages.some((reply) => reply.kind === "memory-released"), false);
  f.failRelease(false); await f.runtime.receive(f.command("retry")); assert.equal((await f.terminal())?.phase, "done");
  assert.equal(f.identities.length, 1); assert.equal(f.inferred.length, 1);
  assert.deepEqual(f.messages.filter((reply) => reply.kind === "memory-released").map(({ generation, attempt }) => ({ generation, attempt })), [{ generation: 1, attempt: 1 }]);
  await f.runtime.close();
});
test("Mac Discard waits for late confirmed delivery then acknowledges only the original issued context", async () => {
  const f = fixture(), delivery = f.deliveryHold(); await f.runtime.receive(f.configuration());
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop"));
  const until = performance.now() + 3000;
  while (!f.events.includes("deliver")) { assert.ok(performance.now() < until); await turn(); }
  const discard = f.runtime.receive(f.command("discard")); await turn();
  assert.equal(f.events.includes("release"), false); assert.equal(f.messages.some((reply) => reply.kind === "memory-released"), false);
  delivery.resolve(); await discard; assert.equal(f.last()?.phase, "idle");
  assert.deepEqual(f.messages.filter((reply) => reply.kind === "memory-released").map(({ generation, attempt }) => ({ generation, attempt })), [{ generation: 1, attempt: 1 }]);
  await f.runtime.close();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as turn } from "node:timers/promises";
import test from "node:test";
import type { PreparedAudio, RecoveryToken } from "../src/core/recording.js";
import { NativeCaptureBoundary } from "../src/services/capture.js";
import { CaptureRuntime, type CaptureRuntimeEffects } from "../src/workers/capture-runtime.js";
import type { CaptureMetadata, NativeCaptureSession } from "../src/workers/native-capture.js";
import { recordingHostReplySchema, recordingHostRequestSchema,
  type RecordingConfiguration, type RecordingHostReply, type RecordingHostRequest } from "../src/workers/recording-host-protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve };
}
const request = { model: { path: "/owned/models/ggml-tiny.bin", family: "whisper" as const, gpu: false },
  language: "en" as const, vocabulary: "COUNTRI", snippets: [{ id: "test", trigger: "COUNTRI", expansion: "literal ✅", enabled: true }] };
function fixture() {
  const epoch = randomUUID(), messages: RecordingHostReply[] = [], events: string[] = [];
  let audio: PreparedAudio | undefined, token: RecoveryToken | null = null;
  const sessions: NativeCaptureSession[] = [], inferred: { model: string; vocabulary: string }[] = [];
  let startLatch: ReturnType<typeof deferred<CaptureMetadata>> | undefined;
  let fenceLatch: ReturnType<typeof deferred<CaptureMetadata>> | undefined;
  let preparationLatch: ReturnType<typeof deferred<void>> | undefined;
  let deliveryLatch: ReturnType<typeof deferred<void>> | undefined;
  let failDelivery = false, failSave = false, cleanup = 0;
  const meta = (generation: number): CaptureMetadata => ({ generation, running: false, streamClosed: true,
    finalSamplesFenced: true, failed: false, frameCount: "4800", sequence: "4800", sampleRate: 16000, channels: 1, level: 0 });
  const effects: CaptureRuntimeEffects = {
    prepare: async () => ({ capture: new NativeCaptureBoundary({ create(generation) {
      events.push("create"); const base = meta(generation);
      const session: NativeCaptureSession = {
        generation, start: async () => { events.push("start"); return startLatch ? startLatch.promise : { ...base, running: true, streamClosed: false, finalSamplesFenced: false }; },
        closeAndFence: async () => { events.push("fence"); return fenceLatch ? fenceLatch.promise : base; },
        prepare: async () => { events.push("prepare"); if (preparationLatch) await preparationLatch.promise;
          return { ...base, sampleCount: 4800, chunkCount: 1 }; },
        readPreparedChunk: () => new Float32Array(4800).fill(0.1), status: () => ({ ...base, running: true, streamClosed: false, finalSamplesFenced: false }),
        release: async () => { events.push("release"); return base; }, abortStart: () => { events.push("abort-start"); },
        feed: () => {}, feedHole: () => {}, injectError: () => {},
      }; sessions.push(session); return session;
    } }, { mode: "synthetic", sampleRate: 16000, channels: 1 }), recovery: {
      latest: async () => token,
      save: async (value, context) => { events.push("save"); if (failSave) throw new Error("inert storage failure");
        audio = value; token = { id: randomUUID() }; return { generation: context.generation, attempt: context.attempt, token, durable: true }; },
      read: async (_token, context) => { assert.ok(audio); return { ...audio, generation: context.generation, attempt: context.attempt }; },
      remove: async (_token, context) => { events.push("remove"); token = null; return { generation: context.generation, attempt: context.attempt }; },
    } }),
    enumerate: async () => { events.push("enumerate"); return [{ id: "owned.monitor", name: "Owned source", isDefault: true }]; },
    infer: () => ({ transcribeWindow: async (model, samples, _language, vocabulary) => {
      assert.equal(samples.byteOffset, 0); assert.equal(samples.byteLength, samples.buffer.byteLength);
      inferred.push({ model: model.path, vocabulary }); events.push("infer"); return "COUNTRI";
    } }),
    delivery: { deliver: async (text, context) => {
      events.push("deliver"); assert.equal(text, "literal ✅"); if (deliveryLatch) await deliveryLatch.promise;
      return failDelivery ? { generation: context.generation, attempt: context.attempt, outcome: "failed", clipboardConfirmed: false }
        : { generation: context.generation, attempt: context.attempt, outcome: "clipboard", clipboardConfirmed: true };
    } },
    close: async () => { cleanup++; events.push("effects-close"); },
  };
  const runtime = new CaptureRuntime({ epoch, pid: 123, send: (reply) => { messages.push(reply);
    if (reply.kind === "control" && reply.command === "stop" && reply.reply.ok) events.push("stop-ack"); }, effects });
  const command = (name: Exclude<RecordingHostRequest["command"], "configure" | "enumerate-sources">) =>
    ({ version: 1 as const, channel: "recording-host" as const, epoch, id: randomUUID(), command: name });
  const configuration = (): RecordingConfiguration => ({ version: 1, channel: "recording-host", epoch, id: randomUUID(), command: "configure",
    capture: { bytes: 123, sha256: "a".repeat(64) }, server: "unix:/owned/runtime/pulse/native", source: "", recoveryPath: "/owned/recovery",
    request: structuredClone(request) });
  const last = () => messages.filter((message) => message.kind === "snapshot").at(-1)?.snapshot;
  async function terminal() {
    const until = performance.now() + 3000;
    while (!last() || last()?.busy) { if (performance.now() >= until) throw new Error("inert fixture deadline"); await turn(); }
    return last();
  }
  return { runtime, messages, events, effects, command, configuration, last, terminal, inferred, meta,
    token: () => token, cleanup: () => cleanup, savedAudio: () => audio,
    startHold: () => { startLatch = deferred<CaptureMetadata>(); return startLatch; },
    fenceHold: () => { fenceLatch = deferred<CaptureMetadata>(); return fenceLatch; },
    prepareHold: () => { preparationLatch = deferred<void>(); return preparationLatch; },
    deliveryHold: () => { deliveryLatch = deferred<void>(); return deliveryLatch; },
    failDelivery: (value: boolean) => { failDelivery = value; }, failSave: () => { failSave = true; },
  };
}
test("normal recording protocol separates host controls and metadata from inference/audio/native paths", () => {
  const f = fixture(), config = f.configuration(); recordingHostRequestSchema.parse(config);
  for (const changed of [{ ...config, binding: "/untrusted.node" }, { ...config, samples: new Float32Array(1) },
    { ...config, source: "@DEFAULT_SOURCE@" }, { ...config, server: "tcp:localhost" },
    { ...config, request: { ...config.request, model: { ...config.request.model, gpu: true } } },
    { ...config, channel: "effects" }]) assert.equal(recordingHostRequestSchema.safeParse(changed).success, false);
  const reply = f.messages[0]; assert.ok(reply); assert.equal(recordingHostReplySchema.safeParse({ ...reply, samples: new Float32Array(1) }).success, false);
  assert.deepEqual(f.events, []);
});
test("device-only epoch enumerates without model recovery stream creation or inference", async () => {
  const f = fixture(), config = f.configuration();
  await f.runtime.receive({ version: 1, channel: "recording-host", epoch: config.epoch, id: randomUUID(), command: "enumerate-sources",
    capture: config.capture, server: config.server });
  assert.deepEqual(f.events, ["enumerate"]); assert.equal(f.messages.at(-1)?.kind, "devices");
  await f.runtime.close(); assert.equal(f.cleanup(), 1);
});
test("shutdown retains late device enumeration until its original operation settles", async () => {
  const f = fixture(), held = deferred<readonly { id: string; name: string; isDefault: boolean }[]>(), config = f.configuration();
  f.effects.enumerate = async () => held.promise;
  const enumeration = f.runtime.receive({ version: 1, channel: "recording-host", epoch: config.epoch, id: randomUUID(),
    command: "enumerate-sources", capture: config.capture, server: config.server });
  await turn(); const close = f.runtime.close(); await turn(); assert.equal(f.cleanup(), 0);
  held.resolve([]); await enumeration; await close; assert.equal(f.cleanup(), 1);
});
test("shutdown retains initialization and never allocates a stream from its late result", async () => {
  const f = fixture(), prepared = await f.effects.prepare(f.configuration()), held = deferred<typeof prepared>();
  f.effects.prepare = async () => held.promise;
  const opening = f.runtime.receive(f.configuration()); await turn();
  const close = f.runtime.close(); await turn(); assert.equal(f.cleanup(), 0);
  held.resolve(prepared); await opening; await close; assert.equal(f.events.includes("create"), false); assert.equal(f.cleanup(), 1);
});
test("Stop acknowledgement follows final fence and precedes preparation and bounded inference", async () => {
  const f = fixture(); await f.runtime.receive(f.configuration()); assert.equal(f.events.length, 0);
  await f.runtime.receive(f.command("start")); const held = f.fenceHold(), stop = f.runtime.receive(f.command("stop"));
  await turn(); assert.equal(f.events.includes("stop-ack"), false); assert.equal(f.events.includes("prepare"), false);
  held.resolve(f.meta(1)); await stop; assert.ok(f.events.indexOf("fence") < f.events.indexOf("stop-ack"));
  const snapshot = await f.terminal(); assert.equal(snapshot?.phase, "done");
  assert.ok(f.events.indexOf("prepare") > f.events.indexOf("stop-ack")); assert.equal(f.token(), null);
  assert.equal(f.events.filter((event) => event === "release").length, 1); await f.runtime.close();
});
test("Start cancellation retains the original late native start and fences rollback before closing", async () => {
  const f = fixture(); await f.runtime.receive(f.configuration()); const latch = f.startHold();
  const start = f.runtime.receive(f.command("start")); await turn();
  const cancel = f.runtime.receive(f.command("cancel")); await turn();
  assert.equal(f.events.includes("fence"), false); assert.equal(f.events.includes("abort-start"), true);
  latch.resolve({ ...f.meta(1), running: true, streamClosed: false, finalSamplesFenced: false });
  await Promise.all([start, cancel]); assert.equal(f.events.filter((value) => value === "create").length, 1);
  assert.equal(f.events.includes("fence"), true); assert.equal(f.events.includes("release"), true); await f.runtime.close();
});
test("configuration captures model vocabulary and exact snippet bytes before user edits", async () => {
  const f = fixture(), config = f.configuration(); await f.runtime.receive(config);
  config.request.model.path = "/owned/models/later.bin"; config.request.vocabulary = "later";
  const snippet = config.request.snippets[0]; assert.ok(snippet); snippet.expansion = "changed";
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop")); await f.terminal();
  assert.deepEqual(f.inferred, [{ model: request.model.path, vocabulary: request.vocabulary }]); await f.runtime.close();
});
test("failed explicit delivery retains stopped audio and retry confirms output without another capture", async () => {
  const f = fixture(); f.failDelivery(true); await f.runtime.receive(f.configuration());
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop"));
  assert.equal((await f.terminal())?.error, "DELIVERY_FAILED"); assert.ok(f.token());
  f.failDelivery(false); await f.runtime.receive(f.command("retry")); assert.equal((await f.terminal())?.phase, "done");
  assert.equal(f.events.filter((value) => value === "create").length, 1); assert.equal(f.inferred.length, 1);
  assert.equal(f.events.filter((value) => value === "save").length, 1); assert.equal(f.token(), null); await f.runtime.close();
});
test("shutdown just after Stop completes private save before cancelling inference and preserves recovery", async () => {
  const f = fixture(), held = f.prepareHold(); await f.runtime.receive(f.configuration());
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop")); await turn();
  const closing = f.runtime.close(); assert.equal(f.runtime.close(), closing); await turn();
  assert.equal(f.cleanup(), 0); assert.equal(f.token(), null); held.resolve(); await closing;
  assert.ok(f.savedAudio()); assert.ok(f.token()); assert.equal(f.inferred.length, 0);
  assert.ok(f.events.indexOf("save") < f.events.indexOf("effects-close"));
});
test("shutdown cannot certify unsaved stopped RAM when private recovery commit failed", async () => {
  const f = fixture(); f.failSave(); await f.runtime.receive(f.configuration());
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop")); await f.terminal();
  const closing = f.runtime.close(); await assert.rejects(closing, { code: "TEARDOWN_FAILED" });
  assert.equal(f.runtime.close(), closing); assert.equal(f.cleanup(), 0); assert.equal(f.token(), null);
  assert.equal(f.events.includes("release"), false);
});
test("cancelled late delivery remains owned through confirmation and effect cleanup without deleting its WAV", async () => {
  const f = fixture(), delivery = f.deliveryHold(); await f.runtime.receive(f.configuration());
  await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop"));
  const until = performance.now() + 3000;
  while (!f.events.includes("deliver")) { assert.ok(performance.now() < until); await turn(); }
  const closing = f.runtime.close(); await turn(); assert.equal(f.cleanup(), 0); assert.ok(f.token());
  delivery.resolve(); await closing; assert.ok(f.token()); assert.equal(f.events.includes("remove"), false); assert.equal(f.cleanup(), 1);
});
test("duplicate or other-epoch controls refuse before capture and configuration cannot reset recovery", async () => {
  const f = fixture(), config = f.configuration(); await f.runtime.receive(config);
  await assert.rejects(f.runtime.receive(config), { code: "INVALID_FRAME" });
  await assert.rejects(f.runtime.receive({ ...f.command("start"), epoch: randomUUID() }), { code: "INVALID_FRAME" });
  await f.runtime.receive(f.configuration()); assert.equal(f.messages.at(-1)?.kind, "failed");
  assert.equal(f.events.includes("create"), false); await f.runtime.close();
});
test("recovery removal receipt follows the original matching remove completion", async () => {
  const f = fixture(), held = deferred<void>(), entered = deferred<void>();
  const original = f.effects.prepare;
  let removedToken: string | undefined;
  f.effects.prepare = async (configuration) => {
    const prepared = await original(configuration), remove = prepared.recovery.remove;
    return { ...prepared, recovery: { ...prepared.recovery, remove: async (token, context) => {
      removedToken = token.id; entered.resolve(); await held.promise;
      const result = await remove.call(prepared.recovery, token, context); f.events.push("original-remove-complete"); return result;
    } } };
  };
  await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop"));
  await entered.promise;
  assert.equal(f.messages.some((reply) => reply.kind === "recovery-removed"), false);
  assert.ok(f.token()); held.resolve(); assert.equal((await f.terminal())?.phase, "done");
  const receipts = f.messages.filter((reply) => reply.kind === "recovery-removed");
  assert.equal(receipts.length, 1); const receipt = receipts[0]; assert.ok(receipt);
  assert.equal(receipt.token, removedToken); assert.equal(receipt.epoch, f.configuration().epoch);
  assert.equal(receipt.generation, 1); assert.equal(receipt.attempt, 1);
  assert.equal(f.token(), null); assert.ok(f.events.includes("original-remove-complete")); await f.runtime.close();
});
test("rejected or mismatched recovery removal emits no receipt and retains pending ownership", async () => {
  for (const mode of ["reject", "mismatch"] as const) {
    const f = fixture(), original = f.effects.prepare;
    f.effects.prepare = async (configuration) => {
      const prepared = await original(configuration);
      return { ...prepared, recovery: { ...prepared.recovery, remove: async (_token, context) => {
        if (mode === "reject") throw new Error("inert remove failure");
        return { generation: context.generation + 1, attempt: context.attempt };
      } } };
    };
    await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop"));
    assert.equal((await f.terminal())?.error, "RECOVERY_REMOVE_FAILED"); assert.ok(f.token());
    assert.equal(f.messages.some((reply) => reply.kind === "recovery-removed"), false);
    assert.equal(f.events.includes("release"), false); await f.runtime.close();
  }
});
test("removal retry authorizes the actual prior confirmed delivery without another output commit", async () => {
  const f = fixture(), original = f.effects.prepare, contexts: { generation: number; attempt: number }[] = [];
  f.effects.prepare = async (configuration) => {
    const prepared = await original(configuration), remove = prepared.recovery.remove;
    return { ...prepared, recovery: { ...prepared.recovery, remove: async (token, context) => {
      contexts.push({ generation: context.generation, attempt: context.attempt });
      if (contexts.length === 1) throw new Error("inert first removal failure");
      return remove.call(prepared.recovery, token, context);
    } } };
  };
  await f.runtime.receive(f.configuration()); await f.runtime.receive(f.command("start")); await f.runtime.receive(f.command("stop"));
  assert.equal((await f.terminal())?.error, "RECOVERY_REMOVE_FAILED"); assert.ok(f.token());
  assert.equal(f.messages.some((reply) => reply.kind === "recovery-removed"), false);
  await f.runtime.receive(f.command("retry")); assert.equal((await f.terminal())?.phase, "done");
  assert.deepEqual(contexts, [{ generation: 1, attempt: 1 }, { generation: 1, attempt: 2 }]);
  assert.equal(f.events.filter((event) => event === "deliver").length, 1);
  const receipt = f.messages.find((reply) => reply.kind === "recovery-removed"); assert.ok(receipt);
  assert.equal(receipt.generation, 1); assert.equal(receipt.attempt, 1); assert.equal(f.token(), null); await f.runtime.close();
});

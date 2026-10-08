import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { RecordingCoordinator, recordingRequestSchema } from "../src/core/recording.js";
import type {
  CaptureCallbacks, CapturedHandle, CaptureFinalization, CaptureSession, ControlReply,
  DeliveryReceipt, Ownership, PreparedAudio, RecordingOptions, RecordingRequest,
  RecoveryBoundary, RecoverySaved, RecoveryToken, SpeechResult, WorkContext,
} from "../src/core/recording.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const request: RecordingRequest = {
  model: { path: "/owned/fixture-model.bin", family: "whisper", gpu: false },
  language: "de", vocabulary: "Unchanged 日本語 👩‍💻", snippets: [],
};
const ownership = (context: Ownership): Ownership => ({ generation: context.generation, attempt: context.attempt });
interface Samples extends CapturedHandle { readonly chunks: readonly Float32Array[] }
function audio(chunks: readonly Float32Array[], context: Ownership): PreparedAudio {
  return { ...ownership(context), sampleRate: 16000, sampleCount: chunks.reduce((n, chunk) => n + chunk.length, 0), chunks };
}
function copied(context: Ownership): DeliveryReceipt {
  return { ...ownership(context), outcome: "clipboard", clipboardConfirmed: true };
}

class OwnedCapture implements CaptureSession<Samples> {
  chunks: Float32Array[] = [new Float32Array([0.25, -0.25, 0.5])];
  live = false;
  starts = 0;
  closes = 0;
  preparations = 0;
  startGate: (() => Promise<void>) | undefined;
  closeGate: (() => Promise<CaptureFinalization<Samples>>) | undefined;
  prepareGate: ((captured: Samples, context: WorkContext) => Promise<PreparedAudio>) | undefined;
  finalError: "capture_failed" | null = null;
  streamClosed = true;
  fenced = true;
  appendFinal = false;
  constructor(readonly callbacks: CaptureCallbacks, private readonly events: string[]) {}
  async start(_signal: AbortSignal): Promise<void> {
    this.starts++; this.events.push("start");
    await this.startGate?.(); this.live = true;
  }
  async closeAndFence(): Promise<CaptureFinalization<Samples>> {
    this.closes++; this.events.push("close");
    if (this.closeGate) return this.closeGate();
    if (this.streamClosed) this.live = false;
    if (this.appendFinal) this.chunks.push(new Float32Array([0.75]));
    this.events.push("fence");
    return { generation: this.callbacks.generation, streamClosed: this.streamClosed,
      finalSamplesFenced: this.fenced, error: this.finalError,
      captured: { generation: this.callbacks.generation, chunks: [...this.chunks] } };
  }
  async prepare(captured: Samples, context: WorkContext): Promise<PreparedAudio> {
    this.preparations++; this.events.push("prepare");
    if (this.prepareGate) return this.prepareGate(captured, context);
    return audio(captured.chunks, context);
  }
}

class OwnedRecovery implements RecoveryBoundary {
  readonly records = new Map<string, PreparedAudio>();
  saves = 0;
  reads = 0;
  removals = 0;
  saveGate: ((samples: PreparedAudio, context: WorkContext) => Promise<RecoverySaved>) | undefined;
  readGate: ((token: RecoveryToken, context: WorkContext) => Promise<PreparedAudio>) | undefined;
  removeGate: ((token: RecoveryToken, context: WorkContext) => Promise<Ownership>) | undefined;
  constructor(private readonly events: string[]) {}
  async latest(): Promise<RecoveryToken | null> {
    const id = this.records.keys().next().value;
    return id === undefined ? null : { id };
  }
  async save(samples: PreparedAudio, context: WorkContext): Promise<RecoverySaved> {
    this.saves++; this.events.push("save");
    if (this.saveGate) return this.saveGate(samples, context);
    const token = { id: `owned-${this.saves}` }; this.records.set(token.id, samples);
    return { ...ownership(context), token };
  }
  async read(token: RecoveryToken, context: WorkContext): Promise<PreparedAudio> {
    this.reads++; this.events.push("read");
    if (this.readGate) return this.readGate(token, context);
    const found = this.records.get(token.id);
    if (!found) throw new Error("Owned record absent");
    return { ...found, ...ownership(context) };
  }
  async remove(token: RecoveryToken, context: WorkContext): Promise<Ownership> {
    this.removals++; this.events.push("remove");
    if (this.removeGate) return this.removeGate(token, context);
    this.records.delete(token.id); return ownership(context);
  }
}

function fixture(platform: "macos" | "linux" = "linux", recoveryStore?: OwnedRecovery) {
  const events: string[] = [];
  const sessions: OwnedCapture[] = [];
  const recovery = recoveryStore ?? new OwnedRecovery(events);
  let time = 0;
  let speechCalls = 0;
  let deliveryCalls = 0;
  let configure: ((capture: OwnedCapture) => void) | undefined;
  let speechHook: ((samples: PreparedAudio, input: RecordingRequest, context: WorkContext) => Promise<SpeechResult>) | undefined;
  let deliveryHook: ((text: string, context: WorkContext) => Promise<DeliveryReceipt>) | undefined;
  const common = {
    clock: { now: () => time },
    capture: { create(callbacks: CaptureCallbacks) {
      const session = new OwnedCapture(callbacks, events); configure?.(session); sessions.push(session); return session;
    } },
    speech: { async transcribe(samples: PreparedAudio, input: RecordingRequest, context: WorkContext) {
      speechCalls++; events.push("speech");
      if (speechHook) return speechHook(samples, input, context);
      return { ...ownership(context), text: "  Unchanged fixture 日本語 👩‍💻  " };
    } },
    delivery: { async deliver(text: string, context: WorkContext) {
      deliveryCalls++; events.push("delivery");
      if (deliveryHook) return deliveryHook(text, context);
      return copied(context);
    } },
  };
  const options: RecordingOptions<Samples> = platform === "linux"
    ? { ...common, platform, recovery } : { ...common, platform };
  const coordinator = new RecordingCoordinator(options);
  return {
    coordinator, options, events, sessions, recovery,
    setTime: (value: number) => { time = value; },
    configure: (hook: (session: OwnedCapture) => void) => { configure = hook; },
    speech: (hook: NonNullable<typeof speechHook>) => { speechHook = hook; },
    delivery: (hook: NonNullable<typeof deliveryHook>) => { deliveryHook = hook; },
    counts: () => ({ speech: speechCalls, delivery: deliveryCalls }),
    capture: () => { const value = sessions.at(-1); assert.ok(value); return value; },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let step = 0; step < 30; step++) {
    if (condition()) return;
    await setImmediate();
  }
  assert.fail("Owned deferred boundary did not reach its expected stage");
}

test("Stop closes, checks errors and fences final samples before acknowledgement and preparation", async () => {
  const f = fixture(); f.configure((session) => { session.appendFinal = true; });
  let received = 0;
  f.speech(async (samples, input, context) => {
    received = samples.sampleCount;
    assert.deepEqual(samples.chunks.map((chunk) => [...chunk]), [[0.25, -0.25, 0.5], [0.75]]);
    assert.deepEqual(input, request); return { ...ownership(context), text: "Complete final sample" };
  });
  assert.equal((await f.coordinator.start(request)).ok, true);
  const stopped = await f.coordinator.stop((reply) => {
    assert.equal(reply.ok, true); assert.equal(f.capture().live, false);
    assert.equal(f.capture().preparations, 0); f.events.push("ack"); return true;
  });
  assert.equal(stopped.ok, true);
  assert.equal(f.capture().preparations, 0);
  await f.coordinator.completion();
  assert.deepEqual(f.events, ["start", "close", "fence", "ack", "prepare", "save", "speech", "delivery", "remove"]);
  assert.equal(received, 4); assert.equal(f.coordinator.snapshot().phase, "done");
  assert.equal(f.coordinator.snapshot().recoveryAvailable, false);
});

test("clock and complete chunk ledger exceed one hour without cutoff or truncation", async () => {
  const f = fixture();
  const second = new Float32Array(16000).fill(0.25);
  const tail = new Float32Array(17).fill(-0.5);
  // Shared read-only fixture chunks represent a full logical recording without a 230 MB allocation.
  const chunks = [...Array.from({ length: 3601 }, () => second), tail];
  f.configure((session) => { session.chunks = chunks; });
  f.speech(async (samples, _input, context) => {
    assert.equal(samples.sampleCount, 3601 * 16000 + 17);
    assert.equal(samples.chunks.length, 3602); assert.strictEqual(samples.chunks.at(-1), tail);
    return { ...ownership(context), text: "Full synthetic ledger retained" };
  });
  await f.coordinator.start(request); f.setTime(3_601_001.0625);
  const snapshot = f.coordinator.snapshot();
  assert.equal(snapshot.phase, "recording"); assert.equal(snapshot.elapsedMs, 3_601_001.0625);
  assert.equal(f.capture().closes, 0); assert.equal(f.capture().live, true);
  await f.coordinator.stop(); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().elapsedMs, 3_601_001.0625);
  assert.equal(f.coordinator.snapshot().phase, "done");
});

test("start failure and unreceived acknowledgement roll back every opened capture", async () => {
  for (const failure of ["native", "acknowledgement"] as const) {
    const f = fixture();
    if (failure === "native") f.configure((session) => {
      session.startGate = async () => { session.live = true; throw new Error("Sensitive native details"); };
    });
    let replies = 0;
    const result = await f.coordinator.start(request, { acknowledge: () => { replies++; return failure !== "acknowledgement"; } });
    assert.equal(result.ok, false); assert.equal(replies, 1);
    assert.equal(f.capture().closes, 1); assert.equal(f.capture().live, false);
    assert.equal(f.capture().preparations, 0); assert.equal(f.coordinator.snapshot().busy, false);
    assert.equal(f.coordinator.snapshot().recoveryAvailable, false);
    assert.equal(JSON.stringify(f.coordinator.snapshot()).includes("Sensitive native details"), false);
  }
});

test("expired caller cannot open a stream and cancellation fences an in-flight start before replying", async () => {
  const expired = fixture(); const deadline = new AbortController(); deadline.abort();
  assert.equal((await expired.coordinator.start(request, { signal: deadline.signal, acknowledge: () => true })).ok, false);
  assert.equal(expired.sessions.length, 0);
  const f = fixture(); const gate = deferred<void>();
  f.configure((session) => { session.startGate = () => gate.promise; });
  const starting = f.coordinator.start(request);
  await until(() => f.sessions.length === 1);
  let acknowledged = false;
  const cancelled = f.coordinator.cancel(() => { acknowledged = true; return true; });
  await setImmediate(); assert.equal(acknowledged, false);
  assert.equal((await f.coordinator.start(request)).ok, false);
  gate.resolve(); assert.equal((await starting).ok, false); assert.equal((await cancelled).ok, true);
  assert.equal(acknowledged, true); assert.equal(f.capture().live, false);
  assert.equal(f.capture().closes, 1); assert.equal(f.coordinator.snapshot().busy, false);
});

test("failed closure or fence cannot acknowledge Stop success or free a live capture", async () => {
  for (const failure of ["stream", "fence", "ownership"] as const) {
    const f = fixture(); await f.coordinator.start(request);
    const session = f.capture();
    if (failure === "stream") session.streamClosed = false;
    if (failure === "fence") session.fenced = false;
    if (failure === "ownership") session.closeGate = async () => ({ generation: 999,
      streamClosed: true, finalSamplesFenced: true, error: null, captured: { generation: 999, chunks: session.chunks } });
    const replies: ControlReply[] = [];
    assert.equal((await f.coordinator.stop((reply) => { replies.push(reply); return true; })).ok, false);
    assert.equal(replies[0]?.ok, false); assert.equal(f.coordinator.snapshot().busy, true);
    assert.equal(session.preparations, 0); assert.equal((await f.coordinator.start(request)).ok, false);
    session.streamClosed = true; session.fenced = true; session.closeGate = undefined;
    assert.equal((await f.coordinator.cancel()).ok, true);
    assert.equal(f.coordinator.snapshot().busy, false);
  }
});

test("capture error is an explicit failed Stop reply and salvaged audio remains for retry", async () => {
  const f = fixture(); await f.coordinator.start(request); f.capture().finalError = "capture_failed";
  const reply = await f.coordinator.stop();
  assert.deepEqual(reply, { ok: false, generation: 1, error: "CAPTURE_FAILED" });
  await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().recoveryAvailable, true); assert.equal(f.recovery.records.size, 1);
  assert.equal(f.counts().speech, 0); assert.equal(f.coordinator.snapshot().error, "CAPTURE_FAILED");
  assert.equal(f.coordinator.retry().ok, true); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().phase, "done"); assert.equal(f.recovery.records.size, 0);
});

test("failed recording cancellation preserves captured audio instead of discarding it", async () => {
  const f = fixture(); await f.coordinator.start(request); f.capture().finalError = "capture_failed";
  assert.equal((await f.coordinator.cancel()).ok, false); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().recoveryAvailable, true); assert.equal(f.recovery.records.size, 1);
  assert.equal((await f.coordinator.discardRecovery()).ok, true);
  assert.equal(f.recovery.records.size, 0); assert.equal(f.coordinator.snapshot().phase, "idle");
});

test("old level and device-error callbacks cannot stop or modify a later generation", async () => {
  const f = fixture(); await f.coordinator.start(request); const old = f.capture();
  old.callbacks.onLevel(old.callbacks.generation, 0.6); assert.equal(f.coordinator.snapshot().level, 0.6);
  await f.coordinator.cancel(); await f.coordinator.start(request); const current = f.capture();
  current.callbacks.onLevel(current.callbacks.generation, 0.2);
  old.callbacks.onLevel(old.callbacks.generation, 1); old.callbacks.onError(old.callbacks.generation);
  current.callbacks.onLevel(old.callbacks.generation, 1); current.callbacks.onError(old.callbacks.generation);
  assert.equal(f.coordinator.snapshot().phase, "recording"); assert.equal(f.coordinator.snapshot().level, 0.2);
  assert.equal(current.closes, 0); await f.coordinator.cancel();
});

test("stale preparation and speech results cannot deliver or affect the next recording", async () => {
  for (const stage of ["prepare", "speech"] as const) {
    const f = fixture(); const gate = deferred<PreparedAudio | SpeechResult>();
    let context: WorkContext | undefined;
    if (stage === "prepare") f.configure((session) => {
      session.prepareGate = async (_captured, received) => {
        context = received; const result = await gate.promise;
        if (!("chunks" in result)) throw new Error("Wrong owned fixture result"); return result;
      };
    });
    else f.speech(async (_samples, _request, received) => {
      context = received; const result = await gate.promise;
      if (!("text" in result)) throw new Error("Wrong owned fixture result"); return result;
    });
    await f.coordinator.start(request); await f.coordinator.stop(); const oldDone = f.coordinator.completion();
    await until(() => context !== undefined); assert.ok(context);
    await f.coordinator.cancel(); assert.equal(f.coordinator.snapshot().recoveryAvailable, true);
    await f.coordinator.discardRecovery(); await f.coordinator.start(request);
    const before = f.coordinator.snapshot();
    gate.resolve(stage === "prepare" ? audio([new Float32Array([1])], context) : { ...ownership(context), text: "Stale text" });
    await oldDone;
    assert.deepEqual(f.coordinator.snapshot(), before); assert.equal(f.counts().delivery, 0);
    await f.coordinator.cancel();
  }
});

test("preparation, private save and speech failures retain complete samples for explicit retry", async () => {
  for (const stage of ["prepare", "save", "speech"] as const) {
    const f = fixture();
    if (stage === "prepare") f.configure((session) => { session.prepareGate = async () => { throw new Error("Owned failure"); }; });
    if (stage === "save") f.recovery.saveGate = async () => { throw new Error("Owned full disk"); };
    if (stage === "speech") f.speech(async () => { throw new Error("Owned worker crash"); });
    await f.coordinator.start(request); await f.coordinator.stop(); await f.coordinator.completion();
    assert.equal(f.coordinator.snapshot().phase, "error"); assert.equal(f.coordinator.snapshot().recoveryAvailable, true);
    assert.equal(f.counts().delivery, 0); assert.equal((await f.coordinator.start(request)).ok, false);
    f.capture().prepareGate = undefined; f.recovery.saveGate = undefined;
    f.speech(async (samples, _input, context) => {
      assert.equal(samples.sampleCount, 3); return { ...ownership(context), text: "Retained complete samples" };
    });
    assert.equal(f.coordinator.retry().ok, true); await f.coordinator.completion();
    assert.equal(f.coordinator.snapshot().phase, "done"); assert.equal(f.coordinator.snapshot().recoveryAvailable, false);
  }
});

test("delivery failure retains Linux audio and retry reuses text without duplicate inference", async () => {
  const f = fixture(); f.delivery(async (_text, context) => ({ ...ownership(context), outcome: "failed", clipboardConfirmed: false }));
  await f.coordinator.start(request); await f.coordinator.stop(); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().error, "DELIVERY_FAILED"); assert.equal(f.recovery.records.size, 1);
  assert.deepEqual(f.counts(), { speech: 1, delivery: 1 });
  f.delivery(async (text, context) => { assert.equal(text, "  Unchanged fixture 日本語 👩‍💻  "); return copied(context); });
  f.coordinator.retry(); await f.coordinator.completion();
  assert.deepEqual(f.counts(), { speech: 1, delivery: 2 }); assert.equal(f.recovery.records.size, 0);
  assert.equal(f.coordinator.snapshot().transcript, "  Unchanged fixture 日本語 👩‍💻  ");
});

test("confirmed delivery is not repeated when recovery cleanup fails", async () => {
  const f = fixture(); f.recovery.removeGate = async () => { throw new Error("Owned removal failure"); };
  await f.coordinator.start(request); await f.coordinator.stop(); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().error, "RECOVERY_REMOVE_FAILED"); assert.equal(f.recovery.records.size, 1);
  f.recovery.removeGate = undefined; f.coordinator.retry(); await f.coordinator.completion();
  assert.deepEqual(f.counts(), { speech: 1, delivery: 1 }); assert.equal(f.recovery.records.size, 0);
});

test("cancel during save keeps its late owned token and concurrent retry shares one atomic save", async () => {
  const f = fixture(); const gate = deferred<RecoverySaved>(); let context: WorkContext | undefined;
  f.recovery.saveGate = async (samples, received) => { context = received; f.recovery.records.set("late", samples); return gate.promise; };
  await f.coordinator.start(request); await f.coordinator.stop(); const oldDone = f.coordinator.completion();
  await until(() => context !== undefined); assert.ok(context);
  await f.coordinator.cancel(); assert.equal(f.coordinator.snapshot().recoveryAvailable, true);
  assert.equal(f.coordinator.retry().ok, true); const retryDone = f.coordinator.completion();
  await setImmediate(); assert.equal(f.recovery.saves, 1);
  gate.resolve({ ...ownership(context), token: { id: "late" } });
  await Promise.all([oldDone, retryDone]);
  assert.equal(f.coordinator.snapshot().phase, "done"); assert.equal(f.recovery.records.size, 0);
  assert.deepEqual(f.counts(), { speech: 1, delivery: 1 });
});

test("cancel and retry share a pending delivery receipt instead of committing twice", async () => {
  const f = fixture(); const gate = deferred<DeliveryReceipt>(); let context: WorkContext | undefined;
  f.delivery(async (_text, received) => { context = received; return gate.promise; });
  await f.coordinator.start(request); await f.coordinator.stop(); const oldDone = f.coordinator.completion();
  await until(() => context !== undefined); assert.ok(context);
  await f.coordinator.cancel(); f.coordinator.retry(); const retryDone = f.coordinator.completion();
  await setImmediate(); assert.equal(f.counts().delivery, 1);
  gate.resolve(copied(context)); await Promise.all([oldDone, retryDone]);
  assert.equal(f.coordinator.snapshot().phase, "done"); assert.equal(f.counts().delivery, 1);
});

test("discard waits for owned save and delivery cleanup before releasing a later generation", async () => {
  for (const stage of ["save", "delivery"] as const) {
    const f = fixture(); const saveGate = deferred<RecoverySaved>(); const deliveryGate = deferred<DeliveryReceipt>();
    let context: WorkContext | undefined;
    if (stage === "save") f.recovery.saveGate = async (samples, received) => {
      context = received; f.recovery.records.set("owned-late", samples); return saveGate.promise;
    };
    else f.delivery(async (_text, received) => { context = received; return deliveryGate.promise; });
    await f.coordinator.start(request); await f.coordinator.stop(); const oldDone = f.coordinator.completion();
    await until(() => context !== undefined); assert.ok(context);
    const discarded = f.coordinator.discardRecovery(); await setImmediate();
    assert.equal(f.coordinator.snapshot().phase, "discarding"); assert.equal((await f.coordinator.start(request)).ok, false);
    if (stage === "save") saveGate.resolve({ ...ownership(context), token: { id: "owned-late" } });
    else deliveryGate.resolve(copied(context));
    assert.equal((await discarded).ok, true); await oldDone;
    assert.equal(f.recovery.records.size, 0); assert.equal(f.coordinator.snapshot().recoveryAvailable, false);
    await f.coordinator.start(request); assert.equal(f.coordinator.snapshot().generation, 2); await f.coordinator.cancel();
  }
});

test("Linux restart finds retained audio before opening capture and retries from private storage", async () => {
  const old = fixture(); old.speech(async () => { throw new Error("Owned worker crash"); });
  await old.coordinator.start(request); await old.coordinator.stop(); await old.coordinator.completion();
  assert.equal(old.recovery.records.size, 1);
  const restarted = fixture("linux", old.recovery);
  assert.deepEqual(await restarted.coordinator.start(request), { ok: false, generation: 1, error: "RECOVERY_PENDING" });
  assert.equal(restarted.sessions.length, 0); assert.equal(restarted.coordinator.snapshot().recoveryAvailable, true);
  restarted.coordinator.retry(); await restarted.coordinator.completion();
  assert.equal(restarted.coordinator.snapshot().phase, "done"); assert.equal(old.recovery.reads, 1);
  assert.equal(old.recovery.records.size, 0);
});

test("restored read or explicit discard failure never erases the recovery record", async () => {
  const f = fixture(); f.recovery.records.set("owned-existing", audio([new Float32Array([0.5])], { generation: 99, attempt: 1 }));
  assert.equal(await f.coordinator.restoreRecovery(request), true);
  f.recovery.readGate = async () => { throw new Error("Owned read failure"); };
  f.coordinator.retry(); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().error, "RECOVERY_READ_FAILED"); assert.equal(f.recovery.records.size, 1);
  f.recovery.removeGate = async () => { throw new Error("Owned discard failure"); };
  assert.equal((await f.coordinator.discardRecovery()).ok, false);
  assert.equal(f.coordinator.snapshot().recoveryAvailable, true); assert.equal(f.recovery.records.size, 1);
  f.recovery.removeGate = undefined; assert.equal((await f.coordinator.discardRecovery()).ok, true);
});

test("Mac failure recovery remains in RAM and editor delivery does not introduce disk retention", async () => {
  const f = fixture("macos"); f.speech(async () => { throw new Error("Owned failure"); });
  await f.coordinator.start(request); await f.coordinator.stop(); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().recoveryAvailable, true); assert.equal(f.recovery.saves, 0);
  f.speech(async (_samples, _input, context) => ({ ...ownership(context), text: "RAM recovery" }));
  f.delivery(async (_text, context) => ({ ...ownership(context), outcome: "editor", clipboardConfirmed: false }));
  f.coordinator.retry(); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().phase, "done"); assert.equal(f.recovery.saves, 0);
  // @ts-expect-error macOS must not accept a disk recovery boundary.
  assert.throws(() => new RecordingCoordinator({ ...f.options, platform: "macos", recovery: f.recovery }), /remain in memory/);
});

test("wrong prepare speech or delivery ownership cannot publish text or delete Linux recovery", async () => {
  for (const stage of ["prepare", "speech", "delivery"] as const) {
    const f = fixture();
    if (stage === "prepare") f.configure((session) => { session.prepareGate = async (captured, context) => audio(captured.chunks, { ...context, generation: 500 }); });
    if (stage === "speech") f.speech(async (_samples, _input, context) => ({ ...context, attempt: context.attempt + 1, text: "Foreign result" }));
    if (stage === "delivery") f.delivery(async (_text, context) => copied({ ...context, generation: 500 }));
    await f.coordinator.start(request); await f.coordinator.stop(); await f.coordinator.completion();
    assert.equal(f.coordinator.snapshot().phase, "error"); assert.equal(f.coordinator.snapshot().transcript, "");
    assert.equal(f.coordinator.snapshot().recoveryAvailable, true); assert.equal(f.recovery.removals, 0);
  }
});

test("capture errors during the final fence cannot turn into a successful Stop acknowledgement", async () => {
  const f = fixture(); const gate = deferred<CaptureFinalization<Samples>>();
  await f.coordinator.start(request); const capture = f.capture();
  capture.closeGate = () => gate.promise;
  const stopping = f.coordinator.stop();
  await setImmediate(); capture.callbacks.onError(capture.callbacks.generation);
  gate.resolve({ generation: capture.callbacks.generation, streamClosed: true, finalSamplesFenced: true,
    error: null, captured: { generation: capture.callbacks.generation, chunks: capture.chunks } });
  assert.equal((await stopping).ok, false);
  assert.equal(f.coordinator.snapshot().error, "CAPTURE_FAILED");
  await f.coordinator.completion();
  assert.equal(f.recovery.records.size, 1); assert.equal(f.counts().speech, 0);
});

test("request snapshots retain Parakeet, manual CPU and original multilingual options", async () => {
  const f = fixture(); const input = {
    model: { path: "/owned/parakeet.bin", family: "parakeet" as const, gpu: false },
    language: "de", vocabulary: "Original 日本語 👩‍💻",
    snippets: [{ id: "mac-draft", trigger: "", expansion: "  Unchanged 日本語 👩‍💻\n", enabled: false }],
  };
  f.speech(async (_samples, received, context) => {
    assert.deepEqual(received, { model: { path: "/owned/parakeet.bin", family: "parakeet", gpu: false },
      language: "de", vocabulary: "Original 日本語 👩‍💻",
      snippets: [{ id: "mac-draft", trigger: "", expansion: "  Unchanged 日本語 👩‍💻\n", enabled: false }] });
    assert.ok(Object.isFrozen(received)); assert.ok(Object.isFrozen(received.model));
    assert.ok(Object.isFrozen(received.snippets)); assert.ok(Object.isFrozen(received.snippets[0]));
    return { ...ownership(context), text: "Unchanged processed fixture" };
  });
  await f.coordinator.start(input); input.model.gpu = true; input.model.path = "/owned/edited-model.bin";
  input.language = "en"; input.vocabulary = "Edited later";
  input.snippets.splice(0, 1, { id: "new", trigger: "edited", expansion: "Edited later", enabled: true });
  await f.coordinator.stop(); await f.coordinator.completion();
  assert.equal(f.coordinator.snapshot().phase, "done");
  const withoutSnippets = { model: request.model, language: request.language, vocabulary: request.vocabulary };
  assert.deepEqual(recordingRequestSchema.parse(withoutSnippets).snippets, []);
});

test("duplicate concurrent Stop requests finalize and deliver a recording only once", async () => {
  const f = fixture(); await f.coordinator.start(request);
  const replies = await Promise.all([f.coordinator.stop(), f.coordinator.stop()]);
  assert.equal(replies.filter((reply) => reply.ok).length, 1);
  await f.coordinator.completion();
  assert.equal(f.capture().closes, 1); assert.equal(f.capture().preparations, 1);
  assert.deepEqual(f.counts(), { speech: 1, delivery: 1 });
});

test("cancellation and retry share pending recovery removal without duplicate delivery or deletion", async () => {
  const f = fixture(); const gate = deferred<Ownership>(); let context: WorkContext | undefined;
  let token: RecoveryToken | undefined;
  f.recovery.removeGate = async (receivedToken, received) => { context = received; token = receivedToken; return gate.promise; };
  await f.coordinator.start(request); await f.coordinator.stop(); const oldDone = f.coordinator.completion();
  await until(() => context !== undefined); assert.ok(context); assert.ok(token);
  await f.coordinator.cancel(); f.coordinator.retry(); const retryDone = f.coordinator.completion();
  await setImmediate(); assert.equal(f.recovery.removals, 1);
  f.recovery.records.delete(token.id); gate.resolve(ownership(context));
  await Promise.all([oldDone, retryDone]);
  assert.equal(f.coordinator.snapshot().phase, "done"); assert.equal(f.recovery.records.size, 0);
  assert.deepEqual(f.counts(), { speech: 1, delivery: 1 });
});

test("malformed sample coverage and empty speech results preserve audio without delivery", async () => {
  for (const failure of ["coverage", "empty"] as const) {
    const f = fixture();
    if (failure === "coverage") f.configure((session) => {
      session.prepareGate = async (captured, context) => ({ ...audio(captured.chunks, context), sampleCount: 999 });
    });
    else f.speech(async (_samples, _request, context) => ({ ...ownership(context), text: "  \n " }));
    await f.coordinator.start(request); await f.coordinator.stop(); await f.coordinator.completion();
    assert.equal(f.coordinator.snapshot().phase, "error"); assert.equal(f.coordinator.snapshot().recoveryAvailable, true);
    assert.equal(f.counts().delivery, 0); assert.equal(f.recovery.removals, 0);
  }
});

test("unknown or contradictory native delivery receipts cannot report success", async () => {
  for (const malformed of ["unknown", "unconfirmed"] as const) {
    const f = fixture("macos");
    if (malformed === "unknown") {
      // @ts-expect-error Exercise a malformed result from a native boundary.
      f.delivery(async (_text, context) => ({ ...ownership(context), outcome: "unknown", clipboardConfirmed: true }));
    } else {
      // @ts-expect-error A paste outcome cannot claim an unconfirmed clipboard.
      f.delivery(async (_text, context) => ({ ...ownership(context), outcome: "paste", clipboardConfirmed: false }));
    }
    await f.coordinator.start(request); await f.coordinator.stop(); await f.coordinator.completion();
    assert.equal(f.coordinator.snapshot().error, "DELIVERY_FAILED");
    assert.equal(f.coordinator.snapshot().recoveryAvailable, true); assert.equal(f.coordinator.snapshot().transcript, "");
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { connectFixtureSpeechChannel, type FixtureSpeechProcess } from "../fixtures/speech-bootstrap-channel.js";
import { createSpeechBootstrap } from "../../src/workers/speech/speech-bootstrap.js";
import { SpeechClient, SpeechWorkerError } from "../../src/services/speech/speech-client.js";
import { speechChallengeRequestSchema } from "../../src/workers/speech/speech-control.js";

type Fault = "none" | "wrong-nonce" | "wrong-epoch" | "wrong-pid" | "extra" | "duplicate" | "ordinary" | "hold";
class InertProcess implements FixtureSpeechProcess {
  readonly messages = new Set<(input: unknown) => void>();
  readonly spawns = new Set<() => void>();
  readonly errors = new Set<() => void>();
  readonly exits = new Set<() => void>();
  readonly frames: unknown[] = [];
  bindingLoads = 0;
  kills = 0;
  readonly epoch = randomUUID();
  fault: Fault = "none";
  synchronousReady = false;
  readonly kernel = createSpeechBootstrap({ binding: "/owned/native.node", epoch: this.epoch, pid: 321,
    load: () => { this.bindingLoads += 1; return { gpuDevice: () => null, load: () => {}, transcribe: () => "Café 東京", shutdown: () => {} }; } });
  pid(): number { return 321; }
  emit(input: unknown): void { for (const listener of this.messages) listener(input); }
  postMessage(input: unknown): void {
    this.frames.push(input);
    const challenge = speechChallengeRequestSchema.safeParse(input);
    if (challenge.success) {
      if (this.fault === "hold") return;
      const reply = { version: 1, epoch: this.fault === "wrong-epoch" ? randomUUID() : this.epoch,
        nonce: this.fault === "wrong-nonce" ? randomUUID() : challenge.data.nonce, pid: this.fault === "wrong-pid" ? 999 : this.pid() };
      this.kernel.receive(input);
      queueMicrotask(() => {
        this.emit(this.fault === "extra" ? { ...reply, extra: "private" } : this.fault === "ordinary"
          ? { version: 1, id: randomUUID(), ok: true, value: { command: "discover", gpu: null } } : reply);
        if (this.fault === "duplicate") this.emit(reply);
      });
    } else queueMicrotask(() => { this.emit(this.kernel.receive(input)); });
  }
  kill(): void { this.kills += 1; queueMicrotask(() => { for (const listener of this.exits) listener(); }); }
  onMessage(listener: (input: unknown) => void): () => void {
    this.messages.add(listener);
    if (this.synchronousReady) this.emit(this.kernel.ready); else queueMicrotask(() => { this.emit(this.kernel.ready); });
    return () => { this.messages.delete(listener); };
  }
  onSpawn(listener: () => void): () => void { this.spawns.add(listener); return () => { this.spawns.delete(listener); }; }
  onError(listener: () => void): () => void { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  onExit(listener: () => void): void { this.exits.add(listener); }
}
const failure = (expected: string) => (error: unknown) => error instanceof SpeechWorkerError && error.code === expected;

for (const early of [false, true]) test(`fixture separates private replies and buffers only ready (${early ? "synchronous" : "queued"})`, async () => {
  const owned = new InertProcess(); owned.synchronousReady = early;
  const channel = await connectFixtureSpeechChannel(owned, owned.epoch, new AbortController().signal);
  assert.equal(owned.frames.length, 2); assert.equal(owned.bindingLoads, 0);
  const controls = owned.frames.map((value) => speechChallengeRequestSchema.parse(value));
  assert.equal(new Set(controls.map((value) => value.nonce)).size, 2);
  const client = new SpeechClient(async () => channel);
  assert.equal(await client.gpuDevice(), null); assert.equal(owned.bindingLoads, 1);
  await client.close(); assert.equal(owned.kills, 1); assert.equal(owned.messages.size, 0);
});

for (const fault of ["wrong-nonce", "wrong-epoch", "wrong-pid", "extra", "duplicate", "ordinary"] as const) {
  test(`fixture refuses ${fault} handshake with zero native load or ordinary work`, async () => {
    const owned = new InertProcess(); owned.fault = fault;
    await assert.rejects(connectFixtureSpeechChannel(owned, owned.epoch, new AbortController().signal), failure("INVALID_REPLY"));
    assert.equal(owned.bindingLoads, 0); assert.equal(owned.frames.length, 1); assert.equal(owned.kills, 1);
    assert.equal(owned.messages.size, 0);
  });
}

test("fixture abort during a held challenge rejects after its historical exit cleanup without exposing an ordinary channel", async () => {
  const owned = new InertProcess(); owned.fault = "hold";
  const controller = new AbortController();
  const pending = connectFixtureSpeechChannel(owned, owned.epoch, controller.signal);
  const rejected = assert.rejects(pending, failure("CANCELLED"));
  await nextTurn(); assert.equal(owned.frames.length, 1); controller.abort(); await rejected;
  assert.equal(owned.bindingLoads, 0); assert.equal(owned.kills, 1);
  owned.emit({ version: 1, epoch: owned.epoch, nonce: randomUUID(), pid: 321 });
  assert.equal(owned.frames.length, 1);
});

test("duplicate readiness after the control handshake cannot reach ordinary listeners", async () => {
  const owned = new InertProcess();
  const channel = await connectFixtureSpeechChannel(owned, owned.epoch, new AbortController().signal);
  const received: unknown[] = []; channel.onMessage((input) => { received.push(input); });
  await nextTurn(); assert.deepEqual(received, [{ version: 1, type: "ready" }]);
  owned.emit(owned.kernel.ready); await nextTurn();
  assert.equal(received.length, 1); assert.equal(owned.kills, 1); assert.equal(owned.bindingLoads, 0);
  await channel.terminate();
});

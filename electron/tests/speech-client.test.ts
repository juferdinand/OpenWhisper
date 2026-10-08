import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { SpeechClient, SpeechWorkerError, type SpeechChannel } from "../src/services/speech-client.js";
import type { SpeechRequest } from "../src/workers/speech-protocol.js";

class OwnedChannel implements SpeechChannel {
  message: ((value: unknown) => void) | undefined;
  exit: (() => void) | undefined;
  terminated = 0;
  requests: SpeechRequest[] = [];
  ready = true;
  reply = true;
  send(request: SpeechRequest): void {
    this.requests.push(request);
    if (!this.reply) return;
    queueMicrotask(() => this.message?.({ version: 1, id: request.id, ok: true,
      value: request.command === "discover" ? { command: "discover", gpu: null }
        : request.command === "transcribe" ? { command: "transcribe", text: "Café 東京" }
        : { command: "shutdown" },
    }));
  }
  onMessage(listener: (value: unknown) => void): () => void {
    this.message = listener;
    // Real transport buffers early readiness; test the synchronous buffered case.
    if (this.ready) listener({ version: 1, type: "ready" });
    return () => { this.message = undefined; };
  }
  onExit(listener: () => void): () => void { this.exit = listener; return () => { this.exit = undefined; }; }
  async terminate(): Promise<void> { this.terminated += 1; }
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof SpeechWorkerError && error.code === expected;
}
function deferred<T>() {
  let accept!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolve, fail) => { accept = resolve; reject = fail; });
  return { promise, accept, reject };
}

test("speech client reuses one owner and performs native shutdown before owned termination", async () => {
  const channel = new OwnedChannel();
  let starts = 0;
  const client = new SpeechClient(async () => { starts += 1; return channel; });
  assert.equal(await client.gpuDevice(), null);
  assert.equal(await client.transcribeWindow({ path: "/owned/model.bin", family: "whisper", gpu: false },
    new Float32Array([0.25]), "de", "東京"), "Café 東京");
  assert.equal(starts, 1);
  await client.close();
  assert.deepEqual(channel.requests.map((request) => request.command), ["discover", "transcribe", "shutdown"]);
  assert.equal(channel.terminated, 1);
  await assert.rejects(client.gpuDevice(), code("CLOSED"));
});

test("worker death rejects one request and disposes its owner before the next attempt", async () => {
  const first = new OwnedChannel(); first.reply = false;
  const second = new OwnedChannel();
  let starts = 0;
  const client = new SpeechClient(async () => starts++ === 0 ? first : second);
  const pending = client.gpuDevice();
  const rejected = assert.rejects(pending, code("WORKER_FAILED"));
  await nextTurn();
  first.exit?.();
  await rejected;
  assert.equal(await client.gpuDevice(), null);
  assert.equal(first.terminated, 1);
  assert.equal(starts, 2);
  await client.close();
});

test("a mismatched private reply cannot resolve a request or leak its details", async () => {
  const channel = new OwnedChannel(); channel.reply = false;
  const client = new SpeechClient(async () => channel);
  const pending = client.gpuDevice();
  const rejected = assert.rejects(pending, code("INVALID_REPLY"));
  await nextTurn();
  channel.message?.({ version: 1, id: "wrong-private-id", ok: false, code: "private-model-prompt" });
  await rejected;
  assert.equal(channel.terminated, 1);
  await client.close();
});

test("cancellation during asynchronous startup returns before late owner and disposes it", async () => {
  const channel = new OwnedChannel();
  let ready: ((channel: SpeechChannel) => void) | undefined;
  const client = new SpeechClient(() => new Promise<SpeechChannel>((accept) => { ready = accept; }));
  const cancel = new AbortController();
  const pending = client.gpuDevice(cancel.signal);
  const rejected = assert.rejects(pending, code("CANCELLED"));
  await nextTurn();
  cancel.abort();
  await rejected;
  ready?.(channel);
  await nextTurn();
  assert.equal(channel.terminated, 1);
  assert.deepEqual(channel.requests, []);
  await client.close();
});

test("pending inference excludes parallel requests and cancellation removes old reply ownership", async () => {
  const channel = new OwnedChannel(); channel.reply = false;
  const client = new SpeechClient(async () => channel);
  const cancel = new AbortController();
  const pending = client.transcribeWindow({ path: "/owned/model.bin", family: "parakeet", gpu: false },
    new Float32Array([0.25]), "de", "", cancel.signal);
  const rejected = assert.rejects(pending, code("CANCELLED"));
  await nextTurn();
  await assert.rejects(client.gpuDevice(), code("BUSY"));
  const staleReply = channel.message;
  const request = channel.requests[0]; assert.ok(request);
  cancel.abort();
  await rejected;
  staleReply?.({ version: 1, id: request.id, ok: true, value: { command: "transcribe", text: "stale" } });
  assert.equal(channel.terminated, 1);
  await client.close();
});

test("never-settling factory bounds requests and fails closed on unconfirmed shutdown", async () => {
  let starts = 0;
  const client = new SpeechClient(() => { starts += 1; return new Promise<SpeechChannel>(() => {}); },
    { startupMs: 10, requestMs: 100, teardownMs: 10 });
  await assert.rejects(client.gpuDevice(), code("TIMEOUT"));
  await assert.rejects(client.gpuDevice(), code("TIMEOUT"));
  assert.equal(starts, 1);
  const closing = client.close();
  assert.equal(client.close(), closing);
  await assert.rejects(closing, code("WORKER_FAILED"));
  await assert.rejects(client.gpuDevice(), code("CLOSED"));
});

test("retry waits for canceled factory resolution and late owned termination without overlap", async () => {
  const returned = deferred<SpeechChannel>();
  const cleanup = deferred<void>();
  const first = new OwnedChannel();
  const second = new OwnedChannel();
  let owners = 0, maximumOwners = 0, starts = 0;
  first.terminate = async () => { first.terminated += 1; await cleanup.promise; owners -= 1; };
  second.terminate = async () => { second.terminated += 1; owners -= 1; };
  const client = new SpeechClient(async () => {
    starts += 1; owners += 1; maximumOwners = Math.max(maximumOwners, owners);
    return starts === 1 ? await returned.promise : second;
  });
  const abort = new AbortController();
  const pending = client.gpuDevice(abort.signal);
  const rejected = assert.rejects(pending, code("CANCELLED"));
  await nextTurn(); abort.abort(); await rejected;
  const retry = client.gpuDevice();
  await nextTurn(); assert.equal(starts, 1);
  returned.accept(first);
  await nextTurn(); assert.equal(first.terminated, 1); assert.equal(starts, 1);
  cleanup.accept();
  assert.equal(await retry, null);
  assert.equal(starts, 2); assert.equal(maximumOwners, 1);
  assert.deepEqual(first.requests, []);
  await client.close(); assert.equal(owners, 0);
});

test("failed late termination blocks retry and exposes categorical shutdown failure", async () => {
  const returned = deferred<SpeechChannel>();
  const first = new OwnedChannel();
  first.terminate = async () => { first.terminated += 1; throw new Error("Private teardown details"); };
  let starts = 0;
  const client = new SpeechClient(async () => { starts += 1; return returned.promise; },
    { startupMs: 100, requestMs: 100, teardownMs: 100 });
  const abort = new AbortController();
  const pending = client.gpuDevice(abort.signal);
  const rejected = assert.rejects(pending, code("CANCELLED"));
  await nextTurn(); abort.abort(); await rejected;
  returned.accept(first);
  await nextTurn();
  await assert.rejects(client.gpuDevice(), code("TEARDOWN_FAILED"));
  assert.equal(starts, 1); assert.equal(first.terminated, 1);
  await assert.rejects(client.close(), code("WORKER_FAILED"));
});

test("shutdown waits for a late startup owner and its confirmed cleanup", async () => {
  const returned = deferred<SpeechChannel>();
  const cleanup = deferred<void>();
  const first = new OwnedChannel();
  first.terminate = async () => { first.terminated += 1; await cleanup.promise; };
  const client = new SpeechClient(async () => returned.promise);
  const pending = client.gpuDevice();
  const rejected = assert.rejects(pending, code("CLOSED"));
  await nextTurn();
  let closed = false;
  const closing = client.close().then(() => { closed = true; });
  await rejected;
  returned.accept(first); await nextTurn();
  assert.equal(first.terminated, 1); assert.equal(closed, false);
  cleanup.accept(); await closing;
  assert.deepEqual(first.requests, []);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createProvisionalSpeechTransport } from "../src/services/speech-transport.js";
import { InertSpeechPort, deferred, turn } from "./fixtures/speech-port.js";

function fixture(deadlineMs = 3000) {
  const port = new InertSpeechPort(), epoch = randomUUID();
  const transport = createProvisionalSpeechTransport(port, epoch, { deadlineMs });
  port.spawn(); port.ready();
  const challenge = () => transport.challenge(randomUUID(), epoch, new AbortController().signal);
  return { port, epoch, transport, challenge };
}
test("one ready is buffered; private replies never reach ordinary client", async () => {
  const { port, transport, challenge } = fixture();
  const frames: unknown[] = [];
  await challenge(); await challenge();
  assert.equal(port.sent.length, 2);
  transport.channel.onMessage((frame) => { frames.push(frame); }); await turn();
  assert.deepEqual(frames, [{ version: 1, type: "ready" }]);
  const id = randomUUID(); transport.channel.send({ version: 1, id, command: "discover" });
  port.message({ version: 1, id, ok: true, value: { command: "discover", gpu: null } });
  assert.equal(frames.length, 2); assert.equal(port.terminateCalls, 0); port.exit();
});
test("ready before original spawn cannot substitute a frame PID", async () => {
  const port = new InertSpeechPort(), epoch = randomUUID(), transport = createProvisionalSpeechTransport(port, epoch, { deadlineMs: 3000 });
  port.ready(); const pending = transport.challenge(randomUUID(), epoch, new AbortController().signal);
  await turn(); assert.equal(port.sent.length, 0); port.spawn();
  assert.equal(await transport.started, port.pid); await pending; port.exit();
});
test("ordinary work cannot precede two challenges or overwrite one active request", async () => {
  const first = fixture(); first.transport.channel.onMessage(() => {}); await turn();
  assert.throws(() => { first.transport.channel.send({ version: 1, id: randomUUID(), command: "discover" }); }, { code: "INTEGRITY_FAILED" });
  await assert.rejects(first.challenge(), { code: "INTEGRITY_FAILED" }); first.port.exit();
  const second = fixture(); second.transport.channel.onMessage(() => {}); await turn(); await second.challenge(); await second.challenge();
  second.transport.channel.send({ version: 1, id: randomUUID(), command: "discover" });
  assert.throws(() => { second.transport.channel.send({ version: 1, id: randomUUID(), command: "shutdown" }); }, { code: "INTEGRITY_FAILED" }); second.port.exit();
});
test("cancelled caller leaves original control held and serial cleanup waits it", async () => {
  const { port, epoch, transport } = fixture(); port.autoChallenge = false;
  const abort = new AbortController(), first = transport.challenge(randomUUID(), epoch, abort.signal);
  await turn(); assert.equal(port.sent.length, 1); abort.abort(); await assert.rejects(first, { code: "CANCELLED" });
  const next = transport.challenge(randomUUID(), epoch, new AbortController().signal);
  await turn(); assert.equal(port.sent.length, 1); assert.equal(port.terminateCalls, 0);
  port.reply(port.sent[0]); await turn(); assert.equal(port.sent.length, 2);
  port.reply(port.sent[1]); await next; port.exit();
});
test("already cancelled challenge has no frame effect and does not consume nonce", async () => {
  const { port, epoch, transport } = fixture(), aborted = new AbortController(), nonce = randomUUID(); aborted.abort();
  await assert.rejects(transport.challenge(nonce, epoch, aborted.signal), { code: "CANCELLED" }); assert.equal(port.sent.length, 0);
  await transport.challenge(nonce, epoch, new AbortController().signal); port.exit();
});
for (const kind of ["nonce", "epoch", "pid", "extra", "unsolicited"] as const) {
  test(`invalid private ${kind} poisons without implicit termination`, async () => {
    const { port, epoch, transport } = fixture(); port.autoChallenge = false;
    const nonce = randomUUID();
    const pending = kind === "unsolicited" ? undefined : transport.challenge(nonce, epoch, new AbortController().signal);
    await turn(); port.message({ version: 1, nonce: kind === "nonce" ? randomUUID() : nonce,
      epoch: kind === "epoch" ? randomUUID() : epoch, pid: kind === "pid" ? port.pid + 1 : port.pid,
      ...(kind === "extra" ? { extra: true } : {}) });
    if (pending) await assert.rejects(pending, { code: "INTEGRITY_FAILED" });
    await assert.rejects(transport.challenge(randomUUID(), epoch, new AbortController().signal), { code: "INTEGRITY_FAILED" });
    assert.equal(port.terminateCalls, 0); port.exit();
  });
}
test("repeated nonce and duplicate ready remain terminal", async () => {
  const first = fixture(), nonce = randomUUID(); await first.transport.challenge(nonce, first.epoch, new AbortController().signal);
  await assert.rejects(first.transport.challenge(nonce, first.epoch, new AbortController().signal), { code: "INTEGRITY_FAILED" }); first.port.exit();
  const second = fixture(); second.port.ready(); await assert.rejects(second.challenge(), { code: "INTEGRITY_FAILED" }); second.port.exit();
});
test("duplicate result, wrong result ID and command are refused", async () => {
  for (const kind of ["duplicate", "id", "command", "extra"] as const) {
    const { port, transport, challenge } = fixture(); transport.channel.onMessage(() => {}); await turn(); await challenge(); await challenge();
    const id = randomUUID(); transport.channel.send({ version: 1, id, command: "discover" });
    const reply = { version: 1, id: kind === "id" ? randomUUID() : id, ok: true, value: kind === "command" ? { command: "shutdown" } : { command: "discover", gpu: null },
      ...(kind === "extra" ? { extra: true } : {}) };
    port.message(reply); if (kind === "duplicate") port.message(reply);
    await assert.rejects(challenge(), { code: "INTEGRITY_FAILED" }); port.exit();
  }
});
test("validated worker failure category passes through without retaining text", async () => {
  const { port, transport, challenge } = fixture(), frames: unknown[] = [];
  transport.channel.onMessage((frame) => { frames.push(frame); }); await turn(); await challenge(); await challenge();
  const id = randomUUID(); transport.channel.send({ version: 1, id, command: "discover" });
  port.message({ version: 1, id, ok: false, code: "START_FAILED" });
  assert.deepEqual(frames[1], { version: 1, id, ok: false, code: "START_FAILED" }); port.exit();
});
test("late original control reply cannot erase deadline refusal", async () => {
  const { port, epoch, transport } = fixture(30); port.autoChallenge = false;
  const pending = transport.challenge(randomUUID(), epoch, new AbortController().signal);
  await assert.rejects(pending, { code: "TEARDOWN_FAILED" });
  port.reply(port.sent[0]); await assert.rejects(transport.challenge(randomUUID(), epoch, new AbortController().signal), { code: "TEARDOWN_FAILED" });
  assert.equal(port.sent.length, 1); assert.equal(port.terminateCalls, 0); port.exit();
});
test("blocked event loop late success is refused before timer dispatch", async () => {
  const { port, transport, challenge } = fixture(30); port.autoChallenge = false;
  const pending = challenge(); await turn();
  const until = performance.now() + 60; while (performance.now() < until) { /* Inert scheduling regression only. */ }
  port.reply(port.sent[0]); await assert.rejects(pending, { code: "TEARDOWN_FAILED" }); port.exit();
});
for (const kind of ["missing", "duplicate", "error", "exit"] as const) {
  test(`original spawn ${kind} is uncertain, never trusted not-created`, async () => {
    const port = new InertSpeechPort(), transport = createProvisionalSpeechTransport(port, randomUUID(), { deadlineMs: 3000 });
    if (kind === "duplicate") { port.spawn(); port.spawn(); }
    else if (kind === "missing") { for (const listener of port.spawns) listener(undefined); }
    else if (kind === "error") port.fail(); else port.exit();
    await assert.rejects(transport.started, { code: "TEARDOWN_FAILED" });
    assert.equal(port.terminateCalls, 0); port.exit();
  });
}
test("termination memoizes exact original operation, acknowledgement is not reap", async () => {
  const { port, transport } = fixture(), gate = deferred<void>(); port.onTerminate = () => gate.promise;
  const first = transport.channel.terminate(), second = transport.channel.terminate(); assert.equal(first, second);
  await turn(); assert.equal(port.terminateCalls, 1); gate.accept(); await first;
  assert.equal(port.terminateCalls, 1); port.exit();
});
test("termination deadline remains refused after late original completion", async () => {
  const { port, transport } = fixture(30), gate = deferred<void>(); port.onTerminate = () => gate.promise;
  const first = transport.channel.terminate(); await assert.rejects(first, { code: "TEARDOWN_FAILED" }); gate.accept();
  assert.equal(first, transport.channel.terminate()); await assert.rejects(first, { code: "TEARDOWN_FAILED" }); assert.equal(port.terminateCalls, 1); port.exit();
});
test("excess ordinary listener is an integrity failure", async () => {
  const { port, transport, challenge } = fixture(); transport.channel.onMessage(() => {});
  assert.throws(() => { transport.channel.onMessage(() => {}); }, { code: "INTEGRITY_FAILED" });
  await assert.rejects(challenge(), { code: "INTEGRITY_FAILED" }); port.exit();
});
test("corrupt ordinary frame never kills implicitly; explicit cleanup waits original ACK and preserves refusal", async () => {
  const { port, transport, challenge } = fixture(), gate = deferred<void>(), frames: unknown[] = [];
  transport.channel.onMessage((value) => { frames.push(value); }); await turn(); await challenge(); await challenge();
  const id = randomUUID(); transport.channel.send({ version: 1, id, command: "discover" });
  port.message({ version: 1, id: randomUUID(), ok: true, value: { command: "discover", gpu: null } });
  assert.equal(port.terminateCalls, 0); port.onTerminate = () => gate.promise;
  const cleanup = transport.channel.terminate(); let settled = false;
  void cleanup.then(() => { settled = true; }, () => { settled = true; }); await turn();
  assert.equal(port.terminateCalls, 1); assert.equal(settled, false); assert.equal(cleanup, transport.channel.terminate());
  port.message({ version: 1, id, ok: true, value: { command: "discover", gpu: null } });
  assert.equal(frames.length, 1); gate.accept(); await assert.rejects(cleanup, { code: "INTEGRITY_FAILED" });
  await assert.rejects(challenge(), { code: "INTEGRITY_FAILED" }); assert.equal(port.terminateCalls, 1); port.exit();
});
test("explicit cleanup after poison retains first refusal across timeout and late ACK", async () => {
  const { port, transport, challenge } = fixture(30), gate = deferred<void>();
  port.message({ malformed: true }); assert.equal(port.terminateCalls, 0); port.onTerminate = () => gate.promise;
  const cleanup = transport.channel.terminate(); await assert.rejects(cleanup, { code: "INTEGRITY_FAILED" });
  assert.equal(port.terminateCalls, 1); gate.accept(); await turn();
  assert.equal(cleanup, transport.channel.terminate()); await assert.rejects(cleanup, { code: "INTEGRITY_FAILED" });
  await assert.rejects(challenge(), { code: "INTEGRITY_FAILED" }); assert.equal(port.terminateCalls, 1); port.exit();
});
test("original termination ACK after elapsed deadline is refused before timer dispatch", async () => {
  const { port, transport } = fixture(30), gate = deferred<void>(); port.onTerminate = () => gate.promise;
  const cleanup = transport.channel.terminate(); await turn(); assert.equal(port.terminateCalls, 1);
  const until = performance.now() + 60; while (performance.now() < until) { /* Inert scheduling regression only. */ }
  gate.accept(); await assert.rejects(cleanup, { code: "TEARDOWN_FAILED" }); assert.equal(port.terminateCalls, 1); port.exit();
});

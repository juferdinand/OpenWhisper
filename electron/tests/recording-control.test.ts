import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RecordingSnapshot } from "../src/core/recording.js";
import { createRecordingControlPort } from "../src/main/recording-control.js";
import type { RecordingIdentity } from "../src/main/development-recording-host.js";
import { deferred, turn } from "./fixtures/speech-port.js";

function fixture(configure = async () => {}) {
  let identity: RecordingIdentity = { epoch: randomUUID(), generation: 0 };
  let snapshot: RecordingSnapshot = { phase: "idle", generation: 0, elapsedMs: 0, level: 0,
    busy: false, recoveryAvailable: false, error: null, transcript: "" };
  const commands: string[] = [];
  let stop: Promise<void> | undefined;
  const owner = { currentIdentity: () => identity,
    async command(command: "start" | "stop" | "cancel", expected?: RecordingIdentity) {
      assert.ok(!expected || expected.epoch === identity.epoch && expected.generation === identity.generation);
      commands.push(command);
      if (command === "start") {
        identity = { ...identity, generation: identity.generation + 1 };
        snapshot = { ...snapshot, phase: "recording", generation: identity.generation, busy: true };
      } else {
        if (command === "stop") await stop;
        snapshot = { ...snapshot, phase: command === "stop" ? "transcribing" : "idle", busy: command === "stop" };
      }
      return identity;
    },
  };
  const port = createRecordingControlPort({ owner, configure, snapshot: () => snapshot,
    available: () => true, serialize: <T>(operation: () => Promise<T>) => Promise.resolve().then(operation) });
  return { port, commands, holdStop: (value: Promise<void>) => { stop = value; },
    nextGuiRecording() { identity = { epoch: randomUUID(), generation: 1 };
      snapshot = { ...snapshot, generation: 1, phase: "recording", busy: true }; },
    retainedRecording() { snapshot = { ...snapshot, phase: "error", busy: false, recoveryAvailable: true }; },
  };
}
test("GUI and CLI acquisition share one immutable current recording lease", async () => {
  const f = fixture(), first = await f.port.start(new AbortController().signal);
  assert.equal(await f.port.currentLease?.(), first);
  assert.equal(await f.port.currentLease?.(), first);
  const held = deferred<void>(); f.holdStop(held.promise);
  const stop = first.stop(); assert.equal(first.stop(), stop); await turn();
  assert.deepEqual(f.commands, ["start", "stop"]);
  held.accept(); await stop;
  assert.equal(await f.port.status(), "transcribing");
  await first.cancel(); assert.deepEqual(f.commands, ["start", "stop"]);
});
test("an old CLI lease cannot stop or cancel a later GUI recording", async () => {
  const f = fixture(), first = await f.port.start(new AbortController().signal);
  f.nextGuiRecording(); const current = await f.port.currentLease?.(); assert.notEqual(current, first);
  await assert.rejects(first.stop(), /owner changed/u);
  await first.cancel(); assert.deepEqual(f.commands, ["start"]);
  await current?.stop(); assert.deepEqual(f.commands, ["start", "stop"]);
});
test("expiry during configuration creates no recording and no rollback target", async () => {
  const configured = deferred<void>(), f = fixture(() => configured.promise), abort = new AbortController();
  const start = f.port.start(abort.signal); await turn(); abort.abort(); configured.accept();
  await assert.rejects(start, /cancelled/u); assert.deepEqual(f.commands, []);
});
test("retained failed recording prevents a new CLI start", async () => {
  const f = fixture(); f.retainedRecording();
  assert.equal(await f.port.status(), "transcribing");
  await assert.rejects(f.port.start(new AbortController().signal)); assert.deepEqual(f.commands, []);
});
test("trusted lease cleanup still closes the exact recording after GUI shutdown admission closes", async () => {
  const identity = Object.freeze({ epoch: randomUUID(), generation: 1 }), commands: string[] = [];
  let closing = false;
  const port = createRecordingControlPort({
    owner: { currentIdentity: () => identity, async command(command, expected) {
      assert.deepEqual(expected, identity); commands.push(command); return identity;
    } },
    snapshot: () => ({ phase: "recording", busy: true, recoveryAvailable: false }), available: () => !closing,
    configure: async () => {}, serialize: <T>(operation: () => Promise<T>) => closing
      ? Promise.reject(new Error("GUI admission closed.")) : Promise.resolve().then(operation),
    cleanupSerialize: <T>(operation: () => Promise<T>) => Promise.resolve().then(operation),
  });
  const lease = await port.currentLease?.(); assert.ok(lease); closing = true;
  await lease.cancel(); assert.deepEqual(commands, ["cancel"]);
});

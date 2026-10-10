import assert from "node:assert/strict";
import { test } from "node:test";
import { recordingUnavailableReason } from "../../src/main/recording-control.js";

const ready = { host: true, model: true, busy: false, recovery: false, mac: false,
  microphoneAllowed: false, audioServer: true };

test("a fresh Dev profile explains its missing model before Start can run", () => {
  assert.equal(recordingUnavailableReason({ ...ready, model: false }), "model");
  assert.equal(recordingUnavailableReason(ready), undefined);
});

test("Start reports unavailable host, audio and Mac permission prerequisites", () => {
  assert.equal(recordingUnavailableReason({ ...ready, host: false }), "host");
  assert.equal(recordingUnavailableReason({ ...ready, audioServer: false }), "audio");
  assert.equal(recordingUnavailableReason({ ...ready, mac: true }), "permission");
  assert.equal(recordingUnavailableReason({ ...ready, mac: true, microphoneAllowed: true }), undefined);
});

test("Stop and stopped-audio retry remain usable after audio disappears", () => {
  assert.equal(recordingUnavailableReason({ ...ready, busy: true, model: false, audioServer: false }), undefined);
  assert.equal(recordingUnavailableReason({ ...ready, recovery: true, audioServer: false }), undefined);
  assert.equal(recordingUnavailableReason({ ...ready, recovery: true, mac: true }), undefined);
  assert.equal(recordingUnavailableReason({ ...ready, recovery: true, model: false }), "model");
  assert.equal(recordingUnavailableReason({ ...ready, recovery: true, host: false }), "host");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  appStateSchema,
  isCurrentRecordingTelemetry,
  isSteadyRecordingUpdate,
  validateEvent,
} from "../../src/contracts/ui/state.js";
import type { AppState } from "../../src/contracts/ui/state.js";

const idleState: AppState = {
  updates: {
    configured: false,
    status: "idle",
    version: null,
    progress: 0,
    error: null,
    package: "development",
  },
  platform: "linux",
  version: "0.3.0",
  status: "idle",
  message: "",
  transcript: "",
  history: [],
  preferences: {
    ui_language: "en",
    setup_completed: true,
    model: "tiny",
    language: "auto",
    microphone: "",
    vocabulary: "",
    snippets: [],
    output: "clipboard",
    hold_to_record: false,
    gpu: false,
    keep_history: true,
  },
  models: [],
  installed: [],
  microphones: [],
  session: "wayland",
  desktop: "test",
  clipboard_available: false,
  shortcut_portal: false,
  paste_portal: false,
  shortcut: null,
  paste_ready: false,
  gpu_available: false,
  download: null,
  progress: 0,
  elapsed: 0,
  model_directory: "",
  recording_generation: 7,
};

test("recording telemetry is a strict bounded event and cannot update stale or final state", () => {
  const payload = validateEvent("recording_telemetry", {
    generation: 7,
    elapsed: 1,
    level: 0.4,
  });
  const recording = appStateSchema.parse({ ...idleState, status: "recording" });
  assert.equal(isCurrentRecordingTelemetry(recording, payload), true);
  assert.equal(
    isCurrentRecordingTelemetry(
      { ...recording, recording_generation: 6 },
      payload,
    ),
    false,
  );
  assert.equal(
    isCurrentRecordingTelemetry({ ...recording, status: "done" }, payload),
    false,
  );
  assert.equal(
    isCurrentRecordingTelemetry({ ...recording, elapsed: 2 }, payload),
    false,
  );
  for (const invalid of [
    { ...payload, generation: -1 },
    { ...payload, elapsed: 1.5 },
    { ...payload, level: 1.1 },
    { ...payload, transcript: "must not cross the telemetry boundary" },
  ])
    assert.throws(() => validateEvent("recording_telemetry", invalid));
});

test("only same-generation recording snapshots use telemetry; transitions remain full state", () => {
  const steady = {
    phase: "recording",
    generation: 7,
    elapsedMs: 500,
    busy: true,
    recoveryAvailable: false,
    error: null,
    transcript: "",
  };
  assert.equal(isSteadyRecordingUpdate(steady, { ...steady, elapsedMs: 600 }), true);
  assert.equal(isSteadyRecordingUpdate(steady, { ...steady, phase: "starting" }), false);
  assert.equal(isSteadyRecordingUpdate(steady, { ...steady, phase: "stopping" }), false);
  assert.equal(isSteadyRecordingUpdate(steady, { ...steady, generation: 8 }), false);
  assert.equal(isSteadyRecordingUpdate(steady, { ...steady, transcript: "changed" }), false);
  assert.equal(isSteadyRecordingUpdate(steady, { ...steady, recoveryAvailable: true }), false);
  assert.equal(isSteadyRecordingUpdate(steady, { ...steady, elapsedMs: 499 }), false);
  assert.equal(
    validateEvent("state", { ...idleState, status: "done" }).status,
    "done",
  );
});

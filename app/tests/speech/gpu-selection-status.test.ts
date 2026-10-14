import assert from "node:assert/strict";
import test from "node:test";
import type { BackendSelection } from "../../src/services/speech/backend-supervisor.js";
import { GpuSelectionStatus } from "../../src/services/speech/gpu-selection-status.js";

const cpuAfterProbeFailure: BackendSelection = {
  backend: "cpu", requestedGpu: true, gpu: false, detection: "unavailable",
};
const selectedGpu: BackendSelection = {
  backend: "vulkan", requestedGpu: true, gpu: true, detection: "device", gpuDevice: "Synthetic GPU",
};

test("GPU probe failure remains visible through CPU recording and clears after a successful GPU selection", () => {
  const reported: ReturnType<GpuSelectionStatus["snapshot"]>[] = [];
  const status = new GpuSelectionStatus(true, (snapshot) => { reported.push(snapshot); });

  status.discovered(cpuAfterProbeFailure);
  assert.deepEqual(status.snapshot(), { supported: true, checked: true, available: false,
    fallback: false, probeFailed: true, device: null });

  // Configuring a CPU recording resets only per-recording fallback state.
  status.resetRecordingFallback();
  assert.equal(status.snapshot().probeFailed, true);

  status.backendSelected(cpuAfterProbeFailure);
  assert.deepEqual(status.snapshot(), { supported: true, checked: true, available: false,
    fallback: true, probeFailed: true, device: null });

  status.resetRecordingFallback();
  assert.equal(status.snapshot().probeFailed, true);
  status.discovered(selectedGpu);
  assert.deepEqual(status.snapshot(), { supported: true, checked: true, available: true,
    fallback: false, probeFailed: false, device: "Synthetic GPU" });
  assert.equal(reported.length, 5);
});

test("unsupported and CPU-only selections do not report GPU state", () => {
  const reported: ReturnType<GpuSelectionStatus["snapshot"]>[] = [];
  const status = new GpuSelectionStatus(false, (snapshot) => { reported.push(snapshot); });

  status.discovered(cpuAfterProbeFailure);
  status.backendSelected(selectedGpu);
  status.adaptiveFallback();
  status.resetRecordingFallback();
  assert.deepEqual(reported, []);
  assert.deepEqual(status.snapshot(), { supported: false, checked: false, available: false,
    fallback: false, probeFailed: false, device: null });
});

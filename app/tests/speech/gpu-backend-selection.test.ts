import assert from "node:assert/strict";
import test from "node:test";
import { recordingDescriptorSupportsGpu } from "../../src/main/development-recording-descriptor.js";
import { gpuBackendFor } from "../../src/services/speech/backend-supervisor.js";

const artifact = { bytes: 1, sha256: "a".repeat(64) };
const descriptor = (platform: "linux" | "darwin", architecture: "x64" | "arm64", backends: readonly ("cpu" | "vulkan" | "metal")[]) => ({
  platform, architecture, speech: { version: 1 as const, platform, architecture, napiVersion: 8 as const,
    speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a" as const,
    speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde" as const,
    entries: backends.map((backend) => ({ backend, ...artifact })) },
});

test("each host has at most one accelerated backend: Vulkan on Linux x64 and Metal on Apple Silicon", () => {
  assert.equal(gpuBackendFor({ platform: "linux", architecture: "x64" }), "vulkan");
  assert.equal(gpuBackendFor({ platform: "darwin", architecture: "arm64" }), "metal");
  assert.equal(gpuBackendFor({ platform: "darwin", architecture: "x64" }), undefined);
  assert.equal(gpuBackendFor({ platform: "linux", architecture: "arm64" }), undefined);
});

test("GPU support is offered only when the build ships the host's accelerated speech backend", () => {
  assert.equal(recordingDescriptorSupportsGpu(descriptor("darwin", "arm64", ["cpu", "metal"])), true);
  assert.equal(recordingDescriptorSupportsGpu(descriptor("darwin", "arm64", ["cpu"])), false);
  // Intel Macs ship the same Metal build for the universal package but keep recognizing on the CPU.
  assert.equal(recordingDescriptorSupportsGpu(descriptor("darwin", "x64", ["cpu", "metal"])), false);
  assert.equal(recordingDescriptorSupportsGpu(descriptor("linux", "x64", ["cpu", "vulkan"])), true);
  assert.equal(recordingDescriptorSupportsGpu(descriptor("linux", "x64", ["cpu"])), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { darwinUniversalRecordingDescriptorSchema, developmentRecordingDescriptorSchema,
  selectDevelopmentRecordingDescriptor, type DevelopmentRecordingDescriptor } from "../../src/main/development-recording-descriptor.js";
import { SPEECH_ENTRY_FILES } from "../../src/services/speech/speech-entry-graph.js";

const artifact = { bytes: 123, sha256: "a".repeat(64) };
function descriptor(platform: "linux" | "darwin", architecture: "arm64" | "x64"): DevelopmentRecordingDescriptor {
  return developmentRecordingDescriptorSchema.parse({ version: 1, platform, architecture,
    capture: artifact, captureEntry: artifact, ...(platform === "darwin" ? { retirement: artifact } : {}),
    speech: { version: 1, platform, architecture, napiVersion: 8,
      speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
      speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
      entries: [{ backend: "cpu", ...artifact }] },
    speechEntryGraph: { version: 1, zodVersion: "4.6.5",
      entries: [...SPEECH_ENTRY_FILES, "node_modules/zod/package.json", "node_modules/zod/index.js"].map((path) => ({ path, ...artifact })) },
  });
}
const universal = () => ({ version: 2, platform: "darwin", architectures: {
  arm64: descriptor("darwin", "arm64"), x64: descriptor("darwin", "x64"),
} });

test("V1 thin Mac and Linux descriptors remain unchanged and select only their matching host", () => {
  for (const platform of ["linux", "darwin"] as const) for (const architecture of ["arm64", "x64"] as const) {
    const input = descriptor(platform, architecture);
    assert.deepEqual(selectDevelopmentRecordingDescriptor(input, { platform, architecture }), input);
    assert.throws(() => selectDevelopmentRecordingDescriptor(input, { platform: platform === "darwin" ? "linux" : "darwin", architecture }));
    assert.throws(() => selectDevelopmentRecordingDescriptor(input, { platform, architecture: architecture === "arm64" ? "x64" : "arm64" }));
    assert.throws(() => developmentRecordingDescriptorSchema.parse({ ...input, extra: true }));
  }
  const linux = descriptor("linux", "x64");
  const withPlatform = { ...linux, platformServices: { entry: artifact, bus: artifact } };
  assert.deepEqual(selectDevelopmentRecordingDescriptor(withPlatform, { platform: "linux", architecture: "x64" }), withPlatform);
});

test("Vulkan is optional only for the x64 Linux development recording slice", () => {
  const linux = descriptor("linux", "x64");
  const withVulkan = { ...linux, speech: { ...linux.speech,
    entries: [...linux.speech.entries, { backend: "vulkan" as const, ...artifact }] } };
  assert.deepEqual(developmentRecordingDescriptorSchema.parse(withVulkan), withVulkan);
  for (const invalid of [
    { ...descriptor("linux", "arm64"), speech: { ...descriptor("linux", "arm64").speech,
      entries: [{ backend: "cpu" as const, ...artifact }, { backend: "vulkan" as const, ...artifact }] } },
    { ...descriptor("darwin", "x64"), speech: { ...descriptor("darwin", "x64").speech,
      entries: [{ backend: "cpu" as const, ...artifact }, { backend: "vulkan" as const, ...artifact }] } },
    { ...linux, speech: { ...linux.speech, entries: [{ backend: "vulkan" as const, ...artifact }, { backend: "cpu" as const, ...artifact }] } },
  ]) assert.throws(() => developmentRecordingDescriptorSchema.parse(invalid));
});

test("Darwin V2 validates both branches and returns only the requested readonly V1", () => {
  const input = universal(), parsed = darwinUniversalRecordingDescriptorSchema.parse(input);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.architectures));
  for (const architecture of ["arm64", "x64"] as const) {
    const selected = selectDevelopmentRecordingDescriptor(input, { platform: "darwin", architecture });
    assert.deepEqual(selected, input.architectures[architecture]); assert.equal(selected.version, 1);
    assert.equal(selected.platform, "darwin"); assert.equal(selected.architecture, architecture); assert.ok(Object.isFrozen(selected));
    assert.deepEqual(developmentRecordingDescriptorSchema.parse(selected), selected);
  }
  assert.throws(() => developmentRecordingDescriptorSchema.parse(input));
});

test("Darwin V2 refuses missing or swapped branches, Linux branches and extra keys", () => {
  const input = universal(), branches = input.architectures;
  const malformed: unknown[] = [
    { ...input, architectures: { arm64: branches.arm64 } },
    { ...input, architectures: { x64: branches.x64 } },
    { ...input, architectures: { arm64: branches.x64, x64: branches.arm64 } },
    { ...input, architectures: { ...branches, arm64: descriptor("linux", "arm64") } },
    { ...input, platform: "linux" }, { ...input, architecture: "universal" }, { ...input, extra: true },
    { ...input, architectures: { ...branches, ia32: branches.x64 } },
    { ...input, architectures: { ...branches, x64: { ...branches.x64, extra: true } } },
    { ...input, architectures: { ...branches, x64: { ...branches.x64, version: 2 } } },
    { ...input, version: 3 }, null, [],
  ];
  for (const value of malformed) {
    assert.throws(() => darwinUniversalRecordingDescriptorSchema.parse(value));
    for (const architecture of ["arm64", "x64"] as const) {
      assert.throws(() => selectDevelopmentRecordingDescriptor(value, { platform: "darwin", architecture }));
    }
  }
});

test("the unselected V2 branch retains V1 native, speech and worker graph validation", () => {
  const input = universal(), branch = input.architectures.x64;
  for (const altered of [
    { ...branch, capture: { ...artifact, sha256: "invalid" } },
    { ...branch, retirement: { ...artifact, bytes: 0 } },
    { ...branch, speech: { ...branch.speech, architecture: "arm64" } },
    { ...branch, speech: { ...branch.speech, platform: "linux" } },
    { ...branch, speech: { ...branch.speech, entries: [{ backend: "cpu", ...artifact }, { backend: "metal", ...artifact }] } },
    { ...branch, speechEntryGraph: { ...branch.speechEntryGraph, entries: branch.speechEntryGraph.entries.slice(1) } },
  ]) {
    const changed = { ...input, architectures: { ...input.architectures, x64: altered } };
    assert.throws(() => selectDevelopmentRecordingDescriptor(changed, { platform: "darwin", architecture: "arm64" }));
  }
});

test("the selector refuses Linux V2 and unsupported or malformed runtime hosts", () => {
  const input = universal();
  for (const host of [{ platform: "linux", architecture: "arm64" }, { platform: "linux", architecture: "x64" },
    { platform: "win32", architecture: "x64" }, { platform: "darwin", architecture: "ia32" },
    { platform: "darwin", architecture: "universal" }, { platform: "darwin" },
    { platform: "darwin", architecture: "arm64", extra: true }, null, "darwin"]) {
    assert.throws(() => selectDevelopmentRecordingDescriptor(input, host));
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { SPEECH_ENTRY_FILES } from "../src/services/speech-entry-graph.js";
import { parseMacPackageSmokeArguments, validateUniversalMacPackageMetadata } from "./fixtures/mac-package-metadata.js";
const artifact = { bytes: 123, sha256: "a".repeat(64) };
function descriptor(architecture: "arm64" | "x64") {
  return developmentRecordingDescriptorSchema.parse({ version: 1, platform: "darwin", architecture,
    capture: artifact, captureEntry: artifact, retirement: artifact,
    speech: { version: 1, platform: "darwin", architecture, napiVersion: 8,
      speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a", speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
      entries: [{ backend: "cpu", ...artifact }] }, speechEntryGraph: { version: 1, zodVersion: "4.6.5",
      entries: [...SPEECH_ENTRY_FILES, "node_modules/zod/package.json", "node_modules/zod/index.js"].map((path) => ({ path, ...artifact })) } });
}
function fixture() {
  const applicationBuild = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" };
  const source = { commit: "a".repeat(40), modified: false };
  const originalThinRecording = { version: 2, platform: "darwin", architectures: { arm64: descriptor("arm64"), x64: descriptor("x64") } };
  // Final FAT/signing hashes differ legitimately from original thin hashes.
  const signedRecording = { ...originalThinRecording, architectures: {
    arm64: { ...originalThinRecording.architectures.arm64, capture: { ...artifact, sha256: "b".repeat(64) } },
    x64: { ...originalThinRecording.architectures.x64, capture: { ...artifact, sha256: "b".repeat(64) } } } };
  const receipt = { version: 1, classification: "UNIVERSAL_VALIDATION_ONLY", source, sourceVersion: "0.3.0", runtimeVersion: "44.7.0", applicationBuild,
    merger: { version: "3.0.6", integrity: "sha512-MonS1kfkZdSEkLZI0pdR/TCx8ecxwRSFm7sORfwIkDI9UaIbHnk4Mgeqq+Ob9qDQRV8LZ9+hHCmimpA9BRcNxw==",
      licenseSha256: "edab8abb78d9c5b36944c3e00aebf6a90eb32378993f49ac8a3904007029c629" }, signingMode: "ad-hoc",
    originalThinRecording, signedRecording, updateAuthority: false, runtimeAcceptance: false, limitations: [] };
  const thin = (architecture: "arm64" | "x64") => ({ version: 1, architecture, source, sourceVersion: "0.3.0", runtimeVersion: "44.7.0", applicationBuild,
    unsignedRecording: originalThinRecording.architectures[architecture], signedRecording: originalThinRecording.architectures[architecture] });
  return { receipt, thinReceipts: { arm64: thin("arm64"), x64: thin("x64") }, applicationBuild, source,
    recordingModule: `const DEVELOPMENT_RECORDING_BUILD = ${JSON.stringify(signedRecording)};\nexport { DEVELOPMENT_RECORDING_BUILD };\n`,
    host: { platform: "darwin", architecture: "arm64" } };
}
test("explicit universal format requires Stable while existing thin launcher arguments keep their defaults", () => {
  const args = ["--package", "/owned/OpenWhisper.app", "--evidence", "/owned/evidence", "--fixtures", "/owned/fixtures"];
  assert.deepEqual([parseMacPackageSmokeArguments(args).variant, parseMacPackageSmokeArguments(args).packageFormat], ["development", "thin"]);
  assert.equal(parseMacPackageSmokeArguments([...args, "--variant", "stable"]).packageFormat, "thin");
  assert.equal(parseMacPackageSmokeArguments([...args, "--variant", "stable", "--package-format", "universal"]).packageFormat, "universal");
  for (const suffix of [["--variant", "development", "--package-format", "universal"], ["--package-format", "universal"],
    ["--variant", "stable", "--package-format", "other"]]) assert.throws(() => parseMacPackageSmokeArguments([...args, ...suffix]));
});
test("actual V2 and indexed originals agree on both architectures while final signing hashes may differ", () => {
  for (const architecture of ["arm64", "x64"] as const) {
    const input = fixture(); input.host.architecture = architecture;
    const result = validateUniversalMacPackageMetadata(input);
    assert.equal(result.recordingDescriptor.architecture, architecture);
    assert.deepEqual(result.recordingDescriptor, input.receipt.signedRecording.architectures[architecture]);
  }
});
test("missing or swapped originals and source, identity, version or descriptor mismatches refuse universal evidence", () => {
  const original = fixture();
  const cases = [
    { ...original, thinReceipts: { ...original.thinReceipts, x64: undefined } },
    { ...original, thinReceipts: { arm64: original.thinReceipts.x64, x64: original.thinReceipts.arm64 } },
    ...["source", "applicationBuild", "sourceVersion", "signedRecording"].map((field) => ({ ...original, thinReceipts: { ...original.thinReceipts,
      x64: { ...original.thinReceipts.x64, [field]: field === "source" ? { commit: "b".repeat(40), modified: false }
        : field === "applicationBuild" ? { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" }
        : field === "sourceVersion" ? "0.3.1" : { ...original.thinReceipts.x64.signedRecording, capture: { ...artifact, sha256: "c".repeat(64) } } } } })),
    { ...original, recordingModule: `export const DEVELOPMENT_RECORDING_BUILD = ${JSON.stringify(original.receipt.originalThinRecording)};` },
    { ...original, recordingModule: `${original.recordingModule} process.exit(0);` },
    { ...original, source: { ...original.source, modified: true } },
    { ...original, host: { platform: "linux", architecture: "arm64" } },
    { ...original, receipt: { ...original.receipt, updateAuthority: true } },
    { ...original, receipt: { ...original.receipt, signedRecording: { ...original.receipt.signedRecording,
      architectures: { ...original.receipt.signedRecording.architectures, x64: { ...original.receipt.signedRecording.architectures.x64, architecture: "arm64" } } } } },
  ];
  for (const input of cases) assert.throws(() => validateUniversalMacPackageMetadata(input));
});

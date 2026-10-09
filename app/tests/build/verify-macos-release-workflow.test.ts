import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseMacReleaseInputNotice, validateSourceReceipt, verifyNativeEvidence } from "../../scripts/verify-macos-release-workflow.js";
import { SPEECH_ENTRY_FILES } from "../../src/services/speech/speech-entry-graph.js";

const commit = "a".repeat(40);

test("Mac release workflow source receipt pins the expected clean commit", () => {
  assert.deepEqual(validateSourceReceipt({ commit, modified: false }, commit), { commit, modified: false });
  assert.throws(() => validateSourceReceipt({ commit: "b".repeat(40), modified: false }, commit));
  assert.throws(() => validateSourceReceipt({ commit, modified: true }, commit));
});

test("Mac release workflow accepts the package factory's unsigned and signed native receipt fields", () => {
  const digest = { bytes: 1, sha256: "b".repeat(64) };
  const architecture = "arm64" as const;
  const recording = { version: 1 as const, platform: "darwin" as const, architecture, capture: digest, captureEntry: digest,
    retirement: digest,
    speech: { version: 1 as const, platform: "darwin" as const, architecture, napiVersion: 8 as const,
      speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
      speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
      entries: [{ backend: "cpu" as const, ...digest }] },
    speechEntryGraph: { version: 1 as const, zodVersion: "4.6.5" as const,
      entries: [...SPEECH_ENTRY_FILES, "node_modules/zod/package.json", "node_modules/zod/index.js"].map((path) => ({ path, ...digest })) } };
  const native = Array.from({ length: 5 }, (_, index) => ({ path: `dist/native/module-${index}.node`, unsigned: digest, signed: digest }));
  const notice = parseMacReleaseInputNotice({ version: 1, classification: "STABLE_RELEASE_INPUT", architecture,
    sourceVersion: "0.3.0", source: { commit, modified: false }, signedRecording: recording, native,
    signingMode: "persistent-validation", updateConfigured: true, certificateFingerprint: "c".repeat(40) });
  assert.equal(notice.native[0]?.unsigned.sha256, digest.sha256);
  assert.equal(notice.native[0]?.signed.sha256, digest.sha256);
});

test("Mac release workflow native receipt matches file bytes and rejects path escape", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mac-release-workflow-"));
  try {
    const application = join(temporary, "OpenWhisper.app");
    const nativeDirectory = join(application, "dist/native");
    await mkdir(nativeDirectory, { recursive: true });
    const path = join(nativeDirectory, "capture.node");
    const bytes = Buffer.from("owned signed native input");
    await writeFile(path, bytes);
    const signed = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const evidence = { unsigned: signed, signed };
    await verifyNativeEvidence(application, [{ path: "dist/native/capture.node", ...evidence }]);
    await assert.rejects(verifyNativeEvidence(application, [{ path: "../../../../outside", ...evidence }]));
    await assert.rejects(verifyNativeEvidence(application, [{ path: "dist/native/capture.node", ...evidence, signed: { ...signed, bytes: bytes.length + 1 } }]));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

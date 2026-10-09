import assert from "node:assert/strict";
import { test } from "node:test";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { SPEECH_ENTRY_FILES } from "../src/services/speech-entry-graph.js";
import { classifyMacPublisherFixtureResult, parseMacPackageSmokeArguments, validateMacPackageUpdateConfiguration, validateUniversalMacPackageMetadata } from "./fixtures/mac-package-metadata.js";
import { MacPublisherIdentityError, parseMacPublisherIdentity, parseMacPublisherKeychains, parseMacPublisherZipListing, parseOwnedMacPublisherArguments,
  validateMacPublisherCompletion } from "./owned-macos-publisher.js";
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
    assert.equal(result.signingMode, "ad-hoc");
    assert.equal(result.updateConfigured, false);
    assert.equal(result.recordingDescriptor.architecture, architecture);
    assert.deepEqual(result.recordingDescriptor, input.receipt.signedRecording.architectures[architecture]);
  }
});
test("Mac update configuration defaults off and requires explicit Stable persistent producer evidence", () => {
  const original = fixture();
  assert.equal(validateMacPackageUpdateConfiguration(original.receipt), false);
  assert.equal(validateMacPackageUpdateConfiguration({ ...original.receipt, updateConfigured: false, publicationAuthority: false }), false);
  const enabled = { ...original.receipt, signingMode: "persistent-validation", updateConfigured: true, publicationAuthority: false };
  assert.equal(validateMacPackageUpdateConfiguration(enabled), true);
  assert.equal(validateUniversalMacPackageMetadata({ ...original, receipt: enabled }).updateConfigured, true);
  for (const receipt of [{ ...enabled, signingMode: "ad-hoc" }, { ...enabled, publicationAuthority: true },
    { ...enabled, applicationBuild: { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" } },
    ...[null, 1, "true"].map((updateConfigured) => ({ ...enabled, updateConfigured }))]) {
    assert.throws(() => validateMacPackageUpdateConfiguration(receipt));
  }
  assert.throws(() => validateUniversalMacPackageMetadata({ ...original, receipt: { ...enabled, updateAuthority: true } }));
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
    { ...original, receipt: { ...original.receipt, signingMode: undefined } },
    { ...original, receipt: { ...original.receipt, signingMode: "unknown" } },
    { ...original, receipt: { ...original.receipt, signedRecording: { ...original.receipt.signedRecording,
      architectures: { ...original.receipt.signedRecording.architectures, x64: { ...original.receipt.signedRecording.architectures.x64, architecture: "arm64" } } } } },
  ];
  for (const input of cases) assert.throws(() => validateUniversalMacPackageMetadata(input));
});
test("publisher fixture limitation requires the admitted ad-hoc mode and the exact universal self refusal", () => {
  const original = fixture();
  const metadata = validateUniversalMacPackageMetadata(original);
  assert.equal(validateUniversalMacPackageMetadata({ ...original, receipt: { ...original.receipt,
    signingMode: "persistent-validation" } }).signingMode, "persistent-validation");
  const knownRefusal = { accepted: false, code: "INVALID_SIGNATURE", osStatus: -67050 };
  assert.equal(classifyMacPublisherFixtureResult({ fixture: "self", packageFormat: "universal",
    signingMode: metadata.signingMode, result: knownRefusal }), "UNAVAILABLE");
  for (const [packageFormat, signingMode] of [["thin", "ad-hoc"], ["thin", "persistent-validation"],
    ["universal", "persistent-validation"]] as const) {
    assert.throws(() => classifyMacPublisherFixtureResult({ fixture: "self", packageFormat, signingMode, result: knownRefusal }));
  }
  for (const result of [{ ...knownRefusal, osStatus: -67062 }, { ...knownRefusal, osStatus: null },
    { ...knownRefusal, code: "CURRENT_SIGNATURE_UNAVAILABLE" }, { accepted: false, code: null, osStatus: null }]) {
    assert.throws(() => classifyMacPublisherFixtureResult({ fixture: "self", packageFormat: "universal", signingMode: "ad-hoc", result }));
  }
});
test("measured publisher success remains success in every format and signing mode", () => {
  for (const packageFormat of ["thin", "universal"] as const) for (const signingMode of ["ad-hoc", "persistent-validation"] as const) {
    const context = { packageFormat, signingMode, result: { accepted: true, code: null, osStatus: null } };
    assert.equal(classifyMacPublisherFixtureResult({ ...context, fixture: "self" }), "ACCEPTED");
    assert.equal(classifyMacPublisherFixtureResult({ ...context, fixture: "real-package", selfAvailability: "UNAVAILABLE" }), "ACCEPTED");
    assert.throws(() => classifyMacPublisherFixtureResult({ ...context, fixture: "self",
      result: { accepted: true, code: "INVALID_SIGNATURE", osStatus: -67050 } }));
  }
});
test("actual ZIP publisher unavailability requires the previously measured exact self limitation", () => {
  const context = { packageFormat: "universal", signingMode: "ad-hoc", fixture: "real-package",
    result: { accepted: false, code: "INVALID_SIGNATURE", osStatus: -67050 } } as const;
  assert.equal(classifyMacPublisherFixtureResult({ ...context, selfAvailability: "UNAVAILABLE" }), "UNAVAILABLE");
  assert.throws(() => classifyMacPublisherFixtureResult({ ...context, selfAvailability: "ACCEPTED" }));
  assert.throws(() => classifyMacPublisherFixtureResult({ ...context, selfAvailability: "UNAVAILABLE",
    result: { accepted: false, code: "INVALID_BUNDLE", osStatus: -67050 } }));
  assert.throws(() => classifyMacPublisherFixtureResult({ ...context, selfAvailability: "UNAVAILABLE", signingMode: "persistent-validation" }));
});

test("owned publisher commands and keychain output reject ambiguous or unbounded authority", () => {
  for (const mode of ["admit", "oracle", "keychain-list", "keychain-identity", "runtime-input", "result"]) assert.equal(parseOwnedMacPublisherArguments([mode]), mode);
  for (const args of [[], ["sign"], ["oracle", "--original", "/other.app"]]) assert.throws(() => parseOwnedMacPublisherArguments(args));
  assert.deepEqual(parseMacPublisherKeychains('    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/owned/path with spaces.keychain-db"\n'),
    ["/Users/runner/Library/Keychains/login.keychain-db", "/owned/path with spaces.keychain-db"]);
  for (const value of ['', '/unquoted\n', '"relative"\n', '"/owned/../elsewhere"\n', '"/owned"\n"/owned"\n', '"/owned\u0000key"\n']) {
    assert.throws(() => parseMacPublisherKeychains(value));
  }
});
test("owned publisher selects one matching self-signed identity without granting publisher authority", () => {
  // Grammar follows Apple's SecurityTool identity_find.c; these are synthetic parser inputs.
  const identity = "A".repeat(40), row = `  1) ${identity} "WhisperFree Dev"`;
  const listing = (matchingRow: string, validRows: string, matchingCount = 1, validCount = 0) =>
    `\nPolicy: Code Signing\n  Matching identities\n${matchingRow}\n     ${matchingCount} identities found\n\n  Valid identities only\n${validRows}     ${validCount} valid identities found\n`;
  const selfSigned = listing(`${row} (CSSMERR_TP_NOT_TRUSTED)`, "");
  const trusted = listing(row, `${row}\n`, 1, 1);
  assert.equal(parseMacPublisherIdentity(selfSigned), identity);
  assert.equal(parseMacPublisherIdentity(trusted), identity);
  for (const value of ['', '     0 valid identities found\n', selfSigned + selfSigned, selfSigned.slice(0, -1), "x".repeat(65537),
    selfSigned.replace("  Matching identities", " Matching identities"), selfSigned.replace("  Valid identities only", " Valid identities only"),
    selfSigned.replace(identity, "A".repeat(39)), selfSigned.replace('WhisperFree Dev', 'unexpected\nline'),
    listing(`${row} (CSSMERR_TP_CERT_EXPIRED)`, ""), listing(`${row} (PRIVATE_ERROR)`, ""), listing(row, ""),
    listing(`${row} (CSSMERR_TP_NOT_TRUSTED)`, `${row}\n`, 1, 1), listing(row, `${row} (CSSMERR_TP_NOT_TRUSTED)\n`, 1, 1),
    listing(row, `${row.replace(identity, "B".repeat(40))}\n`, 1, 1), listing(row, `${row.replace('WhisperFree Dev', 'Other')}\n`, 1, 1),
    listing(`${row}\n${row}`, "", 2), listing(row, `${row}\n${row}\n`, 1, 2), listing(row, `${row}\n`, 1, 0)]) {
    assert.throws(() => parseMacPublisherIdentity(value), MacPublisherIdentityError);
  }
  assert.throws(() => parseMacPublisherIdentity(listing(`${row} (PRIVATE_ERROR)`, "")), (error: unknown) => {
    assert.ok(error instanceof MacPublisherIdentityError);
    assert.deepEqual({ category: error.category, matchingIdentities: error.matchingIdentities, validIdentities: error.validIdentities },
      { category: "IDENTITY_TRUST_REFUSED", matchingIdentities: "one", validIdentities: "zero" });
    assert.ok(!JSON.stringify(error).includes('PRIVATE_ERROR') && !error.message.includes('WhisperFree Dev')); return true;
  });
});
function publisherListing(entries: readonly { path: string; kind?: string; bytes?: number }[]) {
  return `Archive:  /owned/original.zip\nZip file size: 123 bytes, number of entries: ${entries.length}\n` + entries.map((entry) =>
    `${entry.kind ?? '-'}rwxr-xr-x  2.1 unx ${entry.bytes ?? 1} bx 1 stor 20261007.220837 ${entry.path}\n`).join('') +
    `${entries.length} files, 1 bytes uncompressed, 1 bytes compressed:  0.0%\n`;
}
test("fixed ZIP tool listing admits internal framework links and rejects escape and link-write entries", () => {
  const path = "OpenWhisper.app/Contents/Frameworks/whisper.framework/Versions/Current";
  assert.equal(parseMacPublisherZipListing(publisherListing([{ path: "OpenWhisper.app/", kind: "d", bytes: 0 },
    { path, kind: "l" }, { path: "__MACOSX/._OpenWhisper.app" }]), 123).length, 3);
  for (const entries of [[{ path: "../outside" }], [{ path: "/outside" }], [{ path: "OpenWhisper.app/../outside" }],
    [{ path: "OpenWhisper.app/link", kind: "l" }], [{ path, kind: "l" }, { path: `${path}/write` }],
    [{ path }, { path }], [{ path, kind: "p" }], [{ path: "OpenWhisper.app/huge", bytes: 2 * 1024 ** 3 + 1 }],
    [{ path: "OpenWhisper.app/control\rname" }]]) assert.throws(() => parseMacPublisherZipListing(publisherListing(entries), 123));
  assert.throws(() => parseMacPublisherZipListing(publisherListing([{ path }]), 124));
  assert.throws(() => parseMacPublisherZipListing(publisherListing([{ path }]).replace(' bx ', ' Bx '), 123));
  assert.throws(() => parseMacPublisherZipListing(publisherListing([{ path }]).replace(' bx ', ' bz '), 123));
  for (const compressedBytes of ['', '-1', '1.5', 'unknown', '9007199254740992']) {
    assert.throws(() => parseMacPublisherZipListing(publisherListing([{ path }]).replace(' bx 1 stor ', ` bx ${compressedBytes} stor `), 123));
  }
  assert.throws(() => parseMacPublisherZipListing(publisherListing([{ path }]).replace('number of entries: 1', 'number of entries: 2'), 123));
});
test("original ARM ZIP listing rows admit compressed sizes and both Info-ZIP extra-field indicators", () => {
  // Rows from the immutable same-run ARM archive; no archive contents are executed.
  const listing = `Archive:  /owned/original.zip\nZip file size: 138095968 bytes, number of entries: 3\n` +
    `drwxr-xr-x  2.1 unx        0 bx        0 stor 20261009.105214 OpenWhisper.app/\n` +
    `-rw-r--r--  2.1 unx   481746 bX   100464 defN 20261009.105221 OpenWhisper.app/Contents/_CodeSignature/CodeResources\n` +
    `lrwxr-xr-x  2.1 unx       35 b-       35 stor 20261009.085214 OpenWhisper.app/Contents/Frameworks/Electron Framework.framework/Electron Framework\n` +
    `3 files, 481781 bytes uncompressed, 100499 bytes compressed:  79.1%\n`;
  assert.deepEqual(parseMacPublisherZipListing(listing, 138095968), [
    { name: "OpenWhisper.app", kind: "directory", bytes: 0 },
    { name: "OpenWhisper.app/Contents/_CodeSignature/CodeResources", kind: "file", bytes: 481746 },
    { name: "OpenWhisper.app/Contents/Frameworks/Electron Framework.framework/Electron Framework", kind: "link", bytes: 35 },
  ]);
});
test("persistent completion requires measured self and ZIP acceptance, old publisher negatives and successful cleanup", () => {
  const oracle = { status: "PASS", originalRequirement: "ACCEPTED", validSameIdDifferentPublisher: "REJECTED" };
  const input = { smoke: { status: "PASS", architecture: "arm64", packageFormat: "universal",
    signatureAdmission: { signingMode: "persistent-validation", selfAvailability: "ACCEPTED" }, archiveAdmission: { publisherAvailability: "ACCEPTED" } },
    cleanup: { status: "PASS" }, staged: oracle, zip: oracle, package: { directory: "/owned/OpenWhisper.app", archive: "/owned/candidate.zip", sha256: "a".repeat(64) } };
  assert.equal(validateMacPublisherCompletion(input).smoke.status, "PASS");
  for (const changed of [{ ...input, cleanup: { status: "FAIL" } }, { ...input, staged: { ...oracle, originalRequirement: "UNAVAILABLE" } },
    { ...input, zip: { ...oracle, validSameIdDifferentPublisher: "ACCEPTED" } },
    { ...input, smoke: { ...input.smoke, architecture: "x64" } },
    { ...input, smoke: { ...input.smoke, signatureAdmission: { signingMode: "ad-hoc", selfAvailability: "UNAVAILABLE" } } },
    { ...input, smoke: { ...input.smoke, archiveAdmission: { publisherAvailability: "UNAVAILABLE" } } }]) assert.throws(() => validateMacPublisherCompletion(changed));
});

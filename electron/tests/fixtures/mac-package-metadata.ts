import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { buildIdentitySchema } from "../../src/contracts/build-identity.js";
import { darwinUniversalRecordingDescriptorSchema, developmentRecordingDescriptorSchema,
  selectDevelopmentRecordingDescriptor } from "../../src/main/development-recording-descriptor.js";
import { parseUpdateVersion } from "../../src/services/update-policy.js";

/** Explicit launcher selection never changes the captured production identity. */
export function parseMacPackageSmokeArguments(args: readonly string[]) {
  if (![6, 8, 10].includes(args.length) || args[0] !== "--package" || args[2] !== "--evidence" || args[4] !== "--fixtures" ||
    (args.length >= 8 && args[6] !== "--variant") || (args.length === 10 && args[8] !== "--package-format")) {
    throw new Error("Usage: owned-macos-package-smoke.ts --package /absolute/App.app --evidence /absolute/fresh/evidence --fixtures /absolute/pinned/fixtures [--variant development|stable [--package-format thin|universal]]");
  }
  const path = z.string().min(1).refine((value) => isAbsolute(value) && !value.includes("\0"));
  const variant = z.enum(["development", "stable"]).parse(args.length >= 8 ? args[7] : "development");
  const packageFormat = z.enum(["thin", "universal"]).parse(args.length === 10 ? args[9] : "thin");
  if (packageFormat === "universal" && variant !== "stable") throw new Error("Universal smoke requires the explicit stable variant.");
  return { variant, packageFormat, packagePath: path.parse(args[1]), evidencePath: path.parse(args[3]), fixturePath: path.parse(args[5]) };
}

const sourceSchema = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) });
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);
const universalReceiptSchema = z.strictObject({ version: z.literal(1), classification: z.literal("UNIVERSAL_VALIDATION_ONLY"),
  source: sourceSchema, sourceVersion: versionSchema, runtimeVersion: z.literal("44.7.0"), applicationBuild: buildIdentitySchema,
  merger: z.strictObject({ version: z.literal("3.0.6"),
    integrity: z.literal("sha512-MonS1kfkZdSEkLZI0pdR/TCx8ecxwRSFm7sORfwIkDI9UaIbHnk4Mgeqq+Ob9qDQRV8LZ9+hHCmimpA9BRcNxw=="),
    licenseSha256: z.literal("edab8abb78d9c5b36944c3e00aebf6a90eb32378993f49ac8a3904007029c629") }),
  signingMode: z.enum(["ad-hoc", "persistent-validation"]), originalThinRecording: darwinUniversalRecordingDescriptorSchema,
  signedRecording: darwinUniversalRecordingDescriptorSchema, updateAuthority: z.literal(false), runtimeAcceptance: z.literal(false),
  limitations: z.array(z.string().max(256)).max(16) });
const thinReceiptSchema = z.object({ version: z.literal(1), architecture: z.enum(["arm64", "x64"]), source: sourceSchema,
  sourceVersion: versionSchema, runtimeVersion: z.literal("44.7.0"), applicationBuild: buildIdentitySchema,
  unsignedRecording: developmentRecordingDescriptorSchema, signedRecording: developmentRecordingDescriptorSchema });

/** Consistency of original package evidence only; normal main still performs native admission. */
export function validateUniversalMacPackageMetadata(input: {
  readonly receipt: unknown; readonly thinReceipts: { readonly arm64: unknown; readonly x64: unknown };
  readonly applicationBuild: unknown; readonly source: unknown; readonly recordingModule: string; readonly host: unknown;
}) {
  const receipt = universalReceiptSchema.parse(input.receipt), identity = buildIdentitySchema.parse(input.applicationBuild);
  assert.equal(identity.kind, "stable"); assert.deepEqual(receipt.applicationBuild, identity);
  assert.deepEqual(receipt.source, sourceSchema.parse(input.source)); parseUpdateVersion(receipt.sourceVersion);
  // The generated module is a fixed JSON export; never execute package code here.
  const match = /^\s*(export\s+)?const DEVELOPMENT_RECORDING_BUILD(?:\s*:\s*unknown)?\s*=\s*(\{[^]*?\});\s*(export\s*\{\s*DEVELOPMENT_RECORDING_BUILD\s*\};)?\s*$/u.exec(input.recordingModule);
  if (!match?.[2] || Boolean(match[1]) === Boolean(match[3])) throw new Error("An original universal recording export is required.");
  const actual = darwinUniversalRecordingDescriptorSchema.parse(JSON.parse(match[2]) as unknown);
  assert.deepEqual(actual, receipt.signedRecording);
  for (const architecture of ["arm64", "x64"] as const) {
    const original = thinReceiptSchema.parse(input.thinReceipts[architecture]);
    assert.equal(original.architecture, architecture); assert.equal(original.sourceVersion, receipt.sourceVersion);
    assert.deepEqual(original.source, receipt.source); assert.deepEqual(original.applicationBuild, identity);
    selectDevelopmentRecordingDescriptor(original.unsignedRecording, { platform: "darwin", architecture });
    assert.deepEqual(selectDevelopmentRecordingDescriptor(original.signedRecording, { platform: "darwin", architecture }),
      receipt.originalThinRecording.architectures[architecture]);
  }
  const selected = selectDevelopmentRecordingDescriptor(actual, input.host);
  return { sourceVersion: receipt.sourceVersion, runtimeVersion: receipt.runtimeVersion, applicationBuild: identity,
    source: receipt.source, recordingDescriptor: selected, signingMode: receipt.signingMode };
}

/** Only the producer-admitted ad-hoc universal fixture has this known publisher limitation. */
export function classifyMacPublisherFixtureResult(input: {
  readonly packageFormat: "thin" | "universal"; readonly signingMode: "ad-hoc" | "persistent-validation";
  readonly result: { readonly accepted: boolean; readonly code: string | null; readonly osStatus: number | null };
} & ({ readonly fixture: "self" } | { readonly fixture: "real-package"; readonly selfAvailability: "ACCEPTED" | "UNAVAILABLE" })) {
  if (input.result.accepted) {
    assert.deepEqual(input.result, { accepted: true, code: null, osStatus: null });
    return "ACCEPTED" as const;
  }
  assert.equal(input.packageFormat, "universal"); assert.equal(input.signingMode, "ad-hoc");
  if (input.fixture === "real-package") assert.equal(input.selfAvailability, "UNAVAILABLE");
  assert.deepEqual(input.result, { accepted: false, code: "INVALID_SIGNATURE", osStatus: -67050 });
  return "UNAVAILABLE" as const;
}

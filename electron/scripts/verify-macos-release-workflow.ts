import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseApplicationBuildModule } from "../src/contracts/build-identity.js";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { readMacPreviewRecordingDescriptor, verifyMacPreviewRecordingDescriptor } from "./package-macos-preview.js";

const sourceSchema = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) });
const fileDigestSchema = z.strictObject({ bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const resultSchema = z.strictObject({ directory: z.string().min(1), archive: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const noticeSchema = z.object({ classification: z.literal("STABLE_RELEASE_INPUT"), architecture: z.enum(["arm64", "x64"]),
  sourceVersion: z.string().regex(/^\d+\.\d+\.\d+$/u), source: sourceSchema, signedRecording: developmentRecordingDescriptorSchema,
  native: z.array(z.strictObject({ path: z.string().min(1), unsigned: fileDigestSchema, signed: fileDigestSchema })).min(5),
  signingMode: z.literal("persistent-validation"), updateConfigured: z.literal(true), certificateFingerprint: z.string().regex(/^[a-f0-9]{40}$/iu) });
type NativeEvidence = z.infer<typeof noticeSchema>["native"];

export function parseMacReleaseInputNotice(value: unknown): z.infer<typeof noticeSchema> {
  return noticeSchema.parse(value);
}

export function validateSourceReceipt(value: unknown, expectedCommit: string): z.infer<typeof sourceSchema> {
  assert.match(expectedCommit, /^[a-f0-9]{40}$/u);
  const source = sourceSchema.parse(value);
  assert.equal(source.commit, expectedCommit);
  return source;
}

export async function verifyNativeEvidence(application: string, entries: NativeEvidence): Promise<void> {
  const root = resolve(application);
  for (const entry of entries) {
    const path = resolve(root, entry.path);
    assert.ok(path.startsWith(`${root}${sep}`), "Native evidence path must remain within the app.");
    const bytes = await readFile(path);
    assert.deepEqual({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, entry.signed);
  }
}

async function thinBuild(version: string, commit: string, architecture: "arm64" | "x64"): Promise<void> {
  assert.equal((await readFile("../VERSION", "utf8")).trim(), version);
  assert.equal((await readFile("dist/resources/VERSION", "utf8")).trim(), version);
  assert.deepEqual(parseApplicationBuildModule(await readFile("dist/main/application-build.js", "utf8")),
    { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" });
  validateSourceReceipt(JSON.parse(await readFile("dist/resources/development-build.json", "utf8")), commit);
  const recording = await readMacPreviewRecordingDescriptor(process.cwd());
  assert.equal(recording.platform, "darwin");
  assert.equal(recording.architecture, architecture);
  await verifyMacPreviewRecordingDescriptor(process.cwd(), recording);
}

async function thinResult(resultPath: string, output: string, version: string, commit: string,
  architecture: "arm64" | "x64", identity: string): Promise<void> {
  const result = resultSchema.parse(JSON.parse(await readFile(resultPath, "utf8")));
  const notice = parseMacReleaseInputNotice(JSON.parse(await readFile(join(result.directory, "Contents/Resources/notices/mac-stable-release-input.json"), "utf8")));
  const application = join(result.directory, "Contents/Resources/app");
  const source = validateSourceReceipt(JSON.parse(await readFile(join(application, "dist/resources/development-build.json"), "utf8")), commit);
  const builtVersion = (await readFile(join(application, "dist/resources/VERSION"), "utf8")).trim();
  assert.equal(notice.classification, "STABLE_RELEASE_INPUT");
  assert.equal(notice.architecture, architecture);
  assert.equal(notice.sourceVersion, version);
  assert.deepEqual(notice.source, source);
  assert.equal(builtVersion, version);
  assert.equal(notice.signingMode, "persistent-validation");
  assert.equal(notice.updateConfigured, true);
  const fingerprint = notice.certificateFingerprint.toLowerCase();
  assert.equal(fingerprint, identity.toLowerCase());
  const recording = await readMacPreviewRecordingDescriptor(application);
  assert.deepEqual(notice.signedRecording, recording);
  await verifyMacPreviewRecordingDescriptor(application, recording);
  await verifyNativeEvidence(application, notice.native);
  const archiveSha256 = createHash("sha256").update(await readFile(result.archive)).digest("hex");
  assert.equal(archiveSha256, result.sha256);
  await writeFile(join(output, "release-input.json"), JSON.stringify({ status: "PASS", architecture, sourceCommit: source.commit,
    sourceModified: source.modified, version, classification: notice.classification, signingMode: notice.signingMode,
    updateConfigured: notice.updateConfigured, certificateFingerprint: fingerprint, archive: basename(result.archive), archiveSha256 }, null, 2));
}

async function universalInputs(runnerTemp: string, version: string, commit: string): Promise<void> {
  for (const architecture of ["arm64", "x64"] as const) {
    const app = join(runnerTemp, `extracted-${architecture}`, "OpenWhisper.app");
    const application = join(app, "Contents/Resources/app");
    const notice = parseMacReleaseInputNotice(JSON.parse(await readFile(join(app, "Contents/Resources/notices/mac-stable-release-input.json"), "utf8")));
    const source = validateSourceReceipt(JSON.parse(await readFile(join(application, "dist/resources/development-build.json"), "utf8")), commit);
    const actualVersion = (await readFile(join(application, "dist/resources/VERSION"), "utf8")).trim();
    const recording = await readMacPreviewRecordingDescriptor(application);
    assert.equal(notice.architecture, architecture);
    assert.equal(notice.sourceVersion, version);
    assert.deepEqual(notice.source, source);
    assert.equal(actualVersion, version);
    assert.deepEqual(notice.signedRecording, recording);
    await verifyMacPreviewRecordingDescriptor(application, recording);
    await verifyNativeEvidence(application, notice.native);
  }
}

function argumentsMap(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) throw new Error("Invalid Mac release workflow arguments.");
    result.set(key, value);
  }
  return result;
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  const options = argumentsMap(args);
  const required = (key: string): string => {
    const value = options.get(key);
    if (value === undefined || value.length === 0) throw new Error(`Missing ${key}.`);
    return value;
  };
  if (mode === "thin-build") {
    await thinBuild(required("--version"), required("--commit"), z.enum(["arm64", "x64"]).parse(required("--architecture")));
  } else if (mode === "thin-result") {
    await thinResult(required("--result"), required("--output"), required("--version"), required("--commit"),
      z.enum(["arm64", "x64"]).parse(required("--architecture")), required("--identity"));
  } else if (mode === "universal-inputs") {
    await universalInputs(required("--runner-temp"), required("--version"), required("--commit"));
  } else throw new Error("Unknown Mac release workflow verification mode.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

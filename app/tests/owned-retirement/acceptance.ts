import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { z } from "zod";
import { EXPECTED_WITNESS_SHA256, IMAGE, SECCOMP_SHA256, FixtureError, shaSchema, runtimeSchema, suiteSchema, resultSchema,
  type ProbeResult, type Runtime, type Suite } from "./contract.js";

export const bundleNameSchema = z.enum(["node-parent.mjs", "electron-parent.mjs", "child-entry.mjs", "utility-entry.mjs"]);
const fileSchema = z.strictObject({ bytes: z.number().int().positive().max(4 * 1024 * 1024), sha256: shaSchema });
export const buildManifestSchema = z.strictObject({ version: z.literal(1), witnessSha256: z.literal(EXPECTED_WITNESS_SHA256),
  sources: z.record(z.string().max(256), fileSchema), bundles: z.record(bundleNameSchema, fileSchema),
  packages: z.strictObject({ electron: z.literal("44.7.0"), node: z.literal("24.21.0"), zod: z.literal("4.6.5"),
    typescript: z.literal("7.0.2"), esbuild: z.literal("0.28.2") }) });
export type BuildManifest = z.infer<typeof buildManifestSchema>;
const runtimePathSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u)
  .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."));
export const runtimeInputSchema = z.strictObject({ version: z.literal(1), image: z.literal(IMAGE), seccompSha256: z.literal(SECCOMP_SHA256),
  runtime: runtimeSchema, suite: suiteSchema, build: buildManifestSchema, electronSha256: shaSchema,
  runtimeFiles: z.record(runtimePathSchema,
    z.strictObject({ bytes: z.number().int().nonnegative().max(512 * 1024 * 1024), sha256: shaSchema })) });
const verificationStageSchema = z.enum(["input", "bundle", "runtime-inventory", "runtime-filesystem", "runtime-file", "runtime-version", "node-file", "runtime-evidence"]);
const verificationOperationSchema = z.enum(["lstat", "file-identity", "open", "opened-stat", "stream", "close", "after-stat", "hash", "read", "parse", "validate", "write", "import"]);
export const runtimeVerificationMetadataSchema = z.strictObject({ category: z.literal("RUNTIME_VERIFICATION_FAILED"),
  stage: verificationStageSchema, operation: verificationOperationSchema,
  index: z.number().int().nonnegative().max(1023).optional(),
  observedKind: z.enum(["regular-file", "directory", "symlink", "other"]).optional(),
  links: z.number().int().nonnegative().max(0xffff_ffff).optional() });
type VerificationMetadata = z.infer<typeof runtimeVerificationMetadataSchema>;
type VerificationContext = Readonly<{ stage: z.infer<typeof verificationStageSchema>; index?: number }>;
export class RuntimeVerificationFailure extends FixtureError {
  readonly metadata: Readonly<VerificationMetadata>;
  constructor(metadata: unknown) { super(); this.metadata = Object.freeze(runtimeVerificationMetadataSchema.parse(metadata)); }
}
/** Categorical diagnostics only; arbitrary exceptions, paths and contents are never serialized. */
export function runtimeFailureMetadata(error: unknown): Readonly<VerificationMetadata> | { category: "OTHER_PROBE_FAILURE" } {
  return error instanceof RuntimeVerificationFailure ? error.metadata : { category: "OTHER_PROBE_FAILURE" };
}
function metadata(context: VerificationContext, operation: VerificationMetadata["operation"], stat?: Stats): VerificationMetadata {
  const observedKind = stat?.isSymbolicLink() ? "symlink" : stat?.isFile() ? "regular-file" : stat?.isDirectory() ? "directory" : "other";
  return { category: "RUNTIME_VERIFICATION_FAILED", ...context, operation,
    ...(stat ? { observedKind, ...(Number.isInteger(stat.nlink) && stat.nlink >= 0 && stat.nlink <= 0xffff_ffff ? { links: stat.nlink } : {}) } : {}) };
}
function checked<T>(detail: VerificationMetadata, operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof RuntimeVerificationFailure) throw error;
    throw new RuntimeVerificationFailure(detail);
  }
}
async function checkedAsync<T>(detail: VerificationMetadata, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof RuntimeVerificationFailure) throw error;
    throw new RuntimeVerificationFailure(detail);
  }
}
type RuntimeFileIO = Readonly<Pick<typeof import("node:fs/promises"), "lstat" | "open" | "readFile">>;
const rawBrowserIdentitySchema = z.strictObject({ processType: z.literal("browser"), electronVersion: z.literal("44.7.0"),
  executable: z.literal("/owned-runtime/electron/electron") });
export function assertOwnedRawBrowserIdentity(input: unknown): void { rawBrowserIdentitySchema.parse(input); }
/** Shape checks cannot establish arbitrary function semantics; the actual API is a typed pinned built-in. */
export function assertRuntimeFileIOShape(input: unknown): void {
  assert.ok(typeof input === "object" && input !== null && "lstat" in input && typeof input.lstat === "function" &&
    "open" in input && typeof input.open === "function" && "readFile" in input && typeof input.readFile === "function");
}
async function runtimeFileIO(runtime: Runtime): Promise<{ io: RuntimeFileIO; marker: "original-fs" | "node:fs/promises" }> {
  if (runtime === "node") return { io: { lstat, open, readFile }, marker: "node:fs/promises" };
  const context = { stage: "runtime-filesystem" } satisfies VerificationContext;
  checked(metadata(context, "validate"), () => assertOwnedRawBrowserIdentity({
    processType: "type" in process && typeof process.type === "string" ? process.type : null,
    electronVersion: process.versions.electron ?? null, executable: process.execPath,
  }));
  // Fixed Electron built-in only: raw ASAR bytes must satisfy the same regular-file/FD/hash checks.
  const original = await checkedAsync(metadata(context, "import"), () => import("original-fs"));
  const io = checked(metadata(context, "validate"), () => {
    const api = original.default.promises; assertRuntimeFileIOShape(api); return api;
  });
  return { io, marker: "original-fs" };
}
async function boundedFile(path: string, maximumBytes: number, context: VerificationContext): Promise<Buffer> {
  const status = await checkedAsync(metadata(context, "lstat"), () => lstat(path));
  checked(metadata(context, "file-identity", status), () => {
    assert.ok(status.isFile() && !status.isSymbolicLink() && status.nlink === 1 && status.size <= maximumBytes);
  });
  const bytes = await checkedAsync(metadata(context, "read"), () => readFile(path));
  checked(metadata(context, "file-identity", status), () => { assert.equal(bytes.length, status.size); }); return bytes;
}
async function fileDigest(path: string, expected: { bytes: number; sha256: string }, context: VerificationContext, io: RuntimeFileIO): Promise<string> {
  const before = await checkedAsync(metadata(context, "lstat"), () => io.lstat(path));
  checked(metadata(context, "file-identity", before), () => {
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1); assert.equal(before.size, expected.bytes);
  });
  let count = 0; const hash = createHash("sha256");
  const file = await checkedAsync(metadata(context, "open"), () => io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW));
  try {
    const opened = await checkedAsync(metadata(context, "opened-stat"), () => file.stat());
    checked(metadata(context, "file-identity", opened), () => { assert.equal(opened.ino, before.ino); assert.equal(opened.dev, before.dev); });
    await checkedAsync(metadata(context, "stream"), async () => {
      for await (const bytes of file.createReadStream({ autoClose: false })) {
        count += bytes.length; assert.ok(count <= expected.bytes); hash.update(bytes);
      }
    });
  } finally { await checkedAsync(metadata(context, "close"), () => file.close()); }
  const after = await checkedAsync(metadata(context, "after-stat"), () => io.lstat(path));
  checked(metadata(context, "file-identity", after), () => {
    assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev); assert.equal(after.ctimeMs, before.ctimeMs);
  });
  return checked(metadata(context, "hash"), () => {
    assert.equal(count, expected.bytes); const digest = hash.digest("hex"); assert.equal(digest, expected.sha256); return digest;
  });
}
export async function verifyRuntimePayload(runtime: Runtime): Promise<void> {
  const inputBytes = await boundedFile("/payload/input.json", 256 * 1024, { stage: "input" });
  const parsed: unknown = checked(metadata({ stage: "input" }, "parse"), () => JSON.parse(inputBytes.toString("utf8")));
  const input = checked(metadata({ stage: "input" }, "validate"), () => runtimeInputSchema.parse(parsed));
  checked(metadata({ stage: "input" }, "validate"), () => {
    assert.equal(input.runtime, runtime); assert.equal(input.suite, process.env.OPENWHISPER_RETIREMENT_SUITE);
  });
  for (const [index, [name, expected]] of Object.entries(input.build.bundles).entries()) {
    const context = { stage: "bundle", index } satisfies VerificationContext;
    const bytes = await boundedFile(`/payload/${name}`, expected.bytes, context);
    checked(metadata(context, "hash"), () => {
      assert.equal(bytes.length, expected.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
    });
  }
  checked(metadata({ stage: "runtime-inventory" }, "validate"), () => {
    assert.ok(Object.keys(input.runtimeFiles).length <= 1024);
    assert.ok(Object.values(input.runtimeFiles).reduce((total, entry) => total + entry.bytes, 0) <= 1024 * 1024 * 1024);
  });
  const runtimeFiles = await runtimeFileIO(runtime);
  for (const [index, [path, expected]] of Object.entries(input.runtimeFiles).entries()) {
    await fileDigest(`/owned-runtime/electron/${path}`, expected, { stage: "runtime-file", index }, runtimeFiles.io);
  }
  checked(metadata({ stage: "runtime-version" }, "validate"), () => {
    assert.equal(input.runtimeFiles["electron"]?.sha256, input.electronSha256);
    if (runtime === "node") assert.equal(process.versions.node, "24.21.0"); else assert.equal(process.versions.electron, "44.7.0");
  });
  const node = await boundedFile("/opt/node/bin/node", 256 * 1024 * 1024, { stage: "node-file" });
  await checkedAsync(metadata({ stage: "runtime-evidence" }, "write"), () => import("node:fs/promises").then(({ writeFile }) => writeFile("/evidence/runtime.json", JSON.stringify({ image: input.image,
    runtime, uid: process.getuid?.(), parentPid: process.pid, versions: process.versions,
    nodeBinarySha256: createHash("sha256").update(node).digest("hex"), electronSha256: input.electronSha256,
    seccompSha256: input.seccompSha256, witnessSha256: input.build.witnessSha256,
    runtimeFileApi: runtimeFiles.marker }, null, 2), { mode: 0o600 })));
}
export function validateProbeResult(input: unknown, runtime: Runtime, suite: Suite): ProbeResult {
  const result = resultSchema.parse(input); assert.equal(result.runtime, runtime); assert.equal(result.suite, suite);
  assert.equal(result.cases.length, suite === "lifecycle" ? 4 : 1);
  const expectedNames = suite === "lifecycle" ? ["self-exit", "owned-term", "self-abort", "delayed-term"] : ["held-close"];
  assert.deepEqual(result.cases.map((item) => item.name), expectedNames);
  for (const [index, item] of result.cases.entries()) {
    assert.equal(item.parentPid, result.parentPid); assert.equal(item.spawnCount, index + 1); assert.equal(item.exitObserved, true);
    assert.notEqual(item.retiredBy, null); assert.equal(item.kernelAbsentAfterExit, item.retiredBy === "absence");
    assert.notEqual(item.exitAtMs, null); assert.equal(new Set(item.nonceHashes).size, item.nonceHashes.length);
    if (runtime === "electron") assert.equal(item.runtimePidUnsetAfterExit, true);
    const failed = item.name === "delayed-term" || item.name === "held-close";
    assert.equal(item.poisoned, failed); assert.equal(item.replacementRefused, failed);
    assert.ok(item.observations.some((observation) => observation.level === (failed ? "ambiguous" : "reaped")));
    if (item.name === "held-close") { assert.equal(item.actualDescriptorHeld, true); assert.equal(item.descriptorClosed, true); assert.equal(item.queuedBarrierSettledEarly, false); }
  }
  return result;
}

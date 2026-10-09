import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { makeUniversalApp, type MakeUniversalOpts } from "@electron/universal";
import { build } from "esbuild";
import { z } from "zod";
import { buildIdentitySchema, parseApplicationBuildModule } from "../src/contracts/application/build-identity.js";
import { darwinUniversalRecordingDescriptorSchema, developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { developmentArtifactSchema } from "../src/services/development/development-artifact.js";
import { parseUpdateVersion } from "../src/services/update/common/update-policy.js";
import { captureSignedMacDescriptor, digestMacPreviewFile as digest, inspectMacBinary, inspectMacMinimumOS,
  inspectMacPreviewFiles, insideOutMacCodePaths, macPreviewCodesignArguments, macPreviewSigningPolicy,
  readMacPreviewRecordingDescriptor, verifyMacPreviewBundleMetadata, verifyMacPreviewRecordingDescriptor,
  macPreviewUpdatePolicy, macPackageConstructionMode, writeMacPreviewUpdateBuild,
  type MacPackageConstructionMode, type MacPreviewSigningMode } from "./package-macos-preview.js";

type Architecture = "arm64" | "x64";
const architectures = ["arm64", "x64"] as const;
const appRelative = "Contents/Resources/app", descriptorRelative = `${appRelative}/dist/main/development-recording-build.js`;
const nativeRelative = ["dist/native/capture/openwhisper_macos_capture.node", "dist/native/openwhisper_macos_capture.node",
  "dist/native/openwhisper_macos_retirement.node", "dist/native/speech/cpu/openwhisper_speech.node", "dist/native/openwhisper_speech.node"];
const koffiRelative = (architecture: Architecture) => `${appRelative}/node_modules/@koromix/koffi-darwin-${architecture}`;
const snapshotRelative = (architecture: Architecture) => `Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/v8_context_snapshot.${architecture === "x64" ? "x86_64" : "arm64"}.bin`;
const thinPackageNotice = (mode: MacPackageConstructionMode) => `Contents/Resources/notices/${mode === "release" ? "mac-stable-release-input.json" : "mac-stable-validation-package.json"}`;
const namespaced = ["Contents/Resources/notices/mac-stable-validation-package.json", "Contents/Resources/notices/speech-cpu-unsigned-build.json",
  `${appRelative}/dist/native/macos-capture-notices/build-manifest.json`, `${appRelative}/dist/native/macos-retirement-notices/build-manifest.json`];
const sourceSchema = z.strictObject({ commit: z.string().length(40).regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) });
const mergerRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@electron/universal"))));
const mergerPin = { version: "3.0.6", integrity: "sha512-MonS1kfkZdSEkLZI0pdR/TCx8ecxwRSFm7sORfwIkDI9UaIbHnk4Mgeqq+Ob9qDQRV8LZ9+hHCmimpA9BRcNxw==",
  licenseSha256: "edab8abb78d9c5b36944c3e00aebf6a90eb32378993f49ac8a3904007029c629" } as const;
const receiptSchema = z.object({ version: z.literal(1), architecture: z.enum(architectures), sourceVersion: z.string(), source: sourceSchema,
  classification: z.string().optional(), signingMode: z.string().optional(), updateConfigured: z.boolean().optional(),
  runtimeVersion: z.literal("44.7.0"), applicationBuild: buildIdentitySchema, unsignedRecording: developmentRecordingDescriptorSchema, signedRecording: developmentRecordingDescriptorSchema,
  runtimeMachFiles: z.array(z.string().min(1).max(1024)).min(1).max(64),
  native: z.array(z.strictObject({ path: z.string(), unsigned: developmentArtifactSchema, signed: developmentArtifactSchema })).min(5).max(16) });
interface Item { readonly kind: "file" | "directory" | "link"; readonly mode: number; readonly bytes?: number; readonly sha256?: string; readonly target?: string }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const beneath = (root: string, value: string) => value === root || value.startsWith(`${root}/`);
async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return true; throw error; }
}

/** Physical inventory; framework links are recorded without recursive traversal. */
async function inventory(root: string): Promise<Map<string, Item>> {
  await inspectMacPreviewFiles(root, true);
  const result = new Map<string, Item>();
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), metadata = await lstat(path), key = relative(root, path);
      if (result.size >= 100_000) throw new Error("Universal package inventory exceeds its bound.");
      const mode = metadata.mode & 0o7777;
      if (metadata.isSymbolicLink()) {
        if (!key.startsWith("Contents/Frameworks/") || !key.split("/").some((part) => part.endsWith(".framework"))) throw new Error("Unexpected non-framework package link.");
        result.set(key, { kind: "link", mode, target: await readlink(path) });
      }
      else {
        if ((mode & 0o7022) !== 0) throw new Error("Unsafe universal package permissions.");
        if (metadata.isDirectory()) { result.set(key, { kind: "directory", mode }); await visit(path); }
        else if (metadata.isFile()) result.set(key, { kind: "file", mode, ...await digest(path) });
        else throw new Error("Unsupported universal package file type.");
      }
    }
  };
  await visit(root); return result;
}
function inventoryEqual(a: Map<string, Item>, b: Map<string, Item>): boolean { return same([...a].sort(), [...b].sort()); }
const toolSchema = z.enum(["/usr/bin/codesign", "/usr/bin/otool", "/usr/bin/ditto", "/usr/bin/plutil", "/usr/bin/tar"]);
const failureSchema = z.strictObject({ version: z.literal(1), status: z.literal("FAIL"), category: z.enum(["tool-exit", "tool-signal", "tool-spawn", "construction"]),
  tool: toolSchema.nullable(), nativePath: z.string().max(1024).nullable(), exit: z.number().int().nullable(),
  signal: z.string().regex(/^SIG[A-Z0-9]{1,12}$/u).nullable(), stderr: z.string().max(4096), stderrTruncated: z.boolean() });
type Tool = z.infer<typeof toolSchema>;
type ToolFailure = z.infer<typeof failureSchema>;
/** System-tool diagnostics only; arguments, absolute paths, URLs and signing identities are never retained. */
export function macUniversalToolFailure(command: Tool, result: { status: number | null; signal: NodeJS.Signals | null; error?: Error; stderr: unknown },
  args: readonly string[], nativePath: string | null = null): ToolFailure {
  if (nativePath !== null && (!nativePath.startsWith("Contents/") || nativePath.split("/").some((part) => ["", ".", ".."].includes(part)) ||
      /[\\\u0000-\u001f\u007f]/u.test(nativePath))) throw new Error("Invalid diagnostic native path.");
  const originalStderr = typeof result.stderr === "string" ? result.stderr : "";
  let stderr = originalStderr.slice(0, 16_384);
  for (const value of [...args].sort((a, b) => b.length - a.length)) if (isAbsolute(value) || /^[a-f0-9]{40}$/iu.test(value)) stderr = stderr.replaceAll(value, "<redacted>");
  stderr = stderr.replace(/https?:\/\/[^\s]+/giu, "<redacted-url>").replace(/\/[A-Za-z0-9_.~/-]+/gu, "<redacted-path>")
    .replace(/\b[a-f0-9]{40,64}\b/giu, "<redacted-identity>").replace(/[^\x20-\x7e\n\t]/gu, "?");
  const stderrTruncated = originalStderr.length > 16_384 || stderr.length > 4096;
  return failureSchema.parse({ version: 1, status: "FAIL", category: result.error ? "tool-spawn" : result.signal ? "tool-signal" : "tool-exit",
    tool: command, nativePath, exit: result.status, signal: result.signal, stderr: stderr.slice(0, 4096), stderrTruncated });
}
class MacUniversalToolError extends Error {
  constructor(readonly diagnostic: ToolFailure) {
    super(`Universal Mac validation tool failed: ${diagnostic.tool}, exit=${diagnostic.exit ?? "unavailable"}.`);
  }
}
export function macUniversalFailureDiagnostic(error: unknown): ToolFailure {
  return error instanceof MacUniversalToolError ? error.diagnostic : failureSchema.parse({ version: 1, status: "FAIL", category: "construction",
    tool: null, nativePath: null, exit: null, signal: null, stderr: "", stderrTruncated: false });
}
function tool(command: Tool, args: readonly string[], nativePath: string | null = null, environment?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, [...args], { ...(environment ? { env: environment } : {}), shell: false, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal !== null) throw new MacUniversalToolError(macUniversalToolFailure(command, result, args, nativePath));
  return result.stdout;
}
/** Disable archive(member) parsing so native helper names remain literal file paths. */
export function readMacUniversalLoadCommands(absolutePath: string, nativePath: string): string {
  return tool("/usr/bin/otool", ["-l", "-m", absolutePath], nativePath);
}

/** Inspect exactly two non-overlapping native slices, then retain the existing thin signing-policy checks. */
export function inspectUniversalMacBinary(bytes: Buffer): void {
  if (bytes.length < 8 || ![0xcafebabe, 0xcafebabf].includes(bytes.readUInt32BE()) || bytes.readUInt32BE(4) !== 2) throw new Error("Expected exactly two universal Mac slices.");
  const wide = bytes.readUInt32BE() === 0xcafebabf, width = wide ? 32 : 20, end = 8 + 2 * width;
  if (bytes.length < end) throw new Error("Truncated universal Mac header.");
  const ranges: { offset: number; size: number }[] = [], found = new Set<Architecture>();
  for (let i = 0; i < 2; i++) {
    const at = 8 + i * width, cpu = bytes.readUInt32BE(at), architecture = cpu === 0x100000c ? "arm64" : cpu === 0x1000007 ? "x64" : undefined;
    const offset = wide ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8);
    const size = wide ? Number(bytes.readBigUInt64BE(at + 16)) : bytes.readUInt32BE(at + 12), alignment = bytes.readUInt32BE(at + (wide ? 24 : 16));
    if (!architecture || found.has(architecture) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 32 ||
      offset < end || offset + size > bytes.length || alignment > 30 || offset % (2 ** alignment) !== 0 ||
      (wide && bytes.readUInt32BE(at + 28) !== 0) || ranges.some((range) => offset < range.offset + range.size && range.offset < offset + size)) throw new Error("Invalid universal Mac slice.");
    if (!inspectMacBinary(bytes.subarray(offset, offset + size), architecture) || bytes.readUInt32BE(at + 4) !== bytes.readUInt32LE(offset + 8)) throw new Error("Invalid universal Mac slice header.");
    found.add(architecture); ranges.push({ offset, size });
  }
}

async function admit(directory: string, architecture: Architecture, constructionMode: MacPackageConstructionMode) {
  if (!isAbsolute(directory) || resolve(directory) !== directory || /[\u0000-\u001f\u007f]/u.test(directory) || await realpath(directory) !== directory || !directory.endsWith("/OpenWhisper.app")) throw new Error("Expected a canonical stable thin Mac bundle.");
  const original = await inventory(directory), root = join(directory, appRelative);
  await inspectMacPreviewFiles(root);
  for (const name of ["app.asar", "app-x64", "app-arm64"]) if (!await absent(join(directory, "Contents/Resources", name))) throw new Error("Architecture shims are not admitted.");
  const identity = parseApplicationBuildModule(await readFile(join(root, "dist/main/application-build.js"), "utf8"));
  if (identity.kind !== "stable") throw new Error("Universal validation requires stable identity.");
  const metadata = z.object({ version: z.string(), main: z.literal("dist/main/index.js"), type: z.literal("module"),
    devDependencies: z.object({ electron: z.literal("44.7.0") }) }).parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  parseUpdateVersion(metadata.version);
  const source = sourceSchema.parse(JSON.parse(await readFile(join(root, "dist/resources/development-build.json"), "utf8")));
  if ((await readFile(join(root, "dist/resources/VERSION"), "utf8")).trim() !== metadata.version) throw new Error("Thin Mac version differs.");
  const recording = await readMacPreviewRecordingDescriptor(root);
  if (recording.platform !== "darwin" || recording.architecture !== architecture) throw new Error("Thin Mac recording architecture differs.");
  await verifyMacPreviewRecordingDescriptor(root, recording);
  const receipt = receiptSchema.parse(JSON.parse(await readFile(join(directory, thinPackageNotice(constructionMode)), "utf8")));
  if (receipt.architecture !== architecture || receipt.sourceVersion !== metadata.version || !same(receipt.source, source) ||
    !same(receipt.applicationBuild, identity) || receipt.unsignedRecording.platform !== "darwin" || receipt.unsignedRecording.architecture !== architecture ||
    !same(receipt.signedRecording, recording) || (constructionMode === "release" && (receipt.classification !== "STABLE_RELEASE_INPUT" ||
      receipt.signingMode !== "persistent-validation" || receipt.updateConfigured !== true)) ||
    (constructionMode === "validation" && receipt.classification !== undefined)) throw new Error("Thin package receipt differs.");
  const lock = z.object({ packages: z.record(z.string(), z.object({ version: z.string().optional() })) }).parse(JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")));
  const wrapper = z.object({ name: z.literal("koffi"), version: z.literal("3.3.2"), optionalDependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(join(root, "node_modules/koffi/package.json"), "utf8")));
  if (lock.packages["node_modules/koffi"]?.version !== wrapper.version || architectures.some((arch) => wrapper.optionalDependencies[`@koromix/koffi-darwin-${arch}`] !== "3.3.2" ||
    lock.packages[`node_modules/@koromix/koffi-darwin-${arch}`]?.version !== "3.3.2")) throw new Error("Darwin Koffi union differs from the locked wrapper.");
  const koffi = join(directory, koffiRelative(architecture));
  const dependency = z.object({ name: z.literal(`@koromix/koffi-darwin-${architecture}`), version: z.literal("3.3.2") }).parse(JSON.parse(await readFile(join(koffi, "package.json"), "utf8")));
  if (lock.packages[`node_modules/${dependency.name}`]?.version !== dependency.version || !await absent(join(directory, koffiRelative(architecture === "arm64" ? "x64" : "arm64")))) throw new Error("Thin Koffi identity differs.");
  const mach: string[] = [];
  for (const [path, item] of original) if (item.kind === "file") {
    const bytes = await readFile(join(directory, path));
    if (bytes.length >= 4 && [0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(bytes.readUInt32BE())) throw new Error("Thin inputs cannot contain universal Mach-O files.");
    if (inspectMacBinary(bytes, architecture)) mach.push(path);
    else if (path.endsWith(".node")) throw new Error("Native addon is not a matching thin Mach-O.");
  }
  const koffiMach = mach.filter((path) => beneath(koffiRelative(architecture), path));
  if (koffiMach.length !== 1 || koffiMach[0] !== `${koffiRelative(architecture)}/darwin_${architecture}/koffi.node`) throw new Error("Unexpected locked Darwin Koffi layout.");
  const appMach = mach.filter((path) => beneath(appRelative, path));
  if (!same(appMach.sort(), [...nativeRelative.map((path) => `${appRelative}/${path}`), ...koffiMach].sort())) throw new Error("Unexpected application native inventory.");
  for (const entry of receipt.native) {
    if (!appMach.includes(`${appRelative}/${entry.path}`) || !same(await digest(join(root, entry.path)), entry.signed)) throw new Error("Signed native receipt differs.");
  }
  if (new Set(receipt.native.map((entry) => entry.path)).size !== appMach.length) throw new Error("Incomplete native receipt.");
  const expectedRuntime = receipt.runtimeMachFiles.map((path) => path === "Contents/MacOS/Electron" ? "Contents/MacOS/OpenWhisper" : path);
  if (new Set(expectedRuntime).size !== expectedRuntime.length || !same(mach.filter((path) => !beneath(appRelative, path)).sort(), expectedRuntime.sort())) throw new Error("Runtime native inventory differs from the original receipt.");
  const ownSnapshot = original.get(snapshotRelative(architecture));
  if (ownSnapshot?.kind !== "file" || original.has(snapshotRelative(architecture === "arm64" ? "x64" : "arm64"))) throw new Error("Thin snapshot inventory differs.");
  return { directory, root, identity, version: metadata.version, source, recording, original, mach, koffiMach };
}

export interface MacUniversalOptions { readonly arm64AppPath: string; readonly x64AppPath: string; readonly output: string;
  readonly signingMode?: MacPreviewSigningMode; readonly enableUpdates?: boolean; readonly constructionMode?: MacPackageConstructionMode }
/** Normalize only captured architecture differences in fresh copies; never mutate the original thin packages. */
export async function stageMacUniversalInputs(options: MacUniversalOptions) {
  z.object({ name: z.literal("@electron/universal"), version: z.literal(mergerPin.version), license: z.literal("MIT") })
    .parse(JSON.parse(await readFile(join(mergerRoot, "package.json"), "utf8")));
  if ((await digest(join(mergerRoot, "LICENSE"))).sha256 !== mergerPin.licenseSha256) throw new Error("Universal merger license differs from its pin.");
  const constructionMode = options.constructionMode ?? "validation";
  const input = { arm64: await admit(options.arm64AppPath, "arm64", constructionMode), x64: await admit(options.x64AppPath, "x64", constructionMode) };
  if (!same(input.arm64.identity, input.x64.identity) || input.arm64.version !== input.x64.version || !same(input.arm64.source, input.x64.source)) throw new Error("Thin Mac provenance differs.");
  const signing = macPreviewSigningPolicy(options.signingMode ?? "ad-hoc", input.arm64.identity, input.arm64.version, input.arm64.source, process.env["SIGN_IDENTITY"]);
  const updatePolicy = macPreviewUpdatePolicy(options.enableUpdates, input.arm64.identity, signing);
  macPackageConstructionMode(constructionMode, input.arm64.identity, signing, updatePolicy);
  if (!isAbsolute(options.output) || resolve(options.output) !== options.output || /[\u0000-\u001f\u007f]/u.test(options.output) || !await absent(options.output) || await realpath(dirname(options.output)) !== dirname(options.output) ||
    architectures.some((architecture) => beneath(input[architecture].directory, options.output) || beneath(options.output, input[architecture].directory))) throw new Error("Expected a fresh isolated canonical output.");
  await mkdir(options.output, { mode: 0o700 });
  const staged = { arm64: join(options.output, "arm64", "OpenWhisper.app"), x64: join(options.output, "x64", "OpenWhisper.app") };
  const captured = darwinUniversalRecordingDescriptorSchema.parse({ version: 2, platform: "darwin", architectures: { arm64: input.arm64.recording, x64: input.x64.recording } });
  const module = (await build({ stdin: { contents: `export const DEVELOPMENT_RECORDING_BUILD: unknown = ${JSON.stringify(captured)};`, loader: "ts" },
    platform: "node", format: "esm", target: "node24", write: false, sourcemap: false })).outputFiles![0]!.contents;
  for (const architecture of architectures) { await mkdir(dirname(staged[architecture])); await cp(input[architecture].directory, staged[architecture], { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true }); }
  for (const architecture of architectures) {
    const destination = staged[architecture];
    if (!inventoryEqual(await inventory(destination), input[architecture].original)) throw new Error("Copied thin Mac inputs changed.");
    for (const path of [thinPackageNotice(constructionMode), ...namespaced.slice(1)]) {
      const source = join(destination, path);
      if (!await absent(source)) {
        const receipt = join(destination, "Contents/Resources/notices/architectures", architecture, path);
        await mkdir(dirname(receipt), { recursive: true }); await cp(source, receipt, { force: false, errorOnExist: true }); await rm(source);
      } else if (path === thinPackageNotice(constructionMode) || path === namespaced[1]) throw new Error("Missing original architecture receipt.");
    }
    for (const [path, item] of input[architecture].original) if (path.endsWith("/_CodeSignature/CodeResources")) {
      if (item.kind !== "file") throw new Error("Invalid original code seal.");
      await rm(join(destination, path)); await rmdir(dirname(join(destination, path)));
    }
    await writeFile(join(destination, descriptorRelative), module);
    // The merger is build-time tooling; no merger or shim code is copied into the application.
    await cp(join(mergerRoot, "LICENSE"), join(destination, "Contents/Resources/notices/universal-build-tool-LICENSE"), { force: false, errorOnExist: true });
  }
  for (const architecture of architectures) {
    const other = architecture === "arm64" ? "x64" : "arm64";
    const destination = join(staged[other], koffiRelative(architecture));
    await cp(join(staged[architecture], koffiRelative(architecture)), destination, { recursive: true, force: false, errorOnExist: true });
    await cp(join(staged[architecture], "Contents/Resources/notices/architectures", architecture),
      join(staged[other], "Contents/Resources/notices/architectures", architecture), { recursive: true, force: false, errorOnExist: true });
  }
  const copies = { arm64: await inventory(staged.arm64), x64: await inventory(staged.x64) };
  const allowedMach = new Set([...input.arm64.mach, ...input.x64.mach]);
  for (const key of new Set([...copies.arm64.keys(), ...copies.x64.keys()])) {
    const left = copies.arm64.get(key), right = copies.x64.get(key);
    if (key === snapshotRelative("arm64") || key === snapshotRelative("x64")) continue;
    if (allowedMach.has(key) && left?.kind === "file" && right?.kind === "file" && left.mode === right.mode) continue;
    if (!same(left, right)) throw new Error(`Unexplained universal package difference: ${key}.`);
  }
  for (const architecture of architectures) if (!inventoryEqual(await inventory(input[architecture].directory), input[architecture].original)) throw new Error("Original thin Mac inputs changed.");
  const koffiFiles = [...input.arm64.koffiMach, ...input.x64.koffiMach].sort();
  const merger: MakeUniversalOpts = { arm64AppPath: staged.arm64, x64AppPath: staged.x64, outAppPath: join(options.output, "OpenWhisper.app"),
    force: false, mergeASARs: false, x64ArchFiles: `{${koffiFiles.join(",")}}` };
  return { input, staged, captured, signing, merger, copies, nativeFiles: [...allowedMach].sort(), constructionMode, output: options.output };
}

/** Compare the complete signed application tree, including modes and relative framework-link targets. */
export async function verifyMacUniversalCopy(original: string, copy: string): Promise<void> {
  if (!isAbsolute(original) || !isAbsolute(copy) || resolve(original) !== original || resolve(copy) !== copy || original === copy) {
    throw new Error("Expected two distinct absolute Mac application paths.");
  }
  if (!inventoryEqual(await inventory(original), await inventory(copy))) throw new Error("Universal Mac copy changed signed files or framework links.");
}

async function verifyMerged(stage: Awaited<ReturnType<typeof stageMacUniversalInputs>>, signed = false,
  updateBuild?: Readonly<{ bytes: number; sha256: string }>): Promise<void> {
  const directory = stage.merger.outAppPath;
  const actual = await inventory(directory), reference = stage.copies.x64;
  for (const name of ["app.asar", "app-x64", "app-arm64"]) if (!await absent(join(directory, "Contents/Resources", name))) throw new Error("Universal merger introduced an architecture shim.");
  for (const key of new Set([...reference.keys(), ...actual.keys()])) {
    if (stage.nativeFiles.includes(key) || key === snapshotRelative("arm64")) continue;
    if (signed && key === `${appRelative}/dist/main/macos-update-build.js`) {
      if (!updateBuild || !same(actual.get(key), { kind: "file", mode: 0o644, ...updateBuild })) throw new Error("Universal updater configuration changed.");
      continue;
    }
    const packageNotice = `Contents/Resources/notices/${stage.constructionMode === "release" ? "mac-universal-release-package.json" : "mac-universal-validation-package.json"}`;
    if (signed && (key === descriptorRelative || key === packageNotice ||
      key.endsWith("/_CodeSignature") || key.endsWith("/_CodeSignature/CodeResources"))) continue;
    if (key.endsWith("/Info.plist")) {
      if (reference.get(key)?.kind !== "file" || actual.get(key)?.kind !== "file" || reference.get(key)?.mode !== actual.get(key)?.mode) throw new Error("Universal plist inventory changed.");
      const plist = (path: string) => z.record(z.string(), z.json()).parse(JSON.parse(tool("/usr/bin/plutil", ["-convert", "json", "-o", "-", path])));
      const before = plist(join(stage.staged.x64, key)), after = plist(join(directory, key));
      delete before.ElectronAsarIntegrity; delete after.ElectronAsarIntegrity;
      if (!isDeepStrictEqual(before, after)) throw new Error("Universal plist metadata changed.");
      continue;
    }
    if (!same(reference.get(key), actual.get(key))) throw new Error("Universal merger changed common resources.");
  }
  for (const path of stage.nativeFiles) {
    const bytes = await readFile(join(directory, path));
    const koffi = architectures.find((architecture) => stage.input[architecture].koffiMach.includes(path));
    if (koffi) { if (!inspectMacBinary(bytes, koffi)) throw new Error("Invalid Koffi native input."); }
    else inspectUniversalMacBinary(bytes);
    inspectMacMinimumOS(readMacUniversalLoadCommands(join(directory, path), path), path);
  }
  for (const architecture of architectures) if (!same(await digest(join(directory, snapshotRelative(architecture))), await digest(join(stage.input[architecture].directory, snapshotRelative(architecture))))) throw new Error("Original architecture snapshot changed.");
  for (const architecture of architectures) if (!inventoryEqual(await inventory(stage.staged[architecture]), stage.copies[architecture]) ||
    !inventoryEqual(await inventory(stage.input[architecture].directory), stage.input[architecture].original)) throw new Error("Original merger inputs changed.");
}

export async function packageMacUniversal(options: MacUniversalOptions): Promise<{ directory: string; archive: string; sha256: string }> {
  if (process.platform !== "darwin" || !architectures.includes(process.arch as Architecture) || process.getuid?.() === 0) throw new Error("Universal Mac packaging requires a non-root Darwin host.");
  for (const directory of [options.arm64AppPath, options.x64AppPath]) tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", directory]);
  const stage = await stageMacUniversalInputs(options);
  const updatePolicy = macPreviewUpdatePolicy(options.enableUpdates, stage.input.arm64.identity, stage.signing);
  await makeUniversalApp(stage.merger); await verifyMerged(stage);
  const directory = stage.merger.outAppPath, root = join(directory, appRelative), appMach = stage.nativeFiles.filter((path) => beneath(appRelative, path));
  for (const path of appMach) tool("/usr/bin/codesign", macPreviewCodesignArguments(stage.signing, join(directory, path)));
  await cp(join(root, nativeRelative[0]!), join(root, nativeRelative[1]!));
  const final = darwinUniversalRecordingDescriptorSchema.parse({ version: 2, platform: "darwin", architectures: {
    arm64: await captureSignedMacDescriptor(root, stage.captured.architectures.arm64),
    x64: await captureSignedMacDescriptor(root, stage.captured.architectures.x64) } });
  await build({ stdin: { contents: `export const DEVELOPMENT_RECORDING_BUILD: unknown = ${JSON.stringify(final)};`, loader: "ts" },
    outfile: join(root, "dist/main/development-recording-build.js"), platform: "node", format: "esm", target: "node24", sourcemap: false });
  const updateBuild = await writeMacPreviewUpdateBuild(root, updatePolicy);
  const constructionMode = options.constructionMode ?? "validation";
  const packageNotice = constructionMode === "release" ? "mac-universal-release-package.json" : "mac-universal-validation-package.json";
  await writeFile(join(directory, "Contents/Resources/notices", packageNotice), JSON.stringify({ version: 1,
    classification: constructionMode === "release" ? "UNIVERSAL_RELEASE_PACKAGE" : "UNIVERSAL_VALIDATION_ONLY", source: stage.input.arm64.source, sourceVersion: stage.input.arm64.version,
    runtimeVersion: "44.7.0", applicationBuild: stage.input.arm64.identity, merger: mergerPin, signingMode: stage.signing.mode, originalThinRecording: stage.captured,
    signedRecording: final, updateAuthority: false, updateConfigured: updatePolicy !== null, publicationAuthority: false, runtimeAcceptance: false,
    limitations: ["No notarization", ...(updatePolicy ? [constructionMode === "release" ? "No public release publication or end-user update acceptance" : "No update installation or public release acceptance"]
      : ["No stable update channel or public release acceptance"]), "No microphone/TCC or desktop runtime acceptance"] }, null, 2), { mode: 0o644 });
  for (const path of insideOutMacCodePaths(stage.nativeFiles.filter((path) => !beneath(appRelative, path)))) tool("/usr/bin/codesign", macPreviewCodesignArguments(stage.signing, join(directory, path)));
  const containers = (await readdir(join(directory, "Contents/Frameworks"))).filter((name) => name.endsWith(".framework") || name.endsWith(".app"));
  for (const name of containers) tool("/usr/bin/codesign", macPreviewCodesignArguments(stage.signing, join(directory, "Contents/Frameworks", name)));
  tool("/usr/bin/codesign", macPreviewCodesignArguments(stage.signing, directory));
  tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", directory]);
  await verifyMerged(stage, true, updateBuild);
  for (const architecture of architectures) await verifyMacPreviewRecordingDescriptor(root, final.architectures[architecture]);
  const helpers = containers.filter((name) => name.endsWith(".app"));
  verifyMacPreviewBundleMetadata(directory, stage.input.arm64.identity, stage.input.arm64.version, helpers);
  const archive = join(options.output, constructionMode === "release" ? "OpenWhisper-macOS.zip" :
    `OpenWhisper-validation-macOS-universal_${stage.input.arm64.version}_${stage.input.arm64.source.commit.slice(0, 12)}.zip`);
  tool("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", directory, archive]);
  const extracted = join(options.output, "archive-check"); await mkdir(extracted, { mode: 0o700 });
  tool("/usr/bin/tar", ["-x", "-f", archive, "-C", extracted, "--no-same-owner"], null, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  const bundle = join(extracted, "OpenWhisper.app"); tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", bundle]);
  await verifyMacUniversalCopy(directory, bundle);
  return { directory, archive, sha256: (await digest(archive)).sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (![6, 8, 9, 11].includes(args.length) || args[0] !== "--arm64-app" || args[2] !== "--x64-app" || args[4] !== "--output" ||
    !args[1] || !args[3] || !args[5] || (args.length >= 8 && (args[6] !== "--signing-mode" || args[7] !== "persistent-validation")) ||
    (args.length >= 9 && args[8] !== "--enable-updates") || (args.length === 11 && (args[9] !== "--construction-mode" || args[10] !== "release")))
    throw new Error("Usage: package-macos-universal.ts --arm64-app /owned/OpenWhisper.app --x64-app /owned/OpenWhisper.app --output /fresh/output [--signing-mode persistent-validation --enable-updates [--construction-mode release]]");
  try {
    console.log(JSON.stringify(await packageMacUniversal({ arm64AppPath: args[1], x64AppPath: args[3], output: args[5], ...(args.length >= 8 ? {
      signingMode: "persistent-validation", ...(args.length >= 9 ? { enableUpdates: true } : {}), ...(args.length === 11 ? { constructionMode: "release" } : {}) } : {}) })));
  } catch (error: unknown) {
    const diagnostic = process.env["OPENWHISPER_UNIVERSAL_DIAGNOSTIC"];
    if (diagnostic && isAbsolute(diagnostic) && resolve(diagnostic) === diagnostic) {
      try { await writeFile(diagnostic, JSON.stringify(macUniversalFailureDiagnostic(error)), { mode: 0o600, flag: "wx" }); }
      catch { /* Diagnostic failure must not replace the original construction refusal. */ }
    }
    throw error;
  }
}

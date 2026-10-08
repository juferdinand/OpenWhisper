import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { developmentRecordingDescriptorSchema, type DevelopmentRecordingDescriptor } from "../src/main/development-recording-descriptor.js";
import { parseApplicationBuildModule } from "../src/contracts/build-identity.js";
import { installedElectronExecutable } from "./runtime.js";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appId = "io.github.whisperfree.dev";
const metadataSchema = z.object({ name: z.literal("openwhisper-electron"), version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  main: z.literal("dist/main/index.js"), type: z.literal("module"), dependencies: z.record(z.string(), z.string()),
  devDependencies: z.object({ electron: z.literal("44.7.0") }) });
const dependencySchema = z.object({ name: z.string(), version: z.string(), dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional() });
const lockSchema = z.object({ lockfileVersion: z.literal(3), packages: z.record(z.string(), z.object({ version: z.string().optional() })) });
const buildSchema = z.strictObject({ commit: z.union([z.string().regex(/^[a-f0-9]{40}$/u), z.literal("source")]), modified: z.boolean() });
type Architecture = "arm64" | "x64";

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
const inside = (root: string, path: string): boolean => {
  const value = relative(root, path); return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
};
async function digest(path: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(path); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
/** Framework links must remain relative and inside the copied runtime; application inputs have no links. */
async function files(root: string, links = false): Promise<string[]> {
  const result: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const value = await lstat(path);
    if (value.isSymbolicLink()) {
      if (!links || isAbsolute(await readlink(path)) || !inside(root, await realpath(path))) throw new Error("Unsafe package input symlink.");
    } else if (value.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (value.isFile()) result.push(path);
    else throw new Error("Package inputs must be regular files, directories or internal runtime links.");
  };
  await visit(root); return result.sort();
}
async function dependencies(root: string, initial: Readonly<Record<string, string>>, architecture: Architecture): Promise<string[]> {
  const lock = lockSchema.parse(await json(join(root, "package-lock.json"))), selected = new Set<string>();
  const visit = async (name: string, optional: boolean): Promise<void> => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(name)) throw new Error("Invalid dependency name.");
    if (name.startsWith("@koromix/koffi-") && name !== `@koromix/koffi-darwin-${architecture}`) return;
    const path = join(root, "node_modules", name);
    if (selected.has(name) || (optional && !await exists(path))) return;
    const value = dependencySchema.parse(await json(join(path, "package.json")));
    if (value.name !== name || value.version !== lock.packages[`node_modules/${name}`]?.version ||
      (initial[name] !== undefined && initial[name] !== value.version)) throw new Error(`Dependency differs from locked metadata: ${name}.`);
    await files(path); selected.add(name);
    for (const child of Object.keys(value.dependencies ?? {})) await visit(child, false);
    for (const child of Object.keys(value.optionalDependencies ?? {})) await visit(child, true);
  };
  for (const name of Object.keys(initial)) await visit(name, false);
  if (!selected.has(`@koromix/koffi-darwin-${architecture}`)) throw new Error("Missing matching locked Darwin Koffi runtime.");
  return [...selected].sort();
}
async function descriptor(root: string): Promise<DevelopmentRecordingDescriptor> {
  const raw = await readFile(join(root, "dist/main/development-recording-build.js"), "utf8");
  const literal = /(?:export\s+)?const DEVELOPMENT_RECORDING_BUILD(?:\s*:\s*unknown)?\s*=\s*(\{[^]*?\});/u.exec(raw)?.[1];
  if (!literal) throw new Error("A captured production recording Dev build is required.");
  return developmentRecordingDescriptorSchema.parse(JSON.parse(literal));
}
async function unchangedGraph(root: string, value: DevelopmentRecordingDescriptor): Promise<void> {
  const entries = [...value.speechEntryGraph.entries, { path: "dist/workers/macos-capture-entry.js", ...value.captureEntry }];
  for (const entry of entries) if (JSON.stringify(await digest(join(root, entry.path))) !== JSON.stringify({ bytes: entry.bytes, sha256: entry.sha256 })) {
    throw new Error(`Captured recording input changed: ${entry.path}.`);
  }
}
async function verifyDescriptor(root: string, value: DevelopmentRecordingDescriptor): Promise<void> {
  if (value.platform !== "darwin") throw new Error("The preview requires a Darwin recording build.");
  await unchangedGraph(root, value);
  for (const [path, expected] of [
    ["dist/native/capture/openwhisper_macos_capture.node", value.capture],
    ["dist/native/openwhisper_macos_capture.node", value.capture],
    ["dist/native/openwhisper_macos_retirement.node", value.retirement],
    ...value.speech.entries.map((entry) => [`dist/native/speech/${entry.backend}/openwhisper_speech.node`, { bytes: entry.bytes, sha256: entry.sha256 }] as const),
  ] as const) if (JSON.stringify(await digest(join(root, path))) !== JSON.stringify(expected)) throw new Error(`Captured native input changed: ${path}.`);
}

/** Build-time finalization after codesign. Runtime admission never calls this function. */
export async function captureSignedMacDescriptor(root: string, original: DevelopmentRecordingDescriptor): Promise<DevelopmentRecordingDescriptor> {
  if (original.platform !== "darwin") throw new Error("The preview requires a Darwin recording build.");
  await unchangedGraph(root, original);
  const signed = developmentRecordingDescriptorSchema.parse({ ...original,
    capture: await digest(join(root, "dist/native/capture/openwhisper_macos_capture.node")),
    retirement: await digest(join(root, "dist/native/openwhisper_macos_retirement.node")),
    speech: { ...original.speech, entries: await Promise.all(original.speech.entries.map(async (entry) => ({ ...entry,
      ...await digest(join(root, `dist/native/speech/${entry.backend}/openwhisper_speech.node`)) }))) },
  });
  await build({ stdin: { contents: `export const DEVELOPMENT_RECORDING_BUILD: unknown = ${JSON.stringify(signed)};`, loader: "ts", resolveDir: root },
    outfile: join(root, "dist/main/development-recording-build.js"), platform: "node", format: "esm", target: "node24", sourcemap: false });
  await verifyDescriptor(root, signed); return signed;
}

export interface MacPreviewStageOptions { readonly root: string; readonly output: string; readonly architecture: Architecture }
export interface MacPreviewStage { readonly directory: string; readonly application: string; readonly version: string;
  readonly source: z.infer<typeof buildSchema>; readonly recording: DevelopmentRecordingDescriptor }

/** Copy existing inputs only; fixture tests exercise this without Mac tools or app execution. */
export async function stageMacPreview(options: MacPreviewStageOptions): Promise<MacPreviewStage> {
  const root = resolve(options.root), output = resolve(options.output);
  if (!isAbsolute(options.output) || options.output.includes("\0") || inside(root, output) || inside(output, root) || await exists(output) ||
    await realpath(root) !== root || await realpath(dirname(output)) !== dirname(output)) throw new Error("A fresh absolute output outside the real source tree is required.");
  const metadata = metadataSchema.parse(await json(join(root, "package.json"))), source = buildSchema.parse(await json(join(root, "dist/resources/development-build.json")));
  if (parseApplicationBuildModule(await readFile(join(root, "dist/main/application-build.js"), "utf8")).kind !== "development") {
    throw new Error("Mac preview packaging requires its captured Dev build identity.");
  }
  if ((await readFile(join(root, "dist/resources/VERSION"), "utf8")).trim() !== metadata.version) throw new Error("Source and build versions differ.");
  const recording = await descriptor(root);
  if (recording.architecture !== options.architecture) throw new Error("Recording architecture differs from the package.");
  await verifyDescriptor(root, recording);
  const distribution = join(root, "node_modules/electron/dist"), runtime = join(distribution, "Electron.app");
  if ((await readFile(join(distribution, "version"), "utf8")).trim().replace(/^v/u, "") !== metadata.devDependencies.electron ||
    (await readFile(join(root, "node_modules/electron/path.txt"), "utf8")).trim() !== "Electron.app/Contents/MacOS/Electron") throw new Error("Pinned Darwin runtime metadata differs.");
  await files(runtime, true); await files(join(root, "dist"));
  const selected = await dependencies(root, metadata.dependencies, options.architecture);
  const notices = [[join(distribution, "LICENSE"), "Electron-LICENSE"], [join(distribution, "LICENSES.chromium.html"), "LICENSES.chromium.html"],
    [resolve(root, "../LICENSE"), "OpenWhisper-LICENSE"], [join(root, "dist/ui/fonts/LICENSE.txt"), "Inter-LICENSE.txt"],
    [join(root, "vendor/whisper.cpp/LICENSE"), "whisper.cpp-LICENSE"], [join(root, "native/build-cpu/build-manifest.json"), "speech-cpu-unsigned-build.json"],
    ...["LICENSE-MIT", "LICENSE-APACHE-2.0", "LICENSE.spdx"].map((name) => [resolve(root, "../shared/ui/node_modules/@tauri-apps/api", name), `tauri-api-${name}`])];
  const icon = resolve(root, "../macos/Resources/AppIcon.icns");
  for (const [path] of [...notices, [icon]]) { if (!path) throw new Error("Missing notice input."); await files(path); }
  await mkdir(output, { mode: 0o700 });
  const directory = join(output, "OpenWhisper Dev.app"), application = join(directory, "Contents/Resources/app");
  await cp(runtime, directory, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
  // Electron44's isPackaged checks the executable basename; "Electron" remains a raw runtime.
  await rename(join(directory, "Contents/MacOS/Electron"), join(directory, "Contents/MacOS/OpenWhisper Dev"));
  if (await exists(application) || await exists(join(directory, "Contents/Resources/app.asar"))) throw new Error("Runtime contains an unexpected application.");
  await mkdir(application);
  await cp(join(root, "dist"), join(application, "dist"), { recursive: true,
    filter: (path) => !relative(join(root, "dist"), path).split(sep).some((part) => part.includes("retirement_probe") || part === "macos-retirement-probe-notices") });
  for (const name of ["package.json", "package-lock.json"]) await cp(join(root, name), join(application, name));
  for (const name of selected) {
    const destination = join(application, "node_modules", name); await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, "node_modules", name), destination, { recursive: true });
  }
  const noticeDirectory = join(directory, "Contents/Resources/notices"); await mkdir(noticeDirectory);
  for (const [path, name] of notices) { if (!path || !name) throw new Error("Missing notice input."); await cp(path, join(noticeDirectory, name)); }
  await cp(icon, join(directory, "Contents/Resources/AppIcon.icns"));
  await writeFile(join(noticeDirectory, "README.txt"), "OpenWhisper Dev. Per-architecture, non-hardened ad-hoc development signing; no notarization or stable update channel.\nOriginal source metadata and unsigned native build manifests are preserved. The final recording descriptor captures signed native bytes.\nNo models included. Package checks do not establish microphone/TCC, desktop input or stable updater acceptance.\n");
  await verifyDescriptor(application, recording);
  return { directory, application, version: metadata.version, source, recording };
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Mac preview tool failed: ${command}: ${result.stderr}`);
  return result.stdout;
}
/** Official 44.7.0 arm64 binaries have linker ad-hoc signatures without entitlements; x64 are unsigned.
 * Reject a different signing policy instead of guessing entitlements or disabling native admission. */
export function inspectMacBinary(bytes: Buffer, architecture: Architecture): boolean {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) return false;
  if (bytes.readUInt32LE(4) !== (architecture === "arm64" ? 0x100000c : 0x1000007)) throw new Error("Unexpected Mach-O architecture.");
  let offset = 32;
  for (let index = 0; index < bytes.readUInt32LE(16); index++) {
    if (offset + 8 > bytes.length) throw new Error("Invalid Mach-O load command.");
    const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > bytes.length) throw new Error("Invalid Mach-O load command.");
    if (command === 0x1d) {
      if (size < 16) throw new Error("Invalid Mach-O signature command.");
      const start = bytes.readUInt32LE(offset + 8), length = bytes.readUInt32LE(offset + 12), blob = bytes.subarray(start, start + length);
      if (blob.length !== length || blob.length < 12 || blob.readUInt32BE(0) !== 0xfade0cc0) throw new Error("Unknown runtime code signature.");
      const count = blob.readUInt32BE(8);
      for (let slot = 0; slot < count; slot++) {
        const entry = 12 + slot * 8; if (entry + 8 > blob.length) throw new Error("Invalid signature inventory.");
        const type = blob.readUInt32BE(entry), position = blob.readUInt32BE(entry + 4);
        if (type === 5 || type === 7) throw new Error("Unexpected runtime entitlements; explicit signing review required.");
        if (type === 0 || (type >= 0x1000 && type < 0x1005)) {
          if (position + 16 > blob.length || (blob.readUInt32BE(position + 12) & 0x10000) !== 0) throw new Error("Unexpected hardened runtime policy.");
        }
      }
    }
    offset += size;
  }
  return true;
}
async function machFiles(root: string, architecture: Architecture, inspectPolicy: boolean): Promise<string[]> {
  const result: string[] = [];
  for (const path of await files(root, true)) {
    const file = await open(path, "r"), header = Buffer.alloc(4);
    try { await file.read(header, 0, 4, 0); } finally { await file.close(); }
    if (header.readUInt32LE() === 0xfeedfacf) {
      const bytes = await readFile(path);
      if (inspectPolicy) inspectMacBinary(bytes, architecture);
      else if (bytes.readUInt32LE(4) !== (architecture === "arm64" ? 0x100000c : 0x1000007)) throw new Error("Unexpected Mach-O architecture.");
      result.push(path);
    } else if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32LE())) throw new Error("Universal inputs are outside this per-architecture preview.");
  }
  return result;
}
function updatePlist(path: string, values: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(values)) run("/usr/bin/plutil", ["-replace", key, "-string", value, path]);
  run("/usr/bin/plutil", ["-lint", path]);
}

/** otool also prints SDK, linker/tool and LC_SOURCE_VERSION values; only deployment fields are OS floors. */
export function inspectMacMinimumOS(output: string, path: string): string {
  const minimums: number[][] = [];
  let command = "";
  for (const line of output.split("\n")) {
    const next = /^\s*cmd\s+(LC_[A-Z0-9_]+)\s*$/u.exec(line)?.[1];
    if (next) { command = next; continue; }
    const field = command === "LC_BUILD_VERSION" ? "minos" : command === "LC_VERSION_MIN_MACOSX" ? "version" : undefined;
    const match = field ? new RegExp(`^\\s*${field} (\\d+)\\.(\\d+)(?:\\.(\\d+))?\\s*$`, "u").exec(line) : null;
    if (match) minimums.push([Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]);
  }
  if (!minimums.length) throw new Error(`Native package input ${path} has no measured macOS deployment floor (LC_BUILD_VERSION minos / LC_VERSION_MIN_MACOSX version).`);
  const highest = minimums.sort((left, right) => (right[0]! - left[0]!) || (right[1]! - left[1]!) || (right[2]! - left[2]!))[0]!;
  const floor = highest.join(".");
  if (highest[0]! > 14 || (highest[0] === 14 && (highest[1]! > 0 || highest[2]! > 0))) {
    throw new Error(`Native package input ${path} requires measured macOS ${floor}, exceeding the macOS 14.0.0 preview baseline.`);
  }
  return floor;
}

/** The unsigned Intel runtime requires nested executables/dylibs before enclosing framework code. */
export function insideOutMacCodePaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => right.split(sep).length - left.split(sep).length ||
    (left < right ? -1 : left > right ? 1 : 0));
}

export async function packageMacPreview(output: string, root = defaultRoot): Promise<{ directory: string; archive: string; sha256: string }> {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64") || process.getuid?.() === 0) throw new Error("Mac preview packaging requires a non-root Darwin architecture host.");
  const architecture = process.arch;
  await installedElectronExecutable(root);
  const inputRuntime = join(root, "node_modules/electron/dist/Electron.app");
  const inventory = await machFiles(inputRuntime, architecture, true);
  const staged = await stageMacPreview({ root, output, architecture });
  const plist = join(staged.directory, "Contents/Info.plist");
  updatePlist(plist, { CFBundleIdentifier: appId, CFBundleExecutable: "OpenWhisper Dev", CFBundleName: "OpenWhisper Dev", CFBundleDisplayName: "OpenWhisper Dev",
    CFBundleVersion: staged.version, CFBundleShortVersionString: staged.version, CFBundleIconFile: "AppIcon", LSMinimumSystemVersion: "14.0",
    NSMicrophoneUsageDescription: "OpenWhisper Dev needs microphone access to record your voice. Everything stays on your Mac." });
  const helpers = (await readdir(join(staged.directory, "Contents/Frameworks"))).filter((name) => name.endsWith(".app"));
  for (const name of helpers) updatePlist(join(staged.directory, "Contents/Frameworks", name, "Contents/Info.plist"), {
    CFBundleIdentifier: `${appId}.helper.${name.replace(/[^a-z0-9]+/giu, "-").replace(/-$/u, "").toLowerCase()}`,
  });
  const appMach = await machFiles(staged.application, architecture, false);
  const addons = (await files(staged.application)).filter((path) => path.endsWith(".node"));
  if (addons.length < 5 || addons.some((path) => !appMach.includes(path))) throw new Error("Every production native addon must be a matching Mach-O file.");
  for (const path of appMach) inspectMacMinimumOS(run("/usr/bin/otool", ["-l", path]), relative(staged.application, path));
  const nativeInputs = await Promise.all(appMach.map(async (path) => ({ path: relative(staged.application, path), unsigned: await digest(path) })));
  for (const path of appMach) run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", path]);
  // The source build keeps a second capture copy. Keep both signed copies identical.
  await cp(join(staged.application, "dist/native/capture/openwhisper_macos_capture.node"), join(staged.application, "dist/native/openwhisper_macos_capture.node"));
  const signed = await captureSignedMacDescriptor(staged.application, staged.recording);
  await writeFile(join(staged.directory, "Contents/Resources/notices/mac-dev-package.json"), JSON.stringify({
    version: 1, architecture, sourceVersion: staged.version, source: staged.source, runtimeVersion: "44.7.0",
    signing: "non-hardened ad-hoc Dev; no entitlements", runtimeMachFiles: inventory.map((path) => relative(inputRuntime, path)),
    unsignedRecording: staged.recording, signedRecording: signed,
    native: await Promise.all(nativeInputs.map(async (entry) => ({ ...entry, signed: await digest(join(staged.application, entry.path)) }))),
    limitations: ["No notarization", "No stable update channel or universal support", "No microphone/TCC or desktop runtime acceptance"],
  }, null, 2));
  const runtimeMach = (await machFiles(staged.directory, architecture, false)).filter((path) => !inside(staged.application, path));
  for (const path of insideOutMacCodePaths(runtimeMach)) run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", path]);
  const frameworks = (await readdir(join(staged.directory, "Contents/Frameworks"))).filter((name) => name.endsWith(".framework"));
  for (const name of [...frameworks, ...helpers]) run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", join(staged.directory, "Contents/Frameworks", name)]);
  run("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", staged.directory]);
  for (const path of appMach) run("/usr/bin/codesign", ["--verify", "--strict", path]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged.directory]);
  await machFiles(staged.directory, architecture, true);
  await verifyDescriptor(staged.application, await descriptor(staged.application));
  if (run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]).trim() !== appId) throw new Error("Dev bundle identity verification failed.");
  const archive = join(output, `OpenWhisper-Dev-macOS-${architecture}_${staged.version}_${staged.source.commit.slice(0, 12)}${staged.source.modified ? ".modified" : ""}.zip`);
  run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", staged.directory, archive]);
  const extracted = join(output, "archive-check");
  run("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
  const extractedApp = join(extracted, "OpenWhisper Dev.app"), extractedRoot = join(extractedApp, "Contents/Resources/app");
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", extractedApp]);
  await verifyDescriptor(extractedRoot, signed);
  for (const path of ["package.json", "package-lock.json", "dist/resources/development-build.json"]) {
    if (JSON.stringify(await digest(join(extractedRoot, path))) !== JSON.stringify(await digest(join(root, path)))) throw new Error("Archived source metadata changed.");
  }
  await files(extractedApp, true);
  return { directory: staged.directory, archive, sha256: (await digest(archive)).sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--output" || !process.argv[3]) throw new Error("Usage: package-macos-preview.ts --output /absolute/fresh/output");
  console.log(JSON.stringify(await packageMacPreview(process.argv[3])));
}

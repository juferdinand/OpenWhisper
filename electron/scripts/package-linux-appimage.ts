import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseApplicationBuildModule } from "../src/contracts/build-identity.js";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { appImageLauncher } from "../src/services/linux-appimage-launcher.js";
import { linuxSupervisorLauncher } from "../src/cli/linux-supervisor-bootstrap.js";
export { appImageLauncher };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const producerSchema = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.boolean() });
const artifactSchema = z.strictObject({ bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const pinSchema = artifactSchema.extend({ version: z.string(), commit: z.string().regex(/^[a-f0-9]{40}$/u), url: z.string().url() });
const toolsSchema = z.strictObject({ appimagetool: pinSchema, runtime: pinSchema.extend({ digestMd5Offset: z.number().int().nonnegative(),
  licenseBytes: z.number().int().positive(), licenseSha256: z.string().regex(/^[a-f0-9]{64}$/u) }) });
const noticeNames = ["libfuse-LICENSE", "libfuse-LGPL2.txt", "squashfuse-LICENSE", "musl-COPYRIGHT", "zstd-LICENSE", "zlib-LICENSE", "mimalloc-LICENSE"] as const;
const runtimeNoticesSchema = z.strictObject({ runtimeCommit: z.string(), upstreamBuild: z.string().url(), upstreamMakefile: z.string().url(),
  classification: z.literal("LICENSE_TEXTS_AND_UPSTREAM_BUILD_PROVENANCE_ONLY"), publicDistributionGate: z.string(),
  entries: z.array(artifactSchema.extend({ path: z.enum(noticeNames), source: z.string().url(), scope: z.string() })).length(noticeNames.length),
}).refine((value) => new Set(value.entries.map((entry) => entry.path)).size === noticeNames.length);
type Entry = { readonly type: "file" | "directory" | "symlink"; readonly target?: string; readonly mode: number; readonly bytes: number; readonly sha256: string };
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const inside = (parent: string, child: string): boolean => { const value = relative(parent, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value)); };
async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true; throw error;
  }
}
async function canonical(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\p{Cc}]/u.test(path) || await realpath(path) !== path) throw new Error("UNSAFE_PACKAGE_PATH");
}
async function inventory(path: string, prefix = "", iconLink?: string): Promise<Record<string, Entry>> {
  const result: Record<string, Entry> = {};
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const name = join(prefix, entry.name), file = join(path, entry.name), stat = await lstat(file);
    if (stat.isSymbolicLink()) {
      if (prefix !== "" || entry.name !== ".DirIcon" || !iconLink || await readlink(file) !== iconLink) throw new Error("UNSAFE_PACKAGE_INPUT");
      const bytes = Buffer.from(iconLink); result[name] = { type: "symlink", target: iconLink, mode: stat.mode & 0o7777,
        bytes: bytes.length, sha256: hash(bytes) }; continue;
    }
    if (stat.isDirectory()) { result[name] = { type: "directory", mode: stat.mode & 0o7777, bytes: 0, sha256: hash(new Uint8Array()) };
      Object.assign(result, await inventory(file, name)); }
    else {
      if (!stat.isFile()) throw new Error("UNSAFE_PACKAGE_INPUT");
      const bytes = await readFile(file); result[name] = { type: "file", mode: stat.mode & 0o7777, bytes: bytes.length, sha256: hash(bytes) };
    }
  }
  return result;
}

function appRun(executable: string): string {
  if (executable === "openwhisper") return linuxSupervisorLauncher("appimage");
  return ["#!/bin/sh", "set -eu", 'bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `exec "$bundle/usr/lib/${executable}/${executable}" "$@"`, ""].join("\n");
}
function command(executable: string, args: readonly string[], cwd: string, receipt: string, env?: NodeJS.ProcessEnv): string {
  const reply = spawnSync(executable, args, { cwd, env, shell: false, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  const bounded = (value: string | null): { bytes: number; truncated: boolean; text: string } => {
    const bytes = Buffer.from(value ?? "", "utf8"); return { bytes: bytes.length, truncated: bytes.length > 64 * 1024,
      text: bytes.subarray(0, 64 * 1024).toString("utf8") };
  };
  writeFileSync(receipt, `${JSON.stringify({ originalPid: reply.pid, exitCode: reply.status, signal: reply.signal,
    errorCategory: reply.error ? "EXECUTION_FAILED" : null, stdout: bounded(reply.stdout), stderr: bounded(reply.stderr) }, null, 2)}\n`,
  { mode: 0o600, flag: "wx" });
  if (reply.error || reply.status !== 0) throw new Error(`APPIMAGE_COMMAND_FAILED:${reply.status ?? "unknown"}`);
  return reply.stdout;
}
export interface LinuxAppImageOptions { readonly directory: string; readonly output: string; readonly tools: string }

/** Wrap existing Ubuntu22 package bytes only. No builds, downloads, signing, installation or application launch. */
export async function packageLinuxAppImage(options: LinuxAppImageOptions): Promise<{ image: string; launcher: string; receipt: string }> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("UNSUPPORTED_APPIMAGE_HOST");
  const { directory, output, tools } = options;
  await canonical(directory); await canonical(tools); await canonical(dirname(output));
  if (!isAbsolute(output) || resolve(output) !== output || /[\p{Cc}]/u.test(output) || !await absent(output) ||
      [directory, tools, root].some((input) => inside(input, output) || inside(output, input))) throw new Error("UNSAFE_PACKAGE_OUTPUT");
  const pins = toolsSchema.parse(JSON.parse(await readFile(join(root, "native/appimage-tools.json"), "utf8")) as unknown);
  for (const [file, pin] of [["appimagetool-x86_64.AppImage", pins.appimagetool], ["runtime-x86_64", pins.runtime]] as const) {
    const path = join(tools, file); await canonical(path); const stat = await lstat(path), bytes = await readFile(path);
    if (!stat.isFile() || (stat.mode & 0o111) === 0 || bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) throw new Error("APPIMAGE_TOOL_PIN_MISMATCH");
  }
  const license = await readFile(join(root, "native/appimage-runtime-LICENSE"));
  if (license.length !== pins.runtime.licenseBytes || hash(license) !== pins.runtime.licenseSha256) throw new Error("APPIMAGE_RUNTIME_LICENSE_MISMATCH");
  const noticesRoot = join(root, "native/appimage-runtime-notices"), noticesManifestBytes = await readFile(join(noticesRoot, "manifest.json"));
  const runtimeNotices = runtimeNoticesSchema.parse(JSON.parse(noticesManifestBytes.toString("utf8")) as unknown);
  if (runtimeNotices.runtimeCommit !== pins.runtime.commit) throw new Error("APPIMAGE_RUNTIME_NOTICE_PROVENANCE_MISMATCH");
  for (const notice of runtimeNotices.entries) {
    const path = join(noticesRoot, notice.path), stat = await lstat(path), bytes = await readFile(path);
    if (!stat.isFile() || stat.isSymbolicLink() || bytes.length !== notice.bytes || hash(bytes) !== notice.sha256) throw new Error("APPIMAGE_RUNTIME_NOTICE_MISMATCH");
  }
  const before = await inventory(directory), application = join(directory, "resources/app"), dist = join(application, "dist");
  const identity = parseApplicationBuildModule(await readFile(join(dist, "main/application-build.js"), "utf8"));
  const executable = identity.kind === "stable" ? "openwhisper" : "openwhisper-dev";
  if (before[executable]?.type !== "file" || (before[executable].mode & 0o111) === 0) throw new Error("MISSING_PACKAGE_EXECUTABLE");
  const version = (await readFile(join(dist, "resources/VERSION"), "utf8")).trim();
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version) ||
      z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(application, "package.json"), "utf8"))).version !== version) throw new Error("PACKAGE_VERSION_MISMATCH");
  const producer = producerSchema.parse(JSON.parse(await readFile(join(dist, "resources/development-build.json"), "utf8")) as unknown);
  const descriptorLiteral = /(?:export\s+)?const DEVELOPMENT_RECORDING_BUILD\s*=\s*(\{[^]*?\});/u
    .exec(await readFile(join(dist, "main/development-recording-build.js"), "utf8"))?.[1];
  if (!descriptorLiteral) throw new Error("MISSING_CAPTURED_PACKAGE_RECORDING");
  const descriptor = developmentRecordingDescriptorSchema.parse(JSON.parse(descriptorLiteral) as unknown);
  if (descriptor.platform !== "linux" || descriptor.architecture !== "x64" || !descriptor.platformServices) throw new Error("PACKAGE_RECORDING_MISMATCH");
  const captured = [...descriptor.speechEntryGraph.entries,
    { path: "dist/native/capture/openwhisper_capture.node", ...descriptor.capture }, { path: "dist/workers/capture-entry.js", ...descriptor.captureEntry },
    { path: "dist/workers/platform-entry.js", ...descriptor.platformServices.entry }, { path: "dist/native/openwhisper_linux_bus.node", ...descriptor.platformServices.bus },
    ...descriptor.speech.entries.map((entry) => ({ path: `dist/native/speech/${entry.backend}/openwhisper_speech.node`, bytes: entry.bytes, sha256: entry.sha256 }))];
  for (const entry of captured) { const actual = before[`resources/app/${entry.path}`];
    if (!actual || actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error("CAPTURED_PACKAGE_INPUT_CHANGED"); }
  for (const required of ["LICENSE", "LICENSES.chromium.html", "notices/OpenWhisper-LICENSE", "resources/app/dist/ui/app-icon.png"]) {
    if (before[required]?.type !== "file") throw new Error("MISSING_PACKAGE_NOTICE_OR_ICON");
  }
  await mkdir(output, { mode: 0o700 });
  const appDir = join(output, "AppDir"), payload = join(appDir, "usr/lib", executable);
  await mkdir(dirname(payload), { recursive: true }); await cp(directory, payload, { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await inventory(payload), before);
  await writeFile(join(appDir, "AppRun"), appRun(executable), { mode: 0o755 });
  await writeFile(join(appDir, `${identity.appId}.desktop`), ["[Desktop Entry]", "Type=Application", `Name=${identity.productName}`,
    `Exec=${executable}`, `Icon=${identity.appId}`, `StartupWMClass=${identity.appId}`, "Terminal=false", "Categories=AudioVideo;Audio;", ""].join("\n"));
  await cp(join(dist, "ui/app-icon.png"), join(appDir, `${identity.appId}.png`));
  await writeFile(join(payload, "notices/AppImage-runtime-LICENSE"), license);
  await writeFile(join(payload, "notices/AppImage-runtime-provenance.json"), `${JSON.stringify(pins.runtime, null, 2)}\n`);
  const componentNotices = join(payload, "notices/AppImage-runtime-components"); await mkdir(componentNotices);
  await writeFile(join(componentNotices, "manifest.json"), noticesManifestBytes);
  for (const notice of runtimeNotices.entries) await cp(join(noticesRoot, notice.path), join(componentNotices, notice.path), { errorOnExist: true, force: false });
  const launcher = join(output, `${executable}-launch`); await writeFile(launcher, appImageLauncher(), { mode: 0o755 });
  const toolExtraction = join(output, "tool"); await mkdir(toolExtraction);
  command(join(tools, "appimagetool-x86_64.AppImage"), ["--appimage-extract"], toolExtraction, join(output, "tool-extraction-command.json"));
  const image = join(output, `OpenWhisper${identity.kind === "stable" ? "" : "-Dev"}-Linux-x86_64_${version}~dev.${producer.commit.slice(0, 12)}${producer.modified ? ".modified" : ""}.AppImage`);
  const environment: NodeJS.ProcessEnv = { ...process.env, ARCH: "x86_64" };
  delete environment["APPIMAGE"]; delete environment["APPDIR"]; delete environment["TARGET_APPIMAGE"]; delete environment["APPIMAGE_EXTRACT_AND_RUN"];
  command(join(toolExtraction, "squashfs-root/AppRun"), ["--no-appstream", "--runtime-file", join(tools, "runtime-x86_64"), "--comp", "zstd", appDir, image], output,
    join(output, "construction-command.json"), environment);
  await chmod(image, 0o755);
  const imageBytes = await readFile(image), originalRuntime = await readFile(join(tools, "runtime-x86_64"));
  const normalized = Buffer.from(imageBytes.subarray(0, pins.runtime.bytes));
  originalRuntime.copy(normalized, pins.runtime.digestMd5Offset, pins.runtime.digestMd5Offset, pins.runtime.digestMd5Offset + 16);
  if (hash(normalized) !== pins.runtime.sha256 || imageBytes.subarray(pins.runtime.bytes, pins.runtime.bytes + 4).toString() !== "hsqs") throw new Error("APPIMAGE_RUNTIME_CHANGED");
  const extracted = join(output, "extracted");
  command("unsquashfs", ["-no-progress", "-o", String(pins.runtime.bytes), "-d", extracted, image], output, join(output, "passive-extraction-command.json"));
  assert.deepEqual(await inventory(extracted, "", `${identity.appId}.png`), await inventory(appDir, "", `${identity.appId}.png`));
  const extractedPayload = await inventory(join(extracted, "usr/lib", executable));
  for (const [path, expected] of Object.entries(before)) assert.deepEqual(extractedPayload[path], expected);
  assert.deepEqual(await inventory(directory), before);
  const receipt = join(output, "receipt.json");
  await writeFile(receipt, `${JSON.stringify({ classification: "UNSIGNED_CONSTRUCTION_ONLY", applicationProducer: producer, buildIdentity: identity, version,
    sourceDirectory: directory, sourceInventory: before, image: { path: image, bytes: imageBytes.length, sha256: hash(imageBytes) },
    launcher: { path: launcher, sha256: hash(Buffer.from(appImageLauncher())) }, tools: pins, runtimeDigestMd5Only: true,
    passiveExtractionMatches: true, originalInputUnchanged: true, runtimeAcceptance: false, updateAuthority: false,
    runtimeComponentNotices: runtimeNotices, publicDistributionAuthorized: false }, null, 2)}\n`, { mode: 0o600 });
  return { image, launcher, receipt };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--directory" || args[2] !== "--output" || args[4] !== "--tools" || !args[1] || !args[3] || !args[5]) {
    throw new Error("Usage: tsx scripts/package-linux-appimage.ts --directory /existing/preview --output /fresh/output --tools /verified/tools");
  }
  console.log(JSON.stringify(await packageLinuxAppImage({ directory: args[1], output: args[3], tools: args[5] })));
}

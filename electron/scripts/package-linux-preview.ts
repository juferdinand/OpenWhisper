import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { parseApplicationBuildModule, type BuildIdentity } from "../src/contracts/build-identity.js";
import { installedElectronExecutable } from "./runtime.js";
import { linuxSupervisorLauncher } from "../src/cli/linux-supervisor-bootstrap.js";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageSchema = z.object({ name: z.string(), version: z.string(), main: z.literal("dist/main/index.js"),
  type: z.literal("module"), dependencies: z.record(z.string(), z.string()) });
const dependencySchema = z.object({ name: z.string(), version: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(), optionalDependencies: z.record(z.string(), z.string()).optional() });
const lockSchema = z.object({ lockfileVersion: z.literal(3), packages: z.record(z.string(), z.object({ version: z.string().optional() })) });
const buildSchema = z.strictObject({ commit: z.union([z.string().regex(/^[a-f0-9]{40}$/u), z.literal("source")]), modified: z.boolean() });

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }

/** Preview inputs are copied verbatim; symlinks and special files are not package inputs. */
async function checkTree(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isFile()) return info.size;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Preview inputs must be regular files and directories without symlinks.");
  let bytes = 0;
  for (const entry of await readdir(path)) bytes += await checkTree(join(path, entry));
  return bytes;
}

async function dependencies(root: string, initial: Readonly<Record<string, string>>): Promise<string[]> {
  const lock = lockSchema.parse(await json(join(root, "package-lock.json")));
  const selected = new Set<string>();
  const visit = async (name: string, optional: boolean): Promise<void> => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(name)) throw new Error("Invalid dependency package name.");
    const path = join(root, "node_modules", name);
    if (optional && !await exists(path)) return;
    if (selected.has(name)) return;
    const metadata = dependencySchema.parse(await json(join(path, "package.json")));
    if (metadata.name !== name || metadata.version !== lock.packages[`node_modules/${name}`]?.version) {
      throw new Error(`Installed dependency does not match the lockfile: ${name}.`);
    }
    await checkTree(path);
    selected.add(name);
    for (const child of Object.keys(metadata.dependencies ?? {})) await visit(child, false);
    for (const child of Object.keys(metadata.optionalDependencies ?? {})) await visit(child, true);
  };
  for (const name of Object.keys(initial)) await visit(name, false);
  return [...selected].sort();
}

async function recordingDescriptor(root: string, identity: BuildIdentity): Promise<boolean> {
  const raw = await readFile(join(root, "dist/main/development-recording-build.js"), "utf8");
  // This build-generated module contains only a JSON literal and its fixed export.
  // Read its captured data without executing a worker or native module.
  const literal = /(?:export\s+)?const DEVELOPMENT_RECORDING_BUILD(?:\s*:\s*unknown)?\s*=\s*(null|\{[^]*?\});/u.exec(raw)?.[1];
  if (!literal) throw new Error("Missing captured recording build descriptor.");
  if (literal === "null") {
    if (identity.kind === "stable") throw new Error("Stable validation packaging requires its captured recording build.");
    return false;
  }
  const descriptor = developmentRecordingDescriptorSchema.parse(JSON.parse(literal));
  if (descriptor.platform !== "linux" || descriptor.architecture !== "x64") throw new Error("Preview requires the Linux x64 recording descriptor.");
  if (identity.kind === "stable" && !descriptor.platformServices) throw new Error("Stable validation packaging requires captured Linux platform services.");
  const expected = [
    ...descriptor.speechEntryGraph.entries,
    { path: "dist/native/capture/openwhisper_capture.node", ...descriptor.capture },
    { path: "dist/workers/capture-entry.js", ...descriptor.captureEntry },
    ...descriptor.speech.entries.map((entry) => ({ path: `dist/native/speech/${entry.backend}/openwhisper_speech.node`, ...entry })),
    ...(descriptor.platformServices ? [
      { path: "dist/workers/platform-entry.js", ...descriptor.platformServices.entry },
      { path: "dist/native/openwhisper_linux_bus.node", ...descriptor.platformServices.bus },
    ] : []),
  ];
  for (const entry of expected) {
    const bytes = await readFile(join(root, entry.path));
    if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`Existing build input differs from its captured descriptor: ${entry.path}.`);
    }
  }
  return true;
}

function runDpkg(args: readonly string[]): string {
  const result = spawnSync("dpkg-deb", args, { encoding: "utf8", shell: false, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("Preview packaging requires dpkg-deb and a successful package check.");
  return result.stdout;
}

async function nativeLibcFloor(root: string, recording: boolean): Promise<string> {
  let floor: [number, number] = [2, 35];
  if (!recording) return floor.join(".");
  const inspect = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith(".node")) {
        const result = spawnSync("readelf", ["--version-info", file], { encoding: "utf8", shell: false, timeout: 10_000 });
        if (result.error || result.status !== 0) throw new Error("Native preview packaging requires readelf ABI inspection.");
        for (const version of result.stdout.matchAll(/Name: GLIBC_(\d+)\.(\d+)(?:\.[0-9]+)?\b/gu)) {
          const major = Number(version[1]), minor = Number(version[2]);
          if (major > floor[0] || (major === floor[0] && minor > floor[1])) floor = [major, minor];
        }
      }
    }
  };
  await inspect(join(root, "dist/native"));
  return floor.join(".");
}

export interface LinuxPreviewOptions { readonly output: string; readonly root?: string; readonly directoryOnly?: boolean }
export interface LinuxPreviewResult { readonly directory: string; readonly debianRoot: string; readonly version: string; readonly debianPackage: string | null }

/** Package an existing build only. No downloads, builds, signing, installation, or app launch. */
export async function packageLinuxPreview(options: LinuxPreviewOptions): Promise<LinuxPreviewResult> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The preview packager supports Linux x64 only.");
  if (!isAbsolute(options.output) || options.output.includes("\0")) throw new Error("An explicit absolute output directory is required.");
  const root = resolve(options.root ?? defaultRoot), output = resolve(options.output);
  const inside = (parent: string, child: string): boolean => {
    const path = relative(parent, child); return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
  };
  if (inside(root, output) || inside(output, root) || await exists(output)) throw new Error("The output must be a fresh directory outside the application source.");
  if (await realpath(root) !== root || await realpath(dirname(output)) !== dirname(output)) throw new Error("Source and output parent must have real paths without symlinks.");
  const metadata = packageSchema.parse(await json(join(root, "package.json")));
  const identity = parseApplicationBuildModule(await readFile(join(root, "dist/main/application-build.js"), "utf8"));
  const stable = identity.kind === "stable", appId = identity.appId;
  const packageName = stable ? "io-github-whisperfree" : "io-github-whisperfree-dev";
  const executableName = stable ? "openwhisper" : "openwhisper-dev";
  const directoryName = stable ? "OpenWhisper-Linux-x64" : "OpenWhisper-Dev-Linux-x64";
  const build = buildSchema.parse(await json(join(root, "dist/resources/development-build.json")));
  const sourceVersion = (await readFile(join(root, "dist/resources/VERSION"), "utf8")).trim();
  if (!/^\d+\.\d+\.\d+$/u.test(sourceVersion) || sourceVersion !== metadata.version) throw new Error("Existing build and package versions differ.");
  const version = `${sourceVersion}~dev.${build.commit.slice(0, 12)}${build.modified ? ".modified" : ""}`;
  const runtime = dirname(await installedElectronExecutable(root));
  const selected = await dependencies(root, metadata.dependencies);
  await checkTree(join(root, "dist"));
  await checkTree(runtime);
  await checkTree(join(runtime, "LICENSE"));
  await checkTree(join(runtime, "LICENSES.chromium.html"));
  const recording = await recordingDescriptor(root, identity);
  if (stable && (!await exists(join(root, "dist/cli/linux-supervisor-bootstrap.js")) ||
      !(await lstat(join(root, "dist/cli/linux-supervisor-bootstrap.js"))).isFile())) throw new Error("Stable packaging requires its compiled Linux supervisor entry.");
  const libcFloor = await nativeLibcFloor(root, recording);
  const noticeInputs = [[resolve(root, "../LICENSE"), "OpenWhisper-LICENSE"],
    [join(root, "dist/ui/fonts/LICENSE.txt"), "Inter-LICENSE.txt"],
    [join(root, "node_modules/@noble/hashes/LICENSE"), "noble-hashes-LICENSE"],
    [resolve(root, "../shared/ui/node_modules/@tauri-apps/api/LICENSE-MIT"), "tauri-api-LICENSE-MIT"],
    [resolve(root, "../shared/ui/node_modules/@tauri-apps/api/LICENSE-APACHE-2.0"), "tauri-api-LICENSE-APACHE-2.0"],
    [resolve(root, "../shared/ui/node_modules/@tauri-apps/api/LICENSE.spdx"), "tauri-api-LICENSE.spdx"],
    ...(recording ? [[join(root, "vendor/whisper.cpp/LICENSE"), "whisper.cpp-LICENSE"],
      [join(root, "native/build-cpu/build-manifest.json"), "speech-cpu-build.json"]] : [])];
  for (const [source] of noticeInputs) {
    if (!source) throw new Error("Missing preview notice input.");
    await checkTree(source);
  }
  if (!options.directoryOnly) runDpkg(["--version"]);
  await mkdir(output, { mode: 0o700 });
  const directory = join(output, directoryName), application = join(directory, "resources/app");
  await cp(runtime, directory, { recursive: true, errorOnExist: true, force: false });
  await rename(join(directory, "electron"), join(directory, executableName));
  await mkdir(application, { recursive: true });
  await cp(join(root, "dist"), join(application, "dist"), { recursive: true });
  // The speech-entry descriptor hashes this file. Changing its version/name breaks native startup.
  await cp(join(root, "package.json"), join(application, "package.json"));
  await cp(join(root, "package-lock.json"), join(application, "package-lock.json"));
  for (const name of selected) {
    const destination = join(application, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, "node_modules", name), destination, { recursive: true });
  }
  if (stable) {
    await writeFile(join(directory, "openwhisper-launch"), linuxSupervisorLauncher("debian"), { flag: "wx", mode: 0o755 });
    await chmod(join(directory, "openwhisper-launch"), 0o755);
  }
  const notices = join(directory, "notices");
  await mkdir(notices);
  for (const [source, name] of noticeInputs) {
    if (!source || !name) throw new Error("Missing preview notice input.");
    await cp(source, join(notices, name));
  }
  await writeFile(join(notices, "README.txt"), [
    `${identity.productName} Linux ${stable ? "stable-profile validation package" : "preview"}. Unsigned; no stable update channel.`,
    "Source provenance remains in resources/app/dist/resources/development-build.json.",
    "Electron LICENSE and LICENSES.chromium.html remain beside the executable.",
    "Production dependency licenses remain inside resources/app/node_modules.",
    "Capture notices remain in resources/app/dist/native/capture-notices when included.",
    "Models are not included. System libraries and desktop acceptance require separate validation.", "",
  ].join("\n"));
  const debianRoot = join(output, "debian-root"), payload = join(debianRoot, "opt", executableName);
  await mkdir(dirname(payload), { recursive: true });
  await cp(directory, payload, { recursive: true });
  if (stable) {
    const legacyEntry = join(debianRoot, "usr/bin/openwhisper-desktop");
    await mkdir(dirname(legacyEntry), { recursive: true, mode: 0o755 });
    // The native updater captured this permanent path before replacing its package.
    await writeFile(legacyEntry, '#!/bin/sh\nexec /opt/openwhisper/openwhisper-launch "$@"\n', { flag: "wx", mode: 0o755 });
    await chmod(legacyEntry, 0o755);
  }
  const desktopDirectory = join(debianRoot, "usr/share/applications");
  const iconDirectory = join(debianRoot, "usr/share/icons/hicolor/256x256/apps");
  const docDirectory = join(debianRoot, "usr/share/doc", packageName);
  await mkdir(desktopDirectory, { recursive: true });
  await mkdir(iconDirectory, { recursive: true });
  await mkdir(docDirectory, { recursive: true });
  await writeFile(join(desktopDirectory, `${appId}.desktop`), [
    "[Desktop Entry]", "Type=Application", `Name=${identity.productName}`, `Comment=${stable ? "Local dictation validation package" : "Isolated local development preview"}`,
    `Exec=/opt/${executableName}/${stable ? "openwhisper-launch" : `${executableName} --dev`}`, `Icon=${appId}`, "Terminal=false",
    "Categories=AudioVideo;Audio;", `StartupWMClass=${stable ? appId : executableName}`, "",
  ].join("\n"));
  await cp(join(root, "dist/ui/app-icon.png"), join(iconDirectory, `${appId}.png`));
  await cp(join(notices, "OpenWhisper-LICENSE"), join(docDirectory, "copyright"));
  await mkdir(join(debianRoot, "DEBIAN"));
  await chmod(join(debianRoot, "DEBIAN"), 0o755);
  const installedSize = Math.ceil(await checkTree(join(debianRoot, "opt")) / 1024);
  await writeFile(join(debianRoot, "DEBIAN/control"), [
    `Package: ${packageName}`, `Version: ${version}`, "Architecture: amd64", "Section: utils", "Priority: optional",
    "Maintainer: OpenWhisper Contributors <noreply@openwhisper.invalid>", `Installed-Size: ${installedSize}`,
    `Depends: libc6 (>= ${libcFloor}), libstdc++6, libgcc-s1, libgtk-3-0, libnss3, libnspr4, libasound2, libgbm1, libdrm2, libx11-6, libx11-xcb1, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libxkbcommon0, libdbus-1-3, libatomic1, libpulse0, libsystemd0`,
    `Description: ${identity.productName} ${stable ? "stable-profile validation package" : "isolated Electron preview"}`,
    stable ? " Unsigned validation package; no public release or stable update channel." : " Unsigned development package with a separate Dev identity and data profile.", "",
  ].join("\n"));
  const debianPackage = options.directoryOnly ? null : join(output, `OpenWhisper${stable ? "" : "-Dev"}-Linux-amd64_${version}.deb`);
  if (debianPackage) {
    runDpkg(["--root-owner-group", "-Zgzip", "-z1", "--build", debianRoot, debianPackage]);
    if (runDpkg(["--field", debianPackage, "Package", "Version", "Architecture"]).trim() !==
      `Package: ${packageName}\nVersion: ${version}\nArchitecture: amd64`) throw new Error("Unexpected preview Debian metadata.");
    const contents = runDpkg(["--contents", debianPackage]);
    if (!contents.includes(`./usr/share/applications/${appId}.desktop`) || !contents.includes(`./opt/${executableName}/resources/app/dist/main/index.js`) ||
        (stable && (!contents.includes("./usr/bin/openwhisper-desktop") || !contents.includes("./opt/openwhisper/openwhisper-launch")))) {
      throw new Error("Preview Debian package is missing its launcher or application.");
    }
  }
  return { directory, debianRoot, version, debianPackage };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== "--output" || !args[1] || (args.length !== 2 && !(args.length === 3 && args[2] === "--directory-only"))) {
    throw new Error("Usage: tsx scripts/package-linux-preview.ts --output /absolute/fresh/output [--directory-only]");
  }
  const result = await packageLinuxPreview({ output: args[1], directoryOnly: args[2] === "--directory-only" });
  console.log(JSON.stringify(result));
}

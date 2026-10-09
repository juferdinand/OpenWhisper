import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import { developmentRecordingDescriptorSchema } from "../../main/development-recording-descriptor.js";
import { resolveDevelopmentProfile } from "../settings/profiles.js";

const run = promisify(execFile);
const appId = "io.github.whisperfree.dev";
const metadataSchema = z.object({ name: z.literal("openwhisper-electron"), version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  main: z.literal("dist/main/index.js"), type: z.literal("module"), dependencies: z.record(z.string(), z.string()),
  devDependencies: z.object({ electron: z.literal("44.7.0") }) });
const sourceSchema = z.strictObject({ commit: z.union([z.string().regex(/^[a-f0-9]{40}$/u), z.literal("source")]), modified: z.boolean() });
const stableNames = new Set(["whisperfree", "openwhisper", "io.github.whisperfree", "io-github-whisperfree", "openwhisper.app", "whisperfree.app", "autostart"]);
const inside = (parent: string, child: string): boolean => {
  const value = relative(parent.toLowerCase(), child.toLowerCase()); return !value || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
};
const overlap = (left: string, right: string): boolean => inside(left, right) || inside(right, left);
function absolute(input: string): string {
  if (!isAbsolute(input) || /[\u0000-\u001f\u007f]/u.test(input) || input.split(sep).some((part) => part === "." || part === "..")) {
    throw new Error("Explicit absolute paths without traversal or control characters are required.");
  }
  return resolve(input);
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  throw new Error(`A fresh path is required: ${path}`);
}
async function safeParent(path: string, home: string): Promise<void> {
  if (!inside(home, path) || path === home || relative(home, path).split(sep).some((part) => stableNames.has(part.toLowerCase()))) {
    throw new Error("Installation paths must stay within the user home and outside stable storage or autostart.");
  }
  for (let cursor = dirname(path);; cursor = dirname(cursor)) {
    const value = await lstat(cursor), sticky = value.uid === 0 && (value.mode & 0o1000) !== 0;
    if (!value.isDirectory() || value.isSymbolicLink() || (value.uid !== process.getuid?.() && value.uid !== 0) ||
      ((value.mode & 0o022) !== 0 && !sticky)) throw new Error("Installation ancestors require safe ownership, permissions and no symlinks.");
    if (cursor === home && value.uid !== process.getuid?.()) throw new Error("The home must belong to this user.");
    if (dirname(cursor) === cursor) break;
  }
}
interface TreeEntry { path: string; kind: "directory" | "file" | "link"; mode: number; bytes?: number; sha256?: string; target?: string }
async function digest(path: string): Promise<{ bytes: number; sha256: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), hash = createHash("sha256");
  let bytes = 0;
  try { for await (const block of file.createReadStream({ autoClose: false })) { bytes += block.length; hash.update(block); } }
  finally { await file.close(); }
  return { bytes, sha256: hash.digest("hex") };
}
async function tree(root: string, mac: boolean): Promise<TreeEntry[]> {
  const result: TreeEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    const value = await lstat(path), name = relative(root, path), mode = value.mode & 0o7777;
    if (value.isSymbolicLink()) {
      const target = await readlink(path);
      if (!mac || !name.startsWith(`Contents${sep}Frameworks${sep}`) || isAbsolute(target) || !inside(root, await realpath(path))) {
        throw new Error("Only internal relative Mac framework links are permitted.");
      }
      result.push({ path: name, kind: "link", mode, target });
    } else if (value.isDirectory()) {
      if ((mode & 0o022) !== 0) throw new Error("Package directories must not be writable by other users.");
      result.push({ path: name, kind: "directory", mode });
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    } else if (value.isFile() && (mode & 0o022) === 0) result.push({ path: name, kind: "file", mode, ...await digest(path) });
    else throw new Error("Package payloads require regular private files and directories.");
  };
  await visit(root); return result;
}
/** Never recursively delete a payload: unknown or changed entries must survive rollback. */
async function removeKnownPayload(root: string, initial: readonly TreeEntry[]): Promise<void> {
  const expected = new Map(initial.map((entry) => [entry.path, entry])), errors: unknown[] = [];
  const visit = async (name: string): Promise<void> => {
    try {
      const entry = expected.get(name), path = join(root, name), value = await lstat(path);
      if (!entry || (value.mode & 0o7777) !== entry.mode) throw new Error(`Unexpected or changed payload entry retained: ${name}`);
      if (entry.kind === "directory" && value.isDirectory() && !value.isSymbolicLink()) {
        for (const child of await readdir(path)) await visit(join(name, child));
        const current = await lstat(path);
        if (current.dev !== value.dev || current.ino !== value.ino || !current.isDirectory() || current.isSymbolicLink()) throw new Error(`Payload directory changed: ${name}`);
        await rmdir(path); // Unknown/new children cause ENOTEMPTY; they are never deleted.
      } else {
        const matches = entry.kind === "file" && value.isFile() && !value.isSymbolicLink()
          ? isDeepStrictEqual(await digest(path), { bytes: entry.bytes, sha256: entry.sha256 })
          : entry.kind === "link" && value.isSymbolicLink() && await readlink(path) === entry.target;
        const current = await lstat(path);
        if (!matches || current.dev !== value.dev || current.ino !== value.ino || current.size !== value.size ||
            current.mtimeMs !== value.mtimeMs || current.ctimeMs !== value.ctimeMs) throw new Error(`Changed payload entry retained: ${name}`);
        await unlink(path);
      }
    } catch (error: unknown) { errors.push(error); }
  };
  await visit("");
  if (errors.length) throw new AggregateError(errors, "Payload cleanup retained unknown or changed entries.");
}
async function architecture(path: string, mac: boolean): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), header = Buffer.alloc(32);
  let count: number;
  try { count = (await file.read(header, 0, header.length, 0)).bytesRead; } finally { await file.close(); }
  const valid = count === 32 && (mac ? header.readUInt32LE(0) === 0xfeedfacf &&
    header.readUInt32LE(4) === (process.arch === "arm64" ? 0x100000c : 0x1000007) :
    header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62);
  if (!valid) throw new Error(`Package architecture differs from the host: ${path}`);
}
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));
async function inspect(root: string, entries: readonly TreeEntry[], mac: boolean) {
  const application = join(root, mac ? "Contents/Resources/app" : "resources/app");
  const executable = join(root, mac ? "Contents/MacOS/OpenWhisper Dev" : "openwhisper-dev");
  const metadata = metadataSchema.parse(await json(join(application, "package.json")));
  const source = sourceSchema.parse(await json(join(application, "dist/resources/development-build.json")));
  if ((await readFile(join(application, "dist/resources/VERSION"), "utf8")).trim() !== metadata.version ||
      metadata.dependencies["zod"] !== "4.6.5" || metadata.dependencies["koffi"] !== "3.3.2") throw new Error("Package version/dependency metadata differs.");
  const lock = z.object({ lockfileVersion: z.literal(3), packages: z.record(z.string(), z.object({ version: z.string().optional() })) }).parse(await json(join(application, "package-lock.json")));
  const checked = new Set<string>();
  const dependency = async (name: string, optional = false): Promise<void> => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(name)) throw new Error("Invalid packaged dependency name.");
    if (name.startsWith("@koromix/koffi-") && name !== `@koromix/koffi-${process.platform}-${process.arch}`) return;
    if (checked.has(name)) return;
    const path = join(application, "node_modules", name, "package.json");
    if (optional) { try { await lstat(path); } catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; } }
    const value = z.object({ name: z.string(), version: z.string(), dependencies: z.record(z.string(), z.string()).optional(),
      optionalDependencies: z.record(z.string(), z.string()).optional() }).parse(await json(path));
    if (value.name !== name || value.version !== lock.packages[`node_modules/${name}`]?.version ||
      (metadata.dependencies[name] !== undefined && value.version !== metadata.dependencies[name])) throw new Error("Packaged dependency differs from lock metadata.");
    checked.add(name);
    for (const child of Object.keys(value.dependencies ?? {})) await dependency(child);
    for (const child of Object.keys(value.optionalDependencies ?? {})) await dependency(child, true);
  };
  for (const name of Object.keys(metadata.dependencies)) await dependency(name);
  if (!checked.has(`@koromix/koffi-${process.platform}-${process.arch}`)) throw new Error("Matching packaged Koffi runtime is required.");
  const raw = await readFile(join(application, "dist/main/development-recording-build.js"), "utf8");
  const literal = /(?:export\s+)?const DEVELOPMENT_RECORDING_BUILD(?:\s*:\s*unknown)?\s*=\s*(\{[^]*?\});/u.exec(raw)?.[1];
  if (!literal) throw new Error("A captured production recording descriptor is required.");
  const descriptor = developmentRecordingDescriptorSchema.parse(JSON.parse(literal));
  if (descriptor.platform !== process.platform || descriptor.architecture !== process.arch) throw new Error("Captured platform/architecture differs from the host.");
  const expected = [...descriptor.speechEntryGraph.entries,
    { path: `dist/native/capture/${mac ? "openwhisper_macos_capture" : "openwhisper_capture"}.node`, ...descriptor.capture },
    { path: `dist/workers/${mac ? "macos-capture-entry" : "capture-entry"}.js`, ...descriptor.captureEntry },
    ...descriptor.speech.entries.map((entry) => ({ path: `dist/native/speech/${entry.backend}/openwhisper_speech.node`, ...entry })),
    ...(descriptor.platform === "darwin" ? [{ path: "dist/native/openwhisper_macos_capture.node", ...descriptor.capture },
      { path: "dist/native/openwhisper_macos_retirement.node", ...descriptor.retirement }] : descriptor.platformServices ? [
      { path: "dist/workers/platform-entry.js", ...descriptor.platformServices.entry }, { path: "dist/native/openwhisper_linux_bus.node", ...descriptor.platformServices.bus }] : [])];
  for (const entry of expected) if (!isDeepStrictEqual(await digest(join(application, entry.path)), { bytes: entry.bytes, sha256: entry.sha256 })) {
    throw new Error(`Captured package input changed: ${entry.path}`);
  }
  if (((await lstat(executable)).mode & 0o111) === 0) throw new Error("Packaged executable is not executable.");
  await architecture(executable, mac);
  for (const entry of entries.filter((value) => value.kind === "file" && value.path.endsWith(".node"))) await architecture(join(root, entry.path), mac);
  await lstat(join(application, "dist/main/index.js"));
  await lstat(join(application, "dist/ui/app-icon.png"));
  if (mac) {
    const plist = join(root, "Contents/Info.plist");
    for (const entry of entries.filter((value) => value.kind === "file" && value.path.startsWith(`Contents${sep}Frameworks${sep}`) &&
      ((value.mode & 0o111) !== 0 || value.path.endsWith(".dylib")))) await architecture(join(root, entry.path), true);
    for (const [key, expectedValue] of Object.entries({ CFBundleIdentifier: appId, CFBundleExecutable: "OpenWhisper Dev", CFBundleName: "OpenWhisper Dev",
      CFBundleDisplayName: "OpenWhisper Dev", CFBundleVersion: metadata.version, CFBundleShortVersionString: metadata.version, LSMinimumSystemVersion: "14.0" })) {
      if ((await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { timeout: 30_000 })).stdout.trim() !== expectedValue) throw new Error(`Mac Dev identity differs: ${key}`);
    }
    const notice = z.object({ version: z.literal(1), architecture: z.enum(["x64", "arm64"]), sourceVersion: z.string(),
      source: sourceSchema, runtimeVersion: z.literal("44.7.0"), signedRecording: developmentRecordingDescriptorSchema }).parse(await json(join(root, "Contents/Resources/notices/mac-dev-package.json")));
    if (notice.architecture !== process.arch || notice.sourceVersion !== metadata.version || !isDeepStrictEqual(notice.source, source) ||
        !isDeepStrictEqual(notice.signedRecording, descriptor)) throw new Error("Mac signed package metadata differs.");
    await lstat(join(root, "Contents/Resources/AppIcon.icns"));
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", root], { timeout: 60_000 });
  } else {
    if ((await readFile(join(root, "version"), "utf8")).trim().replace(/^v/u, "") !== "44.7.0") throw new Error("Packaged Electron runtime differs.");
    await lstat(join(root, "LICENSE")); await lstat(join(root, "LICENSES.chromium.html"));
    if (!(await readFile(join(root, "notices/README.txt"), "utf8")).startsWith("OpenWhisper Dev Linux preview.")) throw new Error("Linux Dev identity notice is required.");
  }
  return { version: metadata.version, source };
}
/** Two escaping layers: desktop string escapes, then Exec's quoted argument syntax. */
export function developmentDesktopArgument(value: string): string {
  return `"${value.replaceAll("%", "%%").replace(/["`$\\]/gu, (item) => `\\${item}`).replaceAll("\\", "\\\\")}"`;
}
export interface DevelopmentInstallOptions { readonly source: string; readonly installationRoot: string; readonly profile: string;
  readonly home: string; readonly desktopFile?: string }
export async function installDevelopmentPackage(options: DevelopmentInstallOptions) {
  const mac = process.platform === "darwin";
  if ((process.platform !== "linux" && !mac) || (mac ? !["x64", "arm64"].includes(process.arch) : process.arch !== "x64") || process.getuid?.() === 0) {
    throw new Error("Dev installation requires a supported non-root Linux/Mac host.");
  }
  const source = absolute(options.source), root = absolute(options.installationRoot), profile = absolute(options.profile), home = absolute(options.home);
  if (!mac && join(root, "OpenWhisper-Dev-Linux-x64/openwhisper-dev").includes("=")) throw new Error("Linux desktop executable paths must not contain '='.");
  const desktop = options.desktopFile === undefined ? undefined : absolute(options.desktopFile);
  if (mac ? desktop !== undefined : desktop === undefined || basename(desktop) !== `${appId}.desktop`) throw new Error("Linux requires an explicit fresh io.github.whisperfree.dev.desktop; Mac has no desktop file.");
  const paths = [source, root, profile, ...(desktop ? [desktop] : [])];
  for (const [index, left] of paths.entries()) for (const right of paths.slice(index + 1)) if (overlap(left, right)) throw new Error("Source, installation, profile and launcher paths must not overlap.");
  if (await realpath(source) !== source || !(await lstat(source)).isDirectory()) throw new Error("Source must be a real standalone package directory.");
  if (mac && basename(source) !== "OpenWhisper Dev.app") throw new Error("The Mac source must be OpenWhisper Dev.app.");
  resolveDevelopmentProfile({ home, explicitRoot: profile }); // Validate only; never prepare or create data.
  for (const path of [root, profile, ...(desktop ? [desktop] : [])]) { await safeParent(path, home); await absent(path); }
  const initial = await tree(source, mac), metadata = await inspect(source, initial, mac);
  await mkdir(root, { mode: 0o700 }); // Exclusive reservation; never rename over an existing installation root.
  const owned = await lstat(root), staging = join(root, mac ? ".stage.app" : "stage"), application = join(root, mac ? "OpenWhisper Dev.app" : "OpenWhisper-Dev-Linux-x64");
  let launcherIdentity: { dev: number; ino: number } | undefined, payloadIdentity: { dev: number; ino: number } | undefined;
  try {
    await mkdir(staging, { mode: initial[0]!.mode }); payloadIdentity = await lstat(staging);
    if (mac) await run("/usr/bin/ditto", [source, staging], { timeout: 120_000 });
    else for (const name of await readdir(source)) await cp(join(source, name), join(staging, name), { recursive: true, force: false, errorOnExist: true, dereference: false });
    const copied = await tree(staging, mac);
    if (!isDeepStrictEqual(initial, copied) || !isDeepStrictEqual(initial, await tree(source, mac))) throw new Error("Source/staged package payload changed during installation.");
    await inspect(staging, copied, mac);
    await absent(profile); resolveDevelopmentProfile({ home, explicitRoot: profile }); await absent(application);
    const currentRoot = await lstat(root);
    if (currentRoot.dev !== owned.dev || currentRoot.ino !== owned.ino || currentRoot.isSymbolicLink()) throw new Error("Reserved installation root changed.");
    await rename(staging, application); // Both children belong to this freshly reserved root.
    const executable = join(application, mac ? "Contents/MacOS/OpenWhisper Dev" : "openwhisper-dev");
    if (desktop) {
      const file = await open(desktop, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      launcherIdentity = await file.stat();
      try { await file.writeFile(["[Desktop Entry]", "Type=Application", "Name=OpenWhisper Dev", "Comment=Isolated local development preview",
        `Exec=${developmentDesktopArgument(executable)} --dev-profile ${developmentDesktopArgument(profile)}`,
        `Icon=${join(application, "resources/app/dist/ui/app-icon.png").replaceAll("\\", "\\\\")}`, "Terminal=false", "Categories=AudioVideo;Audio;",
        "StartupWMClass=openwhisper-dev", ""].join("\n")); await file.sync(); } finally { await file.close(); }
    }
    return { installationRoot: root, application, executable, profile, desktopFile: desktop ?? null, ...metadata,
      sourceDigest: createHash("sha256").update(JSON.stringify(initial)).digest("hex"),
      launchArguments: ["--dev-profile", profile], scope: "Fresh local Dev copy only; no launch, profile creation, updates or replacement" };
  } catch (failure: unknown) {
    const cleanupErrors: unknown[] = [];
    if (launcherIdentity && desktop) { try {
      const current = await lstat(desktop);
      if (current.dev !== launcherIdentity.dev || current.ino !== launcherIdentity.ino || !current.isFile() || current.isSymbolicLink()) throw new Error("Launcher changed; cleanup refused.");
      await rm(desktop);
    } catch (error: unknown) { cleanupErrors.push(error); } }
    try {
      const current = await lstat(root);
      if (current.dev !== owned.dev || current.ino !== owned.ino || !current.isDirectory() || current.isSymbolicLink()) throw new Error("Installation root changed; cleanup refused.");
      const names = await readdir(root);
      if (names.length > 1 || names.some((name) => name !== basename(staging) && name !== basename(application))) throw new Error("Unexpected installation files; cleanup refused.");
      for (const name of names) {
        const path = join(root, name), child = await lstat(path);
        if (!payloadIdentity || child.dev !== payloadIdentity.dev || child.ino !== payloadIdentity.ino || !child.isDirectory() || child.isSymbolicLink()) throw new Error("Payload changed; cleanup refused.");
        await removeKnownPayload(path, initial);
      }
      await rmdir(root);
    } catch (error: unknown) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], "Dev installation failed and cleanup was incomplete.");
    throw failure;
  }
}

import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { parseApplicationBuildModule } from "../src/contracts/application/build-identity.js";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { LINUX_UPDATE_PUBLIC_KEY } from "../src/services/update/linux/linux-update-signature.js";
import { LINUX_UPDATE_FEED_URL } from "../src/services/update/common/update-policy.js";
import { packageLinuxAppImage } from "./package-linux-appimage.js";
import { packageLinuxPreview } from "./package-linux-preview.js";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const versionSchema = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
const buildSchema = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) });
const packageSchema = z.object({ version: versionSchema });
const inside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export interface LinuxReleasePackageOptions { readonly output: string; readonly tools: string; readonly root?: string }
export interface LinuxReleasePackageResult { readonly debian: string; readonly appImage: string; readonly receipt: string }
export interface LinuxReleaseUpdatePolicyDescriptor {
  readonly publicKey: string;
  readonly feedURL: string;
  readonly requireSignedVersion: true;
}

/** Validate the values exposed by the workflow's emitted modules against this package constructor. */
export function linuxReleaseUpdatePolicyDescriptor(signatureModule: Readonly<Record<string, unknown>>,
  policyModule: Readonly<Record<string, unknown>>, signatureSource: string): LinuxReleaseUpdatePolicyDescriptor {
  const publicKey = z.string().min(1).parse(signatureModule["LINUX_UPDATE_PUBLIC_KEY"]);
  const feedURL = z.string().url().parse(policyModule["LINUX_UPDATE_FEED_URL"]);
  if (publicKey !== LINUX_UPDATE_PUBLIC_KEY || feedURL !== LINUX_UPDATE_FEED_URL ||
      typeof signatureModule["verifyLinuxUpdateStream"] !== "function" || !signatureSource.includes("SIGNED_VERSION_MISMATCH")) {
    throw new Error("LINUX_RELEASE_UPDATE_POLICY_MISMATCH");
  }
  return Object.freeze({ publicKey: LINUX_UPDATE_PUBLIC_KEY, feedURL: LINUX_UPDATE_FEED_URL, requireSignedVersion: true });
}

async function inventory(path: string, prefix = ""): Promise<Record<string, { bytes: number; mode: number; sha256: string }>> {
  const result: Record<string, { bytes: number; mode: number; sha256: string }> = {};
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name, file = join(path, entry.name), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error("RELEASE_NOTICE_SYMLINK");
    if (stat.isDirectory()) Object.assign(result, await inventory(file, name));
    else {
      if (!stat.isFile()) throw new Error("RELEASE_NOTICE_SPECIAL_FILE");
      const bytes = await readFile(file);
      result[name] = { bytes: bytes.length, mode: stat.mode & 0o7777, sha256: hash(bytes) };
    }
  }
  return result;
}

/** Construct canonical Linux release payloads from the already-built clean Stable tree. Signing and publication are separate. */
export async function packageLinuxRelease(options: LinuxReleasePackageOptions): Promise<LinuxReleasePackageResult> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("UNSUPPORTED_LINUX_RELEASE_HOST");
  const root = resolve(options.root ?? defaultRoot), output = resolve(options.output), tools = resolve(options.tools);
  if (!isAbsolute(options.output) || output !== options.output || !isAbsolute(options.tools) || tools !== options.tools ||
      !await lstat(dirname(output)).then((stat) => stat.isDirectory()).catch(() => false) ||
      await realpath(root) !== root || await realpath(tools) !== tools || await realpath(dirname(output)) !== dirname(output) ||
      [root, tools].some((path) => inside(path, output) || inside(output, path))) throw new Error("UNSAFE_LINUX_RELEASE_PATH");
  try { await lstat(output); throw new Error("LINUX_RELEASE_OUTPUT_EXISTS"); }
  catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }

  const packageMetadata = packageSchema.parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown);
  const version = versionSchema.parse((await readFile(join(root, "dist/resources/VERSION"), "utf8")).trim());
  const build = buildSchema.parse(JSON.parse(await readFile(join(root, "dist/resources/development-build.json"), "utf8")) as unknown);
  const identity = parseApplicationBuildModule(await readFile(join(root, "dist/main/application-build.js"), "utf8"));
  const git = (args: string[]): string => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, timeout: 5_000 });
    if (result.error || result.status !== 0) throw new Error("LINUX_RELEASE_GIT_CHECK_FAILED");
    return result.stdout.trim();
  };
  if (identity.kind !== "stable" || identity.appId !== "io.github.whisperfree" || version !== packageMetadata.version ||
      version !== (await readFile(resolve(root, "../VERSION"), "utf8")).trim() || build.modified || build.commit !== git(["rev-parse", "HEAD"]) ||
      git(["status", "--porcelain"]) !== "") throw new Error("LINUX_RELEASE_SOURCE_MISMATCH");

  const signatureModulePath = join(root, "dist/services/update/linux/linux-update-signature.js");
  const policyModulePath = join(root, "dist/services/update/common/update-policy.js");
  const [signatureModule, policyModule, signatureModuleBytes, policyModuleBytes] = await Promise.all([
    import(pathToFileURL(signatureModulePath).href) as Promise<Readonly<Record<string, unknown>>>,
    import(pathToFileURL(policyModulePath).href) as Promise<Readonly<Record<string, unknown>>>,
    readFile(signatureModulePath), readFile(policyModulePath),
  ]);
  const updatePolicy = linuxReleaseUpdatePolicyDescriptor(signatureModule, policyModule, signatureModuleBytes.toString("utf8"));

  const recordingModule = await readFile(join(root, "dist/main/development-recording-build.js"), "utf8");
  const descriptorLiteral = /(?:export\s+)?const DEVELOPMENT_RECORDING_BUILD\s*=\s*(\{[^]*?\});/u.exec(recordingModule)?.[1];
  if (!descriptorLiteral) throw new Error("LINUX_RELEASE_NATIVE_RECEIPT_MISSING");
  const descriptor = developmentRecordingDescriptorSchema.parse(JSON.parse(descriptorLiteral) as unknown);
  if (descriptor.platform !== "linux" || descriptor.architecture !== "x64" || !descriptor.platformServices) throw new Error("LINUX_RELEASE_NATIVE_RECEIPT_MISMATCH");

  await mkdir(output, { mode: 0o700 });
  const debRoot = join(output, "debian-factory"), appImageRoot = join(output, "appimage-factory");
  const debPackage = await packageLinuxPreview({ root, output: debRoot, mode: "canonical-stable-release-construction" });
  if (!debPackage.debianPackage) throw new Error("LINUX_RELEASE_DEBIAN_MISSING");
  const appImage = await packageLinuxAppImage({ directory: debPackage.directory, output: appImageRoot, tools,
    canonicalStableReleaseConstruction: true });
  const debian = join(output, "OpenWhisper-Linux-amd64.deb"), image = join(output, "OpenWhisper-Linux-x86_64.AppImage");
  await copyFile(debPackage.debianPackage, debian, 1);
  await copyFile(appImage.image, image, 1);
  await chmod(image, 0o755);
  const debBytes = await readFile(debian), imageBytes = await readFile(image);
  const notices = {
    debian: await inventory(join(debPackage.directory, "notices")),
    appImage: await inventory(join(appImageRoot, "AppDir/usr/lib/openwhisper/notices")),
  };
  const nativeEntries = [
    ...descriptor.speechEntryGraph.entries,
    { path: "dist/native/capture/openwhisper_capture.node", ...descriptor.capture },
    { path: "dist/workers/capture-entry.js", ...descriptor.captureEntry },
    { path: "dist/workers/platform-entry.js", ...descriptor.platformServices.entry },
    { path: "dist/native/openwhisper_linux_bus.node", ...descriptor.platformServices.bus },
    ...descriptor.speech.entries.map((entry) => ({ path: `dist/native/speech/${entry.backend}/openwhisper_speech.node`, ...entry })),
  ];
  const native = Object.fromEntries(await Promise.all(nativeEntries.map(async (entry) => {
    const bytes = await readFile(join(root, entry.path));
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error("LINUX_RELEASE_NATIVE_INPUT_CHANGED");
    return [entry.path, { bytes: bytes.length, sha256: hash(bytes) }];
  })));
  const receipt = join(output, "release-construction-receipt.json");
  await writeFile(receipt, `${JSON.stringify({ classification: "CANONICAL_STABLE_LINUX_RELEASE_CONSTRUCTION_UNSIGNED",
    source: { commit: build.commit, modified: false }, version, buildIdentity: identity,
    updatePolicy: { ...updatePolicy,
      signatureModuleSha256: hash(signatureModuleBytes), policyModuleSha256: hash(policyModuleBytes) },
    native, notices, artifacts: {
      debian: { path: debian, bytes: debBytes.length, sha256: hash(debBytes), package: "io-github-whisperfree", version, architecture: "amd64" },
      appImage: { path: image, bytes: imageBytes.length, sha256: hash(imageBytes), mode: (await lstat(image)).mode & 0o7777 },
      debianFactoryResult: { directory: debPackage.directory, debianRoot: debPackage.debianRoot,
        packagePath: debPackage.debianPackage, version: debPackage.version },
      appImageFactoryReceiptSha256: hash(await readFile(appImage.receipt)),
    }, signing: "NOT_PERFORMED_EXISTING_KEY_SIGNER_REQUIRED", updateAuthority: false, publicDistributionAuthorized: false }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { debian, appImage: image, receipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--output" || args[2] !== "--tools" || args[4] !== "--root" || args.slice(1).some((value) => !value)) {
    throw new Error("Usage: tsx scripts/package-linux-release.ts --output /fresh/output --tools /verified/tools --root /absolute/app");
  }
  console.log(JSON.stringify(await packageLinuxRelease({ output: args[1]!, tools: args[3]!, root: args[5]! })));
}

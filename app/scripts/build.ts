import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildIdentitySchema, parseApplicationBuildModule, type BuildIdentity } from "../src/contracts/application/build-identity.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) throw new Error("Application build failed.");
}

export async function buildApplication(options: { readonly recording?: boolean; readonly stable?: boolean } = {}): Promise<void> {
  if (options.stable && !((process.platform === "linux" && process.arch === "x64") ||
      (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")))) {
    throw new Error("A fresh stable validation build requires Linux x64 or Darwin arm64/x64.");
  }
  const identity = buildIdentitySchema.parse(options.stable ? { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" }
    : { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" });
  const projectVersion = (await readFile(resolve(root, "../VERSION"), "utf8")).trim();
  const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(projectVersion) || typeof metadata !== "object" || metadata === null ||
      Reflect.get(metadata, "version") !== projectVersion) throw new Error("Source and project versions differ.");
  await rm(join(root, "dist"), { recursive: true, force: true });
  run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], root);
  await build({ stdin: { contents: `export const APPLICATION_BUILD: unknown = ${JSON.stringify(identity)};`, loader: "ts", resolveDir: root },
    outfile: join(root, "dist/main/application-build.js"), platform: "node", format: "esm", target: "node24", sourcemap: false });
  run("npm", ["run", "build"], resolve(root, "ui"));
  await build({
    entryPoints: [join(root, "src/preload/index.ts")],
    outfile: join(root, "dist/preload/index.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: false,
  });
  await cp(resolve(root, "ui/dist"), join(root, "dist/ui"), { recursive: true });
  await mkdir(join(root, "dist/resources"), { recursive: true });
  await cp(resolve(root, "ui/locales"), join(root, "dist/resources/locales"), { recursive: true });
  await cp(resolve(root, "data/models.json"), join(root, "dist/resources/models.json"));
  await cp(resolve(root, "../VERSION"), join(root, "dist/resources/VERSION"));
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", shell: false });
  const changes = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", shell: false });
  const commit = revision.status === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim())
    ? revision.stdout.trim() : "source";
  await writeFile(join(root, "dist/resources/development-build.json"), JSON.stringify({
    commit, modified: changes.status !== 0 || changes.stdout.length > 0,
  }));
  if (options.recording) {
    const { buildDevelopmentRecording } = await import("./build-development-recording.js");
    await buildDevelopmentRecording();
  }
}

export type MacValidationVariant = "development" | "stable";
export interface MacValidationPairOptions { readonly devOutput: string; readonly stableOutput: string;
  readonly devResult: string; readonly stableResult: string }
export interface MacValidationPairEffects<T> {
  readonly freshDevBuild: () => Promise<void>;
  readonly assertIdentity: (variant: MacValidationVariant) => Promise<void>;
  readonly writeStableIdentity: () => Promise<void>;
  readonly package: (variant: MacValidationVariant, output: string) => Promise<T>;
  readonly writeResult: (path: string, value: T) => Promise<void>;
}

export function supportsMacValidationPair(platform: string, architecture: string, isRoot: boolean): boolean {
  return platform === "darwin" && (architecture === "arm64" || architecture === "x64") && !isRoot;
}

const overlaps = (left: string, right: string): boolean => {
  const inside = (base: string, path: string): boolean => {
    const value = relative(base, path);
    return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith(sep));
  };
  return inside(left, right) || inside(right, left);
};

function macValidationPairPaths(options: MacValidationPairOptions): string[] {
  const paths = [options.devOutput, options.stableOutput, options.devResult, options.stableResult];
  const resolved = paths.map((path) => resolve(path));
  if (paths.some((path) => !isAbsolute(path)) || resolved.some((path, index) =>
      resolved.some((other, otherIndex) => index !== otherIndex && overlaps(path, other)))) {
    throw new Error("Mac Dev and Stable validation outputs must be distinct absolute paths without overlap.");
  }
  return resolved;
}

export async function validateMacValidationPairPaths(options: MacValidationPairOptions, sourceRoot = root): Promise<void> {
  const paths = macValidationPairPaths(options), canonicalSource = await realpath(sourceRoot);
  for (const path of paths) {
    if (overlaps(canonicalSource, path) || await realpath(dirname(path)) !== dirname(path)) {
      throw new Error("Mac validation outputs must have canonical parents outside the source tree.");
    }
    try { await lstat(path); throw new Error("Mac validation output already exists."); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

/** Invoke through this one fresh build so shared host and native outputs are never reused across runs. */
export async function assembleMacValidationPair<T>(options: MacValidationPairOptions, effects: MacValidationPairEffects<T>): Promise<void> {
  const resolved = macValidationPairPaths(options);
  await effects.freshDevBuild();
  await effects.assertIdentity("development");
  const dev = await effects.package("development", resolved[0]!);
  await effects.writeStableIdentity();
  await effects.assertIdentity("stable");
  const stable = await effects.package("stable", resolved[1]!);
  await effects.writeResult(resolved[2]!, dev);
  await effects.writeResult(resolved[3]!, stable);
}

/** Build the shared Mac host and native recording outputs once, then package fresh Dev and Stable identities. */
export async function buildMacValidationPair(options: { readonly devOutput: string; readonly stableOutput: string;
  readonly devResult: string; readonly stableResult: string }): Promise<void> {
  if (!supportsMacValidationPair(process.platform, process.arch, process.getuid?.() === 0)) {
    throw new Error("A Mac validation pair requires a non-root Darwin arm64/x64 builder.");
  }
  await validateMacValidationPairPaths(options);
  const before = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", shell: false });
  if (before.status !== 0 || before.stdout.length !== 0) throw new Error("A clean source tree is required for the Mac validation pair.");
  const { packageMacPreview } = await import("./package-macos-preview.js");
  const identities: Readonly<Record<MacValidationVariant, BuildIdentity>> = {
    development: { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" },
    stable: { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" },
  };
  await assembleMacValidationPair(options, {
    freshDevBuild: () => buildApplication({ recording: true }),
    assertIdentity: async (variant) => {
      const selected = parseApplicationBuildModule(await readFile(join(root, "dist/main/application-build.js"), "utf8"));
      if (JSON.stringify(selected) !== JSON.stringify(identities[variant])) throw new Error("Mac validation package identity does not match its variant.");
    },
    writeStableIdentity: () => writeApplicationIdentity(identities.stable),
    package: (_variant, output) => packageMacPreview(output, root),
    writeResult: (path, value) => writeFile(path, JSON.stringify(value), { flag: "wx" }),
  });
  const after = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", shell: false });
  if (after.status !== 0 || after.stdout.length !== 0) throw new Error("The Mac validation pair changed the committed source tree.");
}

async function writeApplicationIdentity(identity: unknown): Promise<void> {
  await build({ stdin: { contents: `export const APPLICATION_BUILD: unknown = ${JSON.stringify(buildIdentitySchema.parse(identity))};`, loader: "ts", resolveDir: root },
    outfile: join(root, "dist/main/application-build.js"), platform: "node", format: "esm", target: "node24", sourcemap: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--mac-validation-pair") {
    if (args.length !== 9 || args[1] !== "--dev-output" || args[3] !== "--stable-output" || args[5] !== "--dev-result" || args[7] !== "--stable-result") {
      throw new Error("Usage: build.ts --mac-validation-pair --dev-output PATH --stable-output PATH --dev-result PATH --stable-result PATH");
    }
    await buildMacValidationPair({ devOutput: args[2]!, stableOutput: args[4]!, devResult: args[6]!, stableResult: args[8]! });
  } else {
    if (args.some((argument) => argument !== "--recording" && argument !== "--stable") || new Set(args).size !== args.length) {
      throw new Error("Usage: build.ts [--recording] [--stable]");
    }
    await buildApplication({ recording: args.includes("--recording"), stable: args.includes("--stable") });
  }
}

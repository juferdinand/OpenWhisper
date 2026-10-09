import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const releaseSourceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const versionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const packageSchema = z.object({ version: versionSchema });
const lockSchema = z.object({
  version: versionSchema,
  packages: z.record(
    z.string(),
    z.object({ version: versionSchema.optional() }),
  ),
});

export interface VerifyReleaseSourceOptions {
  readonly root?: string;
  readonly version: string;
  readonly commit: string;
}

export interface VerifiedReleaseSource {
  readonly root: string;
  readonly version: string;
  readonly commit: string;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0)
    throw new Error("RELEASE_SOURCE_GIT_CHECK_FAILED");
  return result.stdout.trim();
}

async function regular(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("RELEASE_SOURCE_MANIFEST_INVALID");
}

/** Read-only admission check for a release build's committed source and exact project versions. */
export async function verifyReleaseSource(
  options: VerifyReleaseSourceOptions,
): Promise<VerifiedReleaseSource> {
  const root = resolve(options.root ?? releaseSourceRoot);
  if ((await realpath(root)) !== root)
    throw new Error("RELEASE_SOURCE_ROOT_UNSAFE");
  const expectedVersion = versionSchema.parse(options.version);
  const expectedCommit = commitSchema.parse(options.commit);
  const versionPath = join(root, "VERSION"),
    electronManifestPath = join(root, "app/package.json");
  const electronLockPath = join(root, "app/package-lock.json");
  const uiManifestPath = join(root, "app/ui/package.json");
  const uiLockPath = join(root, "app/ui/package-lock.json");
  await Promise.all(
    [
      versionPath,
      electronManifestPath,
      electronLockPath,
      uiManifestPath,
      uiLockPath,
    ].map(regular),
  );
  const [sourceVersion, electron, electronLock, ui, uiLock] = await Promise.all(
    [
      readFile(versionPath, "utf8"),
      readFile(electronManifestPath, "utf8"),
      readFile(electronLockPath, "utf8"),
      readFile(uiManifestPath, "utf8"),
      readFile(uiLockPath, "utf8"),
    ],
  );
  const version = versionSchema.parse(sourceVersion.trim());
  const electronLockValue = lockSchema.parse(JSON.parse(electronLock));
  const uiLockValue = lockSchema.parse(JSON.parse(uiLock));
  if (
    version !== expectedVersion ||
    packageSchema.parse(JSON.parse(electron)).version !== expectedVersion ||
    electronLockValue.version !== expectedVersion ||
    electronLockValue.packages[""]?.version !== expectedVersion ||
    packageSchema.parse(JSON.parse(ui)).version !== expectedVersion ||
    uiLockValue.version !== expectedVersion ||
    uiLockValue.packages[""]?.version !== expectedVersion
  ) {
    throw new Error("RELEASE_SOURCE_VERSION_MISMATCH");
  }
  if (
    git(root, ["rev-parse", "HEAD"]) !== expectedCommit ||
    git(root, ["status", "--porcelain", "--untracked-files=all"]) !== ""
  ) {
    throw new Error("RELEASE_SOURCE_NOT_EXACT_CLEAN_COMMIT");
  }
  return Object.freeze({ root, version, commit: expectedCommit });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (
    args.length !== 4 ||
    args[0] !== "--version" ||
    args[2] !== "--commit" ||
    args.some((argument) => !argument)
  ) {
    throw new Error(
      "Usage: tsx scripts/verify-release-source.ts --version X.Y.Z --commit <40-hex-commit>",
    );
  }
  console.log(
    JSON.stringify(
      await verifyReleaseSource({ version: args[1]!, commit: args[3]! }),
    ),
  );
}

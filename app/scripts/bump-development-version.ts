import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { synchronizeVersion } from "./set-version.js";
import { readReleaseContext } from "./release-context.js";
import { nextPatchVersion } from "../src/services/update/common/update-policy.js";

export async function bumpDevelopmentVersion(root: string, releaseVersion: string): Promise<{ readonly version: string; readonly changed: boolean }> {
  const context = await readReleaseContext(root);
  const successorVersion = nextPatchVersion(releaseVersion);
  if (context.currentVersion === successorVersion) return { version: successorVersion, changed: false };
  if (context.currentVersion !== releaseVersion) {
    throw new Error(`Cannot bump after publishing ${releaseVersion}: current VERSION is ${context.currentVersion}.`);
  }
  await synchronizeVersion(root, successorVersion);
  const updated = await readReleaseContext(root);
  if (updated.currentVersion !== successorVersion) throw new Error("Development version update did not synchronize all manifests.");
  return { version: successorVersion, changed: true };
}

/** Update only version manifests after a successfully published release. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--release-version" || args[2] !== "--github-output") {
    throw new Error("Usage: bump-development-version.ts --release-version X.Y.Z --github-output PATH");
  }
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const releaseVersion = args[1]!;
  const output = args[3]!;
  const result = await bumpDevelopmentVersion(root, releaseVersion);
  await appendFile(output, `development_version=${result.version}\n`, { mode: 0o600 });
  process.stdout.write(result.changed ? `Advanced development version to ${result.version}.\n` : `Development version ${result.version} is already set.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

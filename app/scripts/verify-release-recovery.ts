import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const publicAssets = ["OpenWhisper-macOS.dmg", "OpenWhisper-macOS.zip", "OpenWhisper-Linux-x86_64.AppImage",
  "OpenWhisper-Linux-amd64.deb", "OpenWhisper-Linux-x86_64.AppImage.sig", "OpenWhisper-Linux-amd64.deb.sig",
  "latest.json", "SHA256SUMS"] as const;
const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  assets: z.array(z.object({ name: z.string() }).passthrough()),
}).passthrough();

export function parsePublicReleaseRecord(input: unknown, expectedTag: string): void {
  const release = releaseSchema.parse(input);
  if (release.tag_name !== expectedTag) throw new Error("RELEASE_RECOVERY_TAG_MISMATCH");
  if (release.draft) throw new Error("RELEASE_RECOVERY_NOT_PUBLIC");
  const names = release.assets.map(({ name }) => name).sort();
  const expected = [...publicAssets].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("RELEASE_RECOVERY_ASSET_SET_MISMATCH");
  }
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyDirectory(directory: string): Promise<Map<string, string>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort();
  const expected = [...publicAssets].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("RELEASE_RECOVERY_ASSET_SET_MISMATCH");
  }
  const digests = new Map<string, string>();
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (!entry.isFile() || stat.isSymbolicLink() || stat.size === 0 || basename(path) !== entry.name) {
      throw new Error("RELEASE_RECOVERY_ASSET_INVALID");
    }
    digests.set(entry.name, await digest(path));
  }
  return digests;
}

export async function verifyPublicReleaseRecovery(input: unknown, expectedTag: string, stagedDirectory: string, downloadedDirectory: string): Promise<void> {
  parsePublicReleaseRecord(input, expectedTag);
  const [staged, downloaded] = await Promise.all([verifyDirectory(resolve(stagedDirectory)), verifyDirectory(resolve(downloadedDirectory))]);
  for (const name of publicAssets) {
    if (staged.get(name) !== downloaded.get(name)) throw new Error(`RELEASE_RECOVERY_ASSET_BYTES_MISMATCH:${name}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 8 || args[0] !== "--release-json" || args[2] !== "--tag" || args[4] !== "--staged-assets" || args[6] !== "--downloaded-assets") {
    throw new Error("Usage: verify-release-recovery.ts --release-json PATH --tag vX.Y.Z --staged-assets DIR --downloaded-assets DIR");
  }
  const release = JSON.parse(await readFile(resolve(args[1]!), "utf8")) as unknown;
  await verifyPublicReleaseRecovery(release, args[3]!, args[5]!, args[7]!);
  process.stdout.write("Existing public release metadata and assets exactly match the staged source assets.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

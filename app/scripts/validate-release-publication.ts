import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LINUX_UPDATE_PUBLIC_KEY, verifyLinuxUpdateStream } from "../src/services/update/linux/linux-update-signature.js";
import {
  LINUX_UPDATE_FEED_URL,
  LINUX_UPDATE_REPOSITORY,
  UPDATE_POLICY_LIMITS,
} from "../src/services/update/common/update-policy.js";
import { verifyReleaseSource } from "./verify-release-source.js";

const versionSchema = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const linuxReceiptSchema = z.object({
  classification: z.literal("CANONICAL_STABLE_LINUX_RELEASE_CONSTRUCTION_UNSIGNED"),
  source: z.object({ commit: commitSchema, modified: z.literal(false) }),
  version: versionSchema,
  updatePolicy: z.object({
    publicKey: z.string().min(1),
    feedURL: z.string().url(),
    requireSignedVersion: z.literal(true),
  }),
  artifacts: z.object({
    debian: z.object({ path: z.string(), bytes: z.number().int().positive(), sha256: digestSchema,
      package: z.literal("io-github-whisperfree"), version: versionSchema, architecture: z.literal("amd64") }),
    appImage: z.object({ path: z.string(), bytes: z.number().int().positive(), sha256: digestSchema,
      mode: z.literal(0o755) }),
  }),
  signing: z.literal("NOT_PERFORMED_EXISTING_KEY_SIGNER_REQUIRED"),
  updateAuthority: z.literal(false),
  publicDistributionAuthorized: z.literal(false),
});
const macReceiptSchema = z.object({ status: z.literal("PASS"), version: versionSchema,
  sourceCommit: commitSchema, architecture: z.literal("universal"), updateConfigured: z.literal(true) });
const feedSchema = z.object({
  version: versionSchema,
  notes: z.string(),
  pub_date: z.string().datetime({ offset: true }),
  platforms: z.object({
    "linux-x86_64-appimage": z.object({ url: z.string().url(), signature: z.string().min(1) }),
    "linux-x86_64-deb": z.object({ url: z.string().url(), signature: z.string().min(1) }),
  }),
});

const macFiles = ["OpenWhisper-macOS.dmg", "OpenWhisper-macOS.zip"] as const;
const linuxFiles = ["OpenWhisper-Linux-x86_64.AppImage", "OpenWhisper-Linux-x86_64.AppImage.sig",
  "OpenWhisper-Linux-amd64.deb", "OpenWhisper-Linux-amd64.deb.sig", "latest.json"] as const;
const releaseFiles = ["OpenWhisper-macOS.dmg", "OpenWhisper-macOS.zip", ...linuxFiles] as const;

export interface ValidateReleasePublicationOptions {
  readonly root?: string;
  readonly version: string;
  readonly commit: string;
  readonly macosDirectory: string;
  readonly linuxDirectory: string;
  readonly outputDirectory: string;
}

export function parseReleaseChecksums(text: string, expected: readonly string[]): Map<string, string> {
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  if (rows.length !== expected.length) throw new Error("RELEASE_CHECKSUM_SET_MISMATCH");
  const result = new Map<string, string>();
  for (const row of rows) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(row);
    if (!match || !expected.includes(match[2]!) || result.has(match[2]!)) throw new Error("RELEASE_CHECKSUM_ENTRY_INVALID");
    result.set(match[2]!, match[1]!);
  }
  if (expected.some((name) => !result.has(name))) throw new Error("RELEASE_CHECKSUM_SET_MISMATCH");
  return result;
}

async function requireExactFiles(directory: string, expected: readonly string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (names.length !== expected.length || expected.some((name) => !names.includes(name))) throw new Error("RELEASE_ARTIFACT_SET_MISMATCH");
  for (const entry of entries) {
    const stat = await lstat(join(directory, entry.name));
    if (!entry.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("RELEASE_ARTIFACT_INVALID_FILE");
  }
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyChecksums(directory: string, names: readonly string[]): Promise<void> {
  const checksums = parseReleaseChecksums(await readFile(join(directory, "SHA256SUMS"), "utf8"), names);
  for (const name of names) if (await digest(join(directory, name)) !== checksums.get(name)) throw new Error("RELEASE_ARTIFACT_CHECKSUM_MISMATCH");
}

/** Validate the exact builder outputs and stage only canonical public assets. */
export async function validateReleasePublication(options: ValidateReleasePublicationOptions): Promise<void> {
  const version = versionSchema.parse(options.version), commit = commitSchema.parse(options.commit);
  const root = resolve(options.root ?? defaultRoot);
  await verifyReleaseSource({ root, version, commit });
  const macosDirectory = resolve(options.macosDirectory), linuxDirectory = resolve(options.linuxDirectory), outputDirectory = resolve(options.outputDirectory);
  if (outputDirectory === root || outputDirectory.startsWith(`${root}/`)) throw new Error("RELEASE_OUTPUT_MUST_BE_OUTSIDE_SOURCE");
  if (macosDirectory === outputDirectory || linuxDirectory === outputDirectory) throw new Error("RELEASE_OUTPUT_DIRECTORY_COLLISION");
  if (await realpath(dirname(outputDirectory)) !== dirname(outputDirectory)) throw new Error("RELEASE_OUTPUT_PARENT_UNSAFE");

  await Promise.all([
    requireExactFiles(macosDirectory, [...macFiles, "OpenWhisper-macOS-release.json", "SHA256SUMS"]),
    requireExactFiles(linuxDirectory, [...linuxFiles, "release-construction-receipt.json", "SHA256SUMS"]),
  ]);
  await Promise.all([verifyChecksums(macosDirectory, macFiles), verifyChecksums(linuxDirectory, linuxFiles)]);

  const macReceipt = macReceiptSchema.parse(JSON.parse(await readFile(join(macosDirectory, "OpenWhisper-macOS-release.json"), "utf8")) as unknown);
  if (macReceipt.version !== version || macReceipt.sourceCommit !== commit) throw new Error("MACOS_RELEASE_RECEIPT_SOURCE_MISMATCH");
  const linuxReceipt = linuxReceiptSchema.parse(JSON.parse(await readFile(join(linuxDirectory, "release-construction-receipt.json"), "utf8")) as unknown);
  if (linuxReceipt.source.commit !== commit || linuxReceipt.version !== version ||
      linuxReceipt.updatePolicy.feedURL !== LINUX_UPDATE_FEED_URL ||
      linuxReceipt.updatePolicy.publicKey !== LINUX_UPDATE_PUBLIC_KEY ||
      linuxReceipt.artifacts.debian.version !== version) throw new Error("LINUX_RELEASE_RECEIPT_SOURCE_MISMATCH");

  const debName = "OpenWhisper-Linux-amd64.deb", imageName = "OpenWhisper-Linux-x86_64.AppImage";
  for (const [name, artifact] of [[debName, linuxReceipt.artifacts.debian], [imageName, linuxReceipt.artifacts.appImage]] as const) {
    const path = join(linuxDirectory, name), stat = await lstat(path);
    if (stat.size !== artifact.bytes || await digest(path) !== artifact.sha256 || basename(artifact.path) !== name) {
      throw new Error("LINUX_RELEASE_CONSTRUCTION_ARTIFACT_MISMATCH");
    }
  }
  const feed = feedSchema.parse(JSON.parse(await readFile(join(linuxDirectory, "latest.json"), "utf8")) as unknown);
  if (feed.version !== version || feed.platforms["linux-x86_64-appimage"].url !== `${LINUX_UPDATE_REPOSITORY}/releases/download/v${version}/${imageName}` ||
      feed.platforms["linux-x86_64-deb"].url !== `${LINUX_UPDATE_REPOSITORY}/releases/download/v${version}/${debName}`) {
    throw new Error("LINUX_RELEASE_FEED_MISMATCH");
  }
  for (const [name, signature] of [[debName, feed.platforms["linux-x86_64-deb"].signature],
    [imageName, feed.platforms["linux-x86_64-appimage"].signature]] as const) {
    const signatureBytes = await readFile(join(linuxDirectory, `${name}.sig`));
    if (signatureBytes.byteLength > UPDATE_POLICY_LIMITS.signatureBytes || signatureBytes.toString("utf8").trim() !== signature) {
      throw new Error("LINUX_RELEASE_SIGNATURE_FEED_MISMATCH");
    }
    await verifyLinuxUpdateStream(createReadStream(join(linuxDirectory, name)), signature, version);
  }

  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  for (const name of releaseFiles) await copyFile(join(name === "OpenWhisper-macOS.dmg" || name === "OpenWhisper-macOS.zip" ? macosDirectory : linuxDirectory, name), join(outputDirectory, name));
  const rows = await Promise.all(releaseFiles.map(async (name) => `${await digest(join(outputDirectory, name))}  ${name}`));
  await writeFile(join(outputDirectory, "SHA256SUMS"), `${rows.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  await verifyChecksums(outputDirectory, releaseFiles);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 10 || args[0] !== "--version" || args[2] !== "--commit" || args[4] !== "--macos-dir" ||
      args[6] !== "--linux-dir" || args[8] !== "--output-dir" || args.slice(1).some((value) => !value)) {
    throw new Error("Usage: tsx scripts/validate-release-publication.ts --version X.Y.Z --commit <40-hex-commit> --macos-dir /path --linux-dir /path --output-dir /path");
  }
  await validateReleasePublication({ version: args[1]!, commit: args[3]!, macosDirectory: args[5]!, linuxDirectory: args[7]!, outputDirectory: args[9]! });
}

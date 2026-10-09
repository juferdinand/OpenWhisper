import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  LINUX_UPDATE_PUBLIC_KEY,
  verifyLinuxUpdateStream,
} from "../src/services/update/linux/linux-update-signature.js";
import {
  LINUX_UPDATE_FEED_URL,
  LINUX_UPDATE_REPOSITORY,
  UPDATE_POLICY_LIMITS,
} from "../src/services/update/common/update-policy.js";

const versionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const constructionReceiptSchema = z.object({
  classification: z.literal(
    "CANONICAL_STABLE_LINUX_RELEASE_CONSTRUCTION_UNSIGNED",
  ),
  source: z.object({
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    modified: z.literal(false),
  }),
  version: versionSchema,
  updatePolicy: z.object({
    publicKey: z.string(),
    feedURL: z.string().url(),
    requireSignedVersion: z.literal(true),
  }),
  artifacts: z.object({
    debian: z.object({
      path: z.string(),
      bytes: z.number().int().positive(),
      sha256: digestSchema,
      package: z.literal("io-github-whisperfree"),
      version: versionSchema,
      architecture: z.literal("amd64"),
    }),
    appImage: z.object({
      path: z.string(),
      bytes: z.number().int().positive(),
      sha256: digestSchema,
      mode: z.literal(0o755),
    }),
  }),
});

export interface FinalizeLinuxReleaseOptions {
  readonly directory: string;
  readonly version: string;
  readonly commit: string;
}
export interface FinalizeLinuxReleaseResult {
  readonly feed: string;
  readonly checksums: string;
}

async function regular(path: string): Promise<{ bytes: number; mode: number }> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("LINUX_RELEASE_EXPECTED_REGULAR_FILE");
  return { bytes: stat.size, mode: stat.mode & 0o7777 };
}

async function signedAsset(
  path: string,
  signaturePath: string,
  version: string,
): Promise<{
  signature: string;
  signatureSha256: string;
  bytes: number;
  sha256: string;
}> {
  const metadata = await regular(path);
  const signatureStat = await regular(signaturePath);
  if (
    metadata.bytes === 0 ||
    signatureStat.bytes === 0 ||
    signatureStat.bytes > UPDATE_POLICY_LIMITS.signatureBytes
  ) {
    throw new Error("LINUX_RELEASE_EMPTY_OR_OVERSIZED_ASSET");
  }
  const signatureBytes = await readFile(signaturePath),
    decodedSignature = signatureBytes.toString("utf8"),
    signature = decodedSignature.trim();
  if (
    !signature ||
    !Buffer.from(decodedSignature, "utf8").equals(signatureBytes)
  ) {
    throw new Error("LINUX_RELEASE_INVALID_SIGNATURE_TEXT");
  }
  const digest = createHash("sha256");
  let bytes = 0;
  async function* authenticatedChunks() {
    for await (const chunk of createReadStream(path)) {
      bytes += chunk.length;
      digest.update(chunk);
      yield chunk;
    }
  }
  await verifyLinuxUpdateStream(authenticatedChunks(), signature, version);
  if (bytes !== metadata.bytes)
    throw new Error("LINUX_RELEASE_ASSET_CHANGED_DURING_VERIFICATION");
  return {
    signature,
    signatureSha256: createHash("sha256").update(signatureBytes).digest("hex"),
    bytes,
    sha256: digest.digest("hex"),
  };
}

/** Verify signatures with the production typed verifier before writing feed or checksum metadata. */
export async function finalizeLinuxRelease(
  options: FinalizeLinuxReleaseOptions,
): Promise<FinalizeLinuxReleaseResult> {
  const version = versionSchema.parse(options.version),
    commit = z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .parse(options.commit);
  const directory = resolve(options.directory);
  if (directory !== options.directory || !directory.startsWith("/"))
    throw new Error("LINUX_RELEASE_DIRECTORY_MUST_BE_ABSOLUTE");
  const debianName = "OpenWhisper-Linux-amd64.deb",
    imageName = "OpenWhisper-Linux-x86_64.AppImage";
  const debian = join(directory, debianName),
    image = join(directory, imageName);
  const receipt = constructionReceiptSchema.parse(
    JSON.parse(
      await readFile(
        join(directory, "release-construction-receipt.json"),
        "utf8",
      ),
    ) as unknown,
  );
  if (
    receipt.source.commit !== commit ||
    receipt.version !== version ||
    receipt.artifacts.debian.version !== version ||
    receipt.updatePolicy.publicKey !== LINUX_UPDATE_PUBLIC_KEY ||
    receipt.updatePolicy.feedURL !== LINUX_UPDATE_FEED_URL ||
    receipt.artifacts.debian.path !== debian ||
    receipt.artifacts.appImage.path !== image
  )
    throw new Error("LINUX_RELEASE_CONSTRUCTION_RECEIPT_MISMATCH");
  const debianInfo = await regular(debian),
    imageInfo = await regular(image);
  if (
    debianInfo.bytes !== receipt.artifacts.debian.bytes ||
    imageInfo.bytes !== receipt.artifacts.appImage.bytes ||
    imageInfo.mode !== 0o755
  ) {
    throw new Error("LINUX_RELEASE_CONSTRUCTION_ARTIFACT_MISMATCH");
  }
  const signed = await Promise.all([
    signedAsset(debian, `${debian}.sig`, version),
    signedAsset(image, `${image}.sig`, version),
  ]);
  if (
    signed[0].bytes !== receipt.artifacts.debian.bytes ||
    signed[0].sha256 !== receipt.artifacts.debian.sha256 ||
    signed[1].bytes !== receipt.artifacts.appImage.bytes ||
    signed[1].sha256 !== receipt.artifacts.appImage.sha256
  ) {
    throw new Error("LINUX_RELEASE_SIGNED_ARTIFACT_DIFFERS_FROM_CONSTRUCTION");
  }
  const [debianSignature, imageSignature] = signed;
  const feed = {
    version,
    notes: `OpenWhisper ${version}. See the GitHub release for changes and platform notes.`,
    pub_date: new Date().toISOString(),
    platforms: {
      "linux-x86_64-appimage": {
        url: `${LINUX_UPDATE_REPOSITORY}/releases/download/v${version}/${imageName}`,
        signature: imageSignature.signature,
      },
      "linux-x86_64-deb": {
        url: `${LINUX_UPDATE_REPOSITORY}/releases/download/v${version}/${debianName}`,
        signature: debianSignature.signature,
      },
    },
  };
  const feedPath = join(directory, "latest.json"),
    checksumsPath = join(directory, "SHA256SUMS");
  for (const path of [feedPath, checksumsPath]) {
    try {
      await lstat(path);
      throw new Error("LINUX_RELEASE_METADATA_ALREADY_EXISTS");
    } catch (error: unknown) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  const feedText = `${JSON.stringify(feed, null, 2)}\n`;
  const feedDigest = createHash("sha256").update(feedText).digest("hex");
  const rows =
    [
      [signed[1].sha256, imageName],
      [signed[1].signatureSha256, `${imageName}.sig`],
      [signed[0].sha256, debianName],
      [signed[0].signatureSha256, `${debianName}.sig`],
      [feedDigest, "latest.json"],
    ]
      .map(([digest, name]) => `${digest}  ${name}`)
      .join("\n") + "\n";
  const temporaryFeed = `${feedPath}.tmp`,
    temporaryChecksums = `${checksumsPath}.tmp`;
  try {
    await writeFile(temporaryFeed, feedText, { flag: "wx", mode: 0o600 });
    await writeFile(temporaryChecksums, rows, { flag: "wx", mode: 0o600 });
    await rename(temporaryFeed, feedPath);
    await rename(temporaryChecksums, checksumsPath);
  } catch (error: unknown) {
    await Promise.all(
      [temporaryFeed, temporaryChecksums, feedPath, checksumsPath].map((path) =>
        rm(path, { force: true }),
      ),
    );
    throw error;
  }
  return { feed: feedPath, checksums: checksumsPath };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--directory" ||
    args[2] !== "--version" ||
    args[4] !== "--commit" ||
    args.slice(1).some((value) => !value)
  ) {
    throw new Error(
      "Usage: tsx scripts/finalize-linux-release.ts --directory /release/output --version X.Y.Z --commit <40-hex-commit>",
    );
  }
  console.log(
    JSON.stringify(
      await finalizeLinuxRelease({
        directory: args[1]!,
        version: args[3]!,
        commit: args[5]!,
      }),
    ),
  );
}

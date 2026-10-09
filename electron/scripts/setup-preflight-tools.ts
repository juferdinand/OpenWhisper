import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ACTIONLINT_VERSION = "1.7.12";
const ACTIONLINT_MANIFEST_SHA256 =
  "433028cf0ba3c42163ea1a668dedce30fcdbe84fe912b1a5e288c006eab8a4f5";
const SHELLCHECK_VERSION = "0.11.0";
const ACTIONLINT_BASE = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}`;
const SHELLCHECK_BASE = `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}`;
const TOOL_ROOT = resolve(import.meta.dirname, "../../.local/preflight-tools");

interface PlatformAsset {
  readonly actionlint: string;
  readonly actionlintSha256: string;
  readonly shellcheck: string;
  readonly shellcheckSha256: string;
  readonly shellcheckBinary: string;
}

const PLATFORM_ASSETS: Readonly<Record<string, PlatformAsset>> = {
  "linux-x64": {
    actionlint: `actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz`,
    actionlintSha256:
      "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    shellcheck: `shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz`,
    shellcheckSha256:
      "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198",
    shellcheckBinary: `shellcheck-v${SHELLCHECK_VERSION}/shellcheck`,
  },
  "darwin-x64": {
    actionlint: `actionlint_${ACTIONLINT_VERSION}_darwin_amd64.tar.gz`,
    actionlintSha256:
      "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
    shellcheck: `shellcheck-v${SHELLCHECK_VERSION}.darwin.x86_64.tar.xz`,
    shellcheckSha256:
      "3c89db4edcab7cf1c27bff178882e0f6f27f7afdf54e859fa041fca10febe4c6",
    shellcheckBinary: `shellcheck-v${SHELLCHECK_VERSION}/shellcheck`,
  },
  "darwin-arm64": {
    actionlint: `actionlint_${ACTIONLINT_VERSION}_darwin_arm64.tar.gz`,
    actionlintSha256:
      "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
    shellcheck: `shellcheck-v${SHELLCHECK_VERSION}.darwin.aarch64.tar.xz`,
    shellcheckSha256:
      "56affdd8de5527894dca6dc3d7e0a99a873b0f004d7aabc30ae407d3f48b0a79",
    shellcheckBinary: `shellcheck-v${SHELLCHECK_VERSION}/shellcheck`,
  },
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`Download failed (${response.status}): ${url}`);
  const announcedSize = Number(response.headers.get("content-length") ?? "0");
  if (announcedSize > maxBytes)
    throw new Error(`Download exceeds ${maxBytes} bytes: ${url}`);
  if (!response.body) throw new Error(`Download has no response body: ${url}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`Download exceeds ${maxBytes} bytes: ${url}`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, size);
}

export type PreflightDownloader = (
  url: string,
  maxBytes: number,
) => Promise<Uint8Array>;

export async function loadVerifiedAsset(
  cachePath: string,
  url: string,
  expectedSha256: string,
  maxBytes: number,
  download: PreflightDownloader = fetchBytes,
): Promise<Uint8Array> {
  try {
    const cached = await readFile(cachePath);
    if (cached.byteLength <= maxBytes && sha256(cached) === expectedSha256) {
      return cached;
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const downloaded = await download(url, maxBytes);
  if (
    downloaded.byteLength > maxBytes ||
    sha256(downloaded) !== expectedSha256
  ) {
    throw new Error(`Downloaded asset checksum or size mismatch: ${url}`);
  }

  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, downloaded, { mode: 0o600 });
    await rename(temporaryPath, cachePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return downloaded;
}

function extract(
  archive: string,
  staging: string,
  flag: "-xzf" | "-xJf",
  member: string,
): void {
  const result = spawnSync("tar", [flag, archive, "-C", staging, member], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`tar extraction failed: ${result.stderr.trim()}`);
}

export async function setupPreflightTools(): Promise<{
  actionlint: string;
  shellcheck: string;
}> {
  const platformKey = `${process.platform}-${process.arch}`;
  const assets = PLATFORM_ASSETS[platformKey];
  if (!assets)
    throw new Error(
      `Preflight tools do not support ${platformKey}; use Linux x64 or macOS x64/arm64.`,
    );

  await mkdir(TOOL_ROOT, { recursive: true, mode: 0o700 });
  await chmod(TOOL_ROOT, 0o700);
  const cacheDirectory = join(TOOL_ROOT, "cache");
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await chmod(cacheDirectory, 0o700);

  const manifestName = `actionlint_${ACTIONLINT_VERSION}_checksums.txt`;
  const manifestPath = join(cacheDirectory, manifestName);
  const actionlintArchivePath = join(cacheDirectory, assets.actionlint);
  const shellcheckArchivePath = join(cacheDirectory, assets.shellcheck);
  const [manifest] = await Promise.all([
    loadVerifiedAsset(
      manifestPath,
      `${ACTIONLINT_BASE}/${manifestName}`,
      ACTIONLINT_MANIFEST_SHA256,
      64 * 1024,
    ),
    loadVerifiedAsset(
      actionlintArchivePath,
      `${ACTIONLINT_BASE}/${assets.actionlint}`,
      assets.actionlintSha256,
      30 * 1024 * 1024,
    ),
    loadVerifiedAsset(
      shellcheckArchivePath,
      `${SHELLCHECK_BASE}/${assets.shellcheck}`,
      assets.shellcheckSha256,
      30 * 1024 * 1024,
    ),
  ]);
  if (sha256(manifest) !== ACTIONLINT_MANIFEST_SHA256)
    throw new Error("Official actionlint checksum manifest digest mismatch.");
  const manifestText = new TextDecoder().decode(manifest);
  const expectedActionlint = manifestText.match(
    new RegExp(
      `^([a-f0-9]{64})  ${assets.actionlint.replaceAll(".", "\\.")}$`,
      "m",
    ),
  )?.[1];
  if (expectedActionlint !== assets.actionlintSha256)
    throw new Error(
      "Pinned actionlint checksum does not match its official manifest.",
    );
  const staging = await mkdtemp(join(tmpdir(), "openwhisper-preflight-"));
  try {
    extract(actionlintArchivePath, staging, "-xzf", "actionlint");
    extract(
      shellcheckArchivePath,
      staging,
      "-xJf",
      `shellcheck-v${SHELLCHECK_VERSION}`,
    );

    const binDirectory = join(TOOL_ROOT, "bin");
    await mkdir(binDirectory, { recursive: true, mode: 0o700 });
    await chmod(binDirectory, 0o700);
    const actionlintPath = join(binDirectory, "actionlint");
    const shellcheckPath = join(binDirectory, "shellcheck");
    const actionlintBinary = await readFile(join(staging, "actionlint"));
    const shellcheckBinary = await readFile(
      join(staging, assets.shellcheckBinary),
    );
    const actionlintTemp = `${actionlintPath}.${process.pid}.tmp`;
    const shellcheckTemp = `${shellcheckPath}.${process.pid}.tmp`;
    await Promise.all([
      writeFile(actionlintTemp, actionlintBinary, { mode: 0o700 }),
      writeFile(shellcheckTemp, shellcheckBinary, { mode: 0o700 }),
    ]);
    await chmod(actionlintTemp, 0o700);
    await chmod(shellcheckTemp, 0o700);
    await rename(actionlintTemp, actionlintPath);
    await rename(shellcheckTemp, shellcheckPath);
    return { actionlint: actionlintPath, shellcheck: shellcheckPath };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  setupPreflightTools()
    .then(({ actionlint, shellcheck }) => {
      process.stdout.write(
        `Prepared actionlint ${ACTIONLINT_VERSION} and ShellCheck ${SHELLCHECK_VERSION} in ${TOOL_ROOT}\n`,
      );
      process.stdout.write(`${actionlint}\n${shellcheck}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

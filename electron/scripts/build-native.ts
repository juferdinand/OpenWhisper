import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const speechPinSchema = z.strictObject({
  repository: z.literal("ggml-org/whisper.cpp"), tag: z.literal("b5130"),
  revision: z.string().regex(/^[a-f0-9]{40}$/), sha256: digestSchema,
});
const headerPinSchema = z.strictObject({
  version: z.literal("24.21.0"), sha256: digestSchema,
  source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt"), napiVersion: z.literal(8),
});

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => { code === 0 ? accept() : reject(new Error("Native dependency build failed.")); });
  });
}

async function pinnedSource(url: string, sha256: string, destination: string): Promise<void> {
  const marker = join(destination, ".verified-archive");
  try { if ((await readFile(marker, "utf8")).trim() === sha256) return; }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".native-download-"));
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error("Pinned native source download failed.");
    const blocks: Uint8Array[] = [];
    let length = 0;
    for await (const block of response.body) {
      length += block.byteLength;
      if (length > 128 * 1024 * 1024) throw new Error("Native source archive exceeds its download limit.");
      blocks.push(block);
    }
    const bytes = Buffer.concat(blocks);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("Native source checksum mismatch.");
    const archive = join(temporary, "source.tar.gz");
    const unpacked = join(temporary, "source");
    await writeFile(archive, bytes);
    await mkdir(unpacked);
    await run("tar", ["-xzf", archive, "-C", unpacked, "--strip-components=1", "--no-same-owner"]);
    await writeFile(join(unpacked, ".verified-archive"), `${sha256}\n`);
    await rm(destination, { recursive: true, force: true });
    await rename(unpacked, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function buildNativeSpeech(): Promise<void> {
  const speechRaw: unknown = JSON.parse(await readFile(join(root, "native/whisper-source.json"), "utf8"));
  const headersRaw: unknown = JSON.parse(await readFile(join(root, "native/node-headers.json"), "utf8"));
  const speech = speechPinSchema.parse(speechRaw);
  const headers = headerPinSchema.parse(headersRaw);
  const source = join(root, "vendor/whisper.cpp");
  const node = join(root, "vendor/node-headers");
  await pinnedSource(`https://codeload.github.com/${speech.repository}/tar.gz/${speech.revision}`, speech.sha256, source);
  await pinnedSource(`https://nodejs.org/download/release/v${headers.version}/node-v${headers.version}-headers.tar.gz`, headers.sha256, node);
  const output = join(root, "native/build");
  await run("cmake", ["-S", join(root, "native"), "-B", output, "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release", `-DWHISPER_SOURCE=${source}`, `-DNODE_HEADERS=${join(node, "include/node")}`,
    ...(process.platform === "darwin" ? ["-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0"] : []),
  ]);
  await run("cmake", ["--build", output, "--target", "openwhisper_speech", "--parallel", "4"]);
  await mkdir(join(root, "dist/native"), { recursive: true });
  await cp(join(output, "openwhisper_speech.node"), join(root, "dist/native/openwhisper_speech.node"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNativeSpeech();

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.strictObject({ repository: z.literal("mackron/miniaudio"), tag: z.literal("0.11.25"),
  revision: z.literal("9634bedb5b5a2ca38c1ee7108a9358a4e233f14d"), sha256: digest,
  headerSha256: digest, licenseSha256: digest, license: z.literal("MIT-0") });
const headerSchema = z.strictObject({ version: z.literal("24.21.0"), sha256: digest,
  source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt"), napiVersion: z.literal(8) });
async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error("Pinned capture build failed.")));
  });
}
async function source(url: string, checksum: string, destination: string): Promise<void> {
  try { if ((await readFile(join(destination, ".verified-archive"), "utf8")).trim() === checksum) return; }
  catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".capture-source-"));
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error("Pinned capture source unavailable.");
    let count = 0; const blocks: Uint8Array[] = [];
    for await (const block of response.body) {
      count += block.byteLength;
      if (count > 128 * 1024 * 1024) throw new Error("Capture source archive too large.");
      blocks.push(block);
    }
    const bytes = Buffer.concat(blocks);
    if (createHash("sha256").update(bytes).digest("hex") !== checksum) throw new Error("Capture source checksum mismatch.");
    const archive = join(temporary, "source.tar.gz"), unpacked = join(temporary, "source");
    await writeFile(archive, bytes); await mkdir(unpacked);
    await run("tar", ["-xzf", archive, "-C", unpacked, "--strip-components=1", "--no-same-owner"]);
    await writeFile(join(unpacked, ".verified-archive"), `${checksum}\n`);
    await rm(destination, { recursive: true, force: true }); await rename(unpacked, destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function buildNativeCapture(): Promise<void> {
  if (process.platform !== "linux") throw new Error("The initial capture addon supports Linux PulseAudio only.");
  const pin = sourceSchema.parse(JSON.parse(await readFile(join(root, "native/capture/miniaudio-source.json"), "utf8")) as unknown);
  const headers = headerSchema.parse(JSON.parse(await readFile(join(root, "native/node-headers.json"), "utf8")) as unknown);
  const audio = join(root, "vendor/miniaudio"), node = join(root, "vendor/node-headers");
  await source(`https://codeload.github.com/${pin.repository}/tar.gz/${pin.revision}`, pin.sha256, audio);
  await source(`https://nodejs.org/download/release/v${headers.version}/node-v${headers.version}-headers.tar.gz`, headers.sha256, node);
  for (const [path, expected] of [["miniaudio.h", pin.headerSha256], ["LICENSE", pin.licenseSha256]] as const) {
    if (createHash("sha256").update(await readFile(join(audio, path))).digest("hex") !== expected)
      throw new Error("Capture source file checksum mismatch.");
  }
  const output = join(root, "native/capture/build");
  await run("cmake", ["-S", join(root, "native/capture"), "-B", output, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
    `-DMINIAUDIO_SOURCE=${audio}`, `-DNODE_HEADERS=${join(node, "include/node")}`, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"]);
  await run("cmake", ["--build", output, "--target", "openwhisper_capture", "--parallel", "4"]);
  await mkdir(join(root, "dist/native/capture-notices"), { recursive: true });
  await cp(join(output, "openwhisper_capture.node"), join(root, "dist/native/openwhisper_capture.node"));
  await cp(join(root, "native/capture/notices"), join(root, "dist/native/capture-notices"), { recursive: true });
  await cp(join(root, "native/capture/miniaudio-source.json"), join(root, "dist/native/capture-notices/source.json"));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNativeCapture();

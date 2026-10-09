import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digestSchema, pinnedNativeSource } from "./native-dependencies.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelHash = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";
const wavHash = "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e";
const floatHash = "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0";
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Decode only this checksum-pinned mono PCM16 fixture; this is not a general WAV importer. */
export function publicFixtureSamples(wav: Buffer): Buffer {
  if (digest(wav) !== wavHash || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("The public speech fixture checksum or format does not match.");
  }
  let pcm: Buffer | undefined;
  let validFormat = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > wav.length) throw new Error("The public speech fixture is incomplete.");
    if (kind === "fmt ") {
      validFormat = length >= 16 && wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1
        && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 12) === 2
        && wav.readUInt16LE(start + 14) === 16;
    } else if (kind === "data") pcm = wav.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (!validFormat || !pcm || pcm.length !== 352000) throw new Error("The public speech fixture parameters do not match.");
  const samples = Buffer.alloc(pcm.length * 2);
  for (let index = 0; index < pcm.length / 2; index += 1) {
    samples.writeFloatLE(pcm.readInt16LE(index * 2) / 32768, index * 4);
  }
  if (digest(samples) !== floatHash) throw new Error("The converted public speech fixture checksum does not match.");
  return samples;
}

export async function fetchSpeechFixtures(): Promise<void> {
  const destination = join(root, ".local/speech-fixtures");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const model = join(destination, "ggml-tiny.bin");
  let existing: Buffer | undefined;
  try { existing = await readFile(model); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (!existing || digest(existing) !== modelHash) {
    // This public download may use Hugging Face's HTTPS CDN; only exact pinned bytes are accepted.
    const response = await fetch("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin", {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body || !response.url.startsWith("https://")) {
      throw new Error("The public speech model download failed.");
    }
    const blocks: Uint8Array[] = [];
    let length = 0;
    for await (const block of response.body) {
      length += block.byteLength;
      if (length > 128 * 1024 * 1024) throw new Error("The public speech model exceeds its download limit.");
      blocks.push(block);
    }
    const bytes = Buffer.concat(blocks);
    if (digest(bytes) !== modelHash) throw new Error("The public speech model checksum does not match.");
    const temporary = `${model}.part`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, model);
    } finally { await rm(temporary, { force: true }); }
  }
  const source = join(root, "vendor/whisper.cpp"), sample = join(source, "samples/jfk.wav");
  let wav: Buffer;
  try { wav = await readFile(sample); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    // Package consumers have no native build. Prepare only its existing pinned public source fixture.
    const pin = z.strictObject({ repository: z.literal("ggml-org/whisper.cpp"), tag: z.literal("b5130"),
      revision: z.string().regex(/^[a-f0-9]{40}$/u), sha256: digestSchema }).parse(
      JSON.parse(await readFile(join(root, "native/whisper-source.json"), "utf8")) as unknown);
    await pinnedNativeSource(`https://codeload.github.com/${pin.repository}/tar.gz/${pin.revision}`, pin.sha256, source);
    wav = await readFile(sample);
  }
  await writeFile(join(destination, "jfk.f32"), publicFixtureSamples(wav), { mode: 0o600 });
  console.log("Checksum-pinned public speech fixtures are ready; no capture device was opened.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await fetchSpeechFixtures();

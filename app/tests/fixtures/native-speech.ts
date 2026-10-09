import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadNativeSpeech } from "../../src/workers/native-speech.js";

const [binding, model, audio] = process.argv.slice(2);
if (!binding || !model || !audio) throw new Error("Explicit owned speech fixtures are required.");
const bytes = await readFile(model);
if (createHash("sha256").update(bytes).digest("hex") !==
    "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21") {
  throw new Error("The speech fixture model checksum does not match.");
}
const pcm = await readFile(audio);
if (pcm.length % 4 !== 0) throw new Error("Invalid public test fixture audio.");
const samples = new Float32Array(pcm.length / 4);
for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readFloatLE(i * 4);
const speech = loadNativeSpeech(binding);
try {
  const gpu = speech.gpuDevice();
  speech.load({ path: model, family: "whisper", gpu: false });
  const first = speech.transcribe(samples, "en", "");
  const second = speech.transcribe(samples, "en", "");
  let wrongFamilyRejected = false;
  try { speech.load({ path: model, family: "parakeet", gpu: false }); }
  catch { wrongFamilyRejected = true; }
  if (!wrongFamilyRejected) throw new Error("A cached Whisper context accepted the wrong model family.");
  speech.load({ path: model, family: "whisper", gpu: false });
  const reloaded = speech.transcribe(samples, "en", "");
  process.stdout.write(JSON.stringify({ gpu, first, second, wrongFamilyRejected, reloaded }));
} finally { speech.shutdown(); }

import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { buildNativeCapture } from "./build-capture.js";
import { buildNativeSpeech } from "./build-native.js";
import { buildSpeechEntryGraph } from "./build-speech-entry-graph.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function digest(path: string) {
  const value = await readFile(path);
  return { bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") };
}
/** Explicit Dev build only; no model download, capture, stable installation or release signing. */
export async function buildDevelopmentRecording(): Promise<void> {
  if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error("The initial recording development build requires Linux.");
  }
  const speech = await buildNativeSpeech({ backend: "cpu" });
  await buildNativeCapture();
  const speechDirectory = join(root, "dist/native/speech/cpu"), captureDirectory = join(root, "dist/native/capture");
  await mkdir(speechDirectory, { recursive: true });
  await mkdir(captureDirectory, { recursive: true });
  const speechFile = join(speechDirectory, "openwhisper_speech.node"), captureFile = join(captureDirectory, "openwhisper_capture.node");
  await cp(speech.binding, speechFile);
  await cp(join(root, "dist/native/openwhisper_capture.node"), captureFile);
  const entry = join(root, "dist/workers/capture-entry.js");
  const bundled = await build({ entryPoints: [join(root, "src/workers/capture-entry.ts")], outfile: entry,
    bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false, metafile: true,
    external: ["electron", "original-fs"] });
  for (const input of Object.values(bundled.metafile.inputs)) for (const imported of input.imports) {
    if (imported.external && !imported.path.startsWith("node:") && imported.path !== "electron" && imported.path !== "original-fs") {
      throw new Error("The capture entry has an unexpected external dependency.");
    }
  }
  const graph = await buildSpeechEntryGraph(root), speechDigest = await digest(speechFile);
  const descriptor = developmentRecordingDescriptorSchema.parse({
    version: 1, platform: "linux", architecture: process.arch,
    capture: await digest(captureFile), captureEntry: await digest(entry),
    speech: { version: 1, platform: "linux", architecture: process.arch, napiVersion: 8,
      speechRevision: speech.manifest.speech.revision, speechSourceSha256: speech.manifest.speech.sha256,
      entries: [{ backend: "cpu", ...speechDigest }] }, speechEntryGraph: graph.graph,
  });
  // Compile a typed, captured record into the fixed module imported by main.
  await build({ stdin: { contents: `export const DEVELOPMENT_RECORDING_BUILD: unknown = ${JSON.stringify(descriptor)};`,
    loader: "ts", resolveDir: root }, outfile: join(root, "dist/main/development-recording-build.js"),
    platform: "node", format: "esm", target: "node24", sourcemap: false });
}

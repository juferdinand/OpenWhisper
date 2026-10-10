import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { buildNativeCapture } from "./build-capture.js";
import { buildNativeSpeech } from "./build-native.js";
import { buildSpeechEntryGraph } from "./build-speech-entry-graph.js";
import { buildMacCapture } from "./build-macos-capture.js";
import { buildMacRetirementProduction } from "./build-macos-retirement.js";
import { buildLinuxBus } from "./build-linux-bus.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function digest(path: string) {
  const value = await readFile(path);
  return { bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") };
}
async function bundleEntry(name: "capture-entry" | "macos-capture-entry" | "platform-entry"): Promise<string> {
  const entry = join(root, `dist/workers/${name}.js`);
  const bundled = await build({ entryPoints: [join(root, `src/workers/${name}.ts`)], outfile: entry,
    bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false, metafile: true,
    external: ["electron", "original-fs"] });
  for (const input of Object.values(bundled.metafile.inputs)) for (const imported of input.imports) {
    if (imported.external && !imported.path.startsWith("node:") && imported.path !== "electron" && imported.path !== "original-fs") {
      throw new Error("The recording entry has an unexpected external dependency.");
    }
  }
  return entry;
}
/** Explicit Dev build only; no model download, capture, stable installation or release signing. */
export async function buildDevelopmentRecording(): Promise<void> {
  if ((process.platform !== "linux" && process.platform !== "darwin") || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error("The recording development build requires Linux or macOS.");
  }
  const speech = await buildNativeSpeech({ backend: "cpu" });
  const vulkanSpeech = process.platform === "linux" && process.arch === "x64"
    ? await buildNativeSpeech({ backend: "vulkan" }) : undefined;
  if (process.platform === "darwin") {
    await buildMacCapture();
    await buildMacRetirementProduction();
  } else {
    await buildNativeCapture();
    await buildLinuxBus();
  }
  const speechDirectory = join(root, "dist/native/speech/cpu"), captureDirectory = join(root, "dist/native/capture");
  await mkdir(speechDirectory, { recursive: true });
  await mkdir(captureDirectory, { recursive: true });
  const captureName = process.platform === "darwin" ? "openwhisper_macos_capture.node" : "openwhisper_capture.node";
  const speechFile = join(speechDirectory, "openwhisper_speech.node"), captureFile = join(captureDirectory, captureName);
  await cp(speech.binding, speechFile);
  const vulkanFile = vulkanSpeech ? join(root, "dist/native/speech/vulkan/openwhisper_speech.node") : undefined;
  if (vulkanSpeech && vulkanFile) {
    if (vulkanSpeech.manifest.speech.revision !== speech.manifest.speech.revision ||
        vulkanSpeech.manifest.speech.sha256 !== speech.manifest.speech.sha256 ||
        vulkanSpeech.manifest.platform !== speech.manifest.platform ||
        vulkanSpeech.manifest.architecture !== speech.manifest.architecture) {
      throw new Error("CPU and Vulkan speech artifacts must use the same pinned source and host.");
    }
    await mkdir(join(root, "dist/native/speech/vulkan"), { recursive: true });
    await cp(vulkanSpeech.binding, vulkanFile);
  }
  await cp(join(root, "dist/native", captureName), captureFile);
  const entry = await bundleEntry(process.platform === "darwin" ? "macos-capture-entry" : "capture-entry");
  const platformServices = process.platform === "linux" ? {
    entry: await digest(await bundleEntry("platform-entry")), bus: await digest(join(root, "dist/native/openwhisper_linux_bus.node")),
  } : undefined;
  const graph = await buildSpeechEntryGraph(root), speechDigest = await digest(speechFile);
  const speechEntries = [{ backend: "cpu" as const, ...speechDigest },
    ...(vulkanFile ? [{ backend: "vulkan" as const, ...await digest(vulkanFile) }] : [])];
  const descriptor = developmentRecordingDescriptorSchema.parse({
    version: 1, platform: process.platform, architecture: process.arch,
    capture: await digest(captureFile), captureEntry: await digest(entry),
    ...(platformServices ? { platformServices } : { retirement: await digest(join(root, "dist/native/openwhisper_macos_retirement.node")) }),
    speech: { version: 1, platform: process.platform, architecture: process.arch, napiVersion: 8,
      speechRevision: speech.manifest.speech.revision, speechSourceSha256: speech.manifest.speech.sha256,
      entries: speechEntries }, speechEntryGraph: graph.graph,
  });
  // Compile a typed, captured record into the fixed module imported by main.
  await build({ stdin: { contents: `export const DEVELOPMENT_RECORDING_BUILD: unknown = ${JSON.stringify(descriptor)};`,
    loader: "ts", resolveDir: root }, outfile: join(root, "dist/main/development-recording-build.js"),
    platform: "node", format: "esm", target: "node24", sourcemap: false });
}

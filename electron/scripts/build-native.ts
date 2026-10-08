import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digestSchema, fileSha256, nativeTool, pinnedNativeSource, prepareVulkanToolchain } from "./native-dependencies.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const nativeBackendSchema = z.enum(["cpu", "vulkan", "metal"]);
export type NativeBackend = z.infer<typeof nativeBackendSchema>;
const hostSchema = z.strictObject({ platform: z.enum(["linux", "darwin"]), architecture: z.enum(["x64", "arm64"]) });
const optionsSchema = z.strictObject({ backend: nativeBackendSchema.default("cpu") });
const speechPinSchema = z.strictObject({ repository: z.literal("ggml-org/whisper.cpp"), tag: z.literal("b5130"),
  revision: z.string().regex(/^[a-f0-9]{40}$/), sha256: digestSchema });
const headerPinSchema = z.strictObject({ version: z.literal("24.21.0"), sha256: digestSchema,
  source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt"), napiVersion: z.literal(8) });
export const nativeBuildManifestSchema = z.strictObject({ version: z.literal(1), backend: nativeBackendSchema,
  platform: hostSchema.shape.platform, architecture: hostSchema.shape.architecture, fingerprint: digestSchema,
  bindingSha256: digestSchema, cmakeCacheSha256: digestSchema, sourceHashes: z.record(z.string(), digestSchema),
  speech: speechPinSchema, headers: headerPinSchema, toolchainFingerprint: digestSchema.nullable(),
  compiledCpu: z.literal(true), portableCpu: z.literal(true), metalEmbedded: z.boolean(),
  deploymentTarget: z.literal("14.0").nullable(), cmakeVersion: z.string().max(65536), compilerVersion: z.string().max(65536),
  scope: z.literal("Compiled backend profile only; runtime device/initialization/execution requires separate acceptance"),
}).refine((value) => (value.platform === "darwin" ? value.deploymentTarget === "14.0" : value.deploymentTarget === null)
  && (value.backend === "metal" ? value.platform === "darwin" && value.metalEmbedded : !value.metalEmbedded)
  && (value.backend === "vulkan" ? value.platform === "linux" && value.toolchainFingerprint !== null : value.toolchainFingerprint === null),
  "Native manifest profile fields must agree.");
export type NativeBuildManifest = z.infer<typeof nativeBuildManifestSchema>;
export interface NativeBuildArtifact { readonly backend: NativeBackend; readonly binding: string; readonly manifest: NativeBuildManifest }

/** Pure validation comes before reading pins, creating outputs, downloading or invoking tools. */
export function nativeBuildPlan(input: unknown = {}, host: unknown = { platform: process.platform, architecture: process.arch }) {
  const parsed = optionsSchema.parse(input), platform = hostSchema.parse(host);
  if ((parsed.backend === "vulkan" && platform.platform !== "linux") ||
      (parsed.backend === "metal" && platform.platform !== "darwin")) throw new Error("Unsupported native backend/platform combination.");
  return Object.freeze({ ...platform, backend: parsed.backend, output: join(root, `native/build-${parsed.backend}`),
    flags: Object.freeze([`-DOPENWHISPER_BACKEND=${parsed.backend}`,
      ...(platform.platform === "darwin" ? ["-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0",
        `-DCMAKE_OSX_ARCHITECTURES=${platform.architecture === "arm64" ? "arm64" : "x86_64"}`] : [])]),
  });
}

async function artifact(path: string, fingerprint: string, plan: ReturnType<typeof nativeBuildPlan>): Promise<NativeBuildArtifact | null> {
  let raw: string;
  try { raw = await readFile(join(path, "build-manifest.json"), "utf8"); }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
  const manifest = nativeBuildManifestSchema.parse(JSON.parse(raw));
  if (manifest.fingerprint !== fingerprint || manifest.backend !== plan.backend || manifest.platform !== plan.platform ||
      manifest.architecture !== plan.architecture) return null;
  const binding = join(path, "openwhisper_speech.node");
  const stats = await lstat(binding);
  if (!stats.isFile() || stats.isSymbolicLink() || await fileSha256(binding) !== manifest.bindingSha256 ||
      await fileSha256(join(path, "CMakeCache.txt")) !== manifest.cmakeCacheSha256) throw new Error("Native build artifact did not match its manifest.");
  return { backend: plan.backend, binding, manifest };
}

export async function buildNativeSpeech(input: unknown = {}): Promise<NativeBuildArtifact> {
  const plan = nativeBuildPlan(input);
  const speech = speechPinSchema.parse(JSON.parse(await readFile(join(root, "native/whisper-source.json"), "utf8")));
  const headers = headerPinSchema.parse(JSON.parse(await readFile(join(root, "native/node-headers.json"), "utf8")));
  const sourceHashes: Record<string, string> = {};
  for (const path of ["native/CMakeLists.txt", "native/speech_bridge.cpp", "native/speech_binding.cpp", "scripts/build-native.ts", "scripts/native-dependencies.ts"]) {
    sourceHashes[path] = await fileSha256(join(root, path));
  }
  const cmakeVersion = await nativeTool("cmake", ["--version"], root, 10_000);
  const compilerVersion = await nativeTool("c++", ["--version"], root, 10_000);
  const source = join(root, "vendor/whisper.cpp"), node = join(root, "vendor/node-headers");
  await pinnedNativeSource(`https://codeload.github.com/${speech.repository}/tar.gz/${speech.revision}`, speech.sha256, source);
  await pinnedNativeSource(`https://nodejs.org/download/release/v${headers.version}/node-v${headers.version}-headers.tar.gz`, headers.sha256, node);
  const toolchain = plan.backend === "vulkan" ? await prepareVulkanToolchain(root) : null;
  const fingerprint = createHash("sha256").update(JSON.stringify({ plan, sourceHashes, speech, headers,
    toolchainFingerprint: toolchain?.fingerprint ?? null, cmakeVersion, compilerVersion })).digest("hex");
  let built = await artifact(plan.output, fingerprint, plan);
  if (!built) {
    // Only the selected isolated Dev profile output is reset; the other CPU/GPU artifacts survive.
    await rm(plan.output, { recursive: true, force: true });
    await nativeTool("cmake", ["-S", join(root, "native"), "-B", plan.output, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
      `-DWHISPER_SOURCE=${source}`, `-DNODE_HEADERS=${join(node, "include/node")}`, ...plan.flags,
      ...(toolchain ? [`-DVulkan_INCLUDE_DIR=${join(toolchain.prefix, "include")}`, `-DVulkan_GLSLC_EXECUTABLE=${toolchain.compiler}`,
        `-DSPIRV-Headers_DIR=${join(toolchain.prefix, "share/cmake/SPIRV-Headers")}`, `-DCMAKE_PREFIX_PATH=${toolchain.prefix}`] : []),
    ], root);
    await nativeTool("cmake", ["--build", plan.output, "--target", "openwhisper_speech", "--parallel", "4"], root);
    const cache = await readFile(join(plan.output, "CMakeCache.txt"), "utf8");
    for (const [name, enabled] of Object.entries({ GGML_CPU: true, GGML_VULKAN: plan.backend === "vulkan", GGML_METAL: plan.backend === "metal",
      GGML_NATIVE: false, GGML_OPENMP: false, GGML_BACKEND_DL: false, GGML_AVX: false, GGML_AVX2: false,
      GGML_SSE42: false, GGML_BMI2: false, GGML_FMA: false, GGML_F16C: false })) {
      if (!new RegExp(`^${name}:BOOL=${enabled ? "ON" : "OFF"}$`, "m").test(cache)) throw new Error("Native feature cache does not match the selected profile.");
    }
    if (plan.backend === "metal" && !/^GGML_METAL_EMBED_LIBRARY:BOOL=ON$/m.test(cache)) throw new Error("Metal kernels must remain embedded.");
    for (const [path, before] of Object.entries(sourceHashes)) {
      if (await fileSha256(join(root, path)) !== before) throw new Error("Native build input changed while compiling.");
    }
    const manifest = nativeBuildManifestSchema.parse({ version: 1, backend: plan.backend, platform: plan.platform, architecture: plan.architecture,
      fingerprint, bindingSha256: await fileSha256(join(plan.output, "openwhisper_speech.node")),
      cmakeCacheSha256: await fileSha256(join(plan.output, "CMakeCache.txt")), sourceHashes, speech, headers,
      toolchainFingerprint: toolchain?.fingerprint ?? null, compiledCpu: true, portableCpu: true,
      metalEmbedded: plan.backend === "metal", deploymentTarget: plan.platform === "darwin" ? "14.0" : null,
      cmakeVersion, compilerVersion, scope: "Compiled backend profile only; runtime device/initialization/execution requires separate acceptance" });
    await writeFile(join(plan.output, "build-manifest.json"), JSON.stringify(manifest, null, 2));
    built = await artifact(plan.output, fingerprint, plan);
    if (!built) throw new Error("Missing completed native build artifact.");
  }
  // GPU artifacts are proof inputs only; the existing fixed worker still receives the CPU default.
  if (plan.backend === "cpu") {
    await mkdir(join(root, "dist/native"), { recursive: true });
    await cp(built.binding, join(root, "dist/native/openwhisper_speech.node"));
  }
  return built;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--backend" || !args[1])) {
    throw new Error("Usage: tsx scripts/build-native.ts [--backend cpu|vulkan|metal]");
  }
  const artifact = await buildNativeSpeech(args.length === 0 ? {} : { backend: args[1] });
  console.log(`Built ${artifact.backend} speech artifact: ${artifact.binding}`);
}

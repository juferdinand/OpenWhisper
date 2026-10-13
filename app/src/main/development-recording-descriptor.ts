import { z } from "zod";
import { developmentArtifactSchema } from "../services/development/development-artifact.js";
import { speechResourceCatalogSchema } from "../services/speech/speech-resources.js";
import { speechEntryGraphSchema } from "../services/speech/speech-entry-graph.js";
import { gpuBackendFor } from "../services/speech/backend-supervisor.js";

const common = {
  version: z.literal(1), architecture: z.enum(["x64", "arm64"]),
  capture: developmentArtifactSchema, captureEntry: developmentArtifactSchema,
  speech: speechResourceCatalogSchema, speechEntryGraph: speechEntryGraphSchema,
};
const developmentPlatformDescriptorSchema = z.strictObject({
  entry: developmentArtifactSchema, bus: developmentArtifactSchema,
}).readonly();
export const developmentRecordingDescriptorSchema = z.discriminatedUnion("platform", [
  z.strictObject({ ...common, platform: z.literal("linux"), platformServices: developmentPlatformDescriptorSchema.optional() }),
  z.strictObject({ ...common, platform: z.literal("darwin"), retirement: developmentArtifactSchema }),
]).superRefine((value, context) => {
  const backends = value.speech.entries.map((entry) => entry.backend);
  const cpuOnly = backends.length === 1 && backends[0] === "cpu";
  const cpuVulkan = value.platform === "linux" && value.architecture === "x64" &&
    backends.length === 2 && backends[0] === "cpu" && backends[1] === "vulkan";
  // Both Mac slices ship Metal so the universal package keeps one native inventory; only arm64 selects it.
  const cpuMetal = value.platform === "darwin" && backends.length === 2 && backends[0] === "cpu" && backends[1] === "metal";
  if (value.speech.platform !== value.platform || value.speech.architecture !== value.architecture ||
    !(cpuOnly || cpuVulkan || cpuMetal)) {
    context.addIssue({ code: "custom", message: "The development recording slice requires its matching CPU and optional Vulkan or Metal builds." });
  }
}).readonly();
export type DevelopmentRecordingDescriptor = z.infer<typeof developmentRecordingDescriptorSchema>;

/** Vulkan on Linux x64 and Metal on Apple Silicon, when the build ships that speech backend. */
export function recordingDescriptorSupportsGpu(descriptor: Pick<DevelopmentRecordingDescriptor, "platform" | "architecture" | "speech">): boolean {
  const backend = gpuBackendFor(descriptor);
  return backend !== undefined && descriptor.speech.entries.some((entry) => entry.backend === backend);
}

const darwin = { ...common, platform: z.literal("darwin"), retirement: developmentArtifactSchema };
/** Validate both original V1 branches before selecting a universal Mac runtime slice. */
export const darwinUniversalRecordingDescriptorSchema = z.strictObject({
  version: z.literal(2), platform: z.literal("darwin"),
  architectures: z.strictObject({
    arm64: developmentRecordingDescriptorSchema.pipe(z.strictObject({ ...darwin, architecture: z.literal("arm64") }).readonly()),
    x64: developmentRecordingDescriptorSchema.pipe(z.strictObject({ ...darwin, architecture: z.literal("x64") }).readonly()),
  }).readonly(),
}).readonly();

const recordingBuildSchema = z.union([developmentRecordingDescriptorSchema, darwinUniversalRecordingDescriptorSchema]);
const runtimeHostSchema = z.strictObject({ platform: z.enum(["linux", "darwin"]), architecture: z.enum(["arm64", "x64"]) });

/** Return only a matching V1 descriptor; this consistency check does not authenticate native bytes. */
export function selectDevelopmentRecordingDescriptor(input: unknown,
  host: unknown = { platform: process.platform, architecture: process.arch }): DevelopmentRecordingDescriptor {
  const runtime = runtimeHostSchema.parse(host), build = recordingBuildSchema.parse(input);
  if (build.version === 2) {
    if (runtime.platform !== "darwin") throw new Error("A universal Mac recording build requires Darwin.");
    return build.architectures[runtime.architecture];
  }
  if (build.platform !== runtime.platform || build.architecture !== runtime.architecture) {
    throw new Error("The recording build does not match this runtime.");
  }
  return build;
}

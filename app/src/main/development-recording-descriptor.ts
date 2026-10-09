import { z } from "zod";
import { developmentArtifactSchema } from "../services/development/development-artifact.js";
import { speechResourceCatalogSchema } from "../services/speech/speech-resources.js";
import { speechEntryGraphSchema } from "../services/speech/speech-entry-graph.js";

const common = {
  version: z.literal(1), architecture: z.enum(["x64", "arm64"]),
  capture: developmentArtifactSchema, captureEntry: developmentArtifactSchema,
  speech: speechResourceCatalogSchema, speechEntryGraph: speechEntryGraphSchema,
};
export const developmentPlatformDescriptorSchema = z.strictObject({
  entry: developmentArtifactSchema, bus: developmentArtifactSchema,
}).readonly();
export const developmentRecordingDescriptorSchema = z.discriminatedUnion("platform", [
  z.strictObject({ ...common, platform: z.literal("linux"), platformServices: developmentPlatformDescriptorSchema.optional() }),
  z.strictObject({ ...common, platform: z.literal("darwin"), retirement: developmentArtifactSchema }),
]).superRefine((value, context) => {
  if (value.speech.platform !== value.platform || value.speech.architecture !== value.architecture ||
    value.speech.entries.length !== 1 || value.speech.entries[0]?.backend !== "cpu") {
    context.addIssue({ code: "custom", message: "The development recording slice requires the matching CPU build." });
  }
}).readonly();
export type DevelopmentRecordingDescriptor = z.infer<typeof developmentRecordingDescriptorSchema>;

const darwin = { ...common, platform: z.literal("darwin"), retirement: developmentArtifactSchema };
/** Validate both original V1 branches before selecting a universal Mac runtime slice. */
export const darwinUniversalRecordingDescriptorSchema = z.strictObject({
  version: z.literal(2), platform: z.literal("darwin"),
  architectures: z.strictObject({
    arm64: developmentRecordingDescriptorSchema.pipe(z.strictObject({ ...darwin, architecture: z.literal("arm64") }).readonly()),
    x64: developmentRecordingDescriptorSchema.pipe(z.strictObject({ ...darwin, architecture: z.literal("x64") }).readonly()),
  }).readonly(),
}).readonly();
export type DarwinUniversalRecordingDescriptor = z.infer<typeof darwinUniversalRecordingDescriptorSchema>;

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

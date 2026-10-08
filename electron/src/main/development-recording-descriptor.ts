import { z } from "zod";
import { developmentArtifactSchema } from "../services/development-artifact.js";
import { speechResourceCatalogSchema } from "../services/speech-resources.js";
import { speechEntryGraphSchema } from "../services/speech-entry-graph.js";

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

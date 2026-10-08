import { z } from "zod";
import { developmentArtifactSchema } from "../services/development-artifact.js";
import { speechResourceCatalogSchema } from "../services/speech-resources.js";
import { speechEntryGraphSchema } from "../services/speech-entry-graph.js";

export const developmentRecordingDescriptorSchema = z.strictObject({
  version: z.literal(1), platform: z.literal("linux"), architecture: z.enum(["x64", "arm64"]),
  capture: developmentArtifactSchema, captureEntry: developmentArtifactSchema,
  speech: speechResourceCatalogSchema, speechEntryGraph: speechEntryGraphSchema,
}).superRefine((value, context) => {
  if (value.speech.platform !== value.platform || value.speech.architecture !== value.architecture ||
    value.speech.entries.length !== 1 || value.speech.entries[0]?.backend !== "cpu") {
    context.addIssue({ code: "custom", message: "The development recording slice requires the matching CPU build." });
  }
}).readonly();
export type DevelopmentRecordingDescriptor = z.infer<typeof developmentRecordingDescriptorSchema>;

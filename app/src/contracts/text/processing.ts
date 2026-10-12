import { z } from "zod";

const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const samples = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Processing telemetry is bound to the recording generation and retry attempt that produced it. */
const textProcessingStageSchema = z.enum(["recognition", "cleanup", "vocabulary", "snippets", "model"]);

export const textProcessingStageEventSchema = z.strictObject({
  generation: sequence,
  attempt: sequence,
  stage: textProcessingStageSchema,
  status: z.enum(["progress", "completed", "skipped"]),
  completedSamples: samples.optional(),
  totalSamples: sequence.optional(),
  text: z.string().optional(),
}).refine((event) => (event.completedSamples === undefined) === (event.totalSamples === undefined)
  && (event.completedSamples === undefined || event.completedSamples <= (event.totalSamples ?? 0))
  && (event.stage === "recognition" || event.completedSamples === undefined)
  && (event.status === "progress" ? (event.stage === "recognition" || event.stage === "model")
    && event.text === undefined && (event.stage !== "recognition" || event.completedSamples !== undefined)
    : event.completedSamples === undefined),
{ message: "Invalid text processing stage event." }).readonly();
export type TextProcessingStageEvent = z.infer<typeof textProcessingStageEventSchema>;

const transcriptDeliveryMetadataSchema = z.strictObject({ rawText: z.string() }).readonly();
export type TranscriptDeliveryMetadata = z.infer<typeof transcriptDeliveryMetadataSchema>;

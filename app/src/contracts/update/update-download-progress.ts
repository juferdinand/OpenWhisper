import { z } from "zod";

export const updateDownloadProgressSchema = z.strictObject({
  received: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).superRefine((value, context) => {
  if (value.total !== undefined && value.received > value.total) {
    context.addIssue({ code: "custom", message: "Received update bytes exceed the declared total." });
  }
});

export type UpdateDownloadProgress = z.infer<typeof updateDownloadProgressSchema>;

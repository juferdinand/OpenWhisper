import { z } from "zod";

export const stableMigrationFailureSchema = z.enum([
  "UNSAFE_SOURCE", "SOURCE_CHANGED", "INVALID_DATA", "INCOMPLETE_STATE", "INVALID_COMPLETION",
  "INVALID_TIMESTAMP", "PUBLICATION_UNAVAILABLE", "DESTINATION_EXISTS", "STORAGE_FAILED",
]);
export const stableMigrationReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), status: z.enum(["migrated", "already-complete"]),
    recoveryCount: z.int().min(0).max(100_000) }),
  z.strictObject({ ok: z.literal(false), code: stableMigrationFailureSchema }),
]);
export type StableMigrationReply = z.infer<typeof stableMigrationReplySchema>;

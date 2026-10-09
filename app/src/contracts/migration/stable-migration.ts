import { z } from "zod";

export const stableMigrationFailureSchema = z.enum([
  "UNSAFE_SOURCE", "SOURCE_CHANGED", "INVALID_DATA", "INCOMPLETE_STATE", "INVALID_COMPLETION",
  "INVALID_TIMESTAMP", "PUBLICATION_UNAVAILABLE", "DESTINATION_EXISTS", "STORAGE_FAILED",
  "LEGACY_APP_RUNNING", "PREFERENCES_SNAPSHOT_UNAVAILABLE", "PREFERENCES_SNAPSHOT_INCOHERENT", "LOGIN_STATE_UNKNOWN",
]);
export class StableMigrationError extends Error {
  constructor(readonly code: z.infer<typeof stableMigrationFailureSchema>) {
    super(code); this.name = "StableMigrationError";
  }
}
export const stableMigrationReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), status: z.enum(["migrated", "already-complete"]),
    recoveryCount: z.int().min(0).max(100_000) }),
  z.strictObject({ ok: z.literal(false), code: stableMigrationFailureSchema }),
]);
export type StableMigrationReply = z.infer<typeof stableMigrationReplySchema>;

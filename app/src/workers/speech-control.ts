import { isAbsolute } from "node:path";
import { z } from "zod";

export const speechBootstrapArgumentsSchema = z.tuple([
  z.string().min(1).max(4096).refine((value) => isAbsolute(value) && value.endsWith(".node") && !value.includes("\0")),
  z.string().uuid(),
]);
export const speechChallengeRequestSchema = z.strictObject({
  version: z.literal(1), type: z.literal("challenge"), epoch: z.string().uuid(), nonce: z.string().uuid(),
});
// This exact private shape matches the supervisor's existing challenge contract.
export const speechChallengeReplySchema = z.strictObject({
  version: z.literal(1), epoch: z.string().uuid(), nonce: z.string().uuid(), pid: z.number().int().positive(),
});
export type SpeechChallengeRequest = z.infer<typeof speechChallengeRequestSchema>;
export type SpeechChallengeReply = z.infer<typeof speechChallengeReplySchema>;

/** A finite private control budget; ordinary work never expands nonce storage. */
export const MAX_SPEECH_CHALLENGES = 64;

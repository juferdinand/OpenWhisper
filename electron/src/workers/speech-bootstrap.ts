import { z } from "zod";
import type { NativeSpeech } from "./native-speech.js";
import {
  MAX_SPEECH_CHALLENGES, speechBootstrapArgumentsSchema, speechChallengeReplySchema,
  speechChallengeRequestSchema, type SpeechChallengeReply,
} from "./speech-control.js";
import { executeSpeechRequest, speechReadySchema, speechRequestSchema, type SpeechReply } from "./speech-protocol.js";

export type SpeechBootstrapFailureCode = "CONTROL_FAILED" | "INVALID_FRAME" | "CLOSED";
export class SpeechBootstrapError extends Error {
  constructor(readonly code: SpeechBootstrapFailureCode) { super(`Speech bootstrap: ${code}.`); }
}
export interface SpeechBootstrap {
  readonly ready: z.infer<typeof speechReadySchema>;
  receive(input: unknown): SpeechChallengeReply | SpeechReply;
  close(): void;
}

/** Utility-local serial kernel. Two challenges are a control prerequisite, not OS
 * admission: only the main supervisor may expose ordinary work after identity checks.
 * The loader effect is host-only and the binding is fixed at construction. */
export function createSpeechBootstrap(options: Readonly<{
  binding: string; epoch: string; pid: number; load: (binding: string) => NativeSpeech;
}>): SpeechBootstrap {
  const [binding, epoch] = speechBootstrapArgumentsSchema.parse([options.binding, options.epoch]);
  const pid = z.number().int().positive().parse(options.pid);
  const nonces = new Set<string>();
  let native: NativeSpeech | undefined;
  let attemptedLoad = false;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (native) {
      const owned = native; native = undefined;
      // Teardown cannot expose native diagnostic details through the private channel.
      try { owned.shutdown(); } catch { /* The owning process exits after local cleanup. */ }
    }
  };
  const fail = (code: SpeechBootstrapFailureCode): never => { close(); throw new SpeechBootstrapError(code); };
  return Object.freeze({
    ready: speechReadySchema.parse({ version: 1, type: "ready" }),
    receive(input: unknown): SpeechChallengeReply | SpeechReply {
      if (closed) throw new SpeechBootstrapError("CLOSED");
      const challenge = speechChallengeRequestSchema.safeParse(input);
      if (challenge.success) {
        if (challenge.data.epoch !== epoch || nonces.has(challenge.data.nonce) || nonces.size >= MAX_SPEECH_CHALLENGES) {
          return fail("CONTROL_FAILED");
        }
        nonces.add(challenge.data.nonce);
        return speechChallengeReplySchema.parse({ version: 1, epoch, nonce: challenge.data.nonce, pid });
      }
      const request = speechRequestSchema.safeParse(input);
      if (!request.success) return fail("INVALID_FRAME");
      if (request.data.command === "shutdown") {
        closed = true;
        if (!native) return { version: 1, id: request.data.id, ok: true, value: { command: "shutdown" } };
        const owned = native; native = undefined;
        return executeSpeechRequest(owned, request.data);
      }
      if (nonces.size < 2) return fail("CONTROL_FAILED");
      if (!attemptedLoad) {
        attemptedLoad = true;
        try { native = options.load(binding); }
        catch { /* Only binding load refusal uses START_FAILED, never a device result. */ }
      }
      if (!native) return { version: 1, id: request.data.id, ok: false, code: "START_FAILED" };
      return executeSpeechRequest(native, request.data);
    },
    close,
  } satisfies SpeechBootstrap);
}

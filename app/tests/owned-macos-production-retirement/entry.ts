import { speechChallengeReplySchema, speechChallengeRequestSchema } from "../../src/workers/speech/speech-control.js";
import { exitRequestSchema, modeSchema } from "./contracts.js";
import { z } from "zod";

const mode = modeSchema.parse(process.argv[2]), epoch = z.string().uuid().parse(process.argv[3]);
if (process.platform !== "darwin" || process.type !== "utility" || process.getuid?.() === 0 ||
  process.env["OPENWHISPER_OWNED_MAC_PRODUCTION_RETIREMENT_TEST"] !== "1" || !process.parentPort) process.exit(1);
const port = process.parentPort, nonces = new Set<string>();
// Private helper fallback only; this fixture has no audio or recording duration.
setTimeout(() => { process.exit(1); }, 20_000);
port.on("message", (event: { data: unknown }) => {
  const challenge = speechChallengeRequestSchema.safeParse(event.data);
  if (challenge.success) {
    if (challenge.data.epoch !== epoch || nonces.has(challenge.data.nonce) || nonces.size >= 2) process.exit(1);
    nonces.add(challenge.data.nonce);
    port.postMessage(speechChallengeReplySchema.parse({ version: 1, epoch, nonce: challenge.data.nonce, pid: process.pid })); return;
  }
  if (!exitRequestSchema.safeParse(event.data).success || nonces.size !== 2 || mode === "kill") process.exit(1);
  process.exit(mode === "nonzero" ? 17 : 0);
});
port.postMessage({ version: 1, type: "ready" });
if (mode === "early") setTimeout(() => { process.exit(0); }, 20);

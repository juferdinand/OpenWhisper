import { modeSchema, nonceRequestSchema, retireSchema } from "./contracts.js";

const mode = modeSchema.parse(process.argv[2]);
if (process.platform !== "darwin" || process.type !== "utility" || process.getuid?.() === 0 || process.env["GITHUB_ACTIONS"] !== "true" ||
  process.env["OPENWHISPER_OWNED_MAC_RETIREMENT_TEST"] !== "1" || !process.parentPort) process.exit(1);
const port = process.parentPort;
// Fixed self-exit is a fixture cleanup fallback, never a recording cutoff.
const fallback = setTimeout(() => { process.exit(1); }, 20_000);
if (mode === "delayed") process.on("SIGTERM", () => { setTimeout(() => { process.exit(0); }, 150); });
if (mode === "ignore") process.on("SIGTERM", () => { /* Owned fixture deliberately ignores this one signal. */ });
port.on("message", (event: { data: unknown }) => {
  const challenge = nonceRequestSchema.safeParse(event.data);
  if (challenge.success) { port.postMessage({ kind: "nonce", nonce: challenge.data.nonce, epoch: challenge.data.epoch }); return; }
  if (!retireSchema.safeParse(event.data).success) { process.exit(1); return; }
  if (mode === "ignore") { setTimeout(() => { process.exit(0); }, 600); return; }
  clearTimeout(fallback); process.exit(mode === "nonzero" ? 17 : 0);
});
port.postMessage({ kind: "ready" });
if (mode === "early") setTimeout(() => { process.exit(0); }, 20);

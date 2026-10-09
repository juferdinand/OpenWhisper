import { createRequire } from "node:module";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { probeStateSchema } from "./contracts.js";

const input = z.strictObject({ binding: z.string().endsWith("/dist/native/openwhisper_macos_retirement_probe.node") }).parse(workerData);
if (isMainThread || !parentPort || process.platform !== "darwin" || process.getuid?.() === 0 || process.env["GITHUB_ACTIONS"] !== "true" ||
  process.env["OPENWHISPER_OWNED_MAC_RETIREMENT_TEST"] !== "1") process.exit(1);
const port = parentPort;
const raw: unknown = createRequire(import.meta.url)(input.binding);
if (!raw || typeof raw !== "object") process.exit(1);
function call(name: string, args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(raw as object, name); if (typeof method !== "function") throw new Error("PROBE_FAILED");
  return Reflect.apply(method, raw, args);
}
// This separately labelled test hook accepts NO PID/UID/parent and executes no
// kernel process query or watch allocation. Only native lifetime machinery is shared.
const owner = call("createSynthetic", []);
call("holdNext", [owner, 1500]);
void Promise.resolve(call("observe", [owner])).then(() => { port.postMessage({ kind: "unexpected-settlement" }); }, () => {
  port.postMessage({ kind: "unexpected-settlement" });
});
const until = performance.now() + 5000;
async function notify(): Promise<void> {
  for (;;) {
    const state = probeStateSchema.parse(call("probeState", [owner]));
    if (!state.synthetic || state.kernelQueries !== 0 || state.watchAllocations !== 0) throw new Error("PROBE_FAILED");
    if (state.barrierEntered) { port.postMessage({ kind: "barrier-entered", state }); return; }
    if (performance.now() >= until) throw new Error("PROBE_FAILED");
    await new Promise<void>((accept) => { setTimeout(accept, 5); });
  }
}
void notify().catch(() => { port.postMessage({ kind: "synthetic-failure" }); process.exitCode = 1; });

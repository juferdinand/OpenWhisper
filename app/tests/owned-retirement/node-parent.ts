import { fork } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bootstrapFailureMetadata, prepareOwnedEnvironment } from "./bootstrap.js";
import { probeFailureMetadata, type Suite } from "./contract.js";
import { OwnedLink, runProbe } from "./probe.js";
import { runtimeFailureMetadata, verifyRuntimePayload } from "./acceptance.js";

// Install the referenced watchdog before any synchronous bootstrap can fail.
const watchdog = setTimeout(() => { process.exit(79); }, 150_000);
async function fail(error: unknown, phase: "bootstrap" | "probe"): Promise<void> {
  try { await writeFile("/evidence/failure.json", JSON.stringify({ status: "FAIL", code: "FIXTURE_FAILED", phase,
    ...(phase === "bootstrap" ? bootstrapFailureMetadata(error) : { ...runtimeFailureMetadata(error), ...probeFailureMetadata(error) }) }), { mode: 0o600 }); }
  catch { /* Exit remains mandatory if evidence writing fails. */ }
  clearTimeout(watchdog); process.exit(1);
}
async function run(suite: Suite): Promise<void> {
  await verifyRuntimePayload("node");
  const result = await runProbe("node", suite, (epoch, mode) => {
    const child = fork(fileURLToPath(new URL("./child-entry.mjs", import.meta.url)), [epoch, mode], {
      execPath: "/opt/node/bin/node", execArgv: [], env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    return new OwnedLink({ pid: () => child.pid,
      send: (request) => new Promise<void>((accept, reject) => { child.send(request, (error: Error | null) => { if (error) reject(error); else accept(); }); }),
      kill: () => child.kill("SIGTERM"), onMessage: (listener) => { child.on("message", (input: unknown) => { listener(input); }); },
      onExit: (listener) => { child.once("exit", (code, signal) => { listener(code, signal); }); },
      onFailure: (listener) => { child.once("error", listener); }, onSpawn: (listener) => { child.once("spawn", listener); } }, epoch, mode);
  });
  await writeFile("/evidence/result.json", JSON.stringify(result, null, 2), { mode: 0o600 });
}
// No top-level await: this fixture never blocks a runtime bootstrap on module evaluation.
try {
  const { suite } = prepareOwnedEnvironment();
  void run(suite).then(() => { clearTimeout(watchdog); process.exit(0); }, (error: unknown) => fail(error, "probe"));
} catch (error) { void fail(error, "bootstrap"); }

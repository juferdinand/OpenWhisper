import { app, utilityProcess } from "electron";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bootstrapFailureMetadata, prepareOwnedEnvironment } from "./bootstrap.js";
import { probeFailureMetadata, type Suite } from "./contract.js";
import { OwnedLink, runProbe } from "./probe.js";
import { runtimeFailureMetadata, verifyRuntimePayload } from "./acceptance.js";

// Install the referenced watchdog before any synchronous bootstrap can fail.
const watchdog = setTimeout(() => { app.exit(79); }, 150_000);
async function fail(error: unknown, phase: "bootstrap" | "probe"): Promise<void> {
  try { await writeFile("/evidence/failure.json", JSON.stringify({ status: "FAIL", code: "FIXTURE_FAILED", phase,
    ...(phase === "bootstrap" ? bootstrapFailureMetadata(error) : { ...runtimeFailureMetadata(error), ...probeFailureMetadata(error) }) }), { mode: 0o600 }); }
  catch { /* Exit remains mandatory if evidence writing fails. */ }
  clearTimeout(watchdog); app.exit(1);
}
async function run(suite: Suite): Promise<void> {
  await app.whenReady(); await verifyRuntimePayload("electron");
  const result = await runProbe("electron", suite, (epoch, mode) => {
    const child = utilityProcess.fork(fileURLToPath(new URL("./utility-entry.mjs", import.meta.url)), [epoch, mode], {
      env: process.env, stdio: "ignore", serviceName: "OpenWhisper Retirement Fixture",
    });
    return new OwnedLink({ pid: () => child.pid, send: async (request) => { child.postMessage(request); }, kill: () => child.kill(),
      onMessage: (listener) => { child.on("message", (input: unknown) => { listener(input); }); },
      onExit: (listener) => { child.once("exit", (code) => { listener(code, null); }); },
      onFailure: (listener) => { child.once("error", listener); }, onSpawn: (listener) => { child.once("spawn", listener); } }, epoch, mode);
  });
  await writeFile("/evidence/result.json", JSON.stringify(result, null, 2), { mode: 0o600 });
}
// Awaiting app.whenReady at top level can deadlock Electron's ESM startup.
try {
  // Private profile preparation and path selection stay synchronous, before ready.
  const { profile, suite } = prepareOwnedEnvironment();
  app.setName("OpenWhisper Retirement Fixture");
  app.setPath("userData", profile.roots.config); app.setPath("sessionData", profile.paths.session); app.setPath("crashDumps", profile.paths.logs);
  void run(suite).then(() => { clearTimeout(watchdog); app.exit(0); }, (error: unknown) => fail(error, "probe"));
} catch (error) { void fail(error, "bootstrap"); }

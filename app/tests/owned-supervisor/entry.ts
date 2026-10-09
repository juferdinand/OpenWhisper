import { app } from "electron";
import { writeFile } from "node:fs/promises";
import { prepareEnvironment } from "./bootstrap.js";
import { runCpuComposition } from "./probe.js";
import { inputSchema, IMAGE, NODE_SHA256, ELECTRON_SHA256 } from "./contract.js";
import { boundedJson, describe, verifyPayload, type RawFiles } from "./files.js";

// Referenced before synchronous private preparation; never top-level await ready.
const watchdog = setTimeout(() => { app.exit(79); }, 150_000);
let stage: "bootstrap" | "ready" | "payload" | "runtime" | "composition" | "result" = "bootstrap";
async function failed(): Promise<void> {
  try { await writeFile("/evidence/failure.json", JSON.stringify({ status: "FAIL", code: "FIXTURE_FAILED", stage }), { mode: 0o600 }); }
  catch { /* Mandatory exit survives evidence failure. */ }
  clearTimeout(watchdog); app.exit(1);
}
async function run(profile: ReturnType<typeof prepareEnvironment>): Promise<void> {
  stage = "ready"; await app.whenReady(); stage = "payload";
  const input = inputSchema.parse(await boundedJson("/payload/input.json")); await verifyPayload("/payload", input.build);
  stage = "runtime";
  if (process.type !== "browser" || process.versions.electron !== "44.7.0" || process.execPath !== "/owned-runtime/electron/electron") throw new Error("Unexpected fixture runtime.");
  // Fixed pinned Electron builtin. Only raw runtime bytes use it; no noAsar/global mutation.
  const original = await import("original-fs"), io: RawFiles = original.default.promises;
  if (typeof io.lstat !== "function" || typeof io.open !== "function") throw new Error("Unexpected raw filesystem API.");
  for (const [path, expected] of Object.entries(input.runtimeFiles)) {
    const actual = await describe(`/owned-runtime/electron/${path}`, 512 * 1024 * 1024, io);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error("Fixture runtime bytes changed.");
  }
  if ((await describe(process.execPath, 512 * 1024 * 1024, io)).sha256 !== ELECTRON_SHA256 ||
      (await describe("/opt/node/bin/node", 256 * 1024 * 1024, io)).sha256 !== NODE_SHA256) throw new Error("Fixture executable changed.");
  await writeFile("/evidence/runtime.json", JSON.stringify({ image: IMAGE, uid: process.getuid?.(), pid: process.pid,
    electronSha256: input.electronSha256, nodeSha256: input.nodeSha256, runtimeFileApi: "original-fs", versions: process.versions }), { mode: 0o600 });
  stage = "composition"; const result = await runCpuComposition(profile); stage = "result";
  await writeFile("/evidence/result.json", JSON.stringify(result, null, 2), { mode: 0o600 });
}
try {
  const profile = prepareEnvironment(); app.setName("OpenWhisper CPU Supervisor Fixture");
  app.setPath("userData", profile.roots.config); app.setPath("sessionData", profile.paths.session); app.setPath("crashDumps", profile.paths.logs);
  void run(profile).then(() => { clearTimeout(watchdog); app.exit(0); }, () => failed());
} catch { void failed(); }

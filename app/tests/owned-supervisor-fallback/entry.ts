import { app } from "electron";
import { writeFile } from "node:fs/promises";
import { prepareEnvironment } from "./bootstrap.js";
import { runFallbackComposition } from "./probe.js";
import { inputSchema, preflightSchema, PROFILE_IMAGES, NODE_SHA256, ELECTRON_SHA256, MAX_METADATA_BYTES, validateRuntimeDerivative, failureMetadata } from "./contract.js";
import { boundedJson, describe, type RawFiles } from "../owned-supervisor/files.js";

const watchdog = setTimeout(() => { app.exit(79); }, 150_000); // Before any synchronous bootstrap effect.
let stage: "bootstrap" | "ready" | "payload" | "runtime" | "preflight" | "composition" | "result" = "bootstrap";
async function failed(error: unknown): Promise<void> {
  try { await writeFile("/evidence/failure.json", JSON.stringify({ status: "FAIL", code: "FIXTURE_FAILED", stage, ...failureMetadata(error) }), { mode: 0o600 }); }
  catch { /* Mandatory exit survives evidence failure. */ }
  clearTimeout(watchdog); app.exit(1);
}
async function run(profile: ReturnType<typeof prepareEnvironment>): Promise<void> {
  stage = "ready"; await app.whenReady(); stage = "payload";
  const input = inputSchema.parse(await boundedJson("/payload/input.json", MAX_METADATA_BYTES));
  if (input.profile !== process.env.OPENWHISPER_FALLBACK_PROFILE) throw new Error("Unexpected fixture profile.");
  for (const [name, expected] of Object.entries(input.build.payloadFiles)) {
    const actual = await describe(`/payload/${name}`); if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error("Fixture payload changed.");
  }
  validateRuntimeDerivative(input.build.originalRuntimeFiles, input.build.absentRuntimeFiles); stage = "runtime";
  if (process.type !== "browser" || process.versions.electron !== "44.7.0" || process.execPath !== "/owned-runtime/electron/electron") throw new Error("Unexpected fixture runtime.");
  const original = await import("original-fs"), io: RawFiles = original.default.promises;
  if (typeof io.lstat !== "function" || typeof io.open !== "function") throw new Error("Unexpected raw filesystem API.");
  const files = input.profile === "loader-present" ? input.build.originalRuntimeFiles : input.build.absentRuntimeFiles;
  for (const [name, expected] of Object.entries(files)) {
    const actual = await describe(`/owned-runtime/electron/${name}`, 512 * 1024 * 1024, io);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error("Fixture runtime changed.");
  }
  if ((await describe(process.execPath, 512 * 1024 * 1024, io)).sha256 !== ELECTRON_SHA256 || (await describe("/opt/node/bin/node", 256 * 1024 * 1024, io)).sha256 !== NODE_SHA256) throw new Error("Fixture executable changed.");
  await writeFile("/evidence/runtime.json", JSON.stringify({ profile: input.profile, image: PROFILE_IMAGES[input.profile], uid: process.getuid?.(), pid: process.pid,
    electronSha256: input.electronSha256, nodeSha256: input.nodeSha256, runtimeFileApi: "original-fs", versions: process.versions }), { mode: 0o600 });
  stage = "preflight"; const environment = preflightSchema.parse(await boundedJson("/evidence/environment.json"));
  if (environment.profile !== input.profile) throw new Error("Unexpected environment profile.");
  stage = "composition"; const result = await runFallbackComposition(profile); stage = "result";
  await writeFile("/evidence/result.json", JSON.stringify(result, null, 2), { mode: 0o600 });
}
try {
  const profile = prepareEnvironment(); app.setName("OpenWhisper Supervisor Fallback Fixture");
  app.setPath("userData", profile.roots.config); app.setPath("sessionData", profile.paths.session); app.setPath("crashDumps", profile.paths.logs);
  void run(profile).then(() => { clearTimeout(watchdog); app.exit(0); }, (error: unknown) => failed(error));
} catch (error: unknown) { void failed(error); }

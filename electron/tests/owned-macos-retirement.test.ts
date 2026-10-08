import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildMacRetirementFixture } from "./owned-macos-retirement/build-probe.js";
import { resultSchema } from "./owned-macos-retirement/contracts.js";

const enabled = process.env["OPENWHISPER_OWNED_MAC_RETIREMENT_TEST"] === "1";
const sourceNames = ["src/services/macos-process-retirement.ts", "tests/owned-macos-retirement.test.ts", "tests/owned-macos-retirement/main.ts",
  "tests/owned-macos-retirement/entry.ts", "tests/owned-macos-retirement/worker.ts", "tests/owned-macos-retirement/contracts.ts", "tests/owned-macos-retirement/build-probe.ts"];
async function retain(root: string, project: string): Promise<void> {
  const evidence = process.env["OPENWHISPER_MAC_RETIREMENT_EVIDENCE"]; if (!evidence) return;
  const inside = relative(join(project, ".local"), evidence);
  assert.ok(isAbsolute(evidence) && !evidence.includes("\0") && inside && !inside.startsWith("..") && !isAbsolute(inside));
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const owner = await lstat(evidence);
  assert.ok(owner.isDirectory() && !owner.isSymbolicLink()); assert.equal(owner.uid, process.getuid?.());
  assert.equal(owner.mode & 0o7777, 0o700); assert.equal(await realpath(evidence), resolve(evidence));
  for (const name of ["result.json", "failure.json", "lifecycle.json", "phases.json", "retained.json", "startup.json", "checkpoint.json"]) {
    try { await cp(join(root, name), join(evidence, name)); }
    catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  const binding = join(project, "dist/native/openwhisper_macos_retirement_probe.node");
  const sourceHashes: Record<string, string> = {};
  for (const name of sourceNames) sourceHashes[name] = createHash("sha256").update(await readFile(join(project, name))).digest("hex");
  const require = createRequire(import.meta.url);
  await cp(join(project, "dist/native/macos-retirement-probe-notices/build-manifest.json"), join(evidence, "build-manifest.json"));
  await writeFile(join(evidence, "run-manifest.json"), JSON.stringify({ bindingSha256: createHash("sha256").update(await readFile(binding)).digest("hex"), sourceHashes,
    electronVersion: z.object({ version: z.string() }).parse(require("electron/package.json")).version, architecture: process.arch, uid: process.getuid?.(),
    probeOnly: true, mainOnlyKernel: true, workerSyntheticOnly: true, productionArchitectureSelected: false,
    scope: "Owned Apple CI VM; main public-SDK/trusted Electron child topology plus separate target-free synthetic Worker environment lifetime. Delayed/ignored scenario names configure handlers; signal delivery, survival and delay are not inferred. No production factory, audio/TCC, deterministic zombie or signed package evidence." }, null, 2), { mode: 0o600 });
}

test("owned Apple parent-native retirement probe measures SDK identity and asynchronous resource lifetime without audio", { skip: !enabled, timeout: 180_000 }, async () => {
  assert.equal(process.platform, "darwin"); assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.notEqual(process.getuid?.(), 0);
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const distribution = join(project, "dist"), binding = join(distribution, "native/openwhisper_macos_retirement_probe.node");
  const file = await lstat(binding); assert.ok(file.isFile() && !file.isSymbolicLink());
  assert.equal(file.uid, process.getuid?.()); assert.equal(file.mode & 0o022, 0); assert.equal(await realpath(binding), binding);
  const require = createRequire(import.meta.url), executable: unknown = require("electron");
  assert.ok(typeof executable === "string" && isAbsolute(executable));
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-owned-mac-retirement-"))); await chmod(root, 0o700);
  let preserve = false;
  try {
    await mkdir(join(root, "home"), { mode: 0o700 }); await buildMacRetirementFixture(root);
    const code = await new Promise<number | null>((accept, reject) => {
      const environment: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), TMPDIR: root,
        XDG_CONFIG_HOME: join(root, "user-data"), XDG_DATA_HOME: join(root, "user-data"), XDG_CACHE_HOME: join(root, "cache") };
      delete environment["ELECTRON_RUN_AS_NODE"]; delete environment["NODE_OPTIONS"]; delete environment["NODE_PATH"];
      const child = spawn(String(executable), [join(root, "main.mjs"), root, distribution], { env: environment, stdio: "ignore" });
      let hardStop: NodeJS.Timeout | undefined;
      const deadline = setTimeout(() => { child.kill("SIGTERM"); hardStop = setTimeout(() => { child.kill("SIGKILL"); }, 8000); }, 150_000);
      child.once("error", (error) => { clearTimeout(deadline); if (hardStop) clearTimeout(hardStop); reject(error); });
      child.once("exit", (result) => { clearTimeout(deadline); if (hardStop) clearTimeout(hardStop); accept(result); });
    });
    assert.equal(code, 0, "Owned Mac retirement probe failed; no alternate process or permission bypass is permitted.");
    z.strictObject({ stage: z.literal("ready") }).parse(JSON.parse(await readFile(join(root, "startup.json"), "utf8")));
    const result = resultSchema.parse(JSON.parse(await readFile(join(root, "result.json"), "utf8")));
    assert.equal(result.architecture, process.arch);
    assert.equal(result.runtime.electron, z.object({ version: z.string() }).parse(require("electron/package.json")).version);
    assert.deepEqual(result.cases.map((item) => item.name), ["clean-exit", "nonzero-exit", "utility-kill", "delayed-sigterm", "ignored-sigterm", "early-exit", "held-observation"]);
    for (const item of result.cases) {
      if (item.name === "early-exit") { assert.equal(item.admitted, false); assert.equal(item.originalNonceConfirmed, false); assert.equal(item.sameUid, null); assert.equal(item.directParent, null); }
      else { assert.equal(item.admitted, true); assert.equal(item.originalNonceConfirmed, true); assert.equal(item.sameUid, true); assert.equal(item.directParent, true); assert.equal(item.watchAllocations, 1); }
    }
    z.strictObject({ helperExitObserved: z.literal(true), reservedNativeOwners: z.literal(0), rendererCreated: z.literal(false),
      productionFactoriesChanged: z.literal(false), syntheticWorkerKernelQueries: z.literal(0) }).parse(JSON.parse(await readFile(join(root, "lifecycle.json"), "utf8")));
    await retain(root, project);
  } catch (error) {
    preserve = true;
    await writeFile(join(root, "retained.json"), JSON.stringify({ code: "MAC_RETIREMENT_PROBE_FAILED", ownedFixtureRetained: true }), { mode: 0o600 });
    await retain(root, project); throw error;
  } finally { if (!preserve) await rm(root, { recursive: true, force: true }); }
});

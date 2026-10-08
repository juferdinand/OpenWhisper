import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildMacProductionRetirementFixture } from "./owned-macos-production-retirement/build-fixture.js";
import { distributionNames, payloadNames, resultSchema, sourceNames } from "./owned-macos-production-retirement/contracts.js";
import { captureDescriptor, captureNodeExecutable, checkedBytes, freezeInput, sha256 } from "./owned-macos-production-retirement/input.js";
import { retainOriginalCLI, type OriginalClosure } from "./owned-macos-production-retirement/lifetime.js";

const enabled = process.env["OPENWHISPER_OWNED_MAC_PRODUCTION_RETIREMENT_TEST"] === "1";
async function retain(root: string, project: string): Promise<void> {
  const evidence = process.env["OPENWHISPER_MAC_PRODUCTION_RETIREMENT_EVIDENCE"]; if (!evidence) return;
  const inside = relative(join(project, ".local"), evidence);
  assert.ok(isAbsolute(evidence) && !evidence.includes("\0") && inside && !inside.startsWith("..") && !isAbsolute(inside));
  await mkdir(evidence, { recursive: true, mode: 0o700 }); const owner = await lstat(evidence);
  assert.ok(owner.isDirectory() && !owner.isSymbolicLink()); assert.equal(owner.uid, process.getuid?.()); assert.equal(owner.mode & 0o7777, 0o700);
  assert.equal(await realpath(evidence), resolve(evidence));
  for (const name of ["fixture-input.json", ...payloadNames, "startup.json", "checkpoint.json", "cases.json", "result.json", "failure.json", "lifecycle.json", "cli-lifecycle.json", "guard-lifecycle.json", "retained.json"]) {
    try { await cp(join(root, name), join(evidence, name)); }
    catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  await cp(join(project, "dist/native/openwhisper_macos_retirement.node"), join(evidence, "openwhisper_macos_retirement.node"));
  await cp(join(project, "dist/native/macos-retirement-notices"), join(evidence, "notices"), { recursive: true });
  for (const name of sourceNames) { const target = join(evidence, "source", name); await mkdir(dirname(target), { recursive: true }); await cp(join(project, name), target); }
  for (const name of distributionNames) { const target = join(evidence, "distribution", name); await mkdir(dirname(target), { recursive: true }); await cp(join(project, "dist", name), target); }
}

test("owned Mac production role verifies actual guards original-child identity and full retirement without audio", { skip: !enabled, timeout: 180_000 }, async () => {
  assert.equal(process.platform, "darwin"); assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.notEqual(process.getuid?.(), 0);
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Capture both trusted build and ordinary Node identities before the bundle
  // and Electron launch. No runtime mismatch refreshes these expectations.
  const descriptor = await captureDescriptor(project), node = await captureNodeExecutable();
  const require = createRequire(import.meta.url), executable: unknown = require("electron");
  assert.ok(typeof executable === "string" && isAbsolute(executable));
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-owned-mac-production-retirement-"))); await chmod(root, 0o700);
  let preserve = false;
  let cli: OriginalClosure<number | null> | undefined;
  const retainCLI = async (): Promise<void> => { if (cli) await writeFile(join(root, "cli-lifecycle.json"),
    JSON.stringify({ ...cli.state, genericCloseIsKernelRetirementProof: false }), { mode: 0o600 }); };
  try {
    await mkdir(join(root, "home"), { mode: 0o700 }); const sources = await buildMacProductionRetirementFixture(root);
    const input = await freezeInput(project, root, descriptor, node), inputBytes = Buffer.from(JSON.stringify(input));
    assert.deepEqual(input.sourceHashes, sources);
    await writeFile(join(root, "fixture-input.json"), inputBytes, { flag: "wx", mode: 0o600 }); const inputHash = sha256(inputBytes);
    const environment: NodeJS.ProcessEnv = { HOME: join(root, "home"), TMPDIR: root, XDG_CONFIG_HOME: join(root, "user-data"),
        XDG_DATA_HOME: join(root, "user-data"), XDG_CACHE_HOME: join(root, "cache"), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8",
        GITHUB_ACTIONS: "true", OPENWHISPER_OWNED_MAC_PRODUCTION_RETIREMENT_TEST: "1" };
    const until = performance.now() + 150_000;
    const child = spawn(String(executable), [join(root, "main.mjs"), root, join(project, "dist"), inputHash], { env: environment, stdio: "ignore" });
    cli = retainOriginalCLI({ onError(listener) { child.on("error", listener); }, onClose(listener) { child.once("close", listener); },
      signal(kind) { child.kill(kind); } }, until);
    const code = await cli.accepted(); await retainCLI();
    assert.equal(code, 0, "Owned production retirement fixture failed; no native guard or loading bypass is permitted.");
    z.strictObject({ stage: z.literal("ready") }).parse(JSON.parse((await checkedBytes(join(root, "startup.json"))).toString("utf8")));
    const result = resultSchema.parse(JSON.parse((await checkedBytes(join(root, "result.json"))).toString("utf8")));
    assert.equal(result.architecture, process.arch); assert.equal(result.inputSha256, inputHash); assert.equal(result.bindingSha256, descriptor.bindingSha256);
    assert.equal(result.runtime.electron, z.object({ version: z.string() }).parse(require("electron/package.json")).version);
    z.strictObject({ helperExitObserved: z.literal(true), originalFullReapConfirmed: z.literal(true), closeReadReceiptsConfirmed: z.literal(true),
      guardWorkerExitObserved: z.literal(true), guardNodeCloseObserved: z.literal(true), allCasesCompleted: z.literal(true),
      nativeOwnersCreated: z.literal(5), utilityChildrenCreated: z.literal(5), genericMainExitIsRetirementProof: z.literal(false),
      productionFactoryWired: z.literal(false) }).parse(JSON.parse((await checkedBytes(join(root, "lifecycle.json"))).toString("utf8")));
    await retain(root, project); cli.assertAcceptedClosure();
  } catch (error: unknown) {
    preserve = true; await writeFile(join(root, "retained.json"), JSON.stringify({ code: "PRODUCTION_RETIREMENT_FAILED", ownedFixtureRetained: true }), { mode: 0o600 });
    await retainCLI(); await retain(root, project); throw error;
  } finally { if (!preserve) await rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { z } from "zod";
import { buildMacCaptureProbe } from "./owned-macos-capture/build-probe.js";
import { resultSchema } from "./owned-macos-capture/contracts.js";

const enabled = process.env["OPENWHISPER_OWNED_MAC_CAPTURE_TEST"] === "1";
async function retainMetadata(directory: string, project: string, binding: string): Promise<void> {
  const evidence = process.env["OPENWHISPER_MAC_CAPTURE_EVIDENCE"];
  if (!evidence) return;
  const inside = relative(join(project, ".local"), evidence);
  assert.ok(isAbsolute(evidence) && !evidence.includes("\0") && inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside));
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const owner = await lstat(evidence); assert.ok(owner.isDirectory() && !owner.isSymbolicLink());
  assert.equal(owner.uid, process.getuid?.()); assert.equal(owner.mode & 0o7777, 0o700);
  assert.equal(await realpath(evidence), resolve(evidence));
  for (const name of ["result.json", "failure.json", "lifecycle.json", "phases.json", "retained.json"]) {
    try { await cp(join(directory, name), join(evidence, name)); }
    catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  await cp(join(project, "dist/native/macos-capture-notices/build-manifest.json"), join(evidence, "build-manifest.json"));
  const require = createRequire(import.meta.url);
  const hashes: Record<string, string> = {};
  for (const name of ["src/workers/native-macos-capture.ts", "tests/owned-macos-capture.test.ts", "tests/owned-macos-capture/contracts.ts",
    "tests/owned-macos-capture/build-probe.ts", "tests/owned-macos-capture/main.ts", "tests/owned-macos-capture/entry.ts", "tests/owned-macos-capture/probe.ts",
    "dist/workers/native-macos-capture.js", "dist/workers/native-capture.js"]) {
    hashes[name] = createHash("sha256").update(await readFile(join(project, name))).digest("hex");
  }
  await writeFile(join(evidence, "run-manifest.json"), JSON.stringify({ bindingSha256: createHash("sha256").update(await readFile(binding)).digest("hex"),
    electronVersion: z.object({ version: z.string() }).parse(require("electron/package.json")).version,
    architecture: process.arch, uid: process.getuid?.(), sourceHashes: hashes,
    scope: "Owned GitHub Apple VM; actual Electron utility/native PCM/converter, generated duration, no physical audio or permission acceptance." }, null, 2), { mode: 0o600 });
}
test("Apple capture utility preserves synthetic full streams, final tails, fences and failure ownership without devices", {
  skip: !enabled, timeout: 180_000,
}, async () => {
  assert.equal(process.platform, "darwin"); assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.notEqual(process.getuid?.(), 0);
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const binding = join(project, "dist/native/openwhisper_macos_capture.node");
  const source = await lstat(binding); assert.ok(source.isFile() && !source.isSymbolicLink());
  const require = createRequire(import.meta.url), electron: unknown = require("electron");
  assert.equal(typeof electron, "string"); assert.ok(typeof electron === "string" && isAbsolute(electron));
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-owned-mac-pcm-"))); await chmod(root, 0o700);
  let preserve = false;
  try {
    await mkdir(join(root, "home"), { mode: 0o700 });
    await buildMacCaptureProbe(root);
    const code = await new Promise<number | null>((accept, reject) => {
      const environment: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "user-data"),
        XDG_DATA_HOME: join(root, "user-data"), XDG_CACHE_HOME: join(root, "cache"), TMPDIR: root };
      delete environment["ELECTRON_RUN_AS_NODE"]; delete environment["NODE_OPTIONS"]; delete environment["NODE_PATH"];
      const child = spawn(String(electron), [join(root, "main.mjs"), root, join(root, "entry.mjs"), binding], { env: environment, stdio: "ignore", detached: true });
      const kill = (signal: "SIGTERM" | "SIGKILL"): void => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      };
      let hardStop: NodeJS.Timeout | undefined;
      const deadline = setTimeout(() => { kill("SIGTERM"); hardStop = setTimeout(() => { kill("SIGKILL"); }, 8000); }, 150_000);
      child.once("error", (error) => { clearTimeout(deadline); if (hardStop) clearTimeout(hardStop); reject(error); });
      child.once("exit", (exit) => { clearTimeout(deadline); if (hardStop) clearTimeout(hardStop); kill("SIGKILL"); accept(exit); });
    });
    assert.equal(code, 0, "Owned synthetic Apple utility failed; no microphone fallback is permitted.");
    const result = resultSchema.parse(JSON.parse(await readFile(join(root, "result.json"), "utf8")));
    assert.equal(result.architecture, process.arch);
    assert.deepEqual(result.cases.map((item) => item.name), ["identity-tail", "format-transition", "long-ledger", "held-callback", "cancel-race",
      "allocation-failure", "interruption", "start-rollback", "exceptions"]);
    z.strictObject({ resultSeen: z.literal(true), helperExitObserved: z.literal(true), actualOSRetirementVerified: z.literal(false),
      mainLoadedCapture: z.literal(false), loadedInventoryVerified: z.literal(true),
      rendererCreated: z.literal(false), realCaptureSelected: z.literal(false) }).parse(JSON.parse(await readFile(join(root, "lifecycle.json"), "utf8")));
    await retainMetadata(root, project, binding);
  } catch (error) {
    // Keep only owned fixture artifacts for categorical diagnostics, never raw audio.
    preserve = true;
    await writeFile(join(root, "retained.json"), JSON.stringify({ code: "SYNTHETIC_CAPTURE_FAILED", ownedFixtureRetained: true }), { mode: 0o600 });
    await retainMetadata(root, project, binding);
    throw error;
  } finally { if (!preserve) await rm(root, { recursive: true, force: true }); }
});

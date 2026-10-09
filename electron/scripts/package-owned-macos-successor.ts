import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseApplicationBuildModule } from "../src/contracts/build-identity.js";
import { packageMacPreview } from "./package-macos-preview.js";

function canonical(value: string): string {
  assert.ok(value.startsWith("/") && resolve(value) === value && !/[\u0000-\u001f\u007f]/u.test(value)); return value;
}
const args = process.argv.slice(2); assert.equal(args.length, 4); assert.equal(args[0], "--source"); assert.equal(args[2], "--output");
assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.equal(process.env["RUNNER_ENVIRONMENT"], "github-hosted");
assert.equal(process.env["OPENWHISPER_OWNED_MAC_PUBLISHER"], "1");
const runnerTemp = canonical(process.env["RUNNER_TEMP"] ?? ""), source = canonical(args[1] ?? ""), output = canonical(args[3] ?? "");
assert.ok(source.startsWith(`${runnerTemp}/`) && output.startsWith(`${runnerTemp}/`));
await lstat(output).then(() => { throw new Error("Successor package output must be fresh."); }, (error: unknown) => {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
});
const run = (command: string, argv: readonly string[]): string => {
  const result = spawnSync(command, [...argv], { cwd: source, encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal !== null || result.status !== 0) throw new Error(`Successor package source check failed: ${command}.`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};
const producer = JSON.parse(await readFile(join(source, "electron/dist/resources/development-build.json"), "utf8")) as unknown;
const sourceInfo = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) }).parse(producer);
assert.equal(run("/usr/bin/git", ["status", "--porcelain"]), "");
const identity = parseApplicationBuildModule(await readFile(join(source, "electron/dist/main/application-build.js"), "utf8"));
assert.deepEqual(identity, { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" });
assert.equal((await readFile(join(source, "VERSION"), "utf8")).trim(), "0.3.1");
assert.equal(run("/usr/bin/git", ["rev-parse", "HEAD"]).trim(), sourceInfo.commit);
assert.equal(run("/usr/bin/git", ["rev-parse", `${sourceInfo.commit}^`]).trim(), process.env["GITHUB_SHA"]);
assert.deepEqual(run("/usr/bin/git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sourceInfo.commit]).trim().split("\n").sort(),
  ["VERSION", "electron/package-lock.json", "electron/package.json"]);
const result = await packageMacPreview(output, join(source, "electron"), { signingMode: "persistent-validation", enableUpdates: true });
await writeFile(join(output, "successor-package-result.json"), `${JSON.stringify({ status: "PASS", sourceCommit: sourceInfo.commit,
  version: "0.3.1", directory: result.directory, archive: result.archive, sha256: result.sha256,
  signingMode: "persistent-validation", updateConfigured: true, scope: "Private signed same-source successor package; no publication." })}\n`,
  { flag: "wx", mode: 0o600 });
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write("PASS: private Mac successor package signed.\n");

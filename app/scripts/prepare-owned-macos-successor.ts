import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const digest = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
function run(command: string, args: readonly string[], cwd = root, timeout = 15_000, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, [...args], { cwd, env, encoding: "utf8", shell: false, timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0 || result.signal !== null) throw new Error(`Owned successor command failed: ${command}.`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
function canonical(path: string): string {
  assert.ok(path.startsWith("/") && resolve(path) === path && !/[\u0000-\u001f\u007f]/u.test(path)); return path;
}
const output = canonical(process.argv[process.argv.indexOf("--output") + 1] ?? "");
assert.equal(process.argv.length, 4); assert.equal(process.argv[2], "--output");
assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
assert.equal(process.env["OPENWHISPER_OWNED_MAC_SUCCESSOR"], "1");
assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.equal(process.env["RUNNER_ENVIRONMENT"], "github-hosted");
const runnerTemp = canonical(process.env["RUNNER_TEMP"] ?? "");
assert.ok(output.startsWith(`${runnerTemp}/`));
const workspace = canonical(process.env["GITHUB_WORKSPACE"] ?? ""); assert.equal(resolve(root, ".."), workspace);
await mkdir(output, { mode: 0o700 }); assert.equal(await (await lstat(output)).isSymbolicLink(), false);
const original = run("/usr/bin/git", ["rev-parse", "HEAD"]).trim();
assert.match(original, /^[a-f0-9]{40}$/u); assert.equal(original, process.env["GITHUB_SHA"]);
assert.equal(run("/usr/bin/git", ["status", "--porcelain"]), "");
const current = (await readFile(resolve(root, "../VERSION"), "utf8")).trim();
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u).parse(current);
const fields = version.split(".").map(Number); const successor = `${fields[0]}.${fields[1]}.${fields[2]! + 1}`;
assert.equal(version, "0.3.1"); assert.equal(successor, "0.3.2");

const nativePaths = ["native/macos-capture/build/arm64/openwhisper_macos_capture.node",
  "native/macos-retirement/build-production/arm64/openwhisper_macos_retirement.node", "native/build-cpu/openwhisper_speech.node"];
const nativeBefore = await Promise.all(nativePaths.map(async (path) => ({ path, sha256: await digest(resolve(root, path)) })));
const nativeReceiptPaths = ["native/macos-capture/build/arm64/build-manifest.json",
  "native/macos-retirement/build-production/arm64/build-manifest.json", "native/build-cpu/build-manifest.json"];
const nativeReceiptsBefore = await Promise.all(nativeReceiptPaths.map(async (path) => ({ path,
  sha256: await digest(resolve(root, path)) })));
const compileBefore = await Promise.all(["native/macos-capture/build/arm64/compile_commands.json",
  "native/macos-retirement/build-production/arm64/compile_commands.json"]
  .map(async (path) => ({ path, sha256: await digest(resolve(root, path)) })));
try {
  await writeFile(resolve(root, "../VERSION"), `${successor}\n`);
  const packagePath = resolve(root, "package.json"), packageJson = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
  packageJson["version"] = successor; await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const lockPath = resolve(root, "package-lock.json"), lock = JSON.parse(await readFile(lockPath, "utf8")) as { version: string; packages: Record<string, { version?: string }> };
  lock.version = successor; const rootPackage = lock.packages[""];
  assert.ok(rootPackage); rootPackage.version = successor; await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  run("/usr/bin/git", ["add", "VERSION", "app/package.json", "app/package-lock.json"], resolve(root, ".."));
  run("/usr/bin/git", ["-c", "user.name=OpenWhisper CI", "-c", "user.email=ci@users.noreply.github.com",
    "commit", "--no-gpg-sign", "-m", `Owned macOS successor package ${successor}`], resolve(root, ".."));
  const childCommit = run("/usr/bin/git", ["rev-parse", "HEAD"]).trim(); assert.match(childCommit, /^[a-f0-9]{40}$/u);
  assert.equal(run("/usr/bin/git", ["rev-parse", `${childCommit}^`]).trim(), original);
  const changedFiles = run("/usr/bin/git", ["diff-tree", "--no-commit-id", "--name-only", "-r", childCommit]).trim().split("\n").sort();
  assert.deepEqual(changedFiles, ["VERSION", "app/package-lock.json", "app/package.json"]);
  assert.equal(run("/usr/bin/git", ["show", `${childCommit}^:VERSION`]).trim(), version);
  assert.equal(run("/usr/bin/git", ["show", `${childCommit}:VERSION`]).trim(), successor);
  assert.equal(run("/usr/bin/git", ["status", "--porcelain"]), "");
  const buildEnv = { ...process.env, OPENWHISPER_CAPTURE_NATIVE_BUILD_LOG: "1" };
  const buildLog = run("npm", ["run", "build", "--", "--recording", "--stable"], root, 180_000, buildEnv);
  await writeFile(join(output, "native-build.log"), buildLog, { flag: "wx", mode: 0o600 });
  assert.ok((buildLog.match(/ninja: no work to do\./giu) ?? []).length >= 2, "Both native CMake builds must report no compilation.");
  const nativeAfter = await Promise.all(nativePaths.map(async (path) => ({ path, sha256: await digest(resolve(root, path)) })));
  const nativeReceiptsAfter = await Promise.all(nativeReceiptPaths.map(async (path) => ({ path,
    sha256: await digest(resolve(root, path)) })));
  const compileAfter = await Promise.all(["native/macos-capture/build/arm64/compile_commands.json",
    "native/macos-retirement/build-production/arm64/compile_commands.json"]
    .map(async (path) => ({ path, sha256: await digest(resolve(root, path)) })));
  assert.deepEqual(nativeAfter, nativeBefore); assert.deepEqual(nativeReceiptsAfter, nativeReceiptsBefore); assert.deepEqual(compileAfter, compileBefore);
  const packageOutput = join(output, "package");
  const packageResultText = run(process.execPath, ["--import", "tsx", "scripts/package-macos-preview.ts", "--output", packageOutput], root, 180_000);
  const packageResult = JSON.parse(packageResultText) as unknown;
  z.object({ directory: z.literal(join(packageOutput, "OpenWhisper.app")), archive: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).parse(packageResult);
  await writeFile(join(output, "package-result.json"), `${JSON.stringify(packageResult)}\n`, { flag: "wx", mode: 0o600 });
  run("/usr/bin/git", ["bundle", "create", join(output, "successor.bundle"), "HEAD"], resolve(root, ".."));
  await writeFile(join(output, "successor-source.json"), `${JSON.stringify({ status: "PASS", originalCommit: original,
    parentCommit: original, changedFiles, successorCommit: childCommit, originalVersion: version, successorVersion: successor, nativeBefore, nativeAfter,
    nativeReceiptsBefore, nativeReceiptsAfter,
    compileCommandsBefore: compileBefore, compileCommandsAfter: compileAfter,
    scope: "Private same-source version child built from the same checkout path; cached native artifacts and compile commands unchanged; no release." })}\n`, { flag: "wx", mode: 0o600 });
} finally {
  run("/usr/bin/git", ["reset", "--hard", original]);
  assert.equal(run("/usr/bin/git", ["rev-parse", "HEAD"]).trim(), original);
  assert.equal(run("/usr/bin/git", ["status", "--porcelain"]), "");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write("PASS: private owned macOS successor package captured.\n");

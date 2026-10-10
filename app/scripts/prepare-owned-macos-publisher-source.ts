import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseApplicationBuildModule } from "../src/contracts/application/build-identity.js";

function canonical(path: string): string { assert.ok(path.startsWith("/") && resolve(path) === path && !/[\u0000-\u001f\u007f]/u.test(path)); return path; }
const args = process.argv.slice(2); assert.equal(args.length, 4); assert.equal(args[0], "--artifact"); assert.equal(args[2], "--output");
assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.equal(process.env["RUNNER_ENVIRONMENT"], "github-hosted");
assert.equal(process.env["OPENWHISPER_OWNED_MAC_PUBLISHER"], "1");
const workspace = canonical(process.env["GITHUB_WORKSPACE"] ?? ""), runnerTemp = canonical(process.env["RUNNER_TEMP"] ?? "");
const artifact = canonical(args[1] ?? ""), output = canonical(args[3] ?? "");
assert.ok(artifact.startsWith(`${runnerTemp}/`) && output.startsWith(`${runnerTemp}/`));
assert.equal(resolve(workspace, "app"), resolve(fileURLToPath(new URL("..", import.meta.url))));
const run = (command: string, argv: readonly string[], cwd: string): string => {
  const result = spawnSync(command, [...argv], { cwd, encoding: "utf8", shell: false, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.signal !== null || result.status !== 0) throw new Error(`Private Mac source reconstruction failed: ${command}.`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
};
assert.equal(run("/usr/bin/git", ["rev-parse", "HEAD"], workspace).trim(), process.env["GITHUB_SHA"]);
assert.equal(run("/usr/bin/git", ["status", "--porcelain"], workspace), "");
await mkdir(output, { mode: 0o700 }); assert.equal((await lstat(output)).isSymbolicLink(), false);
const packets: string[] = [];
for (const path of [artifact, join(artifact, "openwhisper-mac-successor")]) {
  const listing = await readdir(path, { encoding: "utf8" }).catch((error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && error.code === "ENOENT"); return [];
  });
  if (listing.some((name) => name.toString() === "successor-source.json") && listing.some((name) => name.toString() === "successor.bundle")) packets.push(path);
}
assert.equal(packets.length, 1); const packet = packets[0]!;
const listing = await readdir(packet, { encoding: "utf8" }), packageFiles = await readdir(join(packet, "package"), { encoding: "utf8" }).catch((error: unknown) => {
  assert.ok(error instanceof Error && "code" in error && error.code === "ENOENT"); return [];
});
const archives = [...listing.filter((name) => name.endsWith(".zip")), ...packageFiles.filter((name) => name.endsWith(".zip"))];
assert.equal(archives.length, 1); assert.equal(listing.filter((name) => name.endsWith(".bundle")).length, 1);
const sourceReceipt = z.object({ status: z.literal("PASS"), originalCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  parentCommit: z.string().regex(/^[a-f0-9]{40}$/u), changedFiles: z.array(z.string()),
  successorCommit: z.string().regex(/^[a-f0-9]{40}$/u), originalVersion: z.literal("0.3.1"), successorVersion: z.literal("0.3.2") })
  .parse(JSON.parse(await readFile(join(packet, "successor-source.json"), "utf8")) as unknown);
assert.equal(sourceReceipt.originalCommit, process.env["GITHUB_SHA"]);
assert.equal(sourceReceipt.parentCommit, process.env["GITHUB_SHA"]);
assert.deepEqual(sourceReceipt.changedFiles, ["VERSION", "app/package-lock.json", "app/package.json"]);
const packageReceipt = z.object({ directory: z.string(), archive: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .parse(JSON.parse(await readFile(join(packet, "package-result.json"), "utf8")) as unknown);
const archive = join(packageFiles.some((name) => name.toString() === archives[0]) ? join(packet, "package") : packet, archives[0]!);
assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), packageReceipt.sha256);
const bundle = join(packet, "successor.bundle");
run("/usr/bin/git", ["fetch", bundle, "HEAD"], workspace);
assert.equal(run("/usr/bin/git", ["cat-file", "-t", sourceReceipt.successorCommit], workspace).trim(), "commit");
assert.equal(run("/usr/bin/git", ["rev-parse", `${sourceReceipt.successorCommit}^`], workspace).trim(), process.env["GITHUB_SHA"]);
const changedFiles = run("/usr/bin/git", ["diff-tree", "--no-commit-id", "--name-only", "-r", sourceReceipt.successorCommit], workspace).trim().split("\n").sort();
assert.deepEqual(changedFiles, ["VERSION", "app/package-lock.json", "app/package.json"]);
assert.equal(run("/usr/bin/git", ["show", `${sourceReceipt.successorCommit}^:VERSION`], workspace).trim(), "0.3.1");
assert.equal(run("/usr/bin/git", ["show", `${sourceReceipt.successorCommit}:VERSION`], workspace).trim(), "0.3.2");
const source = join(output, "source");
run("/usr/bin/git", ["worktree", "add", "--detach", source, sourceReceipt.successorCommit], workspace);
try {
  const extracted = join(output, "extracted"); await mkdir(extracted, { mode: 0o700 });
  run("/usr/bin/ditto", ["-x", "-k", archive, extracted], workspace);
  const bundleApp = join(extracted, "OpenWhisper.app"), appRoot = join(bundleApp, "Contents/Resources/app");
  const build = parseApplicationBuildModule(await readFile(join(appRoot, "dist/main/application-build.js"), "utf8"));
  assert.deepEqual(build, { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" });
  const producer = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) })
    .parse(JSON.parse(await readFile(join(appRoot, "dist/resources/development-build.json"), "utf8")) as unknown);
  assert.equal(producer.commit, sourceReceipt.successorCommit);
  assert.equal((await readFile(join(appRoot, "dist/resources/VERSION"), "utf8")).trim(), "0.3.2");
  await cp(join(appRoot, "dist"), join(source, "app/dist"), { recursive: true, force: false, errorOnExist: true });
  const notices = join(bundleApp, "Contents/Resources/notices");
  const cpuManifest = await readFile(join(notices, "speech-cpu-unsigned-build.json"));
  const whisperLicense = await readFile(join(notices, "whisper.cpp-LICENSE"));
  const cpuManifestPath = join(source, "app/native/build-cpu/build-manifest.json");
  const whisperLicensePath = join(source, "app/vendor/whisper.cpp/LICENSE");
  await mkdir(dirname(cpuManifestPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(whisperLicensePath), { recursive: true, mode: 0o700 });
  await writeFile(cpuManifestPath, cpuManifest, { flag: "wx", mode: 0o600 });
  await writeFile(whisperLicensePath, whisperLicense, { flag: "wx", mode: 0o600 });
  const aliases: readonly [string, string][] = [["app/node_modules", "app/node_modules"],
    ["app/ui/node_modules", "app/ui/node_modules"]];
  for (const [relativeLink, relativeTarget] of aliases) {
    const link = join(source, relativeLink), target = resolve(workspace, relativeTarget);
    assert.equal((await lstat(target)).isSymbolicLink(), false); await symlink(target, link, "dir");
  }
  assert.equal(run("/usr/bin/git", ["rev-parse", "HEAD"], source).trim(), sourceReceipt.successorCommit);
  assert.equal(run("/usr/bin/git", ["status", "--porcelain"], source), "");
  await writeFile(join(output, "source-path.json"), `${JSON.stringify({ source, successorCommit: sourceReceipt.successorCommit,
    archiveSha256: packageReceipt.sha256, version: "0.3.2", packageType: "same-source private stable validation" })}\n`, { flag: "wx", mode: 0o600 });
} catch (error: unknown) {
  run("/usr/bin/git", ["worktree", "remove", "--force", source], workspace); throw error;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write("PASS: private Mac successor source reconstructed from same-run artifact.\n");

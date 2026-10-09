import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { appImageArtifactName, appImageLauncher, packageLinuxAppImage } from "../../scripts/package-linux-appimage.js";

import { validateOwnedAppImageConstruction } from "../owned-signed-debian.js";

const supported = process.platform === "linux" && process.arch === "x64";

test("canonical AppImage naming refuses Dev or modified producers while previews retain their source suffix", () => {
  const source = { commit: "0123456789abcdef0123456789abcdef01234567", modified: false };
  assert.equal(appImageArtifactName("stable", "0.3.0", source, true), "OpenWhisper-Linux-x86_64.AppImage");
  assert.equal(appImageArtifactName("stable", "0.3.0", source), "OpenWhisper-Linux-x86_64_0.3.0~dev.0123456789ab.AppImage");
  assert.equal(appImageArtifactName("development", "0.3.0", { ...source, modified: true }),
    "OpenWhisper-Dev-Linux-x86_64_0.3.0~dev.0123456789ab.modified.AppImage");
  assert.throws(() => appImageArtifactName("development", "0.3.0", source, true), /CANONICAL_STABLE_REQUIRED/);
  assert.throws(() => appImageArtifactName("stable", "0.3.0", { ...source, modified: true }, true), /CANONICAL_STABLE_REQUIRED/);
  for (const version of ["0.3.0~dev.0123456789ab", "0.3", "0.3.00", "0.3.0/other"]) {
    assert.throws(() => appImageArtifactName("stable", version, source, true), /PACKAGE_VERSION_MISMATCH/);
  }
});
function closed(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
}
async function textWhenPresent(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(path, "utf8"); } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(10);
  }
  throw new Error("Owned fixture observation timed out");
}

test("installed launcher isolates simultaneous extraction lifetimes and forwards literal arguments", { skip: !supported, timeout: 10_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "openwhisper-appimage-launch-"));
  let primary: ChildProcess | undefined;
  try {
    const launcher = join(base, "launcher"), image = join(base, "Image with spaces.AppImage"), temporary = join(base, "temporary");
    await mkdir(temporary); await writeFile(launcher, appImageLauncher(), { mode: 0o755 });
    await writeFile(image, ["#!/bin/sh", "set -eu", 'test "$APPIMAGE_EXTRACT_AND_RUN" = 1',
      'test "${NO_CLEANUP+x}${TARGET_APPIMAGE+x}${APPIMAGE+x}${APPDIR+x}" = ""',
      'mkdir "$TMPDIR/resources"', 'printf "%s\\n" "$TMPDIR" "$3" > "$1"',
      'while test ! -f "$2"; do sleep 0.01; done', 'rmdir "$TMPDIR/resources"', ""].join("\n"), { mode: 0o755 });
    const literal = 'literal $value; "quoted" %field', first = join(base, "first"), releaseFirst = join(base, "release-first");
    const env = { ...process.env, TMPDIR: temporary, NO_CLEANUP: "0", TARGET_APPIMAGE: "unsafe", APPIMAGE: "unsafe", APPDIR: "unsafe" };
    primary = spawn(launcher, [image, first, releaseFirst, literal], { env, stdio: "ignore" }); const primaryClose = closed(primary);
    const [firstTmp, firstArgument] = (await textWhenPresent(first)).trimEnd().split("\n"); assert.equal(firstArgument, literal);
    assert.ok(firstTmp); assert.equal((await lstat(firstTmp)).mode & 0o777, 0o700);
    const second = join(base, "second"), releaseSecond = join(base, "release-second"); await writeFile(releaseSecond, "release");
    const secondary = spawn(launcher, [image, second, releaseSecond, literal], { env, stdio: "ignore" });
    assert.deepEqual(await closed(secondary), { code: 0, signal: null });
    const [secondTmp, secondArgument] = (await readFile(second, "utf8")).trimEnd().split("\n");
    assert.equal(secondArgument, literal); assert.notEqual(firstTmp, secondTmp); assert.ok(secondTmp);
    await assert.rejects(lstat(secondTmp), { code: "ENOENT" });
    assert.equal((await lstat(join(firstTmp, "resources"))).isDirectory(), true);
    await writeFile(releaseFirst, "release"); assert.deepEqual(await primaryClose, { code: 0, signal: null });
    await assert.rejects(lstat(firstTmp), { code: "ENOENT" }); primary = undefined;
  } finally { primary?.kill("SIGTERM"); await rm(base, { recursive: true, force: true }); }
});

test("installed launcher rejects relative and absent images before allocating extraction state", { skip: !supported, timeout: 5_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "openwhisper-appimage-refusal-"));
  try {
    const launcher = join(base, "launcher"); await writeFile(launcher, appImageLauncher(), { mode: 0o755 });
    for (const image of ["relative.AppImage", join(base, "missing.AppImage")]) {
      const child = spawn(launcher, [image], { env: { ...process.env, TMPDIR: base }, stdio: "ignore" });
      assert.deepEqual(await closed(child), { code: 64, signal: null });
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("AppImage packager refuses overlap and unpinned tools before creating output or executing inputs", { skip: !supported }, async () => {
  const base = await mkdtemp(join(tmpdir(), "openwhisper-appimage-pins-"));
  try {
    const directory = join(base, "package"), tools = join(base, "tools"), output = join(base, "output");
    await mkdir(directory); await mkdir(tools);
    await assert.rejects(packageLinuxAppImage({ directory, tools, output: join(directory, "output") }), /UNSAFE_PACKAGE_OUTPUT/);
    await writeFile(join(tools, "appimagetool-x86_64.AppImage"), "Inert altered tool; never executed", { mode: 0o755 });
    await assert.rejects(packageLinuxAppImage({ directory, tools, output }), /APPIMAGE_TOOL_PIN_MISMATCH/);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  } finally { await rm(base, { recursive: true, force: true }); }
});


function constructionFixture() {
  const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
  const source = { commit: "0123456789abcdef0123456789abcdef01234567", modified: false as const }, sourceVersion = "0.3.0";
  const sourceInventory = { resources: { type: "directory", mode: 0o755, bytes: 0, sha256: digest("") },
    "resources/app.js": { type: "file", mode: 0o644, bytes: 1, sha256: digest("x") } };
  const image = { bytes: 10, sha256: digest("inert image") }, launcher = { bytes: Buffer.byteLength(appImageLauncher()), sha256: digest(appImageLauncher()) };
  const inventory = { files: { "OpenWhisper-Linux-x64/resources/app.js": { bytes: 1, sha256: digest("x") },
    "appimage/OpenWhisper-Linux-x86_64.AppImage": image, "appimage/openwhisper-launch": launcher },
    modes: { "OpenWhisper-Linux-x64": 0o755, "OpenWhisper-Linux-x64/resources": 0o755,
      "OpenWhisper-Linux-x64/resources/app.js": 0o644, "appimage/OpenWhisper-Linux-x86_64.AppImage": 0o755, "appimage/openwhisper-launch": 0o755 } };
  const tools = { appimagetool: "synthetic fixed pin", runtime: "synthetic fixed pin" };
  const receipt = { classification: "UNSIGNED_CONSTRUCTION_ONLY", applicationProducer: source, version: sourceVersion,
    buildIdentity: { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" },
    canonicalStableValidation: true, sourceDirectory: "/producer/OpenWhisper-Linux-x64", sourceInventory,
    image: { path: "/producer/appimage/OpenWhisper-Linux-x86_64.AppImage", ...image },
    launcher: { path: "/producer/appimage/openwhisper-launch", sha256: launcher.sha256 }, tools,
    runtimeDigestMd5Only: true, passiveExtractionMatches: true, originalInputUnchanged: true,
    runtimeAcceptance: false, updateAuthority: false, publicDistributionAuthorized: false };
  return { receipt, expected: { source, sourceVersion, inventory }, tools };
}

test("Owned canonical AppImage receipt binds source, exact payload and tool pins without claiming signature or runtime", () => {
  const f = constructionFixture(); validateOwnedAppImageConstruction(f.receipt, f.expected, f.tools);
  for (const changed of [
    { ...f.receipt, applicationProducer: { ...f.receipt.applicationProducer, modified: true } },
    { ...f.receipt, applicationProducer: { ...f.receipt.applicationProducer, commit: "f".repeat(40) } },
    { ...f.receipt, version: "0.2.5" }, { ...f.receipt, canonicalStableValidation: false },
    { ...f.receipt, buildIdentity: { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" } },
    { ...f.receipt, passiveExtractionMatches: false }, { ...f.receipt, originalInputUnchanged: false },
    { ...f.receipt, runtimeAcceptance: true }, { ...f.receipt, updateAuthority: true }, { ...f.receipt, publicDistributionAuthorized: true },
    { ...f.receipt, tools: { ...f.tools, runtime: "changed" } },
    { ...f.receipt, image: { ...f.receipt.image, path: "/producer/Preview.AppImage" } },
    { ...f.receipt, image: { ...f.receipt.image, sha256: "f".repeat(64) } },
    { ...f.receipt, sourceInventory: { ...f.receipt.sourceInventory, foreign: f.receipt.sourceInventory.resources } },
    { ...f.receipt, sourceInventory: { resources: f.receipt.sourceInventory.resources } },
  ]) assert.throws(() => validateOwnedAppImageConstruction(changed, f.expected, f.tools));
  for (const change of ["digest", "mode", "type"] as const) {
    const receipt = structuredClone(f.receipt);
    if (change === "digest") receipt.sourceInventory["resources/app.js"].sha256 = "f".repeat(64);
    if (change === "mode") receipt.sourceInventory["resources/app.js"].mode = 0o600;
    if (change === "type") receipt.sourceInventory["resources/app.js"].type = "directory";
    assert.throws(() => validateOwnedAppImageConstruction(receipt, f.expected, f.tools));
  }
});

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { appImageLauncher, packageLinuxAppImage } from "../scripts/package-linux-appimage.js";

const supported = process.platform === "linux" && process.arch === "x64";
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

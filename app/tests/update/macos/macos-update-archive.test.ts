import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupMacUpdateArchiveDownload, MacosUpdateArchiveError, validateMacUpdateBundleFiles } from "../../../src/services/update/macos/macos-update-archive.js";
import { retainOwnedUpdateDownload } from "../../../src/services/update/common/update-staging.js";

const invalid = (error: unknown): boolean => error instanceof MacosUpdateArchiveError && error.code === "INVALID_BUNDLE";
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-archive-")));
  const bundle = join(root, "OpenWhisper.app"), resources = join(bundle, "Contents/Resources");
  await mkdir(resources, { recursive: true, mode: 0o700 });
  await writeFile(join(resources, "payload"), "owned fixture", { mode: 0o600 });
  return { root, bundle, resources };
}
test("Mac bundle file inspection preserves internal framework directory and file links", async () => {
  const f = await fixture();
  try {
    const framework = join(f.bundle, "Contents/Frameworks/Owned.framework");
    await mkdir(join(framework, "Versions/A"), { recursive: true });
    await writeFile(join(framework, "Versions/A/Owned"), "owned code");
    await symlink("A", join(framework, "Versions/Current"));
    await symlink("Versions/Current/Owned", join(framework, "Owned"));
    await symlink("payload", join(f.resources, "link"));
    await validateMacUpdateBundleFiles(f.bundle);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("Mac bundle file inspection refuses outside, dangling and root-loop links", async () => {
  for (const target of ["../../../outside", "missing", "../.."] as const) {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "outside"), "untouched");
      await symlink(target, join(f.resources, "escape"));
      await assert.rejects(validateMacUpdateBundleFiles(f.bundle), invalid);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
test("Mac bundle file inspection refuses a linked app root and a missing app", async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, "Alias.app"); await symlink(f.bundle, alias);
    await assert.rejects(validateMacUpdateBundleFiles(alias), invalid);
    await assert.rejects(validateMacUpdateBundleFiles(join(f.root, "Missing.app")), invalid);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("Mac bundle file inspection requires a canonical absolute app pathname", async () => {
  for (const path of ["relative.app", "/owned/../OpenWhisper.app", "/owned/OpenWhisper.app\0", "/owned/other"]) {
    await assert.rejects(validateMacUpdateBundleFiles(path), (error: unknown) => error instanceof MacosUpdateArchiveError && error.code === "INVALID_INPUT");
  }
});

test("failed extraction cleanup preserves the child and original error while closing the retained ZIP descriptor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-cleanup-")));
  const stage = await mkdtemp(join(root, "stage-")), child = join(stage, "retained-child");
  await mkdir(child, { mode: 0o700 }); await writeFile(join(child, "marker"), "retained owned bytes", { mode: 0o600 });
  const file = await open(join(stage, "OpenWhisper-macOS.zip"), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.write(Buffer.from("owned zip fixture"), 0, 17, 0); await file.sync();
    const download = await retainOwnedUpdateDownload({ file, stageDirectory: stage, artifactName: "OpenWhisper-macOS.zip" });
    const refusal = new MacosUpdateArchiveError("CLEANUP_FAILED", "CHILD_IDENTITY", "FILE_CHANGED");
    await assert.rejects(cleanupMacUpdateArchiveDownload({ cleanup: async () => { throw refusal; } }, download), (error: unknown) => error === refusal);
    await assert.rejects(file.stat(), { code: "EBADF" });
    assert.equal(await readFile(join(child, "marker"), "utf8"), "retained owned bytes");
    assert.ok((await lstat(stage)).isDirectory());
    await assert.rejects(lstat(join(stage, "OpenWhisper-macOS.zip")), { code: "ENOENT" });
  } finally { await file.close(); await rm(root, { recursive: true, force: true }); }
});

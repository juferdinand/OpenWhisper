import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertPrivateUpdateDirectory, inspectOwnedUpdateFile, MAX_UPDATE_STAGE_BYTES, retainOwnedUpdateDownload, UpdateStagingError } from "../src/services/update-staging.js";
import type { OwnedUpdateFileInput } from "../src/services/update-staging.js";

const unixTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const failure = (code: string) => (error: unknown): boolean => error instanceof UpdateStagingError && error.code === code && error.message === code;
async function fixture() {
  // macOS temporary paths can contain OS symlinks; use the owned directory's actual canonical path.
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-update-stage-"))), stageDirectory = join(root, "stage");
  await mkdir(stageDirectory, { mode: 0o700 });
  const artifactName = "OpenWhisper-macOS.zip", path = join(stageDirectory, artifactName);
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await file.write(Buffer.from("owned bytes"), 0, 11, 0); await file.sync();
  const input = { file, stageDirectory, artifactName } satisfies OwnedUpdateFileInput;
  return { root, path, file, input };
}

unixTest("the pre-acquisition private directory guard rejects unsafe ancestry and detects a replaced directory", async () => {
  const f = await fixture();
  try {
    const guard = await assertPrivateUpdateDirectory(f.input.stageDirectory); assert.ok(Object.isFrozen(guard));
    await guard.assertUnchanged();
    const alias = join(f.root, "alias"); await symlink(f.input.stageDirectory, alias);
    await assert.rejects(assertPrivateUpdateDirectory(alias), failure("UNSAFE_STAGING"));
    await chmod(f.root, 0o777);
    await assert.rejects(assertPrivateUpdateDirectory(f.input.stageDirectory), failure("UNSAFE_STAGING"));
    await chmod(f.root, 0o700);
    await rename(f.input.stageDirectory, `${f.input.stageDirectory}-original`); await mkdir(f.input.stageDirectory, { mode: 0o700 });
    await assert.rejects(guard.assertUnchanged(), failure("FILE_CHANGED"));
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});

unixTest("shared staging accepts an original Mac ZIP descriptor without authenticating it and closes once", async () => {
  const f = await fixture(), close = f.file.close.bind(f.file); let closes = 0;
  f.file.close = async () => { closes++; await close(); };
  try {
    const stage = await retainOwnedUpdateDownload(f.input);
    assert.ok(Object.isFrozen(stage)); assert.equal(stage.file, f.file); assert.equal(stage.bytes, 11);
    assert.equal(stage.artifactName, "OpenWhisper-macOS.zip");
    const first = Buffer.alloc(5); await stage.file.read(first, 0, first.length, 0);
    await stage.assertUnchanged();
    const implicit = Buffer.alloc(5); await stage.file.read(implicit, 0, implicit.length, null);
    assert.deepEqual(implicit, first); // Positioned writes and reads preserved initial offset zero.
    await Promise.all([stage.cleanup(), stage.cleanup()]); await stage.cleanup();
    assert.equal(closes, 1); await assert.rejects(lstat(f.input.stageDirectory), { code: "ENOENT" });
    await assert.rejects(stage.assertUnchanged(), failure("READ_FAILED"));
  } finally { if (!closes) await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
unixTest("borrowed observations retain the original caller and detect same-size modification", async () => {
  const f = await fixture();
  try {
    const observed = await inspectOwnedUpdateFile(f.input); assert.ok(Object.isFrozen(observed));
    assert.equal(observed.bytes, 11); await observed.assertUnchanged();
    await f.file.write(Buffer.from("Owned bytes"), 0, 11, 0);
    await assert.rejects(observed.assertUnchanged(), failure("FILE_CHANGED"));
    assert.equal((await f.file.stat()).size, 11); assert.equal(await readFile(f.path, "utf8"), "Owned bytes");
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
unixTest("failed staging admission preserves the acquired descriptor and requires fixed private metadata", async () => {
  const f = await fixture();
  try {
    for (const maximumBytes of [-1, NaN, 0.5, MAX_UPDATE_STAGE_BYTES + 1]) {
      await assert.rejects(retainOwnedUpdateDownload({ ...f.input, maximumBytes }), failure("INVALID_INPUT"));
    }
    await assert.rejects(retainOwnedUpdateDownload({ ...f.input, maximumBytes: 10 }), failure("PAYLOAD_TOO_LARGE"));
    await assert.rejects(retainOwnedUpdateDownload({ ...f.input, artifactName: "../escape" as OwnedUpdateFileInput["artifactName"] }), failure("INVALID_INPUT"));
    const alias = join(f.root, "alias"); await symlink(f.input.stageDirectory, alias);
    await assert.rejects(retainOwnedUpdateDownload({ ...f.input, stageDirectory: alias }), failure("UNSAFE_STAGING"));
    await chmod(f.input.stageDirectory, 0o755);
    await assert.rejects(retainOwnedUpdateDownload(f.input), failure("UNSAFE_STAGING"));
    assert.ok((await f.file.stat()).isFile()); assert.equal(await readFile(f.path, "utf8"), "owned bytes");
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
unixTest("staging observations reject mode changes and new hardlinks", async () => {
  for (const change of ["mode", "link"] as const) {
    const f = await fixture();
    try {
      const observed = await inspectOwnedUpdateFile(f.input);
      if (change === "mode") await chmod(f.path, 0o644); else await link(f.path, join(f.root, "second-link"));
      await assert.rejects(observed.assertUnchanged(), failure("FILE_CHANGED"));
    } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});
unixTest("cleanup closes the original but preserves a replacement artifact and original renamed file", async () => {
  const f = await fixture();
  try {
    const stage = await retainOwnedUpdateDownload(f.input), original = join(f.input.stageDirectory, "original");
    await rename(f.path, original); await writeFile(f.path, "replacement", { mode: 0o600 });
    await assert.rejects(stage.assertUnchanged(), failure("FILE_CHANGED"));
    assert.equal(stage.ownersSettled?.(), false);
    await assert.rejects(stage.cleanup(), failure("CLEANUP_FAILED"));
    assert.equal(stage.ownersSettled?.(), true);
    await assert.rejects(f.file.stat(), { code: "EBADF" });
    assert.equal(await readFile(f.path, "utf8"), "replacement"); assert.equal(await readFile(original, "utf8"), "owned bytes");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
unixTest("cleanup preserves a replaced stage directory", async () => {
  const f = await fixture();
  try {
    const stage = await retainOwnedUpdateDownload(f.input), original = `${f.input.stageDirectory}-original`;
    await rename(f.input.stageDirectory, original); await mkdir(f.input.stageDirectory, { mode: 0o700 });
    await writeFile(f.path, "replacement", { mode: 0o600 });
    await assert.rejects(stage.assertUnchanged(), failure("FILE_CHANGED"));
    await assert.rejects(stage.cleanup(), failure("CLEANUP_FAILED"));
    await assert.rejects(f.file.stat(), { code: "EBADF" });
    assert.equal(await readFile(f.path, "utf8"), "replacement");
    assert.equal(await readFile(join(original, f.input.artifactName), "utf8"), "owned bytes");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
unixTest("an extraction child remains consumer-owned and cleanup can finish after its settled removal", async () => {
  const f = await fixture(), close = f.file.close.bind(f.file); let closes = 0;
  f.file.close = async () => { closes++; await close(); };
  try {
    const stage = await retainOwnedUpdateDownload(f.input), child = join(stage.stageDirectory, "extracted");
    await mkdir(child, { mode: 0o700 }); await writeFile(join(child, "owned"), "consumer output", { mode: 0o600 });
    await stage.assertUnchanged();
    await assert.rejects(stage.cleanup(), failure("CLEANUP_FAILED"));
    assert.equal(closes, 1); assert.equal(await readFile(join(child, "owned"), "utf8"), "consumer output");
    await assert.rejects(lstat(f.path), { code: "ENOENT" });
    await rm(child, { recursive: true }); await stage.cleanup();
    assert.equal(closes, 1); await assert.rejects(lstat(stage.stageDirectory), { code: "ENOENT" });
  } finally { if (!closes) await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
unixTest("failed original closure remains the same obligation and never deletes the staged file", async () => {
  const f = await fixture(), close = f.file.close.bind(f.file); let closes = 0;
  f.file.close = async () => { closes++; throw new Error("PRIVATE CLOSE DETAILS"); };
  try {
    const stage = await retainOwnedUpdateDownload(f.input);
    await assert.rejects(stage.cleanup(), failure("CLEANUP_FAILED")); await assert.rejects(stage.cleanup(), failure("CLEANUP_FAILED"));
    assert.equal(closes, 1); assert.equal(await readFile(f.path, "utf8"), "owned bytes");
    await stage.assertUnchanged(); assert.ok((await f.file.stat()).isFile());
  } finally { await close(); await rm(f.root, { recursive: true, force: true }); }
});

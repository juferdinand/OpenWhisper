import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_USER_TEXT_BYTES } from "../src/contracts/ui.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../src/services/profiles.js";
import { saveDevelopmentTranscript } from "../src/services/development-transcripts.js";

test("complete multilingual output larger than the UI limit remains in one private transcript file", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "openwhisper-transcript-"));
  await chmod(root, 0o700);
  try {
    const profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ home: root }));
    const text = "日本語 Wünsche مرحبا 👩‍💻\n".repeat(Math.ceil(MAX_USER_TEXT_BYTES / 20));
    assert.ok(Buffer.byteLength(text, "utf8") > MAX_USER_TEXT_BYTES);
    await saveDevelopmentTranscript(profile, text);
    const files = await readdir(profile.paths.transcripts);
    assert.equal(files.length, 1); assert.match(files[0]!, /^[a-f0-9-]{36}\.txt$/u);
    const path = join(profile.paths.transcripts, files[0]!);
    assert.equal(await readFile(path, "utf8"), text);
    const stats = await lstat(path); assert.equal(stats.mode & 0o7777, 0o600); assert.equal(stats.nlink, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a replaced transcript directory cannot redirect private output", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "openwhisper-transcript-"));
  await chmod(root, 0o700);
  try {
    const profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ home: root }));
    const outside = join(root, "outside"); await mkdir(outside, { mode: 0o700 });
    await rm(profile.paths.transcripts, { recursive: true }); await symlink(outside, profile.paths.transcripts);
    await assert.rejects(saveDevelopmentTranscript(profile, "Private synthetic text"));
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

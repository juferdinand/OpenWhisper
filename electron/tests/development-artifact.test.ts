import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyDevelopmentCaptureArtifact, verifyDevelopmentCaptureEntry } from "../src/services/development-artifact.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-development-artifact-")));
  const native = join(root, "dist/native/capture/openwhisper_capture.node");
  const entry = join(root, "dist/workers/capture-entry.js");
  await mkdir(join(root, "dist/native/capture"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "dist/workers"), { mode: 0o700 });
  const bytes = Buffer.from("owned development build input");
  await writeFile(native, bytes, { mode: 0o600 }); await writeFile(entry, bytes, { mode: 0o600 });
  return { root, native, entry, expected: { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
}
test("development admission consumes captured bytes and refuses a changed native artifact", async () => {
  const value = await fixture();
  try {
    assert.equal(await verifyDevelopmentCaptureArtifact(value.root, value.expected), value.native);
    assert.equal(await verifyDevelopmentCaptureEntry(value.root, value.expected), value.entry);
    await writeFile(value.native, Buffer.alloc(value.expected.bytes, 42));
    await assert.rejects(verifyDevelopmentCaptureArtifact(value.root, value.expected));
    await assert.rejects(verifyDevelopmentCaptureEntry(value.root, { ...value.expected, bytes: value.expected.bytes - 1 }));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
test("development native destinations refuse aliases hardlinks and writable ancestors", async () => {
  const value = await fixture();
  try {
    await link(value.native, join(value.root, "alias.node"));
    await assert.rejects(verifyDevelopmentCaptureArtifact(value.root, value.expected));
    await rm(join(value.root, "alias.node"));
    await chmod(join(value.root, "dist/native"), 0o777);
    await assert.rejects(verifyDevelopmentCaptureArtifact(value.root, value.expected));
    await chmod(join(value.root, "dist/native"), 0o700);
    await rm(value.native); await symlink(value.entry, value.native);
    await assert.rejects(verifyDevelopmentCaptureArtifact(value.root, value.expected));
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

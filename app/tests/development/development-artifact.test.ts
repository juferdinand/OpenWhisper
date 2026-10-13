import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { trustedAncestor, verifyDevelopmentCaptureArtifact, verifyDevelopmentCaptureEntry } from "../../src/services/development/development-artifact.js";

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
test("development ancestors accept the default macOS Applications folder but not world-writable or foreign directories", () => {
  const directory = (uid: bigint, gid: bigint, mode: bigint) => ({ uid, gid, mode, isDirectory: () => true, isSymbolicLink: () => false });
  const user = 501n;
  // /Applications is root:admin 0775 on a standard macOS installation.
  assert.equal(trustedAncestor(directory(0n, 80n, 0o40775n), user, "darwin"), true);
  assert.equal(trustedAncestor(directory(0n, 80n, 0o40775n), user, "linux"), false);
  assert.equal(trustedAncestor(directory(0n, 80n, 0o40777n), user, "darwin"), false);
  assert.equal(trustedAncestor(directory(0n, 20n, 0o40775n), user, "darwin"), false);
  assert.equal(trustedAncestor(directory(user, 80n, 0o40775n), user, "darwin"), false);
  assert.equal(trustedAncestor(directory(502n, 20n, 0o40755n), user, "darwin"), false);
  assert.equal(trustedAncestor(directory(0n, 0n, 0o41777n), user, "linux"), true);
  assert.equal(trustedAncestor(directory(user, 20n, 0o40755n), user, "linux"), true);
  assert.equal(trustedAncestor({ ...directory(0n, 0n, 0o40755n), isSymbolicLink: () => true }, user, "darwin"), false);
});

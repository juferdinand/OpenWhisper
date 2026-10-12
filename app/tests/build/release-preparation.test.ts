import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareRelease, applyPreparedRelease } from "../../scripts/prepare-release.js";
import { releaseContextFromFiles } from "../../scripts/release-context.js";
import { bumpDevelopmentVersion } from "../../scripts/bump-development-version.js";
import { parsePublicReleaseRecord, verifyPublicReleaseRecovery } from "../../scripts/verify-release-recovery.js";

const versionFiles = (version: string): Record<string, string> => ({
  VERSION: `${version}\n`,
  "app/package.json": JSON.stringify({ name: "openwhisper-electron", version }),
  "app/package-lock.json": JSON.stringify({ version, packages: { "": { version } } }),
  "app/ui/package.json": JSON.stringify({ name: "openwhisper-ui", version }),
  "app/ui/package-lock.json": JSON.stringify({ version, packages: { "": { version } } }),
});
const highlights = { en: ["English authored update"], de: ["Deutsch verfasste Änderung"] };

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-release-preparation-"));
  for (const [path, contents] of Object.entries({ ...versionFiles("0.4.1"),
    "README.md": "# OpenWhisper\n\nThe current release is **0.4.1**, a shared Electron app.\n",
    ".github/release-notes.md": "<!-- Prepared for the gated release workflow; repository status lives in README.md. -->\n\n## What's new in OpenWhisper 0.4.1\n\n- Previous English note\n\n## Neu in OpenWhisper 0.4.1\n\n- Vorherige deutsche Notiz\n\nRecognition runs locally.\n\n## Updating from 0.2.5\n\nHistorical transition to 0.4.1 stays intact.\n",
  })) {
    const pathName = join(root, path); await mkdir(dirname(pathName), { recursive: true }); await writeFile(pathName, contents);
  }
  return root;
}

test("release context validates every version manifest and computes a safe next patch", () => {
  assert.deepEqual(releaseContextFromFiles(versionFiles("0.4.1")), { currentVersion: "0.4.1", successorVersion: "0.4.2" });
  assert.deepEqual(releaseContextFromFiles(versionFiles("1.2.9")), { currentVersion: "1.2.9", successorVersion: "1.2.10" });
  assert.deepEqual(releaseContextFromFiles(versionFiles("1.9.9")), { currentVersion: "1.9.9", successorVersion: "1.9.10" });
  const mismatch = versionFiles("0.4.1"); mismatch["app/ui/package-lock.json"] = JSON.stringify({ version: "0.4.2", packages: { "": { version: "0.4.1" } } });
  assert.throws(() => releaseContextFromFiles(mismatch), /inconsistent/);
  assert.throws(() => releaseContextFromFiles({ ...versionFiles("0.4.1"), VERSION: "01.4.1\n" }), /INVALID_VERSION/);
});

test("release preparation previews, applies, and repeats without changing history", async () => {
  const root = await fixture();
  try {
    const prepared = await prepareRelease(root, "0.4.2", highlights);
    assert.equal(prepared.currentVersion, "0.4.1"); assert.equal(prepared.targetVersion, "0.4.2");
    assert.deepEqual(prepared.changes.map(({ path }) => path.slice(root.length + 1)), [
      "VERSION", "app/package.json", "app/package-lock.json", "app/ui/package.json", "app/ui/package-lock.json", "README.md", ".github/release-notes.md",
    ]);
    assert.match(prepared.notes, /What's new in OpenWhisper 0\.4\.2/);
    assert.match(prepared.notes, /Neu in OpenWhisper 0\.4\.2/);
    await applyPreparedRelease(prepared);
    assert.equal(await readFile(join(root, "VERSION"), "utf8"), "0.4.2\n");
    assert.match(await readFile(join(root, "README.md"), "utf8"), /current release is \*\*0\.4\.2\*\*/);
    const notes = await readFile(join(root, ".github/release-notes.md"), "utf8");
    assert.match(notes, /- English authored update/); assert.match(notes, /- Deutsch verfasste Änderung/);
    assert.match(notes, /Historical transition to 0\.4\.1 stays intact/);
    assert.deepEqual((await prepareRelease(root, "0.4.2", highlights)).changes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid editorial input and inconsistent manifests are rejected before writes", async () => {
  const root = await fixture();
  try {
    const before = await Promise.all(["VERSION", "README.md", ".github/release-notes.md"].map((path) => readFile(join(root, path), "utf8")));
    await assert.rejects(prepareRelease(root, "0.4.2", { ...highlights, de: ["one\nsecond"] }), /Highlight/);
    await writeFile(join(root, "app/package.json"), JSON.stringify({ name: "openwhisper-electron", version: "9.9.9" }));
    await assert.rejects(prepareRelease(root, "0.4.2", highlights), /inconsistent/);
    assert.equal(await readFile(join(root, "VERSION"), "utf8"), before[0]);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), before[1]);
    assert.equal(await readFile(join(root, ".github/release-notes.md"), "utf8"), before[2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit patch, minor, and major targets are accepted while downgrades and changed same-version notes fail", async () => {
  const root = await fixture();
  try {
    for (const version of ["0.4.2", "0.5.0", "1.0.0"]) {
      assert.equal((await prepareRelease(root, version, highlights)).targetVersion, version);
    }
    for (const version of ["0.4.0", "0.4.1", "v0.5.0", "01.0.0"]) {
      await assert.rejects(prepareRelease(root, version, highlights));
    }
    const prepared = await prepareRelease(root, "0.4.2", highlights);
    await applyPreparedRelease(prepared);
    await assert.rejects(prepareRelease(root, "0.4.2", { en: ["Different English"], de: ["Andere deutsche Notiz"] }), /different prepared content/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-publication bump synchronizes the next patch and is idempotent", async () => {
  const root = await fixture();
  try {
    const release = await prepareRelease(root, "0.4.2", highlights);
    await applyPreparedRelease(release);
    const bumped = await bumpDevelopmentVersion(root, "0.4.2");
    assert.deepEqual(bumped, { version: "0.4.3", changed: true });
    assert.match(await readFile(join(root, "README.md"), "utf8"), /current release is \*\*0\.4\.2\*\*/);
    assert.match(await readFile(join(root, ".github/release-notes.md"), "utf8"), /What's new in OpenWhisper 0\.4\.2/);
    assert.deepEqual(await releaseContextFromFiles(Object.fromEntries(await Promise.all(
      Object.keys(versionFiles("0.4.3")).map(async (path) => [path, await readFile(join(root, path), "utf8")] as const),
    ))), { currentVersion: "0.4.3", successorVersion: "0.4.4" });
    assert.deepEqual(await bumpDevelopmentVersion(root, "0.4.2"), { version: "0.4.3", changed: false });
    const nextRelease = await prepareRelease(root, "0.4.3", highlights);
    assert.equal(nextRelease.targetVersion, "0.4.3");
    await applyPreparedRelease(nextRelease);
    assert.match(await readFile(join(root, "README.md"), "utf8"), /current release is \*\*0\.4\.3\*\*/);
    assert.match(await readFile(join(root, ".github/release-notes.md"), "utf8"), /What's new in OpenWhisper 0\.4\.3/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-publication bump refuses unrelated version movement", async () => {
  const root = await fixture();
  try {
    await assert.rejects(bumpDevelopmentVersion(root, "0.4.2"), /Cannot bump after publishing/);
    assert.equal(await readFile(join(root, "VERSION"), "utf8"), "0.4.1\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release recovery requires an exact public tag, exact asset set, and matching staged bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-release-recovery-"));
  const staged = join(root, "staged"), downloaded = join(root, "downloaded");
  const names = ["OpenWhisper-macOS.dmg", "OpenWhisper-macOS.zip", "OpenWhisper-Linux-x86_64.AppImage",
    "OpenWhisper-Linux-amd64.deb", "OpenWhisper-Linux-x86_64.AppImage.sig", "OpenWhisper-Linux-amd64.deb.sig",
    "latest.json", "SHA256SUMS"];
  const release = { tag_name: "v0.4.2", draft: false, assets: names.map((name) => ({ name })) };
  try {
    await Promise.all([mkdir(staged), mkdir(downloaded)]);
    await Promise.all(names.map(async (name) => {
      await writeFile(join(staged, name), `staged:${name}`);
      await writeFile(join(downloaded, name), `staged:${name}`);
    }));
    await verifyPublicReleaseRecovery(release, "v0.4.2", staged, downloaded);
    assert.throws(() => parsePublicReleaseRecord({ ...release, draft: true }, "v0.4.2"), /RELEASE_RECOVERY_NOT_PUBLIC/);
    assert.throws(() => parsePublicReleaseRecord(release, "v0.4.3"), /RELEASE_RECOVERY_TAG_MISMATCH/);
    await writeFile(join(downloaded, "OpenWhisper-macOS.dmg"), "different bytes");
    await assert.rejects(verifyPublicReleaseRecovery(release, "v0.4.2", staged, downloaded), /RELEASE_RECOVERY_ASSET_BYTES_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

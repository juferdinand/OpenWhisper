import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { finalizeLinuxRelease } from "../../scripts/finalize-linux-release.js";
import { parseReleaseChecksums, validateReleasePublication } from "../../scripts/validate-release-publication.js";
import { LINUX_UPDATE_PUBLIC_KEY } from "../../src/services/update/linux/linux-update-signature.js";
import { LINUX_UPDATE_FEED_URL, projectLinuxUpdateFeed } from "../../src/services/update/common/update-policy.js";

const ownedAssets = process.env["OPENWHISPER_OWNED_UPDATE_SIGNATURE_ASSETS"];

test("publication checksums require the exact safe filename set", () => {
  const digestA = "a".repeat(64), digestB = "b".repeat(64);
  assert.deepEqual(parseReleaseChecksums(`${digestA}  app.deb\n${digestB}  app.deb.sig\n`, ["app.deb", "app.deb.sig"]),
    new Map([["app.deb", digestA], ["app.deb.sig", digestB]]));
  for (const text of [
    `${digestA}  app.deb\n${digestA}  app.deb\n`,
    `${digestA}  ../app.deb\n${digestB}  app.deb.sig\n`,
    `${digestA}  app.deb\n`,
  ]) assert.throws(() => parseReleaseChecksums(text, ["app.deb", "app.deb.sig"]));
});

test("publication rejects incomplete builder outputs before staging any public asset", async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-publication-")));
  const root = join(temporary, "source"), macosDirectory = join(temporary, "macos"),
    linuxDirectory = join(temporary, "linux"), outputDirectory = join(temporary, "assets");
  try {
    await mkdir(root);
    await mkdir(macosDirectory);
    await mkdir(linuxDirectory);
    await writeFile(join(root, "VERSION"), "0.3.0\n");
    await mkdir(join(root, "app", "ui"), { recursive: true });
    await writeFile(join(root, "app", "package.json"), JSON.stringify({ version: "0.3.0" }));
    await writeFile(join(root, "app", "package-lock.json"), JSON.stringify({ version: "0.3.0", packages: { "": { version: "0.3.0" } } }));
    await writeFile(join(root, "app", "ui", "package.json"), JSON.stringify({ version: "0.3.0" }));
    await writeFile(join(root, "app", "ui", "package-lock.json"), JSON.stringify({ version: "0.3.0", packages: { "": { version: "0.3.0" } } }));
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    git(["config", "user.name", "Release test"]);
    git(["config", "user.email", "release-test@example.invalid"]);
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);
    const commit = git(["rev-parse", "HEAD"]);
    await assert.rejects(validateReleasePublication({ root, version: "0.3.0", commit, macosDirectory, linuxDirectory, outputDirectory }),
      { message: "RELEASE_ARTIFACT_SET_MISMATCH" });
    await assert.rejects(lstat(outputDirectory), { code: "ENOENT" });

    const linkedParent = join(temporary, "linked-output-parent");
    await symlink(root, linkedParent, "dir");
    const linkedOutput = join(linkedParent, "assets");
    await assert.rejects(validateReleasePublication({ root, version: "0.3.0", commit, macosDirectory, linuxDirectory, outputDirectory: linkedOutput }),
      { message: "RELEASE_OUTPUT_PARENT_UNSAFE" });
    await assert.rejects(lstat(join(root, "assets")), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("publication stages canonical assets from the existing public signed Linux fixture", {
  skip: !ownedAssets ? "Requires the existing public 0.2.5 signed fixture directory; no download or signing fallback." : false,
}, async () => {
  assert.ok(ownedAssets);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-publication-valid-")));
  const root = join(temporary, "source"), linuxDirectory = join(temporary, "linux"),
    macosDirectory = join(temporary, "macos"), outputDirectory = join(temporary, "assets");
  const version = "0.2.5";
  try {
    await mkdir(root);
    await mkdir(linuxDirectory);
    await mkdir(macosDirectory);
    await writeFile(join(root, "VERSION"), `${version}\n`);
    await mkdir(join(root, "app", "ui"), { recursive: true });
    const lock = JSON.stringify({ version, packages: { "": { version } } });
    await writeFile(join(root, "app", "package.json"), JSON.stringify({ version }));
    await writeFile(join(root, "app", "package-lock.json"), lock);
    await writeFile(join(root, "app", "ui", "package.json"), JSON.stringify({ version }));
    await writeFile(join(root, "app", "ui", "package-lock.json"), lock);
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    git(["config", "user.name", "Release fixture"]);
    git(["config", "user.email", "release-fixture@example.invalid"]);
    git(["add", "."]);
    git(["commit", "-qm", "clean 0.2.5 source fixture"]);
    const commit = git(["rev-parse", "HEAD"]);

    const pins: Readonly<Record<string, string>> = {
      "OpenWhisper-Linux-amd64.deb": "412d06d5475b430fd290c560ea9cd03818b6c471075f064833ebca021313b6cb",
      "OpenWhisper-Linux-amd64.deb.sig": "13032b0a95929f0061f0c596eb6ced59152165418b6f288e414caa8a8ebdff39",
      "OpenWhisper-Linux-x86_64.AppImage": "81ee1be21506a3deb0a5e90846c639e81df766eab728b9970f4af14ef166ffab",
      "OpenWhisper-Linux-x86_64.AppImage.sig": "5994738ed14e8a375ac762bf44f80ba0dc6939a0b672df66f857b60ce158a084",
    };
    for (const [name, expectedHash] of Object.entries(pins)) {
      const source = join(ownedAssets, name);
      const bytes = await readFile(source);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, name);
      await cp(source, join(linuxDirectory, name));
    }
    const imageName = "OpenWhisper-Linux-x86_64.AppImage";
    await chmod(join(linuxDirectory, imageName), 0o755);
    const debianName = "OpenWhisper-Linux-amd64.deb";
    const debian = await readFile(join(linuxDirectory, debianName));
    const image = await readFile(join(linuxDirectory, imageName));
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(linuxDirectory, "release-construction-receipt.json"), JSON.stringify({
      classification: "CANONICAL_STABLE_LINUX_RELEASE_CONSTRUCTION_UNSIGNED",
      source: { commit, modified: false }, version,
      updatePolicy: { publicKey: LINUX_UPDATE_PUBLIC_KEY, feedURL: LINUX_UPDATE_FEED_URL, requireSignedVersion: true },
      artifacts: {
        debian: { path: join(linuxDirectory, debianName), bytes: debian.length, sha256: digest(debian),
          package: "io-github-whisperfree", version, architecture: "amd64" },
        appImage: { path: join(linuxDirectory, imageName), bytes: image.length, sha256: digest(image), mode: 0o755 },
      },
      signing: "NOT_PERFORMED_EXISTING_KEY_SIGNER_REQUIRED", updateAuthority: false, publicDistributionAuthorized: false,
    }));
    await finalizeLinuxRelease({ directory: linuxDirectory, version, commit });

    // These inert bytes satisfy the Mac metadata staging contract only; this does not test Mac package acceptance or signing.
    for (const name of ["OpenWhisper-macOS.dmg", "OpenWhisper-macOS.zip"]) {
      await writeFile(join(macosDirectory, name), `metadata-only fixture: ${name}`);
    }
    await writeFile(join(macosDirectory, "OpenWhisper-macOS-release.json"), JSON.stringify({
      status: "PASS", version, sourceCommit: commit, architecture: "universal", updateConfigured: true,
    }));
    const macNames = ["OpenWhisper-macOS.dmg", "OpenWhisper-macOS.zip"];
    const macRows = await Promise.all(macNames.map(async (name) => `${digest(await readFile(join(macosDirectory, name)))}  ${name}`));
    await writeFile(join(macosDirectory, "SHA256SUMS"), `${macRows.join("\n")}\n`);

    await validateReleasePublication({ root, version, commit, macosDirectory, linuxDirectory, outputDirectory });
    const feed: unknown = JSON.parse(await readFile(join(outputDirectory, "latest.json"), "utf8"));
    for (const packageKind of ["deb", "appimage"] as const) {
      const candidate = projectLinuxUpdateFeed({ sourceURL: LINUX_UPDATE_FEED_URL, package: packageKind, currentVersion: "0.2.4", feed });
      assert.equal(candidate.version, version);
      assert.equal(candidate.package, packageKind);
    }
    const publishedChecksums = await readFile(join(outputDirectory, "SHA256SUMS"), "utf8");
    assert.equal(parseReleaseChecksums(publishedChecksums, [
      "OpenWhisper-macOS.dmg", "OpenWhisper-macOS.zip", "OpenWhisper-Linux-x86_64.AppImage",
      "OpenWhisper-Linux-x86_64.AppImage.sig", "OpenWhisper-Linux-amd64.deb", "OpenWhisper-Linux-amd64.deb.sig", "latest.json",
    ]).size, 7);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

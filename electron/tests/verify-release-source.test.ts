import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  releaseSourceRoot,
  verifyReleaseSource,
} from "../scripts/verify-release-source.js";

async function committedSource() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-release-source-")));
  await mkdir(join(root, "electron"), { recursive: true });
  await mkdir(join(root, "shared/ui"), { recursive: true });
  await writeFile(join(root, "VERSION"), "0.3.0\n");
  await writeFile(
    join(root, "electron/package.json"),
    JSON.stringify({ name: "openwhisper-electron", version: "0.3.0" }),
  );
  await writeFile(
    join(root, "electron/package-lock.json"),
    JSON.stringify({
      version: "0.3.0",
      lockfileVersion: 3,
      packages: { "": { version: "0.3.0" } },
    }),
  );
  await writeFile(
    join(root, "shared/ui/package.json"),
    JSON.stringify({ name: "openwhisper-ui", version: "0.3.0" }),
  );
  await writeFile(
    join(root, "shared/ui/package-lock.json"),
    JSON.stringify({
      version: "0.3.0",
      lockfileVersion: 3,
      packages: { "": { version: "0.3.0" } },
    }),
  );
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git([
    "-c",
    "user.name=OpenWhisper Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "release source fixture",
  ]);
  return { root, commit: git(["rev-parse", "HEAD"]), git };
}

test("release source CLI defaults to the repository root above electron/scripts", () => {
  assert.equal(
    releaseSourceRoot,
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  );
});

test("release source verification accepts the exact clean commit and synchronized versions", async () => {
  const source = await committedSource();
  try {
    assert.deepEqual(
      await verifyReleaseSource({
        root: source.root,
        version: "0.3.0",
        commit: source.commit,
      }),
      {
        root: source.root,
        version: "0.3.0",
        commit: source.commit,
      },
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
  }
});

test("release source verification rejects version drift, wrong commit, and dirty or untracked files", async () => {
  const source = await committedSource();
  try {
    await assert.rejects(
      verifyReleaseSource({
        root: source.root,
        version: "0.3.1",
        commit: source.commit,
      }),
      /RELEASE_SOURCE_VERSION_MISMATCH/u,
    );
    await assert.rejects(
      verifyReleaseSource({
        root: source.root,
        version: "0.3.0",
        commit: "f".repeat(40),
      }),
      /RELEASE_SOURCE_NOT_EXACT_CLEAN_COMMIT/u,
    );
    await writeFile(join(source.root, "untracked.txt"), "untracked");
    await assert.rejects(
      verifyReleaseSource({
        root: source.root,
        version: "0.3.0",
        commit: source.commit,
      }),
      /RELEASE_SOURCE_NOT_EXACT_CLEAN_COMMIT/u,
    );
  } finally {
    await rm(source.root, { recursive: true, force: true });
  }
});

test("release source verification rejects a symlink alias for the source root", async () => {
  const source = await committedSource();
  const alias = `${source.root}-alias`;
  try {
    await symlink(source.root, alias);
    await assert.rejects(
      verifyReleaseSource({ root: alias, version: "0.3.0", commit: source.commit }),
      /RELEASE_SOURCE_ROOT_UNSAFE/u,
    );
  } finally {
    await rm(alias, { force: true });
    await rm(source.root, { recursive: true, force: true });
  }
});

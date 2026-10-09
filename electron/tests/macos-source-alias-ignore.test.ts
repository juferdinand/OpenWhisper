import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", shell: false, timeout: 5_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("Mac publisher dependency aliases stay ignored without hiding unrelated untracked source", async () => {
  const repository = await mkdtemp(join(tmpdir(), "mac-publisher-ignore-"));
  try {
    const ignore = await readFile(new URL("../../.gitignore", import.meta.url), "utf8");
    await writeFile(join(repository, ".gitignore"), ignore);
    git(repository, ["init", "--quiet"]);
    git(repository, ["config", "user.name", "Fixture"]);
    git(repository, ["config", "user.email", "fixture@example.invalid"]);
    git(repository, ["add", ".gitignore"]);
    git(repository, ["commit", "--quiet", "-m", "fixture"]);

    const electronTarget = join(repository, ".owned-electron-dependencies");
    const uiTarget = join(repository, ".owned-ui-dependencies");
    await mkdir(electronTarget);
    await mkdir(uiTarget);
    await mkdir(join(repository, "electron"));
    await mkdir(join(repository, "shared/ui"), { recursive: true });
    await symlink(electronTarget, join(repository, "electron/node_modules"), "dir");
    await symlink(uiTarget, join(repository, "shared/ui/node_modules"), "dir");
    assert.equal(git(repository, ["status", "--porcelain", "--untracked-files=all"]), "");

    await writeFile(join(repository, "unexpected-source.txt"), "not an approved dependency alias\n");
    assert.equal(git(repository, ["status", "--porcelain", "--untracked-files=all"]), "?? unexpected-source.txt\n");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

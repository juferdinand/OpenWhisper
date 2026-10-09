import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAIN_URL, OVERLAY_URL, readApplicationAsset } from "../../src/main/assets.js";

test("assets allow trusted main and overlay while refusing foreign paths and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-assets-"));
  const outside = await mkdtemp(join(tmpdir(), "openwhisper-outside-"));
  try {
    await writeFile(join(root, "index.html"), "<div>Owned fixture</div>");
    await writeFile(join(outside, "private.html"), "Never served");
    await symlink(join(outside, "private.html"), join(root, "linked.html"));
    assert.equal(new TextDecoder().decode((await readApplicationAsset(MAIN_URL, root)).bytes), "<div>Owned fixture</div>");
    assert.equal((await readApplicationAsset(OVERLAY_URL, root)).mediaType, "text/html; charset=utf-8");
    for (const url of [
      "https://openwhisper/index.html", "app://other/index.html", "app://user@openwhisper/index.html",
      `${MAIN_URL}?unknown=1`, `${MAIN_URL}#fragment`, "app://openwhisper/linked.html",
      "app://openwhisper/%2e%2e%2fprivate.html", "app://openwhisper/%00.html",
    ]) await assert.rejects(readApplicationAsset(url, root));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

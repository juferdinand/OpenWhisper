import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelInventory, ModelInventoryError } from "../src/services/model-inventory.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../src/services/profiles.js";

const catalog: unknown = JSON.parse(await readFile(new URL("../../shared/models.json", import.meta.url), "utf8"));
test("catalog basename aliases cannot acquire or remove a differently named inventory ID", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-inventory-alias-review-")));
  try {
    const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
    const profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ home }));
    const bytes = Buffer.from("private unchanged catalog model");
    const file = join(profile.paths.models, "ggml-tiny.bin"); await writeFile(file, bytes, { mode: 0o600 });
    const store = await ModelInventory.open(profile, catalog);
    assert.equal((await store.installed())[0]?.model.id, "tiny");
    const invalid = (error: unknown): boolean => error instanceof ModelInventoryError && error.code === "INVALID_ID";
    await assert.rejects(store.acquire("ggml-tiny", { gpu: false }), invalid);
    await assert.rejects(store.remove("ggml-tiny"), invalid);
    assert.deepEqual(await readFile(file), bytes);
    const lease = await store.acquire("tiny", { gpu: false }); await lease.release(Promise.resolve());
  } finally { await rm(root, { recursive: true, force: true }); }
});

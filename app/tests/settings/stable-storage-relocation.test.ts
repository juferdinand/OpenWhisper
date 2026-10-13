import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { StableMigrationError } from "../../src/contracts/migration/stable-migration.js";
import { resolveStableProfile } from "../../src/services/settings/stable-profile.js";
import { relocateStableStorage } from "../../src/services/settings/stable-storage-relocation.js";

function fixture(run: (home: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openwhisper-storage-relocation-")), home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  try { run(home); } finally { rmSync(root, { recursive: true, force: true }); }
}
function file(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, content, { mode: 0o600 });
}
const code = (expected: string) => (error: unknown): boolean => error instanceof StableMigrationError && error.code === expected;
const support = (home: string, name: string) => join(home, "Library/Application Support", name);

test("a fresh installation has nothing to relocate", () => {
  fixture((home) => {
    for (const platform of ["darwin", "linux"] as const) {
      assert.deepEqual(relocateStableStorage({ home, platform }), { moved: [], keptPrevious: [], skippedCache: false });
    }
    assert.deepEqual(readdirSync(home), []);
  });
});

test("an Electron-layout Mac profile moves every root to the OpenWhisper folders and resolves there", () => {
  fixture((home) => {
    file(join(support(home, "io.github.whisperfree"), "electron/settings/preferences.json"), "preferences");
    file(join(support(home, "io.github.whisperfree"), "electron/migration.json"), "completion");
    file(join(support(home, "WhisperFree"), "Models/ggml-base.bin"), "model");
    file(join(home, "Library/Caches/io.github.whisperfree/electron/cache/entry"), "cache");
    chmodSync(support(home, "WhisperFree"), 0o755);
    const result = relocateStableStorage({ home, platform: "darwin" });
    assert.deepEqual(result, { moved: ["config", "data", "cache"], keptPrevious: [], skippedCache: false });
    for (const old of [support(home, "io.github.whisperfree"), support(home, "WhisperFree"), join(home, "Library/Caches/io.github.whisperfree")]) {
      assert.equal(existsSync(old), false);
    }
    const profile = resolveStableProfile({ home, platform: "darwin" });
    assert.equal(readFileSync(join(profile.paths.settings, "preferences.json"), "utf8"), "preferences");
    assert.equal(readFileSync(join(profile.paths.models, "ggml-base.bin"), "utf8"), "model");
    assert.equal(readFileSync(join(profile.roots.cache, "electron/cache/entry"), "utf8"), "cache");
    // Repeating the relocation is a no-op.
    assert.deepEqual(relocateStableStorage({ home, platform: "darwin" }), { moved: [], keptPrevious: [], skippedCache: false });
  });
});

test("legacy 0.2.x Mac sources follow the data root so the Electron migration still finds them", () => {
  fixture((home) => {
    file(join(support(home, "WhisperFree"), "snippets.json"), "[]");
    file(join(support(home, "WhisperFree"), "Diktate/old.txt"), "old dictation");
    file(join(support(home, "WhisperFree"), "Models/model.bin"), "model");
    const plist = join(home, "Library/Preferences/io.github.whisperfree.plist"); file(plist, "plist");
    assert.deepEqual(relocateStableStorage({ home, platform: "darwin" }).moved, ["data"]);
    const profile = resolveStableProfile({ home, platform: "darwin" });
    assert.equal(readFileSync(profile.legacy.snippets, "utf8"), "[]");
    assert.equal(profile.legacy.transcripts, join(profile.roots.data, "Diktate"));
    assert.equal(readFileSync(join(profile.legacy.models, "model.bin"), "utf8"), "model");
    assert.equal(profile.legacy.settings, plist); assert.equal(readFileSync(plist, "utf8"), "plist");
  });
});

test("Linux XDG roots move from whisperfree to openwhisper, including custom bases", () => {
  fixture((home) => {
    file(join(home, ".config/whisperfree/settings.json"), "{}");
    file(join(home, ".local/share/whisperfree/models/ggml-tiny.bin"), "model");
    assert.deepEqual(relocateStableStorage({ home, platform: "linux" }).moved, ["config", "data"]);
    const profile = resolveStableProfile({ home, platform: "linux" });
    assert.equal(readFileSync(profile.legacy.settings, "utf8"), "{}");
    assert.equal(readFileSync(join(profile.paths.models, "ggml-tiny.bin"), "utf8"), "model");
    const dataHome = join(home, "custom-data");
    file(join(dataHome, "whisperfree/models/model.bin"), "custom");
    assert.deepEqual(relocateStableStorage({ home, platform: "linux", dataHome }).moved, ["data"]);
    assert.equal(readFileSync(join(dataHome, "openwhisper/models/model.bin"), "utf8"), "custom");
  });
});

test("existing new storage is kept and earlier storage is never merged or removed", () => {
  fixture((home) => {
    file(join(support(home, "io.github.whisperfree"), "electron/settings/preferences.json"), "old");
    file(join(support(home, "OpenWhisper/Config"), "electron/settings/preferences.json"), "new");
    const result = relocateStableStorage({ home, platform: "darwin" });
    assert.deepEqual(result.keptPrevious, ["config"]); assert.deepEqual(result.moved, []);
    assert.equal(readFileSync(join(support(home, "io.github.whisperfree"), "electron/settings/preferences.json"), "utf8"), "old");
    assert.equal(readFileSync(join(support(home, "OpenWhisper/Config"), "electron/settings/preferences.json"), "utf8"), "new");
  });
});

test("unsafe earlier roots are refused before anything moves", () => {
  fixture((home) => {
    const target = join(home, "elsewhere"); file(join(target, "settings.json"), "{}");
    mkdirSync(join(home, ".config"), { mode: 0o700 }); symlinkSync(target, join(home, ".config/whisperfree"));
    assert.throws(() => relocateStableStorage({ home, platform: "linux" }), code("UNSAFE_SOURCE"));
    assert.equal(existsSync(join(home, ".config/openwhisper")), false);
  });
  fixture((home) => {
    file(join(home, ".local/share/whisperfree/models/model.bin"), "model"); chmodSync(join(home, ".local/share/whisperfree"), 0o777);
    assert.throws(() => relocateStableStorage({ home, platform: "linux" }), code("UNSAFE_SOURCE"));
    assert.equal(readFileSync(join(home, ".local/share/whisperfree/models/model.bin"), "utf8"), "model");
  });
});

test("a cross-volume rename stops startup for persistent roots but only skips the cache", () => {
  const crossDevice = (): never => { throw Object.assign(new Error("cross-device link"), { code: "EXDEV" }); };
  fixture((home) => {
    file(join(support(home, "WhisperFree"), "Models/model.bin"), "model");
    assert.throws(() => relocateStableStorage({ home, platform: "darwin" }, { rename: crossDevice }), code("RELOCATION_FAILED"));
    assert.equal(readFileSync(join(support(home, "WhisperFree"), "Models/model.bin"), "utf8"), "model");
    assert.equal(existsSync(support(home, "OpenWhisper/Data")), false);
  });
  fixture((home) => {
    file(join(home, "Library/Caches/io.github.whisperfree/entry"), "cache");
    assert.deepEqual(relocateStableStorage({ home, platform: "darwin" }, { rename: crossDevice }), { moved: [], keptPrevious: [], skippedCache: true });
    assert.equal(readFileSync(join(home, "Library/Caches/io.github.whisperfree/entry"), "utf8"), "cache");
  });
});

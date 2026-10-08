import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { prepareStableProfile, prepareStableProfileStorage, resolveStableProfile, stableProfileSchema, validateStableProfile, type StableProfile } from "../src/services/stable-profile.js";

function fixture(run: (home: string, root: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openwhisper-stable-profile-")), home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  try { run(home, root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function snapshot(root: string): Record<string, { mode: number; bytes?: string }> {
  const result: Record<string, { mode: number; bytes?: string }> = {};
  const visit = (path: string): void => {
    const stats = lstatSync(path);
    result[relative(root, path)] = { mode: stats.mode & 0o7777, ...(!stats.isDirectory() ? { bytes: readFileSync(path).toString("hex") } : {}) };
    if (stats.isDirectory()) for (const child of readdirSync(path).sort()) visit(join(path, child));
  };
  visit(root); return result;
}
function legacyFile(path: string, content = "existing legacy bytes"): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, content, { mode: 0o600 });
}

test("Linux stable resolution preserves identity and XDG/model paths without mutation or Dev policy", () => {
  fixture((home, root) => {
    const before = snapshot(root), profile = resolveStableProfile({ home, platform: "linux" });
    assert.deepEqual(snapshot(root), before);
    assert.equal(profile.appId, "io.github.whisperfree"); assert.equal(profile.productName, "OpenWhisper");
    assert.deepEqual(profile.roots, { config: join(home, ".config/whisperfree"), data: join(home, ".local/share/whisperfree"), cache: join(home, ".cache/whisperfree") });
    assert.equal(profile.paths.models, join(profile.roots.data, "models")); assert.equal(profile.legacy.models, profile.paths.models);
    assert.equal(profile.legacy.settings, join(profile.roots.config, "settings.json"));
    assert.equal(profile.legacy.history, join(profile.roots.config, "history.json"));
    assert.equal(profile.legacy.recovery, join(profile.roots.config, "recovery"));
    assert.deepEqual(profile.flags, { globalTriggers: true, autoPaste: true, autostart: true, stableUpdater: true });
    for (const value of [profile, profile.roots, profile.paths, profile.legacy, profile.flags]) assert.ok(Object.isFrozen(value));
  });
});

test("preparation retains existing 0755 Linux model roots and originals while creating private 0700 state", () => {
  fixture((home) => {
    const profile = resolveStableProfile({ home, platform: "linux" });
    for (const path of Object.values(profile.roots)) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o755); }
    legacyFile(profile.legacy.settings); legacyFile(profile.legacy.history);
    legacyFile(join(profile.paths.models, "ggml-tiny.bin"), "owned inert model sentinel"); chmodSync(profile.paths.models, 0o755);
    const modelsBefore = snapshot(profile.paths.models), originals = [profile.legacy.settings, profile.legacy.history].map((path) => readFileSync(path));
    assert.strictEqual(prepareStableProfile(profile), profile);
    assert.deepEqual(snapshot(profile.paths.models), modelsBefore);
    assert.deepEqual([profile.legacy.settings, profile.legacy.history].map((path) => readFileSync(path)), originals);
    for (const root of Object.values(profile.roots)) assert.equal(lstatSync(root).mode & 0o7777, 0o755);
    for (const [key, path] of Object.entries(profile.paths)) if (key !== "models") assert.equal(lstatSync(path).mode & 0o7777, 0o700);
    assert.equal(existsSync(profile.legacy.recovery!), false);
    legacyFile(join(profile.paths.settings, "preferences.json"), "saved new stable preferences");
    const beforeRepeat = snapshot(home); assert.strictEqual(prepareStableProfile(profile), profile); assert.deepEqual(snapshot(home), beforeRepeat);
  });
});

test("Mac profile preserves legacy Models, plist, snippets and Diktate references with separate stable state", () => {
  fixture((home) => {
    const support = join(home, "Library/Application Support/WhisperFree"), models = join(support, "Models"), transcripts = join(support, "Diktate");
    legacyFile(join(models, "model.bin")); legacyFile(join(transcripts, "old-dictation.txt")); legacyFile(join(support, "snippets.json"));
    const plist = join(home, "Library/Preferences/io.github.whisperfree.plist"); legacyFile(plist);
    for (const path of [support, models, transcripts]) chmodSync(path, 0o755);
    const before = snapshot(support), plistBefore = readFileSync(plist), profile = resolveStableProfile({ home, platform: "darwin" });
    assert.equal(profile.roots.config, join(home, "Library/Application Support/io.github.whisperfree"));
    assert.equal(profile.roots.cache, join(home, "Library/Caches/io.github.whisperfree"));
    assert.equal(profile.paths.models, models); assert.equal(profile.legacy.settings, plist); assert.equal(profile.legacy.history, plist);
    assert.equal(profile.legacy.snippets, join(support, "snippets.json")); assert.equal(profile.legacy.transcripts, transcripts);
    assert.equal(profile.legacy.recovery, null); assert.deepEqual(snapshot(support), before);
    prepareStableProfile(profile);
    assert.equal(lstatSync(models).mode & 0o7777, 0o755); assert.deepEqual(readFileSync(plist), plistBefore);
    for (const name of ["Models", "Diktate"]) assert.deepEqual(snapshot(join(support, name)), Object.fromEntries(Object.entries(before)
      .filter(([path]) => path === name || path.startsWith(`${name}/`)).map(([path, value]) => [path === name ? "" : path.slice(name.length + 1), value])));
    assert.equal(readFileSync(join(support, "snippets.json"), "utf8"), "existing legacy bytes");
    for (const [key, path] of Object.entries(profile.paths)) if (key !== "models") assert.equal(lstatSync(path).mode & 0o7777, 0o700);
  });
});

test("custom Linux XDG bases remain distinct and Mac chooses Transcripts when Diktate is absent", () => {
  fixture((home, root) => {
    const configHome = join(root, "config"), dataHome = join(root, "data"), cacheHome = join(root, "cache");
    const profile = resolveStableProfile({ home, platform: "linux", configHome, dataHome, cacheHome });
    assert.equal(profile.paths.models, join(dataHome, "whisperfree/models")); prepareStableProfile(profile);
    assert.deepEqual(readdirSync(home), []);
    assert.equal(resolveStableProfile({ home, platform: "darwin" }).legacy.transcripts, join(home, "Library/Application Support/WhisperFree/Transcripts"));
    assert.throws(() => resolveStableProfile({ home, platform: "darwin", configHome }), /fixed Library/);
  });
});

test("invalid, overlapping and Dev bases are refused before creating any stable state", () => {
  fixture((home, root) => {
    const before = snapshot(root), configHome = join(root, "config");
    for (const options of [
      { home: "relative", platform: "linux" }, { home, platform: "windows" }, { home, platform: "linux", explicitRoot: join(root, "other") },
      { home, platform: "linux", dataHome: `${root}/one/../two` }, { home, platform: "linux", cacheHome: `${root}/bad\npath` },
      { home, platform: "linux", configHome, dataHome: configHome }, { home, platform: "linux", configHome, dataHome: join(configHome, "data") },
      { home, platform: "linux", configHome, cacheHome: configHome.toUpperCase() },
      { home, platform: "linux", configHome: join(home, ".config/io.github.whisperfree.dev") },
      { home, platform: "linux", dataHome: join(root, "openwhisper-dev/data") },
      { home, platform: "linux", configHome: join(home, ".config/whisperfree") },
    ]) assert.throws(() => resolveStableProfile(options));
    assert.deepEqual(snapshot(root), before);
  });
});

test("symlink ancestors and changed planned directories fail before preparation changes other roots", () => {
  fixture((home, root) => {
    const target = join(root, "target"); legacyFile(join(target, "sentinel")); const before = snapshot(target);
    const profile = resolveStableProfile({ home, platform: "linux" });
    mkdirSync(dirname(profile.paths.models), { recursive: true, mode: 0o700 }); symlinkSync(target, profile.paths.models, "dir");
    assert.throws(() => prepareStableProfile(profile), /no symlinks/);
    assert.equal(existsSync(profile.roots.config), false); assert.equal(existsSync(profile.roots.cache), false); assert.deepEqual(snapshot(target), before);
    const baseLink = join(root, "linked-base"); symlinkSync(target, baseLink, "dir");
    assert.throws(() => resolveStableProfile({ home, platform: "linux", configHome: baseLink }), /no symlinks/);
    assert.deepEqual(snapshot(target), before);
  });
});

test("unsafe legacy or private permissions are rejected without chmod or deletion", () => {
  fixture((home) => {
    const profile = resolveStableProfile({ home, platform: "linux" });
    mkdirSync(profile.roots.data, { recursive: true, mode: 0o700 }); chmodSync(profile.roots.data, 0o777);
    assert.throws(() => prepareStableProfile(profile), /safe ownership and permissions/);
    assert.equal(lstatSync(profile.roots.data).mode & 0o7777, 0o777); assert.equal(existsSync(profile.roots.config), false);
    chmodSync(profile.roots.data, 0o755); mkdirSync(profile.paths.settings, { recursive: true, mode: 0o700 }); chmodSync(profile.paths.settings, 0o755);
    assert.throws(() => prepareStableProfile(profile), /mode 0700/); assert.equal(lstatSync(profile.paths.settings).mode & 0o7777, 0o755);
    assert.equal(existsSync(profile.roots.cache), false);
  });
});

test("forged or serialized stable profiles cannot authorize directory preparation", () => {
  fixture((home, root) => {
    const before = snapshot(root), profile = resolveStableProfile({ home, platform: "linux" });
    assert.throws(() => prepareStableProfile(stableProfileSchema.parse(profile)), /resolved in this process/);
    const altered: StableProfile = { ...profile, paths: { ...profile.paths, settings: home } };
    assert.throws(() => prepareStableProfile(altered), /resolved in this process/); assert.deepEqual(snapshot(root), before);
  });
});

test("storage-only preparation reserves config publication for migration while validation creates nothing", () => {
  fixture((home, root) => {
    const before = snapshot(root), profile = resolveStableProfile({ home, platform: "linux" });
    assert.strictEqual(validateStableProfile(profile), profile); assert.deepEqual(snapshot(root), before);
    assert.throws(() => validateStableProfile(stableProfileSchema.parse(profile)), /resolved in this process/);
    assert.throws(() => prepareStableProfileStorage(stableProfileSchema.parse(profile)), /resolved in this process/);
    prepareStableProfileStorage(profile);
    assert.ok(existsSync(profile.roots.config)); assert.ok(existsSync(profile.paths.models));
    assert.ok(existsSync(profile.paths.session)); assert.ok(existsSync(profile.paths.downloads));
    assert.equal(existsSync(join(profile.roots.config, "electron")), false);
    assert.strictEqual(validateStableProfile(profile), profile);
  });
});

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PreferenceStore } from "../src/services/preferences.js";
import { convertLegacyLinuxData } from "../src/services/legacy-linux-data.js";
import { prepareStableProfile, resolveStableProfile, stableProfileSchema, type StableProfile } from "../src/services/stable-profile.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../src/services/profiles.js";
import { saveTranscript } from "../src/services/development-transcripts.js";

async function fixture(platform: "linux" | "darwin", run: (profile: StableProfile, home: string) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-stable-preferences-")));
  try { await run(resolveStableProfile({ home, platform }), home); }
  finally { await rm(home, { recursive: true, force: true }); }
}

for (const platform of ["linux", "darwin"] as const) test(`${platform} stable patches retain migrated opt-ins, text and independent trigger profiles across restart`, async () => fixture(platform, async (profile) => {
  prepareStableProfile(profile);
  const migrated = convertLegacyLinuxData({ settings: { ui_language: "de", vocabulary: "café, İstanbul, 東京",
    launch_at_login: true, auto_check_updates: true, gpu: false, gpu_configured: true,
    hold_to_record: true, native_trigger: { kind: "mouse", button: 8 },
    x11_trigger: { keycode: 74, keysym: 65477, modifiers: 0, group: 0 } } }).preferences;
  const path = join(profile.paths.settings, "preferences.json");
  await writeFile(path, JSON.stringify({ ...migrated, play_sounds: true, restore_clipboard: true, output: "editor" }), { mode: 0o600 });
  const legacy = profile.platform === "linux" ? profile.legacy.settings : profile.legacy.snippets;
  await mkdir(dirname(legacy), { recursive: true, mode: 0o700 }); await writeFile(legacy, "unchanged original source", { mode: 0o600 });
  const store = await PreferenceStore.open(profile);
  await Promise.all([store.patch({ vocabulary: "Neue Wörter — 新語" }), store.patch({ ui_language: "en" })]);
  const saved = (await PreferenceStore.open(profile)).snapshot();
  assert.equal(saved.vocabulary, "Neue Wörter — 新語"); assert.equal(saved.ui_language, "en");
  assert.equal(saved.launch_at_login, true); assert.equal(saved.auto_check_updates, true); assert.equal(saved.gpu, false);
  assert.equal(saved.play_sounds, true); assert.equal(saved.restore_clipboard, true); assert.equal(saved.output, "editor");
  assert.equal(saved.hold_to_record, true); assert.deepEqual(saved.native_trigger, migrated.native_trigger);
  assert.deepEqual(saved.x11_trigger, migrated.x11_trigger); assert.equal(saved.setup_completed, true);
  await store.patch({ auto_check_updates: false }); await store.patch({ launch_at_login: false });
  assert.equal((await PreferenceStore.open(profile)).snapshot().auto_check_updates, false);
  assert.equal((await PreferenceStore.open(profile)).snapshot().launch_at_login, false);
  assert.equal(await readFile(legacy, "utf8"), "unchanged original source"); assert.equal((await lstat(path)).mode & 0o7777, 0o600);
}));

test("stable preference absence never adopts Dev defaults or creates a partial migration destination", async () => fixture("linux", async (profile) => {
  await assert.rejects(PreferenceStore.open(profile));
  await assert.rejects(lstat(join(profile.roots.config, "electron")), { code: "ENOENT" });
  prepareStableProfile(profile);
  await assert.rejects(PreferenceStore.open(profile), /unavailable/);
  assert.deepEqual(await readdir(profile.paths.settings), []);
}));

test("shared preference storage retains Dev restrictions for both saved and patched service opt-ins", async () => fixture("linux", async (_stable, home) => {
  const profile = resolveDevelopmentProfile({ home }); prepareDevelopmentProfile(profile);
  const store = await PreferenceStore.open(profile), original = store.snapshot();
  await assert.rejects(store.patch({ auto_check_updates: true }), /unavailable/);
  await assert.rejects(store.patch({ launch_at_login: true }), /unavailable/);
  assert.deepEqual(store.snapshot(), original);
  const path = join(profile.paths.settings, "preferences.json");
  await writeFile(path, JSON.stringify({ ...original, auto_check_updates: true }), { mode: 0o600 });
  const before = await readFile(path); await assert.rejects(PreferenceStore.open(profile), /unavailable/);
  assert.deepEqual(await readFile(path), before);
}));

test("stable patch refuses a replaced parent while preserving both the original and selected target", async () => fixture("linux", async (profile, home) => {
  prepareStableProfile(profile);
  const path = join(profile.paths.settings, "preferences.json"), original = JSON.stringify(convertLegacyLinuxData({}).preferences);
  await writeFile(path, original, { mode: 0o600 }); const store = await PreferenceStore.open(profile);
  const retained = `${profile.paths.settings}.retained`, target = join(home, "unrelated-private");
  await mkdir(target, { mode: 0o700 }); const selected = join(target, "preferences.json");
  await writeFile(selected, "unrelated user bytes", { mode: 0o600 });
  await rename(profile.paths.settings, retained); await symlink(target, profile.paths.settings);
  await assert.rejects(store.patch({ vocabulary: "Must never be written" }));
  assert.equal(await readFile(join(retained, "preferences.json"), "utf8"), original);
  assert.equal(await readFile(selected, "utf8"), "unrelated user bytes");
}));

test("stable preference authority rejects serialized profiles and unsafe private records", async () => fixture("darwin", async (profile) => {
  await assert.rejects(PreferenceStore.open(stableProfileSchema.parse(profile)), /resolved in this process/);
  prepareStableProfile(profile);
  const path = join(profile.paths.settings, "preferences.json"), original = JSON.stringify(convertLegacyLinuxData({}).preferences);
  await writeFile(path, original, { mode: 0o600 }); await chmod(path, 0o644);
  await assert.rejects(PreferenceStore.open(profile), /unsafe/);
  assert.equal((await lstat(path)).mode & 0o7777, 0o644); assert.equal(await readFile(path, "utf8"), original);
}));

test("stable transcript saving retains complete output in private files without touching old transcripts", async () => fixture("darwin", async (profile) => {
  prepareStableProfile(profile);
  await mkdir(profile.legacy.transcripts!, { mode: 0o700 }); const old = join(profile.legacy.transcripts!, "old.txt");
  await writeFile(old, "old full output", { mode: 0o600 }); const text = "Complete output 東京\n".repeat(1000);
  await saveTranscript(profile, text);
  const files = await readdir(profile.paths.transcripts); assert.equal(files.length, 1);
  const path = join(profile.paths.transcripts, files[0]!);
  assert.equal(await readFile(path, "utf8"), text); assert.equal((await lstat(path)).mode & 0o7777, 0o600);
  assert.equal(await readFile(old, "utf8"), "old full output");
}));

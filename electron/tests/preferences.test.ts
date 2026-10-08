import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { MAX_UI_REQUEST_BYTES } from "../src/contracts/ui.js";
import { DevelopmentPreferenceStore } from "../src/services/preferences.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../src/services/profiles.js";

test("concurrent development patches preserve each field and retain text across restart", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-preferences-")));
  try {
    const profile = resolveDevelopmentProfile({ home });
    prepareDevelopmentProfile(profile);
    const store = await DevelopmentPreferenceStore.open(profile);
    const text = "Mehrsprachig: café, İstanbul, 東京";
    await Promise.all([store.patch({ vocabulary: text }), store.patch({ ui_language: "de" })]);
    const reopened = await DevelopmentPreferenceStore.open(profile);
    assert.equal(reopened.snapshot().vocabulary, text);
    assert.equal(reopened.snapshot().ui_language, "de");
    assert.equal(reopened.snapshot().launch_at_login, false);
    await assert.rejects(reopened.patch({ launch_at_login: true }));
    await reopened.patch({ model: "base" });
    assert.equal((await DevelopmentPreferenceStore.open(profile)).snapshot().model, "base");
    const x11 = { keycode: 74, keysym: 65477, modifiers: 0, group: 0 };
    await Promise.all([reopened.saveNativeTrigger({ kind: "mouse", button: 8 }), reopened.saveX11Trigger(x11), reopened.saveMacShortcut("Command+Shift+Space")]);
    const triggers = await DevelopmentPreferenceStore.open(profile);
    assert.deepEqual(triggers.snapshot().x11_trigger, x11);
    assert.deepEqual(triggers.snapshot().native_trigger, { kind: "mouse", button: 8 });
    assert.equal(triggers.snapshot().macos_shortcut, "Command+Shift+Space");
    await triggers.saveMacShortcut(null);
    assert.deepEqual((await DevelopmentPreferenceStore.open(profile)).snapshot().x11_trigger, x11);
    await triggers.saveX11Trigger(null);
    assert.deepEqual((await DevelopmentPreferenceStore.open(profile)).snapshot().native_trigger, { kind: "mouse", button: 8 });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("development preferences reject FIFO and malformed UTF-8 without waiting or replacement", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-pref-bounds-")));
  try {
    const profile = resolveDevelopmentProfile({ home });
    prepareDevelopmentProfile(profile);
    const path = join(profile.paths.settings, "preferences.json");
    const fifo = spawnSync("mkfifo", ["-m", "600", path], { shell: false });
    assert.equal(fifo.status, 0);
    const started = performance.now();
    await assert.rejects(DevelopmentPreferenceStore.open(profile));
    assert.ok(performance.now() - started < 1000);
    await rm(path);
    const malformed = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]);
    await writeFile(path, malformed, { mode: 0o600 });
    await assert.rejects(DevelopmentPreferenceStore.open(profile));
    assert.deepEqual(await readFile(path), malformed);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("development store refuses a symlink without reading or changing its target", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-pref-link-")));
  try {
    const profile = resolveDevelopmentProfile({ home });
    prepareDevelopmentProfile(profile);
    const outside = join(home, "stable-fixture.json");
    const original = "Owned stable fixture";
    await writeFile(outside, original, { mode: 0o600 });
    await symlink(outside, join(profile.paths.settings, "preferences.json"));
    await assert.rejects(DevelopmentPreferenceStore.open(profile));
    assert.equal(await readFile(outside, "utf8"), original);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("oversized development preferences are refused without truncating the original file", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-pref-size-")));
  try {
    const profile = resolveDevelopmentProfile({ home });
    prepareDevelopmentProfile(profile);
    const path = join(profile.paths.settings, "preferences.json");
    const original = Buffer.alloc(MAX_UI_REQUEST_BYTES + 1, 0x61);
    await writeFile(path, original, { mode: 0o600 });
    await assert.rejects(DevelopmentPreferenceStore.open(profile), /unsafe/);
    assert.deepEqual(await readFile(path), original);
  } finally { await rm(home, { recursive: true, force: true }); }
});

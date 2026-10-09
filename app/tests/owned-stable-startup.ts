import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recoveryWavHeader } from "../src/workers/recovery.js";

// Exercise the compiled production worker and consumers after the normal build.
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--app-root" || !args[1] || !isAbsolute(args[1]))) {
  throw new Error("Usage: owned-stable-startup [--app-root /absolute/compiled/application]");
}
const appRoot = await realpath(args[1] ?? fileURLToPath(new URL("..", import.meta.url)));
const { initializeStableLinuxProfile, initializeStableMacosProfile } = require(join(appRoot, "dist/main/stable-profile-startup.js")) as typeof import("../src/main/stable-profile-startup.js");
const { PreferenceStore } = require(join(appRoot, "dist/services/settings/preferences.js")) as typeof import("../src/services/settings/preferences.js");
const { ModelInventory } = require(join(appRoot, "dist/services/models/model-inventory.js")) as typeof import("../src/services/models/model-inventory.js");
const { PrivateAudioRecovery } = require(join(appRoot, "dist/workers/recovery.js")) as typeof import("../src/workers/recovery.js");
const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-compiled-stable-startup-"))), home = join(root, "home");
await mkdir(home, { mode: 0o700 });
try {
  if (process.platform === "darwin") {
    if (process.env["GITHUB_ACTIONS"] !== "true" || process.env["RUNNER_ENVIRONMENT"] !== "github-hosted") {
      throw new Error("The Mac compiled native snapshot check requires an owned GitHub-hosted account.");
    }
    const models = join(home, "Library/Application Support/WhisperFree/Models");
    await mkdir(models, { recursive: true, mode: 0o700 });
    await writeFile(join(models, "ggml-tiny.bin"), "Inert retained model", { mode: 0o644 });
    // Host facts are synthetic here; the worker's stopped-host/CFPreferences readers are real.
    // No legacy plist is seeded: the owned OS account must have an actually empty fixed domain.
    const context = { systemLanguage: "de-DE", loginStatus: "not-registered",
      defaults: { recommendedModel: "tiny", appleSilicon: process.arch === "arm64", launchAtLogin: false } };
    const profile = await initializeStableMacosProfile({ home, platform: "darwin" }, context);
    const store = await PreferenceStore.open(profile);
    assert.equal(store.snapshot().model, "tiny"); assert.equal(store.snapshot().language, "de");
    assert.equal(store.snapshot().launch_at_login, false);
    const catalog: unknown = JSON.parse(await readFile(join(appRoot, "dist/resources/models.json"), "utf8"));
    const inventory = await ModelInventory.open(profile, catalog);
    assert.equal((await inventory.installed())[0]?.verification, "legacy-owned-file");
    await store.patch({ vocabulary: "Edited private Mac state" });
    const repeated = await initializeStableMacosProfile({ home, platform: "darwin" }, undefined);
    assert.equal((await PreferenceStore.open(repeated)).snapshot().vocabulary, "Edited private Mac state");
    assert.equal(await (await PrivateAudioRecovery.open(profile.paths.recovery)).latest(), null);
    assert.equal(await readFile(join(models, "ggml-tiny.bin"), "utf8"), "Inert retained model");
    assert.equal((await readdir(profile.roots.config)).some((name) => name.startsWith(".electron-migration-")), false);
    console.log(JSON.stringify({ status: "PASS", scope: "compiled Mac worker, native empty-domain snapshot and production stores",
      hostFacts: "SYNTHETIC", legacyPlist: "ABSENT", preferenceWrites: false, microphone: false }));
  } else {
  const config = join(home, ".config/whisperfree"), recovery = join(config, "recovery"), models = join(home, ".local/share/whisperfree/models");
  await mkdir(recovery, { recursive: true, mode: 0o700 }); await mkdir(models, { recursive: true, mode: 0o700 });
  const source = JSON.stringify({ ui_language: "de", setup_completed: true, model: "tiny", gpu: false, gpu_configured: true,
    vocabulary: "東京 café", launch_at_login: true, auto_check_updates: true });
  await writeFile(join(config, "settings.json"), source, { mode: 0o600 });
  await writeFile(join(config, "history.json"), JSON.stringify(["Complete old history"]), { mode: 0o600 });
  await writeFile(join(models, "ggml-tiny.bin"), "Inert retained model", { mode: 0o644 });
  const id = "12345678-1234-4567-8123-123456789abc", header = recoveryWavHeader(2n), pcm = Buffer.alloc(8);
  pcm.writeFloatLE(0.25, 0); pcm.writeFloatLE(-0.25, 4);
  const originalAudio = Buffer.concat([header, pcm]), originalPath = join(recovery, `recording-00000001791410537123-${id}.wav`);
  await writeFile(originalPath, originalAudio, { mode: 0o600 });
  const profile = await initializeStableLinuxProfile({ home, platform: "linux" });
  const store = await PreferenceStore.open(profile);
  assert.equal(store.snapshot().vocabulary, "東京 café"); assert.equal(store.snapshot().launch_at_login, true);
  const catalog: unknown = JSON.parse(await readFile(join(appRoot, "dist/resources/models.json"), "utf8"));
  const inventory = await ModelInventory.open(profile, catalog);
  assert.equal((await inventory.installed())[0]?.verification, "legacy-owned-file");
  const saved = await PrivateAudioRecovery.open(profile.paths.recovery), token = await saved.latest();
  assert.equal(token?.id, id);
  const loaded = await saved.read({ id }, { generation: 1, attempt: 0, signal: new AbortController().signal });
  assert.equal(loaded.sampleCount, 2); assert.deepEqual(loaded.chunks.flatMap((chunk) => Array.from(chunk)), [0.25, -0.25]);
  await store.patch({ vocabulary: "Edited new settings" });
  const repeated = await initializeStableLinuxProfile({ home, platform: "linux" });
  assert.equal((await PreferenceStore.open(repeated)).snapshot().vocabulary, "Edited new settings");
  await saved.remove({ id }, { generation: 1, attempt: 0, signal: new AbortController().signal });
  const discarded = await initializeStableLinuxProfile({ home, platform: "linux" });
  assert.equal(await (await PrivateAudioRecovery.open(discarded.paths.recovery)).latest(), null);
  assert.equal(await readFile(join(config, "settings.json"), "utf8"), source); assert.deepEqual(await readFile(originalPath), originalAudio);
  assert.equal((await readdir(config)).some((name) => name.startsWith(".electron-migration-")), false);
  const partialHome = join(root, "partial-home"), partial = join(partialHome, ".config/whisperfree/electron");
  await mkdir(partial, { recursive: true, mode: 0o700 }); await writeFile(join(partial, "retained"), "Partial owned state", { mode: 0o600 });
  await assert.rejects(initializeStableLinuxProfile({ home: partialHome, platform: "linux" }), { message: "INCOMPLETE_STATE" });
  assert.deepEqual(await readdir(partial), ["retained"]); assert.equal(await readFile(join(partial, "retained"), "utf8"), "Partial owned state");
  await assert.rejects(initializeStableLinuxProfile({ home: join(root, "never-created"), platform: "darwin" }), { message: "UNSAFE_SOURCE" });
  await assert.rejects(readFile(join(root, "never-created")), { code: "ENOENT" });
  console.log(JSON.stringify({ status: "PASS", scope: "compiled Linux stable migration worker and production stores", microphone: false }));
  }
} finally { await rm(root, { recursive: true, force: true }); }

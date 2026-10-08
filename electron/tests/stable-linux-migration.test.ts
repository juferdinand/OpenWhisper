import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MAX_UI_REQUEST_BYTES } from "../src/contracts/ui.js";
import { resolveStableProfile, type StableProfile } from "../src/services/stable-profile.js";
import { PreferenceStore } from "../src/services/preferences.js";
import { ModelInventory } from "../src/services/model-inventory.js";
import { migrateStableLinuxProfile, StableLinuxMigrationError } from "../src/workers/stable-linux-migration.js";
import { recoveryWavHeader } from "../src/workers/recovery.js";

async function fixture(run: (profile: StableProfile, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openwhisper-stable-migration-")), home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  try { await run(resolveStableProfile({ home, platform: "linux" }), root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function file(path: string, bytes: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode });
}
function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function publication(profile: StableProfile): string { return join(profile.roots.config, "electron"); }
function stages(profile: StableProfile): string[] { return readdirSync(profile.roots.config).filter((name) => name.startsWith(".electron-migration-")); }
function code(value: string): (error: unknown) => boolean { return (error) => error instanceof StableLinuxMigrationError && error.code === value && error.message === value; }
const id = "12345678-1234-4567-8123-123456789abc", timestampMs = "00000001791410537123";
const wavName = (time = timestampMs): string => `recording-${time}-${id}.wav`;

test("fresh migration publishes all config children with legacy defaults and repeats without replay", { skip: process.platform !== "linux" }, async () => {
  await fixture(async (profile) => {
    const result = await migrateStableLinuxProfile(profile);
    assert.equal(result.status, "migrated"); assert.equal(result.recoveryCount, 0);
    const preferences = json(join(profile.paths.settings, "preferences.json")) as Record<string, unknown>;
    assert.equal(preferences["setup_completed"], false); assert.equal(preferences["gpu"], true);
    assert.equal(preferences["auto_check_updates"], true); assert.deepEqual(json(join(profile.paths.history, "history.json")), []);
    for (const path of Object.values(profile.paths)) if (path.startsWith(`${publication(profile)}/`)) assert.equal(lstatSync(path).mode & 0o7777, 0o700);
    file(join(profile.paths.settings, "preferences.json"), JSON.stringify({ ...preferences, setup_completed: true, vocabulary: "Edited current state" }));
    file(join(profile.paths.history, "history.json"), JSON.stringify(["Edited current history"]));
    file(profile.legacy.settings, JSON.stringify({ vocabulary: "Old state must not replay" }));
    const repeated = await migrateStableLinuxProfile(profile);
    assert.equal(repeated.status, "already-complete"); assert.equal(stages(profile).length, 0);
    assert.equal((json(join(profile.paths.settings, "preferences.json")) as Record<string, unknown>)["vocabulary"], "Edited current state");
    assert.deepEqual(json(join(profile.paths.history, "history.json")), ["Edited current history"]);
  });
});

test("migration retains raw JSON, full history, model permissions and streamed recovery identity/chronology", { skip: process.platform !== "linux" }, async () => {
  await fixture(async (profile) => {
    const rawSettings = Buffer.from('{\n "setup_completed": true, "gpu": false, "gpu_configured": true, "later_data": {"saved": "東京"}, "native_trigger": {"kind":"key","key":8205}, "hold_to_record":true\n}\n');
    const rawHistory = Buffer.from(JSON.stringify(Array.from({ length: 23 }, (_, index) => `Synthetic history ${index}`), null, 2));
    file(profile.legacy.settings, rawSettings, 0o644); file(profile.legacy.history, rawHistory, 0o644);
    file(join(profile.paths.models, "model.bin"), "Owned model sentinel", 0o644);
    chmodSync(profile.roots.config, 0o755); chmodSync(profile.roots.data, 0o755); chmodSync(profile.paths.models, 0o755);
    const payload = Buffer.alloc(1024 * 1024 + 28, 0x39), samples = BigInt(payload.length / 4);
    const wav = Buffer.concat([recoveryWavHeader(samples), payload]), source = join(profile.legacy.recovery!, wavName()); file(source, wav);
    const interrupted = join(profile.legacy.recovery!, `${wavName()}.tmp`), unrelated = join(profile.legacy.recovery!, "retained-original-sentinel");
    file(interrupted, "Interrupted legacy save bytes"); file(unrelated, "Unrelated original bytes", 0o644);
    const originals = [profile.legacy.settings, profile.legacy.history, source].map((path) => readFileSync(path));
    const result = await migrateStableLinuxProfile(profile), destination = join(profile.paths.recovery, `recording-${id}.wav`);
    assert.equal(result.recoveryCount, 1); assert.deepEqual(readFileSync(destination), wav);
    assert.equal(Math.round(lstatSync(destination).mtimeMs), Number(timestampMs)); assert.equal(lstatSync(destination).mode & 0o7777, 0o600);
    assert.deepEqual([profile.legacy.settings, profile.legacy.history, source].map((path) => readFileSync(path)), originals);
    assert.equal(readFileSync(interrupted, "utf8"), "Interrupted legacy save bytes"); assert.equal(readFileSync(unrelated, "utf8"), "Unrelated original bytes");
    assert.deepEqual(readFileSync(join(publication(profile), "legacy/settings.json")), rawSettings);
    assert.deepEqual(readFileSync(join(publication(profile), "legacy/history.json")), rawHistory);
    assert.equal((json(join(profile.paths.history, "history.json")) as unknown[]).length, 20);
    assert.equal(lstatSync(profile.roots.config).mode & 0o7777, 0o755); assert.equal(lstatSync(profile.paths.models).mode & 0o7777, 0o755);
    assert.equal(readFileSync(join(profile.paths.models, "model.bin"), "utf8"), "Owned model sentinel");
    const store = await PreferenceStore.open(profile), inventory = await ModelInventory.open(profile,
      JSON.parse(readFileSync(new URL("../../shared/models.json", import.meta.url), "utf8")));
    assert.equal(store.snapshot().gpu, false); assert.equal(store.snapshot().hold_to_record, true);
    assert.equal(inventory.belongsToProfile(profile), true); assert.equal(lstatSync(profile.paths.models).mode & 0o7777, 0o755);
    const manifest = json(result.completion) as { triggerReview: string[]; recovery: Record<string, unknown>[] };
    assert.deepEqual(manifest.triggerReview, ["KDE_LEGACY_SPECIAL_KEY"]);
    assert.deepEqual(manifest.recovery[0], { source: wavName(), target: `recording-${id}.wav`, id, timestampMs,
      bytes: String(wav.length), sha256: createHash("sha256").update(wav).digest("hex") });
    rmSync(destination); assert.equal((await migrateStableLinuxProfile(profile)).status, "already-complete");
  });
});

test("unsafe aliases, modes, malformed UTF8 and oversized legacy JSON fail before staging", { skip: process.platform !== "linux" }, async () => {
  for (const kind of ["symlink", "hardlink", "mode", "utf8", "oversize"] as const) await fixture(async (profile, root) => {
    const external = join(root, "sentinel.json"); file(external, "{}", 0o600); mkdirSync(profile.roots.config, { recursive: true, mode: 0o700 });
    if (kind === "symlink") symlinkSync(external, profile.legacy.settings);
    else if (kind === "hardlink") linkSync(external, profile.legacy.settings);
    else file(profile.legacy.settings, kind === "utf8" ? Buffer.from([0xff]) : kind === "oversize" ? Buffer.alloc(MAX_UI_REQUEST_BYTES + 1, 0x20) : "{}", kind === "mode" ? 0o666 : 0o600);
    if (kind === "mode") chmodSync(profile.legacy.settings, 0o666);
    await assert.rejects(migrateStableLinuxProfile(profile), code(kind === "utf8" || kind === "oversize" ? "INVALID_DATA" : "UNSAFE_SOURCE"));
    assert.equal(existsSync(publication(profile)), false); assert.deepEqual(stages(profile), []); assert.equal(readFileSync(external, "utf8"), "{}");
  });
});

test("partial published state and forged profiles are preserved and refused", { skip: process.platform !== "linux" }, async () => {
  await fixture(async (profile) => {
    file(join(publication(profile), "partial-owned-file"), "Unfinished state");
    await assert.rejects(migrateStableLinuxProfile(profile), code("INCOMPLETE_STATE"));
    assert.equal(readFileSync(join(publication(profile), "partial-owned-file"), "utf8"), "Unfinished state");
    assert.equal(existsSync(profile.roots.data), false);
    await assert.rejects(migrateStableLinuxProfile(structuredClone(profile)), code("STORAGE_FAILED"));
  });
});

test("unknown recovery names, duplicate UUIDs and unsafe timestamps do not publish or change original audio", { skip: process.platform !== "linux" }, async () => {
  for (const kind of ["unknown", "duplicate", "timestamp"] as const) await fixture(async (profile) => {
    const first = kind === "unknown" ? "unrecognized-owned-file.wav" : wavName(kind === "timestamp" ? "99999999999999999999" : timestampMs);
    file(join(profile.legacy.recovery!, first), "Owned inert audio bytes");
    if (kind === "duplicate") file(join(profile.legacy.recovery!, wavName("00000001791410538000")), "Second owned audio bytes");
    await assert.rejects(migrateStableLinuxProfile(profile), code(kind === "timestamp" ? "INVALID_TIMESTAMP" : "INVALID_DATA"));
    assert.equal(existsSync(publication(profile)), false); assert.equal(readFileSync(join(profile.legacy.recovery!, first), "utf8"), "Owned inert audio bytes");
  });
});

test("completion validation detects tampered raw backups without changing edited current state", { skip: process.platform !== "linux" }, async () => {
  await fixture(async (profile) => {
    file(profile.legacy.settings, "{}"); const result = await migrateStableLinuxProfile(profile);
    const settingsPath = join(profile.paths.settings, "preferences.json"), before = readFileSync(settingsPath);
    file(join(publication(profile), "legacy/settings.json"), '{"tampered":true}');
    await assert.rejects(migrateStableLinuxProfile(profile), code("INVALID_COMPLETION"));
    assert.deepEqual(readFileSync(settingsPath), before); assert.equal(readFileSync(profile.legacy.settings, "utf8"), "{}");
    assert.ok(existsSync(result.completion)); assert.deepEqual(stages(profile), []);
  });
});

test("source mutation retains private interrupted stage and unexpected contents without publication", { skip: process.platform !== "linux" }, async () => {
  await fixture(async (profile) => {
    file(profile.legacy.settings, "{}"); let retained: string | undefined;
    const watcher = watch(profile.roots.config, (_event, name) => {
      if (!retained && name?.startsWith(".electron-migration-")) {
        retained = join(profile.roots.config, name); file(join(retained, "unexpected"), "Retain unexpected contents");
        file(profile.legacy.settings, '{"vocabulary":"Changed during migration"}');
      }
    });
    try { await assert.rejects(migrateStableLinuxProfile(profile), code("SOURCE_CHANGED")); } finally { watcher.close(); }
    assert.ok(retained); assert.equal(lstatSync(retained).mode & 0o7777, 0o700);
    assert.equal(readFileSync(join(retained, "unexpected"), "utf8"), "Retain unexpected contents"); assert.equal(existsSync(publication(profile)), false);
    assert.equal((await migrateStableLinuxProfile(profile)).status, "migrated");
    assert.equal(readFileSync(join(retained, "unexpected"), "utf8"), "Retain unexpected contents");
  });
});

test("config directory replacement is refused while original private stage and sources survive", { skip: process.platform !== "linux" }, async () => {
  await fixture(async (profile, root) => {
    file(profile.legacy.settings, "{}"); let moved = false; const original = join(root, "retained-original-config");
    const watcher = watch(profile.roots.config, (_event, name) => {
      if (!moved && name?.startsWith(".electron-migration-")) { moved = true; renameSync(profile.roots.config, original); mkdirSync(profile.roots.config, { mode: 0o700 }); }
    });
    try { await assert.rejects(migrateStableLinuxProfile(profile), code("SOURCE_CHANGED")); } finally { watcher.close(); }
    assert.equal(moved, true); assert.equal(readFileSync(join(original, "settings.json"), "utf8"), "{}");
    assert.equal(existsSync(publication(profile)), false); assert.ok(readdirSync(original).some((name) => name.startsWith(".electron-migration-")));
  });
});

test("growing recovery source is rejected without copying beyond its captured size", { skip: process.platform !== "linux" }, async () => {
  await fixture(async (profile) => {
    const source = join(profile.legacy.recovery!, wavName()), original = Buffer.alloc(4 * 1024 * 1024, 0x31);
    file(source, original); let grew = false, destination: string | undefined; const watchers: FSWatcher[] = [];
    watchers.push(watch(profile.roots.config, (_event, name) => {
      if (name?.startsWith(".electron-migration-")) {
        const stage = join(profile.roots.config, name);
        watchers.push(watch(stage, (_childEvent, child) => {
          if (child === "recovery") watchers.push(watch(join(stage, "recovery"), (_audioEvent, audio) => {
            if (!grew && audio === `recording-${id}.wav`) {
              grew = true; destination = join(stage, "recovery", audio); appendFileSync(source, Buffer.alloc(128 * 1024, 0x32));
            }
          }));
        }));
      }
    }));
    try { await assert.rejects(migrateStableLinuxProfile(profile), code("SOURCE_CHANGED")); } finally { for (const watcher of watchers) watcher.close(); }
    assert.equal(grew, true); assert.ok(destination); assert.ok(lstatSync(destination).size <= original.length);
    assert.equal(lstatSync(source).size, original.length + 128 * 1024); assert.equal(existsSync(publication(profile)), false);
  });
});

test("real competing Linux publication cannot overwrite the winning complete directory", { skip: process.platform !== "linux" }, async () => {
  await fixture(async (profile) => {
    file(profile.legacy.settings, "{}");
    const results = await Promise.allSettled([migrateStableLinuxProfile(profile), migrateStableLinuxProfile(profile)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected"); assert.ok(rejected && rejected.status === "rejected");
    assert.ok(code("DESTINATION_EXISTS")(rejected.reason));
    assert.equal((await migrateStableLinuxProfile(profile)).status, "already-complete");
    assert.equal(stages(profile).length, 1); assert.equal(lstatSync(join(profile.roots.config, stages(profile)[0]!)).mode & 0o7777, 0o700);
  });
});

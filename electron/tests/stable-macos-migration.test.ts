import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { StableMigrationError } from "../src/contracts/stable-migration.js";
import { resolveStableProfile, type StableProfile } from "../src/services/stable-profile.js";
import { PreferenceStore } from "../src/services/preferences.js";
import { ModelInventory } from "../src/services/model-inventory.js";
import { decodeLegacyMacosPlist, type DecodedLegacyMacosPlist } from "../src/workers/macos-legacy-plist.js";
import { migrateStableMacosProfile, type MacosMigrationAccess } from "../src/workers/stable-macos-migration.js";

const context = { systemLanguage: "de-DE", loginStatus: "requires-approval", defaults: { recommendedModel: "tiny", appleSilicon: false, launchAtLogin: true } };
const ownedPlist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>uiLanguage</key><string>de</string><key>setupShown</key><true/>
<key>selectedModel</key><string>tiny</string><key>vocabulary</key><string>東京 café</string>
<key>outputMode</key><string>clipboard</string><key>recordingMode</key><string>hold</string>
<key>trigger</key><data>bnVsbA==</data><key>history</key><array><string>Original history</string></array>
<key>unknownDate</key><date>2020-01-02T03:04:05Z</date><key>__proto__</key><string>Original prototype key</string>
</dict></plist>`;
function file(path: string, bytes: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode });
}
async function fixture(run: (profile: StableProfile) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openwhisper-mac-archive-migration-")), home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  try { await run(resolveStableProfile({ home, platform: "darwin" })); } finally { rmSync(root, { recursive: true, force: true }); }
}
function access(snapshot: DecodedLegacyMacosPlist): MacosMigrationAccess {
  return { assertStopped() {}, snapshot: () => snapshot };
}
const publication = (profile: StableProfile): string => join(profile.roots.config, "electron");
const code = (expected: string) => (error: unknown): boolean => error instanceof StableMigrationError && error.code === expected;
const darwin = { skip: process.platform !== "darwin" };

test("Mac archive migration refuses other hosts before touching sources or admission", { skip: process.platform === "darwin" }, async () => {
  await fixture(async (profile) => {
    await assert.rejects(migrateStableMacosProfile(profile, context, { assertStopped() { assert.fail("Unexpected admission"); },
      snapshot() { assert.fail("Unexpected snapshot"); } }), code("UNSAFE_SOURCE"));
    assert.equal(existsSync(profile.roots.config), false);
  });
});

test("Mac migration retains exact archives, typed data, draft snippets, models and pending login facts", darwin, async () => {
  await fixture(async (profile) => {
    file(profile.legacy.settings, ownedPlist, 0o644);
    const snippets = JSON.stringify([{ id: "00000000-0000-0000-0000-000000000000", trigger: "", expansion: "", enabled: false }]);
    file(profile.legacy.snippets, snippets, 0o644); file(join(profile.paths.models, "ggml-tiny.bin"), "Owned model bytes", 0o644);
    const originalModel = lstatSync(join(profile.paths.models, "ggml-tiny.bin"));
    const decoded = decodeLegacyMacosPlist(Buffer.from(ownedPlist));
    let stopped = 0, snapshots = 0;
    const result = await migrateStableMacosProfile(profile, context, { assertStopped() { stopped++; }, snapshot() { snapshots++; return decoded; } });
    assert.equal(result.status, "migrated"); assert.equal(result.recoveryCount, 0); assert.ok(stopped >= 3); assert.equal(snapshots, 2);
    const store = await PreferenceStore.open(profile);
    assert.equal(store.snapshot().vocabulary, "東京 café"); assert.equal(store.snapshot().hold_to_record, true);
    assert.equal(store.snapshot().launch_at_login, true); assert.equal(store.snapshot().snippets[0]?.expansion, "");
    assert.equal(readFileSync(profile.legacy.settings, "utf8"), ownedPlist);
    assert.equal(readFileSync(profile.legacy.snippets, "utf8"), snippets);
    assert.equal(readFileSync(join(publication(profile), "legacy/preferences.plist"), "utf8"), ownedPlist);
    const retained = JSON.parse(readFileSync(join(publication(profile), "legacy/decoded.json"), "utf8")) as DecodedLegacyMacosPlist;
    assert.equal(retained.plist["__proto__"], "Original prototype key"); assert.deepEqual(retained.nativeValues, decoded.nativeValues);
    const conversion = JSON.parse(readFileSync(join(publication(profile), "legacy/conversion.json"), "utf8")) as { context: typeof context };
    assert.equal(conversion.context.loginStatus, "requires-approval");
    assert.deepEqual(JSON.parse(readFileSync(join(profile.paths.history, "history.json"), "utf8")), ["Original history"]);
    const inventory = await ModelInventory.open(profile, JSON.parse(readFileSync(new URL("../../shared/models.json", import.meta.url), "utf8")) as unknown);
    assert.equal((await inventory.installed())[0]?.verification, "legacy-owned-file");
    const model = lstatSync(join(profile.paths.models, "ggml-tiny.bin"));
    assert.equal(model.ino, originalModel.ino); assert.equal(model.mode, originalModel.mode);
    for (const path of Object.values(profile.paths)) if (path.startsWith(`${publication(profile)}/`)) assert.equal(lstatSync(path).mode & 0o7777, 0o700);
    await store.patch({ vocabulary: "Edited current state" });
    file(join(profile.paths.history, "history.json"), '["Edited history"]');
    const repeated = await migrateStableMacosProfile(profile, undefined, { assertStopped() { assert.fail("Completed state must not reimport"); },
      snapshot() { assert.fail("Completed state must not query old preferences"); } });
    assert.equal(repeated.status, "already-complete");
    assert.equal((await PreferenceStore.open(profile)).snapshot().vocabulary, "Edited current state");
    assert.deepEqual(JSON.parse(readFileSync(join(profile.paths.history, "history.json"), "utf8")), ["Edited history"]);
  });
});

test("Mac cache disagreement and unknown first login state refuse before publication", darwin, async () => {
  await fixture(async (profile) => {
    file(profile.legacy.settings, ownedPlist);
    await assert.rejects(migrateStableMacosProfile(profile, undefined, access({ plist: {}, nativeValues: [] })), code("LOGIN_STATE_UNKNOWN"));
    await assert.rejects(migrateStableMacosProfile(profile, context, access({ plist: {}, nativeValues: [] })), code("PREFERENCES_SNAPSHOT_INCOHERENT"));
    assert.equal(existsSync(publication(profile)), false); assert.equal(readFileSync(profile.legacy.settings, "utf8"), ownedPlist);
  });
});

test("a changed final Mac snapshot keeps the private interrupted stage and original bytes", darwin, async () => {
  await fixture(async (profile) => {
    file(profile.legacy.settings, ownedPlist); const decoded = decodeLegacyMacosPlist(Buffer.from(ownedPlist)); let reads = 0;
    await assert.rejects(migrateStableMacosProfile(profile, context, { assertStopped() {},
      snapshot: () => ++reads === 1 ? decoded : { plist: {}, nativeValues: [] } }), code("PREFERENCES_SNAPSHOT_INCOHERENT"));
    assert.equal(existsSync(publication(profile)), false);
    const stages = readdirSync(profile.roots.config).filter((name) => name.startsWith(".electron-migration-"));
    assert.equal(stages.length, 1); assert.equal(lstatSync(join(profile.roots.config, stages[0]!)).mode & 0o7777, 0o700);
    assert.equal(readFileSync(profile.legacy.settings, "utf8"), ownedPlist);
  });
});

test("source mutation during the final native query is refused before exclusive Mac publication", darwin, async () => {
  await fixture(async (profile) => {
    file(profile.legacy.settings, ownedPlist); const decoded = decodeLegacyMacosPlist(Buffer.from(ownedPlist)); let reads = 0;
    await assert.rejects(migrateStableMacosProfile(profile, context, { assertStopped() {}, snapshot() {
      if (++reads === 2) file(profile.legacy.settings, `${ownedPlist}\n`);
      return decoded;
    } }), code("SOURCE_CHANGED"));
    assert.equal(existsSync(publication(profile)), false);
    assert.equal(readFileSync(profile.legacy.settings, "utf8"), `${ownedPlist}\n`);
    assert.equal(readdirSync(profile.roots.config).filter((name) => name.startsWith(".electron-migration-")).length, 1);
  });
});

test("Mac migration rejects unsafe source aliases and permissions without replacing originals", darwin, async () => {
  for (const kind of ["symlink", "hardlink", "permissions"] as const) await fixture(async (profile) => {
    file(profile.legacy.settings, ownedPlist);
    if (kind === "permissions") chmodSync(profile.legacy.settings, 0o666);
    else {
      const other = `${profile.legacy.settings}.owned`; rmSync(profile.legacy.settings); file(other, ownedPlist);
      if (kind === "symlink") symlinkSync(other, profile.legacy.settings); else linkSync(other, profile.legacy.settings);
    }
    await assert.rejects(migrateStableMacosProfile(profile, context, access({ plist: {}, nativeValues: [] })), code("UNSAFE_SOURCE"));
    assert.equal(existsSync(publication(profile)), false);
  });
});

test("Mac partial publication and modified raw backup are refused without replaying current state", darwin, async () => {
  await fixture(async (profile) => {
    file(join(publication(profile), "unexpected"), "Retained partial bytes");
    await assert.rejects(migrateStableMacosProfile(profile, context), code("INCOMPLETE_STATE"));
    assert.equal(readFileSync(join(publication(profile), "unexpected"), "utf8"), "Retained partial bytes");
  });
  await fixture(async (profile) => {
    file(profile.legacy.settings, ownedPlist);
    await migrateStableMacosProfile(profile, context, access(decodeLegacyMacosPlist(Buffer.from(ownedPlist))));
    const before = readFileSync(join(profile.paths.settings, "preferences.json"));
    file(join(publication(profile), "legacy/preferences.plist"), "Changed backup");
    await assert.rejects(migrateStableMacosProfile(profile, context), code("INVALID_COMPLETION"));
    assert.deepEqual(readFileSync(join(profile.paths.settings, "preferences.json")), before);
  });
});

test("exclusive Mac publication preserves a concurrent winner", darwin, async () => {
  await fixture(async (profile) => {
    const profile2 = resolveStableProfile({ home: dirname(dirname(dirname(profile.legacy.settings))), platform: "darwin" });
    const shared = access({ plist: {}, nativeValues: [] });
    const results = await Promise.allSettled([migrateStableMacosProfile(profile, context, shared), migrateStableMacosProfile(profile2, context, shared)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(code("DESTINATION_EXISTS")(rejected.reason) || code("SOURCE_CHANGED")(rejected.reason));
    assert.equal((await migrateStableMacosProfile(profile, undefined)).status, "already-complete");
  });
});

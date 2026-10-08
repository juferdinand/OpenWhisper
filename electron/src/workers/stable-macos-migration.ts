import { randomUUID } from "node:crypto";
import { constants, lstatSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, relative, sep } from "node:path";
import { z } from "zod";
import { MAX_UI_REQUEST_BYTES, MAX_USER_TEXT_BYTES, preferencesSchema } from "../contracts/ui.js";
import { StableMigrationError } from "../contracts/stable-migration.js";
import { convertLegacyMacosData, legacyMacosMigrationContextSchema } from "../services/legacy-macos-data.js";
import { prepareStableProfileStorage, validateStableProfile, type StableProfile } from "../services/stable-profile.js";
import { decodedLegacyMacosPlistSchema, decodeLegacyMacosPlist, type DecodedLegacyMacosPlist } from "./macos-legacy-plist.js";
import { assertLegacyMacosHostStopped, readLegacyMacosPreferencesSnapshot } from "./macos-migration-admission.js";
import { fail, byteSource, jsonSource, optional, safeDirectory, sameDirectory, directoryUnchanged,
  unchanged, stillAbsent, sha256, writeFile, jsonBytes, syncDirectory, type ByteSource } from "./migration-files.js";

const backupSchema = z.strictObject({ bytes: z.int().min(0).max(MAX_UI_REQUEST_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const reviewSchema = z.array(z.enum(["MAC_NATIVE_TRIGGER", "MAC_DEFAULT_TRIGGER", "MAC_EDITOR_OUTPUT", "MAC_EDITOR_PATH",
  "MAC_HOLD_MODE", "MAC_HARDWARE_GPU", "MAC_HISTORY_OVERFLOW", "MAC_HISTORY_DISABLED", "MAC_UNMAPPED_PREFERENCES"])).max(9);
const completionSchema = z.strictObject({ version: z.literal(1), appId: z.literal("io.github.whisperfree"),
  sourceFormat: z.literal("macos-v0.2.5"), preferences: backupSchema.nullable(), snippets: backupSchema.nullable(),
  decoded: backupSchema, conversion: backupSchema, review: reviewSchema });
const historySchema = z.array(z.string().max(MAX_USER_TEXT_BYTES).refine((text) => Buffer.byteLength(text, "utf8") <= MAX_USER_TEXT_BYTES)).max(20);

/** Native preference access stays outside filesystem policy; owned fixtures use explicit synthetic snapshots. */
export interface MacosMigrationAccess {
  assertStopped(): void;
  snapshot(): DecodedLegacyMacosPlist;
}
const nativeAccess: MacosMigrationAccess = { assertStopped: assertLegacyMacosHostStopped, snapshot: readLegacyMacosPreferencesSnapshot };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`;
  return JSON.stringify(value);
}
function snapshotIdentity(value: DecodedLegacyMacosPlist): string {
  const checked = decodedLegacyMacosPlistSchema.parse(value);
  return canonical({ plist: checked.plist, nativeValues: [...checked.nativeValues].sort((a, b) =>
    canonical(a.path).localeCompare(canonical(b.path), "en")) });
}
function agree(access: MacosMigrationAccess, decoded: DecodedLegacyMacosPlist): void {
  access.assertStopped();
  if (snapshotIdentity(access.snapshot()) !== snapshotIdentity(decoded)) throw new StableMigrationError("PREFERENCES_SNAPSHOT_INCOHERENT");
}
const backup = (source: ByteSource): z.infer<typeof backupSchema> | null => source.bytes ? { bytes: source.bytes.length, sha256: sha256(source.bytes) } : null;

async function completed(profile: StableProfile, publication: string): Promise<void> {
  try {
    validateStableProfile(profile);
    const manifest = completionSchema.parse((await jsonSource(join(publication, "migration.json"), true)).value);
    safeDirectory(await lstat(join(publication, "legacy"), { bigint: true }), true);
    for (const [name, expected] of [["preferences.plist", manifest.preferences], ["snippets.json", manifest.snippets],
      ["decoded.json", manifest.decoded], ["conversion.json", manifest.conversion]] as const) {
      const path = join(publication, "legacy", name);
      if (!expected) { if (await optional(path)) fail("INVALID_COMPLETION"); continue; }
      const raw = await byteSource(path, true);
      if (!raw.bytes || raw.bytes.length !== expected.bytes || sha256(raw.bytes) !== expected.sha256) fail("INVALID_COMPLETION");
    }
    decodedLegacyMacosPlistSchema.parse((await jsonSource(join(publication, "legacy/decoded.json"), true)).value);
    preferencesSchema.parse((await jsonSource(join(profile.paths.settings, "preferences.json"), true)).value);
    historySchema.parse((await jsonSource(join(profile.paths.history, "history.json"), true)).value);
    for (const path of Object.values(profile.paths)) if (path.startsWith(`${publication}${sep}`)) safeDirectory(await lstat(path, { bigint: true }), true);
  } catch { fail("INVALID_COMPLETION"); }
}

/** Snapshot and publish the whole private configuration; never overwrite, rewrite or remove legacy data. */
export async function migrateStableMacosProfile(profile: StableProfile, context: unknown,
  access: MacosMigrationAccess = nativeAccess): Promise<{ status: "migrated" | "already-complete"; completion: string; recoveryCount: number }> {
  let configIdentity: BigIntStats | undefined;
  try {
    if (process.platform !== "darwin" || profile.platform !== "darwin" || ["browser", "renderer"].includes(String(Reflect.get(process, "type")))) fail("UNSAFE_SOURCE");
    validateStableProfile(profile);
    const publication = join(profile.roots.config, "electron"), completion = join(publication, "migration.json");
    if (await optional(publication)) {
      if (!(await optional(completion))) fail("INCOMPLETE_STATE");
      await completed(profile, publication);
      return { status: "already-complete", completion, recoveryCount: 0 };
    }
    if (context === undefined) fail("LOGIN_STATE_UNKNOWN");
    const checkedContext = legacyMacosMigrationContextSchema.parse(context);
    const { loginStatus: _loginStatus, ...conversionContext } = checkedContext;
    access.assertStopped();
    const initialConfig = await optional(profile.roots.config);
    const preferences = await byteSource(profile.legacy.settings, false, true);
    const snippets = await jsonSource(profile.legacy.snippets, false, true);
    const decoded = preferences.bytes ? decodeLegacyMacosPlist(preferences.bytes) : decodedLegacyMacosPlistSchema.parse({ plist: {}, nativeValues: [] });
    agree(access, decoded);
    const converted = convertLegacyMacosData({ ...conversionContext, ...(preferences.source ? { plist: decoded.plist } : {}),
      ...(snippets.source ? { snippets: snippets.value } : {}) });
    const decodedBytes = jsonBytes(decoded), conversionBytes = jsonBytes({ context: checkedContext, legacy: converted.legacy,
      history: converted.preserved.history, snippets: converted.preserved.snippets, review: converted.review });
    const manifest = completionSchema.parse({ version: 1, appId: profile.appId, sourceFormat: "macos-v0.2.5",
      preferences: backup(preferences), snippets: backup(snippets), decoded: { bytes: decodedBytes.length, sha256: sha256(decodedBytes) },
      conversion: { bytes: conversionBytes.length, sha256: sha256(conversionBytes) }, review: converted.review });
    const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
    const system = koffi.load("/usr/lib/libSystem.B.dylib");
    let parent: FileHandle | undefined;
    try {
      let publish: (...args: unknown[]) => unknown;
      try { publish = system.func("int renameatx_np(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)"); }
      catch { return fail("PUBLICATION_UNAVAILABLE"); }
      prepareStableProfileStorage(profile);
      const originalConfig = await lstat(profile.roots.config, { bigint: true }); safeDirectory(originalConfig, false);
      configIdentity = originalConfig;
      if (initialConfig && !sameDirectory(initialConfig, originalConfig)) fail("SOURCE_CHANGED");
      parent = await open(profile.roots.config, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!sameDirectory(originalConfig, await parent.stat({ bigint: true }))) fail("SOURCE_CHANGED");
      const stage = join(profile.roots.config, `.electron-migration-${randomUUID()}`);
      await mkdir(stage, { mode: 0o700 }); const stageIdentity = await lstat(stage, { bigint: true }); safeDirectory(stageIdentity, true);
      const children = Object.values(profile.paths).filter((path) => path.startsWith(`${publication}${sep}`)).map((path) => relative(publication, path));
      for (const child of [...children, "legacy"]) await mkdir(join(stage, child), { mode: 0o700 });
      for (const [name, source] of [["preferences.plist", preferences], ["snippets.json", snippets]] as const)
        if (source.bytes) await writeFile(join(stage, "legacy", name), source.bytes);
      await writeFile(join(stage, "legacy/decoded.json"), decodedBytes);
      await writeFile(join(stage, "legacy/conversion.json"), conversionBytes);
      await writeFile(join(stage, "settings/preferences.json"), jsonBytes(converted.preferences));
      await writeFile(join(stage, "history/history.json"), jsonBytes(converted.history));
      await writeFile(join(stage, "migration.json"), jsonBytes(manifest));
      for (const child of [...children, "legacy"]) await syncDirectory(join(stage, child));
      await syncDirectory(stage);
      agree(access, decoded);
      // No asynchronous operation may intervene between these checks and exclusive publication.
      validateStableProfile(profile);
      if (!directoryUnchanged(profile.roots.config, originalConfig)) fail("SOURCE_CHANGED");
      const finalStage = lstatSync(stage, { bigint: true }); safeDirectory(finalStage, true);
      if (!sameDirectory(stageIdentity, finalStage)) fail("SOURCE_CHANGED");
      for (const [path, source] of [[profile.legacy.settings, preferences], [profile.legacy.snippets, snippets]] as const)
        if (source.source) unchanged(source.source); else stillAbsent(path);
      if (publish(parent.fd, basename(stage), parent.fd, "electron", 4) !== 0) {
        if (koffi.errno() === 17) fail("DESTINATION_EXISTS"); fail("PUBLICATION_UNAVAILABLE");
      }
      await parent.sync(); validateStableProfile(profile);
      if (!directoryUnchanged(profile.roots.config, originalConfig)) fail("SOURCE_CHANGED");
      return { status: "migrated", completion, recoveryCount: 0 };
    } finally { try { await parent?.close(); } finally { system.unload(); } }
  } catch (error: unknown) {
    if (error instanceof StableMigrationError) throw error;
    if (configIdentity && !directoryUnchanged(profile.roots.config, configIdentity)) fail("SOURCE_CHANGED");
    if (error instanceof Error && (error.name === "LegacyMacosDataError" || error.name === "LegacyMacosPlistError" || error.name === "ZodError")) fail("INVALID_DATA");
    return fail("STORAGE_FAILED");
  }
}

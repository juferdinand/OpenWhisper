import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readdirSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { MAX_UI_REQUEST_BYTES, MAX_USER_TEXT_BYTES, preferencesSchema } from "../contracts/ui.js";
import { convertLegacyLinuxData, convertLegacyLinuxRecoveryNames } from "../services/legacy-linux-data.js";
import { prepareStableProfileStorage, validateStableProfile, type StableProfile } from "../services/stable-profile.js";
import { StableMigrationError as StableLinuxMigrationError } from "../contracts/stable-migration.js";
import { fail, optional, safeFile, safeDirectory, sourceFile, unchanged, directoryUnchanged, stillAbsent,
  same, sameDirectory, sha256, jsonSource, writeFile, jsonBytes, syncDirectory, type Source, type JsonSource } from "./migration-files.js";

export { StableLinuxMigrationError };
const digest = z.string().regex(/^[0-9a-f]{64}$/u), decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const backupSchema = z.strictObject({ bytes: z.int().min(0).max(MAX_UI_REQUEST_BYTES), sha256: digest });
const completionSchema = z.strictObject({ version: z.literal(1), appId: z.literal("io.github.whisperfree"),
  sourceFormat: z.literal("linux-v0.2.5"), settings: backupSchema.nullable(), history: backupSchema.nullable(),
  triggerReview: z.array(z.enum(["KDE_MOUSE_TRIGGER", "KDE_MODIFIER_TRIGGER", "KDE_LEGACY_SPECIAL_KEY", "INVALID_X11_TRIGGER"])).max(4),
  recovery: z.array(z.strictObject({ source: z.string().max(128), target: z.string().max(128), id: z.string(),
    timestampMs: z.string().regex(/^[0-9]{20}$/u), bytes: decimal, sha256: digest })).max(100_000) });
const historySchema = z.array(z.string().max(MAX_USER_TEXT_BYTES).refine((text) => Buffer.byteLength(text, "utf8") <= MAX_USER_TEXT_BYTES)).max(20);
function timestamp(value: string): number {
  const milliseconds = BigInt(value);
  if (milliseconds > 8_640_000_000_000_000n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) fail("INVALID_TIMESTAMP");
  return Number(milliseconds);
}
async function copyRecovery(source: Source, destination: string, timestampMs: string): Promise<{ bytes: string; sha256: string }> {
  const { source: opened, file } = await sourceFile(source.path, true);
  if (!same(source.stats, opened.stats)) { await file.close(); fail("SOURCE_CHANGED"); }
  let output: FileHandle | undefined;
  try {
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.alloc(64 * 1024), hash = createHash("sha256"); let bytes = 0n;
    while (bytes < source.stats.size) {
      const remaining = source.stats.size - bytes, length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
      const read = await file.read(buffer, 0, length, null); if (!read.bytesRead) fail("SOURCE_CHANGED");
      hash.update(buffer.subarray(0, read.bytesRead)); bytes += BigInt(read.bytesRead);
      let offset = 0; while (offset < read.bytesRead) { const written = await output.write(buffer, offset, read.bytesRead - offset, null);
        if (!written.bytesWritten) fail("STORAGE_FAILED"); offset += written.bytesWritten; }
    }
    if ((await file.read(buffer, 0, 1, null)).bytesRead !== 0) fail("SOURCE_CHANGED");
    if (bytes !== source.stats.size || !same(source.stats, await file.stat({ bigint: true }))) fail("SOURCE_CHANGED");
    unchanged(source); const milliseconds = timestamp(timestampMs), time = new Date(milliseconds);
    await output.utimes(time, time); await output.sync();
    // Filesystems must retain the exact millisecond chronology represented by the name.
    if (Math.round(Number((await output.stat({ bigint: true })).mtimeNs) / 1_000_000) !== milliseconds) fail("INVALID_TIMESTAMP");
    return { bytes: bytes.toString(), sha256: hash.digest("hex") };
  } finally { try { await output?.close(); } finally { await file.close(); } }
}
async function completed(profile: StableProfile, publication: string): Promise<number> {
  try {
    validateStableProfile(profile); const manifest = completionSchema.parse((await jsonSource(join(publication, "migration.json"), true)).value);
    safeDirectory(await lstat(join(publication, "legacy"), { bigint: true }), true);
    const names = convertLegacyLinuxRecoveryNames(manifest.recovery.map((item) => item.source));
    for (const [index, mapped] of names.entries()) {
      const item = manifest.recovery[index]!;
      if (item.id !== mapped.id || item.target !== mapped.target || item.timestampMs !== mapped.timestampMs) fail("INVALID_COMPLETION");
      timestamp(item.timestampMs);
    }
    for (const name of ["settings", "history"] as const) {
      const expected = manifest[name], path = join(publication, "legacy", `${name}.json`);
      if (!expected) { if (await optional(path)) fail("INVALID_COMPLETION"); continue; }
      const raw = await jsonSource(path, true);
      if (!raw.bytes || raw.bytes.length !== expected.bytes || sha256(raw.bytes) !== expected.sha256) fail("INVALID_COMPLETION");
    }
    preferencesSchema.parse((await jsonSource(join(profile.paths.settings, "preferences.json"), true)).value);
    historySchema.parse((await jsonSource(join(profile.paths.history, "history.json"), true)).value);
    for (const path of Object.values(profile.paths)) if (path.startsWith(`${publication}${sep}`)) {
      const stats = await lstat(path, { bigint: true }); safeDirectory(stats, true);
    }
    return manifest.recovery.length;
  } catch (error: unknown) { if (error instanceof StableLinuxMigrationError && error.code === "INVALID_COMPLETION") throw error;
    return fail("INVALID_COMPLETION"); }
}

/** Run only in a migration utility/worker. No audio/native bindings are loaded in main or renderer. */
export async function migrateStableLinuxProfile(profile: StableProfile): Promise<{
  status: "migrated" | "already-complete"; completion: string; recoveryCount: number;
}> {
  let configIdentity: BigIntStats | undefined;
  try {
    if (process.platform !== "linux" || profile.platform !== "linux" || ["browser", "renderer"].includes(String(Reflect.get(process, "type")))) fail("UNSAFE_SOURCE");
    validateStableProfile(profile); const publication = join(profile.roots.config, "electron"), completion = join(publication, "migration.json");
    if (await optional(publication)) {
      if (!(await optional(completion))) fail("INCOMPLETE_STATE");
      return { status: "already-complete", completion, recoveryCount: await completed(profile, publication) };
    }
    const initialConfig = await optional(profile.roots.config);
    const settings = await jsonSource(profile.legacy.settings, false, true), history = await jsonSource(profile.legacy.history, false, true);
    const converted = convertLegacyLinuxData({ ...(settings.source ? { settings: settings.value } : {}), ...(history.source ? { history: history.value } : {}) });
    const recoveryPath = profile.legacy.recovery!, recoveryDirectory = await optional(recoveryPath);
    if (recoveryDirectory) safeDirectory(recoveryDirectory, false);
    const names = recoveryDirectory ? (await readdir(recoveryPath)).sort() : [];
    // Interrupted legacy writes and unrelated originals stay untouched; unknown WAVs still fail closed.
    const mappings = convertLegacyLinuxRecoveryNames(names.filter((name) => name.endsWith(".wav")));
    const audio: Source[] = [];
    for (const mapping of mappings) { timestamp(mapping.timestampMs); const path = join(recoveryPath, mapping.source), stats = await lstat(path, { bigint: true });
      safeFile(stats, true); audio.push({ path, stats }); }
    const backup = (source: JsonSource): z.infer<typeof backupSchema> | null => source.bytes ? { bytes: source.bytes.length, sha256: sha256(source.bytes) } : null;
    // Bound completion metadata before copying any potentially large recordings.
    jsonBytes({ version: 1, appId: profile.appId, sourceFormat: "linux-v0.2.5", settings: backup(settings), history: backup(history),
      triggerReview: converted.triggerReview, recovery: mappings.map((mapping, index) => ({ ...mapping, bytes: audio[index]!.stats.size.toString(), sha256: "0".repeat(64) })) });
    // Fail unavailable publication before creating a stage. There is deliberately no rename fallback.
    const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi"), libc = koffi.load("libc.so.6");
    let parent: FileHandle | undefined;
    try {
      let publish: (...args: unknown[]) => unknown;
      try { publish = libc.func("int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)"); }
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
      for (const [name, source] of [["settings", settings], ["history", history]] as const) if (source.bytes) await writeFile(join(stage, "legacy", `${name}.json`), source.bytes);
      await writeFile(join(stage, "settings/preferences.json"), jsonBytes(converted.preferences));
      await writeFile(join(stage, "history/history.json"), jsonBytes(converted.history));
      const recovered: z.infer<typeof completionSchema>["recovery"] = [];
      for (const [index, mapping] of mappings.entries()) recovered.push({ ...mapping,
        ...await copyRecovery(audio[index]!, join(stage, "recovery", mapping.target), mapping.timestampMs) });
      const manifest = completionSchema.parse({ version: 1, appId: profile.appId, sourceFormat: "linux-v0.2.5",
        settings: backup(settings), history: backup(history), triggerReview: converted.triggerReview, recovery: recovered });
      await writeFile(join(stage, "migration.json"), jsonBytes(manifest));
      for (const child of [...children, "legacy"]) await syncDirectory(join(stage, child)); await syncDirectory(stage);
      validateStableProfile(profile);
      if (!sameDirectory(originalConfig, lstatSync(profile.roots.config, { bigint: true })) ||
        !sameDirectory(stageIdentity, lstatSync(stage, { bigint: true }))) fail("SOURCE_CHANGED");
      for (const source of [settings.source, history.source, ...audio]) if (source) unchanged(source);
      for (const source of [settings, history]) if (!source.source && await optional(source === settings ? profile.legacy.settings : profile.legacy.history)) fail("SOURCE_CHANGED");
      if (recoveryDirectory) {
        if (!sameDirectory(recoveryDirectory, lstatSync(recoveryPath, { bigint: true })) || JSON.stringify((await readdir(recoveryPath)).sort()) !== JSON.stringify(names)) fail("SOURCE_CHANGED");
      } else if (await optional(recoveryPath)) fail("SOURCE_CHANGED");
      // Recheck synchronously after the final await; publish relative to the retained original parent fd.
      validateStableProfile(profile);
      if (!sameDirectory(originalConfig, lstatSync(profile.roots.config, { bigint: true }))) fail("SOURCE_CHANGED");
      const finalStage = lstatSync(stage, { bigint: true }); safeDirectory(finalStage, true);
      if (!sameDirectory(stageIdentity, finalStage)) fail("SOURCE_CHANGED");
      for (const source of [settings.source, history.source, ...audio]) if (source) unchanged(source);
      if (!settings.source) stillAbsent(profile.legacy.settings);
      if (!history.source) stillAbsent(profile.legacy.history);
      if (recoveryDirectory && (!directoryUnchanged(recoveryPath, recoveryDirectory) ||
        JSON.stringify(readdirSync(recoveryPath).sort()) !== JSON.stringify(names))) fail("SOURCE_CHANGED");
      if (!recoveryDirectory) stillAbsent(recoveryPath);
      if (publish(parent.fd, basename(stage), parent.fd, "electron", 1) !== 0) {
        if (koffi.errno() === 17) fail("DESTINATION_EXISTS"); fail("PUBLICATION_UNAVAILABLE");
      }
      await parent.sync(); validateStableProfile(profile);
      if (!sameDirectory(originalConfig, lstatSync(profile.roots.config, { bigint: true }))) fail("SOURCE_CHANGED");
      return { status: "migrated", completion, recoveryCount: recovered.length };
    } finally { try { await parent?.close(); } finally { libc.unload(); } }
  } catch (error: unknown) {
    if (error instanceof StableLinuxMigrationError) throw error;
    if (configIdentity && !directoryUnchanged(profile.roots.config, configIdentity)) return fail("SOURCE_CHANGED");
    if (error instanceof Error && error.name === "LegacyLinuxDataError") fail("INVALID_DATA");
    return fail("STORAGE_FAILED");
  }
}

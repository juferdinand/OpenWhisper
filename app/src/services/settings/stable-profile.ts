import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { developmentProfileInputSchema, developmentProfileSchema } from "./profiles.js";

const absolutePath = developmentProfileInputSchema.shape.home.refine((path) => !/[\u0000-\u001f\u007f]/u.test(path));
export const stableProfileInputSchema = z.strictObject({
  home: absolutePath, platform: z.enum(["linux", "darwin"]),
  configHome: absolutePath.optional(), dataHome: absolutePath.optional(), cacheHome: absolutePath.optional(),
});
export const stableMacosMigrationRequestSchema = z.strictObject({
  profile: stableProfileInputSchema.extend({ platform: z.literal("darwin") }), context: z.unknown(),
});
export const stableProfileSchema = z.strictObject({
  appId: z.literal("io.github.whisperfree"), productName: z.literal("OpenWhisper"), platform: z.enum(["linux", "darwin"]),
  roots: developmentProfileSchema.unwrap().shape.roots,
  paths: developmentProfileSchema.unwrap().shape.paths,
  legacy: z.strictObject({ settings: absolutePath, history: absolutePath, snippets: absolutePath,
    models: absolutePath, recovery: absolutePath.nullable(), transcripts: absolutePath.nullable() }).readonly(),
  // These permit host capabilities; saved opt-ins and platform permissions still control every action.
  flags: z.strictObject({ globalTriggers: z.literal(true), autoPaste: z.literal(true),
    autostart: z.literal(true), stableUpdater: z.literal(true) }).readonly(),
}).readonly();
export type StableProfile = z.infer<typeof stableProfileSchema>;

interface Context { readonly home: string; readonly uid: number; readonly directories: readonly string[];
  readonly privateRoots: readonly string[]; readonly ownedRoots: readonly string[]; readonly inspected: readonly string[] }
const resolved = new WeakMap<StableProfile, Context>();
const devNames = new Set(["io.github.whisperfree.dev", "io-github-whisperfree-dev", "openwhisper-dev", "openwhisper dev", "whisperfree dev"]);
const contains = (parent: string, path: string): boolean => {
  const left = resolve(parent).toLowerCase(), right = resolve(path).toLowerCase();
  return left === right || right.startsWith(`${left.endsWith(sep) ? left.slice(0, -1) : left}${sep}`);
};
function separate(paths: readonly string[]): void {
  for (const [index, path] of paths.entries()) for (const other of paths.slice(index + 1)) {
    if (contains(path, other) || contains(other, path)) throw new Error("Stable storage bases and roots must not overlap.");
  }
}
function ancestry(path: string): string[] {
  const paths: string[] = [];
  for (let cursor = path;; cursor = dirname(cursor)) { paths.push(cursor); if (dirname(cursor) === cursor) return paths.reverse(); }
}
function existing(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
function check(path: string, value: Stats, context: Context): void {
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("Stable profile directories must have no symlinks.");
  const mode = value.mode & 0o7777;
  if (context.privateRoots.some((root) => contains(root, path))) {
    if (value.uid !== context.uid || mode !== 0o700) throw new Error("Existing stable private directories must be user-owned with mode 0700.");
  } else {
    const sticky = value.uid === 0 && (mode & 0o1000) !== 0;
    if ((value.uid !== context.uid && value.uid !== 0) || ((mode & 0o022) !== 0 && !sticky)) {
      throw new Error("Stable profile ancestors require safe ownership and permissions.");
    }
    if ((path === context.home || context.ownedRoots.includes(path)) && value.uid !== context.uid) {
      throw new Error("Stable profile home and storage roots must belong to this user.");
    }
  }
}
function validate(context: Context): void {
  const checked = new Set<string>();
  for (const directory of context.inspected) for (const path of ancestry(directory)) {
    if (checked.has(path)) continue;
    checked.add(path); const value = existing(path); if (value) check(path, value, context);
  }
  if (!existing(context.home)) throw new Error("Stable profile requires an existing user-owned home.");
}

/** Resolve fixed stable destinations and legacy source references without reading or migrating user files. */
export function resolveStableProfile(options: unknown): StableProfile {
  const input = stableProfileInputSchema.parse(options), uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error("Stable profiles require a non-root host with filesystem ownership support.");
  if (input.platform === "darwin" && [input.configHome, input.dataHome, input.cacheHome].some((path) => path !== undefined)) {
    throw new Error("Mac stable storage uses fixed Library paths, not XDG overrides.");
  }
  const bases = input.platform === "linux" ? [input.configHome ?? join(input.home, ".config"),
    input.dataHome ?? join(input.home, ".local/share"), input.cacheHome ?? join(input.home, ".cache")] : [];
  separate(bases);
  if (bases.some((path) => ["whisperfree", "openwhisper", "io.github.whisperfree", "io-github-whisperfree"].includes(path.split(sep).at(-1)!.toLowerCase()))) {
    throw new Error("XDG bases must not already name application storage.");
  }
  for (const path of [input.home, ...bases]) if (path.split(sep).some((part) => devNames.has(part.toLowerCase()))) {
    throw new Error("Stable profiles must not alias development storage.");
  }
  const roots = input.platform === "linux" ? { config: join(bases[0]!, "whisperfree"), data: join(bases[1]!, "whisperfree"), cache: join(bases[2]!, "whisperfree") }
    : { config: join(input.home, "Library/Application Support/io.github.whisperfree"),
      data: join(input.home, "Library/Application Support/WhisperFree"), cache: join(input.home, "Library/Caches/io.github.whisperfree") };
  separate(Object.values(roots));
  const config = join(roots.config, "electron"), data = join(roots.data, "electron"), cache = join(roots.cache, "electron");
  const models = join(roots.data, input.platform === "darwin" ? "Models" : "models");
  const plist = join(input.home, "Library/Preferences/io.github.whisperfree.plist");
  const transcripts = input.platform === "darwin" ? join(roots.data, existing(join(roots.data, "Diktate")) ? "Diktate" : "Transcripts") : null;
  const profile = stableProfileSchema.parse({ appId: "io.github.whisperfree", productName: "OpenWhisper", platform: input.platform, roots,
    paths: { settings: join(config, "settings"), models, downloads: join(data, "downloads"), snippets: join(config, "snippets"),
      history: join(config, "history"), transcripts: join(data, "transcripts"), recovery: join(config, "recovery"),
      logs: join(cache, "logs"), cache: join(cache, "cache"), session: join(cache, "session"), locks: join(config, "locks"), control: join(config, "control") },
    legacy: { settings: input.platform === "linux" ? join(roots.config, "settings.json") : plist,
      history: input.platform === "linux" ? join(roots.config, "history.json") : plist,
      snippets: input.platform === "linux" ? join(roots.config, "settings.json") : join(roots.data, "snippets.json"),
      models, recovery: input.platform === "linux" ? join(roots.config, "recovery") : null, transcripts },
    flags: { globalTriggers: true, autoPaste: true, autostart: true, stableUpdater: true } });
  const directories = [...new Set([...Object.values(roots), ...Object.values(profile.paths)])];
  const context: Context = { home: input.home, uid, directories, privateRoots: [config, data, cache],
    ownedRoots: [...Object.values(roots), models], inspected: [...new Set([input.home, ...bases, ...directories,
      dirname(profile.legacy.settings), ...(profile.legacy.recovery ? [profile.legacy.recovery] : []), ...(transcripts ? [transcripts] : [])])] };
  validate(context); resolved.set(profile, context); return profile;
}

/** Recheck trusted profile provenance and directories without creating anything. */
export function validateStableProfile(profile: StableProfile): StableProfile {
  const context = resolved.get(profile);
  if (!context) throw new Error("Stable profiles must be resolved in this process before preparation.");
  validate(context); return profile;
}

function prepare(profile: StableProfile, storageOnly: boolean): StableProfile {
  validateStableProfile(profile);
  const context = resolved.get(profile)!;
  const publication = join(profile.roots.config, "electron");
  for (const directory of context.directories.filter((path) => !storageOnly || !contains(publication, path))) for (const path of ancestry(directory)) {
    if (!existing(path)) {
      for (const ancestor of ancestry(dirname(path))) {
        const value = existing(ancestor); if (!value) throw new Error("Stable profile ancestor disappeared."); check(ancestor, value, context);
      }
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    }
    const value = existing(path); if (!value) throw new Error("Stable directory creation failed."); check(path, value, context);
  }
  validate(context); return profile;
}

/** Leave the complete config/electron unit for atomic migration publication. */
export function prepareStableProfileStorage(profile: StableProfile): StableProfile { return prepare(profile, true); }

/** Create directories only. Never chmod, delete, rename or read existing legacy data. */
export function prepareStableProfile(profile: StableProfile): StableProfile { return prepare(profile, false); }

import { lstatSync, mkdirSync, renameSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { StableMigrationError } from "../../contracts/migration/stable-migration.js";
import { previousStableStorageRoots, stableProfileInputSchema, stableStorageBases, stableStorageRoots, type StableStorageRoots } from "./stable-profile.js";

type StableStorageRoot = keyof StableStorageRoots;
export interface StableStorageRelocation {
  /** Roots moved from their pre-#65 location in this call. */
  readonly moved: readonly StableStorageRoot[];
  /** Roots whose previous location was left untouched because the new one already exists. */
  readonly keptPrevious: readonly StableStorageRoot[];
  /** Cache roots that could not be moved; caches are rebuilt and never block startup. */
  readonly skippedCache: boolean;
}
export interface StableStorageRelocationOptions {
  readonly rename?: (from: string, to: string) => void;
  readonly uid?: number;
}

function existing(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
/** A directory another local user cannot replace: user-owned (or root for system ancestors), no symlink, no group/world write. */
function trusted(value: Stats | undefined, uid: number, ownedByUser: boolean): boolean {
  if (!value || !value.isDirectory() || value.isSymbolicLink()) return false;
  const mode = value.mode & 0o7777, sticky = value.uid === 0 && (mode & 0o1000) !== 0;
  if (ownedByUser ? value.uid !== uid : value.uid !== uid && value.uid !== 0) return false;
  return (mode & 0o022) === 0 || (!ownedByUser && sticky);
}
function ancestors(path: string): string[] {
  const paths: string[] = [];
  for (let cursor = dirname(path); ; cursor = dirname(cursor)) { paths.unshift(cursor); if (dirname(cursor) === cursor) return paths; }
}

/**
 * Moves pre-#65 storage roots to the product-named roots once, before the stable profile is
 * resolved. Each root moves with one same-volume rename, so a root is either entirely at its
 * old or entirely at its new location. Nothing is copied or merged: when a new root already
 * exists the old one is left untouched. A persistent root that cannot be renamed (for example
 * across volumes) stops startup with RELOCATION_FAILED instead of starting with empty data.
 */
export function relocateStableStorage(options: unknown, relocation: StableStorageRelocationOptions = {}): StableStorageRelocation {
  const input = stableProfileInputSchema.parse(options), uid = relocation.uid ?? process.getuid?.();
  if (uid === undefined || uid === 0) throw new StableMigrationError("UNSAFE_SOURCE");
  const rename = relocation.rename ?? renameSync;
  const bases = stableStorageBases(input);
  const previous = previousStableStorageRoots(input.platform, input.home, bases), next = stableStorageRoots(input.platform, input.home, bases);
  const moved: StableStorageRoot[] = [], keptPrevious: StableStorageRoot[] = [];
  let skippedCache = false;
  // Config and data move before the cache so a refused cache move never strands settings.
  for (const root of ["config", "data", "cache"] as const) {
    const from = previous[root], to = next[root], persistent = root !== "cache";
    const source = existing(from);
    if (!source) continue;
    if (existing(to)) { keptPrevious.push(root); continue; }
    try {
      if (!trusted(source, uid, true)) throw new StableMigrationError("UNSAFE_SOURCE");
      for (const ancestor of ancestors(to)) {
        let value = existing(ancestor);
        if (!value && ancestor.startsWith(`${input.home}/`)) { mkdirSync(ancestor, { mode: 0o700 }); value = existing(ancestor); }
        if (!trusted(value, uid, ancestor === input.home || ancestor.startsWith(`${input.home}/`))) throw new StableMigrationError("UNSAFE_SOURCE");
      }
      // Recheck immediately before the atomic rename; another starting instance may have moved it.
      if (existing(to)) { keptPrevious.push(root); continue; }
      try { rename(from, to); }
      catch (error: unknown) {
        if (!existing(from) && existing(to)) continue;
        throw new StableMigrationError(error instanceof Error && "code" in error && error.code === "EXDEV" ? "RELOCATION_FAILED" : "STORAGE_FAILED");
      }
      moved.push(root);
    } catch (error: unknown) {
      if (persistent) throw error instanceof StableMigrationError ? error : new StableMigrationError("RELOCATION_FAILED");
      skippedCache = true;
    }
  }
  return { moved, keptPrevious, skippedCache };
}

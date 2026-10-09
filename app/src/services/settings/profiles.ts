import { lstatSync, mkdirSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { z } from 'zod';

const absolutePathSchema = z.string().min(1).refine(
  (value) => isAbsolute(value) && !value.includes('\0')
    && !value.split(sep).some((part) => part === '.' || part === '..'),
  { message: 'Profile paths must be absolute and contain no traversal components or null bytes.' },
).transform((value) => resolve(value));

export const developmentProfileInputSchema = z.strictObject({
  home: absolutePathSchema,
  configHome: absolutePathSchema.optional(),
  dataHome: absolutePathSchema.optional(),
  cacheHome: absolutePathSchema.optional(),
  explicitRoot: absolutePathSchema.optional(),
});

/** All paths name directories; services choose their own files within them. */
export const developmentProfileSchema = z.strictObject({
  appId: z.literal('io.github.whisperfree.dev'),
  productName: z.literal('OpenWhisper Dev'),
  roots: z.strictObject({
    config: absolutePathSchema,
    data: absolutePathSchema,
    cache: absolutePathSchema,
  }).readonly(),
  paths: z.strictObject({
    settings: absolutePathSchema,
    models: absolutePathSchema,
    downloads: absolutePathSchema,
    snippets: absolutePathSchema,
    history: absolutePathSchema,
    transcripts: absolutePathSchema,
    recovery: absolutePathSchema,
    logs: absolutePathSchema,
    cache: absolutePathSchema,
    session: absolutePathSchema,
    locks: absolutePathSchema,
    control: absolutePathSchema,
  }).readonly(),
  flags: z.strictObject({
    globalTriggers: z.literal(false),
    autoPaste: z.literal(false),
    autostart: z.literal(false),
    stableUpdater: z.literal(false),
  }).readonly(),
}).readonly();

export type DevelopmentProfileOptions = z.input<typeof developmentProfileInputSchema>;
export type DevelopmentProfile = z.output<typeof developmentProfileSchema>;

interface ProfileContext {
  readonly home: string;
  readonly bases: readonly string[];
  readonly directories: readonly string[];
  readonly privateRoots: readonly string[];
  readonly uid: number;
}

// A schema validates the serialized shape, not filesystem provenance. Preparation
// only accepts an immutable profile resolved in this process, then checks it again.
const resolvedProfiles = new WeakMap<DevelopmentProfile, ProfileContext>();
const stableNames = ['whisperfree', 'openwhisper', 'io.github.whisperfree', 'io-github-whisperfree'];

function containsPath(parent: string, child: string): boolean {
  // Conservatively apply case-insensitive comparisons on every supported host.
  const normalizedParent = resolve(parent).toLowerCase();
  const normalizedChild = resolve(child).toLowerCase();
  return normalizedParent === normalizedChild
    || normalizedChild.startsWith(normalizedParent.endsWith(sep)
      ? normalizedParent : `${normalizedParent}${sep}`);
}

function overlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}

function requireSeparate(paths: readonly string[], description: string): void {
  for (const [index, left] of paths.entries()) {
    for (const right of paths.slice(index + 1)) {
      if (overlap(left, right)) {
        throw new Error(`${description} must not overlap.`);
      }
    }
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('Private development profiles require filesystem ownership support.');
  }
  return process.getuid();
}

function existingStats(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function ancestry(path: string): string[] {
  const paths: string[] = [];
  let cursor = path;
  while (true) {
    paths.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return paths.reverse();
}

function isPrivateDirectory(path: string, context: ProfileContext): boolean {
  return context.privateRoots.some((root) => containsPath(root, path));
}

function checkDirectory(path: string, stats: Stats, context: ProfileContext): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Development profile paths must be directories without symlinks.');
  }
  const mode = stats.mode & 0o7777;
  if (isPrivateDirectory(path, context)) {
    if (stats.uid !== context.uid || mode !== 0o700) {
      throw new Error('Existing development profile directories must be owned by this user and have mode 0700.');
    }
    return;
  }
  // Standard system ancestors may be root-owned. A root-owned sticky directory
  // such as /tmp is permitted; all newly created profile ancestors remain 0700.
  const sharedTemporaryAncestor = stats.uid === 0 && (mode & 0o1000) !== 0;
  if ((stats.uid !== context.uid && stats.uid !== 0)
    || ((mode & 0o022) !== 0 && !sharedTemporaryAncestor)) {
    throw new Error('Development profile ancestors must have safe ownership and permissions.');
  }
}

function validateExistingDirectories(context: ProfileContext): void {
  const checked = new Set<string>();
  for (const directory of [context.home, ...context.bases, ...context.directories]) {
    for (const path of ancestry(directory)) {
      if (checked.has(path)) continue;
      checked.add(path);
      const stats = existingStats(path);
      if (stats !== undefined) checkDirectory(path, stats, context);
    }
  }
  const homeStats = existingStats(context.home);
  if (homeStats === undefined || homeStats.uid !== context.uid) {
    throw new Error('The development profile home must be an existing directory owned by this user.');
  }
}

function stableDirectories(home: string, bases: readonly string[]): string[] {
  const storageBases = new Set([
    home,
    join(home, '.config'),
    join(home, '.local', 'share'),
    join(home, '.cache'),
    join(home, 'Library', 'Application Support'),
    join(home, 'Library', 'Caches'),
    ...bases,
  ]);
  return [
    ...Array.from(storageBases).flatMap((base) => stableNames.map((name) => join(base, name))),
    join(home, 'Library', 'Preferences', 'io.github.whisperfree.plist'),
  ];
}

/** Resolve a development profile without creating, reading, or migrating data files. */
export function resolveDevelopmentProfile(options: unknown): DevelopmentProfile {
  const input = developmentProfileInputSchema.parse(options);
  const configHome = input.configHome ?? join(input.home, '.config');
  const dataHome = input.dataHome ?? join(input.home, '.local', 'share');
  const cacheHome = input.cacheHome ?? join(input.home, '.cache');
  const bases = [configHome, dataHome, cacheHome];
  requireSeparate(bases, 'Configuration, data, and cache base directories');
  if (bases.some((base) => stableNames.includes(parse(base).base.toLowerCase()))) {
    throw new Error('XDG base directories must not name stable OpenWhisper or WhisperFree storage.');
  }

  const explicitRoot = input.explicitRoot;
  if (explicitRoot !== undefined && bases.some((base) => overlap(explicitRoot, base))) {
    throw new Error('The explicit development root must not overlap configuration, data, or cache base directories.');
  }
  const roots = explicitRoot === undefined ? {
    config: join(configHome, 'io.github.whisperfree.dev'),
    data: join(dataHome, 'io.github.whisperfree.dev'),
    cache: join(cacheHome, 'io.github.whisperfree.dev'),
  } : {
    config: join(explicitRoot, 'config'),
    data: join(explicitRoot, 'data'),
    cache: join(explicitRoot, 'cache'),
  };
  const privateRoots = explicitRoot === undefined ? Object.values(roots) : [explicitRoot];
  requireSeparate(Object.values(roots), 'Development profile storage roots');
  const stableRoots = stableDirectories(input.home, bases);
  if (privateRoots.some((root) => stableRoots.some((stable) => overlap(root, stable)))
    || (explicitRoot !== undefined && stableNames.includes(parse(explicitRoot).base.toLowerCase()))) {
    throw new Error('Development profiles must not overlap stable OpenWhisper or WhisperFree storage.');
  }

  const profile = developmentProfileSchema.parse({
    appId: 'io.github.whisperfree.dev',
    productName: 'OpenWhisper Dev',
    roots,
    paths: {
      settings: join(roots.config, 'settings'),
      models: join(roots.data, 'models'),
      downloads: join(roots.data, 'downloads'),
      snippets: join(roots.config, 'snippets'),
      history: join(roots.data, 'history'),
      transcripts: join(roots.data, 'transcripts'),
      recovery: join(roots.data, 'recovery'),
      logs: join(roots.data, 'logs'),
      cache: roots.cache,
      session: join(roots.cache, 'session'),
      locks: join(roots.cache, 'locks'),
      control: join(roots.cache, 'control'),
    },
    flags: { globalTriggers: false, autoPaste: false, autostart: false, stableUpdater: false },
  });
  const context: ProfileContext = {
    home: input.home,
    bases,
    directories: [...new Set([...privateRoots, ...Object.values(roots), ...Object.values(profile.paths)])],
    privateRoots,
    uid: currentUid(),
  };
  validateExistingDirectories(context);
  resolvedProfiles.set(profile, context);
  return profile;
}

/** Create private directories only. Existing directories are checked, never chmodded. */
export function prepareDevelopmentProfile(profile: DevelopmentProfile): DevelopmentProfile {
  const context = resolvedProfiles.get(profile);
  if (context === undefined) {
    throw new Error('Development profiles must be resolved in this process before preparation.');
  }
  // Preflight every path before any mutation, including changes since resolution.
  validateExistingDirectories(context);
  for (const directory of context.directories) {
    for (const path of ancestry(directory)) {
      if (existingStats(path) === undefined) {
        // Recheck ancestors before each mkdir. The private roots prevent access by
        // other users; this is not a sandbox against another process with this UID.
        for (const ancestor of ancestry(dirname(path))) {
          const stats = existingStats(ancestor);
          if (stats === undefined) throw new Error('Development profile ancestor disappeared.');
          checkDirectory(ancestor, stats, context);
        }
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error: unknown) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
      const stats = existingStats(path);
      if (stats === undefined) throw new Error('Development profile directory creation failed.');
      checkDirectory(path, stats, context);
    }
  }
  validateExistingDirectories(context);
  return profile;
}

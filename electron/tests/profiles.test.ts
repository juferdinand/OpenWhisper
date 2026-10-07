import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import {
  developmentProfileInputSchema, developmentProfileSchema,
  prepareDevelopmentProfile, resolveDevelopmentProfile,
} from '../src/services/profiles.js';
import type { DevelopmentProfile } from '../src/services/profiles.js';

interface Fixture {
  readonly root: string;
  readonly home: string;
}

function withFixture(run: (fixture: Fixture) => void): void {
  // macOS exposes some temporary paths through system symlinks. Tests deliberately
  // use the canonical owned fixture root, not a symlink exception in the resolver.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'openwhisper-profile-test-'));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  try {
    run({ root, home });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface SnapshotEntry {
  readonly mode: number;
  readonly bytes?: string;
}

function snapshotTree(root: string): Record<string, SnapshotEntry> {
  const entries: Record<string, SnapshotEntry> = {};
  function visit(path: string): void {
    const stats = lstatSync(path);
    const name = relative(root, path) || '.';
    entries[name] = stats.isDirectory()
      ? { mode: stats.mode & 0o7777 }
      : { mode: stats.mode & 0o7777, bytes: readFileSync(path).toString('hex') };
    if (stats.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    }
  }
  visit(root);
  return entries;
}

function directories(profile: DevelopmentProfile): string[] {
  return [...new Set([...Object.values(profile.roots), ...Object.values(profile.paths)])];
}

function installStableFixtures(home: string): string[] {
  const roots = [
    join(home, '.config', 'whisperfree'),
    join(home, '.local', 'share', 'whisperfree'),
    join(home, '.cache', 'whisperfree'),
    join(home, 'Library', 'Application Support', 'WhisperFree'),
    join(home, 'Library', 'Caches', 'io.github.whisperfree'),
    join(home, 'Library', 'Preferences'),
    join(home, '.config', 'autostart'),
  ];
  for (const root of roots) mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [index, root] of roots.entries()) {
    writeFileSync(join(root, index === 5 ? 'io.github.whisperfree.plist' : 'stable-data.bin'),
      Buffer.from([0, index, 255, 17]), { mode: 0o600 });
  }
  return roots;
}

test('resolution is read-only and returns isolated immutable directories and disabled behavior', () => {
  withFixture(({ home }) => {
    const before = snapshotTree(home);
    const profile = resolveDevelopmentProfile({ home });
    assert.deepEqual(snapshotTree(home), before);
    assert.equal(profile.appId, 'io.github.whisperfree.dev');
    assert.equal(profile.productName, 'OpenWhisper Dev');
    assert.deepEqual(profile.flags, {
      globalTriggers: false, autoPaste: false, autostart: false, stableUpdater: false,
    });
    assert.deepEqual(profile.roots, {
      config: join(home, '.config', 'io.github.whisperfree.dev'),
      data: join(home, '.local', 'share', 'io.github.whisperfree.dev'),
      cache: join(home, '.cache', 'io.github.whisperfree.dev'),
    });
    assert.deepEqual(Object.keys(profile.paths).sort(), [
      'settings', 'models', 'downloads', 'snippets', 'history', 'transcripts',
      'recovery', 'logs', 'cache', 'session', 'locks', 'control',
    ].sort());
    for (const path of directories(profile)) {
      assert.ok(isAbsolute(path));
      assert.ok(Object.values(profile.roots).some((root) => path === root || path.startsWith(`${root}${sep}`)));
      assert.equal(existsSync(path), false);
    }
    for (const value of [profile, profile.roots, profile.paths, profile.flags]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.equal(developmentProfileSchema.safeParse(profile).success, true);
    assert.equal(developmentProfileSchema.safeParse({ ...profile, appId: 'io.github.whisperfree' }).success, false);
    assert.equal(developmentProfileSchema.safeParse({ ...profile, flags: { ...profile.flags, autoPaste: true } }).success, false);
  });
});

test('preparation preserves all stable bytes and modes and creates only private development directories', () => {
  withFixture(({ home }) => {
    const stableRoots = installStableFixtures(home);
    const before = stableRoots.map(snapshotTree);
    const profile = resolveDevelopmentProfile({ home });
    assert.strictEqual(prepareDevelopmentProfile(profile), profile);
    for (const path of directories(profile)) {
      const stats = lstatSync(path);
      assert.ok(stats.isDirectory());
      assert.equal(stats.mode & 0o7777, 0o700);
      assert.equal(stats.uid, process.getuid?.());
    }
    assert.deepEqual(stableRoots.map(snapshotTree), before);
    writeFileSync(join(profile.paths.settings, 'preferences.json'), '{"interfaceLanguage":"de"}', { mode: 0o600 });
    const prepared = Object.values(profile.roots).map(snapshotTree);
    assert.strictEqual(prepareDevelopmentProfile(profile), profile);
    assert.deepEqual(Object.values(profile.roots).map(snapshotTree), prepared);
    assert.deepEqual(stableRoots.map(snapshotTree), before);
  });
});

test('custom XDG bases and a separate explicit root produce distinct development storage', () => {
  withFixture(({ root, home }) => {
    const input = {
      home, configHome: join(root, 'xdg-config'), dataHome: join(root, 'xdg-data'), cacheHome: join(root, 'xdg-cache'),
    };
    const xdgProfile = resolveDevelopmentProfile(input);
    assert.equal(xdgProfile.roots.config, join(input.configHome, 'io.github.whisperfree.dev'));
    assert.equal(xdgProfile.roots.data, join(input.dataHome, 'io.github.whisperfree.dev'));
    assert.equal(xdgProfile.roots.cache, join(input.cacheHome, 'io.github.whisperfree.dev'));
    const explicitRoot = join(root, 'separate-profile');
    const profile = resolveDevelopmentProfile({ ...input, explicitRoot });
    assert.deepEqual(profile.roots, {
      config: join(explicitRoot, 'config'), data: join(explicitRoot, 'data'), cache: join(explicitRoot, 'cache'),
    });
    prepareDevelopmentProfile(profile);
    assert.equal(lstatSync(explicitRoot).mode & 0o7777, 0o700);
    assert.deepEqual(readdirSync(home), []);
    assert.equal(existsSync(input.configHome), false);
    assert.equal(existsSync(input.dataHome), false);
    assert.equal(existsSync(input.cacheHome), false);
  });
});

test('relative, traversal, null-byte and unexpected options fail before any filesystem mutation', () => {
  withFixture(({ root, home }) => {
    const before = snapshotTree(root);
    for (const input of [
      { home: 'relative' }, { home, configHome: 'relative' }, { home, explicitRoot: 'relative' },
      { home, explicitRoot: `${root}/one/../two` }, { home, explicitRoot: `${root}/bad\0path` },
      { home, cacheHome: null }, { home, migrateStable: true },
    ]) {
      assert.equal(developmentProfileInputSchema.safeParse(input).success, false);
      assert.throws(() => resolveDevelopmentProfile(input));
    }
    assert.deepEqual(snapshotTree(root), before);
  });
});

test('stable storage, its ancestors, and explicit roots overlapping XDG bases are rejected', () => {
  withFixture(({ root, home }) => {
    installStableFixtures(home);
    const before = snapshotTree(root);
    const prohibited = [
      home, join(home, '.config'), join(home, '.local'), join(home, '.cache'),
      join(home, '.config', 'whisperfree'), join(home, '.config', 'whisperfree', 'dev'),
      join(home, 'WhisperFree'), join(home, 'openwhisper'),
      join(home, 'Library'), join(home, 'Library', 'Application Support'),
      join(home, 'Library', 'Application Support', 'WhisperFree'),
      join(root, 'WhisperFree'), join(root, 'whisperfree'), join(root, 'OpenWhisper'),
    ];
    for (const explicitRoot of prohibited) assert.throws(() => resolveDevelopmentProfile({ home, explicitRoot }));
    const configHome = join(root, 'custom-config');
    const dataHome = join(root, 'custom-data');
    const cacheHome = join(root, 'custom-cache');
    for (const explicitRoot of [root, configHome, join(configHome, 'dev'), join(dataHome, 'dev'), cacheHome]) {
      assert.throws(() => resolveDevelopmentProfile({ home, configHome, dataHome, cacheHome, explicitRoot }));
    }
    assert.throws(() => resolveDevelopmentProfile({ home, configHome: join(root, 'WhisperFree') }));
    assert.deepEqual(snapshotTree(root), before);
  });
});

test('configuration, data, and cache bases may not alias or contain each other', () => {
  withFixture(({ root, home }) => {
    const configHome = join(root, 'storage');
    const before = snapshotTree(root);
    for (const input of [
      { home, configHome, dataHome: configHome },
      { home, configHome, dataHome: join(configHome, 'data') },
      { home, dataHome: configHome, cacheHome: join(configHome, 'cache') },
      { home, configHome, cacheHome: configHome.toUpperCase() },
    ]) assert.throws(() => resolveDevelopmentProfile(input), /must not overlap/);
    assert.deepEqual(snapshotTree(root), before);
  });
});

test('symlink roots and ancestors are refused without accessing or modifying the target data', () => {
  withFixture(({ root, home }) => {
    const stable = join(root, 'stable-target');
    mkdirSync(stable, { mode: 0o700 });
    writeFileSync(join(stable, 'sentinel'), 'preserve this owned fixture', { mode: 0o600 });
    const before = snapshotTree(stable);
    const link = join(root, 'profile-link');
    symlinkSync(stable, link, 'dir');
    assert.throws(() => resolveDevelopmentProfile({ home, explicitRoot: link }), /without symlinks/);
    assert.throws(() => resolveDevelopmentProfile({ home, explicitRoot: join(link, 'profile') }), /without symlinks/);
    assert.throws(() => resolveDevelopmentProfile({ home: link }), /without symlinks/);
    assert.deepEqual(snapshotTree(stable), before);
  });
});

test('preparation revalidates every planned directory before creating any missing root', () => {
  withFixture(({ root, home }) => {
    const stable = join(root, 'stable-target');
    mkdirSync(stable, { mode: 0o700 });
    writeFileSync(join(stable, 'sentinel'), 'unchanged', { mode: 0o600 });
    const before = snapshotTree(stable);
    const explicitRoot = join(root, 'development');
    const profile = resolveDevelopmentProfile({ home, explicitRoot });
    mkdirSync(profile.roots.data, { recursive: true, mode: 0o700 });
    symlinkSync(stable, profile.paths.models, 'dir');
    assert.throws(() => prepareDevelopmentProfile(profile), /without symlinks/);
    assert.equal(existsSync(profile.roots.config), false);
    assert.equal(existsSync(profile.roots.cache), false);
    assert.deepEqual(snapshotTree(stable), before);
  });
});

test('an explicit profile cannot bypass symlink validation of supplied XDG bases', () => {
  withFixture(({ root, home }) => {
    const explicitRoot = join(root, 'development');
    mkdirSync(explicitRoot, { mode: 0o700 });
    const configHome = join(root, 'xdg-config-link');
    symlinkSync(explicitRoot, configHome, 'dir');
    assert.throws(() => resolveDevelopmentProfile({ home, explicitRoot, configHome }), /without symlinks/);
    assert.deepEqual(readdirSync(explicitRoot), []);
    assert.deepEqual(readdirSync(home), []);
  });
});

test('existing nonprivate directories and files are rejected without permission repairs', () => {
  withFixture(({ root, home }) => {
    const explicitRoot = join(root, 'nonprivate-profile');
    mkdirSync(explicitRoot, { mode: 0o700 });
    chmodSync(explicitRoot, 0o755);
    writeFileSync(join(explicitRoot, 'sentinel'), 'retain', { mode: 0o600 });
    const before = snapshotTree(explicitRoot);
    assert.throws(() => resolveDevelopmentProfile({ home, explicitRoot }), /mode 0700/);
    assert.deepEqual(snapshotTree(explicitRoot), before);
    const fileRoot = join(root, 'file-profile');
    writeFileSync(fileRoot, 'a file is not a directory', { mode: 0o600 });
    assert.throws(() => resolveDevelopmentProfile({ home, explicitRoot: fileRoot }), /must be directories/);
    assert.equal(readFileSync(fileRoot, 'utf8'), 'a file is not a directory');
    const profile = resolveDevelopmentProfile({ home, explicitRoot: join(root, 'new-profile') });
    prepareDevelopmentProfile(profile);
    chmodSync(profile.paths.settings, 0o750);
    assert.throws(() => prepareDevelopmentProfile(profile), /mode 0700/);
    assert.equal(lstatSync(profile.paths.settings).mode & 0o7777, 0o750);
  });
});

test('missing or unsafe home and writable nonsticky ancestors are refused', () => {
  withFixture(({ root, home }) => {
    assert.throws(() => resolveDevelopmentProfile({ home: join(root, 'missing-home') }), /existing directory/);
    const unsafe = join(root, 'unsafe-ancestor');
    mkdirSync(unsafe, { mode: 0o700 });
    chmodSync(unsafe, 0o777);
    assert.throws(() => resolveDevelopmentProfile({ home, explicitRoot: join(unsafe, 'development') }), /safe ownership and permissions/);
    assert.equal(readdirSync(unsafe).length, 0);
    assert.equal(lstatSync(unsafe).mode & 0o7777, 0o777);
  });
});

test('serialized or modified profile shapes cannot bypass the resolver before preparation', () => {
  withFixture(({ root, home }) => {
    const profile = resolveDevelopmentProfile({ home });
    const copy = developmentProfileSchema.parse(profile);
    assert.throws(() => prepareDevelopmentProfile(copy), /resolved in this process/);
    const changed: DevelopmentProfile = { ...profile, roots: { ...profile.roots, config: home } };
    assert.throws(() => prepareDevelopmentProfile(changed), /resolved in this process/);
    assert.deepEqual(readdirSync(home), []);
    assert.deepEqual(readdirSync(root), ['home']);
  });
});

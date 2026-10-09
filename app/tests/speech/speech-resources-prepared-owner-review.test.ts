import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSpeechResources, verifySpeechResource, type SpeechResourceFiles } from "../../src/services/speech/speech-resources.js";
import { SpeechWorkerError } from "../../src/services/speech/speech-client.js";

const bytes = Buffer.from("independent owned prepared-handle fixture");
const host = { platform: "linux", architecture: "x64" } as const;
const entry = { backend: "cpu", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } as const;
const catalog = { version: 1, ...host, napiVersion: 8,
  speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
  speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde", entries: [entry] };
const code = (expected: "INTEGRITY_FAILED" | "TEARDOWN_FAILED") =>
  (error: unknown): boolean => error instanceof SpeechWorkerError && error.code === expected;

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve = (): void => { throw new Error("Deferred is not initialized."); };
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve: () => { resolve(); } };
}

interface Fixture {
  readonly firstRoot: string;
  readonly secondRoot: string;
  readonly files: SpeechResourceFiles;
  readonly closeEntered: Promise<void>;
  readonly reads: Promise<unknown>[];
  release(): void;
  opens(): number;
  closes(): number;
  directoryCloses(): number;
  setFallbackBirth(root: string, value: bigint): void;
}

type Fault = "held" | "rejected" | "synchronous" | "directory-held" | "directory-rejected" | "directory-synchronous" | "directory-stat";
async function owned(mode: Fault, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-prepared-owner-")));
  const firstRoot = join(parent, "first"), secondRoot = join(parent, "second");
  const identity = BigInt(`0x${randomUUID().replaceAll("-", "")}`);
  const birth = 1_700_000_000_000_000_000n;
  const fallbackBirths = new Map<string, bigint>();
  const barrier = deferred(), entered = deferred();
  const actual: Awaited<ReturnType<typeof open>>[] = [], directories: Awaited<ReturnType<typeof open>>[] = [], reads: Promise<unknown>[] = [];
  let closes = 0, directoryCloses = 0, directoryStats = 0;
  try {
    for (const root of [firstRoot, secondRoot]) {
      await mkdir(join(root, "native/speech/cpu"), { recursive: true, mode: 0o700 });
      await writeFile(join(root, "native/speech/cpu/openwhisper_speech.node"), bytes, { mode: 0o600, flag: "wx" });
    }
    const rootIdentity = (path: string, value: BigIntStats): BigIntStats => {
        if (path === firstRoot || path === secondRoot) {
          // Only root identity is synthetic. Identical dev/ino/birth represents
          // a true alias; all native-resource bytes and descriptor I/O are real.
          value.dev = identity;
          value.ino = identity;
          value.birthtimeNs = fallbackBirths.get(path) ?? birth;
          value.birthtimeMs = value.birthtimeNs / 1_000_000n;
          if (fallbackBirths.has(path)) {
            // Pinned libuv's Linux non-statx path substitutes mutable ctime.
            value.ctimeNs = value.birthtimeNs;
            value.ctimeMs = value.birthtimeMs;
          }
        }
      return value;
    };
    const files: SpeechResourceFiles = {
      realpath,
      lstat: async (path) => rootIdentity(path, await lstat(path, { bigint: true })),
      openDirectory: async (path, flags) => {
        assert.ok((flags & constants.O_DIRECTORY) !== 0);
        assert.ok((flags & constants.O_NOFOLLOW) !== 0);
        const file = await open(path, flags), ordinal = directories.push(file);
        return { stat: async (options) => {
          directoryStats++;
          if (mode === "directory-stat" && directoryStats === 1) throw new Error("Owned root stat failure.");
          return rootIdentity(path, await file.stat(options));
        }, close: () => {
          directoryCloses++;
          if (ordinal === 1 && mode.startsWith("directory-")) {
            entered.resolve();
            if (mode === "directory-synchronous") throw new Error("Owned synchronous root close refusal.");
            if (mode === "directory-rejected") return Promise.reject(new Error("Owned asynchronous root close refusal."));
            if (mode === "directory-held") return barrier.promise.then(async () => { await file.close(); });
          }
          return file.close();
        } };
      },
      open: async (path, flags) => {
        const file = await open(path, flags), ordinal = actual.push(file);
        return { stat: file.stat.bind(file), read: file.read.bind(file), close: () => {
          closes++;
          if (ordinal === 1) {
            if (!mode.startsWith("directory-")) entered.resolve();
            if (mode === "synchronous") throw new Error("Owned synchronous close refusal.");
            if (mode === "rejected") return Promise.reject(new Error("Owned asynchronous close refusal."));
            if (mode === "held") return barrier.promise.then(async () => { await file.close(); });
          }
          return file.close();
        } };
      },
    };
    await run({ firstRoot, secondRoot, files, closeEntered: entered.promise, reads,
      release: barrier.resolve, opens: () => actual.length, closes: () => closes, directoryCloses: () => directoryCloses,
      setFallbackBirth: (root, value) => { fallbackBirths.set(root, value); } });
  } finally {
    barrier.resolve();
    await Promise.allSettled(reads);
    // Cleanup owns these real descriptors; it is not a catalog close receipt.
    await Promise.allSettled(actual.map(async (file) => { await file.close(); }));
    await Promise.allSettled(directories.map(async (file) => { await file.close(); }));
    await rm(parent, { recursive: true, force: true });
  }
}

test("already prepared aliases cannot reclaim a physical owner with a held descriptor", { timeout: 5000 }, async () => {
  await owned("held", async (fixture) => {
    const first = await prepareSpeechResources(fixture.firstRoot, catalog, host, fixture.files);
    const second = await prepareSpeechResources(fixture.secondRoot, catalog, host, fixture.files);
    // The old token must synchronously reclaim the idle owner before queueing.
    const verification = verifySpeechResource(first, "cpu"); fixture.reads.push(verification);
    await fixture.closeEntered;
    await assert.rejects(verifySpeechResource(second, "cpu"), code("INTEGRITY_FAILED"));
    await assert.rejects(prepareSpeechResources(fixture.secondRoot, catalog, host, fixture.files), code("INTEGRITY_FAILED"));
    assert.equal(fixture.opens(), 1); assert.equal(fixture.closes(), 1);
    fixture.release(); await verification;
    assert.equal((await verifySpeechResource(second, "cpu")).sha256, entry.sha256);
    assert.equal((await verifySpeechResource(first, "cpu")).sha256, entry.sha256);
    assert.equal(fixture.opens(), 3); assert.equal(fixture.closes(), 3);
  });
});

test("physical ownership remains reserved until the root descriptor closes", { timeout: 5000 }, async () => {
  await owned("directory-held", async (fixture) => {
    const first = await prepareSpeechResources(fixture.firstRoot, catalog, host, fixture.files);
    const second = await prepareSpeechResources(fixture.secondRoot, catalog, host, fixture.files);
    const verification = verifySpeechResource(first, "cpu"); fixture.reads.push(verification);
    await fixture.closeEntered;
    assert.equal(fixture.closes(), 1); assert.equal(fixture.directoryCloses(), 1);
    await assert.rejects(verifySpeechResource(second, "cpu"), code("INTEGRITY_FAILED"));
    await assert.rejects(prepareSpeechResources(fixture.secondRoot, catalog, host, fixture.files), code("INTEGRITY_FAILED"));
    assert.equal(fixture.opens(), 1);
    fixture.release(); await verification;
    assert.equal((await verifySpeechResource(second, "cpu")).sha256, entry.sha256);
  });
});

for (const mode of ["directory-rejected", "directory-synchronous"] as const) {
  test(`${mode} closure retains a physical refusal after artifact closure succeeded`, { timeout: 5000 }, async () => {
    await owned(mode, async (fixture) => {
      const first = await prepareSpeechResources(fixture.firstRoot, catalog, host, fixture.files);
      const second = await prepareSpeechResources(fixture.secondRoot, catalog, host, fixture.files);
      await assert.rejects(verifySpeechResource(first, "cpu"), code("TEARDOWN_FAILED"));
      for (const handle of [first, second]) await assert.rejects(verifySpeechResource(handle, "cpu"), code("TEARDOWN_FAILED"));
      for (const root of [fixture.firstRoot, fixture.secondRoot]) {
        await assert.rejects(prepareSpeechResources(root, catalog, host, fixture.files), code("TEARDOWN_FAILED"));
      }
      assert.equal(fixture.opens(), 1); assert.equal(fixture.closes(), 1); assert.equal(fixture.directoryCloses(), 1);
    });
  });
}

test("root stat failure closes its acquired descriptor before permitting a clean retry", { timeout: 5000 }, async () => {
  await owned("directory-stat", async (fixture) => {
    const first = await prepareSpeechResources(fixture.firstRoot, catalog, host, fixture.files);
    await assert.rejects(verifySpeechResource(first, "cpu"), code("INTEGRITY_FAILED"));
    assert.equal(fixture.opens(), 0); assert.equal(fixture.directoryCloses(), 1);
    assert.equal((await verifySpeechResource(first, "cpu")).sha256, entry.sha256);
    assert.equal(fixture.opens(), 1); assert.equal(fixture.directoryCloses(), 2);
  });
});

test("artifact close refusal retains a genuine unlinked root directory descriptor", { timeout: 5000 }, async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-real-root-pin-")));
  const root = join(parent, "original"), replacement = join(parent, "replacement");
  const directories: Awaited<ReturnType<typeof open>>[] = [], actual: Awaited<ReturnType<typeof open>>[] = [];
  let directoryCloses = 0;
  try {
    await mkdir(join(root, "native/speech/cpu"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "native/speech/cpu/openwhisper_speech.node"), bytes, { mode: 0o600, flag: "wx" });
    const original = await lstat(root, { bigint: true });
    const files: SpeechResourceFiles = { realpath, lstat: (path) => lstat(path, { bigint: true }),
      openDirectory: async (path, flags) => {
        assert.ok((flags & constants.O_DIRECTORY) !== 0); assert.ok((flags & constants.O_NOFOLLOW) !== 0);
        const file = await open(path, flags); directories.push(file);
        return { stat: (options) => file.stat(options), close: async () => { directoryCloses++; await file.close(); } };
      }, open: async (path, flags) => {
        const file = await open(path, flags); actual.push(file);
        return { stat: file.stat.bind(file), read: file.read.bind(file), close: async () => { throw new Error("Owned artifact close refusal."); } };
      },
    };
    const first = await prepareSpeechResources(root, catalog, host, files);
    await assert.rejects(verifySpeechResource(first, "cpu"), code("TEARDOWN_FAILED"));
    assert.equal(directories.length, 1); assert.equal(directoryCloses, 0);
    const directory = directories[0]; assert.ok(directory);
    await rm(root, { recursive: true });
    await assert.rejects(lstat(root), (error: unknown) =>
      typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT");
    const retained = await directory.stat({ bigint: true });
    assert.equal(retained.isDirectory(), true);
    assert.equal(retained.dev, original.dev); assert.equal(retained.ino, original.ino);
    await mkdir(replacement, { mode: 0o700 });
    const newer = await lstat(replacement, { bigint: true });
    assert.ok(newer.dev !== original.dev || newer.ino !== original.ino);
    await assert.rejects(verifySpeechResource(first, "cpu"), code("TEARDOWN_FAILED"));
    assert.equal(directoryCloses, 0);
  } finally {
    await Promise.allSettled(actual.map(async (file) => { await file.close(); }));
    await Promise.allSettled(directories.map(async (file) => { await file.close(); }));
    await rm(parent, { recursive: true, force: true });
  }
});

for (const mode of ["rejected", "synchronous"] as const) {
  test(`physical ${mode} close refusal cannot be escaped through prepared old or new aliases`, { timeout: 5000 }, async () => {
    await owned(mode, async (fixture) => {
      const first = await prepareSpeechResources(fixture.firstRoot, catalog, host, fixture.files);
      const second = await prepareSpeechResources(fixture.secondRoot, catalog, host, fixture.files);
      await assert.rejects(verifySpeechResource(first, "cpu"), code("TEARDOWN_FAILED"));
      for (const handle of [first, second]) await assert.rejects(verifySpeechResource(handle, "cpu"), code("TEARDOWN_FAILED"));
      for (const root of [fixture.firstRoot, fixture.secondRoot]) {
        await assert.rejects(prepareSpeechResources(root, catalog, host, fixture.files), code("TEARDOWN_FAILED"));
      }
      assert.equal(fixture.opens(), 1); assert.equal(fixture.closes(), 1);
    });
  });
}

test("changed ctime-substituted birth does not bypass a held physical alias", { timeout: 5000 }, async () => {
  await owned("held", async (fixture) => {
    fixture.setFallbackBirth(fixture.firstRoot, 10n);
    const first = await prepareSpeechResources(fixture.firstRoot, catalog, host, fixture.files);
    const verification = verifySpeechResource(first, "cpu"); fixture.reads.push(verification);
    await fixture.closeEntered;
    fixture.setFallbackBirth(fixture.secondRoot, 20n);
    await assert.rejects(prepareSpeechResources(fixture.secondRoot, catalog, host, fixture.files), code("INTEGRITY_FAILED"));
    assert.equal(fixture.opens(), 1); fixture.release(); await verification;
  });
});

test("changed ctime-substituted birth does not bypass a failed physical alias", { timeout: 5000 }, async () => {
  await owned("rejected", async (fixture) => {
    fixture.setFallbackBirth(fixture.firstRoot, 10n);
    const first = await prepareSpeechResources(fixture.firstRoot, catalog, host, fixture.files);
    await assert.rejects(verifySpeechResource(first, "cpu"), code("TEARDOWN_FAILED"));
    fixture.setFallbackBirth(fixture.secondRoot, 20n);
    await assert.rejects(prepareSpeechResources(fixture.secondRoot, catalog, host, fixture.files), code("TEARDOWN_FAILED"));
    assert.equal(fixture.opens(), 1); assert.equal(fixture.closes(), 1);
  });
});

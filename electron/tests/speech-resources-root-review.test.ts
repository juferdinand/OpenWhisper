import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSpeechResources, verifySpeechResource, type SpeechResourceFiles } from "../src/services/speech-resources.js";
import { SpeechWorkerError } from "../src/services/speech-client.js";

const bytes = Buffer.from("independent-inert-catalog-review");
const host = { platform: "linux", architecture: "x64" } as const;
const catalog = { version: 1, ...host, napiVersion: 8,
  speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
  speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
  entries: [{ backend: "cpu", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] };
const code = (expected: string) => (error: unknown): boolean => error instanceof SpeechWorkerError && error.code === expected;

for (const mode of ["held", "rejected", "synchronous"] as const) {
  test(`logical root replacement cannot escape ${mode} descriptor-close ownership`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-resource-root-review-")));
    const displaced = `${root}-displaced`;
    let release!: () => void;
    const barrier = new Promise<void>((accept) => { release = accept; });
    let opens = 0, closes = 0, confirmed = 0;
    let descriptor: Awaited<ReturnType<typeof open>> | undefined;
    const files: SpeechResourceFiles = { lstat: (path) => lstat(path, { bigint: true }), realpath,
      open: async (path, flags) => {
        opens++; const file = await open(path, flags); descriptor = file;
        return { stat: file.stat.bind(file), read: file.read.bind(file), close: () => {
          closes++;
          if (mode === "synchronous") throw new Error("Owned synthetic synchronous refusal.");
          if (mode === "rejected") return Promise.reject(new Error("Owned synthetic close refusal."));
          return barrier.then(async () => { await file.close(); confirmed++; });
        } };
      } };
    async function populate(): Promise<void> {
      await chmod(root, 0o700); const directory = join(root, "native/speech/cpu");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, "openwhisper_speech.node"), bytes, { mode: 0o600 });
    }
    let first: Promise<unknown> | undefined;
    try {
      await populate(); const original = await prepareSpeechResources(root, catalog, host, files);
      first = verifySpeechResource(original, "cpu"); void first.catch(() => undefined);
      if (mode === "held") {
        const deadline = performance.now() + 2000;
        while (closes === 0) {
          assert.ok(performance.now() < deadline, "Owned close fixture did not start.");
          await new Promise<void>((accept) => { setImmediate(accept); });
        }
      } else await assert.rejects(first, code("TEARDOWN_FAILED"));
      assert.equal(opens, 1); assert.equal(confirmed, 0);
      const before = await lstat(root, { bigint: true });
      await rename(root, displaced); await mkdir(root, { mode: 0o700 }); await populate();
      assert.notEqual((await lstat(root, { bigint: true })).ino, before.ino);
      await assert.rejects(prepareSpeechResources(root, catalog, host, files),
        code(mode === "held" ? "INTEGRITY_FAILED" : "TEARDOWN_FAILED"));
      assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(confirmed, 0);
    } finally {
      release(); if (first) await Promise.allSettled([first]);
      // This independent fixture owns the real handle and closes it separately;
      // it never converts the verifier's synthetic refused close into a receipt.
      await descriptor?.close();
      await rm(root, { recursive: true, force: true }); await rm(displaced, { recursive: true, force: true });
    }
  });
}

test("concurrent preparation rechecks logical ownership after delayed root metadata", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-resource-concurrent-review-")));
  const displaced = `${root}-displaced`;
  let release!: () => void;
  const barrier = new Promise<void>((accept) => { release = accept; });
  let rootsRead = 0, opens = 0, closes = 0;
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  const files: SpeechResourceFiles = { lstat: async (path) => {
    // The second preparation captures its pre-I/O owner before the first has
    // registered. Its actual root metadata is read only after replacement.
    if (path === root && ++rootsRead === 2) await barrier;
    return lstat(path, { bigint: true });
  }, realpath, open: async (path, flags) => {
    opens++; const file = await open(path, flags); descriptor = file;
    return { stat: file.stat.bind(file), read: file.read.bind(file), close: () => {
      closes++; return Promise.reject(new Error("Owned concurrent close refusal."));
    } };
  } };
  async function populate(): Promise<void> {
    await chmod(root, 0o700); await mkdir(join(root, "native/speech/cpu"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "native/speech/cpu/openwhisper_speech.node"), bytes, { mode: 0o600 });
  }
  let late: Promise<unknown> | undefined;
  try {
    await populate();
    const first = prepareSpeechResources(root, catalog, host, files);
    const second = prepareSpeechResources(root, catalog, host, files); late = second; void second.catch(() => undefined);
    const original = await first;
    await assert.rejects(verifySpeechResource(original, "cpu"), code("TEARDOWN_FAILED"));
    const before = await lstat(root, { bigint: true });
    await rename(root, displaced); await mkdir(root, { mode: 0o700 }); await populate();
    assert.notEqual((await lstat(root, { bigint: true })).ino, before.ino);
    release(); await assert.rejects(second, code("TEARDOWN_FAILED"));
    assert.equal(opens, 1); assert.equal(closes, 1);
  } finally {
    release(); if (late) await Promise.allSettled([late]);
    await descriptor?.close();
    await rm(root, { recursive: true, force: true }); await rm(displaced, { recursive: true, force: true });
  }
});

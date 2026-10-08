import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareSpeechResources, verifySpeechResource, type SpeechResourceFiles } from "../src/services/speech-resources.js";
import { SpeechWorkerError } from "../src/services/speech-client.js";

const bytes = Buffer.from("owned inode-reuse fixture");
const host = { platform: "linux", architecture: "x64" } as const;
const catalog = { version: 1, ...host, napiVersion: 8,
  speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
  speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
  entries: [{ backend: "cpu", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] };

for (const mode of ["completed", "held", "rejected"] as const) {
  test(`reused physical root identity respects ${mode} descriptor ownership`, async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-inode-reuse-")));
    const firstRoot = join(parent, "first"), secondRoot = join(parent, "second");
    for (const root of [firstRoot, secondRoot]) {
      await mkdir(join(root, "native/speech/cpu"), { recursive: true, mode: 0o700 });
      await writeFile(join(root, "native/speech/cpu/openwhisper_speech.node"), bytes, { mode: 0o600 });
    }
    const originalRoot = await lstat(firstRoot, { bigint: true });
    let release!: () => void;
    const barrier = new Promise<void>((accept) => { release = accept; });
    let closes = 0;
    const actual: Awaited<ReturnType<typeof open>>[] = [];
    const directories: Awaited<ReturnType<typeof open>>[] = [];
    const files: SpeechResourceFiles = { realpath, lstat: async (path) => {
      const value = await lstat(path, { bigint: true });
      // All actual private file I/O is retained. Only directory inode reuse is
      // deterministic here; the Ubuntu CI separately observed actual reuse.
      if (path === secondRoot) { value.dev = originalRoot.dev; value.ino = originalRoot.ino; }
      return value;
    }, openDirectory: async (path, flags) => {
      const file = await open(path, flags); directories.push(file);
      return { stat: async (options) => {
        const value = await file.stat(options);
        if (path === secondRoot) { value.dev = originalRoot.dev; value.ino = originalRoot.ino; }
        return value;
      }, close: file.close.bind(file) };
    }, open: async (path, flags) => {
      const file = await open(path, flags); actual.push(file);
      return { stat: file.stat.bind(file), read: file.read.bind(file), close: async () => {
        closes++;
        if (actual.length === 1 && mode === "held") await barrier;
        if (actual.length === 1 && mode === "rejected") throw new Error("Owned refused close.");
        await file.close();
      } };
    } };
    let verification: Promise<unknown> | undefined;
    try {
      const first = await prepareSpeechResources(firstRoot, catalog, host, files);
      verification = verifySpeechResource(first, "cpu"); void verification.catch(() => {});
      if (mode === "held") {
        const deadline = performance.now() + 2000;
        while (closes === 0) { assert.ok(performance.now() < deadline); await new Promise<void>((accept) => { setImmediate(accept); }); }
        await assert.rejects(prepareSpeechResources(secondRoot, catalog, host, files),
          (error: unknown) => error instanceof SpeechWorkerError && error.code === "INTEGRITY_FAILED");
        release(); await verification;
      } else if (mode === "rejected") {
        await assert.rejects(verification, (error: unknown) => error instanceof SpeechWorkerError && error.code === "TEARDOWN_FAILED");
        await assert.rejects(prepareSpeechResources(secondRoot, catalog, host, files),
          (error: unknown) => error instanceof SpeechWorkerError && error.code === "TEARDOWN_FAILED");
        assert.equal(actual.length, 1); return;
      } else { await verification; await rm(firstRoot, { recursive: true }); }
      const second = await prepareSpeechResources(secondRoot, catalog, host, files);
      assert.equal((await verifySpeechResource(second, "cpu")).sha256, catalog.entries[0]!.sha256);
      assert.equal(actual.length, 2);
    } finally {
      release(); if (verification) await Promise.allSettled([verification]);
      await Promise.allSettled(actual.map((file) => file.close()));
      await Promise.allSettled(directories.map((file) => file.close()));
      await rm(parent, { recursive: true, force: true });
    }
  });
}

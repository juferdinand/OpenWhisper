import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, open, realpath, chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSpeechResources, speechResourceCatalogSchema, verifySpeechResource } from "../../src/services/speech/speech-resources.js";
import type { PreparedSpeechResources, SpeechResourceFiles } from "../../src/services/speech/speech-resources.js";
import { SpeechWorkerError } from "../../src/services/speech/speech-client.js";

const host = { platform: "linux", architecture: "x64" } as const;
const bytes = Buffer.from("owned-inert-resource-bytes");
const entry = { backend: "cpu", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } as const;
const catalog = { version: 1, ...host, napiVersion: 8, speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
  speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde", entries: [entry] };
const actual: SpeechResourceFiles = { lstat: (path) => lstat(path, { bigint: true }), realpath, open };
const code = (expected: string) => (error: unknown) => error instanceof SpeechWorkerError && error.code === expected;
async function owned(run: (root: string, path: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-resource-test-")));
  try {
    await chmod(root, 0o700);
    const directory = join(root, "native/speech/cpu"); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "openwhisper_speech.node"); await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    await run(root, path);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("resource catalog rejects wrong pins, duplicate profiles and injected paths before filesystem access", async () => {
  const failFiles: SpeechResourceFiles = { lstat: async () => { assert.fail("No filesystem access before catalog/host validation"); },
    realpath: async () => { assert.fail(); }, open: async () => { assert.fail(); } };
  for (const change of [{ napiVersion: 9 }, { speechRevision: "a".repeat(40) }, { speechSourceSha256: "a".repeat(64) },
    { arbitraryPath: "/foreign" }, { entries: [{ ...entry, backend: "metal" }] }, { entries: [entry, entry] },
    { entries: [{ ...entry, path: "/foreign" }] }, { entries: [{ ...entry, bytes: 0 }] },
    { entries: [{ ...entry, sha256: "A".repeat(64) }] }]) {
    await assert.rejects(prepareSpeechResources("/owned-resource-root", { ...catalog, ...change }, host, failFiles), code("INTEGRITY_FAILED"));
  }
  await assert.rejects(prepareSpeechResources("/owned-resource-root", catalog, { ...host, architecture: "arm64" }, failFiles), code("INTEGRITY_FAILED"));
  assert.equal(speechResourceCatalogSchema.safeParse({ ...catalog, entries: [entry, { ...entry, backend: "vulkan" }] }).success, true);
});

test("CPU verification uses copied host metadata and never reads a missing GPU resource", async () => owned(async (root, path) => {
  const visits: string[] = [], observed: SpeechResourceFiles = {
    lstat: async (path) => { visits.push(path); return actual.lstat(path); },
    realpath: async (path) => { visits.push(path); return actual.realpath(path); },
    open: async (path, flags) => { visits.push(path); return actual.open(path, flags); },
  };
  const mutable = { ...catalog, entries: [{ ...entry }, { ...entry, backend: "vulkan" }] };
  const prepared = await prepareSpeechResources(root, mutable, host, observed);
  mutable.entries[0]!.sha256 = "a".repeat(64);
  const result = await verifySpeechResource(prepared, "cpu");
  assert.deepEqual(result, { ...entry, path });
  assert.equal(visits.some((path) => path.includes("vulkan") || path.includes("metal")), false);
  await assert.rejects(verifySpeechResource(prepared, "vulkan"), code("INTEGRITY_FAILED"));
  await assert.rejects(verifySpeechResource({} as PreparedSpeechResources, "cpu"), code("INTEGRITY_FAILED"));
  await assert.rejects(verifySpeechResource(prepared, { backend: "cpu", path }), code("INTEGRITY_FAILED"));
}));

test("selected artifact refuses symlinks at every fixed ancestry and at the resource root", async () => {
  await owned(async (root) => {
    const alias = `${root}-alias`; await symlink(root, alias);
    try { await assert.rejects(prepareSpeechResources(alias, catalog, host), code("INTEGRITY_FAILED")); }
    finally { await rm(alias); }
  });
  for (const component of ["native", "native/speech", "native/speech/cpu", "native/speech/cpu/openwhisper_speech.node"]) {
    await owned(async (root) => {
      const prepared = await prepareSpeechResources(root, catalog, host);
      const path = join(root, component), moved = `${path}-original`;
      await import("node:fs/promises").then(({ rename }) => rename(path, moved)); await symlink(moved, path);
      await assert.rejects(verifySpeechResource(prepared, "cpu"), code("INTEGRITY_FAILED"));
    });
  }
});

test("selected resource refuses changed bytes, hardlinks, writable permissions and replacement during hashing", async () => {
  for (const fault of ["hash", "hardlink", "permissions", "mutation"] as const) await owned(async (root, path) => {
    const files: SpeechResourceFiles = fault !== "mutation" ? actual : { ...actual, open: async (path, flags) => {
      const file = await actual.open(path, flags); let changed = false;
      return { stat: file.stat.bind(file), close: file.close.bind(file), read: async (...args: Parameters<typeof file.read>) => {
        const result = await file.read(...args);
        if (!changed) { changed = true; await writeFile(path, Buffer.alloc(bytes.length, 88)); }
        return result;
      } };
    } };
    const prepared = await prepareSpeechResources(root, catalog, host, files);
    if (fault === "hash") await writeFile(path, Buffer.alloc(bytes.length, 90));
    if (fault === "hardlink") await link(path, `${path}-link`);
    if (fault === "permissions") await chmod(path, 0o620);
    await assert.rejects(verifySpeechResource(prepared, "cpu"), code("INTEGRITY_FAILED"));
  });
});

test("a held close serializes all catalog handles and a failed close retains ownership", async () => owned(async (root) => {
  let release!: () => void, opened = 0, closed = 0;
  const barrier = new Promise<void>((accept) => { release = accept; });
  const files: SpeechResourceFiles = { ...actual, open: async (path, flags) => {
    opened++; const file = await actual.open(path, flags);
    return { stat: file.stat.bind(file), read: file.read.bind(file), close: async () => { await barrier; closed++; await file.close(); } };
  } };
  const first = await prepareSpeechResources(root, catalog, host, files), second = await prepareSpeechResources(root, catalog, host, files);
  const read = verifySpeechResource(first, "cpu"), next = verifySpeechResource(second, "cpu");
  while (opened === 0) await new Promise<void>((accept) => { setImmediate(accept); });
  await new Promise<void>((accept) => { setTimeout(accept, 10); }); assert.equal(opened, 1); assert.equal(closed, 0);
  release(); await read; await next; assert.equal(opened, 2); assert.equal(closed, 2);
}));

test("close refusal remains terminal across retries and fresh catalog handles without a second close", async () => {
  for (const synchronous of [false, true]) await owned(async (root) => {
    let opens = 0, closes = 0; let retained: Awaited<ReturnType<typeof actual.open>> | undefined;
    const files: SpeechResourceFiles = { ...actual, open: async (path, flags) => {
      opens++; const file = await actual.open(path, flags); retained = file;
      return { stat: file.stat.bind(file), read: file.read.bind(file), close: () => {
        closes++; if (synchronous) throw new Error("private-close-error"); return Promise.reject(new Error("private-close-error"));
      } };
    } };
    const prepared = await prepareSpeechResources(root, catalog, host, files);
    try {
      await assert.rejects(verifySpeechResource(prepared, "cpu"), code("TEARDOWN_FAILED"));
      await assert.rejects(verifySpeechResource(prepared, "cpu"), code("TEARDOWN_FAILED"));
      await assert.rejects(prepareSpeechResources(root, catalog, host, files), code("TEARDOWN_FAILED"));
      assert.equal(opens, 1); assert.equal(closes, 1);
    } finally { await retained?.close(); }
  });
});

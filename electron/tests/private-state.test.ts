import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { PrivateStateStore } from "../src/services/private-state.js";

test("private feature state serializes patches, rejects invalid updates and survives restart without aliases", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-private-state-")));
  const schema = z.strictObject({ enabled: z.boolean(), model: z.string(), instruction: z.string() });
  const path = join(root, "feature.json");
  try {
    const defaults = { enabled: false, model: "", instruction: "Keep café 日本語." };
    const store = await PrivateStateStore.open(path, schema, defaults, 1024);
    const snapshot = store.snapshot(); snapshot.enabled = true;
    assert.equal(store.snapshot().enabled, false);
    await Promise.all([store.update((current) => ({ ...current, model: "coder" })),
      store.update((current) => ({ ...current, enabled: true }))]);
    const saved = store.snapshot();
    await assert.rejects(store.update((current) => ({ ...current, model: 42 })));
    await assert.rejects(store.update((current) => ({ ...current, instruction: "a".repeat(1024) })));
    assert.deepEqual(store.snapshot(), saved);
    assert.deepEqual((await PrivateStateStore.open(path, schema, defaults, 1024)).snapshot(), saved);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private feature state refuses unsafe symlinks and preserves the selected fixture target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-feature-link-")));
  try {
    const target = join(root, "owned-stable-sentinel");
    const path = join(root, "feature.json");
    await writeFile(target, "Owned stable bytes", { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(PrivateStateStore.open(path, z.strictObject({ enabled: z.boolean() }), { enabled: false }));
    assert.equal(await readFile(target, "utf8"), "Owned stable bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private state rejects parent and ancestor symlinks without reading the aliased fixture", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-state-ancestry-")));
  const schema = z.strictObject({ enabled: z.boolean() });
  try {
    const sentinel = join(root, "owned-stable-sentinel");
    await mkdir(sentinel, { mode: 0o700 });
    await mkdir(join(sentinel, "settings"), { mode: 0o700 });
    const bytes = JSON.stringify({ enabled: true });
    for (const path of [join(sentinel, "feature.json"), join(sentinel, "settings", "feature.json")]) {
      await writeFile(path, bytes, { mode: 0o600 });
    }
    const alias = join(root, "development");
    await symlink(sentinel, alias);
    await assert.rejects(PrivateStateStore.open(join(alias, "feature.json"), schema, { enabled: false }));
    await assert.rejects(PrivateStateStore.open(join(alias, "settings", "feature.json"), schema, { enabled: false }));
    assert.equal(await readFile(join(sentinel, "feature.json"), "utf8"), bytes);
    assert.equal(await readFile(join(sentinel, "settings", "feature.json"), "utf8"), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private state revalidates the original parent before queued writes and never chmods it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-state-parent-change-")));
  const schema = z.strictObject({ enabled: z.boolean() });
  try {
    const directory = join(root, "settings");
    const original = join(root, "original-settings");
    const sentinel = join(root, "owned-stable-sentinel");
    await mkdir(directory, { mode: 0o700 }); await mkdir(sentinel, { mode: 0o700 });
    const path = join(directory, "feature.json");
    const store = await PrivateStateStore.open(path, schema, { enabled: false });
    await store.update((value) => value);
    const bytes = JSON.stringify({ enabled: true });
    await writeFile(join(sentinel, "feature.json"), bytes, { mode: 0o600 });
    await rename(directory, original); await symlink(sentinel, directory);
    await assert.rejects(store.update(() => ({ enabled: true })));
    assert.equal(await readFile(join(sentinel, "feature.json"), "utf8"), bytes);
    assert.deepEqual(store.snapshot(), { enabled: false });
    await rm(directory); await mkdir(directory, { mode: 0o700 });
    await assert.rejects(store.update(() => ({ enabled: true })), "A different owned directory must not replace this store's parent.");
    await rm(directory, { recursive: true }); await rename(original, directory);
    await chmod(directory, 0o755);
    await assert.rejects(store.update(() => ({ enabled: true })));
    assert.equal((await lstat(directory)).mode & 0o777, 0o755);
    await chmod(directory, 0o700);
    assert.deepEqual(await store.update(() => ({ enabled: true })), { enabled: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private state refuses hard-linked records and nonprivate existing directories", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-state-privacy-")));
  const schema = z.strictObject({ enabled: z.boolean() });
  try {
    const sentinel = join(root, "owned-stable-sentinel.json");
    const path = join(root, "feature.json");
    const bytes = JSON.stringify({ enabled: true });
    await writeFile(sentinel, bytes, { mode: 0o600 }); await link(sentinel, path);
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }));
    assert.equal(await readFile(sentinel, "utf8"), bytes);
    await rm(path); await chmod(root, 0o755);
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }));
    assert.equal((await lstat(root)).mode & 0o777, 0o755);
    await assert.rejects(PrivateStateStore.open("relative-feature.json", schema, { enabled: false }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private state rejects unsafe record types modes sizes and invalid UTF8 without replacement", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-state-invalid-")));
  const schema = z.strictObject({ enabled: z.boolean() });
  const path = join(root, "feature.json");
  try {
    await mkdir(path, { mode: 0o700 });
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }, 32));
    await rm(path, { recursive: true });
    await writeFile(path, JSON.stringify({ enabled: false }), { mode: 0o644 });
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }, 32));
    assert.equal((await lstat(path)).mode & 0o777, 0o644);
    await chmod(path, 0o600); await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }, 32));
    assert.deepEqual(await readFile(path), Buffer.from([0xff]));
    await writeFile(path, " ".repeat(33));
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }, 32));
    assert.equal((await readFile(path)).length, 33);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("optional corrupt feature content stays unchanged with disabled defaults until a valid explicit edit", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-state-optional-content-")));
  const schema = z.strictObject({ enabled: z.boolean(), model: z.string() });
  const defaults = { enabled: false, model: "" };
  const policy = { invalidContent: "preserve-and-default" } as const;
  const path = join(root, "feature.json");
  try {
    for (const bytes of [Buffer.from("{broken private JSON"), Buffer.from([0xff]),
      Buffer.from(JSON.stringify({ enabled: "invalid", model: "private-model" })), Buffer.alloc(65, 0x20)]) {
      await writeFile(path, bytes, { mode: 0o600 });
      await assert.rejects(PrivateStateStore.open(path, schema, defaults, 64));
      const store = await PrivateStateStore.open(path, schema, defaults, 64, policy);
      assert.equal(store.invalidContent, true);
      assert.deepEqual(store.snapshot(), defaults);
      assert.deepEqual(await readFile(path), bytes);
      await assert.rejects(store.update(() => ({ enabled: "invalid", model: "" })));
      assert.equal(store.invalidContent, true);
      assert.deepEqual(await readFile(path), bytes);
      await store.update((current) => ({ ...current, model: "selected-model" }));
      assert.equal(store.invalidContent, false);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: false, model: "selected-model" });
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      const reopened = await PrivateStateStore.open(path, schema, defaults, 64, policy);
      assert.equal(reopened.invalidContent, false);
      assert.deepEqual(reopened.snapshot(), store.snapshot());
    }
    await rm(path);
    const empty = await PrivateStateStore.open(path, schema, defaults, 64, policy);
    assert.equal(empty.invalidContent, false); assert.deepEqual(empty.snapshot(), defaults);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("optional content fallback never permits unsafe path authority", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-state-optional-authority-")));
  const schema = z.strictObject({ enabled: z.boolean() });
  const policy = { invalidContent: "preserve-and-default" } as const;
  const path = join(root, "feature.json");
  try {
    const sentinel = join(root, "owned-stable-sentinel");
    await writeFile(sentinel, "corrupt fixture", { mode: 0o600 }); await symlink(sentinel, path);
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }, 32, policy));
    assert.equal(await readFile(sentinel, "utf8"), "corrupt fixture");
    await rm(path); await link(sentinel, path);
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }, 32, policy));
    await rm(path); await writeFile(path, "corrupt fixture", { mode: 0o644 });
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }, 32, policy));
    assert.equal((await lstat(path)).mode & 0o777, 0o644);
    await rm(path); await mkdir(path, { mode: 0o700 });
    await assert.rejects(PrivateStateStore.open(path, schema, { enabled: false }, 32, policy));
  } finally { await rm(root, { recursive: true, force: true }); }
});

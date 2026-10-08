import assert from "node:assert/strict";
import { chmod, lstat, link, mkdir, mkdtemp, open, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { buildSpeechEntryGraph } from "../scripts/build-speech-entry-graph.js";
import { captureSpeechEntryGraph, prepareSpeechEntryGraph, verifySpeechEntryGraph, SPEECH_ENTRY_FILES, speechEntryGraphSchema, type SpeechEntryFiles } from "../src/services/speech-entry-graph.js";
import { deferred, turn } from "./fixtures/speech-port.js";

const actual: SpeechEntryFiles = { lstat: (path) => lstat(path, { bigint: true }), realpath, open, readdir: (path) => readdir(path, { withFileTypes: true }) };
const retainedRoots = new Set<string>();
after(async () => {
  for (const root of retainedRoots) await rm(root, { recursive: true, force: true });
});
async function owned(run: (root: string) => Promise<void>, retainRoot = false): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-entry-graph-")));
  try {
    await chmod(root, 0o700);
    const application = { name: "openwhisper-electron", type: "module", dependencies: { zod: "4.6.5" } };
    const dependency = { name: "zod", version: "4.6.5", type: "module", exports: { ".": { import: "./index.js", require: "./index.cjs" } } };
    const names = [...SPEECH_ENTRY_FILES, "node_modules/zod/package.json", "node_modules/zod/index.js", "node_modules/zod/index.cjs", "node_modules/zod/v4/core.js", "node_modules/zod/v4/package.json"];
    for (const name of names) {
      const path = join(root, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const value = name === "package.json" ? JSON.stringify(application) : name === "node_modules/zod/package.json" ? JSON.stringify(dependency) :
        name.endsWith("package.json") ? '{"type":"module"}' : name === "dist/workers/speech-entry.js" ?
          'import { value } from "../contracts/speech.js"; import { z } from "zod"; export const fixture = [value,z];' :
          name === "node_modules/zod/index.js" ? 'export { z } from "./v4/core.js";' : name === "node_modules/zod/v4/core.js" ? 'export const z = "inert";' : 'export const value = "inert";';
      await writeFile(path, value, { mode: 0o600, flag: "wx" });
    }
    await run(root);
  } finally {
    // A refused owner stays pinned for the process. Fixture-only FD cleanup must
    // not let the filesystem recycle its inode into a different test's root.
    if (retainRoot) retainedRoots.add(root);
    else await rm(root, { recursive: true, force: true });
  }
}
test("fixed graph includes compiled contracts, package metadata and all Zod runtime files", async () => owned(async (root) => {
  const expected = await captureSpeechEntryGraph(root), token = await prepareSpeechEntryGraph(root, expected);
  const names = expected.entries.map((entry) => entry.path);
  for (const name of [...SPEECH_ENTRY_FILES, "node_modules/zod/index.cjs", "node_modules/zod/v4/package.json"]) assert.ok(names.includes(name));
  assert.deepEqual(await verifySpeechEntryGraph(token), { entry: join(root, "dist/workers/speech-entry.js") });
}));
test("invalid or incomplete manifests refuse before filesystem effects", async () => owned(async (root) => {
  const expected = await captureSpeechEntryGraph(root);
  const absent: SpeechEntryFiles = { async lstat() { assert.fail("Unexpected filesystem effect."); }, async realpath() { assert.fail(); }, async open() { assert.fail(); }, async readdir() { assert.fail(); } };
  for (const changes of [ { extra: true }, { zodVersion: "4.0.0" }, { entries: expected.entries.slice(1) },
    { entries: [...expected.entries, expected.entries[0]] }, { entries: expected.entries.map((entry) => ({ ...entry, path: "/foreign/path" })) },
    { entries: expected.entries.map((entry) => ({ ...entry, bytes: Infinity })) } ]) {
    await assert.rejects(prepareSpeechEntryGraph(root, { ...expected, ...changes }, absent), { code: "INTEGRITY_FAILED" });
  }
  assert.equal(speechEntryGraphSchema.safeParse(expected).success, true);
}));
for (const changed of ["dist/contracts/speech.js", "package.json", "node_modules/zod/package.json", "node_modules/zod/v4/package.json", "node_modules/zod/v4/core.js"] as const) {
  test(`substituted ${changed} is rejected`, async () => owned(async (root) => {
    const expected = await captureSpeechEntryGraph(root), token = await prepareSpeechEntryGraph(root, expected);
    await writeFile(join(root, changed), "changed-inert-bytes");
    await assert.rejects(verifySpeechEntryGraph(token), { code: "INTEGRITY_FAILED" });
  }));
}
test("unrecorded runtime dependency and missing dependency are rejected", async () => {
  for (const kind of ["extra", "missing"] as const) await owned(async (root) => {
    const token = await prepareSpeechEntryGraph(root, await captureSpeechEntryGraph(root));
    if (kind === "extra") await writeFile(join(root, "node_modules/zod/extra.js"), "inert", { mode: 0o600 });
    else await rm(join(root, "node_modules/zod/v4/core.js"));
    await assert.rejects(verifySpeechEntryGraph(token), { code: "INTEGRITY_FAILED" });
  });
});
test("nearer application package scope cannot alter module interpretation", async () => owned(async (root) => {
  const token = await prepareSpeechEntryGraph(root, await captureSpeechEntryGraph(root));
  await writeFile(join(root, "dist/package.json"), '{"type":"commonjs"}', { mode: 0o600 });
  await assert.rejects(verifySpeechEntryGraph(token), { code: "INTEGRITY_FAILED" });
}));
test("symlinked root, ancestor or entry and hardlinked/writable entries refuse", async () => {
  for (const kind of ["root", "ancestor", "entry", "hardlink", "writable"] as const) await owned(async (root) => {
    const expected = await captureSpeechEntryGraph(root), token = await prepareSpeechEntryGraph(root, expected);
    const path = join(root, "dist/contracts/speech.js");
    if (kind === "root") {
      const alias = `${root}-alias`; await symlink(root, alias);
      try { await assert.rejects(prepareSpeechEntryGraph(alias, expected), { code: "INTEGRITY_FAILED" }); } finally { await rm(alias); }
      return;
    }
    if (kind === "ancestor" || kind === "entry") {
      const selected = kind === "ancestor" ? join(root, "dist/contracts") : path;
      await rename(selected, `${selected}-original`); await symlink(`${selected}-original`, selected);
    } else if (kind === "hardlink") await link(path, `${path}-alias`); else await chmod(path, 0o620);
    await assert.rejects(verifySpeechEntryGraph(token), { code: "INTEGRITY_FAILED" });
  });
});
test("mutation of an earlier file while later file is hashed is detected", async () => owned(async (root) => {
  const expected = await captureSpeechEntryGraph(root); let changed = false;
  const files: SpeechEntryFiles = { ...actual, async open(path, flags) {
    const file = await actual.open(path, flags);
    if (path.endsWith("node_modules/zod/index.js")) return { stat: file.stat.bind(file), close: file.close.bind(file), async read(...args: Parameters<typeof file.read>) {
      const result = await file.read(...args);
      if (!changed) { changed = true; await writeFile(join(root, "dist/contracts/speech.js"), 'export const value = "other";'); }
      return result;
    } };
    return file;
  } };
  const token = await prepareSpeechEntryGraph(root, expected, files);
  await assert.rejects(verifySpeechEntryGraph(token), { code: "INTEGRITY_FAILED" }); assert.equal(changed, true);
}));
test("mutation while descriptor close is held cannot pass verification", async () => owned(async (root) => {
  const expected = await captureSpeechEntryGraph(root), gate = deferred<void>(), reached = deferred<void>();
  const files: SpeechEntryFiles = { ...actual, async open(path, flags) {
    const file = await actual.open(path, flags);
    if (!path.endsWith("dist/contracts/speech.js")) return file;
    return { stat: file.stat.bind(file), read: file.read.bind(file), async close() { reached.accept(); await gate.promise; await file.close(); } };
  } };
  const token = await prepareSpeechEntryGraph(root, expected, files), operation = verifySpeechEntryGraph(token);
  await reached.promise; await writeFile(join(root, "dist/contracts/speech.js"), 'export const value = "other";'); gate.accept();
  await assert.rejects(operation, { code: "INTEGRITY_FAILED" });
}));
test("held root descriptor closure serializes every token", async () => owned(async (root) => {
  const expected = await captureSpeechEntryGraph(root), gate = deferred<void>(), reached = deferred<void>(); let roots = 0;
  const files: SpeechEntryFiles = { ...actual, async open(path, flags) {
    const file = await actual.open(path, flags); if (path !== root) return file;
    roots++; return { stat: file.stat.bind(file), read: file.read.bind(file), async close() { reached.accept(); await gate.promise; await file.close(); } };
  } };
  const first = await prepareSpeechEntryGraph(root, expected, files), second = await prepareSpeechEntryGraph(root, expected, files);
  const read = verifySpeechEntryGraph(first), next = verifySpeechEntryGraph(second); await reached.promise; await turn(); assert.equal(roots, 1);
  gate.accept(); await read; await next; assert.equal(roots, 2);
}));
for (const failure of ["file", "root"] as const) {
  test(`failed ${failure} close pins root and prevents retry/fresh-handle escape`, async () => owned(async (root) => {
    const expected = await captureSpeechEntryGraph(root); let closes = 0;
    const handles: Awaited<ReturnType<typeof actual.open>>[] = [], rootHandles: Awaited<ReturnType<typeof actual.open>>[] = [];
    const files: SpeechEntryFiles = { ...actual, async open(path, flags) {
      const file = await actual.open(path, flags);
      if (path === root) rootHandles.push(file);
      if ((failure === "root" && path === root) || (failure === "file" && path.endsWith("dist/contracts/speech.js"))) {
        handles.push(file); return { stat: file.stat.bind(file), read: file.read.bind(file), close() { closes++; return Promise.reject(new Error("inert close refusal")); } };
      }
      return file;
    } };
    try {
      const token = await prepareSpeechEntryGraph(root, expected, files);
      await assert.rejects(verifySpeechEntryGraph(token), { code: "TEARDOWN_FAILED" });
      await assert.rejects(verifySpeechEntryGraph(token), { code: "TEARDOWN_FAILED" });
      await assert.rejects(prepareSpeechEntryGraph(root, expected, files), { code: "TEARDOWN_FAILED" });
      assert.equal(closes, 1);
      for (const file of rootHandles) assert.equal((await file.stat({ bigint: true })).isDirectory(), true);
    } finally { for (const file of new Set([...handles, ...rootHandles])) { try { await file.close(); } catch { /* Fixture-only cleanup. */ } } }
  }, true));
}
test("source-only build records actual resolution inputs without executing bundled code", async () => owned(async (root) => {
  const captured = await buildSpeechEntryGraph(root);
  assert.ok(captured.importedFiles.includes("dist/contracts/speech.js"));
  assert.ok(captured.importedFiles.includes("node_modules/zod/v4/core.js"));
  assert.ok(captured.graph.entries.some((entry) => entry.path === "node_modules/zod/package.json"));
}));
test("builder refuses wrong package type/exports and imports outside fixed graph", async () => {
  for (const kind of ["type", "exports", "external", "local"] as const) await owned(async (root) => {
    if (kind === "type") await writeFile(join(root, "package.json"), '{"name":"openwhisper-electron","type":"commonjs","dependencies":{"zod":"4.6.5"}}');
    else if (kind === "exports") await writeFile(join(root, "node_modules/zod/package.json"), '{"name":"zod","version":"4.6.5","type":"module","exports":{".":{"import":"./v4/core.js","require":"./index.cjs"}}}');
    else if (kind === "external") await writeFile(join(root, "dist/workers/speech-entry.js"), 'import "node:fs";');
    else { await writeFile(join(root, "dist/workers/unreviewed.js"), 'export const value = "inert";', { mode: 0o600 }); await writeFile(join(root, "dist/workers/speech-entry.js"), 'import "./unreviewed.js";'); }
    await assert.rejects(buildSpeechEntryGraph(root));
  });
});

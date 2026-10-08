import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureSourcesSchema, CaptureSourceError, loadNativeCaptureSources, nativeCaptureSourcesFromAddon, PulseSourceDevices } from "../src/workers/source-devices.js";

const first = { id: "owned.first.monitor", name: "Owned first", isDefault: false };
const second = { id: "owned.second.monitor", name: "Owned second", isDefault: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve };
}
async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(path, accept); });
}
async function close(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((accept, reject) => { server.close((error) => error ? reject(error) : accept()); });
}
async function socketFixture() {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-inert-sources-")); await chmod(directory, 0o700);
  const path = join(directory, "native"), socket = createServer(); await listen(socket, path);
  return { directory, path, server: `unix:${path}`, cleanup: async () => { await close(socket); await rm(directory, { recursive: true, force: true }); } };
}
const safeFailure = (error: unknown): boolean => {
  assert.ok(error instanceof CaptureSourceError); assert.equal(error.code, "CAPTURE_SOURCE_FAILED");
  assert.equal(error.message, "The capture sources are unavailable."); return true;
};
test("source metadata preserves multilingual chooser text within exact byte/count bounds", () => {
  const name = "Mikrofon 👩‍💻 العربية", sources = captureSourcesSchema.parse([{ ...first, name }]); assert.equal(sources[0]?.name, name);
  assert.equal(captureSourcesSchema.parse(Array.from({ length: 128 }, (_, i) => ({ ...first, id: `owned.${i}` }))).length, 128);
  assert.equal(captureSourcesSchema.safeParse(Array.from({ length: 129 }, (_, i) => ({ ...first, id: `owned.${i}` }))).success, false);
  for (const invalid of ["\u0000", "\u0085", "\ud800", "😀".repeat(64)]) assert.equal(captureSourcesSchema.safeParse([{ ...first, name: invalid }]).success, false);
  assert.equal(captureSourcesSchema.safeParse([{ ...first, name: "😀".repeat(63) }]).success, true);
  for (const invalid of [[first, first], [second, { ...second, id: "other" }], [{ ...first, id: "@DEFAULT_SOURCE@" }], [{ ...first, rawPath: "/private" }]])
    assert.equal(captureSourcesSchema.safeParse(invalid).success, false);
});
test("verified-addon adapter captures only enumeration and rejects malformed replies categorically", async () => {
  let calls = 0;
  const addon = { enumerate(server: string): unknown { assert.equal(this, addon); assert.equal(server, "unix:/owned/native"); calls++; return [first, second]; } };
  const native = nativeCaptureSourcesFromAddon(addon); addon.enumerate = () => { throw new Error("SECRET PATH"); };
  const sources = await native.enumerate("unix:/owned/native"); assert.equal(calls, 1); assert.equal(sources[1]?.isDefault, true);
  assert.ok(Object.isFrozen(sources) && Object.isFrozen(sources[0]));
  for (const value of [null, {}, { enumerate: 1 }]) assert.throws(() => nativeCaptureSourcesFromAddon(value), safeFailure);
  for (const value of [null, [{ ...first, id: "bad source" }], [first, first], [{ ...first, transcript: "SECRET" }]]) {
    const broken = nativeCaptureSourcesFromAddon({ enumerate: async () => value }); await assert.rejects(broken.enumerate("unix:/owned/native"), safeFailure);
  }
  await assert.rejects(nativeCaptureSourcesFromAddon({ enumerate: () => { throw new Error("SECRET SOURCE"); } }).enumerate("unix:/owned/native"), safeFailure);
});
test("default resolution uses current explicit default rather than first device or stale cache", async () => {
  const fixture = await socketFixture(); let calls = 0, current = [first, second];
  try {
    const sources = new PulseSourceDevices(nativeCaptureSourcesFromAddon({ enumerate(server: string) { assert.equal(server, fixture.server); calls++; return current; } }));
    assert.deepEqual(await sources.resolve({ server: fixture.server, source: "" }), { mode: "pulse", server: fixture.server, source: second.id });
    current = [{ ...first, isDefault: true }, { ...second, isDefault: false }];
    assert.equal((await sources.resolve({ server: fixture.server, source: "" })).source, first.id);
    assert.equal((await sources.resolve({ server: fixture.server, source: second.id })).source, second.id);
    await assert.rejects(sources.resolve({ server: fixture.server, source: "absent.monitor" }), safeFailure); assert.equal(calls, 4);
  } finally { await fixture.cleanup(); }
});
test("no current default or ambiguous/duplicate source metadata cannot start a default selection", async () => {
  const fixture = await socketFixture();
  try {
    for (const entries of [[], [first], [second, { ...second, id: "other" }], [first, first]]) {
      const sources = new PulseSourceDevices(nativeCaptureSourcesFromAddon({ enumerate: () => entries }));
      await assert.rejects(sources.resolve({ server: fixture.server, source: "" }), safeFailure);
    }
    const explicit = new PulseSourceDevices(nativeCaptureSourcesFromAddon({ enumerate: () => [first] }));
    assert.equal((await explicit.resolve({ server: fixture.server, source: first.id })).source, first.id);
  } finally { await fixture.cleanup(); }
});
test("invalid server/source metadata and non-owned-socket kinds refuse before native enumeration", async () => {
  const fixture = await socketFixture(); let calls = 0;
  try {
    const sources = new PulseSourceDevices({ enumerate: async () => { calls++; return [first]; } });
    const regular = join(fixture.directory, "regular"), linked = join(fixture.directory, "linked"); await writeFile(regular, "inert"); await symlink(fixture.path, linked);
    for (const server of ["", "default", "tcp:127.0.0.1:4713", "unix:relative", `${fixture.server} tcp:host`, `${fixture.server},tcp:host`,
      `unix:${fixture.directory}/../native`, `unix:${regular}`, `unix:${linked}`, `unix:${fixture.directory}`, `unix:${fixture.directory}/absent`])
      await assert.rejects(sources.enumerate({ server }), safeFailure);
    await assert.rejects(sources.resolve({ server: fixture.server, source: "bad source" }), safeFailure); assert.equal(calls, 0);
    for (const path of ["relative.node", "/owned/../native.node", "/owned/native.so", "/owned/\0native.node"])
      assert.throws(() => loadNativeCaptureSources(path), safeFailure);
  } finally { await fixture.cleanup(); }
});
test("accepted native enumeration remains pending and rejects a replaced socket before returning metadata", async () => {
  const fixture = await socketFixture(), replacement = createServer(), held = deferred<unknown>(), entered = deferred<void>(); let settled = false;
  try {
    const sources = new PulseSourceDevices(nativeCaptureSourcesFromAddon({ enumerate() { entered.resolve(); return held.promise; } }));
    const operation = sources.enumerate({ server: fixture.server }).finally(() => { settled = true; }); const rejected = assert.rejects(operation, safeFailure);
    await entered.promise; await Promise.resolve(); assert.equal(settled, false);
    // Original listening FD remains live, preventing inode reuse while the pathname is replaced.
    await unlink(fixture.path); await listen(replacement, fixture.path); held.resolve([first, second]); await rejected; assert.equal(settled, true);
  } finally { held.resolve([]); await close(replacement); await fixture.cleanup(); }
});
test("new enumeration export remains separate from the historical capture ABI", () => {
  assert.throws(() => nativeCaptureSourcesFromAddon({ create: () => ({}) }), safeFailure);
  assert.equal(typeof nativeCaptureSourcesFromAddon({ enumerate: () => [] }).enumerate, "function");
});
test("owned native source enumeration resolves the generated source without opening a capture stream", {
  skip: process.env.OPENWHISPER_OWNED_CAPTURE_SOURCES !== "1",
}, async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 1000);
  const binding = process.env.OPENWHISPER_CAPTURE_SOURCES_ADDON; assert.ok(binding);
  const server = "unix:/home/tester/source-test/runtime/pulse/native";
  const sources = new PulseSourceDevices(loadNativeCaptureSources(binding));
  const actual = await sources.enumerate({ server }); assert.ok(actual.length > 0);
  assert.ok(actual.every((item) => item.id === "openwhisper_owned_sources.monitor" || item.id === "auto_null.monitor"));
  const selected = await sources.resolve({ server, source: "" }); assert.equal(selected.source, "openwhisper_owned_sources.monitor");
  await assert.rejects(sources.resolve({ server, source: "openwhisper_missing_source" }), safeFailure);
});

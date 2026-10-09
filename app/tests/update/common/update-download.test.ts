import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { downloadUpdateCandidate, UpdateDownloadError } from "../../../src/services/update/common/update-download.js";
import type { UpdateDownloadInput } from "../../../src/services/update/common/update-download.js";
import { LINUX_UPDATE_FEED_URL, projectLinuxUpdateFeed, projectMacosUpdateRelease } from "../../../src/services/update/common/update-policy.js";
import { verifyOwnedLinuxUpdateFile } from "../../../src/services/update/linux/linux-update-file.js";
import { deferred, FakeTransport, type ResponseScript } from "../../fixtures/model-download-fixtures.js";

const unixTest = ["linux", "darwin"].includes(process.platform) ? test : test.skip;
const failure = (code: string) => (error: unknown): boolean => error instanceof UpdateDownloadError && error.code === code && error.message === code;
const bytes = Buffer.from("owned bytes");
const candidate = projectMacosUpdateRelease({ repository: "juferdinand/OpenWhisper", currentVersion: "0.2.4",
  release: { tag_name: "v0.2.5", html_url: "https://github.com/juferdinand/OpenWhisper/releases/tag/v0.2.5", draft: false, prerelease: false,
    assets: [{ name: "OpenWhisper-macOS.zip", browser_download_url: "https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/OpenWhisper-macOS.zip" }] } });
function response(input = bytes): ResponseScript {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < input.length; offset += 64 * 1024) chunks.push(input.subarray(offset, offset + 64 * 1024));
  return { headers: { status: 200, raw: ["Content-Length", String(input.length)] }, chunks };
}
async function fixture(run: (input: UpdateDownloadInput) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-update-download-"))), cacheDirectory = join(root, "cache");
  await mkdir(cacheDirectory, { mode: 0o700 });
  try { await run({ candidate, repository: candidate.repository, currentVersion: "0.2.4", cacheDirectory }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const turn = (): Promise<void> => new Promise((accept) => { setImmediate(accept); });
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!check()) { assert.ok(performance.now() < deadline); await turn(); }
}

unixTest("an inert HTTPS transfer stages the original private ZIP with partial positioned writes and no authentication claim", async () => fixture(async (input) => {
  const transport = new FakeTransport([response()]); let writes = 0;
  const stage = await downloadUpdateCandidate(input, { transport: () => transport,
    async write(file, chunk, offset, length, position) { writes++; return (await file.write(chunk, offset, Math.min(3, length), position)).bytesWritten; } });
  assert.ok(Object.isFrozen(stage)); assert.equal(stage.bytes, bytes.length); assert.equal(writes, 4);
  assert.equal((await lstat(stage.stageDirectory)).mode & 0o7777, 0o700);
  assert.equal((await stage.file.stat()).mode & 0o7777, 0o600); assert.equal((await stage.file.stat()).nlink, 1);
  const fromOriginal = Buffer.alloc(bytes.length); await stage.file.read(fromOriginal, 0, fromOriginal.length, null);
  assert.deepEqual(fromOriginal, bytes); await stage.assertUnchanged(); assert.equal(transport.closes, 1);
  assert.equal(transport.requests.length, 1); assert.equal(transport.requests[0]?.url.href, candidate.assetURL);
  assert.equal(Object.hasOwn(stage, "authentication"), false);
  await stage.cleanup(); assert.deepEqual(await readdir(input.cacheDirectory), []);
}));
unixTest("tampered policy candidates and already canceled requests perform no transport or staging effects", async () => fixture(async (input) => {
  let factories = 0; const effects = { transport: () => { factories++; return new FakeTransport([]); } };
  for (const changed of [
    { ...candidate, assetURL: candidate.assetURL.replace("github.com", "evil.invalid") },
    { ...candidate, version: "0.2.6" }, { ...candidate, assetName: "Other.zip" },
    { ...candidate, pageURL: "https://github.com/other/repository/releases/tag/v0.2.5" },
    { ...candidate, authentication: "authenticated" as "unauthenticated" },
  ]) await assert.rejects(downloadUpdateCandidate({ ...input, candidate: changed }, effects), failure("INVALID_INPUT"));
  await assert.rejects(downloadUpdateCandidate({ ...input, currentVersion: "0.3.0" }, effects), failure("INVALID_INPUT"));
  await assert.rejects(downloadUpdateCandidate({ ...input, repository: "other/repository" }, effects), failure("INVALID_INPUT"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadUpdateCandidate({ ...input, signal: controller.signal }, effects), failure("CANCELLED"));
  assert.equal(factories, 0); assert.deepEqual(await readdir(input.cacheDirectory), []);
}));
unixTest("Linux projections retain exact package, page and feed fields before any transfer", async () => fixture(async (input) => {
  const announced = projectLinuxUpdateFeed({ sourceURL: LINUX_UPDATE_FEED_URL, package: "deb", currentVersion: "0.2.4",
    feed: { version: "0.2.5", platforms: { "linux-x86_64-deb": { url: "https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/OpenWhisper-Linux-amd64.deb", signature: "opaque" } } } });
  let factories = 0;
  for (const changed of [{ ...announced, assetName: "Other.deb" }, { ...announced, pageURL: "https://github.com/other/project" },
    { ...announced, feedURL: "https://github.com/other/latest.json" }, { ...announced, target: "linux-x86_64-appimage" as const }]) {
    await assert.rejects(downloadUpdateCandidate({ ...input, candidate: changed }, { transport: () => { factories++; return new FakeTransport([]); } }), failure("INVALID_INPUT"));
  }
  assert.equal(factories, 0); assert.deepEqual(await readdir(input.cacheDirectory), []);
}));
unixTest("a CDN redirect waits for the original exchange close before requesting its target", async () => fixture(async (input) => {
  const gate = deferred<void>(), transport = new FakeTransport([
    { headers: { status: 302, raw: ["Location", "https://release-assets.githubusercontent.com/inert?notRetained=token"] }, closeGate: gate.promise }, response(),
  ]);
  const downloading = downloadUpdateCandidate(input, { transport: () => transport });
  try {
    await until(() => transport.requests.length === 1); await turn(); assert.equal(transport.requests.length, 1);
  } finally { gate.accept(); }
  const stage = await downloading;
  assert.equal(transport.requests.length, 2); assert.equal(transport.requests[1]?.url.hostname, "release-assets.githubusercontent.com");
  assert.equal(JSON.stringify(stage).includes("notRetained"), false); await stage.cleanup();
}));
unixTest("redirects refuse other assets, downgrade, credentials, alternate hosts, fragments and loops", async () => {
  for (const location of ["http://github.com/file", "https://user@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com:444/file",
    "https://release-assets.githubusercontent.com/file#secret", "https://objects.githubusercontent.com/file", "https://release-assets.githubusercontent.com.evil.invalid/file",
    "https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/Other.zip", candidate.assetURL, "\\\\evil.invalid\\file"]) {
    await fixture(async (input) => {
      const transport = new FakeTransport([{ headers: { status: 302, raw: ["Location", location] } }]);
      await assert.rejects(downloadUpdateCandidate(input, { transport: () => transport }), failure("REDIRECT_FAILED"));
      assert.equal(transport.requests.length, 1); assert.equal(transport.closes, 1); assert.deepEqual(await readdir(input.cacheDirectory), []);
    });
  }
});
unixTest("five redirects are the limit and a missing content length still measures bounded bytes", async () => fixture(async (input) => {
  const scripts = Array.from({ length: 6 }, (_unused, index): ResponseScript => ({ headers: { status: 302,
    raw: ["Location", `https://release-assets.githubusercontent.com/inert/${index}`] } }));
  const excessive = new FakeTransport(scripts);
  await assert.rejects(downloadUpdateCandidate(input, { transport: () => excessive }), failure("REDIRECT_FAILED"));
  assert.equal(excessive.requests.length, 6); assert.deepEqual(await readdir(input.cacheDirectory), []);
  const transport = new FakeTransport([{ headers: { status: 200, raw: [] }, chunks: [bytes] }]);
  const stage = await downloadUpdateCandidate(input, { transport: () => transport }); assert.equal(stage.bytes, bytes.length); await stage.cleanup();
}));
unixTest("bounded headers, lengths, terminal completion and chunks refuse before returning a stage", async () => {
  const cases: readonly [ResponseScript, string][] = [
    [{ ...response(), headers: { status: 206, raw: [] } }, "METADATA_FAILED"],
    [{ ...response(), headers: { status: 200, raw: ["Content-Length", "11", "content-length", "11"] } }, "METADATA_FAILED"],
    [{ ...response(), headers: { status: 200, raw: ["Content-Length", "011"] } }, "METADATA_FAILED"],
    [{ ...response(), headers: { status: 200, raw: ["Content-Encoding", "gzip"] } }, "METADATA_FAILED"],
    [{ ...response(), headers: { status: 200, raw: ["Private", "x".repeat(16 * 1024)] } }, "METADATA_FAILED"],
    [{ ...response(), headers: { status: 200, raw: ["Content-Length", "12"] } }, "TRANSPORT_FAILED"],
    [{ ...response(), headers: { status: 200, raw: ["Content-Length", "10"] } }, "PAYLOAD_TOO_LARGE"],
    [{ ...response(), failed: true }, "TRANSPORT_FAILED"], [{ ...response(), complete: false }, "TRANSPORT_FAILED"],
    [{ headers: { status: 200, raw: [] }, chunks: [Buffer.alloc(65_537)] }, "TRANSPORT_FAILED"],
    [{ headers: { status: 200, raw: [] }, chunks: [] }, "TRANSPORT_FAILED"],
  ];
  for (const [script, code] of cases) await fixture(async (input) => {
    const transport = new FakeTransport([script]);
    await assert.rejects(downloadUpdateCandidate(input, { transport: () => transport }), failure(code));
    assert.equal(transport.closes, 1); assert.deepEqual(await readdir(input.cacheDirectory), []);
  });
});
unixTest("overflow and actual write failure settle cleanup without deleting outside the private stage", async () => fixture(async (input) => {
  for (const maximumBytes of [0, 0.5, 1024 ** 3 + 1]) {
    await assert.rejects(downloadUpdateCandidate({ ...input, maximumBytes }, { transport: () => new FakeTransport([]) }), failure("INVALID_INPUT"));
  }
  await assert.rejects(downloadUpdateCandidate({ ...input, maximumBytes: 10 }, { transport: () => new FakeTransport([response()]) }), failure("PAYLOAD_TOO_LARGE"));
  await assert.rejects(downloadUpdateCandidate(input, { transport: () => new FakeTransport([response()]),
    async write(file, chunk, offset, length, position) { await file.write(chunk, offset, Math.min(2, length), position); throw new Error("PRIVATE WRITE DETAILS"); } }), failure("WRITE_FAILED"));
  assert.deepEqual(await readdir(input.cacheDirectory), []);
}));
unixTest("cancellation during a retained write waits for its settlement before original close and deletion", async () => fixture(async (input) => {
  const entered = deferred<void>(), release = deferred<void>(), controller = new AbortController(); let original: FileHandle | undefined, closes = 0, settled = false;
  const downloading = downloadUpdateCandidate({ ...input, signal: controller.signal }, { transport: () => new FakeTransport([response()]),
    async write(file, chunk, offset, length, position) {
      original = file; const close = file.close.bind(file); file.close = async () => { closes++; await close(); };
      const written = await file.write(chunk, offset, length, position); entered.accept(); await release.promise; return written.bytesWritten;
    } });
  const rejection = assert.rejects(downloading, failure("CANCELLED")).then(() => { settled = true; });
  await entered.promise; controller.abort(); await turn();
  try { assert.equal(settled, false); assert.equal(closes, 0); assert.ok(original && (await original.stat()).isFile()); }
  finally { release.accept(); }
  await rejection; assert.equal(closes, 1); assert.deepEqual(await readdir(input.cacheDirectory), []);
}));
unixTest("idle cancellation retains a pending original body read and total expiry retains a pending sync", async (t) => fixture(async (input) => {
  const body = deferred<void>(), transport = new FakeTransport([{ ...response(), bodyGate: body.promise }]); let settled = false;
  const rejection = assert.rejects(downloadUpdateCandidate({ ...input, limits: { idleMs: 20 } }, { transport: () => transport }), failure("TIMEOUT"))
    .then(() => { settled = true; });
  try { await until(() => transport.closes === 1); assert.equal(settled, false); assert.equal((await readdir(input.cacheDirectory)).length, 1); }
  finally { body.accept(); await rejection; }
  assert.deepEqual(await readdir(input.cacheDirectory), []);
  const entered = deferred<void>(), sync = deferred<void>(); let file: FileHandle | undefined, syncSettled = false;
  // Advance the deadline only after the retained phase; filesystem latency cannot skip its entry signal.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timed = assert.rejects(downloadUpdateCandidate({ ...input, limits: { totalMs: 20 } }, { transport: () => new FakeTransport([response()]),
    async sync(original) { file = original; entered.accept(); await sync.promise; await original.sync(); } }), failure("TIMEOUT"))
    .then(() => { syncSettled = true; });
  try {
    await Promise.race([entered.promise, timed.then(() => { assert.fail("Download settled before entering the retained sync phase."); })]);
    t.mock.timers.tick(20); await turn(); assert.equal(syncSettled, false); assert.ok(file && (await file.stat()).isFile());
  } finally { sync.accept(); try { await timed; } finally { t.mock.timers.reset(); } }
  assert.deepEqual(await readdir(input.cacheDirectory), []);
}));
unixTest("a failed original close exposes the same retained cleanup obligation and preserves the staged bytes", async () => fixture(async (input) => {
  let originalClose: (() => Promise<void>) | undefined, closes = 0, file: FileHandle | undefined;
  try {
    let failureReceipt: UpdateDownloadError | undefined;
    await assert.rejects(downloadUpdateCandidate(input, { transport: () => new FakeTransport([response()]),
      async write(original) { file = original; originalClose = original.close.bind(original);
        original.close = async () => { closes++; throw new Error("PRIVATE CLOSE DETAILS"); }; throw new Error("PRIVATE WRITE FAILURE"); },
    }), (error: unknown) => { if (!(error instanceof UpdateDownloadError) || error.code !== "CLEANUP_FAILED") return false; failureReceipt = error; return true; });
    assert.ok(failureReceipt?.cleanup); await assert.rejects(failureReceipt.cleanup(), failure("CLEANUP_FAILED"));
    assert.equal(closes, 1); assert.ok(file && (await file.stat()).isFile()); assert.equal((await readdir(input.cacheDirectory)).length, 1);
  } finally { await originalClose?.(); }
}));
unixTest("a replaced producer artifact is preserved after original close with an explicit failed cleanup receipt", async () => fixture(async (input) => {
  let replacement: string | undefined, refusal: UpdateDownloadError | undefined;
  await assert.rejects(downloadUpdateCandidate(input, { transport: () => new FakeTransport([response()]),
    async write(file, chunk, offset, length, position) {
      const result = await file.write(chunk, offset, length, position);
      const stages = await readdir(input.cacheDirectory); assert.equal(stages.length, 1);
      replacement = join(input.cacheDirectory, stages[0]!, candidate.assetName);
      await rename(replacement, `${replacement}.original`); await writeFile(replacement, "replacement", { mode: 0o600 });
      return result.bytesWritten;
    } }), (error: unknown) => {
      if (error instanceof UpdateDownloadError) refusal = error;
      return failure("CLEANUP_FAILED")(error);
    });
  assert.ok(refusal?.cleanup); assert.equal(refusal.ownersSettled?.(), true);
  await assert.rejects(refusal.cleanup(), failure("CLEANUP_FAILED"));
  assert.equal(refusal.ownersSettled?.(), true);
  assert.ok(replacement); assert.equal(await readFile(replacement, "utf8"), "replacement");
  assert.deepEqual(await readFile(`${replacement}.original`), bytes);
}));

unixTest("a rejected original transport close never certifies owner settlement or manufactures a second close", async () => fixture(async (input) => {
  class RefusingTransport extends FakeTransport {
    override async close(): Promise<void> { this.closes++; throw new Error("Owned transport close refusal"); }
  }
  const transport = new RefusingTransport([response()]);
  let original: FileHandle | undefined, refusal: UpdateDownloadError | undefined;
  try {
    await assert.rejects(downloadUpdateCandidate(input, { transport: () => transport,
      async write(file, chunk, offset, length, position) {
        original = file; return (await file.write(chunk, offset, length, position)).bytesWritten;
      } }), (error: unknown) => {
        if (error instanceof UpdateDownloadError) refusal = error;
        return failure("CLEANUP_FAILED")(error);
      });
    assert.ok(original && refusal?.cleanup); assert.equal(refusal.ownersSettled?.(), false);
    await assert.rejects(refusal.cleanup(), failure("CLEANUP_FAILED"));
    assert.equal(refusal.ownersSettled?.(), false); assert.equal(transport.closes, 1);
    assert.ok((await original.stat()).isFile());
  } finally { await original?.close(); } // Owned inert fixture only; the production refusal remains unsettled.
}));

const assets = process.env["OPENWHISPER_OWNED_UPDATE_SIGNATURE_ASSETS"];
const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest("explicit cached 0.2.5 Debian bytes transfer through inert HTTPS effects into an original file and authenticate", {
  skip: assets ? false : "Requires explicit pinned owned cache; no release-server download or network fallback.",
}, async () => fixture(async (input) => {
  assert.ok(assets && isAbsolute(assets));
  const pins = { "OpenWhisper-Linux-amd64.deb": "412d06d5475b430fd290c560ea9cd03818b6c471075f064833ebca021313b6cb",
    "OpenWhisper-Linux-amd64.deb.sig": "13032b0a95929f0061f0c596eb6ced59152165418b6f288e414caa8a8ebdff39",
    "latest.json": "387316f27d23406d2580cdc7cfede721f32a385eadf2ad707a648a321d770224" };
  const pinned = async (): Promise<void> => {
    for (const [name, expected] of Object.entries(pins)) assert.equal(createHash("sha256").update(await readFile(join(assets, name))).digest("hex"), expected);
  };
  await pinned(); const original = await readFile(join(assets, "OpenWhisper-Linux-amd64.deb"));
  const announced = projectLinuxUpdateFeed({ sourceURL: LINUX_UPDATE_FEED_URL, package: "deb", currentVersion: "0.2.4",
    feed: JSON.parse(await readFile(join(assets, "latest.json"), "utf8")) });
  const transport = new FakeTransport([response(original)]);
  const stage = await downloadUpdateCandidate({ ...input, candidate: announced }, { transport: () => transport });
  try {
    assert.equal(stage.bytes, original.length);
    assert.deepEqual(await verifyOwnedLinuxUpdateFile({ file: stage.file, stageDirectory: stage.stageDirectory,
      artifactName: "OpenWhisper-Linux-amd64.deb", signature: announced.signature, version: announced.version }), { bytes: original.length, version: "0.2.5" });
    await stage.assertUnchanged(); const first = Buffer.alloc(6); await stage.file.read(first, 0, first.length, null);
    assert.deepEqual(first, original.subarray(0, first.length)); // Authentication preserved producer offset zero.
  } finally { await stage.cleanup(); }
  assert.deepEqual(await readdir(input.cacheDirectory), []); assert.equal(transport.closes, 1); await pinned();
}));

import assert from "node:assert/strict";
import { test } from "node:test";
import { readCurrentAppImageSignature, readUpdateFeed, UPDATE_FEED_BYTES, UpdateFeedError } from "../../../src/services/update/common/update-feed.js";
import { LINUX_UPDATE_FEED_URL, LINUX_UPDATE_REPOSITORY, UPDATE_POLICY_LIMITS } from "../../../src/services/update/common/update-policy.js";
import { deferred, FakeTransport, type ResponseScript } from "../../fixtures/model-download-fixtures.js";

const failure = (code: UpdateFeedError["code"]) => (error: unknown): boolean => error instanceof UpdateFeedError && error.code === code && error.message === code;
const input = { package: "deb" as const, currentVersion: "0.2.4" };
const versioned = `${LINUX_UPDATE_REPOSITORY}/releases/download/v0.2.5/latest.json`;
const feed = { version: "0.2.5", notes: "Public notes", platforms: {
  "linux-x86_64-deb": { url: `${LINUX_UPDATE_REPOSITORY}/releases/download/v0.2.5/OpenWhisper-Linux-amd64.deb`, signature: "opaque announcement" },
  "linux-x86_64-appimage": { url: `${LINUX_UPDATE_REPOSITORY}/releases/download/v0.2.5/OpenWhisper-Linux-x86_64.AppImage`, signature: "opaque announcement" },
} };
function response(value: unknown = feed): ResponseScript {
  const bytes = Buffer.from(JSON.stringify(value));
  return { headers: { status: 200, raw: ["Content-Length", String(bytes.length)] }, chunks: [bytes] };
}
const turn = (): Promise<void> => new Promise((accept) => { setImmediate(accept); });

test("Linux feed follows its exact versioned metadata redirect after original close without authenticating assets", async () => {
  const gate = deferred<void>(), transport = new FakeTransport([
    { headers: { status: 302, raw: ["Location", versioned] }, closeGate: gate.promise },
    { headers: { status: 302, raw: ["Location", "https://release-assets.githubusercontent.com/private?opaque=not-retained"] } }, response(),
  ]);
  const reading = readUpdateFeed(input, { transport: () => transport });
  try {
    await turn(); assert.equal(transport.requests.length, 1); assert.equal(transport.requests[0]?.url.href, LINUX_UPDATE_FEED_URL);
  } finally { gate.accept(); }
  const candidate = await reading; assert.ok(candidate); assert.ok(Object.isFrozen(candidate));
  assert.equal(candidate.version, "0.2.5"); assert.equal(candidate.authentication, "unauthenticated");
  assert.equal(candidate.assetName, "OpenWhisper-Linux-amd64.deb"); assert.equal(JSON.stringify(candidate).includes("not-retained"), false);
  assert.equal(transport.requests.length, 3); assert.equal(transport.closes, 1);
  for (const currentVersion of ["0.2.5", "0.3.0"]) {
    const old = new FakeTransport([response()]);
    assert.equal(await readUpdateFeed({ ...input, currentVersion }, { transport: () => old }), undefined); assert.equal(old.closes, 1);
  }
});

test("Mac metadata uses the admitted repository API and refuses API redirects", async () => {
  const release = { tag_name: "v0.2.5", html_url: `${LINUX_UPDATE_REPOSITORY}/releases/tag/v0.2.5`, draft: false, prerelease: false,
    assets: [{ name: "OpenWhisper-macOS.zip", browser_download_url: `${LINUX_UPDATE_REPOSITORY}/releases/download/v0.2.5/OpenWhisper-macOS.zip` }] };
  const transport = new FakeTransport([response(release)]), host = { package: "macos" as const, repository: "juferdinand/OpenWhisper", currentVersion: "0.2.4" };
  assert.equal((await readUpdateFeed(host, { transport: () => transport }))?.package, "macos");
  assert.equal(transport.requests[0]?.url.href, "https://api.github.com/repos/juferdinand/OpenWhisper/releases/latest");
  const redirected = new FakeTransport([{ headers: { status: 301, raw: ["Location", "https://api.github.com/other"] } }]);
  await assert.rejects(readUpdateFeed(host, { transport: () => redirected }), failure("INVALID_REDIRECT")); assert.equal(redirected.closes, 1);
});

test("Feed source refuses foreign assets, credentials, downgrade, loops and redirected version drift", async () => {
  for (const location of ["http://github.com/file", `${versioned}?query=1`, versioned.replace("0.2.5", "00.2.5"),
    versioned.replace("latest.json", "Other.json"), versioned.replace("juferdinand", "other"),
    "https://user@release-assets.githubusercontent.com/file", "https://objects.githubusercontent.com/file", LINUX_UPDATE_FEED_URL]) {
    const transport = new FakeTransport([{ headers: { status: 302, raw: ["Location", location] } }]);
    await assert.rejects(readUpdateFeed(input, { transport: () => transport }), failure("INVALID_REDIRECT")); assert.equal(transport.closes, 1);
  }
  const drift = new FakeTransport([{ headers: { status: 302, raw: ["Location", versioned] } }, response({ ...feed, version: "0.2.6" })]);
  await assert.rejects(readUpdateFeed(input, { transport: () => drift }), failure("INVALID_METADATA")); assert.equal(drift.closes, 1);
  const hops = new FakeTransport(Array.from({ length: 6 }, (_, i) => ({ headers: { status: 302, raw: ["Location", `https://release-assets.githubusercontent.com/${i}`] } })));
  await assert.rejects(readUpdateFeed(input, { transport: () => hops }), failure("INVALID_REDIRECT")); assert.equal(hops.requests.length, 6);
});

test("Feed boundaries refuse oversized, incomplete, compressed or invalid metadata", async () => {
  const cases: readonly [ResponseScript, UpdateFeedError["code"]][] = [
    [{ headers: { status: 200, raw: ["Content-Length", String(UPDATE_FEED_BYTES + 1)] } }, "INVALID_METADATA"],
    [{ ...response(), headers: { status: 200, raw: ["Content-Encoding", "gzip"] } }, "INVALID_METADATA"],
    [{ ...response(), headers: { status: 200, raw: ["Content-Length", "1", "content-length", "1"] } }, "INVALID_METADATA"],
    [{ headers: { status: 200, raw: [] }, chunks: [Buffer.alloc(65_537)] }, "INVALID_METADATA"],
    [{ headers: { status: 200, raw: [] }, chunks: [Buffer.from([0xff])] }, "INVALID_METADATA"],
    [response({ ...feed, version: "v0.2.5" }), "INVALID_METADATA"],
    [response({ ...feed, platforms: {} }), "INVALID_METADATA"],
    [{ ...response(), complete: false }, "TRANSPORT_FAILED"], [{ ...response(), failed: true }, "TRANSPORT_FAILED"],
    [{ ...response(), headers: { status: 200, raw: ["Content-Length", "1"] } }, "INVALID_METADATA"],
  ];
  for (const [script, code] of cases) {
    const transport = new FakeTransport([script]);
    await assert.rejects(readUpdateFeed(input, { transport: () => transport }), failure(code)); assert.equal(transport.closes, 1);
  }
});

test("Cancellation and expiry retain original header and body work until it settles", async (t) => {
  for (const phase of ["headers", "body"] as const) for (const timeout of [false, true]) {
    const entered = deferred<void>(), release = deferred<void>(), controller = new AbortController();
    const transport = new FakeTransport([{ ...response(), ...(phase === "headers" ? { headersGate: release.promise } : {}) }]);
    const original = transport.request.bind(transport); let settled = false;
    transport.request = (...args) => {
      const exchange = original(...args);
      if (phase === "headers") { entered.accept(); return exchange; }
      return { ...exchange, body: { async *[Symbol.asyncIterator]() { entered.accept(); await release.promise; yield* exchange.body; } } };
    };
    if (timeout) t.mock.timers.enable({ apis: ["setTimeout"] });
    const reading = assert.rejects(readUpdateFeed({ ...input, signal: controller.signal }, { transport: () => transport }), failure(timeout ? "TIMEOUT" : "CANCELLED"))
      .then(() => { settled = true; });
    try {
      await entered.promise; if (timeout) t.mock.timers.tick(phase === "headers" ? 15_000 : 30_000); else controller.abort();
      await turn(); assert.equal(settled, false); assert.equal(transport.closes, 1);
    } finally { release.accept(); try { await reading; } finally { if (timeout) t.mock.timers.reset(); } }
  }
  const cancelled = new AbortController(); cancelled.abort(); let requests = 0;
  await assert.rejects(readUpdateFeed({ ...input, signal: cancelled.signal }, { transport() { requests++; throw new Error("unexpected"); } }), failure("CANCELLED"));
  await assert.rejects(readUpdateFeed({ ...input, currentVersion: "v0.2.4" }, { transport() { requests++; throw new Error("unexpected"); } }), failure("INVALID_INPUT"));
  assert.equal(requests, 0);
});

const currentSignature = { currentVersion: "0.2.5" };
const signatureEndpoint = `${LINUX_UPDATE_REPOSITORY}/releases/download/v0.2.5/OpenWhisper-Linux-x86_64.AppImage.sig`;
const signatureText = "Opaque current signature 日本語\n";
function signatureResponse(text = signatureText): ResponseScript {
  const bytes = Buffer.from(text);
  return { headers: { status: 200, raw: ["Content-Length", String(bytes.length), "Content-Encoding", "identity"] }, chunks: [bytes] };
}
test("Current AppImage sidecar uses the exact captured version and returns opaque text after original redirect close", async () => {
  const gate = deferred<void>(), transport = new FakeTransport([
    { headers: { status: 302, raw: ["Location", "https://release-assets.githubusercontent.com/current?opaque=not-logged"] }, closeGate: gate.promise },
    signatureResponse(),
  ]);
  const reading = readCurrentAppImageSignature(currentSignature, { transport: () => transport });
  try { await turn(); assert.equal(transport.requests.length, 1); assert.equal(transport.requests[0]?.url.href, signatureEndpoint); }
  finally { gate.accept(); }
  assert.equal(await reading, signatureText); assert.equal(transport.requests.length, 2); assert.equal(transport.closes, 1);
  assert.ok(transport.requests.every((request) => request.method === "GET"));
  const newerCurrent = new FakeTransport([signatureResponse()]);
  assert.equal(await readCurrentAppImageSignature({ currentVersion: "0.3.0" }, { transport: () => newerCurrent }), signatureText);
  assert.equal(newerCurrent.requests[0]?.url.href, signatureEndpoint.replace("v0.2.5", "v0.3.0"));
  // This reader neither parses a feed nor authenticates the returned signature against an image.
  const split = Buffer.from(signatureText), exact = "é".repeat(UPDATE_POLICY_LIMITS.signatureBytes / 2);
  for (const script of [{ ...signatureResponse(), chunks: [split.subarray(0, 26), split.subarray(26)] }, signatureResponse(exact)]) {
    const owner = new FakeTransport([script]);
    assert.equal(await readCurrentAppImageSignature(currentSignature, { transport: () => owner }), script.chunks?.length === 2 ? signatureText : exact);
    assert.equal(owner.closes, 1);
  }
});
test("Current signature redirects reject latest, other versions, assets, repositories, loops and excess hops", async () => {
  for (const location of [LINUX_UPDATE_FEED_URL, signatureEndpoint.replace("/download/v0.2.5/", "/latest/download/"),
    signatureEndpoint.replace("v0.2.5", "v0.3.0"), signatureEndpoint.replace("OpenWhisper-Linux-x86_64.AppImage.sig", "OpenWhisper-Linux-amd64.deb.sig"),
    signatureEndpoint.replace("juferdinand", "other"), `${signatureEndpoint}?query=1`, `${signatureEndpoint}#fragment`,
    "http://release-assets.githubusercontent.com/current", "https://user@release-assets.githubusercontent.com/current",
    "https://release-assets.githubusercontent.com:444/current", "https://objects.githubusercontent.com/current", signatureEndpoint]) {
    const transport = new FakeTransport([{ headers: { status: 302, raw: ["Location", location] } }]);
    await assert.rejects(readCurrentAppImageSignature(currentSignature, { transport: () => transport }), failure("INVALID_REDIRECT"));
    assert.equal(transport.requests.length, 1); assert.equal(transport.closes, 1);
  }
  const loop = new FakeTransport([{ headers: { status: 302, raw: ["Location", "https://release-assets.githubusercontent.com/current"] } },
    { headers: { status: 307, raw: ["Location", "/current"] } }]);
  await assert.rejects(readCurrentAppImageSignature(currentSignature, { transport: () => loop }), failure("INVALID_REDIRECT"));
  assert.equal(loop.requests.length, 2); assert.equal(loop.closes, 1);
  const hops = new FakeTransport(Array.from({ length: 6 }, (_, index) => ({ headers: { status: 302,
    raw: ["Location", `https://release-assets.githubusercontent.com/current-${index}`] } })));
  await assert.rejects(readCurrentAppImageSignature(currentSignature, { transport: () => hops }), failure("INVALID_REDIRECT"));
  assert.equal(hops.requests.length, 6); assert.equal(hops.closes, 1);
});
test("Current signature text enforces the 16 KiB byte bound, identity encoding, fatal UTF-8 and complete transport", async () => {
  const cases: readonly [ResponseScript, UpdateFeedError["code"]][] = [
    [{ headers: { status: 404, raw: [] } }, "INVALID_METADATA"],
    [{ headers: { status: 200, raw: ["Content-Length", String(UPDATE_POLICY_LIMITS.signatureBytes + 1)] } }, "INVALID_METADATA"],
    [{ headers: { status: 200, raw: [] }, chunks: [Buffer.alloc(8192), Buffer.alloc(8192), Buffer.alloc(1)] }, "INVALID_METADATA"],
    [signatureResponse("é".repeat(8193)), "INVALID_METADATA"],
    [{ ...signatureResponse(), headers: { status: 200, raw: ["Content-Encoding", "gzip"] } }, "INVALID_METADATA"],
    [{ ...signatureResponse(), headers: { status: 200, raw: ["Content-Length", "1", "content-length", "1"] } }, "INVALID_METADATA"],
    [{ headers: { status: 200, raw: [] }, chunks: [Buffer.from([0xff])] }, "INVALID_METADATA"],
    [{ headers: { status: 200, raw: [] }, chunks: [Buffer.alloc(0)] }, "INVALID_METADATA"],
    [signatureResponse(" \n\t"), "INVALID_METADATA"],
    [{ headers: { status: 200, raw: [] } }, "TRANSPORT_FAILED"],
    [{ ...signatureResponse(), complete: false }, "TRANSPORT_FAILED"], [{ ...signatureResponse(), failed: true }, "TRANSPORT_FAILED"],
    [{ ...signatureResponse(), headers: { status: 200, raw: ["Content-Length", "16000"] } }, "TRANSPORT_FAILED"],
  ];
  for (const [script, code] of cases) {
    const transport = new FakeTransport([script]);
    await assert.rejects(readCurrentAppImageSignature(currentSignature, { transport: () => transport }), failure(code)); assert.equal(transport.closes, 1);
  }
});
test("Current signature cancellation and expiry await original pending work and cleanup", async (t) => {
  for (const phase of ["headers", "body"] as const) for (const timeout of [false, true]) {
    const entered = deferred<void>(), release = deferred<void>(), controller = new AbortController();
    const transport = new FakeTransport([{ ...signatureResponse(), ...(phase === "headers" ? { headersGate: release.promise } : {}) }]);
    const original = transport.request.bind(transport); let settled = false;
    transport.request = (...args) => {
      const exchange = original(...args);
      if (phase === "headers") { entered.accept(); return exchange; }
      return { ...exchange, body: { async *[Symbol.asyncIterator]() { entered.accept(); await release.promise; yield* exchange.body; } } };
    };
    if (timeout) t.mock.timers.enable({ apis: ["setTimeout"] });
    const reading = assert.rejects(readCurrentAppImageSignature({ ...currentSignature, signal: controller.signal }, { transport: () => transport }),
      failure(timeout ? "TIMEOUT" : "CANCELLED")).then(() => { settled = true; });
    try {
      await entered.promise; if (timeout) t.mock.timers.tick(phase === "headers" ? 15_000 : 30_000); else controller.abort();
      await turn(); assert.equal(settled, false); assert.equal(transport.closes, 1);
    } finally { release.accept(); try { await reading; } finally { if (timeout) t.mock.timers.reset(); } }
  }
  const cancelled = new AbortController(); cancelled.abort(); let requests = 0;
  const inert = { transport() { requests++; throw new Error("unexpected"); } };
  await assert.rejects(readCurrentAppImageSignature({ ...currentSignature, signal: cancelled.signal }, inert), failure("CANCELLED"));
  for (const currentVersion of ["v0.2.5", "00.2.5", "0.2.5/../latest", "18446744073709551616.0.0"]) {
    await assert.rejects(readCurrentAppImageSignature({ currentVersion }, inert), failure("INVALID_INPUT"));
  }
  assert.equal(requests, 0);
  const gate = deferred<void>(), transport = new FakeTransport([signatureResponse()], gate.promise); let settled = false;
  const reading = readCurrentAppImageSignature(currentSignature, { transport: () => transport }).then(() => { settled = true; });
  try { await turn(); assert.equal(transport.closes, 1); assert.equal(settled, false); } finally { gate.accept(); await reading; }
  const broken = new FakeTransport([signatureResponse()]); broken.close = () => Promise.reject(new Error("private cleanup diagnostic"));
  await assert.rejects(readCurrentAppImageSignature(currentSignature, { transport: () => broken }), failure("CLEANUP_FAILED"));
});

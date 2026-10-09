import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BODY_BYTES, BOUNDS, CASES, IMAGE, NODE_ARCHIVE_SHA256, NODE_BINARY_SHA256, NODE_VERSION, ORIGINAL, REDIRECT,
  FixtureError, bodyChunk, bodyHash, bounded, route, validatePreparedCache, validateSuite } from "./contracts.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/settings/profiles.js";
import { Witness, NotificationGate } from "./witness.js";
import { constructedEnvironment, validateContainer } from "./run.js";
import { readReviewedBundle, reviewedBundleSchema } from "./reviewed-bundle.js";
import { cleanupOwnedNamespace } from "./cleanup.js";

test("closed fixture routing refuses every custom authority path method and query without effects", () => {
  assert.equal(route(new URL(ORIGINAL), "HEAD"), "resolve"); assert.equal(route(new URL(REDIRECT), "GET"), "payload");
  for (const input of ["https://127.0.0.1/", ORIGINAL + "?token=inert", ORIGINAL + "#fragment", ORIGINAL.replace("https", "http"),
    ORIGINAL.replace("huggingface.co", "huggingface.co.evil.invalid"), REDIRECT + "/other"]) assert.throws(() => route(new URL(input), "GET"), FixtureError);
  assert.throws(() => route(new URL(REDIRECT), "HEAD"), FixtureError); assert.throws(() => route(new URL(ORIGINAL), "POST"), FixtureError);
});
test("synthetic ledger has a counted tail independent of partitions and finite suite envelopes", () => {
  assert.equal(bodyChunk(BODY_BYTES - 17).length, 17); assert.equal(bodyChunk(BODY_BYTES).length, 0);
  assert.equal(bodyHash().length, 64); assert.equal(CASES.length, 13);
  assert.ok(8 * BOUNDS.toolMs + CASES.length * (BOUNDS.caseMs + BOUNDS.cleanupMs) + 10_000 < BOUNDS.fixtureMs);
  assert.ok(8 * BOUNDS.dockerMs + BOUNDS.executeMs + 20_000 < BOUNDS.outerMs);
});
test("monotonic late completion cannot win a delayed timer without actual wait or socket", async () => {
  let now = 0; const work = Promise.resolve().then(() => { now = 101; return 1; });
  await assert.rejects(bounded(work, 100, () => now), FixtureError);
});
test("independent close witness distinguishes destroy intent and notification delivery", async () => {
  const original = Object.assign(new EventEmitter(), { destroyed: true }); const witness = new Witness(), gate = new NotificationGate();
  witness.observe(original as unknown as ClientRequest, "request");
  let observed = false; original.once("close", () => { gate.receive(() => { observed = true; }); });
  assert.equal(witness.snapshot("request").closed, 0); original.emit("close"); await witness.closed();
  assert.equal(witness.snapshot("request").closed, 1); assert.equal(observed, false); gate.release(); assert.equal(observed, true);
});
test("suite receipt refuses zero-case and forged incomplete closure receipts", () => {
  assert.throws(() => validateSuite({ cases: [] }));
  const cases = CASES.map((name) => ({ case: name, status: "PASS", outcome: name === "success" ? "installed" : name.startsWith("held-") ? "CLEANUP_FAILED" :
    name.startsWith("cancel-") ? "CANCELLED" : name.startsWith("deadline-") ? "TIMEOUT" : "TRANSPORT_FAILED",
    bodyBytes: BODY_BYTES, bodySha256: bodyHash(), maximumChunkBytes: 16_384, requestCount: 3, serverRequestCount: name === "wrong-san" || name === "untrusted-ca" ? 0 : 3,
    request: { acquired: 3, closed: 3, errors: 0 }, response: { acquired: 3, closed: 3, errors: 0 }, socket: { acquired: 3, closed: 3, errors: 0 },
    serverAcquired: 3, serverClosed: 3, serverCloseObserved: true, serverConnections: 0, cleanupFinalized: true,
    notificationBarrier: name.startsWith("held-") ? name.slice(5) : "none", notificationOnly: name.startsWith("held-"),
    apparentEOFObserved: name === "late-local-error", localErrorObserved: name === "late-local-error", parserIncompleteObserved: name === "truncated", elapsedMilliseconds: 1 }));
  const receipt = { scope: "owned-loopback-tls-with-fixture-routing-and-ca", node: NODE_VERSION, image: IMAGE, cases,
    noProductionTrustOverride: true, noProviderDownload: true, noElectronRuntime: true, privateProfileOnly: true };
  validateSuite(receipt);
  const invalid = structuredClone(receipt); invalid.cases[0]!.socket.closed = 2; assert.throws(() => validateSuite(invalid), FixtureError);
  const falseOutcome = structuredClone(receipt); falseOutcome.cases[1]!.outcome = "installed"; assert.throws(() => validateSuite(falseOutcome), FixtureError);
  const falseEOF = structuredClone(receipt); falseEOF.cases[4]!.localErrorObserved = false; assert.throws(() => validateSuite(falseEOF), FixtureError);
});
test("container policy refuses mounts capabilities network privilege and hidden security overrides", () => {
  const base = { Id: "a".repeat(64), Image: IMAGE, Config: { User: "1000:1000" }, Mounts: [], State: { Running: false }, HostConfig: {
    NetworkMode: "none", Privileged: false, CapAdd: null, CapDrop: ["ALL"], Devices: null, DeviceRequests: null, Binds: null,
    SecurityOpt: ["no-new-privileges"], PidMode: "", IpcMode: "private", Memory: 1_073_741_824, NanoCpus: 2_000_000_000, PidsLimit: 128,
    Ulimits: [{ Name: "core", Soft: 0, Hard: 0 }] } };
  validateContainer(base);
  for (const patch of [{ NetworkMode: "host" }, { Privileged: true }, { CapAdd: ["SYS_ADMIN"] }, { Devices: [{}] },
    { Binds: ["/home:/host"] }, { SecurityOpt: ["no-new-privileges", "seccomp=unconfined"] }, { PidMode: "host" }, { Memory: 0 },
    { Ulimits: [] }, { Ulimits: [{ Name: "core", Soft: 0, Hard: 1 }] }])
    assert.throws(() => validateContainer({ ...base, HostConfig: { ...base.HostConfig, ...patch } }));
  assert.throws(() => validateContainer({ ...base, Mounts: [{}] }));
  assert.throws(() => validateContainer({ ...base, State: { Running: true } }));
  assert.equal(Object.keys(constructedEnvironment).length, 8);
  for (const name of ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "HTTPS_PROXY", "HF_TOKEN", "DOCKER_HOST", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS"])
    assert.equal(Object.hasOwn(constructedEnvironment, name), false);
});
test("closure snapshot refuses a late synthetic ownership transfer without certifying disposal", async () => {
  const first = new EventEmitter(), second = new EventEmitter(), witness = new Witness();
  witness.observe(first as unknown as ClientRequest, "request"); const completion = witness.closed();
  first.emit("close"); witness.observe(second as unknown as ClientRequest, "request");
  await assert.rejects(completion, FixtureError);
  assert.equal(witness.snapshot("request").closed, 1); assert.equal(witness.snapshot("request").acquired, 2);
});

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function privateBundle(effect: (directory: string, input: Record<string, unknown>, inputSha256: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-inert-tls-bundle-"))); await chmod(directory, 0o700);
  const fixture = Buffer.from("inert-not-executable"), catalog = Buffer.from("{}"), license = Buffer.from("inert-notice");
  const input: Record<string, unknown> = { version: 1, image: IMAGE, node: NODE_VERSION, nodeArchiveSha256: NODE_ARCHIVE_SHA256,
    nodeBinarySha256: NODE_BINARY_SHA256, fixtureSha256: digest(fixture), catalogSha256: digest(catalog), zodLicenseSha256: digest(license),
    sources: { "app/tests/owned-model-download/contracts.ts": digest(await readFile(fileURLToPath(new URL("contracts.ts", import.meta.url)))) },
    authoredLanguage: "TypeScript", runtimeReviewedSeparately: true };
  const bytes = Buffer.from(JSON.stringify(input));
  try {
    for (const [name, value] of [["input.json", bytes], ["fixture.mjs", fixture], ["models.json", catalog], ["LICENSE-zod", license]] as const)
      await writeFile(join(directory, name), value, { mode: 0o600 });
    await effect(directory, input, digest(bytes));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("reviewed bundle guard captures exact owned bytes and refuses approval or payload drift without executing them", async () => {
  await privateBundle(async (directory, _input, inputSha256) => {
    const captured = await readReviewedBundle({ directory, inputSha256 }); assert.equal(captured["fixture.mjs"].toString(), "inert-not-executable");
    await assert.rejects(readReviewedBundle({ directory, inputSha256: "0".repeat(64) }), FixtureError);
    await writeFile(join(directory, "fixture.mjs"), "changed-inert-bytes", { mode: 0o600 });
    await assert.rejects(readReviewedBundle({ directory, inputSha256 }), FixtureError);
    assert.equal(captured["fixture.mjs"].toString(), "inert-not-executable");
  });
  for (const directory of ["relative", "/tmp/../owned", "/tmp/./owned", "/tmp/owned\0suffix"])
    assert.equal(reviewedBundleSchema.safeParse({ directory, inputSha256: "a".repeat(64) }).success, false);
  assert.equal(reviewedBundleSchema.safeParse({ directory: "/tmp/owned", inputSha256: "a".repeat(64), unreviewed: true }).success, false);
});
test("reviewed bundle refuses source-hash drift unsafe source paths extra files symlink and changed private mode", async () => {
  await privateBundle(async (directory, input) => {
    input.sources = { "app/tests/owned-model-download/contracts.ts": "0".repeat(64) };
    let bytes = Buffer.from(JSON.stringify(input)); await writeFile(join(directory, "input.json"), bytes);
    await assert.rejects(readReviewedBundle({ directory, inputSha256: digest(bytes) }), FixtureError);
    input.sources = { "app/tests/../../inert": "0".repeat(64) };
    bytes = Buffer.from(JSON.stringify(input)); await writeFile(join(directory, "input.json"), bytes);
    await assert.rejects(readReviewedBundle({ directory, inputSha256: digest(bytes) }), FixtureError);
  });
  await privateBundle(async (directory, _input, inputSha256) => {
    await writeFile(join(directory, "extra"), "inert", { mode: 0o600 });
    await assert.rejects(readReviewedBundle({ directory, inputSha256 }), FixtureError); await rm(join(directory, "extra"));
    await chmod(join(directory, "fixture.mjs"), 0o644); await assert.rejects(readReviewedBundle({ directory, inputSha256 }), FixtureError);
    await rm(join(directory, "fixture.mjs")); await symlink("models.json", join(directory, "fixture.mjs"));
    await assert.rejects(readReviewedBundle({ directory, inputSha256 }), FixtureError);
  });
});
test("failed capture and held original CLI cannot mask independent owned removal or fabricate cleanup", async () => {
  const calls: string[] = []; let originalClosed = false;
  const receipt = await cleanupOwnedNamespace({ creationConfirmed: true, capture: async () => { calls.push("capture"); throw new FixtureError(); },
    remove: async () => { calls.push("remove"); }, absence: async () => { calls.push("absence"); },
    originalsClosed: async () => { calls.push("original"); if (!originalClosed) throw new FixtureError(); } });
  assert.deepEqual(calls, ["capture", "remove", "absence", "original"]);
  assert.equal(receipt.evidenceCaptured, false); assert.equal(receipt.removalReturned, true); assert.equal(receipt.absenceObserved, true);
  assert.equal(receipt.originalCLIClosuresObserved, false); assert.equal(receipt.namespaceCleanupConfirmed, false);
  originalClosed = true; assert.equal(receipt.namespaceCleanupConfirmed, false);
});
test("removal refusal still attempts absence and original closure but cannot issue a namespace certificate", async () => {
  const calls: string[] = [];
  const receipt = await cleanupOwnedNamespace({ creationConfirmed: true, capture: async () => { calls.push("capture"); },
    remove: async () => { calls.push("remove"); throw new FixtureError(); }, absence: async () => { calls.push("absence"); },
    originalsClosed: async () => { calls.push("original"); } });
  assert.deepEqual(calls, ["capture", "remove", "absence", "original"]);
  assert.equal(receipt.originalCLIClosuresObserved, true); assert.equal(receipt.namespaceCleanupConfirmed, false);
});
test("an unconfirmed creation remains uncertified even when cleanup CLI observations all succeed", async () => {
  const receipt = await cleanupOwnedNamespace({ creationConfirmed: false, capture: async () => {}, remove: async () => {},
    absence: async () => {}, originalsClosed: async () => {} });
  assert.equal(receipt.removalReturned, true); assert.equal(receipt.absenceObserved, true);
  assert.equal(receipt.originalCLIClosuresObserved, true); assert.equal(receipt.namespaceCleanupConfirmed, false);
});

async function preparedCache(effect: (cache: string, home: string, uid: number) => Promise<void>): Promise<void> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-inert-tls-cache-")));
  await chmod(home, 0o700); const uid = process.getuid?.(); assert.notEqual(uid, undefined);
  try {
    const profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ home }));
    await effect(profile.paths.cache, home, uid!);
  } finally { await rm(home, { recursive: true, force: true }); }
}
test("download cache receipt accepts the actual prepared private empty profile directories", async () => {
  await preparedCache(async (cache, _home, uid) => {
    await validatePreparedCache(cache, uid); await validatePreparedCache(cache, uid);
  });
});
test("download cache receipt rejects additional staging and data retained inside a prepared directory", async () => {
  await preparedCache(async (cache, _home, uid) => {
    const staging = join(cache, "model-download-inert"); await mkdir(staging, { mode: 0o700 });
    await assert.rejects(validatePreparedCache(cache, uid), FixtureError); await rmdir(staging);
    const retained = join(cache, "session", "unexpected-inert"); await writeFile(retained, "inert", { mode: 0o600 });
    await assert.rejects(validatePreparedCache(cache, uid), FixtureError); await rm(retained);
    await validatePreparedCache(cache, uid);
  });
});
test("download cache receipt rejects a prepared directory replaced with a symlink", async () => {
  await preparedCache(async (cache, home, uid) => {
    const outside = join(home, "owned-empty-target"); await mkdir(outside, { mode: 0o700 });
    const session = join(cache, "session"); await rmdir(session); await symlink(outside, session);
    await assert.rejects(validatePreparedCache(cache, uid), FixtureError);
  });
});
test("download cache receipt rejects changed root child permissions and owner expectation", async () => {
  await preparedCache(async (cache, _home, uid) => {
    await chmod(cache, 0o755); await assert.rejects(validatePreparedCache(cache, uid), FixtureError); await chmod(cache, 0o700);
    const control = join(cache, "control"); await chmod(control, 0o701);
    await assert.rejects(validatePreparedCache(cache, uid), FixtureError); await chmod(control, 0o700);
    await assert.rejects(validatePreparedCache(cache, uid + 1), FixtureError);
    await validatePreparedCache(cache, uid);
  });
});
test("download cache receipt rejects a missing prepared directory", async () => {
  await preparedCache(async (cache, _home, uid) => {
    await rmdir(join(cache, "locks")); await assert.rejects(validatePreparedCache(cache, uid), FixtureError);
  });
});

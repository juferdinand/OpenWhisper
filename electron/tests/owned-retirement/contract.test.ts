import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AllocationFence, FixtureError, MAX_FRAME_BYTES, boundedFrame, confirmAdmission, identitySchema,
  diagnosticSignal, expectedExitMatches, parseReply, parseRequest, ProbeFailure, probeFailureMetadata, probeFailureSchema,
  EXPECTED_WITNESS_SHA256, IMAGE, SECCOMP_SHA256, type IdentityReply, type Reply, type Request } from "./contract.js";
import { OwnedLink, type ChildTransport } from "./probe.js";
import { RuntimeVerificationFailure, assertOwnedRawBrowserIdentity, assertRuntimeFileIOShape,
  runtimeFailureMetadata, runtimeInputSchema, runtimeVerificationMetadataSchema } from "./acceptance.js";
import { executeReviewedOwnedRetirement } from "./run.js";
import { assertNoForbiddenEnvironment, bootstrapFailureMetadata } from "./bootstrap.js";

const epoch = randomUUID(), first = "a".repeat(64), second = "b".repeat(64);
const expected = { pid: 70003, parentPid: 70002, epoch, mode: "normal" } satisfies { pid: number; parentPid: number; epoch: string; mode: "normal" };
const identity = (nonce: string): IdentityReply => identitySchema.parse({ version: 1, kind: "identity", epoch, nonce,
  pid: expected.pid, parentPid: expected.parentPid, uid: 1000, startTicks: "123456789", mode: "normal" });
const candidate = { level: "running", canAdmit: true, identity: { pid: expected.pid, parentPid: expected.parentPid,
  epoch, uid: 1000, startTicks: 123456789n } } satisfies import("../../src/services/process-retirement.js").InitialRetirementObservation;

test("owned termination honors Electron's documented zero status without changing Node's signal contract", () => {
  assert.equal(expectedExitMatches("electron", "owned-term", 0, null), true);
  for (const [code, signal] of [[15, null], [1, null], [null, "SIGTERM"], [0, "SIGKILL"]] satisfies [number | null, string | null][]) {
    assert.equal(expectedExitMatches("electron", "owned-term", code, signal), false);
  }
  assert.equal(expectedExitMatches("node", "owned-term", 0, null), false);
  assert.equal(expectedExitMatches("node", "owned-term", null, "SIGTERM"), true);
  assert.equal(expectedExitMatches("node", "owned-term", 1, null), true);
});

test("self exit, delayed cleanup and held readers still require zero status and self-abort remains abnormal", () => {
  for (const runtime of ["node", "electron"] satisfies ("node" | "electron")[]) {
    for (const name of ["self-exit", "delayed-term", "held-close"] satisfies ("self-exit" | "delayed-term" | "held-close")[]) {
      assert.equal(expectedExitMatches(runtime, name, 0, null), true);
      assert.equal(expectedExitMatches(runtime, name, 1, null), false);
      assert.equal(expectedExitMatches(runtime, name, null, "SIGTERM"), false);
    }
    assert.equal(expectedExitMatches(runtime, "self-abort", 0, null), false);
    assert.equal(expectedExitMatches(runtime, "self-abort", null, "SIGABRT"), true);
    assert.equal(expectedExitMatches(runtime, "self-abort", 134, null), true);
  }
});

test("post-admission failure diagnostics expose only fixed stages and bounded runtime status", () => {
  const detail = { category: "PROBE_CASE_FAILED", runtime: "electron", suite: "lifecycle", case: "owned-term",
    stage: "exit-validation", level: "reaped", exitObserved: true, exitCode: 0, exitSignal: null };
  const error = new ProbeFailure(detail);
  assert.deepEqual(probeFailureMetadata(error), detail);
  assert.deepEqual(probeFailureMetadata(new Error("private-error-must-not-appear")), {});
  assert.deepEqual(probeFailureMetadata({ ...detail, message: "private-error-must-not-appear" }), {});
  for (const change of [{ runtime: "renderer" }, { suite: "arbitrary" }, { case: "unowned-pid" }, { stage: "arbitrary-stage" },
    { level: "exit-event" }, { exitObserved: "true" }, { exitCode: Infinity }, { exitCode: NaN }, { exitCode: 0.5 },
    { exitCode: 0x1_0000_0000 }, { exitCode: -0x8000_0001 }, { exitSignal: "private-error-must-not-appear" },
    { path: "/private/path" }, { message: "private-error-must-not-appear" }]) {
    assert.equal(probeFailureSchema.safeParse({ ...detail, ...change }).success, false);
    assert.throws(() => new ProbeFailure({ ...detail, ...change }));
  }
  for (const signal of [null, "SIGTERM", "SIGKILL", "SIGABRT"]) assert.equal(diagnosticSignal(signal), signal);
  assert.equal(diagnosticSignal("private-signal-must-not-appear"), "OTHER");
  assert.equal(JSON.stringify(probeFailureMetadata(error)).includes("private-error-must-not-appear"), false);
  // Runtime verification retains its own category unless this closed fixture error is present.
  assert.deepEqual({ ...runtimeFailureMetadata(error), ...probeFailureMetadata(error) }, detail);
  const verifier = new RuntimeVerificationFailure({ category: "RUNTIME_VERIFICATION_FAILED", stage: "runtime-file", operation: "file-identity" });
  assert.deepEqual({ ...runtimeFailureMetadata(verifier), ...probeFailureMetadata(verifier) }, runtimeFailureMetadata(verifier));
});

test("bootstrap diagnostics name only a forbidden key and reject sentinels without runtime identity", () => {
  assert.doesNotThrow(() => assertNoForbiddenEnvironment({ HOME: "/private-fixture", DISPLAY: ":99" }));
  for (const key of ["NODE_OPTIONS", "DBUS_SESSION_BUS_ADDRESS", "PULSE_SERVER", "LD_LIBRARY_PATH"]) {
    for (const value of ["private-value-must-never-appear", "", undefined]) {
      try { assertNoForbiddenEnvironment({ [key]: value }); assert.fail("Forbidden key was accepted"); }
      catch (error) {
        assert.deepEqual(bootstrapFailureMetadata(error), { category: "FORBIDDEN_ENVIRONMENT_KEY", key });
        assert.equal(JSON.stringify(bootstrapFailureMetadata(error)).includes("private-value-must-never-appear"), false);
      }
    }
  }
  assert.throws(() => assertNoForbiddenEnvironment({ DBUS_SESSION_BUS_ADDRESS: "disabled:" }), FixtureError);
  assert.deepEqual(bootstrapFailureMetadata(new Error("private-arbitrary-error")), { category: "BOOTSTRAP_FAILED" });
});

test("only the exact pinned browser may retain Chromium's literal disabled D-Bus sentinel", () => {
  const browser = { processType: "browser", electronVersion: "44.7.0", executable: "/owned-runtime/electron/electron" };
  assert.doesNotThrow(() => assertNoForbiddenEnvironment({ DBUS_SESSION_BUS_ADDRESS: "disabled:" }, browser));
  for (const value of ["", undefined, "disabled", "Disabled:", " disabled:", "disabled: ", "autolaunch:",
    "unix:path=/run/user/1000/bus", "tcp:host=127.0.0.1,port=1234"]) {
    assert.throws(() => assertNoForbiddenEnvironment({ DBUS_SESSION_BUS_ADDRESS: value }, browser), FixtureError);
  }
  for (const runtime of [{ ...browser, processType: null }, { ...browser, processType: "utility" },
    { ...browser, processType: "renderer" }, { ...browser, electronVersion: null }, { ...browser, electronVersion: "44.7.1" },
    { ...browser, executable: "/opt/node/bin/node" }, { ...browser, executable: "/other-runtime/electron" }]) {
    assert.throws(() => assertNoForbiddenEnvironment({ DBUS_SESSION_BUS_ADDRESS: "disabled:" }, runtime), FixtureError);
  }
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "LD_PRELOAD",
    "LD_LIBRARY_PATH", "DBUS_SYSTEM_BUS_ADDRESS", "PULSE_SERVER", "PIPEWIRE_REMOTE", "WAYLAND_DISPLAY"]) {
    assert.throws(() => assertNoForbiddenEnvironment({ DBUS_SESSION_BUS_ADDRESS: "disabled:", [key]: "" }, browser), FixtureError);
  }
});

test("runtime failure metadata permits only categorical stages and bounded identity diagnostics", () => {
  const detail = { category: "RUNTIME_VERIFICATION_FAILED", stage: "runtime-file", operation: "file-identity",
    index: 23, observedKind: "directory", links: 0 };
  const error = new RuntimeVerificationFailure(detail);
  assert.deepEqual(runtimeFailureMetadata(error), detail);
  assert.deepEqual(runtimeFailureMetadata(new Error("private-content-must-not-appear")), { category: "OTHER_PROBE_FAILURE" });
  assert.deepEqual(runtimeFailureMetadata({ ...detail, message: "private-content-must-not-appear" }), { category: "OTHER_PROBE_FAILURE" });
  for (const change of [{ path: "/private/path" }, { message: "private-content-must-not-appear" }, { index: -1 }, { index: 1024 },
    { index: Infinity }, { operation: "exec" }, { stage: "private-arbitrary-stage" }, { observedKind: "arbitrary-string" },
    { links: -1 }, { links: Infinity }, { links: 0x1_0000_0000 }]) {
    assert.equal(runtimeVerificationMetadataSchema.safeParse({ ...detail, ...change }).success, false);
    assert.throws(() => new RuntimeVerificationFailure({ ...detail, ...change }));
  }
  assert.equal(JSON.stringify(runtimeFailureMetadata(error)).includes("private-content-must-not-appear"), false);
});

test("raw runtime verifier requires exact owned browser identity and rejects malformed API shapes", () => {
  const identity = { processType: "browser", electronVersion: "44.7.0", executable: "/owned-runtime/electron/electron" };
  assert.doesNotThrow(() => assertOwnedRawBrowserIdentity(identity));
  for (const change of [{ processType: "utility" }, { processType: "renderer" }, { processType: null },
    { electronVersion: null }, { electronVersion: "44.7.1" }, { executable: "/opt/node/bin/node" },
    { executable: "/other/electron" }, { path: "/private-path-must-not-appear" }]) {
    assert.throws(() => assertOwnedRawBrowserIdentity({ ...identity, ...change }));
  }
  const api = { lstat: () => {}, open: () => {}, readFile: () => {} };
  assert.doesNotThrow(() => assertRuntimeFileIOShape(api));
  for (const input of [undefined, null, "module-name", {}, { ...api, lstat: undefined }, { ...api, open: null }, { ...api, readFile: "function" }]) {
    assert.throws(() => assertRuntimeFileIOShape(input));
  }
  const failure = new RuntimeVerificationFailure({ category: "RUNTIME_VERIFICATION_FAILED", stage: "runtime-filesystem", operation: "import" });
  assert.deepEqual(runtimeFailureMetadata(failure), { category: "RUNTIME_VERIFICATION_FAILED", stage: "runtime-filesystem", operation: "import" });
});

test("private protocol rejects unknown fields, oversized frames, invalid identity and noncanonical birth", () => {
  assert.equal(parseRequest({ version: 1, kind: "challenge", epoch, nonce: first }).kind, "challenge");
  for (const input of [{ version: 1, kind: "challenge", epoch, nonce: first, path: "/proc/1" },
    { version: 1, kind: "action", epoch, nonce: first, action: "kill-any-pid" },
    { version: 2, kind: "challenge", epoch, nonce: first }, { version: 1, kind: "challenge", epoch, nonce: "short" }]) assert.throws(() => parseRequest(input));
  assert.throws(() => boundedFrame({ text: "x".repeat(MAX_FRAME_BYTES) }), FixtureError);
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic; assert.throws(() => boundedFrame(cyclic), FixtureError);
  for (const change of [{ uid: 1001 }, { startTicks: "0123" }, { startTicks: "18446744073709551616" }, { pid: Infinity }, { shell: "anything" }]) {
    assert.throws(() => parseReply({ ...identity(first), ...change }));
  }
});

test("candidate identity requires two fresh original-channel birth confirmations before admission", () => {
  confirmAdmission(identity(first), candidate, identity(second), expected);
  assert.throws(() => confirmAdmission(identity(first), candidate, identity(first), expected), FixtureError);
  assert.throws(() => confirmAdmission(identity(first), { ...candidate, canAdmit: false }, identity(second), expected), FixtureError);
  assert.throws(() => confirmAdmission(identity(first), { level: "reaped", canAdmit: false, identity: null }, identity(second), expected), FixtureError);
  for (const change of [{ pid: 70004 }, { parentPid: 70004 }, { epoch: randomUUID() }, { startTicks: "123456790" }]) {
    assert.throws(() => confirmAdmission(identitySchema.parse({ ...identity(first), ...change }), candidate, identity(second), expected), FixtureError);
    assert.throws(() => confirmAdmission(identity(first), candidate, identitySchema.parse({ ...identity(second), ...change }), expected), FixtureError);
  }
});

test("first-snapshot same-UID same-parent PID adoption cannot admit the stale original child", () => {
  const reused = { ...candidate, identity: { ...candidate.identity, startTicks: 123456790n } };
  assert.throws(() => confirmAdmission(identity(first), reused, identity(second), expected), FixtureError);
});

test("continuing allocation cannot spawn after ambiguity, zombie release or a new epoch", () => {
  const fence = new AllocationFence(); fence.reserve(); assert.equal(fence.spawnCount, 1);
  assert.throws(() => fence.reserve(), FixtureError); fence.retired("reaped"); fence.reserve();
  assert.throws(() => fence.retired("non-running"), FixtureError); assert.equal(fence.failed, true);
  for (let attempt = 0; attempt < 3; attempt++) assert.throws(() => fence.reserve(), FixtureError);
  assert.equal(fence.spawnCount, 2); assert.throws(() => fence.retired("reaped"), FixtureError);
  const other = new AllocationFence(); other.reserve(); other.poison(); assert.throws(() => other.reserve(), FixtureError);
});

function inertChannel() {
  let onMessage: (input: unknown) => void = () => {}, onSpawn = (): void => {},
    onExit: (code: number | null, signal: string | null) => void = () => {}, onFailure = (): void => {};
  let sent: Request | null = null, killed = 0, pid: number | undefined = expected.pid;
  const transport: ChildTransport = { pid: () => pid, send: async (request) => { sent = request; }, kill: () => { killed++; return true; },
    onMessage: (listener) => { onMessage = listener; }, onSpawn: (listener) => { onSpawn = listener; },
    onExit: (listener) => { onExit = listener; }, onFailure: (listener) => { onFailure = listener; } };
  const link = new OwnedLink(transport, epoch, "normal");
  return { link, spawn: () => { onSpawn(); }, reply: (input: unknown) => { onMessage(input); }, failure: () => { onFailure(); },
    exit: () => { pid = undefined; onExit(0, null); }, killed: () => killed,
    request: (): Request => { assert.ok(sent); return sent; } };
}
async function replyTo(channel: ReturnType<typeof inertChannel>): Promise<Reply> {
  await new Promise<void>((accept) => setImmediate(accept));
  const request = channel.request(); return { ...identity(request.nonce), epoch: request.epoch };
}

test("original returned object owns PID and every challenge uses a fresh nonce", async () => {
  const channel = inertChannel(); channel.spawn(); assert.equal(await channel.link.readyPid(), expected.pid);
  const one = channel.link.challenge(), firstReply = await replyTo(channel); channel.reply(firstReply); await one;
  const two = channel.link.challenge(), secondReply = await replyTo(channel); channel.reply(secondReply); await two;
  assert.notEqual(firstReply.nonce, secondReply.nonce); assert.equal(channel.link.hashes.length, 2);
  channel.exit(); await channel.link.exit(); assert.equal(channel.link.runtimePidUnsetAfterExit, true);
  assert.throws(() => channel.link.killConfirmed(), FixtureError); assert.equal(channel.killed(), 0);
});

test("a spawned child object without confirmed original birth cannot receive a kill request", async () => {
  const channel = inertChannel(); channel.spawn(); await channel.link.readyPid();
  assert.throws(() => channel.link.killConfirmed(), FixtureError); assert.equal(channel.killed(), 0);
  await assert.rejects(channel.link.action("exit"), FixtureError);
  const pending = channel.link.challenge(); channel.reply(await replyTo(channel)); await pending;
  assert.throws(() => channel.link.killConfirmed(), FixtureError); assert.equal(channel.killed(), 0);
});

test("runtime manifests require every fixed bundle and reject traversal in distribution paths", () => {
  const file = { bytes: 1, sha256: "0".repeat(64) };
  const input = { version: 1, image: IMAGE, seccompSha256: SECCOMP_SHA256, runtime: "node", suite: "lifecycle",
    electronSha256: file.sha256, runtimeFiles: { electron: file, "locales/en-US.pak": file },
    build: { version: 1, witnessSha256: EXPECTED_WITNESS_SHA256, sources: { "src/services/process-retirement.ts": file },
      bundles: { "node-parent.mjs": file, "electron-parent.mjs": file, "child-entry.mjs": file, "utility-entry.mjs": file },
      packages: { electron: "44.7.0", node: "24.21.0", zod: "4.6.5", typescript: "7.0.2", esbuild: "0.28.2" } } };
  assert.equal(runtimeInputSchema.safeParse(input).success, true);
  for (const path of ["..", ".", "a/../b", "/etc/passwd", "a\\b"]) {
    assert.equal(runtimeInputSchema.safeParse({ ...input, runtimeFiles: { [path]: file } }).success, false);
  }
  const { "utility-entry.mjs": _removed, ...incomplete } = input.build.bundles;
  assert.equal(runtimeInputSchema.safeParse({ ...input, build: { ...input.build, bundles: incomplete } }).success, false);
});

test("a stale reply on the original channel poisons a pending fresh challenge", async () => {
  const channel = inertChannel(); channel.spawn(); await channel.link.readyPid();
  const one = channel.link.challenge(), oldReply = await replyTo(channel); channel.reply(oldReply); await one;
  const two = channel.link.challenge(); await new Promise<void>((accept) => setImmediate(accept));
  channel.reply(oldReply); await assert.rejects(two, FixtureError); await assert.rejects(channel.link.challenge(), FixtureError);
  assert.throws(() => channel.link.killConfirmed(), FixtureError); assert.equal(channel.killed(), 0);
});

test("unsolicited, wrong-epoch and failed-channel replies cannot authorize work", async () => {
  const unsolicited = inertChannel(); unsolicited.spawn(); await unsolicited.link.readyPid(); unsolicited.reply(identity(first));
  await assert.rejects(unsolicited.link.challenge(), FixtureError);
  const wrong = inertChannel(); wrong.spawn(); await wrong.link.readyPid(); const pending = wrong.link.challenge();
  const reply = await replyTo(wrong); wrong.reply({ ...reply, epoch: randomUUID() }); await assert.rejects(pending, FixtureError);
  const failed = inertChannel(); failed.spawn(); await failed.link.readyPid(); failed.failure(); await assert.rejects(failed.link.challenge(), FixtureError);
});

test("no missing token or malformed launcher arguments can perform fixture execution", async () => {
  await assert.rejects(executeReviewedOwnedRetirement([]), FixtureError);
  await assert.rejects(executeReviewedOwnedRetirement(["--execute-reviewed-owned-retirement"]), FixtureError);
  assert.equal(runtimeInputSchema.safeParse({ version: 1, runtime: "node", suite: "lifecycle", arbitrary: true }).success, false);
});

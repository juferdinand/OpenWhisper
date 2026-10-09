import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { macRetirementBuildLayout, validateMacProductionCompileCommands } from "../../../scripts/build-macos-retirement.js";
import { abiSchema, bounded, buildManifestSchema, buildSourceNames, caseSchema, distributionNames, exportNames, guardSchema,
  inputSchema, nativeGuardCode, payloadNames, sourceNames, validateOriginalChallenge, waitForOriginalProcessAbsence } from "../../owned-macos-production-retirement/contracts.js";
import type { FixtureInput } from "../../owned-macos-production-retirement/contracts.js";
import { captureDescriptor, freezeInput, sha256, verifyInput } from "../../owned-macos-production-retirement/input.js";
import { buildMacProductionRetirementFixture } from "../../owned-macos-production-retirement/build-fixture.js";
import { OriginalClosure, retainOriginalCLI, type FixtureTimers } from "../../owned-macos-production-retirement/lifetime.js";

test("default probe build role preserves its target paths and arguments while production is explicitly selected", () => {
  assert.deepEqual(macRetirementBuildLayout(false), { target: "openwhisper_macos_retirement_probe", directory: "build",
    notices: "macos-retirement-probe-notices", args: ["--parallel", "2"] });
  assert.deepEqual(macRetirementBuildLayout(true), { target: "openwhisper_macos_retirement", directory: "build-production",
    notices: "macos-retirement-notices", args: ["--target", "openwhisper_macos_retirement", "--parallel", "2"] });
  assert.ok(Object.isFrozen(macRetirementBuildLayout(false).args));
});
test("production compile descriptor requires exactly its selected target and role even when the probe is in the CMake graph", () => {
  const command = "/usr/bin/clang++ -DNAPI_VERSION=8 -DOPENWHISPER_RETIREMENT_PRODUCTION=1 -o CMakeFiles/openwhisper_macos_retirement.dir/retirement.cpp.o -c /source/retirement.cpp";
  const own = { directory: "/output", file: "/source/retirement.cpp", command };
  const probe = { ...own, command: command.replaceAll("PRODUCTION", "PROBE").replaceAll("retirement.dir", "retirement_probe.dir") };
  validateMacProductionCompileCommands([probe, own], own.file, own.directory);
  for (const commands of [[probe], [own, own], [{ ...own, command: command.replace(" -DNAPI_VERSION=8", "") }],
    [{ ...own, command: `${command} -DOPENWHISPER_RETIREMENT_PROBE=1` }], [{ ...own, directory: "/other" }]])
    assert.throws(() => validateMacProductionCompileCommands(commands, own.file, own.directory));
});
test("actual categorical native guard refusal is distinct from fuse loader and generic failures", () => {
  assert.equal(nativeGuardCode(Object.assign(new Error("inert"), { code: "TEARDOWN_FAILED" })), "TEARDOWN_FAILED");
  for (const error of [new Error("inert"), Object.assign(new Error("inert"), { code: "ERR_DLOPEN_FAILED" }), null, { code: "TEARDOWN_FAILED" }])
    assert.equal(nativeGuardCode(error), "LOAD_REFUSED");
  assert.throws(() => guardSchema.parse({ context: "worker", result: "LOAD_REFUSED", kernelTargetProvided: false, nodeVersion: "24.21.0", architecture: "arm64" }));
  assert.throws(() => guardSchema.parse({ context: "worker", result: "TEARDOWN_FAILED", kernelTargetProvided: true, nodeVersion: "24.21.0", architecture: "arm64" }));
  assert.throws(() => abiSchema.parse({ version: 1, role: "production", napiVersion: 8, mainOnly: true, zombieLookupArgument: 0, probeOnly: false }));
});
test("early absent-at-bind fixture requires original native reap and cannot substitute channel exit", () => {
  const early = { name: "early", admitted: false, initialLevel: "reaped", firstNonceConfirmed: false, secondNonceConfirmed: false,
    sameBirthRunningConfirmed: false, reservationRefused: true, fullReapConfirmed: true, closeReadReceiptConfirmed: true, helperExitObserved: true, exitCode: 0, elapsedMs: 1 };
  caseSchema.parse(early);
  for (const initialLevel of ["running", "non-running"]) assert.throws(() => caseSchema.parse({ ...early, initialLevel }));
  for (const patch of [{ admitted: true }, { firstNonceConfirmed: true }, { secondNonceConfirmed: true }, { sameBirthRunningConfirmed: true },
    { helperExitObserved: false }, { fullReapConfirmed: false }, { closeReadReceiptConfirmed: false }, { elapsedMs: 20001 }])
    assert.throws(() => caseSchema.parse({ ...early, ...patch }));
});
test("early fixture waits through live PID observations and accepts only original ESRCH", async () => {
  let calls = 0;
  await waitForOriginalProcessAbsence(42, performance.now() + 3000, (pid) => {
    assert.equal(pid, 42); if (++calls === 3) throw Object.assign(new Error("inert absence"), { code: "ESRCH" });
  });
  assert.equal(calls, 3);
  const foreign = Object.assign(new Error("inert inaccessible original"), { code: "EPERM" });
  await assert.rejects(waitForOriginalProcessAbsence(42, performance.now() + 3000, () => { throw foreign; }), (error) => error === foreign);
});
test("early fixture absence cannot exceed the original monotonic deadline or accept a late ESRCH", async () => {
  let calls = 0;
  await assert.rejects(waitForOriginalProcessAbsence(42, performance.now() - 1, () => { calls++; })); assert.equal(calls, 0);
  const until = performance.now() + 30;
  await assert.rejects(waitForOriginalProcessAbsence(42, until, () => {
    calls++;
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (performance.now() < until) Atomics.wait(cell, 0, 0, Math.max(1, until - performance.now()));
    throw Object.assign(new Error("inert late absence"), { code: "ESRCH" });
  }));
  assert.equal(calls, 1);
});
test("the original helper challenge rejects old nonce frames unknown fields and changed PID epoch or nonce", () => {
  const epoch = "7dfc2166-7c3d-4272-8011-0268d6fd86dd", nonce = "fb249cbc-c53c-4108-b844-69d712ca90f5", other = "878b7420-92cb-4b89-8814-a56353ce03cf";
  const expected = { epoch, nonce, pid: 42 }, reply = { version: 1, ...expected };
  validateOriginalChallenge(reply, expected);
  for (const input of [{ kind: "nonce", epoch, nonce }, { ...reply, extra: true }, { ...reply, pid: 43 }, { ...reply, epoch: other },
    { ...reply, nonce: other }, { ...reply, version: 0 }]) assert.throws(() => validateOriginalChallenge(input, expected));
});
test("fixture bounds reject a late microtask result against monotonic expiry even before its timer runs", async () => {
  const until = performance.now() + 100;
  const effect = Promise.resolve().then(() => {
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (performance.now() <= until) Atomics.wait(cell, 0, 0, Math.max(1, until - performance.now()));
    return "inert";
  });
  await assert.rejects(bounded(effect, until));
  assert.equal(await bounded(Promise.resolve("inert"), performance.now() + 3000), "inert");
});
test("repeated original CLI errors retain deadline escalation and an unresolved actual-close obligation", async () => {
  let onError: () => void = () => {}, onClose: (value: number | null) => void = () => {};
  const signals: string[] = [], tasks: { effect: () => void; cancelled: boolean; milliseconds: number }[] = [];
  const timers: FixtureTimers = { schedule(effect, milliseconds) {
    const task = { effect, cancelled: false, milliseconds }; tasks.push(task);
    return { cancel() { task.cancelled = true; } };
  } };
  const closure = retainOriginalCLI({ onError(listener) { onError = listener; }, onClose(listener) { onClose = listener; },
    signal(kind) { signals.push(kind); } }, performance.now() + 3000, timers);
  let originalClosed = false, acceptedSettled = false;
  void closure.completion.then(() => { originalClosed = true; });
  const acceptance = closure.accepted().finally(() => { acceptedSettled = true; }); void acceptance.catch(() => {});
  onError(); onError(); await Promise.resolve(); assert.equal(originalClosed, false); assert.equal(acceptedSettled, false);
  assert.equal(closure.state.errorEvents, 2); assert.equal(tasks[0]?.cancelled, false);
  tasks[0]?.effect(); assert.deepEqual(signals, ["SIGTERM"]); assert.equal(tasks[1]?.milliseconds, 8000);
  onError(); assert.equal(tasks[1]?.cancelled, false); tasks[1]?.effect(); assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  onClose(0); assert.equal(await closure.completion, 0); await assert.rejects(acceptance);
  assert.equal(tasks[0]?.cancelled, true); assert.equal(tasks[1]?.cancelled, true); assert.equal(closure.state.closureObserved, true);
});
test("original Node and Worker error poison never replaces their real closure promise", async () => {
  for (const name of ["node", "worker"]) {
    const closure = new OriginalClosure<number>(performance.now() + 3000), original = closure.completion;
    let settled = false; const accepted = closure.accepted().finally(() => { settled = true; }); void accepted.catch(() => {});
    closure.noteError(); closure.noteError(); await Promise.resolve(); assert.equal(settled, false, name);
    assert.equal(closure.completion, original); assert.equal(closure.closed, false);
    closure.close(0); assert.equal(await original, 0); await assert.rejects(accepted); assert.equal(closure.state.errorEvents, 2);
  }
});
test("late original closure rejects even when no deadline callback ran before its microtask", async () => {
  const until = performance.now() + 100, closure = new OriginalClosure<number>(until);
  const accepted = closure.accepted(); void accepted.catch(() => {});
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (performance.now() <= until) Atomics.wait(cell, 0, 0, Math.max(1, until - performance.now()));
  closure.close(0); assert.equal(await closure.completion, 0); await assert.rejects(accepted);
  assert.equal(closure.state.lateClose, true); assert.equal(closure.state.timedOut, false);
});
test("an on-time closure cannot certify a result whose acceptance resumes after its absolute deadline", async () => {
  const until = performance.now() + 100, closure = new OriginalClosure<number>(until);
  const accepted = closure.accepted(); void accepted.catch(() => {}); closure.close(0);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (performance.now() <= until) Atomics.wait(cell, 0, 0, Math.max(1, until - performance.now()));
  assert.equal(await closure.completion, 0); await assert.rejects(accepted);
  assert.equal(closure.state.lateClose, false); assert.equal(closure.state.timedOut, false);
});
test("stdout overflow remains poisoned after a clean zero exit and repeated terminal checks", async () => {
  const closure = new OriginalClosure<number>(performance.now() + 3000);
  closure.noteOverflow(); closure.close(0); assert.equal(await closure.completion, 0);
  await assert.rejects(closure.accepted()); assert.throws(() => closure.assertAcceptedClosure());
  assert.equal(closure.state.stdoutOverflow, true); assert.equal(closure.state.errorEvents, 0);
});
test("healthy CLI close cancels original supervision while later errors remain sticky", async () => {
  let onError: () => void = () => {}, onClose: (value: number | null) => void = () => {}; let cancelled = 0;
  const closure = retainOriginalCLI({ onError(listener) { onError = listener; }, onClose(listener) { onClose = listener; }, signal() { assert.fail(); } },
    performance.now() + 3000, { schedule() { return { cancel() { cancelled++; } }; } });
  onClose(0); assert.equal(await closure.accepted(), 0); assert.equal(cancelled, 1);
  onError(); await assert.rejects(closure.accepted()); assert.throws(() => closure.assertAcceptedClosure());
});
test("bundle-only entry refuses relative aliased and nonprivate output before bundling", async () => {
  await assert.rejects(buildMacProductionRetirementFixture("relative"));
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-bundle-contract-"))); await chmod(root, 0o700);
  try {
    const directory = join(root, "output"); await mkdir(directory, { mode: 0o755 });
    await assert.rejects(buildMacProductionRetirementFixture(directory)); await chmod(directory, 0o700);
    const alias = join(root, "alias"); await symlink(directory, alias);
    await assert.rejects(buildMacProductionRetirementFixture(alias));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("source-only bundles contain actual compiled adapter imports without starting Electron or loading a native module", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-bundle-positive-"))); await chmod(root, 0o700);
  try {
    const sources = await buildMacProductionRetirementFixture(root); assert.deepEqual(Object.keys(sources), sourceNames);
    for (const name of payloadNames) assert.ok((await readFile(join(root, name))).byteLength > 0);
    const main = await readFile(join(root, "main.mjs"), "utf8");
    assert.match(main, /dist\/services\/platforms\/macos\/macos-retirement-boundary\.js/u);
    assert.match(main, /dist\/workers\/speech-control\.js/u);
    assert.match(main, /void run\(/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function sandbox(effect: (project: string, fixture: string, node: FixtureInput["nodeExecutable"]) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-production-contract-"))); await chmod(root, 0o700);
  try {
    const project = join(root, "electron"), fixture = join(root, "fixture"); await mkdir(project); await mkdir(fixture);
    const put = async (name: string, bytes: string): Promise<void> => { const path = join(project, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o600 }); };
    const sourceHashes: Record<string, string> = {};
    for (const name of buildSourceNames) { await put(name, name); sourceHashes[name] = sha256(Buffer.from(name)); }
    for (const name of sourceNames) await put(name, name);
    for (const name of distributionNames) await put(`dist/${name}`, name);
    for (const name of payloadNames) await writeFile(join(fixture, name), name, { mode: 0o600 });
    await put("dist/native/openwhisper_macos_retirement.node", "inert never loaded");
    const manifest = { version: 1, platform: "darwin", architecture: process.arch === "arm64" ? "arm64" : "x86_64", minimumOS: "14.0", napiVersion: 8,
      role: "production", target: "openwhisper_macos_retirement", probeOnly: false, mainOnly: true, workerSyntheticOnly: false, exports: [...exportNames],
      zombieLookupArgument: 1, sourceHashes, bindingSha256: sha256(Buffer.from("inert never loaded")), sdk: "/inert/sdk", sdkVersion: "15.5", compiler: "inert", macho: "inert", dependencies: "inert", scope: "inert",
      headers: { version: "24.21.0", napiVersion: 8, sha256: "57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2", source: "https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt" },
      license: { version: "24.21.0", source: "https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE", sha256: "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace", scope: "inert" } };
    buildManifestSchema.parse(manifest); await put("dist/native/macos-retirement-notices/build-manifest.json", JSON.stringify(manifest));
    const nodePath = join(root, "node-inert-never-executed"); await writeFile(nodePath, "inert", { mode: 0o700 });
    const node = { path: nodePath, sha256: sha256(Buffer.from("inert")), version: "24.21.0" as const, architecture: process.arch as "arm64" | "x64" };
    await effect(project, fixture, node);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("frozen descriptor and exact payload source distribution hashes verify without executing any binary", async () => {
  await sandbox(async (project, fixture, node) => {
    const descriptor = await captureDescriptor(project), input = await freezeInput(project, fixture, descriptor, node);
    const bytes = Buffer.from(JSON.stringify(input)); await writeFile(join(fixture, "fixture-input.json"), bytes, { mode: 0o600 });
    assert.deepEqual(await verifyInput(project, fixture, sha256(bytes)), input);
    assert.throws(() => inputSchema.parse({ ...input, sourceHashes: {} }));
    assert.throws(() => buildManifestSchema.parse({ probeOnly: true }));
  });
});
for (const member of ["dist/native/openwhisper_macos_retirement.node", "src/services/platforms/macos/macos-retirement-boundary.ts", "dist/services/platforms/macos/macos-retirement-boundary.js", "scripts/build-macos-retirement-production.ts"]) {
  test(`frozen runtime input refuses changed ${member}`, async () => {
    await sandbox(async (project, fixture, node) => {
      const input = await freezeInput(project, fixture, await captureDescriptor(project), node), bytes = Buffer.from(JSON.stringify(input));
      await writeFile(join(fixture, "fixture-input.json"), bytes, { mode: 0o600 }); await writeFile(join(project, member), "changed");
      await assert.rejects(verifyInput(project, fixture, sha256(bytes)));
    });
  });
}
test("frozen runtime input refuses payload changes and does not refresh the expected descriptor", async () => {
  await sandbox(async (project, fixture, node) => {
    const descriptor = await captureDescriptor(project), input = await freezeInput(project, fixture, descriptor, node), bytes = Buffer.from(JSON.stringify(input));
    await writeFile(join(fixture, "fixture-input.json"), bytes, { mode: 0o600 }); await writeFile(join(fixture, "entry.mjs"), "changed");
    await assert.rejects(verifyInput(project, fixture, sha256(bytes)));
    await writeFile(join(project, "dist/native/openwhisper_macos_retirement.node"), "changed");
    await assert.rejects(freezeInput(project, fixture, descriptor, node));
  });
});
test("fixed input checks refuse symlinks writable authority and changed captured Node bytes", async () => {
  await sandbox(async (project, fixture, node) => {
    const descriptor = await captureDescriptor(project);
    const path = join(project, "dist/native/openwhisper_macos_retirement.node"); await chmod(path, 0o622);
    await assert.rejects(captureDescriptor(project)); await chmod(path, 0o600);
    const target = join(fixture, "inert"); await writeFile(target, "inert never loaded", { mode: 0o600 }); await rm(path); await symlink(target, path);
    await assert.rejects(captureDescriptor(project)); assert.ok((await lstat(path)).isSymbolicLink());
    await rm(path); await writeFile(path, "inert never loaded", { mode: 0o600 }); await writeFile(node.path, "changed");
    await assert.rejects(freezeInput(project, fixture, descriptor, node));
  });
});

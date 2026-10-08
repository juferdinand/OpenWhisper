import assert from "node:assert/strict";
import { app, utilityProcess, webContents } from "electron";
import type { UtilityProcess } from "electron";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { captureMacKernelRetirementNative, MacKernelRetirementBoundary } from "../../src/services/macos-retirement-boundary.js";
import { speechChallengeReplySchema, speechChallengeRequestSchema } from "../../src/workers/speech-control.js";
import { abiSchema, bounded, caseSchema, exportNames, guardSchema, nativeGuardCode, resultSchema, validateOriginalChallenge } from "./contracts.js";
import type { FixtureResult, Stage } from "./contracts.js";
import { verifyInput } from "./input.js";
import { OriginalClosure } from "./lifetime.js";

const watchdog = setTimeout(() => { app.exit(1); }, 130_000);
process.on("uncaughtException", () => { process.exit(1); });
process.on("unhandledRejection", () => { process.exit(1); });
const root = process.argv[2], distribution = process.argv[3], expected = process.argv[4];
if (process.platform !== "darwin" || process.type !== "browser" || process.getuid?.() === 0 ||
  process.env["GITHUB_ACTIONS"] !== "true" || process.env["OPENWHISPER_OWNED_MAC_PRODUCTION_RETIREMENT_TEST"] !== "1" ||
  !root || !distribution || !expected || ![root, distribution].every((path) => isAbsolute(path) && !path.includes("\0"))) process.exit(1);
let prepared = false;
try {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() ||
    (directory.mode & 0o7777) !== 0o700 || await realpath(root) !== resolve(root) || await realpath(distribution) !== resolve(distribution) ||
    !distribution.endsWith("/electron/dist")) process.exit(1);
  prepared = true;
  for (const name of ["user-data", "session-data", "cache"]) await mkdir(join(root, name), { mode: 0o700 });
  app.setPath("userData", join(root, "user-data")); app.setPath("sessionData", join(root, "session-data")); app.setPath("cache", join(root, "cache"));
  app.disableHardwareAcceleration();
  await writeFile(join(root, "startup.json"), JSON.stringify({ stage: "profile-prepared" }), { flag: "wx", mode: 0o600 });
} catch {
  if (prepared) { try { await writeFile(join(root, "failure.json"), JSON.stringify({ code: "BOOTSTRAP_FAILED" }), { mode: 0o600 }); } catch {} }
  process.exit(1);
}
interface Child {
  readonly utility: UtilityProcess; readonly epoch: string; readonly exit: Promise<number>; readonly spawned: Promise<number>; readonly ready: Promise<void>;
  pid: number | undefined; exited: boolean; invalid: boolean; readonly nonces: Set<string>;
  pending: { readonly nonce: string; readonly accept: (reply: unknown) => void; readonly reject: () => void } | undefined;
}
function environment(root: string): NodeJS.ProcessEnv {
  return { HOME: join(root, "home"), TMPDIR: root, XDG_CONFIG_HOME: join(root, "user-data"), XDG_DATA_HOME: join(root, "user-data"),
    XDG_CACHE_HOME: join(root, "cache"), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", OPENWHISPER_OWNED_MAC_PRODUCTION_RETIREMENT_TEST: "1" };
}
async function run(root: string, distribution: string, expected: string): Promise<void> {
  const children: Child[] = [], owners: MacKernelRetirementBoundary[] = [];
  const workers: { readonly worker: Worker; readonly closure: OriginalClosure<number> }[] = [];
  const guardChildren: { readonly child: ChildProcess; readonly closure: OriginalClosure<number | null> }[] = [];
  const cases: FixtureResult["cases"] = [], guards: FixtureResult["guards"] = [];
  const checkpoints: { case: string | null; stage: Stage }[] = [];
  let stage: Stage = "ready", caseName: string | null = null;
  const record = async (next: Stage): Promise<void> => {
    stage = next; if (checkpoints.length >= 80) throw new Error("FIXTURE_FAILED"); checkpoints.push({ case: caseName, stage });
    await writeFile(join(root, "checkpoint.json"), JSON.stringify({ current: { case: caseName, stage }, trace: checkpoints }), { mode: 0o600 });
  };
  let allCleanupConfirmed = false;
  try {
    await app.whenReady(); await writeFile(join(root, "startup.json"), JSON.stringify({ stage: "ready" }), { mode: 0o600 });
    await record("verify-input");
    const input = await verifyInput(dirname(distribution), root, expected), binding = join(distribution, "native/openwhisper_macos_retirement.node");
    // Only this owned process loses the historical probe flags. Native loading
    // must rely on its actual browser/main and UID guards instead.
    delete process.env["GITHUB_ACTIONS"]; delete process.env["OPENWHISPER_OWNED_MAC_RETIREMENT_TEST"];
    await record("load");
    const raw: unknown = createRequire(import.meta.url)(binding);
    assert.ok(raw !== null && typeof raw === "object"); assert.deepEqual(Reflect.ownKeys(raw).sort(), exportNames);
    const abiCallable: unknown = Reflect.get(raw, "abi");
    if (typeof abiCallable !== "function") throw new Error("ABI_REFUSED");
    const abi = abiSchema.parse(Reflect.apply(abiCallable, raw, []));
    const native = captureMacKernelRetirementNative(raw);
    const rawCreate: unknown = Reflect.get(raw, "create"); if (typeof rawCreate !== "function") throw new Error("CREATE_REFUSED");
    const refuseCreate = (pid: number, uid: number, parent: number): void => {
      let caught: unknown; try { Reflect.apply(rawCreate, raw, [pid, uid, parent]); } catch (error: unknown) { caught = error; }
      assert.equal(nativeGuardCode(caught), "TEARDOWN_FAILED");
    };
    const uid = process.getuid?.(); assert.ok(uid && uid > 0);
    refuseCreate(process.pid, uid, process.pid); refuseCreate(0, uid, process.pid); refuseCreate(process.pid, 0, process.pid);
    await record("guards");
    const guardUntil = performance.now() + 20_000;
    const workerClosure = new OriginalClosure<number>(guardUntil);
    const worker = new Worker(join(root, "guard.mjs"), { workerData: { binding, sha256: input.bindingSha256 }, env: environment(root) });
    workers.push({ worker, closure: workerClosure });
    let workerFrames = 0, workerReply: unknown;
    worker.on("message", (reply: unknown) => { workerFrames++; workerReply = reply; });
    worker.once("exit", (code) => { workerClosure.close(code); }); worker.on("error", () => { workerClosure.noteError(); });
    assert.equal(await bounded(workerClosure.accepted(), guardUntil), 0); assert.equal(workerFrames, 1); guards.push(guardSchema.parse(workerReply));
    const node = spawn(input.nodeExecutable.path, [join(root, "guard.mjs"), binding, input.bindingSha256], {
      env: environment(root), stdio: ["ignore", "pipe", "ignore"] });
    let output = "", outputBytes = 0;
    const nodeClosure = new OriginalClosure<number | null>(guardUntil); guardChildren.push({ child: node, closure: nodeClosure });
    node.once("close", (code) => { nodeClosure.close(code); }); node.on("error", () => { nodeClosure.noteError(); });
    node.stdout.on("data", (bytes: Buffer) => {
      if (nodeClosure.state.stdoutOverflow) return;
      if (outputBytes + bytes.byteLength > 4096) { nodeClosure.noteOverflow(); try { node.kill("SIGTERM"); } catch { nodeClosure.noteError(); } }
      else { outputBytes += bytes.byteLength; output += bytes.toString("utf8"); }
    });
    assert.equal(await bounded(nodeClosure.accepted(), guardUntil), 0);
    const nodeGuard = guardSchema.parse(JSON.parse(output)); assert.equal(nodeGuard.nodeVersion, input.nodeExecutable.version);
    assert.equal(nodeGuard.architecture, input.nodeExecutable.architecture); guards.push(nodeGuard);

    const spawnOwned = (mode: FixtureResult["cases"][number]["name"]): Child => {
      const epoch = randomUUID();
      const utility = utilityProcess.fork(join(root, "entry.mjs"), [mode, epoch], { serviceName: "OpenWhisper Owned Production Retirement",
        stdio: "ignore", execArgv: [], env: environment(root), allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false });
      let exitAccept: (code: number) => void = () => {}, spawnAccept: (pid: number) => void = () => {}, spawnReject: () => void = () => {};
      let readyAccept: () => void = () => {}, readyReject: () => void = () => {};
      const child: Child = { utility, epoch, pid: undefined, exited: false, invalid: false, nonces: new Set(), pending: undefined,
        exit: new Promise<number>((accept) => { exitAccept = accept; }),
        spawned: new Promise<number>((accept, reject) => { spawnAccept = accept; spawnReject = () => { reject(new Error("SPAWN_FAILED")); }; }),
        ready: new Promise<void>((accept, reject) => { readyAccept = accept; readyReject = () => { reject(new Error("READY_FAILED")); }; }) };
      // Retain the original object and all completion obligations before awaits.
      children.push(child); void child.spawned.catch(() => {}); void child.ready.catch(() => {});
      utility.once("spawn", () => { if (!utility.pid || child.pid) { child.invalid = true; spawnReject(); return; } child.pid = utility.pid; spawnAccept(utility.pid); });
      utility.once("exit", (code) => { child.exited = true; child.pending?.reject(); spawnReject(); readyReject(); exitAccept(code); });
      utility.on("error", () => { child.invalid = true; child.pending?.reject(); spawnReject(); readyReject(); });
      let readySeen = false;
      utility.on("message", (reply: unknown) => {
        if (z.strictObject({ version: z.literal(1), type: z.literal("ready") }).safeParse(reply).success && !readySeen && !child.pending) {
          readySeen = true; readyAccept(); return;
        }
        const parsed = speechChallengeReplySchema.safeParse(reply), pending = child.pending;
        if (!parsed.success || !pending || child.invalid || !child.pid) {
          child.invalid = true; child.pending?.reject(); return;
        }
        try { validateOriginalChallenge(parsed.data, { epoch, nonce: pending.nonce, pid: child.pid }); }
        catch { child.invalid = true; pending.reject(); return; }
        child.pending = undefined; pending.accept(parsed.data);
      });
      return child;
    };
    const challenge = async (child: Child, until: number): Promise<void> => {
      if (child.exited || child.invalid || child.pending || !child.pid) throw new Error("CHALLENGE_FAILED");
      const nonce = randomUUID(); if (child.nonces.has(nonce)) throw new Error("CHALLENGE_FAILED"); child.nonces.add(nonce);
      const reply = new Promise<unknown>((accept, reject) => { child.pending = { nonce, accept, reject: () => { reject(new Error("CHALLENGE_FAILED")); } }; });
      void reply.catch(() => {}); child.utility.postMessage(speechChallengeRequestSchema.parse({ version: 1, type: "challenge", epoch: child.epoch, nonce }));
      await bounded(reply, until); if (child.invalid || child.exited) throw new Error("CHALLENGE_FAILED");
    };
    for (const name of ["clean", "nonzero", "kill", "early", "fresh"] as const) {
      caseName = name; const start = performance.now(), until = start + 20_000, signal = new AbortController().signal;
      await record("spawn"); const child = spawnOwned(name);
      const pid = await bounded(child.spawned, until); await bounded(child.ready, until);
      refuseCreate(pid, uid, 0); refuseCreate(pid, 0, process.pid); refuseCreate(pid, uid + 1, process.pid);
      let firstNonceConfirmed = false, secondNonceConfirmed = false, sameBirthRunningConfirmed = false;
      if (name === "early") await bounded(child.exit, until);
      else { await record("first-challenge"); await challenge(child, until); firstNonceConfirmed = true; }
      await record("bind");
      const owner = new MacKernelRetirementBoundary(native, { pid, uid, parentPid: process.pid, epoch: child.epoch }); owners.push(owner);
      await bounded(owner.bind(signal), until); const initial = owner.initial;
      if (name !== "early") {
        assert.equal(initial.canAdmit, true); assert.ok(initial.identity);
        assert.equal(initial.identity.uid, uid); assert.equal(initial.identity.parentPid, process.pid); assert.equal(initial.identity.pid, pid);
        await record("second-challenge"); await challenge(child, until); secondNonceConfirmed = true;
        await record("observe"); const current = await bounded(owner.observe(signal), until);
        assert.equal(current.level, "running"); assert.deepEqual(current.identity, initial.identity);
        assert.equal(child.invalid, false); assert.equal(child.exited, false); sameBirthRunningConfirmed = true;
      } else { assert.equal(initial.canAdmit, false); assert.notEqual(initial.level, "running"); }
      await record("reservation"); refuseCreate(pid, uid, process.pid);
      await record("request-exit");
      if (!child.exited) { if (name === "kill") child.utility.kill(); else child.utility.postMessage({ version: 1, type: "fixture-exit" }); }
      await record("wait-reap"); await bounded(owner.waitForRetirement(signal), until); assert.equal(owner.current.level, "reaped");
      await record("close-read"); await bounded(owner.settleReads(), until); assert.equal(owner.current.level, "reaped");
      await record("helper-exit"); const exitCode = await bounded(child.exit, until); assert.equal(child.invalid, false);
      if (name === "nonzero") assert.equal(exitCode, 17); else if (name !== "kill") assert.equal(exitCode, 0);
      cases.push(caseSchema.parse({ name, admitted: initial.canAdmit, initialLevel: initial.level, firstNonceConfirmed, secondNonceConfirmed,
        sameBirthRunningConfirmed, reservationRefused: true, fullReapConfirmed: true, closeReadReceiptConfirmed: true, helperExitObserved: true,
        exitCode, elapsedMs: performance.now() - start }));
      await writeFile(join(root, "cases.json"), JSON.stringify(cases), { mode: 0o600 });
    }
    await record("complete"); assert.equal(webContents.getAllWebContents().length, 0);
    for (const guard of [...workers, ...guardChildren]) guard.closure.assertAcceptedClosure();
    const result = resultSchema.parse({ fixture: "macos-production-retirement", architecture: process.arch, abi, guards, cases,
      runtime: { node: process.versions.node, electron: process.versions.electron, systemVersion: process.getSystemVersion(), kernelRelease: release() },
      inputSha256: expected, bindingSha256: input.bindingSha256, rendererCreated: false, audioOperations: 0, permissionOperations: 0,
      productionFactoryWired: false, signedHelperLoadingVerified: false, deterministicZombieVerified: false });
    await writeFile(join(root, "result.json"), JSON.stringify(result), { mode: 0o600 });
    allCleanupConfirmed = true;
  } catch {
    await writeFile(join(root, "failure.json"), JSON.stringify({ code: "PRODUCTION_RETIREMENT_FIXTURE_FAILED", case: caseName, stage }), { mode: 0o600 });
    throw new Error("FIXTURE_FAILED");
  } finally {
    const until = performance.now() + 8000;
    let helperExits = true, closeReads = owners.length === children.length, workerExits = true, fullReap = owners.length === children.length;
    let nodeClosed = true;
    for (const guard of guardChildren) {
      if (!guard.closure.closed) { try { guard.child.kill("SIGTERM"); } catch { guard.closure.noteError(); } }
      try { await bounded(guard.closure.completion, until); } catch { nodeClosed = false; }
    }
    for (const child of children) {
      try { if (!child.exited) child.utility.kill(); await bounded(child.exit, until); } catch { helperExits = false; }
    }
    for (const owner of owners) {
      try { if (owner.current.level !== "reaped") await bounded(owner.waitForRetirement(new AbortController().signal), until); }
      catch { fullReap = false; }
      try { await bounded(owner.settleReads(), until); } catch { closeReads = false; }
    }
    for (const guard of workers) {
      if (!guard.closure.closed) { try { await bounded(guard.worker.terminate(), until); } catch { guard.closure.noteError(); } }
      try { await bounded(guard.closure.completion, until); } catch { workerExits = false; }
    }
    await writeFile(join(root, "guard-lifecycle.json"), JSON.stringify({ nodes: guardChildren.map((guard) => guard.closure.state),
      workers: workers.map((guard) => guard.closure.state), physicalEventsOnly: true, genericCloseIsKernelRetirementProof: false }), { mode: 0o600 });
    await writeFile(join(root, "lifecycle.json"), JSON.stringify({ helperExitObserved: helperExits, originalFullReapConfirmed: fullReap,
      closeReadReceiptsConfirmed: closeReads, guardWorkerExitObserved: workerExits, allCasesCompleted: allCleanupConfirmed,
      guardNodeCloseObserved: nodeClosed, nativeOwnersCreated: owners.length, utilityChildrenCreated: children.length,
      genericMainExitIsRetirementProof: false, productionFactoryWired: false }), { mode: 0o600 });
    if (!helperExits || !closeReads || !workerExits || !fullReap || !nodeClosed) throw new Error("CLEANUP_FAILED");
    // Closure and categorical acceptance are separate: cleanup must preserve
    // the real event even after an error, and late errors still reject success.
    for (const guard of guardChildren) guard.closure.assertAcceptedClosure();
    for (const guard of workers) guard.closure.assertAcceptedClosure();
  }
}
void run(root, distribution, expected).then(() => { clearTimeout(watchdog); app.exit(0); }, () => { clearTimeout(watchdog); app.exit(1); });

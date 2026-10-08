import assert from "node:assert/strict";
import { app, utilityProcess, webContents } from "electron";
import type { UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { loadOwnedMacRetirementProbe, OwnedMacRetirementProbe } from "../../src/services/macos-process-retirement.js";
import type { MacProbeNative, MacTrustedUtility } from "../../src/services/macos-process-retirement.js";
import { modeSchema, nonceReplySchema, probeStateSchema, readySchema, resultSchema, sdkSchema } from "./contracts.js";
import type { ProbeResult } from "./contracts.js";

// Install categorical failure handling before the first awaited filesystem
// operation. An owned fixture must never show Electron's uncaught-error dialog.
const watchdog = setTimeout(() => { app.exit(1); }, 130_000);
process.on("uncaughtException", () => { process.exit(1); });
process.on("unhandledRejection", () => { process.exit(1); });
const root = process.argv[2], distribution = process.argv[3];
if (process.platform !== "darwin" || process.getuid?.() === 0 || process.env["GITHUB_ACTIONS"] !== "true" ||
  process.env["OPENWHISPER_OWNED_MAC_RETIREMENT_TEST"] !== "1" || !root || !distribution ||
  ![root, distribution].every((path) => isAbsolute(path) && !path.includes("\0"))) process.exit(1);
let validatedRoot = false;
try {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o7777) !== 0o700 ||
    await realpath(root) !== resolve(root) || await realpath(distribution) !== resolve(distribution) || !distribution.endsWith("/electron/dist")) process.exit(1);
  validatedRoot = true;
  for (const name of ["user-data", "session-data", "cache"]) await mkdir(join(root, name), { mode: 0o700 });
  app.setPath("userData", join(root, "user-data")); app.setPath("sessionData", join(root, "session-data")); app.setPath("cache", join(root, "cache"));
  app.disableHardwareAcceleration();
  await writeFile(join(root, "startup.json"), JSON.stringify({ stage: "profile-prepared" }), { flag: "wx", mode: 0o600 });
} catch {
  if (validatedRoot) {
    try { await writeFile(join(root, "failure.json"), JSON.stringify({ code: "MAC_RETIREMENT_BOOTSTRAP_FAILED" }), { mode: 0o600 }); }
    catch { /* The outer owned launcher retains its categorical failure. */ }
  }
  process.exit(1);
}

async function bounded<T>(effect: Promise<T>, milliseconds = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([effect, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("PROBE_FAILED")); }, milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 8000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("PROBE_FAILED");
    await new Promise<void>((accept) => { setTimeout(accept, 5); });
  }
}
interface Child {
  readonly utility: UtilityProcess;
  readonly pid: number;
  readonly exit: Promise<number>;
  readonly trusted: MacTrustedUtility;
  readonly state: { exited: boolean; challenged: boolean; ready: boolean };
}
async function run(root: string, distribution: string): Promise<void> {
  await app.whenReady();
  await writeFile(join(root, "startup.json"), JSON.stringify({ stage: "ready" }), { mode: 0o600 });
  const children: Child[] = [], owners: OwnedMacRetirementProbe[] = [];
  let native: MacProbeNative | undefined, worker: Worker | undefined;
  const cases: ProbeResult["cases"] = [], phases: string[] = [];
  type CaseName = ProbeResult["cases"][number]["name"] | "synthetic-environment-cleanup";
  type Stage = "spawn" | "bind" | "retire" | "kill" | "kill-returned" | "post-kill-observe" | "wait-reap" | "exit" | "close" |
    "worker-sdk-before" | "worker-load" | "worker-barrier" | "worker-terminate" | "worker-after-terminate" | "worker-sdk-read" |
    "worker-assert-cleanup" | "worker-assert-suppressed" | "worker-assert-disposal" | "worker-assert-reservation";
  let checkpoint: Readonly<{ case: CaseName; stage: Stage; configuredHandler: "default" | "delayed" | "ignore";
    killReturnedMilliseconds: number | null; helperExitObserved: boolean | null; observedLevel: "running" | "non-running" | "reaped" | null }> | undefined;
  const checkpoints: NonNullable<typeof checkpoint>[] = [];
  type WorkerFailure = "WORKER_LOAD_FAILED" | "WORKER_ERROR" | "WORKER_EXIT_BEFORE_BARRIER" | "WORKER_REPLY_INVALID" |
    "WORKER_TERMINATE_FAILED" | "WORKER_SDK_FAILED" | "WORKER_ASSERTION_FAILED";
  let workerFailure: WorkerFailure | undefined, workerBefore: z.infer<typeof sdkSchema> | undefined, workerAfter: z.infer<typeof sdkSchema> | undefined;
  let workerBarrierState: z.infer<typeof probeStateSchema> | undefined;
  let workerBarrierObserved = false, workerExitObserved = false, workerTerminationRequested = false;
  let workerTerminateMilliseconds: number | undefined;
  const workerDiagnostic = async (): Promise<void> => {
    if (checkpoint?.case !== "synthetic-environment-cleanup") return;
    await writeFile(join(root, "worker-state.json"), JSON.stringify({ stage: checkpoint.stage, code: workerFailure ?? null,
      before: workerBefore ?? null, after: workerAfter ?? null, barrierObserved: workerBarrierObserved, exitObserved: workerExitObserved,
      terminationRequested: workerTerminationRequested, terminateMilliseconds: workerTerminateMilliseconds ?? null,
      syntheticOnly: true, barrierState: workerBarrierState ?? null }), { mode: 0o600 });
  };
  const record = async (caseName: CaseName, stage: Stage, handler: "default" | "delayed" | "ignore" = "default",
    values: Readonly<{ killReturnedMilliseconds?: number; helperExitObserved?: boolean; observedLevel?: "running" | "non-running" | "reaped" }> = {}): Promise<void> => {
    checkpoint = Object.freeze({ case: caseName, stage, configuredHandler: handler,
      killReturnedMilliseconds: values.killReturnedMilliseconds ?? null, helperExitObserved: values.helperExitObserved ?? null,
      observedLevel: values.observedLevel ?? null });
    if (checkpoints.length >= 80) throw new Error("PROBE_FAILED");
    checkpoints.push(checkpoint);
    await writeFile(join(root, "checkpoint.json"), JSON.stringify({ current: checkpoint, trace: checkpoints }), { mode: 0o600 });
  };
  try {
    native = await loadOwnedMacRetirementProbe(distribution);
    assert.equal(sdkSchema.parse(native.sdk()).reserved, 0);
    const edge = native;
    const spawn = async (mode: z.infer<typeof modeSchema>): Promise<Child> => {
      const utility = utilityProcess.fork(join(root, "entry.mjs"), [mode], { serviceName: "OpenWhisper Owned Retirement Test", stdio: "ignore" });
      const state = { exited: false, challenged: false, ready: false };
      let acceptNonce: ((message: unknown) => void) | undefined;
      let rejectNonce: (() => void) | undefined;
      const exit = new Promise<number>((accept) => { utility.once("exit", (code) => { state.exited = true; rejectNonce?.(); accept(code); }); });
      utility.on("message", (message: unknown) => {
        if (readySchema.safeParse(message).success) { state.ready = true; return; }
        if (nonceReplySchema.safeParse(message).success && acceptNonce) { acceptNonce(message); return; }
        rejectNonce?.();
      });
      const processId = await bounded(new Promise<number>((accept, reject) => {
        utility.once("spawn", () => { if (utility.pid) accept(utility.pid); else reject(new Error("PROBE_FAILED")); });
        utility.once("exit", () => { reject(new Error("PROBE_FAILED")); });
      }));
      const trusted: MacTrustedUtility = { pid: processId, challenge: async (nonce, epoch, signal) => {
        if (state.exited || signal.aborted || acceptNonce) throw new Error("PROBE_FAILED");
        let abort: (() => void) | undefined;
        try {
          return await new Promise<unknown>((accept, reject) => {
            abort = () => { reject(new Error("PROBE_FAILED")); }; rejectNonce = abort;
            acceptNonce = (message) => { const parsed = nonceReplySchema.parse(message);
              if (parsed.nonce !== nonce || parsed.epoch !== epoch) { abort?.(); return; }
              state.challenged = true; accept(parsed); };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted || state.exited) { abort(); return; }
            utility.postMessage({ kind: "challenge", nonce, epoch });
          });
        } finally { if (abort) signal.removeEventListener("abort", abort); acceptNonce = undefined; rejectNonce = undefined; }
      } };
      const child = { utility, pid: processId, exit, trusted, state }; children.push(child);
      await until(() => state.ready); return child;
    };
    const acquire = (child: Child): OwnedMacRetirementProbe => {
      const value = new OwnedMacRetirementProbe(edge, child.trusted, randomUUID(), { uid: process.getuid?.() ?? 0, parentPid: process.pid });
      owners.push(value); return value;
    };
    const settings = [
      { name: "clean-exit", mode: "clean", action: "retire" }, { name: "nonzero-exit", mode: "nonzero", action: "retire" },
      { name: "utility-kill", mode: "clean", action: "kill" }, { name: "delayed-sigterm", mode: "delayed", action: "kill" },
      { name: "ignored-sigterm", mode: "ignore", action: "ignore" },
    ] as const;
    for (const setting of settings) {
      const handler = setting.mode === "delayed" || setting.mode === "ignore" ? setting.mode : "default";
      await record(setting.name, "spawn", handler);
      const child = await spawn(setting.mode), probe = acquire(child);
      await record(setting.name, "bind", handler);
      const first = await probe.bind(); assert.equal(first.canAdmit, true); assert.ok(first.identity);
      assert.equal(first.identity.parentPid, process.pid); assert.equal(first.identity.uid, process.getuid?.());
      const started = performance.now();
      if (setting.action === "retire") {
        await record(setting.name, "retire", handler); child.utility.postMessage({ kind: "retire" });
      } else {
        await record(setting.name, "kill", handler);
        if (setting.action === "ignore") child.utility.postMessage({ kind: "retire" });
        const killStarted = performance.now(), accepted = child.utility.kill();
        const returned = { killReturnedMilliseconds: performance.now() - killStarted, helperExitObserved: child.state.exited };
        await record(setting.name, "kill-returned", handler, returned); assert.equal(accepted, true);
        // Apple's pinned Chromium implementation may synchronously wait/reap
        // inside kill(). A configured handler does not prove post-return life.
        await record(setting.name, "post-kill-observe", handler, returned);
        const observed = await probe.observe();
        await record(setting.name, "wait-reap", handler, { ...returned, observedLevel: observed.level });
      }
      if (setting.action === "retire") await record(setting.name, "wait-reap", handler);
      await probe.waitForFullReap(); await record(setting.name, "exit", handler);
      const code = await bounded(child.exit);
      if (setting.mode === "nonzero") assert.equal(code, 17);
      await record(setting.name, "close", handler, { helperExitObserved: child.state.exited });
      await probe.close(); const state = probeStateSchema.parse(probe.probeState(edge));
      assert.equal(state.closed, true); assert.equal(state.descriptorOpen, false); assert.equal(state.reserved, 0); assert.equal(state.disposals, 1);
      cases.push({ name: setting.name, admitted: true, originalNonceConfirmed: child.state.challenged, sameUid: true, directParent: true,
        helperExitObserved: true, noteExitObserved: state.exitSeen, zombieObserved: state.zombieSeen, fullReapConfirmed: true,
        nativeQueries: state.kernelQueries, watchAllocations: state.watchAllocations, observerDisposals: 1, reservedAfterDisposal: 0,
        deadlineRetainedOwner: false, refusedSecondOwner: false, retirementMilliseconds: performance.now() - started });
      phases.push(setting.name); await writeFile(join(root, "phases.json"), JSON.stringify(phases), { mode: 0o600 });
    }
    {
      await record("early-exit", "spawn");
      const child = await spawn("early"); await bounded(child.exit);
      await record("early-exit", "bind", "default", { helperExitObserved: child.state.exited });
      const probe = acquire(child), started = performance.now(), first = await probe.bind();
      assert.equal(first.canAdmit, false); assert.equal(first.level, "reaped"); assert.equal(child.state.challenged, false);
      await probe.close(); const state = probeStateSchema.parse(probe.probeState(edge));
      cases.push({ name: "early-exit", admitted: false, originalNonceConfirmed: false, sameUid: null, directParent: null,
        helperExitObserved: true, noteExitObserved: state.exitSeen, zombieObserved: state.zombieSeen, fullReapConfirmed: true,
        nativeQueries: state.kernelQueries, watchAllocations: state.watchAllocations, observerDisposals: 1, reservedAfterDisposal: 0,
        deadlineRetainedOwner: false, refusedSecondOwner: false, retirementMilliseconds: performance.now() - started });
      phases.push("early-exit"); await writeFile(join(root, "phases.json"), JSON.stringify(phases), { mode: 0o600 });
    }
    {
      await record("held-observation", "spawn");
      const child = await spawn("clean"), probe = acquire(child); assert.equal((await probe.bind()).canAdmit, true);
      probe.holdNext(edge); const controller = new AbortController(), observation = probe.observe(controller.signal);
      await until(() => probeStateSchema.parse(probe.probeState(edge)).barrierEntered);
      controller.abort(); await assert.rejects(observation);
      const closeAbort = new AbortController(); closeAbort.abort(); await assert.rejects(probe.close(closeAbort.signal));
      const held = probeStateSchema.parse(probe.probeState(edge));
      assert.equal(held.busy, true); assert.equal(held.descriptorOpen, true); assert.equal(held.disposals, 0); assert.equal(held.reserved, 1);
      assert.throws(() => edge.create(child.pid, process.getuid?.() ?? 0, process.pid));
      probe.releaseBarrier(edge); await probe.close();
      const state = probeStateSchema.parse(probe.probeState(edge)); assert.equal(state.reserved, 0); assert.equal(state.disposals, 1);
      // Re-observe the SAME original utility only after exact observer disposal;
      // no replacement child or production admission decision is made here.
      const final = acquire(child); assert.equal((await final.bind()).canAdmit, true);
      const started = performance.now(); child.utility.postMessage({ kind: "retire" });
      await final.waitForFullReap(); await bounded(child.exit); await final.close();
      const finished = probeStateSchema.parse(final.probeState(edge));
      cases.push({ name: "held-observation", admitted: true, originalNonceConfirmed: true, sameUid: true, directParent: true,
        helperExitObserved: true, noteExitObserved: finished.exitSeen, zombieObserved: finished.zombieSeen, fullReapConfirmed: true,
        nativeQueries: finished.kernelQueries, watchAllocations: finished.watchAllocations, observerDisposals: 1, reservedAfterDisposal: 0,
        deadlineRetainedOwner: true, refusedSecondOwner: true, retirementMilliseconds: performance.now() - started });
      phases.push("held-observation"); await writeFile(join(root, "phases.json"), JSON.stringify(phases), { mode: 0o600 });
    }
    workerFailure = "WORKER_SDK_FAILED";
    await record("synthetic-environment-cleanup", "worker-sdk-before");
    const before = sdkSchema.parse(edge.sdk());
    workerBefore = before; await workerDiagnostic();
    workerFailure = "WORKER_LOAD_FAILED";
    await record("synthetic-environment-cleanup", "worker-load");
    worker = new Worker(join(root, "worker.mjs"), { workerData: { binding: join(distribution, "native/openwhisper_macos_retirement_probe.node") } });
    const barrier = await bounded(new Promise<unknown>((accept, reject) => {
      worker?.once("message", accept);
      worker?.once("error", () => { workerFailure = "WORKER_ERROR"; reject(new Error("PROBE_FAILED")); });
      worker?.once("exit", () => {
        workerExitObserved = true;
        if (!workerTerminationRequested) workerFailure = "WORKER_EXIT_BEFORE_BARRIER";
        reject(new Error("PROBE_FAILED"));
      });
    }));
    workerFailure = "WORKER_REPLY_INVALID";
    workerBarrierState = z.strictObject({ kind: z.literal("barrier-entered"), state: probeStateSchema }).parse(barrier).state;
    workerBarrierObserved = true;
    await record("synthetic-environment-cleanup", "worker-barrier"); await workerDiagnostic();
    workerFailure = "WORKER_TERMINATE_FAILED";
    await record("synthetic-environment-cleanup", "worker-terminate"); workerTerminationRequested = true;
    const started = performance.now(); await bounded(worker.terminate()); const milliseconds = performance.now() - started;
    workerTerminateMilliseconds = milliseconds;
    await record("synthetic-environment-cleanup", "worker-after-terminate"); await workerDiagnostic();
    workerFailure = "WORKER_SDK_FAILED";
    await record("synthetic-environment-cleanup", "worker-sdk-read");
    const after = sdkSchema.parse(edge.sdk());
    workerAfter = after; await workerDiagnostic();
    workerFailure = "WORKER_ASSERTION_FAILED";
    await record("synthetic-environment-cleanup", "worker-assert-cleanup");
    assert.equal(after.environmentCleanups, before.environmentCleanups + 1);
    await record("synthetic-environment-cleanup", "worker-assert-suppressed");
    assert.equal(after.suppressedCompletions, before.suppressedCompletions + 1);
    await record("synthetic-environment-cleanup", "worker-assert-disposal");
    assert.equal(after.totalDisposals, before.totalDisposals + 1);
    await record("synthetic-environment-cleanup", "worker-assert-reservation");
    assert.equal(after.reserved, 0);
    workerFailure = undefined; await workerDiagnostic();
    const result = resultSchema.parse({ fixture: "macos-retirement-probe", architecture: process.arch, sdk: after, cases,
      runtime: { node: process.versions.node, electron: process.versions.electron },
      workerCleanup: { syntheticOnly: true, kernelQueries: 0, watchAllocations: 0, barrierEntered: true, workerExitObserved: true,
        environmentCleanupObserved: true, javascriptSettlementSuppressed: true, disposalConfirmed: true, reservedAfterDisposal: 0,
        terminateMilliseconds: milliseconds, actualKernelCancellationBound: false },
      rendererCreated: webContents.getAllWebContents().length !== 0, microphoneOperations: 0, permissionOperations: 0,
      productionFactoriesChanged: false, productionArchitectureSelected: false, deterministicZombieExercised: false });
    phases.push("synthetic-environment-cleanup");
    await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  } catch {
    process.exitCode = 1;
    await writeFile(join(root, "failure.json"), JSON.stringify({ code: "MAC_RETIREMENT_PROBE_FAILED", phases,
      ...(checkpoint ? { checkpoint } : {}) }), { mode: 0o600 });
  } finally {
    if (worker) { try { await bounded(worker.terminate()); } catch { process.exitCode = 1; } }
    if (native) for (const owner of owners) {
      try { owner.releaseBarrier(native); await owner.close(); } catch { process.exitCode = 1; }
    }
    for (const child of children) if (!child.state.exited) child.utility.kill();
    try { await bounded(Promise.all(children.map((child) => child.exit))); } catch { process.exitCode = 1; }
    await writeFile(join(root, "phases.json"), JSON.stringify(phases), { mode: 0o600 });
    await writeFile(join(root, "lifecycle.json"), JSON.stringify({ helperExitObserved: children.every((child) => child.state.exited),
      reservedNativeOwners: native ? sdkSchema.parse(native.sdk()).reserved : null, rendererCreated: webContents.getAllWebContents().length !== 0,
      productionFactoriesChanged: false, syntheticWorkerKernelQueries: 0 }), { mode: 0o600 });
    await workerDiagnostic();
    clearTimeout(watchdog); app.exit(process.exitCode === 1 ? 1 : 0);
  }
}
void run(root, distribution).catch(async () => {
  try { await writeFile(join(root, "failure.json"), JSON.stringify({ code: "MAC_RETIREMENT_PROBE_FAILED" }), { mode: 0o600 }); }
  finally { clearTimeout(watchdog); app.exit(1); }
});

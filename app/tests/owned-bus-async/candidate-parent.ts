/** Dedicated owned-fixture Electron main. It never imports the application host. */
import { app, BrowserWindow, utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { addressSchema, EXECUTION_MS, oldChecks, PARENT_CLEANUP_MS as PARENT_PROVIDER_CLEANUP_MS, UTILITY_CLEANUP_MS } from "../owned-bus-opening/launch-contracts.js";
import { awaitNonRunning, bindBirth, observeBirth, type Birth, type Observation } from "../owned-bus-opening/process-witness.js";
import { Diagnosis, DiagnosticRefusal, type Category } from "../owned-bus-opening/diagnostics.js";
import { OwnedDaemon } from "../owned-bus-opening/daemon-owner.js";

import { asyncUtilityResultSchema, candidateProfileSchema as profileSchema, type CandidateProfile as Profile } from "./candidate-contracts.js";

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--profile" || process.env.OPENWHISPER_OWNED_BUS_OPENING_TEST !== "1" ||
    process.getuid?.() !== 1000 || !process.env.HOME?.startsWith("/tmp/openwhisper-owned-opening-driver-")) {
  throw new Error("Explicit copied owned-fixture parent required.");
}
const profile = profileSchema.parse(argv[1]);
await access("/.dockerenv");
app.setPath("userData", join(process.env.HOME, "dev-profile"));
const start = performance.now(), deadline = start + EXECUTION_MS;
const output = `/evidence/${profile}`;
const diagnosis = new Diagnosis((value) => { writeFileSync(`${output}-diagnosis.json`, JSON.stringify(value), { mode: 0o600 }); });
let daemon: ChildProcess | undefined;
let daemonOwner: OwnedDaemon | undefined;
let serviceOwner: OwnedDaemon | undefined;
let window: BrowserWindow | undefined;
let success = false;
let cleanupConfirmed = false;
let scopeResult: unknown;
let executionFinishedMs: number | undefined;
async function until<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DiagnosticRefusal("TIMEOUT")), Math.max(0, milliseconds)); });
  try { return await Promise.race([promise, expiry]); } finally { if (timer) clearTimeout(timer); }
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error: unknown) { if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return false; throw error; }
}
async function privateBus(): Promise<string> {
  const config = "<busconfig><type>session</type><listen>unix:path=/tmp/openwhisper-owned-bus</listen><auth>EXTERNAL</auth><policy context='default'><allow user='*'/><allow own='*'/><allow send_destination='*'/><allow receive_sender='*'/></policy><limit name='max_connections_per_user'>32</limit><limit name='max_message_size'>131072</limit></busconfig>";
  await writeFile("/evidence/opening-bus.conf", config, { mode: 0o600 });
  daemon = spawn("/usr/bin/dbus-daemon", ["--config-file=/evidence/opening-bus.conf", "--nofork", "--print-address=1"], {
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "ignore"],
  });
  const original = daemon;
  daemonOwner = new OwnedDaemon({ pid: original.pid,
    onExit: (callback) => { original.once("exit", callback); }, onClose: (callback) => { original.once("close", callback); },
    onError: (callback) => { original.once("error", callback); }, signalTerminate: () => original.kill("SIGTERM"),
  }, (value) => { writeFileSync(`${output}-daemon-ownership.json`, JSON.stringify(value), { mode: 0o600 }); });
  let text = "";
  const address = await until(new Promise<string>((accept, reject) => {
    daemon?.once("error", reject); daemon?.once("exit", () => reject(new Error("Owned bus exited before readiness.")));
    daemon?.stdout?.on("data", (bytes: Buffer) => {
      if (text.length + bytes.length > 2048) { reject(new Error("Owned bus readiness exceeds its bound.")); return; }
      text += bytes.toString();
      if (text.includes("\n")) { const parsed = addressSchema.safeParse(text.trim()); parsed.success ? accept(parsed.data) : reject(new Error("Invalid owned bus address.")); }
    });
  }), Math.min(5000, deadline - performance.now()));
  await daemonOwner.admitAfterReadiness(process.pid, deadline - performance.now());
  return address;
}
interface OwnerReport { readonly birth: Birth; readonly genericExit: boolean; readonly observation: Observation; readonly killRequested: boolean }
async function utility(mode: Profile, address?: string): Promise<Readonly<{ output: unknown; ownership: OwnerReport }>> {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENWHISPER_OWNED_BUS_TEST: "1", OPENWHISPER_OWNED_BUS_OPENING_TEST: "1", UV_THREADPOOL_SIZE: "1" };
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) delete env[name];
  const helper = utilityProcess.fork(mode === "legacy" ? "/owned-app/tests/owned-bus/entry.mjs" : mode === "async" ? "/owned-app/tests/owned-bus-async/candidate-entry.mjs" : "/owned-app/tests/owned-bus-opening/entry.mjs", [], {
    env, execArgv: [], stdio: "ignore", allowLoadingUnsignedLibraries: false,
    respondToAuthRequestsFromMainProcess: false, serviceName: "OpenWhisper Dev owned opening fixture",
  });
  diagnosis.mark("UTILITY_FORKED");
  let birth: Birth | undefined, genericExit = false, killRequested = false, ready = false;
  helper.on("exit", (code: number) => { genericExit = true; diagnosis.exit(code); });
  const id = randomUUID();
  let result: unknown;
  let operationFailure: unknown;
  let operationCategory: Category = "INVALID_RESULT";
  let observation: Observation | undefined;
  try {
    result = await until(new Promise<unknown>((accept, reject) => {
      helper.on("message", (frame: unknown) => { void (async () => {
        const encoded = JSON.stringify(frame);
        if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 131072) throw new Error("Invalid owned utility frame.");
        if (z.strictObject({ version: z.literal(1), ready: z.literal(true) }).safeParse(frame).success) {
          if (ready || birth) throw new DiagnosticRefusal("DUPLICATE_REQUEST");
          ready = true;
          diagnosis.mark("READY_FRAME_VALIDATED"); operationCategory = "PROCESS_OBSERVATION";
          const pid = helper.pid; if (!pid) throw new Error("Missing owned utility PID.");
          birth = await bindBirth(pid, process.pid);
          diagnosis.mark("BIRTH_ADMITTED"); operationCategory = "INVALID_REQUEST";
          helper.postMessage(mode === "legacy" ? { version: 1, id, command: "run" } :
            { version: 1, id, command: mode === "cleanup" ? "cleanup" : "run", address: addressSchema.parse(address) });
          diagnosis.mark("REQUEST_POSTED"); operationCategory = "INVALID_RESULT";
          if (mode === "cleanup") {
            while (!await exists("/evidence/cleanup-prepared.json")) { if (performance.now() >= deadline) throw new Error("Missing cleanup preparation marker."); await pause(10); }
            const prepared = z.strictObject({ pid: z.literal(pid), uid: z.literal(1000), pendingCertificate: z.literal(true) })
              .parse(JSON.parse(await readFile("/evidence/cleanup-prepared.json", "utf8")));
            observation = await awaitNonRunning(birth, Math.max(0, deadline - performance.now()));
            assert.equal(await exists("/evidence/cleanup-ack.json"), false);
            accept({ prepared, checks: ["prepared environment cleanup has no successful acknowledgment after same-birth non-running proof"] });
          }
          return;
        }
        diagnosis.mark("RESULT_FRAME_RECEIVED");
        if (!birth || mode === "cleanup") throw new DiagnosticRefusal("INVALID_RESULT");
        const failed = z.strictObject({ version: z.literal(1), id: z.union([z.literal(id), z.null()]), command: z.literal("run"),
          error: z.enum(["INVALID_REQUEST", "DUPLICATE_REQUEST", "NATIVE_LOAD", "SCENARIO"]) }).safeParse(frame);
        if (failed.success) throw new DiagnosticRefusal(failed.data.error);
        const parsed = z.strictObject({ version: z.literal(1), id: z.literal(id), command: z.literal("run"), result: z.unknown() }).parse(frame);
        const value = z.object({ checks: z.array(z.string().max(256)).max(19), pid: z.literal(birth.pid), uid: z.literal(1000), nativeApi: z.literal(8) }).passthrough().parse(parsed.result);
        if (mode === "legacy") assert.deepEqual(value.checks, oldChecks);
        else if (mode === "async") asyncUtilityResultSchema.extend({ pid: z.literal(birth.pid) }).parse(parsed.result);
        else assert.equal(value.checks.length, 6);
        diagnosis.mark("RESULT_SCHEMA_VALIDATED");
        accept(value);
      })().catch(reject); });
    }), deadline - performance.now());
    diagnosis.mark("OPERATION_ACCEPTED");
  } catch (error: unknown) {
    operationFailure = error; diagnosis.refuseOperation(error instanceof DiagnosticRefusal ? error.category : operationCategory, error);
    diagnosis.mark("OPERATION_REFUSED");
  }
  executionFinishedMs = performance.now() - start;
  const cleanupStart = performance.now();
  const cleanupDeadline = cleanupStart + UTILITY_CLEANUP_MS;
  try {
    if (!birth) { helper.kill(); throw new Error("Owned utility birth was not confirmed; no disposal certificate."); }
    diagnosis.mark("CLEANUP_BEFORE_OBSERVATION");
    const before = await until(observeBirth(birth), cleanupDeadline - performance.now());
    if (before.level === "running") { killRequested = true; diagnosis.mark("KILL_REQUESTED"); helper.kill(); }
    diagnosis.mark("CLEANUP_AFTER_OBSERVATION");
    observation = await awaitNonRunning(birth, Math.max(0, cleanupDeadline - performance.now()));
    if (performance.now() > cleanupDeadline) throw new Error("Owned utility cleanup exceeded its bound.");
    diagnosis.mark("UTILITY_RETIRED");
  } catch (error: unknown) {
    diagnosis.refuseCleanup(error); diagnosis.mark("UTILITY_RETIREMENT_REFUSED");
    await writeFile(`${output}-utility-ownership.json`, JSON.stringify({ result: "FAIL", category: "OWNED_UTILITY_CLEANUP_FAILED", birth,
      genericExit, killRequested, cleanupMs: performance.now() - cleanupStart }, null, 2), { mode: 0o600 });
    throw new Error("Owned utility cleanup was not confirmed.");
  }
  await writeFile(`${output}-utility-ownership.json`, JSON.stringify({ result: "PASS", birth, genericExit, killRequested, observation,
    cleanupMs: performance.now() - cleanupStart, scope: "Observed same-birth non-running, not a full-reap or universal utility exit guarantee." }, null, 2), { mode: 0o600 });
  if (operationFailure) throw operationFailure;
  if (!birth || !observation) throw new Error("Missing owned utility certificate.");
  return { output: result, ownership: { birth, genericExit, observation, killRequested } };
}
async function runParent(): Promise<void> {
  try {
    await until(app.whenReady(), deadline - performance.now());
    diagnosis.mark("APP_READY");
    window = new BrowserWindow({ show: false, width: 500, height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } });
    await until(window.loadFile("/owned-app/opening-parent/renderer.html"), deadline - performance.now());
    const inspect: unknown = Reflect.get(window.webContents, "getLastWebPreferences");
    if (typeof inspect !== "function") throw new Error("Missing owned renderer preference probe.");
    const rawPreferences: unknown = Reflect.apply(inspect, window.webContents, []);
    const preferences = z.object({ sandbox: z.literal(true), contextIsolation: z.literal(true), nodeIntegration: z.literal(false) }).parse(rawPreferences);
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    const renderer = window.webContents.getOSProcessId();
    const status = await readFile(`/proc/${renderer}/status`, "utf8"), cmdline = await readFile(`/proc/${renderer}/cmdline`, "utf8");
    assert.match(status, /^Uid:\s+1000\s+1000\s+1000\s+1000$/mu); assert.match(status, /^CapEff:\s+0+$/mu);
    assert.match(status, /^NoNewPrivs:\s+1$/mu); assert.match(status, /^Seccomp:\s+2$/mu);
    assert.equal(cmdline.includes("--no-sandbox"), false);
    diagnosis.mark("RENDERER_SANDBOX_VALIDATED");
    const address = profile === "legacy" ? undefined : await privateBus();
    if (address) diagnosis.mark("PRIVATE_BUS_READY");
    if (profile === "async") {
      const service = spawn("/owned-app/tests/owned-bus/service", [addressSchema.parse(address)], {
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, LANG: "C.UTF-8" }, stdio: "ignore",
      });
      serviceOwner = new OwnedDaemon({ pid: service.pid,
        onExit: (callback) => { service.once("exit", callback); }, onClose: (callback) => { service.once("close", callback); },
        onError: (callback) => { service.once("error", callback); }, signalTerminate: () => service.kill("SIGTERM"),
      }, (value) => { writeFileSync("/evidence/async-service-ownership.json", JSON.stringify(value), { mode: 0o600 }); });
      await until(new Promise<void>((accept, reject) => { service.once("spawn", accept); service.once("error", reject); }), deadline - performance.now());
      // This is kernel child admission after spawn, not provider readiness.
      // The candidate utility separately resolves/authenticates the fixed name.
      await serviceOwner.admitAfterReadiness(process.pid, deadline - performance.now());
    }
    scopeResult = { ...(await utility(profile, address)), sandbox: { enabled: true, contextIsolation: true, nodeIntegration: false, rendererPid: renderer },
      versions: { electron: process.versions.electron, node: process.versions.node, napi: process.versions.napi },
      scope: "Owned private-bus utility only; utility is not an OS sandbox. Same-birth non-running is distinct from full reaping." };
    success = true; cleanupConfirmed = true;
  } catch (error: unknown) { diagnosis.refuseOperation(error instanceof DiagnosticRefusal ? error.category : "UNEXPECTED", error); }
  await writeFile(`${output}-execution.json`, JSON.stringify({ result: success ? "PASS" : "FAIL", category: success ? null : "OWNED_OPENING_EXECUTION_FAILED",
    profile, executionMs: executionFinishedMs ?? performance.now() - start, totalBeforeDaemonCleanupMs: performance.now() - start,
    executionBoundMs: EXECUTION_MS, utilityCleanupBoundMs: UTILITY_CLEANUP_MS, scopeResult }, null, 2), { mode: 0o600 });
  const providersUntil = performance.now() + PARENT_PROVIDER_CLEANUP_MS;
  if (serviceOwner) {
    try { await serviceOwner.retire(Math.max(0, providersUntil - performance.now())); }
    catch (error: unknown) { cleanupConfirmed = false; diagnosis.refuseCleanup(error); }
  }
  if (daemonOwner) {
    diagnosis.mark("DAEMON_CLEANUP_STARTED");
    try {
      await daemonOwner.retire(Math.max(0, providersUntil - performance.now()));
      diagnosis.mark("DAEMON_RETIRED");
    } catch (error: unknown) { cleanupConfirmed = false; diagnosis.refuseCleanup(error); diagnosis.mark("DAEMON_RETIREMENT_REFUSED"); }
  }
  window?.destroy();
  await writeFile(`${output}-parent.json`, JSON.stringify({ result: success && cleanupConfirmed ? "PASS" : "FAIL", profile, cleanupConfirmed }, null, 2), { mode: 0o600 });
  app.exit(success && cleanupConfirmed ? 0 : 1);
}
// Return from ESM evaluation before waiting for Electron ready. Main-module
// completion and app.whenReady must never wait on each other.
void runParent().catch(() => { app.exit(1); });

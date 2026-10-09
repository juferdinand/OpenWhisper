import { app, utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { bindPlatformChild, createUtilityPlatformChannelFactory, PlatformChannelError } from "../../src/main/platform-channel.js";

async function ownerPid(): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < 3000) {
    const owners = app.getAppMetrics().filter((metric) => metric.name === "OpenWhisper Dev Platform");
    if (owners.length === 1 && owners[0]) return owners[0].pid;
    await new Promise<void>((accept) => { setTimeout(accept, 10); });
  }
  throw new Error("Owned platform PID was not observable.");
}
async function gone(pid: number): Promise<boolean> {
  try { await access(`/proc/${pid}`); return false; }
  catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function platformTransportProbe(): Promise<string[]> {
  const environment = { PATH: "/opt/node/bin:/usr/bin:/bin", HOME: "/owned-app/home", LANG: "C.UTF-8" };
  await writeFile("/evidence/platform-bus.conf", "<busconfig><type>session</type><listen>unix:path=/tmp/openwhisper-owned-platform</listen><auth>EXTERNAL</auth><policy context='default'><allow user='*'/><allow own='*'/><allow send_destination='*'/><allow receive_sender='*'/></policy></busconfig>", { mode: 0o600 });
  const daemon = spawn("/usr/bin/dbus-daemon", ["--config-file=/evidence/platform-bus.conf", "--nofork", "--print-address=1"], { env: environment, stdio: ["ignore", "pipe", "ignore"] });
  let address = ""; daemon.stdout?.on("data", (bytes: Buffer) => { address += bytes.toString(); if (address.length > 2048) daemon.kill("SIGTERM"); });
  const before = performance.now();
  while (!address.includes("\n")) { if (performance.now() - before > 3000) throw new Error("Owned platform bus readiness failed."); await new Promise<void>((accept) => { setTimeout(accept, 10); }); }
  const factory = createUtilityPlatformChannelFactory();
  const channel = await factory(new AbortController().signal);
  try {
    const status = await channel.request({ version: 1, id: randomUUID(), command: "status" });
    assert.ok(status.ok && status.value.command === "status" && status.value.status === "unavailable");
    const initialized = await channel.request({ version: 1, id: randomUUID(), command: "initialize", address: address.trim() });
    assert.ok(initialized.ok && initialized.value.command === "initialize" && initialized.value.captureAvailable === false);
    const action = spawn("/owned-app/tests/owned-control/client", [address.trim(), "io.github.whisperfree.dev.Control", "normal", "start"], { env: environment, stdio: "ignore" });
    const code = await new Promise<number | null>((accept, reject) => { action.once("error", reject); action.once("close", (value) => { accept(value); }); });
    assert.equal(code, 5);
    await channel.close(); await channel.close();
    // The production factory's abort must retain its request until actual exit.
    const controller = new AbortController(); const failed = await factory(controller.signal);
    const originalPid = await ownerPid();
    const pending = failed.request({ version: 1, id: randomUUID(), command: "status" });
    const refused = assert.rejects(pending, (error: unknown) => error instanceof PlatformChannelError && error.code === "CANCELLED");
    controller.abort(); await refused;
    assert.equal(await gone(originalPid), true);
    await failed.close();
    const replacement = await factory(new AbortController().signal);
    try {
      const replacementPid = await ownerPid(); assert.notEqual(replacementPid, originalPid);
      assert.equal(await gone(originalPid), true);
      const status = await replacement.request({ version: 1, id: randomUUID(), command: "status" });
      assert.ok(status.ok && status.value.command === "status" && status.value.status === "unavailable");
      await writeFile("/evidence/platform-failure-cleanup.json", JSON.stringify({ code: "CANCELLED", originalPid,
        oldProcAbsentAtRequestRejection: true, replacementPid, replacementStatus: "unavailable" }, null, 2), { mode: 0o600 });
    } finally { await replacement.close(); }
    const env = { ...process.env };
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) delete env[key];
    const fault = utilityProcess.fork("/owned-app/tests/owned-control/platform-fault.mjs", [], { env, execArgv: [], stdio: "ignore",
      serviceName: "OpenWhisper Dev owned cleanup failure", allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false });
    const faultChannel = await bindPlatformChild(fault, new AbortController().signal);
    const faultPid = fault.pid; assert.ok(faultPid);
    try {
      await assert.rejects(faultChannel.request({ version: 1, id: randomUUID(), command: "initialize", address: address.trim() }),
        (error: unknown) => error instanceof PlatformChannelError && error.code === "TEARDOWN_FAILED");
      const procAbsent = await gone(faultPid);
      let state: string | undefined;
      if (!procAbsent) {
        try { state = (await readFile(`/proc/${faultPid}/status`, "utf8")).split("\n").find((line) => line.startsWith("State:")); }
        catch (error: unknown) { if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error; }
      }
      await writeFile("/evidence/platform-fatal-process-state.json", JSON.stringify({ faultPid, procAbsentAtRequestRejection: procAbsent,
        stateAtFollowingRead: state ?? "absent", scope: "Owned diagnostic; absence assertion remains strict." }, null, 2), { mode: 0o600 });
      assert.equal(procAbsent, true);
      await assert.rejects(faultChannel.request({ version: 1, id: randomUUID(), command: "initialize", address: address.trim() }),
        (error: unknown) => error instanceof PlatformChannelError && error.code === "CLOSED");
      await writeFile("/evidence/platform-fatal-cleanup.json", JSON.stringify({ originalEntryWithOwnedCreateFailure: true,
        code: "TEARDOWN_FAILED", faultPid, oldProcAbsentAtRequestRejection: true, retryRejected: "CLOSED" }, null, 2), { mode: 0o600 });
    } finally { await faultChannel.close(); }
    return ["actual fixed platform utility readiness and status without automatic bus/capture initialization",
      "actual explicit Dev initialization remains capture-unavailable",
      "actual production transport shutdown confirms owner exit",
      "actual production request cancellation waits for old PID disappearance before replacement",
      "actual original entry maps injected creation cleanup failure to fatal reply and reaps before retry refusal"];
  } finally {
    await channel.close();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGTERM"); const timer = setTimeout(() => { daemon.kill("SIGKILL"); }, 1000);
      await new Promise<void>((accept) => { daemon.once("close", () => { accept(); }); }).finally(() => { clearTimeout(timer); });
    }
  }
}

const readiness = z.strictObject({ version: z.literal(1), ready: z.literal(true) });
const resultSchema = z.strictObject({ version: z.literal(1), id: z.uuid(), command: z.literal("run"), result: z.unknown() });
export async function runControlProbe(): Promise<unknown> {
  if (!app.isReady() || process.getuid?.() !== 1000 || process.env.OPENWHISPER_OWNED_CONTROL_TEST !== "1") throw new Error("Owned ready app is required.");
  const transportChecks = await platformTransportProbe();
  const env = { ...process.env };
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) delete env[key];
  const helper = utilityProcess.fork("/owned-app/tests/owned-control/entry.mjs", [], {
    stdio: "ignore", execArgv: [], env, allowLoadingUnsignedLibraries: false, serviceName: "OpenWhisper Dev owned control test",
    respondToAuthRequestsFromMainProcess: false,
  });
  const id = randomUUID(); let ownerPid: number | undefined;
  const exit = new Promise<void>((accept) => { helper.once("exit", () => { accept(); }); });
  try {
    const result = await new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => { reject(new Error("Owned control helper deadline exceeded.")); }, 45_000);
      helper.once("spawn", () => { ownerPid = helper.pid; });
      helper.once("exit", () => { clearTimeout(timer); reject(new Error("Owned control helper exited before result.")); });
      helper.on("message", (input: unknown) => {
        const ready = readiness.safeParse(input);
        if (ready.success) { helper.postMessage({ version: 1, id, command: "run" }); return; }
        const result = resultSchema.safeParse(input);
        if (!result.success || result.data.id !== id) { clearTimeout(timer); reject(new Error("Owned control fixture returned a failure.")); return; }
        clearTimeout(timer); accept(result.data.result);
      });
    });
    const parsed = z.object({ checks: z.array(z.string()).min(8), uid: z.literal(1000), pid: z.int().positive(), nativeApi: z.literal(8) }).passthrough().parse(result);
    if (parsed.pid !== ownerPid) throw new Error("Unexpected utility owner.");
    helper.kill(); await Promise.race([exit, new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error("Owned helper did not exit.")); }, 8000); })]);
    return { result: "PASS", mainAlive: true, ...parsed, checks: [...transportChecks, ...parsed.checks],
      versions: { electron: process.versions.electron, node: process.versions.node, napi: process.versions.napi },
      scope: "Actual CPU-independent Dev control utility with content-free fake capture. Utility itself is not an OS sandbox; outer container is isolated. No desktop services invoked." };
  } finally { helper.kill(); await Promise.race([exit, new Promise<void>((accept) => { setTimeout(accept, 8000); })]); }
}

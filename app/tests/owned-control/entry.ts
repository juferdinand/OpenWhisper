import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { openLinuxBus } from "../../src/platforms/linux/shared/bus.js";
import { DevControlService, type ControlCaptureLease, type ControlCapturePort, type ControlStatus } from "../../src/platforms/linux/shared/control.js";
import { parseControlStatus, type RecordingStatus } from "../../src/platforms/linux/shared/control-status.js";

const raw: unknown = Reflect.get(process, "parentPort");
if (typeof raw !== "object" || raw === null) throw new Error("Owned utility port required.");
const owner = raw;
function invoke(name: "on" | "postMessage", ...args: unknown[]): void {
  const method: unknown = Reflect.get(owner, name); if (typeof method !== "function") throw new Error("Owned utility port required."); Reflect.apply(method, owner, args);
}
const children = new Set<ChildProcess>();
const env = { PATH: "/opt/node/bin:/usr/bin:/bin", HOME: "/owned-app/home", LANG: "C.UTF-8" };
async function pause(ms = 10): Promise<void> { await new Promise<void>((accept) => { setTimeout(accept, ms); }); }
async function wait(predicate: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const start = performance.now(); while (!await predicate()) { if (performance.now() - start > timeout) throw new Error("Owned control condition timed out."); await pause(); }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  child.kill("SIGTERM"); const timer = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
  await new Promise<void>((accept) => { child.once("close", () => { accept(); }); }).finally(() => { clearTimeout(timer); }); children.delete(child);
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => { throw new Error("Owned gate uninitialized."); };
  const promise = new Promise<void>((accept) => { resolve = accept; }); return { promise, resolve };
}
class FakeCapture implements ControlCapturePort {
  state: ControlStatus = "idle"; starts = 0; cancellations = 0; stops = 0;
  startGate: Promise<void> | undefined; stopGate: Promise<void> | undefined;
  status(): ControlStatus { return this.state; }
  wireStatus() { return { status: this.state === "unavailable" ? "idle" as const : this.state, elapsed: 0n, recovery_available: false }; }
  async start(_signal: AbortSignal): Promise<ControlCaptureLease> {
    this.starts++; await this.startGate; this.state = "recording";
    return { cancel: async () => { this.cancellations++; this.state = "idle"; },
      stop: async () => { this.stops++; await this.stopGate; this.state = "transcribing"; } };
  }
}
async function runProbe(): Promise<unknown> {
  assert.equal(process.getuid?.(), 1000); await access("/.dockerenv");
  assert.equal(process.env.OPENWHISPER_OWNED_CONTROL_TEST, "1");
  for (const device of ["/dev/input", "/dev/uinput", "/dev/snd", "/dev/dri"]) await assert.rejects(access(device));
  await mkdir("/owned-app/home", { recursive: true, mode: 0o700 });
  const config = "<busconfig><type>session</type><listen>unix:path=/tmp/openwhisper-owned-control</listen><auth>EXTERNAL</auth><policy context='default'><allow user='*'/><allow own='*'/><allow send_destination='*'/><allow receive_sender='*'/></policy><limit name='max_connections_per_user'>32</limit></busconfig>";
  await writeFile("/evidence/bus.conf", config, { mode: 0o600 });
  const daemon = spawn("/usr/bin/dbus-daemon", ["--config-file=/evidence/bus.conf", "--nofork", "--print-address=1"], { env, stdio: ["ignore", "pipe", "ignore"] }); children.add(daemon);
  let output = ""; daemon.stdout?.on("data", (bytes: Buffer) => { output += bytes.toString(); if (output.length > 2048) daemon.kill("SIGTERM"); });
  await wait(() => output.includes("\n")); const address = z.string().max(1024).parse(output.split("\n")[0]);
  const bus = await openLinuxBus(address); const capture = new FakeCapture(); const service = await DevControlService.create(bus, capture);
  const checks: string[] = [];
  function client(mode: string, action: string): { process: ChildProcess; result: Promise<{ code: number; output: string }> } {
    const child = spawn("/owned-app/tests/owned-control/client", [address, bus.uniqueName, mode, action], { env, stdio: ["ignore", "pipe", "ignore"] }); children.add(child);
    let text = ""; child.stdout?.on("data", (bytes: Buffer) => { text += bytes.toString(); if (text.length > 1024) child.kill("SIGTERM"); });
    const result = new Promise<{ code: number; output: string }>((accept, reject) => {
      child.once("error", reject); child.once("close", (code) => { children.delete(child); accept({ code: code ?? 1, output: text.trim() }); });
    }); return { process: child, result };
  }
  function accepted(response: { code: number; output: string }, status: RecordingStatus): void {
    assert.equal(response.code, 0); assert.ok(response.output.startsWith("ACCEPTED:"));
    assert.deepEqual(parseControlStatus(response.output.slice("ACCEPTED:".length)), { status, elapsed: 0n, recovery_available: false });
  }
  try {
    assert.equal((await bus.owner("io.github.whisperfree.dev.Control")), bus.uniqueName);
    await assert.rejects(bus.owner("io.github.whisperfree.Control")); checks.push("Dev name is separate; absent production owner is not activated");
    await writeFile("/evidence/foreign-ready.json", JSON.stringify({ address, owner: bus.uniqueName }), { mode: 0o600 });
    await wait(async () => { try { await access("/evidence/foreign-checked"); return true; } catch { return false; } }, 10000);
    assert.equal(capture.starts, 0); checks.push("real UID1001 refused before capture acquisition");
    assert.deepEqual(await client("no-reply", "start").result, { code: 0, output: "NO_REPLY_QUEUED" }); await pause(60);
    assert.equal(capture.starts, 0); checks.push("actual no-reply Start rejected before dispatch");
    const acquisition = deferred(); capture.startGate = acquisition.promise;
    const lost = client("normal", "start"); await wait(() => capture.starts === 1); await stop(lost.process);
    await pause(40); acquisition.resolve(); await wait(() => capture.cancellations === 1);
    assert.equal(capture.state, "idle"); checks.push("caller loss before native acceptance rolls back acquired Start");
    const expiry = deferred(); capture.startGate = expiry.promise;
    const expired = client("normal", "start"); await wait(() => capture.starts === 2); await pause(3100); expiry.resolve();
    await expired.result; await wait(() => capture.cancellations === 2); assert.equal(capture.state, "idle");
    checks.push("actual native expiry prevents accepted Start and disposes late acquisition");
    capture.startGate = undefined;
    accepted(await client("normal", "start").result, "recording");
    await pause(60); assert.equal(capture.state, "recording"); assert.equal(capture.cancellations, 2);
    checks.push("immediate post-ack CLI disconnect preserves committed recording");
    accepted(await client("normal", "start").result, "recording"); assert.equal(capture.starts, 3);
    checks.push("repeat Start is idempotent");
    const closure = deferred(); capture.stopGate = closure.promise;
    const stopping = client("normal", "stop"); await wait(() => capture.stops === 1);
    const busy = await client("normal", "toggle").result; assert.equal(busy.code, 5); assert.equal(capture.starts, 3);
    closure.resolve(); accepted(await stopping.result, "transcribing");
    checks.push("Stop waits for closure fence; concurrent action refused; preparation remains independent");
    capture.state = "idle";
    accepted(await client("normal", "toggle").result, "recording");
    accepted(await client("normal", "cancel").result, "idle");
    checks.push("toggle and cancel use their own content-free lease");
    await service.close(); await bus.close(); checks.push("service closes bus owner and capture leases");
    return { checks, uid: process.getuid?.(), pid: process.pid, nativeApi: 8, starts: capture.starts,
      cancellations: capture.cancellations, scope: "Content-free fake capture only; no audio or desktop adapter is wired." };
  } finally { await service.close().catch(() => undefined); for (const child of [...children]) await stop(child); }
}
let used = false;
invoke("on", "message", (event: { data: unknown }) => {
  const command = z.strictObject({ version: z.literal(1), id: z.uuid(), command: z.literal("run") }).safeParse(event.data);
  if (!command.success || used) process.exit(1); used = true;
  void runProbe().then((result) => { invoke("postMessage", { version: 1, id: command.data.id, command: "run", result }); }, async (error: unknown) => {
    await writeFile("/evidence/fixture-error.txt", error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : "Fixture failed", { mode: 0o600 });
    invoke("postMessage", { version: 1, id: command.data.id, command: "run", error: "FIXTURE_FAILED" });
  });
});
invoke("postMessage", { version: 1, ready: true });

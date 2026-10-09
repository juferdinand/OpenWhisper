import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BusFailure, openLinuxBus, type LinuxBus, type BusMethod } from "../../src/platforms/linux/shared/bus.js";
import type { BusValue } from "../../src/platforms/linux/shared/bus-values.js";
import { safeFailure } from "../owned-bus-opening/diagnostics.js";/* owned-legacy-diagnostic */
import { writeFileSync } from "node:fs";
import { LegacyDiagnosis } from "../owned-bus-opening/legacy-diagnostics.js";
/* end-owned-legacy-diagnostic */

interface ParentPort { on(event: "message", handler: (event: { data: unknown }) => void): void; postMessage(value: unknown): void }
const raw: unknown = Reflect.get(process, "parentPort");
if (typeof raw !== "object" || raw === null) throw new Error("Owned utility parent is required.");
const port: ParentPort = {
  on: (event, handler) => { const fn: unknown = Reflect.get(raw, "on"); if (typeof fn !== "function") throw new Error("Invalid utility parent."); Reflect.apply(fn, raw, [event, handler]); },
  postMessage: (value) => { const fn: unknown = Reflect.get(raw, "postMessage"); if (typeof fn !== "function") throw new Error("Invalid utility parent."); Reflect.apply(fn, raw, [value]); },
};
const env = { PATH: "/opt/node/bin:/usr/bin:/bin", HOME: "/owned-app/home", LANG: "C.UTF-8" };
const children = new Set<ChildProcess>();/* owned-legacy-diagnostic */
const diagnosis = new LegacyDiagnosis((value) => { writeFileSync("/evidence/legacy-entry-diagnosis.json", JSON.stringify(value), { mode: 0o600 }); });
/* end-owned-legacy-diagnostic */
async function pause(ms = 30): Promise<void> { await new Promise<void>((accept) => { setTimeout(accept, ms); }); }
async function wait(predicate: () => Promise<boolean>, timeout = 3000): Promise<void> {
  const start = performance.now(); while (!await predicate()) { if (performance.now() - start > timeout) throw new Error("Owned condition timed out."); await pause(); }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  child.kill("SIGTERM"); const timer = setTimeout(() => { child.kill("SIGKILL"); }, 1500);
  await new Promise<void>((accept) => { child.once("close", () => { accept(); }); }).finally(() => { clearTimeout(timer); }); children.delete(child);
}
async function runProbe(): Promise<unknown> {
  assert.equal(process.getuid?.(), 1000); await access("/.dockerenv");
  for (const device of ["/dev/input", "/dev/uinput", "/dev/snd", "/dev/dri"]) {
    await assert.rejects(access(device));
  }
  assert.equal(process.env.OPENWHISPER_OWNED_BUS_TEST, "1");
  /* owned-legacy-diagnostic */diagnosis.enter("NATIVE_LOAD"); /* end-owned-legacy-diagnostic */const native: unknown = createRequire(import.meta.url)("/owned-app/dist/native/openwhisper_linux_bus.node");/* owned-legacy-diagnostic */ diagnosis.complete("NATIVE_LOAD");/* end-owned-legacy-diagnostic */
  assert.ok(typeof native === "object" && native !== null); const nativeOpen: unknown = Reflect.get(native, "open"); assert.ok(typeof nativeOpen === "function");
  /* owned-legacy-diagnostic */diagnosis.enter("NATIVE_UTF16_OPEN_REFUSAL"); /* end-owned-legacy-diagnostic */for (const invalid of ["unix:path=/tmp/\ud800", "unix:path=/tmp/\udc00"]) assert.throws(() => { Reflect.apply(nativeOpen, native, [invalid]); });/* owned-legacy-diagnostic */ diagnosis.complete("NATIVE_UTF16_OPEN_REFUSAL");/* end-owned-legacy-diagnostic */
  await mkdir("/owned-app/home", { recursive: true, mode: 0o700 });
  const config = "<busconfig><type>session</type><listen>unix:path=/tmp/openwhisper-owned-bus</listen><auth>EXTERNAL</auth><policy context='default'><allow user='*'/><allow own='*'/><allow send_destination='*'/><allow receive_sender='*'/></policy><limit name='max_connections_per_user'>32</limit><limit name='max_message_size'>131072</limit></busconfig>";
  await writeFile("/evidence/bus.conf", config, { mode: 0o600 });
  const daemon = spawn("/usr/bin/dbus-daemon", ["--config-file=/evidence/bus.conf", "--nofork", "--print-address=1"], { env, stdio: ["ignore", "pipe", "ignore"] }); children.add(daemon);
  let output = ""; daemon.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 2048) daemon.kill("SIGTERM"); });
  /* owned-legacy-diagnostic */diagnosis.enter("DAEMON_READY"); /* end-owned-legacy-diagnostic */await wait(async () => output.includes("\n")); const address = z.string().max(1024).parse(output.split("\n")[0]);/* owned-legacy-diagnostic */ diagnosis.complete("DAEMON_READY");/* end-owned-legacy-diagnostic */
  /* owned-legacy-diagnostic */diagnosis.enter("NATIVE_IDENTITY_OPEN"); /* end-owned-legacy-diagnostic */const nativeIdentity: unknown = await Reflect.apply(nativeOpen, native, [address]);/* owned-legacy-diagnostic */ diagnosis.complete("NATIVE_IDENTITY_OPEN");/* end-owned-legacy-diagnostic */
  const identity = z.strictObject({ connection: z.uuid(), uniqueName: z.string() }).parse(nativeIdentity);
  const nativeCall: unknown = Reflect.get(native, "call"), nativeClose: unknown = Reflect.get(native, "close");
  assert.ok(typeof nativeCall === "function" && typeof nativeClose === "function");
/* owned-legacy-diagnostic */  diagnosis.enter("NATIVE_UTF16_CALL_REFUSAL");
/* end-owned-legacy-diagnostic */  for (const invalid of ["\ud800", "\udc00", "before\ud800after"]) assert.throws(() => {
    Reflect.apply(nativeCall, native, [identity.connection, { id: randomUUID(), destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus",
      member: "GetNameOwner", inputSignature: "s", outputSignature: "s", body: [{ type: "s", value: invalid }], timeoutMs: 1000, noAutoStart: true }]);
  });
/* owned-legacy-diagnostic */  diagnosis.complete("NATIVE_UTF16_CALL_REFUSAL");
/* end-owned-legacy-diagnostic */  /* owned-legacy-diagnostic */diagnosis.enter("NATIVE_IDENTITY_CLOSE"); /* end-owned-legacy-diagnostic */await Reflect.apply(nativeClose, native, [identity.connection]);/* owned-legacy-diagnostic */ diagnosis.complete("NATIVE_IDENTITY_CLOSE");/* end-owned-legacy-diagnostic */
  /* owned-legacy-diagnostic */diagnosis.enter("FACADE_OPEN"); /* end-owned-legacy-diagnostic */let bus = await openLinuxBus(address);/* owned-legacy-diagnostic */ diagnosis.complete("FACADE_OPEN");/* end-owned-legacy-diagnostic */ const checks: string[] = ["actual native UTF16 surrogate rejection before method dispatch"];/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */ let service: ChildProcess | undefined;
  function spawnService(): ChildProcess { const child = spawn("/owned-app/tests/owned-bus/service", [address], { env, stdio: "ignore" }); children.add(child); return child; }
  const serviceName = "org.openwhisper.Owned.Test";
  async function ownService(): Promise<string> { let owner: string | undefined; await wait(async () => { try { owner = await bus.owner(serviceName); return true; } catch { return false; } }); assert.ok(owner); return owner; }
  function method(destination: string, member: string, inputSignature = "", outputSignature = "", body: BusValue[] = [], timeoutMs = 3000): BusMethod {
    return { destination, path: "/owned", interface: "org.openwhisper.Owned", member, inputSignature, outputSignature, body, timeoutMs };
  }
  async function memfds(): Promise<number> {
    let count = 0; for (const file of await readdir("/proc/self/fd")) { try { if ((await readlink(`/proc/self/fd/${file}`)).includes("memfd:owned-")) count += 1; } catch { /* Entry may close during enumeration. */ } } return count;
  }
  try {
    /* owned-legacy-diagnostic */diagnosis.enter("SERVICE_OWNER"); /* end-owned-legacy-diagnostic */service = spawnService(); const owner = await ownService();/* owned-legacy-diagnostic */ diagnosis.complete("SERVICE_OWNER");/* end-owned-legacy-diagnostic */ /* owned-legacy-diagnostic */diagnosis.enter("OWNER_UID"); /* end-owned-legacy-diagnostic */assert.equal(await bus.uid(owner), 1000);/* owned-legacy-diagnostic */ diagnosis.complete("OWNER_UID");/* end-owned-legacy-diagnostic */ checks.push("real unique owner and same UID");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("ABSENT_OWNER"); /* end-owned-legacy-diagnostic */await assert.rejects(bus.owner("org.openwhisper.Absent"), (error: unknown) => error instanceof BusFailure && error.code === "REMOTE_ERROR");/* owned-legacy-diagnostic */ diagnosis.complete("ABSENT_OWNER");/* end-owned-legacy-diagnostic */ checks.push("absent service NoAutoStart");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    const body: BusValue[] = [{ type: "x", value: "-9223372036854775808" }, { type: "t", value: "18446744073709551615" },
      { type: "dict", key: "s", member: "v", value: [{ key: { type: "s", value: "key" }, value: { type: "v", signature: "u", value: { type: "u", value: 7 } } }] },
      { type: "a", element: "(su)", value: [{ type: "r", value: [{ type: "s", value: "Grüß dich · 日本語 · 🎙️ 😀" }, { type: "u", value: 5 }] }] }];
    /* owned-legacy-diagnostic */diagnosis.enter("ECHO"); /* end-owned-legacy-diagnostic */assert.deepEqual((await bus.call(method(owner, "Echo", "xta{sv}a(su)", "xta{sv}a(su)", body))).body, body);/* owned-legacy-diagnostic */ diagnosis.complete("ECHO");/* end-owned-legacy-diagnostic */ checks.push("actual widths dictionary variant tuple roundtrip");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("WRONG_SIGNATURE"); /* end-owned-legacy-diagnostic */await assert.rejects(bus.call(method(owner, "Wrong", "", "s")));/* owned-legacy-diagnostic */ diagnosis.complete("WRONG_SIGNATURE");/* end-owned-legacy-diagnostic */ /* owned-legacy-diagnostic */diagnosis.enter("CLOSE_WRONG_SIGNATURE"); /* end-owned-legacy-diagnostic */await bus.close();/* owned-legacy-diagnostic */ diagnosis.complete("CLOSE_WRONG_SIGNATURE"); diagnosis.enter("REOPEN_WRONG_SIGNATURE");/* end-owned-legacy-diagnostic */ bus = await openLinuxBus(address);/* owned-legacy-diagnostic */ diagnosis.complete("REOPEN_WRONG_SIGNATURE");/* end-owned-legacy-diagnostic */ checks.push("actual mismatched output signature refused and owner disposed");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    for (const mode of ["file", "extra"]) {
      /* owned-legacy-diagnostic */diagnosis.enterFd("receive", mode); /* end-owned-legacy-diagnostic */const reply = await bus.call(method(owner, "Fd", "s", "h", [{ type: "s", value: mode }])); const fd = reply.body[0]; assert.ok(fd?.type === "h");/* owned-legacy-diagnostic */ diagnosis.completeFd("receive", mode);/* end-owned-legacy-diagnostic */
      /* owned-legacy-diagnostic */diagnosis.enterFd("reflect", mode); /* end-owned-legacy-diagnostic */assert.equal((await bus.call(method(owner, "ReflectFd", "h", "u", [fd]))).body[0]?.type, "u");/* owned-legacy-diagnostic */ diagnosis.completeFd("reflect", mode);/* end-owned-legacy-diagnostic */
      /* owned-legacy-diagnostic */diagnosis.enterFd("consume", mode); /* end-owned-legacy-diagnostic */assert.equal((await bus.readRegularFd(fd.token)).toString(), "owned-fd-metadata"); assert.throws(() => bus.closeFd(fd.token));/* owned-legacy-diagnostic */ diagnosis.completeFd("consume", mode);/* end-owned-legacy-diagnostic */
      assert.equal(await memfds(), 0);
    }
    for (const mode of ["pipe", "large"]) {
      /* owned-legacy-diagnostic */diagnosis.enterFd("receive", mode); /* end-owned-legacy-diagnostic */const reply = await bus.call(method(owner, "Fd", "s", "h", [{ type: "s", value: mode }])); const fd = reply.body[0]; assert.ok(fd?.type === "h");/* owned-legacy-diagnostic */ diagnosis.completeFd("receive", mode);/* end-owned-legacy-diagnostic */
      /* owned-legacy-diagnostic */diagnosis.enterFd("refuse", mode); /* end-owned-legacy-diagnostic */await assert.rejects(bus.readRegularFd(fd.token)); assert.throws(() => bus.closeFd(fd.token)); assert.equal(await memfds(), 0);/* owned-legacy-diagnostic */ diagnosis.completeFd("refuse", mode);/* end-owned-legacy-diagnostic */
    }
    /* owned-legacy-diagnostic */diagnosis.enter("FD_BAD_SIGNATURE"); /* end-owned-legacy-diagnostic */await assert.rejects(bus.call(method(owner, "Fd", "s", "h", [{ type: "s", value: "bad" }])));/* owned-legacy-diagnostic */ diagnosis.complete("FD_BAD_SIGNATURE");/* end-owned-legacy-diagnostic */ /* owned-legacy-diagnostic */diagnosis.enter("FD_BAD_CLOSE"); /* end-owned-legacy-diagnostic */await bus.close();/* owned-legacy-diagnostic */ diagnosis.complete("FD_BAD_CLOSE"); diagnosis.enter("FD_BAD_REOPEN");/* end-owned-legacy-diagnostic */ bus = await openLinuxBus(address); assert.equal(await memfds(), 0);/* owned-legacy-diagnostic */ diagnosis.complete("FD_BAD_REOPEN");/* end-owned-legacy-diagnostic */
    checks.push("actual FD receive reflect consume unused malformed pipe oversize cleanup");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("CANCELLED_HOLD"); /* end-owned-legacy-diagnostic */const cancelled = new AbortController(); const held = bus.call(method(owner, "Hold"), cancelled.signal); setTimeout(() => { cancelled.abort(); }, 50);
    await assert.rejects(held, (error: unknown) => error instanceof BusFailure && error.code === "CANCELLED");/* owned-legacy-diagnostic */ diagnosis.complete("CANCELLED_HOLD");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("EXPECTED_TIMEOUT"); /* end-owned-legacy-diagnostic */await assert.rejects(bus.call(method(owner, "Hold", "", "", [], 60)), (error: unknown) => error instanceof BusFailure && error.code === "TIMEOUT");/* owned-legacy-diagnostic */ diagnosis.complete("EXPECTED_TIMEOUT");/* end-owned-legacy-diagnostic */
    checks.push("actual GCancellable and finite native deadline");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("SUBSCRIBE"); /* end-owned-legacy-diagnostic */let signalCount = 0; const unwatch = await bus.subscribe({ sender: owner, path: "/owned", interface: "org.openwhisper.Owned", member: "Changed" }, () => { signalCount += 1; });/* owned-legacy-diagnostic */ diagnosis.complete("SUBSCRIBE");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("EMIT"); /* end-owned-legacy-diagnostic */await bus.call(method(owner, "Emit")); await wait(async () => signalCount === 1);/* owned-legacy-diagnostic */ diagnosis.complete("EMIT");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("UNSUBSCRIBE"); /* end-owned-legacy-diagnostic */await unwatch();/* owned-legacy-diagnostic */ diagnosis.complete("UNSUBSCRIBE");/* end-owned-legacy-diagnostic */ /* owned-legacy-diagnostic */diagnosis.enter("EMIT_AFTER_UNSUBSCRIBE"); /* end-owned-legacy-diagnostic */await bus.call(method(owner, "Emit")); await pause(60); assert.equal(signalCount, 1);/* owned-legacy-diagnostic */ diagnosis.complete("EMIT_AFTER_UNSUBSCRIBE");/* end-owned-legacy-diagnostic */ checks.push("actual unique sender subscription and unsubscribe");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    let controls = 0; let foreignUid: number | undefined; let expiredRefused = false;
/* owned-legacy-diagnostic */    diagnosis.enter("CONTROL_EXPORT");
/* end-owned-legacy-diagnostic */    await bus.exportControl((event) => { void (async () => {
      if (event.member === "Execute" && event.body[0]?.type === "s" && event.body[0].value === "late-auth") {
        await pause(3100); assert.equal(bus.controlCurrent(event), false);
        await assert.rejects(bus.authorizeControl(event), (error: unknown) => error instanceof BusFailure && error.code === "EXPIRED"); expiredRefused = true; return;
      }
      try { await bus.authorizeControl(event); }
      catch (error: unknown) {
        if (error instanceof BusFailure && error.code === "DENIED") { foreignUid = await bus.uid(event.sender); await bus.reject(event.id, "Denied"); return; }
        throw error;
      }
      assert.equal(bus.controlCurrent(event), true);
      if (event.member === "Execute" && event.body[0]?.type === "s" && event.body[0].value === "invalid") { await bus.reject(event.id, "InvalidRequest"); return; }
      if (event.member === "Execute" && event.body[0]?.type === "s" && event.body[0].value === "expire") return;
      controls += 1; await bus.reply(event.id, "idle");
    })().catch(() => { void bus.reject(event.id, "Unavailable").catch(() => undefined); }); });
/* owned-legacy-diagnostic */    diagnosis.complete("CONTROL_EXPORT");
/* end-owned-legacy-diagnostic */    const control: BusMethod = { destination: bus.uniqueName, path: "/io/github/whisperfree/dev/Control", interface: "io.github.whisperfree.Control1",
      member: "Status", inputSignature: "", outputSignature: "s", body: [], timeoutMs: 3000 };
    /* owned-legacy-diagnostic */diagnosis.enter("CONTROL_STATUS"); /* end-owned-legacy-diagnostic */assert.deepEqual((await bus.call(control)).body, [{ type: "s", value: "idle" }]); assert.equal(controls, 1);/* owned-legacy-diagnostic */ diagnosis.complete("CONTROL_STATUS");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("CONTROL_INVALID"); /* end-owned-legacy-diagnostic */await assert.rejects(bus.call({ ...control, member: "Execute", inputSignature: "s", body: [{ type: "s", value: "invalid" }] }));/* owned-legacy-diagnostic */ diagnosis.complete("CONTROL_INVALID");/* end-owned-legacy-diagnostic */
    checks.push("actual fixed Dev control export real UID checked and safe refusal");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("CONTROL_UNANSWERED"); /* end-owned-legacy-diagnostic */await assert.rejects(bus.call({ ...control, member: "Execute", inputSignature: "s", body: [{ type: "s", value: "expire" }], timeoutMs: 5000 }), (error: unknown) => error instanceof BusFailure && error.code === "REMOTE_ERROR");/* owned-legacy-diagnostic */ diagnosis.complete("CONTROL_UNANSWERED");/* end-owned-legacy-diagnostic */
    checks.push("actual unanswered exported invocation expires natively");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("CONTROL_EXPIRED_AUTH"); /* end-owned-legacy-diagnostic */await assert.rejects(bus.call({ ...control, member: "Execute", inputSignature: "s", body: [{ type: "s", value: "late-auth" }], timeoutMs: 5000 }));/* owned-legacy-diagnostic */ diagnosis.complete("CONTROL_EXPIRED_AUTH");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("EXPIRED_AUTH_OBSERVED"); /* end-owned-legacy-diagnostic */await wait(async () => expiredRefused); assert.equal(controls, 1);/* owned-legacy-diagnostic */ diagnosis.complete("EXPIRED_AUTH_OBSERVED");/* end-owned-legacy-diagnostic */ checks.push("actual expired monotonic authorization never reaches control action");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("FOREIGN_MARKER"); /* end-owned-legacy-diagnostic */await writeFile("/evidence/foreign-ready.json", JSON.stringify({ address, owner: bus.uniqueName }), { mode: 0o600 });/* owned-legacy-diagnostic */ diagnosis.complete("FOREIGN_MARKER");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("FOREIGN_WAIT"); /* end-owned-legacy-diagnostic */await wait(async () => { try { await access("/evidence/foreign-checked"); return true; } catch { return false; } }, 10_000);/* owned-legacy-diagnostic */ diagnosis.complete("FOREIGN_WAIT");/* end-owned-legacy-diagnostic */
    assert.equal(foreignUid, 1001); assert.equal(controls, 1); checks.push("actual UID1001 caller denied before control action");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    const staleSignals: number[] = [];
    /* owned-legacy-diagnostic */diagnosis.enter("STALE_SUBSCRIBE"); /* end-owned-legacy-diagnostic */await bus.subscribe({ sender: owner, path: "/owned", interface: "org.openwhisper.Owned", member: "Changed" }, () => { staleSignals.push(1); });/* owned-legacy-diagnostic */ diagnosis.complete("STALE_SUBSCRIBE");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("OWNER_REPLACEMENT"); /* end-owned-legacy-diagnostic */await stop(service); service = spawnService(); const next = await ownService(); assert.notEqual(next, owner);/* owned-legacy-diagnostic */ diagnosis.complete("OWNER_REPLACEMENT");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("OLD_OWNER_CALL"); /* end-owned-legacy-diagnostic */await assert.rejects(bus.call(method(owner, "Emit")));/* owned-legacy-diagnostic */ diagnosis.complete("OLD_OWNER_CALL");/* end-owned-legacy-diagnostic */ /* owned-legacy-diagnostic */diagnosis.enter("NEW_OWNER_CALL"); /* end-owned-legacy-diagnostic */await bus.call(method(next, "Emit")); await pause(60); assert.equal(staleSignals.length, 0);/* owned-legacy-diagnostic */ diagnosis.complete("NEW_OWNER_CALL");/* end-owned-legacy-diagnostic */
    checks.push("actual owner replacement old destination and signals stay fenced");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("BURST_SUBSCRIBE"); /* end-owned-legacy-diagnostic */await bus.subscribe({ sender: next, path: "/owned", interface: "org.openwhisper.Owned", member: "Changed" }, () => { signalCount += 1; });/* owned-legacy-diagnostic */ diagnosis.complete("BURST_SUBSCRIBE");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("BURST_REFUSAL"); /* end-owned-legacy-diagnostic */const burst = bus.call(method(next, "Burst")); const burstRefused = assert.rejects(burst);
    // Block only this owned fixture's Node loop. The GLib thread must refuse
    // its bounded delivery queue instead of buffering arbitrary events.
    const busyUntil = performance.now() + 150; while (performance.now() < busyUntil) { /* Deliberate owned queue backpressure. */ }
    await burstRefused;/* owned-legacy-diagnostic */ diagnosis.complete("BURST_REFUSAL");/* end-owned-legacy-diagnostic */ /* owned-legacy-diagnostic */diagnosis.enter("BURST_CLOSE_REOPEN"); /* end-owned-legacy-diagnostic */await bus.close(); bus = await openLinuxBus(address); checks.push("actual native signal queue overflow closes owner");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic *//* owned-legacy-diagnostic */ diagnosis.complete("BURST_CLOSE_REOPEN");/* end-owned-legacy-diagnostic */
    let oversizedEvents = 0;
    /* owned-legacy-diagnostic */diagnosis.enter("HUGE_SUBSCRIBE"); /* end-owned-legacy-diagnostic */await bus.subscribe({ sender: next, path: "/owned", interface: "org.openwhisper.Owned", member: "Changed" }, () => { oversizedEvents += 1; });/* owned-legacy-diagnostic */ diagnosis.complete("HUGE_SUBSCRIBE");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("HUGE_REFUSAL"); /* end-owned-legacy-diagnostic */const huge = bus.call(method(next, "Huge")); await assert.rejects(huge); await pause(50); await bus.close(); assert.equal(oversizedEvents, 0);/* owned-legacy-diagnostic */ diagnosis.complete("HUGE_REFUSAL");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("HUGE_REOPEN"); /* end-owned-legacy-diagnostic */bus = await openLinuxBus(address); checks.push("actual oversized signal refused before application callback");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic *//* owned-legacy-diagnostic */ diagnosis.complete("HUGE_REOPEN");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("RETAINED_FD"); /* end-owned-legacy-diagnostic */const retained = await bus.call(method(next, "Fd", "s", "h", [{ type: "s", value: "file" }])); assert.equal(retained.body[0]?.type, "h"); assert.equal(await memfds(), 1);/* owned-legacy-diagnostic */ diagnosis.complete("RETAINED_FD");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("QUEUED_HOLD"); /* end-owned-legacy-diagnostic */const pending = Array.from({ length: 8 }, () => bus.call(method(next, "Hold", "", "", [], 5000)));
    const rejected = pending.map((request) => assert.rejects(request)); assert.throws(() => bus.call(method(next, "Hold")));/* owned-legacy-diagnostic */ diagnosis.complete("QUEUED_HOLD");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("QUEUED_CLOSE"); /* end-owned-legacy-diagnostic */await pause(40); await bus.close(); await Promise.all(rejected); await bus.close(); assert.equal(await memfds(), 0); checks.push("close cancels full bounded request queue and disposes unconsumed FD holder");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic *//* owned-legacy-diagnostic */ diagnosis.complete("QUEUED_CLOSE");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("FRESH_GENERATION"); /* end-owned-legacy-diagnostic */const fresh = await openLinuxBus(address); assert.notEqual(fresh.uniqueName, bus.uniqueName); await fresh.close(); checks.push("confirmed close permits clean connection generation");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic *//* owned-legacy-diagnostic */ diagnosis.complete("FRESH_GENERATION");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("IDLE_DAEMON_STOP"); /* end-owned-legacy-diagnostic */const idle = await openLinuxBus(address); await stop(service); await stop(daemon);/* owned-legacy-diagnostic */ diagnosis.complete("IDLE_DAEMON_STOP");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("IDLE_CLOSED"); /* end-owned-legacy-diagnostic */await wait(async () => idle.isClosed); await idle.close(); checks.push("actual idle daemon loss invalidates and disposes without another call");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic *//* owned-legacy-diagnostic */ diagnosis.complete("IDLE_CLOSED");/* end-owned-legacy-diagnostic */
    await rm("/tmp/openwhisper-owned-bus", { force: true });
    const replacementDaemon = spawn("/usr/bin/dbus-daemon", ["--config-file=/evidence/bus.conf", "--nofork", "--print-address=1"], { env, stdio: ["ignore", "pipe", "ignore"] }); children.add(replacementDaemon);
    let newOutput = ""; replacementDaemon.stdout?.on("data", (bytes: Buffer) => { newOutput += bytes.toString(); if (newOutput.length > 2048) replacementDaemon.kill("SIGTERM"); });
    /* owned-legacy-diagnostic */diagnosis.enter("REPLACEMENT_DAEMON_READY"); /* end-owned-legacy-diagnostic */await wait(async () => newOutput.includes("\n")); const replacementAddress = z.string().max(1024).parse(newOutput.split("\n")[0]);/* owned-legacy-diagnostic */ diagnosis.complete("REPLACEMENT_DAEMON_READY");/* end-owned-legacy-diagnostic */
    /* owned-legacy-diagnostic */diagnosis.enter("REPLACEMENT_FACADE"); /* end-owned-legacy-diagnostic */const restored = await openLinuxBus(replacementAddress); assert.notEqual(restored.generation, idle.generation); await restored.close(); checks.push("actual daemon replacement establishes fresh transport generation");/* owned-legacy-diagnostic */ diagnosis.checks(checks);/* end-owned-legacy-diagnostic *//* owned-legacy-diagnostic */ diagnosis.complete("REPLACEMENT_FACADE");/* end-owned-legacy-diagnostic */
    return { checks, uid: process.getuid?.(), pid: process.pid, generation: bus.uniqueName, nativeApi: 8, scope: "Owned private-bus utility only; no desktop permission trigger capture or packaging parity." };
  } finally { /* owned-legacy-diagnostic */diagnosis.beginCleanup(); diagnosis.cleanupEnter("FINAL_BUS_CLOSE"); /* end-owned-legacy-diagnostic */await bus.close().catch(() => undefined);/* owned-legacy-diagnostic */ diagnosis.cleanupComplete("FINAL_BUS_CLOSE"); diagnosis.cleanupEnter("FINAL_CHILD_STOP");/* end-owned-legacy-diagnostic */ for (const child of [...children]) await stop(child);/* owned-legacy-diagnostic */ diagnosis.cleanupComplete("FINAL_CHILD_STOP");/* end-owned-legacy-diagnostic */ }
}

let used = false;
port.on("message", (event) => {
  const command = z.strictObject({ version: z.literal(1), id: z.uuid(), command: z.literal("run") }).safeParse(event.data);
  if (!command.success || used) { process.exitCode = 1; return; } used = true;
  void runProbe().then((result) => { port.postMessage({ version: 1, id: command.data.id, command: "run", result }); }, async (error: unknown) => {
    // Synthetic test assertions are retained categorically, never native payloads.
/* owned-legacy-diagnostic */    diagnosis.refuse(error);
/* end-owned-legacy-diagnostic */    await writeFile("/evidence/fixture-error.json", JSON.stringify(safeFailure("SCENARIO", error)), { mode: 0o600 });
    port.postMessage({ version: 1, id: command.data.id, command: "run", error: error instanceof BusFailure ? error.code : "FIXTURE_FAILED" });
  });
});
port.postMessage({ version: 1, ready: true });

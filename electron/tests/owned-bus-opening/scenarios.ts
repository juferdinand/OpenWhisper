/** Review-stage fixture only. Nothing loads an addon, opens a bus or listens on
 * a socket at import time. Execute only after the source/build plan is approved. */
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { randomUUID, pbkdf2 } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { LinuxBus, parseSessionBusAddress } from "../../src/platforms/linux/shared/bus.js";

const openingSchema = z.strictObject({ connection: z.uuid(), ready: z.instanceof(Promise) });
const identitySchema = z.strictObject({ connection: z.uuid(), uniqueName: z.string().regex(/^:[0-9]+\.[0-9]+$/) });
const expiry = (microseconds: bigint) => (process.hrtime.bigint() / 1000n + microseconds).toString();
async function pause(milliseconds: number): Promise<void> { await new Promise<void>((accept) => { setTimeout(accept, milliseconds); }); }
async function wait(predicate: () => boolean, milliseconds: number): Promise<void> {
  const deadline = performance.now() + milliseconds;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error("Owned opening condition timed out."); await pause(10); }
}
function code(expected: string): (error: unknown) => boolean {
  return (error) => typeof error === "object" && error !== null && Reflect.get(error, "code") === expected;
}
function method(binding: unknown, name: string): (...args: unknown[]) => unknown {
  assert.ok(typeof binding === "object" && binding !== null);
  const callable: unknown = Reflect.get(binding, name); assert.ok(typeof callable === "function");
  return (...args) => { const value: unknown = Reflect.apply(callable, binding, args); return value; };
}

export async function runOwnedOpeningScenarios(binding: unknown, ownedAddress: unknown): Promise<unknown> {
  assert.equal(process.getuid?.(), 1000);
  assert.equal(process.env.OPENWHISPER_OWNED_BUS_OPENING_TEST, "1");
  assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
  assert.ok(typeof Reflect.get(process, "parentPort") === "object");
  await access("/.dockerenv");
  for (const device of ["/dev/input", "/dev/uinput", "/dev/snd", "/dev/dri"]) await assert.rejects(access(device));
  const address = parseSessionBusAddress(ownedAddress);
  assert.match(address, /^unix:path=\/tmp\/openwhisper-owned-bus(?:,guid=[a-f0-9]{32})?$/);
  const open = method(binding, "open"), begin = method(binding, "beginOpen"), close = method(binding, "close");
  const subscribe = method(binding, "subscribe"), exportControl = method(binding, "exportControl"), call = method(binding, "call");
  const directory = await mkdtemp("/tmp/openwhisper-owned-opening-");
  const socketPath = join(directory, "auth"); const stalled = `unix:path=${socketPath}`;
  const peers = new Set<Socket>(); let accepted = 0;
  const server = createServer((peer) => {
    accepted++; peers.add(peer); let bytes = 0;
    peer.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 512) peer.destroy(); });
    peer.on("error", () => { /* No untrusted error text or authentication bodies are logged. */ });
    peer.on("close", () => { peers.delete(peer); });
    // Deliberately send no EXTERNAL response. All peers belong to this UID1000 fixture.
  });
  server.maxConnections = 1;
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(socketPath, accept); });
  const checks: string[] = []; const timings: Record<string, number> = {};
  const owned = new Set<string>();
  const noop = (_frame: unknown): void => {};
  const beginOwned = (target: string, deadline: string) => {
    const opening = openingSchema.parse(begin(target, deadline, noop)); owned.add(opening.connection); return opening;
  };
  const closeOwned = async (token: string): Promise<void> => { await close(token); owned.delete(token); };
  try {
    for (const invalid of ["0", "01", "-1", "18446744073709551616", "1.5", ""]) {
      assert.throws(() => begin(stalled, invalid, noop), code("INVALID_FRAME"));
    }
    assert.throws(() => begin(stalled, "1", noop), code("TIMEOUT"));
    assert.equal(accepted, 0); checks.push("invalid or already expired opening allocates no peer");

    const cancellation = beginOwned(stalled, expiry(5_000_000n));
    let readySettled = false;
    void cancellation.ready.then(() => { readySettled = true; }, () => { readySettled = true; });
    const refused = assert.rejects(cancellation.ready);
    await wait(() => peers.size === 1, 2000);
    const cancelStart = performance.now();
    const first: unknown = close(cancellation.connection); const duplicate: unknown = close(cancellation.connection);
    assert.ok(first instanceof Promise); assert.equal(duplicate, first);
    await first; assert.equal(readySettled, true); await refused; owned.delete(cancellation.connection);
    await wait(() => peers.size === 0, 2000);
    timings.cancelMs = performance.now() - cancelStart;
    checks.push("blocked EXTERNAL opens expose a UUID and share one confirmed close");

    const expires = expiry(100_000n); const deadlineStart = performance.now();
    const expired = beginOwned(stalled, expires);
    await assert.rejects(expired.ready, code("TIMEOUT"));
    timings.expiryMs = performance.now() - deadlineStart;
    await pause(150); // Allow automatic native stop/finalizers before claiming close.
    assert.throws(() => open(address), code("INVALID_FRAME"));
    await closeOwned(expired.connection); await wait(() => peers.size === 0, 2000);
    checks.push("automatic failed-open cleanup retains the early token until explicit certificate claim");

    const beforeQueued = accepted;
    const occupied = new Promise<void>((accept, reject) => {
      pbkdf2("owned", "fixture", 1_000_000, 32, "sha256", (error) => { error ? reject(new Error("Owned queue fixture failed.")) : accept(); });
    });
    const queueStart = performance.now();
    const queued = beginOwned(stalled, expiry(40_000n));
    await assert.rejects(queued.ready, code("TIMEOUT")); await occupied;
    timings.queuedMs = performance.now() - queueStart;
    assert.equal(accepted, beforeQueued); await closeOwned(queued.connection);
    checks.push("expired queued work does not reset its budget or connect after dequeue");

    const connected = beginOwned(address, expiry(5_000_000n));
    const identity = identitySchema.parse(await connected.ready); assert.equal(identity.connection, connected.connection);
    let delivered = 0;
    const signal = (_frame: unknown): void => { delivered++; };
    await subscribe(identity.connection, { sender: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus", member: "NameOwnerChanged" }, signal);
    await exportControl(identity.connection, noop);
    const requestName = (name: "org.openwhisper.Owned.Opening" | "org.openwhisper.Owned.Queued"): unknown => call(identity.connection, { id: randomUUID(), destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "RequestName",
      inputSignature: "su", outputSignature: "u", body: [{ type: "s", value: name }, { type: "u", value: 0 }],
      timeoutMs: 1000, noAutoStart: true });
    await requestName("org.openwhisper.Owned.Opening"); await wait(() => delivered > 0, 1000);
    // A daemon-only owned name call creates queued delivery while this synthetic
    // loop is briefly held; no desktop, user input or recording action exists.
    const queuedReply = Promise.resolve(requestName("org.openwhisper.Owned.Queued")); void queuedReply.catch(() => undefined);
    const busyUntil = performance.now() + 50; while (performance.now() < busyUntil) { /* Owned callback queue fixture. */ }
    const certificate: unknown = close(identity.connection);
    assert.ok(certificate instanceof Promise); assert.equal(close(identity.connection), certificate);
    await certificate; owned.delete(identity.connection); await Promise.allSettled([queuedReply]); const after = delivered;
    const replacement = identitySchema.parse(await open(address, noop));
    assert.notEqual(replacement.connection, identity.connection); await close(replacement.connection);
    await pause(80); assert.equal(delivered, after);
    checks.push("lifecycle signal and export holders retire before replacement with no post-certificate callback");

    const controller = new AbortController(); const opening = LinuxBus.open(binding, stalled, controller.signal, { expiresAtUs: expiry(5_000_000n) });
    const facadeRefused = assert.rejects(opening);
    await wait(() => peers.size === 1, 2000); controller.abort(); await facadeRefused;
    const compatible = await LinuxBus.open(binding, address); await compatible.close();
    checks.push("new facade cancels before readiness and unchanged default facade can reopen");
    return { checks, timings, uid: 1000, pid: process.pid, nativeApi: 8,
      scope: "Owned private bus and stalled Unix EXTERNAL fixture; source review plus API behavior, no debug finalizer counters or desktop/capture parity." };
  } finally {
    for (const token of owned) await closeOwned(token);
    for (const peer of peers) peer.destroy();
    await new Promise<void>((accept, reject) => { server.close((error) => { error ? reject(new Error("Owned socket disposal failed.")) : accept(); }); });
    await rm(directory, { recursive: true });
  }
}

/** Test-only abrupt environment disposal. The parent must separately observe
 * this owned process becoming non-running; a generic Electron exit is not proof. */
export async function runOwnedOpeningCleanupScenario(binding: unknown, ownedAddress: unknown): Promise<never> {
  assert.equal(process.getuid?.(), 1000); await access("/.dockerenv");
  assert.equal(process.env.OPENWHISPER_OWNED_BUS_OPENING_TEST, "1");
  assert.ok(typeof Reflect.get(process, "parentPort") === "object");
  const address = parseSessionBusAddress(ownedAddress);
  assert.match(address, /^unix:path=\/tmp\/openwhisper-owned-bus(?:,guid=[a-f0-9]{32})?$/);
  const begin = method(binding, "beginOpen"), subscribe = method(binding, "subscribe");
  const exportControl = method(binding, "exportControl"), close = method(binding, "close");
  const noop = (_frame: unknown): void => {};
  const opening = openingSchema.parse(begin(address, expiry(5_000_000n), noop));
  await opening.ready;
  const filter = { sender: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged" };
  await subscribe(opening.connection, filter, noop); await exportControl(opening.connection, noop);
  const pending = Promise.resolve(subscribe(opening.connection, filter, noop)); void pending.catch(() => undefined);
  const certificate: unknown = close(opening.connection); assert.ok(certificate instanceof Promise);
  void certificate.then(() => {
    writeFileSync("/evidence/cleanup-ack.json", JSON.stringify({ acknowledgement: true }), { mode: 0o600 });
  }, () => { /* Disposal failure never becomes a successful receipt. */ });
  writeFileSync("/evidence/cleanup-prepared.json", JSON.stringify({ pid: process.pid, uid: 1000, pendingCertificate: true }), { mode: 0o600 });
  // No JS turn/await occurs between starting close and environment disposal.
  // Absence of the marker is observed scope, not a universal finalizer proof.
  process.exit(0);
}

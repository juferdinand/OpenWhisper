/** Inert source-review fixture. Only an approved private utility may invoke it. */
import assert from "node:assert/strict";
import { access, readdir, readlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { BusFailure, LinuxBus, parseSessionBusAddress, type BusMethod } from "../../src/platforms/linux/shared/bus.js";
import { safeFailure, type Failure } from "../owned-bus-opening/diagnostics.js";
import { asyncCallChecks, asyncCallDiagnosisSchema, asyncCallResultSchema } from "./contracts.js";

type Outcome = { status: "fulfilled" } | { status: "rejected"; error: unknown };
function observe(task: Promise<unknown>): Promise<Outcome> {
  return task.then<Outcome, Outcome>(() => ({ status: "fulfilled" }), (error: unknown) => ({ status: "rejected", error }));
}
function heldMethod(owner: string): BusMethod {
  return { destination: owner, path: "/owned", interface: "org.openwhisper.Owned", member: "Hold",
    inputSignature: "", outputSignature: "", body: [], timeoutMs: 3000 };
}
async function ownedMemfds(): Promise<number> {
  let count = 0;
  for (const file of await readdir("/proc/self/fd")) {
    try { if ((await readlink(`/proc/self/fd/${file}`)).includes("memfd:owned-")) count++; }
    catch { /* An owned descriptor may close during enumeration. */ }
  }
  return count;
}

export async function runOwnedAsyncCallScenarios(binding: unknown, explicitAddress: unknown): Promise<unknown> {
  assert.equal(process.getuid?.(), 1000); await access("/.dockerenv");
  assert.equal(process.env.OPENWHISPER_OWNED_BUS_TEST, "1");
  assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
  assert.ok(typeof Reflect.get(process, "parentPort") === "object");
  for (const path of ["/dev/input", "/dev/uinput", "/dev/snd", "/dev/dri"]) await assert.rejects(access(path));
  const address = parseSessionBusAddress(explicitAddress);
  assert.match(address, /^unix:path=\/tmp\/openwhisper-owned-bus(?:,guid=[a-f0-9]{32})?$/);
  const checks: string[] = [];
  let bus = await LinuxBus.open(binding, address);
  const cancellation = new AbortController();
  let progressPending: Promise<Outcome> | undefined;
  const pending: Promise<Outcome>[] = [];
  let operationFailure: Failure | null = null;
  let cleanupFailure: Failure | null = null;
  try {
    const owner = await bus.owner("org.openwhisper.Owned.Test");
    let settled = false;
    progressPending = observe(bus.call(heldMethod(owner), cancellation.signal));
    void progressPending.then(() => { settled = true; });
    // The fixed native service withholds Hold. A genuine daemon UID lookup must
    // complete before Hold settles with this same one-worker runtime.
    assert.equal(await bus.uid(owner), 1000); assert.equal(settled, false);
    cancellation.abort(); const refused = await progressPending;
    assert.equal(refused.status, "rejected");
    if (refused.status !== "rejected") throw new Error("Owned cancellation was not refused.");
    assert.ok(refused.error instanceof BusFailure); assert.equal(refused.error.code, "CANCELLED");
    checks.push(asyncCallChecks[0]);

    // A settled Promise is not a TSFN-finalization/cancellation-slot receipt.
    // Retire this connection, then burst on an empty generation using the
    // already pinned fixed-service owner, without another lookup before burst.
    const progressGeneration = bus.generation, progressClose = bus.close();
    assert.equal(bus.close(), progressClose); await progressClose;
    bus = await LinuxBus.open(binding, address); assert.notEqual(bus.generation, progressGeneration);
    for (let i = 0; i < 8; i++) pending.push(observe(bus.call(heldMethod(owner))));
    assert.throws(() => bus.call(heldMethod(owner)), (error: unknown) => error instanceof BusFailure && error.code === "INVALID_FRAME");
    const close = bus.close(); assert.equal(bus.close(), close); await close;
    for (const outcome of await Promise.all(pending)) {
      assert.equal(outcome.status, "rejected");
      if (outcome.status !== "rejected") throw new Error("Owned close unexpectedly delivered a result.");
      assert.ok(outcome.error instanceof BusFailure);
    }
    pending.length = 0; assert.equal(await ownedMemfds(), 0);
    const previous = bus.generation; bus = await LinuxBus.open(binding, address);
    assert.notEqual(bus.generation, previous);
    checks.push(asyncCallChecks[1]);

    pending.push(observe(bus.call({ destination: owner, path: "/owned", interface: "org.openwhisper.Owned", member: "Fd",
      inputSignature: "s", outputSignature: "h", body: [{ type: "s", value: "extra" }], timeoutMs: 3000 })));
    // This prevents JS receipt while the native response may arrive. The receipt
    // honestly covers native-wait OR queued-completion ownership, not an asserted
    // private GIO/TSFN scheduling stage without an independent witness.
    const until = performance.now() + 50; while (performance.now() < until) { /* Owned JS-turn hold. */ }
    const finalClose = bus.close(); assert.equal(bus.close(), finalClose); await finalClose;
    const fdOutcome = await pending[0]; assert.equal(fdOutcome?.status, "rejected");
    pending.length = 0; assert.equal(await ownedMemfds(), 0);
    checks.push(asyncCallChecks[2]);
    return asyncCallResultSchema.parse({ checks, oneWorker: true, progressWhilePending: true,
      outstandingAfterClose: 0, ownedMemfdsAfterClose: 0 });
  } catch (error: unknown) {
    operationFailure = safeFailure("SCENARIO", error); throw error;
  } finally {
    cancellation.abort();
    try {
      await bus.close();
      await Promise.allSettled([...(progressPending ? [progressPending] : []), ...pending]);
    } catch (error: unknown) { cleanupFailure = safeFailure("SCENARIO", error); }
    writeFileSync("/evidence/async-call-diagnosis.json", JSON.stringify(asyncCallDiagnosisSchema.parse({ checks,
      operationFailure, cleanupFailure })), { mode: 0o600 });
    if (cleanupFailure) throw new Error("Owned async-call cleanup refused.");
  }
}

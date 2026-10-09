/** Opt-in candidate utility only; no app/provider/CLI bootstrap. */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { Diagnosis, DiagnosticRefusal, EntryRequestHandler } from "../owned-bus-opening/diagnostics.js";
import { BusFailure, LinuxBus } from "../../src/platforms/linux/shared/bus.js";
import { asyncRequestSchema } from "./candidate-contracts.js";
import { runOwnedAsyncCallScenarios } from "./scenarios.js";

const raw: unknown = Reflect.get(process, "parentPort");
if (process.env.OPENWHISPER_OWNED_BUS_OPENING_TEST !== "1" || process.getuid?.() !== 1000 ||
    typeof raw !== "object" || raw === null) throw new Error("Explicit owned candidate utility required.");
const receive: unknown = Reflect.get(raw, "on"), send: unknown = Reflect.get(raw, "postMessage");
if (typeof receive !== "function" || typeof send !== "function") throw new Error("Invalid owned utility channel.");
function post(value: unknown): void {
  if (typeof send !== "function") throw new Error("Invalid owned utility channel."); Reflect.apply(send, raw, [value]);
}
const diagnosis = new Diagnosis((value) => { writeFileSync("/evidence/async-entry-diagnosis.json", JSON.stringify(value), { mode: 0o600 }); });
async function awaitService(binding: unknown, address: string): Promise<void> {
  const until = performance.now() + 5000;
  for (;;) {
    if (performance.now() >= until) throw new DiagnosticRefusal("TIMEOUT");
    const bus = await LinuxBus.open(binding, address);
    let ready = false;
    try {
      const owner = await bus.owner("org.openwhisper.Owned.Test");
      if (await bus.uid(owner) !== 1000) throw new DiagnosticRefusal("INVALID_RESULT"); ready = true;
    } catch (error: unknown) {
      if (!(error instanceof BusFailure) || error.code !== "REMOTE_ERROR") throw error;
    } finally { await bus.close(); }
    if (performance.now() >= until) throw new DiagnosticRefusal("TIMEOUT");
    if (ready) return;
    // Provider readiness only: each lookup's actual close certificate already
    // retired its holders. This delay never substitutes for TSFN finalization.
    await pause(Math.min(10, Math.max(1, until - performance.now())));
  }
}
const handler = new EntryRequestHandler(diagnosis,
  () => createRequire(import.meta.url)("/owned-app/dist/native/openwhisper_linux_bus.node"),
  async (request, native) => {
    if (request.command !== "run") throw new DiagnosticRefusal("INVALID_REQUEST");
    await awaitService(native, request.address);
    const result = await runOwnedAsyncCallScenarios(native, request.address);
    if (typeof result !== "object" || result === null) throw new DiagnosticRefusal("INVALID_RESULT");
    return { ...result, pid: process.pid, uid: process.getuid?.(), nativeApi: 8 };
  });
Reflect.apply(receive, raw, ["message", (event: { data: unknown }) => {
  const request = asyncRequestSchema.safeParse(event.data);
  if (!request.success) { post({ version: 1, id: null, command: "run", error: "INVALID_REQUEST" }); return; }
  void handler.handle(request.data).then((outcome) => {
    if (outcome.ok) post({ version: 1, id: outcome.id, command: "run", result: outcome.result });
    else post({ version: 1, id: outcome.id, command: "run", error: outcome.category });
  });
}]);
diagnosis.mark("READY_POSTED"); post({ version: 1, ready: true });

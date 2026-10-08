/** Test-only dedicated utility entry; not an application loader or CLI. */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { Diagnosis, EntryRequestHandler } from "./diagnostics.js";
import { runOwnedOpeningCleanupScenario, runOwnedOpeningScenarios } from "./scenarios.js";

const raw: unknown = Reflect.get(process, "parentPort");
if (process.env.OPENWHISPER_OWNED_BUS_OPENING_TEST !== "1" || process.getuid?.() !== 1000 ||
    typeof raw !== "object" || raw === null) throw new Error("Explicit owned utility is required.");
const receive: unknown = Reflect.get(raw, "on"), send: unknown = Reflect.get(raw, "postMessage");
if (typeof receive !== "function" || typeof send !== "function") throw new Error("Invalid owned utility channel.");
function post(value: unknown): void {
  if (typeof send !== "function") throw new Error("Invalid owned utility channel.");
  Reflect.apply(send, raw, [value]);
}
const diagnosis = new Diagnosis((value) => { writeFileSync("/evidence/opening-entry-diagnosis.json", JSON.stringify(value), { mode: 0o600 }); });
const handler = new EntryRequestHandler(diagnosis,
  () => createRequire(import.meta.url)("/owned-app/dist/native/openwhisper_linux_bus.node"),
  (request, native) => request.command === "cleanup"
    ? runOwnedOpeningCleanupScenario(native, request.address) : runOwnedOpeningScenarios(native, request.address));
Reflect.apply(receive, raw, ["message", (event: { data: unknown }) => {
  void handler.handle(event.data).then((outcome) => {
    if (outcome.ok) post({ version: 1, id: outcome.id, command: "run", result: outcome.result });
    else {
      writeFileSync("/evidence/opening-failure.json", JSON.stringify({ result: "FAIL", category: outcome.category }), { mode: 0o600 });
      post({ version: 1, id: outcome.id, command: "run", error: outcome.category });
    }
  });
}]);
diagnosis.mark("READY_POSTED");
post({ version: 1, ready: true });

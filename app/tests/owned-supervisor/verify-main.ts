import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLinuxProcfsReadProvider, parseLinuxProcStat } from "../../src/services/platform-lifecycle/process-retirement.js";
import { boundedJson } from "./files.js";
import { mainIdentitySchema, validateResult, FixtureError, NODE_SHA256 } from "./contract.js";
import { describe } from "./files.js";

/** Pure classification: generic exit/Z/UID changes do not retire a same-birth PID. */
export function classifyMainRetirement(original: unknown, observed: unknown): "absence" | "different-birth" | "reserved" {
  const expected = mainIdentitySchema.parse(original); if (observed === null) return "absence";
  const current = parseLinuxProcStat(observed); if (current.pid !== expected.pid) throw new FixtureError();
  return current.startTicks.toString() === expected.startTicks ? "reserved" : "different-birth";
}
export async function verifyOriginalMainRetired(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 1000 || process.execPath !== "/opt/node/bin/node" ||
    process.versions.node !== "24.21.0" || process.env.OPENWHISPER_OWNED_SUPERVISOR_CPU !== "1" ||
    (await describe(process.execPath)).sha256 !== NODE_SHA256) throw new FixtureError();
  const result = validateResult(await boundedJson("/evidence/result.json")), reader = createLinuxProcfsReadProvider();
  const signal = AbortSignal.timeout(8000), deadline = performance.now() + 8000;
  await reader.verify(signal);
  for (;;) {
    const observed = await reader.read(result.main.pid, "stat", 4096, signal), retiredBy = classifyMainRetirement(result.main, observed);
    if (performance.now() >= deadline || signal.aborted) throw new FixtureError();
    if (retiredBy !== "reserved") {
      await writeFile("/evidence/main-retirement.json", JSON.stringify({ status: "PASS", original: result.main, retiredBy,
        scope: "Read-only original main birth retirement after CLI completion; no admission/signal." }), { mode: 0o600 }); return;
    }
    await delay(20, undefined, { signal });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void verifyOriginalMainRetired().catch(() => { process.stderr.write("Original main retirement not established.\n"); process.exitCode = 1; });
}

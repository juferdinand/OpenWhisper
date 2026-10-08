import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createLinuxProcfsReadProvider, parseLinuxProcStat } from "../../src/services/process-retirement.js";
import { describe, boundedJson } from "../owned-supervisor/files.js";
import { validateResult, mainIdentitySchema, NODE_SHA256, RECORDING_ENVIRONMENT_KEY } from "./contracts.js";

// Same closed classification as the CPU fixture, without importing its CLI
// entry guard into this different bundled CLI (where import.meta is shared).
function classifyMainRetirement(original: unknown, observed: unknown): "absence" | "different-birth" | "reserved" {
  const expected = mainIdentitySchema.parse(original); if (observed === null) return "absence";
  const current = parseLinuxProcStat(observed); if (current.pid !== expected.pid) throw new Error("MAIN_RETIREMENT_FAILED");
  return current.startTicks.toString() === expected.startTicks ? "reserved" : "different-birth";
}

/** Separate ordinary Node read after the original Electron CLI close. */
export async function verifyOriginalMainRetired(): Promise<void> {
  if (process.platform !== "linux" || process.getuid?.() !== 1000 || process.execPath !== "/opt/node/bin/node" ||
    process.versions.node !== "24.21.0" || process.env[RECORDING_ENVIRONMENT_KEY] !== "1" ||
    (await describe(process.execPath)).sha256 !== NODE_SHA256) throw new Error("MAIN_RETIREMENT_FAILED");
  const result = validateResult(await boundedJson("/evidence/result.json", 512 * 1024));
  const reader = createLinuxProcfsReadProvider(), signal = AbortSignal.timeout(8000), until = performance.now() + 8000;
  await reader.verify(signal);
  for (;;) {
    const observed = await reader.read(result.main.pid, "stat", 4096, signal), retiredBy = classifyMainRetirement(result.main, observed);
    if (performance.now() >= until || signal.aborted) throw new Error("MAIN_RETIREMENT_FAILED");
    if (retiredBy !== "reserved") {
      await writeFile("/evidence/main-retirement.json", JSON.stringify({ status: "PASS", original: result.main, retiredBy,
        scope: "Original main birth only, after actual command close; no signal or admission." }), { mode: 0o600 }); return;
    }
    await delay(20, undefined, { signal });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void verifyOriginalMainRetired().catch(() => { process.stderr.write("Owned recording original main retirement failed.\n"); process.exitCode = 1; });
}

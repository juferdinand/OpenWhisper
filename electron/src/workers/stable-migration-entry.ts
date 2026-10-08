import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { stableMigrationReplySchema } from "../contracts/stable-migration.js";
import { resolveStableProfile, stableProfileInputSchema } from "../services/stable-profile.js";
import { migrateStableLinuxProfile, StableLinuxMigrationError } from "./stable-linux-migration.js";

if (isMainThread || !parentPort) throw new Error("Stable migration requires its owned worker.");
try {
  const options = stableProfileInputSchema.parse(workerData as unknown);
  if (options.platform !== "linux") throw new StableLinuxMigrationError("UNSAFE_SOURCE");
  const result = await migrateStableLinuxProfile(resolveStableProfile(options));
  parentPort.postMessage(stableMigrationReplySchema.parse({ ok: true, status: result.status, recoveryCount: result.recoveryCount }));
} catch (error: unknown) {
  parentPort.postMessage(stableMigrationReplySchema.parse({ ok: false,
    code: error instanceof StableLinuxMigrationError ? error.code : "STORAGE_FAILED" }));
  process.exitCode = 1;
} finally { parentPort.close(); }

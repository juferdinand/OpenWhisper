import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { stableMigrationReplySchema, StableMigrationError } from "../contracts/stable-migration.js";
import { resolveStableProfile, stableProfileInputSchema, stableMacosMigrationRequestSchema } from "../services/stable-profile.js";
import { migrateStableLinuxProfile, StableLinuxMigrationError } from "./stable-linux-migration.js";
import { migrateStableMacosProfile } from "./stable-macos-migration.js";

if (isMainThread || !parentPort) throw new Error("Stable migration requires its owned worker.");
try {
  let result: { status: "migrated" | "already-complete"; recoveryCount: number };
  if (process.platform === "darwin") {
    const request = stableMacosMigrationRequestSchema.parse(workerData as unknown);
    result = await migrateStableMacosProfile(resolveStableProfile(request.profile), request.context);
  } else {
    const options = stableProfileInputSchema.parse(workerData as unknown);
    if (options.platform !== "linux") throw new StableLinuxMigrationError("UNSAFE_SOURCE");
    result = await migrateStableLinuxProfile(resolveStableProfile(options));
  }
  parentPort.postMessage(stableMigrationReplySchema.parse({ ok: true, status: result.status, recoveryCount: result.recoveryCount }));
} catch (error: unknown) {
  parentPort.postMessage(stableMigrationReplySchema.parse({ ok: false,
    code: error instanceof StableMigrationError ? error.code : "STORAGE_FAILED" }));
  process.exitCode = 1;
} finally { parentPort.close(); }

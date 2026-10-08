import { Worker } from "node:worker_threads";
import { stableMigrationReplySchema, type StableMigrationReply } from "../contracts/stable-migration.js";
import { resolveStableProfile, stableProfileInputSchema, stableMacosMigrationRequestSchema, validateStableProfile, type StableProfile } from "../services/stable-profile.js";

/** Select only after the host's packaged stable identity is verified. Never runs in Dev bootstrap. */
export async function initializeStableLinuxProfile(options: unknown): Promise<StableProfile> {
  const input = stableProfileInputSchema.parse(options);
  if (process.platform !== "linux" || input.platform !== "linux") throw new Error("UNSAFE_SOURCE");
  const profile = resolveStableProfile(input);
  await runMigrationWorker(input);
  return validateStableProfile(profile);
}

/** The selected stable main supplies read-only hardware/login facts; the worker owns native snapshot admission. */
export async function initializeStableMacosProfile(options: unknown, context: unknown): Promise<StableProfile> {
  const input = stableProfileInputSchema.parse(options);
  if (process.platform !== "darwin" || input.platform !== "darwin") throw new Error("UNSAFE_SOURCE");
  const profile = resolveStableProfile(input);
  await runMigrationWorker(stableMacosMigrationRequestSchema.parse({ profile: input, context }));
  return validateStableProfile(profile);
}

async function runMigrationWorker(workerData: unknown): Promise<void> {
  // The worker resolves its own trusted profile; a serialized WeakMap capability is never accepted.
  const worker = new Worker(new URL("../workers/stable-migration-entry.js", import.meta.url), { workerData, execArgv: [] });
  await new Promise<void>((accept, reject) => {
    let reply: StableMigrationReply | undefined, failure: Error | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    const failed = (code: string): void => { failure ??= new Error(code); };
    worker.on("message", (message: unknown) => {
      const parsed = stableMigrationReplySchema.safeParse(message);
      if (reply || !parsed.success) {
        failed("INVALID_COMPLETION");
        void worker.terminate().catch(() => failed("STORAGE_FAILED"));
        return;
      }
      reply = parsed.data;
      if (!reply.ok) failed(reply.code);
      // Copying is duration-dependent. Bound retirement only after the worker's result.
      exitTimer = setTimeout(() => {
        failed("STORAGE_FAILED"); void worker.terminate().catch(() => failed("STORAGE_FAILED"));
      }, 5000);
    });
    worker.on("error", () => failed("STORAGE_FAILED"));
    worker.once("exit", (code) => {
      if (exitTimer) clearTimeout(exitTimer);
      if (!reply || !reply.ok || code !== 0 || failure) reject(failure ?? new Error("STORAGE_FAILED"));
      else accept();
    });
  });
}

import { app, utilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const readiness = z.strictObject({ version: z.literal(1), ready: z.literal(true) });
const resultSchema = z.strictObject({ version: z.literal(1), id: z.uuid(), command: z.literal("run"), result: z.unknown() });
export async function runBusProbe(): Promise<unknown> {
  if (!app.isReady() || process.getuid?.() !== 1000 || process.env.OPENWHISPER_OWNED_BUS_TEST !== "1") throw new Error("Owned ready app is required.");
  const env = { ...process.env };
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) delete env[key];
  const helper = utilityProcess.fork("/owned-app/tests/owned-bus/entry.mjs", [], {
    stdio: "ignore", execArgv: [], env, allowLoadingUnsignedLibraries: false, serviceName: "OpenWhisper Dev owned bus test",
    respondToAuthRequestsFromMainProcess: false,
  });
  const id = randomUUID(); let ownerPid: number | undefined;
  const exit = new Promise<void>((accept) => { helper.once("exit", () => { accept(); }); });
  try {
    const result = await new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => { reject(new Error("Owned bus helper deadline exceeded.")); }, 45_000);
      helper.once("spawn", () => { ownerPid = helper.pid; });
      helper.once("exit", () => { clearTimeout(timer); reject(new Error("Owned bus helper exited before result.")); });
      helper.on("message", (input: unknown) => {
        const ready = readiness.safeParse(input);
        if (ready.success) { helper.postMessage({ version: 1, id, command: "run" }); return; }
        const result = resultSchema.safeParse(input);
        if (!result.success || result.data.id !== id) { clearTimeout(timer); reject(new Error("Owned bus fixture returned a failure.")); return; }
        clearTimeout(timer); accept(result.data.result);
      });
    });
    const parsed = z.object({ checks: z.array(z.string()).min(10), uid: z.literal(1000), pid: z.int().positive(), nativeApi: z.literal(8) }).passthrough().parse(result);
    if (parsed.pid !== ownerPid) throw new Error("Unexpected utility owner.");
    helper.kill(); await Promise.race([exit, new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error("Owned helper did not exit.")); }, 8000); })]);
    return { result: "PASS", mainAlive: true, ...parsed,
      versions: { electron: process.versions.electron, node: process.versions.node, napi: process.versions.napi },
      scope: "Actual CPU-independent GDBus utility/private-bus transport. Utility itself is not an OS sandbox; outer container is isolated. No desktop services invoked." };
  } finally { helper.kill(); await Promise.race([exit, new Promise<void>((accept) => { setTimeout(accept, 8000); })]); }
}

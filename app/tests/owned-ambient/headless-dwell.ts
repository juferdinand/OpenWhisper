import { app } from "electron";
import { createRequire } from "node:module";
import { LinuxBus } from "../../src/platforms/linux/shared/bus.js";

// New owned diagnostic entry; the original successful no-dwell entry is retained unchanged.
if (process.env.OPENWHISPER_OWNED_AMBIENT_TEST !== "1" || process.getuid?.() !== 1000
  || process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
  || process.env.ELECTRON_RUN_AS_NODE !== undefined || app.commandLine.hasSwitch("no-sandbox")) throw new Error("Owned no-display diagnostic required.");
const controller = new AbortController(), timer = setTimeout(() => { controller.abort(); }, 2000), started = performance.now();
const ready: boolean[] = [app.isReady()];
const milestones: { stage: "entry" | "before-native" | "native-closed" | "dwell-complete"; monotonicUs: string; ready: boolean }[] = [];
const milestone = (stage: "entry" | "before-native" | "native-closed" | "dwell-complete"): void => {
  milestones.push({ stage, monotonicUs: (process.hrtime.bigint() / 1000n).toString(), ready: app.isReady() });
};
milestone("entry");
const dwell = async (): Promise<void> => {
  await new Promise<void>((accept) => { setTimeout(accept, 700); });
  ready.push(app.isReady()); if (controller.signal.aborted || ready.some(Boolean)) throw new Error("Owned early diagnostic expired or became ready.");
};
let bus: LinuxBus | undefined;
try {
  await dwell();
  milestone("before-native");
  const binding: unknown = createRequire(import.meta.url)("/owned-app/dist/native/openwhisper_linux_bus.node");
  bus = await LinuxBus.open(binding, process.env.OPENWHISPER_OWNED_ASYNC_BUS_ADDRESS, controller.signal);
  const reply = await bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus",
    member: "GetId", inputSignature: "", outputSignature: "s", body: [], timeoutMs: 500 }, controller.signal);
  const id = reply.body[0]; if (reply.body.length !== 1 || id?.type !== "s" || !/^[a-f0-9]{32}$/.test(id.value)) throw new Error("Invalid owned daemon identity.");
  await bus.close(); milestone("native-closed"); await dwell(); milestone("dwell-complete");
  process.stdout.write(JSON.stringify({ result: "PASS", readyBefore: ready[0], readyAfter: app.isReady(), ready,
    nativeAsyncGetId: true, busClosed: bus.isClosed, milestones, seconds: (performance.now() - started) / 1000,
    versions: { electron: process.versions.electron, node: process.versions.node, napi: process.versions.napi },
    scope: "Owned early ESM with bounded 1.4-second dwell and fixed native GetId; no production CLI." }) + "\n");
  app.exit(0);
} catch {
  await bus?.close().catch(() => undefined); process.stderr.write("OWNED_AMBIENT_FAILED\n"); app.exit(1);
} finally { clearTimeout(timer); }

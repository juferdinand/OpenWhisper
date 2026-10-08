import { app } from "electron";
import { createRequire } from "node:module";
import { LinuxBus } from "../../src/platforms/linux/shared/bus.js";

// Owned feasibility fixture only. The production worker-only loader is unchanged.
if (process.env.OPENWHISPER_OWNED_ASYNC_CLI_TEST !== "1" || process.getuid?.() !== 1000
  || process.env.DISPLAY !== undefined || process.env.WAYLAND_DISPLAY !== undefined
  || process.env.ELECTRON_RUN_AS_NODE !== undefined || app.commandLine.hasSwitch("no-sandbox")) {
  throw new Error("Owned no-display fixture required.");
}
const controller = new AbortController();
const timer = setTimeout(() => { controller.abort(); }, 2000);
const started = performance.now();
let bus: LinuxBus | undefined;
try {
  const readyBefore = app.isReady();
  if (readyBefore) throw new Error("Unexpected readiness.");
  const binding: unknown = createRequire(import.meta.url)("/owned-app/dist/native/openwhisper_linux_bus.node");
  bus = await LinuxBus.open(binding, process.env.OPENWHISPER_OWNED_ASYNC_BUS_ADDRESS, controller.signal);
  const reply = await bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
    interface: "org.freedesktop.DBus", member: "GetId", inputSignature: "", outputSignature: "s",
    body: [], timeoutMs: 1500 }, controller.signal);
  const value = reply.body[0];
  if (reply.body.length !== 1 || value?.type !== "s" || !/^[a-f0-9]{32}$/.test(value.value)) throw new Error("Invalid owned daemon ID.");
  await bus.close();
  if (controller.signal.aborted || app.isReady()) throw new Error("Unexpected readiness or expiry.");
  process.stdout.write(JSON.stringify({ result: "PASS", readyBefore, readyAfter: app.isReady(),
    nativeAsyncGetId: true, busClosed: bus.isClosed, seconds: (performance.now() - started) / 1000,
    versions: { electron: process.versions.electron, node: process.versions.node, napi: process.versions.napi },
    scope: "Owned ESM top-level await native bus feasibility before graphical readiness; no control action or production CLI." }) + "\n");
  app.exit(0);
} catch {
  await bus?.close().catch(() => undefined);
  process.stderr.write("HEADLESS_ASYNC_FAILED\n"); app.exit(1);
} finally { clearTimeout(timer); }

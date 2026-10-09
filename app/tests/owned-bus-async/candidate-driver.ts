/** Container-only fixture driver, launched solely by the reviewed Docker launcher. */
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { EXECUTION_MS, PARENT_CLEANUP_MS, UTILITY_CLEANUP_MS } from "../owned-bus-opening/launch-contracts.js";
import { awaitNonRunning, bindBirth } from "../owned-bus-opening/process-witness.js";

import { candidateProfileSchema as profileSchema } from "./candidate-contracts.js";

if (process.env.OPENWHISPER_OWNED_BUS_OPENING_DRIVER !== "1" || process.getuid?.() !== 1000 || process.argv.length !== 3) throw new Error("Explicit owned driver required.");
const profile = profileSchema.parse(process.argv[2]); await access("/.dockerenv");
// Profiles run serially only after the prior owner/parent disposal gates. This
// fixed private path cannot belong to any host/session through the launcher.
await rm("/tmp/openwhisper-owned-bus", { force: true });
for (const path of ["/dev/input", "/dev/uinput", "/dev/snd", "/dev/dri"]) {
  try { await access(path); throw new Error("Unexpected owned device."); }
  catch (error: unknown) { if (!(typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT")) throw error; }
}
const root = await mkdtemp("/tmp/openwhisper-owned-opening-driver-"); await chmod(root, 0o700);
for (const path of ["home", "runtime", "config", "data", "cache"]) await mkdir(join(root, path), { mode: 0o700 });
const env = { PATH: "/opt/node/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"),
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/disabled-session`, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${root}/disabled-system`,
  PULSE_SERVER: `unix:${root}/disabled-pulse`, PIPEWIRE_RUNTIME_DIR: join(root, "runtime"), PIPEWIRE_REMOTE: "disabled-pipewire",
  LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe", UV_THREADPOOL_SIZE: "1", OPENWHISPER_OWNED_BUS_OPENING_TEST: "1" };
const xvfb = spawn("/usr/bin/Xvfb", ["-displayfd", "3", "-screen", "0", "800x600x24", "-nolisten", "tcp"], { env, stdio: ["ignore", "ignore", "ignore", "pipe"] });
let parent: ChildProcess | undefined;
let succeeded = false;
async function retire(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid; if (!pid) throw new Error("Missing owned child PID.");
  const birth = await bindBirth(pid, process.pid); child.kill("SIGTERM");
  const force = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
  try { await awaitNonRunning(birth, PARENT_CLEANUP_MS); } finally { clearTimeout(force); }
}
try {
  const display = await new Promise<string>((accept, reject) => {
    let bytes = ""; const timer = setTimeout(() => reject(new Error("Owned display readiness expired.")), 5000);
    xvfb.once("error", reject); xvfb.once("exit", () => reject(new Error("Owned display exited before readiness.")));
    xvfb.stdio[3]?.on("data", (value: Buffer) => {
      bytes += value.toString(); if (bytes.length > 32) { clearTimeout(timer); reject(new Error("Owned display metadata exceeded its bound.")); }
      else if (/^[0-9]+\n$/u.test(bytes)) { clearTimeout(timer); accept(`:${bytes.trim()}`); }
    });
  });
  parent = spawn("/owned-app/runtime/electron", ["/owned-app/opening-parent", "--profile", profile], {
    env: { ...env, DISPLAY: display }, stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnosticBytes = 0, diagnosticOverflow = false;
  parent.stderr?.on("data", (bytes: Buffer) => { diagnosticBytes += bytes.length; if (diagnosticBytes > 32768) { diagnosticOverflow = true; parent?.kill("SIGTERM"); } });
  const pid = parent.pid; if (!pid) throw new Error("Missing owned parent PID.");
  const birth = await bindBirth(pid, process.pid); const start = performance.now();
  const bound = EXECUTION_MS + UTILITY_CLEANUP_MS + PARENT_CLEANUP_MS;
  while (parent.exitCode === null && parent.signalCode === null) {
    if (performance.now() - start >= bound) throw new Error("Owned profile and cleanup bounds exceeded.");
    await pause(10);
  }
  const witness = await awaitNonRunning(birth, PARENT_CLEANUP_MS);
  const result = z.object({ result: z.literal("PASS"), profile: z.literal(profile), cleanupConfirmed: z.literal(true) }).parse(JSON.parse(await readFile(`/evidence/${profile}-parent.json`, "utf8")));
  if (parent.exitCode !== 0 || diagnosticOverflow) throw new Error("Owned parent exited unsuccessfully.");
  await writeFile(`/evidence/${profile}-driver.json`, JSON.stringify({ ...result, birth, witness, diagnosticBytes,
    profileAndCleanupBoundMs: bound, elapsedMs: performance.now() - start }, null, 2), { mode: 0o600 });
  succeeded = true;
} finally {
  if (parent) await retire(parent); await retire(xvfb);
  await writeFile(`/evidence/${profile}-driver-final.json`, JSON.stringify({ result: succeeded ? "PASS" : "FAIL", profile }), { mode: 0o600 });
}

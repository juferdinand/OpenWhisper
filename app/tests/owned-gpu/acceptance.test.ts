import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication } from "@playwright/test";
import { ownedGpuInputSchema, ownedGpuResultSchema } from "./contract.js";

const enabled = process.env.OPENWHISPER_OWNED_GPU_TEST === "1";
const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
async function absent(path: string): Promise<boolean> {
  try { await access(path); return false; } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

test("owned Electron utility exercises the explicit native backend fixture mode", { skip: !enabled, timeout: 300_000 }, async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 1000);
  assert.equal(await absent("/.dockerenv"), false);
  for (const path of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) assert.equal(await absent(path), true);
  assert.equal(process.env.OPENWHISPER_GPU_EVIDENCE, "/evidence");
  const input = ownedGpuInputSchema.parse(JSON.parse(await readFile("/fixtures/backend-input.json", "utf8")));
  const root = await mkdtemp("/tmp/openwhisper-owned-gpu-"); await chmod(root, 0o700);
  const home = join(root, "home"), runtime = join(root, "runtime");
  for (const path of [home, runtime, join(home, "config"), join(home, "data"), join(home, "cache")]) await mkdir(path, { mode: 0o700 });
  const environment: Record<string, string> = {
    PATH: "/opt/node/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/disabled-session-bus`, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime}/disabled-system-bus`,
    PULSE_SERVER: `unix:${runtime}/disabled-pulse`, PIPEWIRE_RUNTIME_DIR: runtime, PIPEWIRE_REMOTE: "disabled-pipewire",
    XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "Owned X11", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe",
    VK_ICD_FILENAMES: input.mode === "software-only" ? "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json" : "/fixtures/no-device.json",
  };
  const xvfb = spawn("/usr/bin/Xvfb", ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
    env: environment, stdio: ["ignore", "ignore", "ignore", "pipe"],
  });
  let application: ElectronApplication | undefined;
  try {
    environment.DISPLAY = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Private display readiness failed.")), 10_000);
      let output = "";
      xvfb.once("error", (error) => { clearTimeout(timer); reject(error); });
      xvfb.once("exit", () => { clearTimeout(timer); reject(new Error("Private display exited.")); });
      const pipe = xvfb.stdio[3]; assert.ok(pipe && "on" in pipe);
      pipe.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (/^\d+\n$/u.test(output)) { clearTimeout(timer); accept(`:${output.trim()}`); }
        else if (output.length > 32) { clearTimeout(timer); reject(new Error("Invalid private display response.")); }
      });
    });
    application = await _electron.launch({ executablePath: join(packageRoot, "node_modules/electron/dist/electron"),
      args: [packageRoot, "--dev", "--dev-profile", join(root, "dev-profile")], env: environment, chromiumSandbox: true, timeout: 30_000 });
    const page = await application.firstWindow(); await page.waitForURL("app://openwhisper/index.html");
    const sandbox = await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; if (!window) throw new Error("Missing owned Dev window.");
      const getPreferences: unknown = Reflect.get(window.webContents, "getLastWebPreferences");
      if (typeof getPreferences !== "function") throw new Error("Missing preference probe.");
      const preferences: unknown = Reflect.apply(getPreferences, window.webContents, []);
      if (typeof preferences !== "object" || preferences === null) throw new Error("Invalid preference probe.");
      const pid = window.webContents.getOSProcessId();
      const fs = process.getBuiltinModule("fs").promises;
      return { sandbox: Reflect.get(preferences, "sandbox"), contextIsolation: Reflect.get(preferences, "contextIsolation"),
        nodeIntegration: Reflect.get(preferences, "nodeIntegration"), pid,
        status: await fs.readFile(`/proc/${pid}/status`, "utf8"), cmdline: await fs.readFile(`/proc/${pid}/cmdline`, "utf8") };
    });
    assert.equal(sandbox.sandbox, true); assert.equal(sandbox.contextIsolation, true); assert.equal(sandbox.nodeIntegration, false);
    assert.equal(sandbox.cmdline.includes("--no-sandbox"), false);
    assert.match(sandbox.status, /^CapEff:\s+0+$/m); assert.match(sandbox.status, /^NoNewPrivs:\s+1$/m); assert.match(sandbox.status, /^Seccomp:\s+2$/m);
    const started = performance.now();
    const output: unknown = await application.evaluate(async () => {
      const load = process.getBuiltinModule("module").createRequire("file:///owned-app/tests/owned-gpu/probe.mjs");
      const imported: unknown = load("/owned-app/tests/owned-gpu/probe.mjs");
      if (typeof imported !== "object" || imported === null) throw new Error("Invalid owned probe.");
      const execute: unknown = Reflect.get(imported, "runOwnedGpuProbe");
      if (typeof execute !== "function") throw new Error("Missing owned probe entry point.");
      const result: unknown = await Reflect.apply(execute, undefined, []); return result;
    });
    const result = ownedGpuResultSchema.parse(output); assert.equal(result.mode, input.mode);
    assert.equal(await page.evaluate(() => document.title), "OpenWhisper");
    await writeFile("/evidence/gpu-result.json", JSON.stringify({ ...result, seconds: (performance.now() - started) / 1000, sandbox }, null, 2), { mode: 0o600 });
    await page.screenshot({ path: "/evidence/gpu-main-alive.png" });
  } finally { await application?.close(); xvfb.kill("SIGTERM"); }
});

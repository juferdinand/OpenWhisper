import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { z } from "zod";

const enabled = process.env.OPENWHISPER_OWNED_SPEECH_TEST === "1";
const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

async function absent(path: string): Promise<boolean> {
  try { await access(path); return false; } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

/** Opt-in only. The launcher copies inputs, never mounts a host session or device. */
test("owned Electron utility process contains native ABI, failure and watchdog boundaries", {
  skip: !enabled, timeout: 180_000,
}, async () => {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid?.(), 1000);
  assert.equal(await absent("/.dockerenv"), false);
  for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) assert.equal(await absent(device), true);
  assert.equal(process.env.OPENWHISPER_SPEECH_EVIDENCE, "/evidence");
  const mode = z.enum(["abi", "cpu"]).parse(process.env.OPENWHISPER_SPEECH_MODE);
  const root = await mkdtemp("/tmp/openwhisper-owned-speech-");
  await chmod(root, 0o700);
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  for (const path of [home, runtime, join(home, "config"), join(home, "data"), join(home, "cache")]) await mkdir(path, { mode: 0o700 });
  const environment: Record<string, string> = {
    PATH: "/opt/node/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/disabled-session-bus`, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime}/disabled-system-bus`,
    PULSE_SERVER: `unix:${runtime}/disabled-pulse`, PIPEWIRE_RUNTIME_DIR: runtime, PIPEWIRE_REMOTE: "disabled-pipewire",
    XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "Owned X11", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe",
  };
  const xvfb = spawn("/usr/bin/Xvfb", ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
    env: environment, stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let application: ElectronApplication | undefined;
  try {
    environment.DISPLAY = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Private display readiness failed.")), 10_000);
      let output = "";
      xvfb.once("error", reject);
      xvfb.once("exit", () => reject(new Error("Private display exited before readiness.")));
      const pipe = xvfb.stdio[3];
      assert.ok(pipe && "on" in pipe);
      pipe.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (/^\d+\n$/.test(output)) { clearTimeout(timer); accept(`:${output.trim()}`); }
      });
    });
    application = await _electron.launch({
      executablePath: join(packageRoot, "node_modules/electron/dist/electron"),
      args: [packageRoot, "--dev", "--dev-profile", join(root, "dev-profile")],
      env: environment, chromiumSandbox: true, timeout: 30_000,
    });
    const page = await application.firstWindow();
    await page.waitForURL("app://openwhisper/index.html");
    const sandbox = await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Missing owned Dev window.");
      const getPreferences: unknown = Reflect.get(window.webContents, "getLastWebPreferences");
      if (typeof getPreferences !== "function") throw new Error("Missing preference probe.");
      const preferences: unknown = Reflect.apply(getPreferences, window.webContents, []);
      if (typeof preferences !== "object" || preferences === null) throw new Error("Invalid preference probe.");
      const rendererPid = window.webContents.getOSProcessId();
      const filesystem = process.getBuiltinModule("fs").promises;
      const status = await filesystem.readFile(`/proc/${rendererPid}/status`, "utf8");
      const cmdline = await filesystem.readFile(`/proc/${rendererPid}/cmdline`, "utf8");
      return { sandbox: Reflect.get(preferences, "sandbox"), contextIsolation: Reflect.get(preferences, "contextIsolation"),
        nodeIntegration: Reflect.get(preferences, "nodeIntegration"), rendererPid, status, cmdline };
    });
    assert.equal(sandbox.sandbox, true);
    assert.equal(sandbox.contextIsolation, true);
    assert.equal(sandbox.nodeIntegration, false);
    assert.equal(sandbox.cmdline.includes("--no-sandbox"), false);
    assert.match(sandbox.status, /^CapEff:\s+0+$/m);
    assert.match(sandbox.status, /^NoNewPrivs:\s+1$/m);
    assert.match(sandbox.status, /^Seccomp:\s+2$/m);
    const start = performance.now();
    const result: unknown = await application.evaluate(async (_electron, selectedMode) => {
      const load = process.getBuiltinModule("module").createRequire("file:///owned-app/tests/owned-speech/probe.mjs");
      const imported: unknown = load("/owned-app/tests/owned-speech/probe.mjs");
      if (typeof imported !== "object" || imported === null) throw new Error("Invalid owned probe module.");
      const execute: unknown = Reflect.get(imported, "runUtilityProbe");
      if (typeof execute !== "function") throw new Error("Missing owned probe entry point.");
      const output: unknown = await Reflect.apply(execute, undefined, [selectedMode]);
      return output;
    }, mode);
    const parsed = z.object({ result: z.literal(mode === "abi" ? "ABI_LOAD_FAILED_CONTAINED" : "PASS"), mainAlive: z.literal(true),
      checks: z.array(z.string()).min(1), versions: z.record(z.string(), z.string()) }).passthrough().parse(result);
    await writeFile(`/evidence/${mode}-result.json`, JSON.stringify({ ...parsed, seconds: (performance.now() - start) / 1000,
      sandbox, scope: "Owned Electron utility/CPU speech probe; utility itself is not an OS sandbox. No microphone or desktop parity claim." }, null, 2), { mode: 0o600 });
    assert.equal(await page.evaluate(() => document.title), "OpenWhisper");
    const processId = application.process().pid;
    assert.ok(processId);
    const mainStatus = await readFile(`/proc/${processId}/status`, "utf8");
    assert.match(mainStatus, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m);
    await page.screenshot({ path: `/evidence/${mode}-main-alive.png` });
  } finally {
    await application?.close();
    xvfb.kill("SIGTERM");
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron, type ElectronApplication } from "@playwright/test";
import { z } from "zod";
import { fetchParakeetFixture, PARAKEET_FIXTURE } from "../scripts/fetch-parakeet-fixture.js";

test("public Parakeet downloader refuses relative or existing destinations without touching them", async () => {
  await assert.rejects(fetchParakeetFixture("relative-model-cache"), /absolute new/);
  const root = await mkdtemp("/tmp/openwhisper-parakeet-download-guard-");
  const marker = join(root, "existing-data");
  await writeFile(marker, "preserved 日本語 👩‍💻");
  await assert.rejects(fetchParakeetFixture(root), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "EEXIST");
  assert.equal(await readFile(marker, "utf8"), "preserved 日本語 👩‍💻");
});

test("public Parakeet downloader rejects unrelated redirects and oversized stream chunks", async (context) => {
  const redirectRoot = await mkdtemp("/tmp/openwhisper-parakeet-redirect-guard-");
  const replacement = context.mock.method(globalThis, "fetch", async () => new Response(null, {
    status: 302, headers: { location: "https://unrelated.example/weights" },
  }));
  await assert.rejects(fetchParakeetFixture(join(redirectRoot, "fresh")), /download failed/);
  assert.equal(replacement.mock.calls.length, 1);
  replacement.mock.restore();
  const streamRoot = await mkdtemp("/tmp/openwhisper-parakeet-stream-guard-");
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); controller.close();
  } }), { headers: { "content-length": String(PARAKEET_FIXTURE.bytes) } }));
  const target = join(streamRoot, "fresh");
  await assert.rejects(fetchParakeetFixture(target), /download failed/);
  await assert.rejects(access(join(target, "model.partial")));
  await assert.rejects(access(join(target, PARAKEET_FIXTURE.filename)));
});

const enabled = process.env.OPENWHISPER_OWNED_PARAKEET_TEST === "1";
const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
async function absent(path: string): Promise<boolean> {
  try { await access(path); return false; } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

/** Actual Electron/native test runs only inside the immutable private owned container. */
test("owned Electron utility recognizes genuine Parakeet Q4_0 and postprocesses without a native prompt", {
  skip: !enabled, timeout: 410_000,
}, async () => {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid?.(), 1000);
  assert.equal(await absent("/.dockerenv"), false);
  for (const path of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) assert.equal(await absent(path), true);
  assert.equal(process.env.OPENWHISPER_PARAKEET_EVIDENCE, "/evidence");
  const root = await mkdtemp("/tmp/openwhisper-owned-parakeet-");
  await chmod(root, 0o700);
  const home = join(root, "home"), runtime = join(root, "runtime");
  for (const path of [home, runtime, join(home, "config"), join(home, "data"), join(home, "cache")]) await mkdir(path, { mode: 0o700 });
  const environment: Record<string, string> = {
    PATH: "/opt/node/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/disabled-session-bus`, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${runtime}/disabled-system-bus`,
    PULSE_SERVER: `unix:${runtime}/disabled-pulse`, PIPEWIRE_RUNTIME_DIR: runtime, PIPEWIRE_REMOTE: "disabled-pipewire",
    XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "Owned X11", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe",
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
      const pipe = xvfb.stdio[3];
      assert.ok(pipe && "on" in pipe);
      pipe.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (/^\d+\n$/.test(output)) { clearTimeout(timer); accept(`:${output.trim()}`); }
        else if (output.length > 32) { clearTimeout(timer); reject(new Error("Invalid private display response.")); }
      });
    });
    application = await _electron.launch({ executablePath: join(packageRoot, "node_modules/electron/dist/electron"),
      args: [packageRoot, "--dev", "--dev-profile", join(root, "dev-profile")], env: environment,
      chromiumSandbox: true, timeout: 30_000 });
    const page = await application.firstWindow();
    await page.waitForURL("app://openwhisper/index.html");
    const sandbox = await application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("Missing owned Dev window.");
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
    const start = performance.now();
    const output: unknown = await application.evaluate(async () => {
      const load = process.getBuiltinModule("module").createRequire("file:///owned-app/tests/owned-parakeet/probe.mjs");
      const imported: unknown = load("/owned-app/tests/owned-parakeet/probe.mjs");
      if (typeof imported !== "object" || imported === null) throw new Error("Invalid owned probe.");
      const execute: unknown = Reflect.get(imported, "runParakeetProbe");
      if (typeof execute !== "function") throw new Error("Missing owned probe entry point.");
      const result: unknown = await Reflect.apply(execute, undefined, []);
      return result;
    });
    const ownerSchema = z.strictObject({ pid: z.number().int().positive(), creationTime: z.number().finite().positive() });
    const parsed = z.strictObject({ result: z.literal("PASS"), mainAlive: z.literal(true), checks: z.array(z.string()).length(5),
      original: ownerSchema, replacement: ownerSchema, processed: z.strictObject({ version: z.literal(1), id: z.string().uuid(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/), characters: z.number().int().positive(), vocabularyThenSnippet: z.literal(true),
        cleanupApplied: z.literal(true), pid: z.number().int().positive(), nativeLoaded: z.literal(false) }),
      transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/), transcriptCharacters: z.number().int().positive(),
      sampleCount: z.literal(176_000), timings: z.array(z.number().finite().nonnegative()).length(3),
      versions: z.record(z.string(), z.string()), scope: z.string(),
    }).parse(output);
    assert.equal(await page.evaluate(() => document.title), "OpenWhisper");
    await writeFile("/evidence/parakeet-result.json", JSON.stringify({ ...parsed, seconds: (performance.now() - start) / 1000, sandbox }, null, 2), { mode: 0o600 });
    await page.screenshot({ path: "/evidence/parakeet-main-alive.png" });
  } finally {
    await application?.close(); xvfb.kill("SIGTERM");
  }
});

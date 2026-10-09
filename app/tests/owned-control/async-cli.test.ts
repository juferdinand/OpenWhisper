import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

const enabled = process.env.OPENWHISPER_OWNED_ASYNC_CLI_TEST === "1";
async function absent(path: string): Promise<boolean> {
  try { await access(path); return false; }
  catch (error: unknown) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true; throw error; }
}
async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((accept) => { child.once("close", () => { accept(); }); });
  child.kill("SIGTERM"); const force = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("Owned child cleanup was not confirmed.")); }, 5000); });
  try { await Promise.race([exit, bound]); } finally { clearTimeout(force); if (timer) clearTimeout(timer); }
}

test("owned Electron ESM finishes one asynchronous native bus round trip before graphical readiness", {
  skip: !enabled, timeout: 20_000,
}, async () => {
  assert.equal(process.getuid?.(), 1000); assert.equal(await absent("/.dockerenv"), false);
  for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) assert.equal(await absent(device), true);
  assert.equal(process.env.OPENWHISPER_ASYNC_CLI_EVIDENCE, "/evidence");
  const root = await mkdtemp("/tmp/openwhisper-owned-async-"); await chmod(root, 0o700);
  for (const directory of ["home", "runtime", "config", "data", "cache"]) await mkdir(join(root, directory), { mode: 0o700 });
  const env: Record<string, string> = { PATH: "/opt/node/bin:/usr/bin:/bin", HOME: join(root, "home"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/disabled-session-bus`, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${root}/disabled-system-bus`,
    PULSE_SERVER: `unix:${root}/disabled-pulse`, PIPEWIRE_RUNTIME_DIR: join(root, "runtime"), PIPEWIRE_REMOTE: "disabled-pipewire",
    OPENWHISPER_OWNED_ASYNC_CLI_TEST: "1" };
  const socket = join(root, "runtime", "bus"), config = join(root, "bus.conf");
  await writeFile(config, `<busconfig><type>session</type><listen>unix:path=${socket}</listen><auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`, { mode: 0o600 });
  const daemon = spawn("/usr/bin/dbus-daemon", [`--config-file=${config}`, "--nofork", "--print-address=1"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let child: ChildProcess | undefined;
  try {
    const address = await new Promise<string>((accept, reject) => {
      let output = ""; const timer = setTimeout(() => { reject(new Error("Owned bus readiness expired.")); }, 2000);
      daemon.once("error", reject); daemon.once("exit", () => { reject(new Error("Owned bus exited before readiness.")); });
      daemon.stdout?.on("data", (bytes: Buffer) => {
        output += bytes.toString(); if (output.length > 2048) { reject(new Error("Owned bus address exceeded its bound.")); return; }
        if (output.endsWith("\n")) { clearTimeout(timer); accept(output.trim()); }
      });
    });
    assert.match(address, new RegExp(`^unix:path=${socket},guid=[a-f0-9]{32}$`));
    env.OPENWHISPER_OWNED_ASYNC_BUS_ADDRESS = address;
    const executable = "/owned-app/node_modules/electron/dist/electron", bytes = await readFile(executable);
    const sha = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha, "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564");
    const marker = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), index = bytes.indexOf(marker);
    assert.ok(index >= 0); assert.equal(bytes.indexOf(marker, index + 1), -1);
    const start = index + marker.length, version = bytes[start], length = bytes[start + 1];
    assert.equal(version, 1); assert.equal(length, 9); const fuses = [...bytes.subarray(start + 2, start + 11)];
    const argv = ["/owned-app/tests/owned-control/async-cli-package"];
    const started = performance.now(); child = spawn(executable, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", force: NodeJS.Timeout | undefined, expired = false;
    const owner = child;
    const timer = setTimeout(() => { expired = true; owner.kill("SIGTERM"); force = setTimeout(() => { owner.kill("SIGKILL"); }, 1000); }, 8000);
    child.stdout?.on("data", (block: Buffer) => { stdout += block.toString(); if (stdout.length > 16384) owner.kill("SIGTERM"); });
    child.stderr?.on("data", (block: Buffer) => { stderr += block.toString(); if (stderr.length > 16384) owner.kill("SIGTERM"); });
    const exit = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
      owner.once("error", reject); owner.once("close", (code, signal) => { accept({ code, signal }); });
    }).finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
    await writeFile("/evidence/async-cli-result.json", JSON.stringify({ ...exit, expired, seconds: (performance.now() - started) / 1000,
      stdout, stderr, executableSha256: sha, argv, fuses, environment: { display: false, waylandDisplay: false, runtimeOverrides: false },
      scope: "One native GetId/close before ready, unchanged upstream fuses; not final packaged CLI support." }, null, 2), { mode: 0o600 });
    assert.equal(expired, false); assert.equal(exit.signal, null); assert.equal(exit.code, 0);
    const result = z.object({ result: z.literal("PASS"), readyBefore: z.literal(false), readyAfter: z.literal(false),
      nativeAsyncGetId: z.literal(true), busClosed: z.literal(true), seconds: z.number().nonnegative() }).passthrough().parse(JSON.parse(stdout));
    assert.ok(result.seconds < 2); assert.equal(stderr.includes("Missing X server"), false);
  } finally { if (child) await reap(child); await reap(daemon); }
});

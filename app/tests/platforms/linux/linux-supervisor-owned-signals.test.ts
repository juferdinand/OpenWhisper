import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { runLinuxSupervisor } from "../../../src/cli/linux-supervisor.js";
import { LINUX_RESTART_NONCE } from "../../../src/main/linux-restart.js";
import type { LinuxInstalledLaunch } from "../../../src/main/linux-installed-launch.js";

const script = fileURLToPath(import.meta.url), appRoot = resolveAppRoot(script);
const launch: LinuxInstalledLaunch = { kind: "debian", executable: "/opt/openwhisper/openwhisper", arguments: [] };
function resolveAppRoot(path: string): string { return dirname(dirname(dirname(dirname(path)))); }
function environment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "C.UTF-8" };
}
function writeMarker(path: string, value: string): void { writeFileSync(path, value, { mode: 0o600 }); }
async function waitForJson(path: string): Promise<Record<string, number>> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")) as Record<string, number>; }
    catch { await new Promise((accept) => setTimeout(accept, 10)); }
  }
  throw new Error("Owned supervisor fixture did not report its process owners.");
}
async function processRunning(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
    return stat.slice(end + 2, end + 3) !== "Z";
  } catch { return false; }
}
async function processStart(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")");
    return stat.slice(end + 2).trim().split(/\s+/u)[19];
  } catch { return undefined; }
}
async function closeWithin(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((accept) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.off("close", onClose); child.off("error", onError); accept(closed);
    };
    const onClose = (): void => finish(true), onError = (): void => finish(false);
    const timer = setTimeout(() => finish(false), milliseconds);
    child.once("close", onClose); child.once("error", onError);
  });
}
async function waitUntilGone(pids: readonly number[]): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (!(await Promise.all(pids.map(processRunning))).some(Boolean)) return;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  assert.fail("The owned GUI process group survived bounded signal cleanup.");
}
async function childMain(mode: string, root: string): Promise<void> {
  if (mode === "grandchild" || mode === "sibling") {
    if (mode === "grandchild") process.on("SIGTERM", () => {});
    writeMarker(join(root, `${mode}.json`), JSON.stringify({ pid: process.pid }));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode !== "owned-gui" && mode !== "supervisor") throw new Error("Unknown owned fixture mode.");
  if (mode === "owned-gui") {
    process.on("SIGTERM", () => {});
    const descendant = spawn(process.execPath, ["--import", "tsx", script, "grandchild", root], {
      cwd: appRoot, detached: false, env: environment(root), stdio: "ignore", shell: false,
    });
    if (!descendant.pid) throw new Error("Owned descendant did not spawn.");
    await waitForJson(join(root, "grandchild.json"));
    writeMarker(join(root, "owners.json"), JSON.stringify({ gui: process.pid, descendant: descendant.pid }));
    const nonce = process.env[LINUX_RESTART_NONCE];
    if (!nonce) throw new Error("Owned restart channel nonce is missing.");
    writeFileSync(3, `${JSON.stringify({ version: 1, type: "restart", nonce, installedVersion: "0.3.1" })}\n`);
    setInterval(() => {}, 1000);
    return;
  }
  // Only this private fixture process changes its execPath so the production native-effects guard
  // can launch the owned Node fixture through its normal detached-group path.
  process.execPath = process.argv[4]!;
  process.exitCode = await runLinuxSupervisor({ launch, currentVersion: "0.3.0",
    argv: ["--import", "tsx", script, "owned-gui", root],
    async revalidateReplacement() { writeMarker(join(root, "unexpected-revalidation"), "revalidate"); } });
}

if (["grandchild", "sibling", "owned-gui", "supervisor"].includes(process.argv[2] ?? "")) {
  await childMain(process.argv[2]!, process.argv[3]!);
} else {
  test("external termination reaps only the detached GUI descendant group and cannot consume its restart receipt", {
    skip: process.platform !== "linux", timeout: 12_000,
  }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-supervisor-signal-")));
    const env = environment(root);
    const openwhisperAlias = join(root, "openwhisper"); await symlink(process.execPath, openwhisperAlias);
    let supervisor: ChildProcess | undefined, supervisorError: Error | undefined, sibling: ChildProcess | undefined;
    let ownerIdentities: Array<Readonly<{ pid: number; start: string }>> = [];
    try {
      sibling = spawn(process.execPath, ["--import", "tsx", script, "sibling", root], {
        cwd: appRoot, env, stdio: "ignore", shell: false,
      });
      assert.ok(sibling.pid);
      supervisor = spawn(openwhisperAlias, ["--import", "tsx", script, "supervisor", root, openwhisperAlias], {
        cwd: appRoot, env, stdio: "ignore", shell: false,
      });
      supervisor.once("error", (error) => { supervisorError = error; });
      const owners = await waitForJson(join(root, "owners.json"));
      ownerIdentities = await Promise.all([owners.gui!, owners.descendant!].map(async (pid) => ({ pid, start: await processStart(pid) })))
        .then((identities) => identities.filter((identity): identity is Readonly<{ pid: number; start: string }> => identity.start !== undefined));
      const siblingReady = await waitForJson(join(root, "sibling.json"));
      assert.equal(await processRunning(owners.gui!), true);
      assert.equal(await processRunning(owners.descendant!), true);
      assert.equal(await processRunning(siblingReady.pid!), true);

      supervisor!.kill("SIGTERM");
      assert.equal(await closeWithin(supervisor!, 4000), true, "The supervisor must close within its cleanup bound.");
      assert.equal(supervisorError, undefined);
      assert.deepEqual({ code: supervisor!.exitCode, signal: supervisor!.signalCode }, { code: 143, signal: null });
      await waitUntilGone([owners.gui!, owners.descendant!]);
      assert.equal(await processRunning(siblingReady.pid!), true, "The unrelated sibling must remain alive.");
      await assert.rejects(access(join(root, "unexpected-revalidation")));
    } finally {
      if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGTERM"); await closeWithin(supervisor, 3000);
        if (supervisor.exitCode === null && supervisor.signalCode === null) { supervisor.kill("SIGKILL"); await closeWithin(supervisor, 1000); }
      }
      if (sibling && sibling.exitCode === null && sibling.signalCode === null) {
        sibling.kill("SIGTERM"); await closeWithin(sibling, 1000);
        if (sibling.exitCode === null && sibling.signalCode === null) { sibling.kill("SIGKILL"); await closeWithin(sibling, 1000); }
      }
      for (const identity of ownerIdentities) {
        if (await processStart(identity.pid) === identity.start) {
          try { process.kill(identity.pid, "SIGKILL"); } catch { /* The private fixture process already exited. */ }
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

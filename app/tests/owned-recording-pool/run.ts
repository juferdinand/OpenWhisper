import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boundedJson, describe, inventory } from "../owned-supervisor/files.js";
import { validateConfiguration as validateCpuConfiguration, waitForOriginalCommandClose } from "../owned-supervisor/run.js";
import { verifyBuiltSources } from "./build-probe.js";
import { buildManifestSchema, fileInventorySchema, inputSchema, validateResult, IMAGE, SECCOMP_SHA256,
  ELECTRON_SHA256, HOME, RECORDING_ENVIRONMENT_KEY, APPLICATION_MS, bounded } from "./contracts.js";

const absolute = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && resolve(value) === value && !value.includes("\0"));
export function parseExecutionArguments(args: readonly string[]) {
  if (args.length !== 9 || args[0] !== "--output" || args[2] !== "--build" || args[4] !== "--input-sha256" || args[6] !== "--seccomp" ||
    args[8] !== "--execute-reviewed-owned-recording-pool") throw new Error("INVALID_EXECUTION");
  const output = absolute.parse(args[1]), build = absolute.parse(args[3]), inputSha256 = z.string().regex(/^[a-f0-9]{64}$/u).parse(args[5]), seccomp = absolute.parse(args[7]);
  if (output === build || output.startsWith(`${build}/`) || build.startsWith(`${output}/`)) throw new Error("INVALID_EXECUTION");
  return { output, build, inputSha256, seccomp };
}
export function validateStoppedConfiguration(value: unknown, policy: unknown): void {
  validateCpuConfiguration(value, policy);
  z.array(z.object({ State: z.object({ Running: z.literal(false) }) })).length(1).parse(value);
}
async function privateDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  assert.ok(status.isDirectory() && !status.isSymbolicLink() && status.uid === process.getuid?.() && (status.mode & 0o7777) === 0o700);
  assert.equal(await realpath(path), path);
}
export async function verifyReviewedBuild(build: string, expectedInput: string) {
  await privateDirectory(build);
  const actualInput = await describe(join(build, "input.json"), 512 * 1024); assert.equal(actualInput.sha256, expectedInput);
  const input = inputSchema.parse(await boundedJson(join(build, "input.json"), 512 * 1024));
  const manifest = buildManifestSchema.parse(await boundedJson(join(build, "build-manifest.json"), 512 * 1024));
  assert.deepEqual(input.build, manifest); await verifyBuiltSources(manifest);
  assert.deepEqual(await inventory(join(build, "payload")), manifest.payloadFiles);
  const runtime = fileInventorySchema.parse(await boundedJson(join(build, "runtime-files.json")));
  assert.deepEqual(input.runtimeFiles, runtime); assert.equal(runtime.electron?.sha256, ELECTRON_SHA256);
  assert.deepEqual(await inventory(join(build, "owned-runtime/electron")), runtime);
  return { input, manifest, runtime };
}
/** Dormant: consumes the reviewed package; never builds or downloads at execution. */
export async function executeReviewedRecordingPool(args: readonly string[]): Promise<void> {
  const { output, build, inputSha256, seccomp } = parseExecutionArguments(args);
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) throw new Error("INVALID_EXECUTION");
  const { runtime } = await verifyReviewedBuild(build, inputSha256);
  assert.equal((await describe(seccomp, 1024 * 1024)).sha256, SECCOMP_SHA256);
  await mkdir(output, { mode: 0o700, recursive: false }); await privateDirectory(output);
  const staged = join(output, "payload"); await cp(join(build, "payload"), staged, { recursive: true, errorOnExist: true, force: false });
  await cp(join(build, "input.json"), join(staged, "input.json"), { errorOnExist: true, force: false });
  assert.equal((await describe(join(staged, "input.json"), 512 * 1024)).sha256, inputSha256);
  const config = join(output, "docker-client"); await mkdir(config, { mode: 0o700 });
  const container = `openwhisper-owned-recording-pool-${randomUUID()}`;
  const allUntil = performance.now() + 450_000, operationUntil = allUntil - 70_000;
  let cleanup = false, sequence = 0, created = false, status = "FAIL", namespaceRemoved = false;
  const originalCloses = new Set<Promise<unknown>>();
  const commands: { args: string[]; code: number; milliseconds: number; expired: boolean; overflow: boolean; errored: boolean; closureObserved: boolean }[] = [];
  async function docker(arguments_: string[], milliseconds = 30_000) {
    const origin = performance.now(), allowedUntil = cleanup ? allUntil : operationUntil;
    const end = Math.min(origin + milliseconds, allowedUntil - 4000);
    if (end <= origin) throw new Error("COMMAND_DEADLINE");
    const child = spawn("/usr/bin/docker", ["--config", config, "--host", "unix:///var/run/docker.sock", ...arguments_],
      { shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    let log = "", stdout = "", logBytes = 0, expired = false, overflow = false, stopRequested = false, signalFailed = false, closureObserved = false;
    let force: NodeJS.Timeout | undefined;
    const signal = (kind: "SIGTERM" | "SIGKILL"): void => { try { child.kill(kind); } catch { signalFailed = true; } };
    const stop = (): void => { if (stopRequested) return; stopRequested = true; force = setTimeout(() => signal("SIGKILL"), 2000); signal("SIGTERM"); };
    const collect = (bytes: Buffer, standard: boolean): void => {
      if (overflow) return;
      if (logBytes + bytes.byteLength > 1024 * 1024) { overflow = true; stop(); return; }
      logBytes += bytes.byteLength; const text = bytes.toString("utf8"); log += text; if (standard) stdout += text;
    };
    child.stdout.on("data", (bytes: Buffer) => collect(bytes, true)); child.stderr.on("data", (bytes: Buffer) => collect(bytes, false));
    const timer = setTimeout(() => { expired = true; stop(); }, Math.max(0, end - performance.now()));
    const original = waitForOriginalCommandClose(child, end, () => ({ expired, overflow })); originalCloses.add(original);
    void original.then(() => { closureObserved = true; clearTimeout(timer); clearTimeout(force); originalCloses.delete(original); });
    let observed = { code: 1, expired: true, overflow, errored: true };
    try { observed = await bounded(original, Math.min(end + 4000, allowedUntil)); }
    catch { stop(); }
    if (signalFailed) observed = { ...observed, code: 1, errored: true };
    await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
    commands.push({ args: arguments_, ...observed, milliseconds: performance.now() - origin, closureObserved });
    return { code: observed.code, stdout, closureObserved };
  }
  async function required(args: string[], milliseconds?: number): Promise<string> {
    const observed = await docker(args, milliseconds); if (observed.code !== 0 || !observed.closureObserved) throw new Error("COMMAND_FAILED"); return observed.stdout.trim();
  }
  try {
    const image = await required(["image", "inspect", IMAGE]); z.array(z.object({ Id: z.literal(IMAGE) })).length(1).parse(JSON.parse(image));
    await writeFile(join(output, "image-inspect.json"), image, { mode: 0o600 }); created = true;
    await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "4g", "--shm-size", "256m",
      "--ulimit", "core=0:0", "--entrypoint", "/bin/sleep", IMAGE, "500"]);
    await required(["cp", "-a", staged, `${container}:/payload`]); await required(["cp", "-a", join(build, "owned-runtime"), `${container}:/owned-runtime`]);
    const inspect = await required(["inspect", container]); validateStoppedConfiguration(JSON.parse(inspect), await boundedJson(seccomp));
    await writeFile(join(output, "container-inspect.json"), inspect, { mode: 0o600 });
    const copied = join(output, "stopped-payload"); await required(["cp", "-a", `${container}:/payload`, copied]);
    assert.deepEqual(await inventory(copied), await inventory(staged));
    const copiedRuntime = join(output, "stopped-runtime"); await required(["cp", "-a", `${container}:/owned-runtime/electron`, copiedRuntime]);
    assert.deepEqual(await inventory(copiedRuntime), runtime);
    await required(["start", container]); const own = ["exec", "--user", "1000:1000", container];
    await required([...own, "/usr/bin/mkdir", "-m", "700", "-p", HOME, `${HOME}/tmp`, `${HOME}/runtime`]);
    await required([...own, "/usr/bin/chmod", "-R", "a-w", "/payload", "/owned-runtime"]);
    const environment = ["/usr/bin/env", "-i", `HOME=${HOME}`, `XDG_CONFIG_HOME=${HOME}/config`, `XDG_DATA_HOME=${HOME}/data`,
      `XDG_CACHE_HOME=${HOME}/cache`, `XDG_RUNTIME_DIR=${HOME}/runtime`, `TMPDIR=${HOME}/tmp`, "PATH=/opt/node/bin:/usr/bin:/bin", "LANG=C.UTF-8", `${RECORDING_ENVIRONMENT_KEY}=1`];
    const run = await docker([...own, ...environment, "/usr/bin/xvfb-run", "-a", "-s", "-screen 0 800x600x24 -nolisten tcp", "/owned-runtime/electron/electron",
      "--disable-gpu", "--disable-dev-shm-usage", "/payload/main.mjs", inputSha256], APPLICATION_MS);
    await required(["cp", `${container}:/evidence/.`, output]); assert.equal(run.code, 0); assert.equal(run.closureObserved, true);
    const accepted = validateResult(await boundedJson(join(output, "result.json"), 512 * 1024));
    await required([...own, ...environment, "/opt/node/bin/node", "/payload/verify-main.mjs"], 15_000);
    await required(["cp", `${container}:/evidence/.`, output]);
    z.object({ status: z.literal("PASS"), retiredBy: z.enum(["absence", "different-birth"]) }).parse(await boundedJson(join(output, "main-retirement.json")));
    await writeFile(join(output, "accepted.json"), JSON.stringify(accepted, null, 2), { mode: 0o600 });
    await verifyReviewedBuild(build, inputSha256); status = "PASS";
  } finally {
    cleanup = true;
    // Independently attempt exact namespace removal even after a held CLI.
    if (created) {
      try { await docker(["cp", `${container}:/evidence/.`, output], 10_000); } catch {}
      try { await docker(["rm", "--force", container], 20_000); } catch {}
      try { const absent = await docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`], 10_000);
        namespaceRemoved = absent.code === 0 && absent.closureObserved && absent.stdout.trim() === ""; } catch {}
    }
    try { await bounded(Promise.all([...originalCloses]), allUntil); } catch {}
    const cliClosuresConfirmed = originalCloses.size === 0;
    await writeFile(join(output, "launcher-result.json"), JSON.stringify({ status: namespaceRemoved && cliClosuresConfirmed ? status : "FAIL",
      image: IMAGE, container, inputSha256, namespaceRemoved, cliClosuresConfirmed, commands,
      scope: "Owned synthetic Linux CPU recording/pool/inventory and private clipboard; capture exit is separate from speech kernel reap." }), { mode: 0o600 });
    assert.equal(namespaceRemoved, true); assert.equal(cliClosuresConfirmed, true);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void executeReviewedRecordingPool(process.argv.slice(2)).catch(() => { process.stderr.write("Owned recording pool failed; retain private evidence.\n"); process.exitCode = 1; });
}

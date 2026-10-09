import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildManifestSchema, fileInventorySchema, inputSchema, validateResult, IMAGE, SECCOMP_SHA256, ELECTRON_SHA256, NODE_SHA256, HOME, FixtureError } from "./contract.js";
import { boundedJson, describe, inventory, verifyPayload } from "./files.js";
import { verifyBuiltSources } from "./build-probe.js";

const absolute = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && resolve(value) === value && !value.includes("\0"));
export function parseExecutionArguments(args: readonly string[]) {
  if (args.length !== 7 || args[0] !== "--output" || args[2] !== "--build" || args[4] !== "--seccomp" ||
      args[6] !== "--execute-reviewed-owned-cpu-supervisor") throw new FixtureError();
  const output = absolute.parse(args[1]), build = absolute.parse(args[3]), seccomp = absolute.parse(args[5]);
  if (output === build || output.startsWith(`${build}/`) || build.startsWith(`${output}/`)) throw new FixtureError();
  return { output, build, seccomp };
}
export const configurationSchema = z.array(z.object({ Image: z.literal(IMAGE), Config: z.object({ User: z.literal("1000:1000") }),
  HostConfig: z.object({ Init: z.literal(true), NetworkMode: z.literal("none"), Privileged: z.literal(false),
    CapDrop: z.array(z.literal("ALL")).length(1), Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private"),
    SecurityOpt: z.array(z.string().max(65536)).length(2).refine((options) => options.includes("no-new-privileges") && options.some((value) => value.startsWith("seccomp="))),
    Ulimits: z.array(z.object({ Name: z.literal("core"), Hard: z.literal(0), Soft: z.literal(0) })).length(1) }), Mounts: z.array(z.unknown()).length(0),
})).length(1);
export function validateConfiguration(input: unknown, expectedSeccomp: unknown): void {
  const [configuration] = configurationSchema.parse(input); assert.ok(configuration);
  const seccomp = configuration.HostConfig.SecurityOpt.find((value) => value.startsWith("seccomp=")); assert.ok(seccomp);
  const normalized: unknown = JSON.parse(seccomp.slice("seccomp=".length)); assert.deepEqual(normalized, expectedSeccomp);
}
/** A delayed timer cannot authorize a close received at or after the monotonic deadline. */
export function classifyCommandCompletion(input: { end: number; closedAt: number; exitCode: number | null; expired: boolean; overflow: boolean; errored: boolean }) {
  assert.ok(Number.isFinite(input.end) && Number.isFinite(input.closedAt));
  const expired = input.expired || input.closedAt >= input.end;
  return { code: expired || input.overflow || input.errored ? 1 : input.exitCode ?? 1, expired, overflow: input.overflow, errored: input.errored };
}
interface OriginalCommandEvents {
  on(event: "error", listener: () => void): unknown;
  once(event: "close", listener: (exitCode: number | null) => void): unknown;
}
/** Errors poison the result; only the original close releases timer/stdio ownership. */
export function waitForOriginalCommandClose(child: OriginalCommandEvents, end: number,
  flags: () => { expired: boolean; overflow: boolean }, clock: () => number = () => performance.now()) {
  return new Promise<ReturnType<typeof classifyCommandCompletion>>((accept) => {
    let errored = false;
    child.on("error", () => { errored = true; });
    child.once("close", (exitCode) => { accept(classifyCommandCompletion({ end, closedAt: clock(), exitCode, ...flags(), errored })); });
  });
}
/** Dormant explicit-token launcher; importing/typechecking/building never runs Docker. */
export async function executeReviewedCpuSupervisor(args: readonly string[]): Promise<void> {
  const { output, build, seccomp } = parseExecutionArguments(args);
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) throw new FixtureError();
  const manifest = buildManifestSchema.parse(await boundedJson(join(build, "build-manifest.json"))), runtime = fileInventorySchema.parse(await boundedJson(join(build, "runtime-files.json")));
  await verifyBuiltSources(manifest); await verifyPayload(join(build, "payload"), manifest);
  assert.deepEqual(await inventory(join(build, "payload")), manifest.payloadFiles);
  assert.equal((await describe(seccomp, 1024 * 1024)).sha256, SECCOMP_SHA256);
  assert.equal(runtime.electron?.sha256, ELECTRON_SHA256); assert.deepEqual(await inventory(join(build, "owned-runtime/electron")), runtime);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const staged = join(output, "payload"); await cp(join(build, "payload"), staged, { recursive: true, force: false, errorOnExist: true });
  await writeFile(join(staged, "input.json"), JSON.stringify(inputSchema.parse({ version: 1, mode: "cpu", image: IMAGE,
    seccompSha256: SECCOMP_SHA256, electronSha256: ELECTRON_SHA256, nodeSha256: NODE_SHA256, build: manifest, runtimeFiles: runtime }), null, 2), { mode: 0o600 });
  const container = `openwhisper-owned-supervisor-${randomUUID()}`, commands: { args: string[]; code: number; milliseconds: number; expired: boolean; overflow: boolean; errored: boolean }[] = [];
  let sequence = 0, created = false, status = "FAIL", cleanupConfirmed = false;
  async function docker(arguments_: string[], timeoutMs = 30_000) {
    const origin = performance.now(), end = origin + timeoutMs, child = spawn("/usr/bin/docker", arguments_, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let log = "", stdout = "", expired = false, overflow = false, stopRequested = false, force: NodeJS.Timeout | undefined;
    const stop = (): void => { if (stopRequested) return; stopRequested = true; child.kill("SIGTERM"); force = setTimeout(() => { child.kill("SIGKILL"); }, 2000); };
    const collect = (data: Buffer, standard: boolean): void => {
      if (Buffer.byteLength(log) + data.length > 1024 * 1024) { overflow = true; stop(); return; } const text = data.toString(); log += text; if (standard) stdout += text;
    };
    child.stdout.on("data", (bytes: Buffer) => { collect(bytes, true); }); child.stderr.on("data", (bytes: Buffer) => { collect(bytes, false); });
    const timer = setTimeout(() => { expired = true; stop(); }, Math.max(0, end - performance.now()));
    const completion = await waitForOriginalCommandClose(child, end, () => ({ expired, overflow }))
      .finally(() => { clearTimeout(timer); clearTimeout(force); });
    await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
    commands.push({ args: arguments_, ...completion, milliseconds: performance.now() - origin }); return { code: completion.code, stdout };
  }
  async function required(arguments_: string[], timeoutMs?: number): Promise<string> {
    const result = await docker(arguments_, timeoutMs); if (result.code !== 0) throw new FixtureError(); return result.stdout.trim();
  }
  try {
    const image = await required(["image", "inspect", IMAGE]); z.array(z.object({ Id: z.literal(IMAGE) })).length(1).parse(JSON.parse(image));
    await writeFile(join(output, "image-inspect.json"), image, { mode: 0o600 }); created = true;
    await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "2g", "--shm-size", "256m",
      "--ulimit", "core=0:0", "--entrypoint", "/bin/sleep", IMAGE, "240"]);
    await required(["cp", "-a", staged, `${container}:/payload`]); await required(["cp", "-a", join(build, "owned-runtime"), `${container}:/owned-runtime`]);
    const inspect = await required(["inspect", container]); validateConfiguration(JSON.parse(inspect), await boundedJson(seccomp)); await writeFile(join(output, "container-inspect.json"), inspect, { mode: 0o600 });
    const roundTrip = join(output, "stopped-payload"); await required(["cp", "-a", `${container}:/payload`, roundTrip]);
    const expectedRoundTrip = await inventory(staged); assert.deepEqual(await inventory(roundTrip), expectedRoundTrip);
    const runtimeRoundTrip = join(output, "stopped-runtime"); await required(["cp", "-a", `${container}:/owned-runtime/electron`, runtimeRoundTrip]);
    assert.deepEqual(await inventory(runtimeRoundTrip), runtime);
    await required(["start", container]); const own = ["exec", "--user", "1000:1000", container];
    await required([...own, "/usr/bin/mkdir", "-m", "700", "-p", HOME, `${HOME}/tmp`, `${HOME}/runtime`]);
    await required([...own, "/usr/bin/chmod", "-R", "a-w", "/payload", "/owned-runtime"]);
    const environment = ["/usr/bin/env", "-i", `HOME=${HOME}`, `XDG_CONFIG_HOME=${HOME}/config`, `XDG_DATA_HOME=${HOME}/data`,
      `XDG_CACHE_HOME=${HOME}/cache`, `XDG_RUNTIME_DIR=${HOME}/runtime`, `TMPDIR=${HOME}/tmp`, "PATH=/opt/node/bin:/usr/bin:/bin", "LANG=C.UTF-8", "OPENWHISPER_OWNED_SUPERVISOR_CPU=1"];
    const ran = await docker([...own, ...environment, "/usr/bin/xvfb-run", "-a", "-s", "-screen 0 800x600x24 -nolisten tcp", "/owned-runtime/electron/electron",
      "--disable-gpu", "--disable-dev-shm-usage", "/payload/main.mjs"], 180_000);
    await required(["cp", `${container}:/evidence/.`, output]); assert.equal(ran.code, 0);
    const accepted = validateResult(await boundedJson(join(output, "result.json")));
    await required([...own, ...environment, "/opt/node/bin/node", "/payload/verify-main.mjs"]);
    await required(["cp", `${container}:/evidence/.`, output]);
    z.object({ status: z.literal("PASS"), retiredBy: z.enum(["absence", "different-birth"]) }).parse(await boundedJson(join(output, "main-retirement.json")));
    await writeFile(join(output, "accepted.json"), JSON.stringify(accepted, null, 2), { mode: 0o600 });
    await verifyBuiltSources(manifest); assert.deepEqual(await inventory(join(build, "payload")), manifest.payloadFiles);
    assert.deepEqual(await inventory(join(build, "owned-runtime/electron")), runtime); status = "PASS";
  } finally {
    if (created) {
      await docker(["cp", `${container}:/evidence/.`, output]); const removed = await docker(["rm", "--force", container]);
      const absent = await docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`]);
      cleanupConfirmed = absent.code === 0 && absent.stdout.trim() === ""; assert.ok(removed.code === 0 || cleanupConfirmed);
    }
    await writeFile(join(output, "launcher-result.json"), JSON.stringify({ status: cleanupConfirmed ? status : "FAIL", mode: "cpu", image: IMAGE,
      cleanupConfirmed, commands, scope: "Owned CPU composition only; no GPU/capture/delivery/macOS/desktop proof." }, null, 2), { mode: 0o600 });
    assert.equal(cleanupConfirmed, true);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void executeReviewedCpuSupervisor(process.argv.slice(2)).catch(() => { process.stderr.write("Owned CPU supervisor fixture failed; inspect private evidence.\n"); process.exitCode = 1; });
}

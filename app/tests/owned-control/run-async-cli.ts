import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--control-run" || !args[1] || args[2] !== "--output" || !args[3]) {
  throw new Error("Usage: node --import tsx tests/owned-control/run-async-cli.ts --control-run RETAINED_RUN --output NEW_DIRECTORY");
}
if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) throw new Error("Owned ordinary-user Linux launcher required.");
const baseline = resolve(args[1]), output = resolve(args[3]), id = randomUUID();
await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await mkdir(output, { mode: 0o700 });
const container = `openwhisper-owned-async-${id}`;
const commands: { args: string[]; code: number; seconds: number }[] = [];
let sequence = 0, result = "FAIL";
async function sha(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function docker(args: string[], timeout = 60_000): Promise<string> {
  const start = performance.now(), child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "", log = "", expired = false, force: NodeJS.Timeout | undefined;
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); log += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { log += bytes.toString(); });
  const timer = setTimeout(() => { expired = true; child.kill("SIGTERM"); force = setTimeout(() => { child.kill("SIGKILL"); }, 1000); }, timeout);
  const code = await new Promise<number>((accept, reject) => {
    child.once("error", reject); child.once("close", (code) => { accept(expired ? 1 : code ?? 1); });
  }).finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
  await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
  commands.push({ args, code, seconds: (performance.now() - start) / 1000 });
  if (code !== 0) throw new Error("Owned async CLI fixture failed; inspect retained logs."); return stdout.trim();
}
try {
  const retained = z.object({ source: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    image: z.string().regex(/^sha256:[a-f0-9]{64}$/), addon: z.literal("24a94d054fd522a449f573bce00f46e7f757b39c357ca6ed804b754b33a77e3b"),
    compiledFacade: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().parse(JSON.parse(await readFile(join(baseline, "input-provenance.json"), "utf8")));
  const baselineResult = z.object({ result: z.literal("PASS") }).passthrough().parse(JSON.parse(await readFile(join(baseline, "launcher-result.json"), "utf8")));
  void baselineResult;
  if (await sha(join(baseline, "openwhisper_linux_bus.node")) !== retained.addon || await sha(join(baseline, "bus.js")) !== retained.compiledFacade) throw new Error("Retained bus artifacts changed.");
  for (const path of ["src/platforms/linux/shared/bus.ts", "src/platforms/linux/shared/bus-values.ts", "native/linux-bus/binding.cpp", "native/linux-bus/codec.cpp", "native/linux-bus/codec.hpp"]) {
    if (await sha(join(root, path)) !== retained.source[path]) throw new Error("Retained bus source differs from current reviewed input.");
  }
  const sources: Record<string, string> = {};
  for (const path of ["tests/owned-control/headless-async.ts", "tests/owned-control/async-cli.test.ts", "tests/owned-control/run-async-cli.ts", "tests/owned-control/Dockerfile", "package-lock.json"]) sources[path] = await sha(join(root, path));
  const pkg = join(output, "async-cli-package"); await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "openwhisper-owned-async-cli", private: true, type: "module", main: "entry.mjs" }), { mode: 0o600 });
  await build({ entryPoints: [join(root, "tests/owned-control/headless-async.ts")], outfile: join(pkg, "entry.mjs"), bundle: true,
    platform: "node", format: "esm", target: "node24", external: ["electron"], plugins: [{ name: "fixed-reviewed-bus", setup(builder) {
      builder.onResolve({ filter: /platforms\/linux\/shared\/bus\.js$/ }, () => ({ path: "file:///owned-app/dist/platforms/linux/shared/bus.js", external: true }));
    } }] });
  await cp(join(baseline, "seccomp.json"), join(output, "seccomp.json"));
  const image = await docker(["image", "inspect", retained.image, "--format", "{{.Id}}"]);
  if (image !== retained.image) throw new Error("Unexpected retained image identity.");
  await docker(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", `seccomp=${join(output, "seccomp.json")}`, "--pids-limit", "128", "--memory", "1g", "--shm-size", "64m", "--entrypoint", "/bin/sleep", image, "120"]);
  await docker(["cp", join(root, "node_modules"), `${container}:/owned-app/`]);
  await docker(["cp", join(root, "package.json"), `${container}:/owned-app/package.json`]);
  await docker(["start", container]);
  const owned = (args: string[]): Promise<string> => docker(["exec", "--user", "1000:1000", container, ...args]);
  await owned(["mkdir", "-p", "/owned-app/dist/native", "/owned-app/dist/platforms/linux/shared", "/owned-app/tests/owned-control"]);
  await docker(["cp", join(baseline, "bus.js"), `${container}:/owned-app/dist/platforms/linux/shared/bus.js`]);
  await docker(["cp", join(baseline, "openwhisper_linux_bus.node"), `${container}:/owned-app/dist/native/openwhisper_linux_bus.node`]);
  await docker(["cp", pkg, `${container}:/owned-app/tests/owned-control/`]);
  await docker(["cp", join(root, "tests/owned-control/async-cli.test.ts"), `${container}:/owned-app/tests/owned-control/async-cli.test.ts`]);
  const inspect = await docker(["inspect", container]); await writeFile(join(output, "container-inspect.json"), inspect, { mode: 0o600 });
  z.array(z.object({ Config: z.object({ User: z.literal("1000:1000") }), HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false),
    CapDrop: z.array(z.literal("ALL")).length(1), Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private") }),
    Mounts: z.array(z.unknown()).length(0) })).length(1).parse(JSON.parse(inspect));
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ source: sources, baseline, image, nativeAddon: retained.addon,
    busFacade: retained.compiledFacade, reviewedNativeSource: retained.source, entry: await sha(join(pkg, "entry.mjs")),
    runtime: await sha(join(root, "node_modules/electron/dist/electron")), seccomp: await sha(join(output, "seccomp.json")) }, null, 2), { mode: 0o600 });
  let failure: unknown;
  try { await owned(["env", "OPENWHISPER_OWNED_ASYNC_CLI_TEST=1", "OPENWHISPER_ASYNC_CLI_EVIDENCE=/evidence", "/opt/node/bin/node", "--import", "tsx", "--test", "tests/owned-control/async-cli.test.ts"]); }
  catch (error: unknown) { failure = error; }
  await docker(["cp", `${container}:/evidence/.`, output]);
  if (failure) throw failure; result = "PASS";
} finally {
  await docker(["rm", "--force", container], 20_000).catch(() => undefined);
  const remaining = await docker(["ps", "--all", "--filter", `name=^${container}$`, "--format", "{{.ID}}"]);
  if (remaining !== "") result = "FAIL";
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ result, commands }, null, 2), { mode: 0o600 });
  if (remaining !== "") throw new Error("Owned async CLI container disposal was not confirmed.");
}
console.log(`PASS: owned asynchronous no-display feasibility; evidence ${output}`);

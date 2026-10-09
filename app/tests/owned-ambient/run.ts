import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--async-run" || !args[1] || args[2] !== "--output" || !args[3]) {
  throw new Error("Usage: node --import tsx tests/owned-ambient/run.ts --async-run RETAINED_RUN --output NEW_DIRECTORY");
}
if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) throw new Error("Owned ordinary-user Linux launcher required.");
const baseline = resolve(args[1]), output = resolve(args[3]), container = `openwhisper-owned-ambient-${randomUUID()}`;
await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await mkdir(output, { mode: 0o700 });
const commands: { args: string[]; code: number; seconds: number }[] = [];
let sequence = 0, result = "FAIL";
async function sha(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function docker(args: string[], timeout = 60_000): Promise<string> {
  const started = performance.now(), child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "", log = "", expired = false, force: NodeJS.Timeout | undefined;
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); log += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { log += bytes.toString(); });
  const timer = setTimeout(() => { expired = true; child.kill("SIGTERM"); force = setTimeout(() => { child.kill("SIGKILL"); }, 1000); }, timeout);
  const code = await new Promise<number>((accept, reject) => {
    child.once("error", reject); child.once("close", (code) => { accept(expired ? 1 : code ?? 1); });
  }).finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
  await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
  commands.push({ args, code, seconds: (performance.now() - started) / 1000 });
  if (code !== 0) throw new Error("Owned ambient diagnostic failed; inspect retained logs."); return stdout.trim();
}
try {
  const retained = z.object({ baseline: z.string(), image: z.literal("sha256:403f066a165681074f19f1977b2b46617d3dd7b072cb7037400dbe01676ed3cb"),
    nativeAddon: z.literal("24a94d054fd522a449f573bce00f46e7f757b39c357ca6ed804b754b33a77e3b"),
    busFacade: z.literal("b1ae10e431e8a51e078895ff78a2c7e0ad8ca91d274f7aaa115d0e6cf25eb482"),
    entry: z.literal("283d553a8a4255464945985aac1c748947ca85245e3a74c68092094fcbcfca6a"),
    runtime: z.literal("10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564"),
    reviewedNativeSource: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).passthrough().parse(JSON.parse(await readFile(join(baseline, "input-provenance.json"), "utf8")));
  z.object({ result: z.literal("PASS") }).passthrough().parse(JSON.parse(await readFile(join(baseline, "launcher-result.json"), "utf8")));
  const addon = join(retained.baseline, "openwhisper_linux_bus.node"), facade = join(retained.baseline, "bus.js"), entry = join(baseline, "async-cli-package", "entry.mjs");
  if (await sha(addon) !== retained.nativeAddon || await sha(facade) !== retained.busFacade || await sha(entry) !== retained.entry
    || await sha(join(root, "node_modules/electron/dist/electron")) !== retained.runtime) throw new Error("Retained native/ESM/runtime bytes changed.");
  for (const path of ["src/platforms/linux/shared/bus.ts", "src/platforms/linux/shared/bus-values.ts", "native/linux-bus/binding.cpp", "native/linux-bus/codec.cpp", "native/linux-bus/codec.hpp"]) {
    if (await sha(join(root, path)) !== retained.reviewedNativeSource[path]) throw new Error("Reviewed bus source differs from frozen input.");
  }
  const source: Record<string, string> = {};
  await mkdir(join(output, "source-snapshot"));
  for (const path of ["tests/owned-ambient/message-metadata.ts", "tests/owned-ambient/message-metadata.test.ts", "tests/owned-ambient/owned-services.ts", "tests/owned-ambient/owned-services.test.ts",
    "tests/owned-ambient/headless-dwell.ts", "tests/owned-ambient/ambient.test.ts", "tests/owned-ambient/run.ts", "package-lock.json"]) {
    source[path] = await sha(join(root, path)); const target = join(output, "source-snapshot", path); await mkdir(dirname(target), { recursive: true }); await cp(join(root, path), target);
  }
  await cp(join(baseline, "async-cli-package"), join(output, "async-cli-package"), { recursive: true });
  const dwellPackage = join(output, "dwell-package"); await mkdir(dwellPackage);
  await writeFile(join(dwellPackage, "package.json"), JSON.stringify({ name: "openwhisper-owned-ambient-dwell", private: true, type: "module", main: "entry.mjs" }), { mode: 0o600 });
  await build({ entryPoints: [join(root, "tests/owned-ambient/headless-dwell.ts")], outfile: join(dwellPackage, "entry.mjs"), bundle: true,
    platform: "node", format: "esm", target: "node24", external: ["electron"], plugins: [{ name: "fixed-reviewed-bus", setup(builder) {
      builder.onResolve({ filter: /platforms\/linux\/shared\/bus\.js$/ }, () => ({ path: "file:///owned-app/dist/platforms/linux/shared/bus.js", external: true }));
    } }] });
  await cp(join(baseline, "seccomp.json"), join(output, "seccomp.json"));
  const image = await docker(["image", "inspect", retained.image, "--format", "{{.Id}}"]); assertImage(image, retained.image);
  await docker(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", `seccomp=${join(output, "seccomp.json")}`, "--pids-limit", "128", "--memory", "1g", "--shm-size", "64m", "--entrypoint", "/bin/sleep", image, "120"]);
  await docker(["cp", join(root, "node_modules"), `${container}:/owned-app/`]);
  await docker(["cp", join(root, "package.json"), `${container}:/owned-app/package.json`]); await docker(["start", container]);
  const owned = (args: string[]): Promise<string> => docker(["exec", "--user", "1000:1000", container, ...args]);
  await owned(["mkdir", "-p", "/owned-app/dist/native", "/owned-app/dist/platforms/linux/shared", "/owned-app/tests/owned-control", "/owned-app/tests/owned-ambient"]);
  await docker(["cp", facade, `${container}:/owned-app/dist/platforms/linux/shared/bus.js`]);
  await docker(["cp", addon, `${container}:/owned-app/dist/native/openwhisper_linux_bus.node`]);
  await docker(["cp", join(output, "async-cli-package"), `${container}:/owned-app/tests/owned-control/`]);
  await docker(["cp", dwellPackage, `${container}:/owned-app/tests/owned-ambient/`]);
  for (const name of ["message-metadata.ts", "owned-services.ts", "ambient.test.ts"]) await docker(["cp", join(root, "tests/owned-ambient", name), `${container}:/owned-app/tests/owned-ambient/${name}`]);
  const inspect = await docker(["inspect", container]); await writeFile(join(output, "container-inspect.json"), inspect, { mode: 0o600 });
  z.array(z.object({ Config: z.object({ User: z.literal("1000:1000") }), HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false),
    CapDrop: z.array(z.literal("ALL")).length(1), Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private") }),
    Mounts: z.array(z.unknown()).length(0) })).length(1).parse(JSON.parse(inspect));
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ source, retainedAsyncRun: baseline, retainedNativeRun: retained.baseline, image,
    nativeAddon: retained.nativeAddon, busFacade: retained.busFacade, entry: retained.entry, runtime: retained.runtime,
    dwellEntry: await sha(join(dwellPackage, "entry.mjs")),
    reviewedNativeSource: retained.reviewedNativeSource, seccomp: await sha(join(output, "seccomp.json")) }, null, 2), { mode: 0o600 });
  let failure: unknown;
  try { await owned(["env", "OPENWHISPER_OWNED_AMBIENT_TEST=1", "OPENWHISPER_AMBIENT_EVIDENCE=/evidence", "/opt/node/bin/node", "--import", "tsx", "--test", "tests/owned-ambient/ambient.test.ts"]); }
  catch (error: unknown) { failure = error; }
  await docker(["cp", `${container}:/evidence/.`, output]); if (failure) throw failure; result = "PASS";
} finally {
  await docker(["rm", "--force", container], 20_000).catch(() => undefined);
  const remaining = await docker(["ps", "--all", "--filter", `name=^${container}$`, "--format", "{{.ID}}"]);
  if (remaining !== "") result = "FAIL";
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ result, commands }, null, 2), { mode: 0o600 });
  if (remaining !== "") throw new Error("Owned ambient container disposal was not confirmed.");
}
console.log(`PASS: owned ambient metadata diagnostic; evidence ${output}`);
function assertImage(actual: string, expected: string): void { if (actual !== expected) throw new Error("Unexpected retained image identity."); }

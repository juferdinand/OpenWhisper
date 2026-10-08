import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildControlProbe } from "./build-probe.js";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const id = randomUUID(); const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1])) throw new Error("Usage: node --import tsx tests/owned-control/run.ts [--output NEW_DIRECTORY]");
if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) throw new Error("Owned bus launcher requires ordinary-user x86_64 Linux.");
const output = resolve(args[1] ?? join(root, ".local/owned-control", id)); await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await mkdir(output, { mode: 0o700 });
const container = `openwhisper-owned-control-${id}`, tag = `openwhisper-owned-control:${id}`;
let sequence = 0; let result = "FAIL"; const commands: { args: string[]; code: number; seconds: number }[] = [];
async function docker(args: string[], timeout = 300_000): Promise<string> {
  const start = performance.now(); const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "", combined = "", expired = false; let force: NodeJS.Timeout | undefined;
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); combined += bytes.toString(); }); child.stderr.on("data", (bytes: Buffer) => { combined += bytes.toString(); });
  const timer = setTimeout(() => { expired = true; child.kill("SIGTERM"); force = setTimeout(() => { child.kill("SIGKILL"); }, 5000); }, timeout);
  const code = await new Promise<number>((accept, reject) => { child.once("error", reject); child.once("close", (value) => { accept(expired ? 1 : value ?? 1); }); })
    .finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
  await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), combined, { mode: 0o600 }); commands.push({ args, code, seconds: (performance.now() - start) / 1000 });
  if (code !== 0) throw new Error(`Owned bus docker ${args[0]} failed; inspect ${output}.`); return stdout.trim();
}
async function sha(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function manifest(directory: string, prefix = ""): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Frozen inputs cannot contain symlinks.");
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await manifest(join(directory, entry.name), relative));
    else if (entry.isFile()) hashes[relative] = await sha(join(directory, entry.name));
  } return hashes;
}
async function download(url: string, expected: string, path: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) }); if (!response.ok || !response.body) throw new Error("Pinned fixture download failed.");
  const blocks: Uint8Array[] = []; let length = 0;
  for await (const block of response.body) { length += block.byteLength; if (length > 32 * 1024 * 1024) throw new Error("Pinned download exceeds its limit."); blocks.push(block); }
  const bytes = Buffer.concat(blocks); if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Pinned input checksum mismatch.");
  await writeFile(path, bytes, { mode: 0o600 }); return bytes;
}
try {
  const dist = await manifest(join(root, "dist")); await cp(join(root, "dist"), join(output, "frozen-dist"), { recursive: true, errorOnExist: true, force: false });
  if (JSON.stringify(await manifest(join(root, "dist"))) !== JSON.stringify(dist) || JSON.stringify(await manifest(join(output, "frozen-dist"))) !== JSON.stringify(dist)) throw new Error("Dist changed during owned copy.");
  await writeFile(join(output, "frozen-dist.json"), JSON.stringify(dist, null, 2), { mode: 0o600 });
  await buildControlProbe(output);
  const source: Record<string, string> = {};
  for (const path of ["native/linux-bus/CMakeLists.txt", "native/linux-bus/binding.cpp", "native/linux-bus/codec.cpp", "native/linux-bus/codec.hpp", "src/platforms/linux/shared/bus.ts", "src/platforms/linux/shared/bus-values.ts", "tests/linux-bus.test.ts",
    "tests/owned-control/client.cpp", "tests/owned-control/entry.ts", "tests/owned-control/probe.ts", "tests/owned-control/build-probe.ts", "tests/owned-control/acceptance.test.ts", "tests/owned-control/run.ts", "tests/owned-control/Dockerfile", "scripts/build-linux-bus.ts", "src/platforms/linux/shared/control.ts", "src/main/platform-channel.ts", "src/workers/platform-protocol.ts", "src/workers/platform-entry.ts", "tests/linux-control.test.ts", "tests/platform-channel.test.ts", "tests/owned-control/headless.ts", "tests/owned-control/cleanup-failure.ts"]) source[path] = await sha(join(root, path));
  const pin = z.strictObject({ version: z.literal("24.21.0"), napiVersion: z.literal(8), sha256: z.string().regex(/^[a-f0-9]{64}$/), source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt") }).parse(JSON.parse(await readFile(join(root, "native/node-headers.json"), "utf8")));
  await download(`https://nodejs.org/download/release/v${pin.version}/node-v${pin.version}-headers.tar.gz`, pin.sha256, join(output, "headers.tar.gz"));
  const policy = z.object({ upstream: z.object({ url: z.url(), sha256: z.string(), licenseUrl: z.url(), licenseSha256: z.string() }), namespaceMask: z.literal(2114060288), namespaceFlags: z.array(z.int()), allowChroot: z.literal(true) }).parse(JSON.parse(await readFile(join(root, "tests/owned-ui/seccomp.json"), "utf8")));
  const bytes = await download(policy.upstream.url, policy.upstream.sha256, join(output, "moby-seccomp.json")); await download(policy.upstream.licenseUrl, policy.upstream.licenseSha256, join(output, "LICENSE-moby"));
  const seccomp = z.object({ defaultAction: z.literal("SCMP_ACT_ERRNO"), syscalls: z.array(z.object({ names: z.array(z.string()), action: z.string() }).passthrough()) }).passthrough().parse(JSON.parse(new TextDecoder().decode(bytes)));
  seccomp.syscalls.push({ names: ["chroot"], action: "SCMP_ACT_ALLOW" });
  for (const flags of policy.namespaceFlags) {
    seccomp.syscalls.push({ names: ["clone"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: policy.namespaceMask, valueTwo: flags, op: "SCMP_CMP_MASKED_EQ" }] });
    seccomp.syscalls.push({ names: ["unshare"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: flags, op: "SCMP_CMP_EQ" }] });
  }
  await writeFile(join(output, "seccomp.json"), JSON.stringify(seccomp), { mode: 0o600 });
  console.log("Provisioning owned Ubuntu22 GIO fixture; app runs only as UID1000 with no host mounts/devices/network.");
  await docker(["build", "--tag", tag, join(root, "tests/owned-control")], 900_000);
  const image = await docker(["image", "inspect", tag, "--format", "{{.Id}}"]); if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Unexpected image identity.");
  await docker(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", `seccomp=${join(output, "seccomp.json")}`, "--pids-limit", "256", "--memory", "3g", "--shm-size", "256m", "--entrypoint", "/bin/sleep", image, "1800"]);
  await docker(["cp", join(output, "frozen-dist"), `${container}:/owned-app/dist`]);
  for (const path of ["tests", "node_modules", "package.json", "package-lock.json", "tsconfig.json"]) await docker(["cp", join(root, path), `${container}:/owned-app/`]);
  const nativeSnapshot = join(output, "native-source"); await mkdir(nativeSnapshot);
  for (const file of ["CMakeLists.txt", "binding.cpp", "codec.cpp", "codec.hpp"]) await cp(join(root, "native/linux-bus", file), join(nativeSnapshot, file));
  await docker(["cp", nativeSnapshot, `${container}:/owned-app/native-linux-bus`]);
  for (const path of ["probe.mjs", "entry.mjs", "headless.mjs", "platform-fault.mjs"]) await docker(["cp", join(output, path), `${container}:/owned-app/tests/owned-control/`]);
  await docker(["cp", join(output, "headers.tar.gz"), `${container}:/fixtures/headers.tar.gz`]);
  const inspected = await docker(["inspect", container]); await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  z.array(z.object({ Config: z.object({ User: z.literal("1000:1000") }), HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1), Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private") }), Mounts: z.array(z.unknown()).length(0) })).length(1).parse(JSON.parse(inspected));
  await docker(["start", container]); const owned = async (args: string[]): Promise<string> => docker(["exec", "--user", "1000:1000", container, ...args]);
  await owned(["mkdir", "-p", "/owned-app/vendor/node-headers", "/owned-app/dist/native", "/owned-app/dist/platforms/linux/shared"]);
  await owned(["tar", "-xzf", "/fixtures/headers.tar.gz", "--strip-components=1", "--no-same-owner", "-C", "/owned-app/vendor/node-headers"]);
  await docker(["cp", join(output, "bus.js"), `${container}:/owned-app/dist/platforms/linux/shared/bus.js`]);
  await owned(["mkdir", "-p", "/owned-app/dist/workers", "/owned-app/dist/main"]);
  for (const [file, destination] of [["control.js", "platforms/linux/shared/control.js"], ["platform-entry.js", "workers/platform-entry.js"], ["platform-channel.js", "main/platform-channel.js"]]) {
    if (!file || !destination) throw new Error("Invalid fixed owned artifact.");
    await docker(["cp", join(output, file), `${container}:/owned-app/dist/${destination}`]);
  }
  await owned(["cmake", "-S", "/owned-app/native-linux-bus", "-B", "/owned-app/native-linux-bus/build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "-DNODE_HEADERS=/owned-app/vendor/node-headers/include/node"]);
  await owned(["cmake", "--build", "/owned-app/native-linux-bus/build", "--parallel", "4"]);
  await owned(["cp", "/owned-app/native-linux-bus/build/openwhisper_linux_bus.node", "/owned-app/dist/native/openwhisper_linux_bus.node"]);
  const flags = (await owned(["pkg-config", "--cflags", "--libs", "gio-2.0", "gio-unix-2.0"])).split(/\s+/);
  await owned(["c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "/owned-app/tests/owned-control/client.cpp", "-o", "/owned-app/tests/owned-control/client", ...flags]);
  let testFailure: unknown;
  try {
    const acceptance = owned(["env", "OPENWHISPER_OWNED_CONTROL_TEST=1", "OPENWHISPER_CONTROL_EVIDENCE=/evidence", "/opt/node/bin/node", "--import", "tsx", "--test", "tests/owned-control/acceptance.test.ts"]);
    // This second UID exists only inside the disposable private container. It
    // uses the same private bus; no host account/credential/session is changed.
    const foreign = (async () => {
      let ready: { address: string; owner: string } | undefined; const start = performance.now();
      while (!ready) {
        try { ready = z.strictObject({ address: z.string().regex(/^unix:path=\/tmp\/openwhisper-owned-control(?:,guid=[a-f0-9]{32})?$/), owner: z.string().regex(/^:[0-9]+\.[0-9]+$/) }).parse(JSON.parse(await owned(["cat", "/evidence/foreign-ready.json"]))); } catch { if (performance.now() - start > 30_000) throw new Error("Foreign UID fixture readiness failed."); await new Promise<void>((accept) => { setTimeout(accept, 100); }); }
      }
      const refusal = await docker(["exec", "--user", "1001:1001", container, "/owned-app/tests/owned-control/client", ready.address, ready.owner, "foreign", "status"]);
      if (refusal !== "FOREIGN_UID_DENIED:1001") throw new Error("Foreign UID refusal was not proven.");
      await owned(["touch", "/evidence/foreign-checked"]);
    })();
    const settled = await Promise.allSettled([acceptance, foreign]);
    for (const value of settled) if (value.status === "rejected") throw value.reason;
  } catch (error: unknown) { testFailure = error; }
  await docker(["cp", `${container}:/evidence/.`, output]);
  for (const file of ["openwhisper_linux_bus.node", "CMakeCache.txt", "compile_commands.json", "build.ninja"]) await docker(["cp", `${container}:/owned-app/native-linux-bus/build/${file}`, join(output, file)]);
  await docker(["cp", `${container}:/etc/openwhisper-test-packages.txt`, join(output, "distro-packages.txt")]);
  await docker(["cp", `${container}:/usr/share/doc/libglib2.0-0/copyright`, join(output, "installed-gio-copyright")]);
  const elf = await owned(["readelf", "--version-info", "/owned-app/dist/native/openwhisper_linux_bus.node"]); await writeFile(join(output, "elf-versions.txt"), elf, { mode: 0o600 });
  await writeFile(join(output, "elf-dynamic.txt"), await owned(["readelf", "--dynamic", "/owned-app/dist/native/openwhisper_linux_bus.node"]), { mode: 0o600 });
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ source, dist, image, pin, addon: await sha(join(output, "openwhisper_linux_bus.node")), compiledFacade: await sha(join(output, "bus.js")), utilityEntry: await sha(join(output, "entry.mjs")), mainProbe: await sha(join(output, "probe.mjs")) }, null, 2), { mode: 0o600 });
  if (testFailure) throw testFailure; result = "PASS";
} finally {
  await docker(["rm", "--force", container], 30_000).catch(() => undefined);
  const remaining = await docker(["ps", "--all", "--filter", `name=^${container}$`, "--format", "{{.ID}}"]);
  if (remaining !== "") result = "FAIL";
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ result, output, commands }, null, 2), { mode: 0o600 });
  if (remaining !== "") throw new Error("Owned container disposal was not confirmed.");
}
console.log(`PASS: owned private-bus utility; evidence ${output}`);

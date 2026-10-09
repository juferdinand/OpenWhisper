import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fileSha256 } from "../../scripts/native-dependencies.js";
import { nativeBuildManifestSchema } from "../../scripts/build-native.js";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const image = "sha256:e2d225c9201932883e976e1f71ce1a9ceaae79ada0b6b60ce48efb93bd4cb6f5";
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output" || !args[1] || !isAbsolute(args[1]) || process.getuid?.() === 0) {
  throw new Error("Usage: tsx tests/owned-gpu/build.ts --output NEW_ABSOLUTE_DIRECTORY (ordinary Linux owner only)");
}
const output = args[1];
await mkdir(output, { mode: 0o700 });
const container = `openwhisper-owned-gpu-build-${randomUUID()}`;
let sequence = 0, created = false, cleanupConfirmed = false, result = "FAIL";
const commands: { args: string[]; code: number; seconds: number }[] = [];
async function docker(arguments_: string[], timeout = 60_000): Promise<{ code: number; stdout: string }> {
  const started = performance.now();
  const child = spawn("docker", arguments_, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", log = "", timedOut = false, exceeded = false;
  let force: NodeJS.Timeout | undefined;
  const stop = (): void => { child.kill("SIGTERM"); force ??= setTimeout(() => child.kill("SIGKILL"), 5000); };
  const collect = (chunk: Buffer, standard: boolean): void => {
    if (log.length + chunk.length > 4 * 1024 * 1024) { exceeded = true; stop(); return; }
    log += chunk.toString(); if (standard) stdout += chunk.toString();
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  const code = await new Promise<number>((accept, reject) => {
    child.once("error", reject); child.once("close", (status) => accept(timedOut || exceeded ? 1 : status ?? 1));
  }).finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
  await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
  commands.push({ args: arguments_, code, seconds: (performance.now() - started) / 1000 });
  return { code, stdout };
}
async function required(arguments_: string[], timeout?: number): Promise<string> {
  const ran = await docker(arguments_, timeout);
  if (ran.code !== 0) throw new Error(`Owned backend build failed; inspect ${output}.`);
  return ran.stdout;
}
const sources: Record<string, string> = {};
try {
  await mkdir(join(output, "input/scripts"), { recursive: true, mode: 0o700 });
  await mkdir(join(output, "input/native"), { mode: 0o700 });
  for (const path of ["scripts/build-native.ts", "scripts/native-dependencies.ts", "native/CMakeLists.txt", "native/speech_bridge.cpp",
    "native/speech_binding.cpp", "native/whisper-source.json", "native/node-headers.json", "native/vulkan-headers.json", "native/shaderc-source.json"]) {
    sources[path] = await fileSha256(join(root, path));
    await cp(join(root, path), join(output, "input", path));
    if (await fileSha256(join(output, "input", path)) !== sources[path]) throw new Error("Build source copy changed.");
  }
  await writeFile(join(output, "image-inspect.json"), await required(["image", "inspect", image]), { mode: 0o600 });
  await required(["create", "--name", container, "--init", "--network", "bridge", "--user", "1000:1000", "--cap-drop", "ALL",
    "--pids-limit", "512", "--memory", "8g", "--entrypoint", "/bin/sleep", image, "2400"]);
  created = true;
  for (const path of ["node_modules", "package.json", "package-lock.json", "tsconfig.json", "vendor"]) {
    await required(["cp", "-a", join(root, path), `${container}:/owned-app/`]);
  }
  for (const path of ["scripts", "native"]) await required(["cp", "-a", join(output, "input", path), `${container}:/owned-app/`]);
  const inspected = await required(["inspect", container]);
  await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  z.array(z.object({ Image: z.literal(image), Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("bridge"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1),
      Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private") }), Mounts: z.array(z.unknown()).length(0),
  })).length(1).parse(JSON.parse(inspected));
  await required(["start", container]);
  await required(["cp", `${container}:/etc/openwhisper-gpu-test-packages.txt`, join(output, "distro-packages.txt")]);
  for (const backend of ["cpu", "vulkan"] as const) {
    await required(["exec", "--user", "1000:1000", container, "/opt/node/bin/node", "--import", "tsx",
      "scripts/build-native.ts", "--backend", backend], 1_200_000);
    const artifact = join(output, backend);
    await mkdir(artifact, { mode: 0o700 });
    for (const file of ["openwhisper_speech.node", "CMakeCache.txt", "build-manifest.json", "build.ninja"]) {
      await required(["cp", `${container}:/owned-app/native/build-${backend}/${file}`, join(artifact, file)]);
    }
    const manifest = nativeBuildManifestSchema.parse(JSON.parse(await readFile(join(artifact, "build-manifest.json"), "utf8")));
    if (manifest.backend !== backend || await fileSha256(join(artifact, "openwhisper_speech.node")) !== manifest.bindingSha256 ||
      await fileSha256(join(artifact, "CMakeCache.txt")) !== manifest.cmakeCacheSha256) throw new Error("Owned compiled artifact mismatch.");
    await writeFile(join(artifact, "elf-dynamic.txt"), await required(["exec", container, "readelf", "-d", `/owned-app/native/build-${backend}/openwhisper_speech.node`]), { mode: 0o600 });
    await writeFile(join(artifact, "elf-versions.txt"), await required(["exec", container, "readelf", "--version-info", `/owned-app/native/build-${backend}/openwhisper_speech.node`]), { mode: 0o600 });
    console.log(`Fresh owned Ubuntu22 ${backend} artifact: ${artifact}; SHA256 ${manifest.bindingSha256}`);
  }
  await required(["cp", `${container}:/owned-app/vendor/native-vulkan`, join(output, "native-vulkan-toolchain")]);
  for (const [path, expected] of Object.entries(sources)) {
    if (await fileSha256(join(root, path)) !== expected) throw new Error("Build input changed during the owned build.");
  }
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ image, sources,
    packageLockSha256: await fileSha256(join(root, "package-lock.json")),
    scope: "UID1000 disposable Ubuntu22 compiler only. Bridge network for pinned public dependency fetch, no application/model execution, host mounts or devices." }, null, 2), { mode: 0o600 });
  result = "PASS";
} finally {
  if (created) {
    const removed = await docker(["rm", "--force", container], 30_000);
    const remaining = await docker(["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"], 30_000);
    cleanupConfirmed = removed.code === 0 && remaining.code === 0 && remaining.stdout.trim() === "";
  }
  await writeFile(join(output, "build-result.json"), JSON.stringify({ result, image, container, sources, commands, cleanupConfirmed }, null, 2), { mode: 0o600 });
  if (created && !cleanupConfirmed) throw new Error("Owned compiler container cleanup was not confirmed.");
}

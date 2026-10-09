import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fileSha256 } from "../../scripts/native-dependencies.js";
import { nativeBuildManifestSchema } from "../../scripts/build-native.js";
import { PARAKEET_FIXTURE } from "../fixtures/parakeet-model.js";
import { buildOwnedGpuProbe } from "./build-probe.js";
import { ownedGpuInputSchema, ownedGpuModeSchema } from "./contract.js";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const flags = ["--output", "--mode", "--build", "--baseline", "--model", "--tiny", "--jfk", "--dist", "--image"];
const args = process.argv.slice(2);
if (args.length !== flags.length * 2 || flags.some((flag, i) => args[i * 2] !== flag) ||
    process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) {
  throw new Error(`Usage: tsx tests/owned-gpu/run.ts ${flags.join(" VALUE ")} VALUE (ordinary x64 Linux owner)`);
}
const absolute = z.string().refine(isAbsolute);
const values = z.tuple([absolute, ownedGpuModeSchema, absolute, absolute, absolute, absolute, absolute, absolute,
  z.string().regex(/^sha256:[a-f0-9]{64}$/)]).parse(flags.map((_, i) => args[i * 2 + 1]));
const [output, mode, build, baseline, model, tiny, audio, distribution, image] = values;
await mkdir(output, { mode: 0o700 });
const container = `openwhisper-owned-gpu-${randomUUID()}`;
let sequence = 0, created = false, cleanupConfirmed = false, result = "FAIL";
const started = new Date().toISOString();
const commands: { args: string[]; code: number; seconds: number }[] = [];
async function docker(arguments_: string[], timeout = 60_000): Promise<{ code: number; stdout: string }> {
  const began = performance.now();
  const child = spawn("docker", arguments_, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", log = "", timedOut = false, exceeded = false;
  let force: NodeJS.Timeout | undefined;
  const stop = (): void => { child.kill("SIGTERM"); force ??= setTimeout(() => child.kill("SIGKILL"), 5000); };
  const collect = (chunk: Buffer, standard: boolean): void => {
    if (log.length + chunk.length > 2 * 1024 * 1024) { exceeded = true; stop(); return; }
    log += chunk.toString(); if (standard) stdout += chunk.toString();
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, true)); child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  const code = await new Promise<number>((accept, reject) => {
    child.once("error", reject); child.once("close", (status) => accept(timedOut || exceeded ? 1 : status ?? 1));
  }).finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
  await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
  commands.push({ args: arguments_, code, seconds: (performance.now() - began) / 1000 });
  return { code, stdout };
}
async function required(arguments_: string[], timeout?: number): Promise<string> {
  const executed = await docker(arguments_, timeout);
  if (executed.code !== 0) throw new Error(`Owned backend fixture failed; inspect ${output}.`);
  return executed.stdout;
}
async function manifest(path: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const entries = await readdir(path, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Frozen distribution must not contain symlinks.");
    if (entry.isDirectory()) Object.assign(files, await manifest(join(path, entry.name), name));
    else if (entry.isFile()) files[name] = await fileSha256(join(path, entry.name));
    else throw new Error("Unexpected distribution file type.");
  }
  return files;
}
async function regular(path: string): Promise<void> {
  const status = await lstat(path); if (!status.isFile() || status.isSymbolicLink()) throw new Error("Fixtures must be regular files.");
}
const seccomp = join(baseline, "electron-seccomp.json");
try {
  for (const path of [model, tiny, audio, seccomp]) await regular(path);
  if ((await lstat(model)).size !== PARAKEET_FIXTURE.bytes || await fileSha256(model) !== PARAKEET_FIXTURE.sha256 ||
      await fileSha256(tiny) !== "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" ||
      (await lstat(audio)).size !== 704_000 || await fileSha256(audio) !== "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0" ||
      await fileSha256(seccomp) !== "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e") throw new Error("Fixture/security policy checksum mismatch.");
  const cpu = nativeBuildManifestSchema.parse(JSON.parse(await readFile(join(build, "cpu/build-manifest.json"), "utf8")));
  const vulkan = nativeBuildManifestSchema.parse(JSON.parse(await readFile(join(build, "vulkan/build-manifest.json"), "utf8")));
  for (const candidate of [cpu, vulkan]) {
    if (candidate.platform !== "linux" || candidate.architecture !== "x64" ||
        await fileSha256(join(build, candidate.backend, "openwhisper_speech.node")) !== candidate.bindingSha256 ||
        await fileSha256(join(build, candidate.backend, "CMakeCache.txt")) !== candidate.cmakeCacheSha256) throw new Error("Compiled backend provenance mismatch.");
  }
  if (cpu.backend !== "cpu" || vulkan.backend !== "vulkan") throw new Error("Wrong owned backend profiles.");
  const attribution = await readFile(join(resolve(model, ".."), "MODEL-ATTRIBUTION.md"), "utf8");
  if (!attribution.includes(PARAKEET_FIXTURE.originalCard) || !attribution.includes(PARAKEET_FIXTURE.license) ||
      !attribution.includes(PARAKEET_FIXTURE.conversionCard)) throw new Error("Model attribution must accompany the public fixture.");
  const originalDist = await manifest(distribution);
  await cp(distribution, join(output, "frozen-dist"), { recursive: true });
  if (JSON.stringify(originalDist) !== JSON.stringify(await manifest(join(output, "frozen-dist")))) throw new Error("Distribution copy changed.");
  await cp(join(build, "vulkan/openwhisper_speech.node"), join(output, "frozen-dist/native/openwhisper_speech.node"));
  const actualDist = await manifest(join(output, "frozen-dist"));
  const electronSha256 = await fileSha256(join(root, "node_modules/electron/dist/electron"));
  const input = ownedGpuInputSchema.parse({ mode, cpuSha256: cpu.bindingSha256, vulkanSha256: vulkan.bindingSha256, electronSha256 });
  await writeFile(join(output, "backend-input.json"), JSON.stringify(input), { mode: 0o600 });
  await buildOwnedGpuProbe(join(output, "probe.mjs"));
  const sources: Record<string, string> = {};
  for (const path of ["tests/owned-gpu/run.ts", "tests/owned-gpu/probe.ts", "tests/owned-gpu/contract.ts", "tests/owned-gpu/acceptance.test.ts",
    "tests/owned-gpu/build-probe.ts", "tests/fixtures/speech-bootstrap-channel.ts",
    "src/workers/speech-bootstrap.ts", "src/workers/speech-control.ts", "src/workers/speech-entry.ts", "src/workers/speech-protocol.ts", "src/services/speech/speech-client.ts", "tests/fixtures/parakeet-model.ts", "tests/owned-gpu/Dockerfile", "tests/owned-gpu/LoaderAbsent.Dockerfile"]) {
    sources[path] = await fileSha256(join(root, path));
    const destination = join(output, "frozen-source", path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(join(root, path), destination, { force: false, errorOnExist: true });
    if (await fileSha256(destination) !== sources[path] || await fileSha256(join(root, path)) !== sources[path]) {
      throw new Error("Owned source changed during snapshot.");
    }
  }
  await writeFile(join(output, "image-inspect.json"), await required(["image", "inspect", image]), { mode: 0o600 });
  await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "4g", "--shm-size", "256m",
    "--entrypoint", "/bin/sleep", image, "1200"]);
  created = true;
  await required(["cp", "-a", join(output, "frozen-dist"), `${container}:/owned-app/dist`]);
  for (const path of ["node_modules", "package.json", "package-lock.json", "tsconfig.json"]) await required(["cp", "-a", join(root, path), `${container}:/owned-app/`]);
  await mkdir(join(output, "test-source/tests/owned-gpu"), { recursive: true, mode: 0o700 });
  for (const file of ["acceptance.test.ts", "contract.ts"]) await cp(join(root, "tests/owned-gpu", file), join(output, "test-source/tests/owned-gpu", file));
  await required(["cp", "-a", join(output, "test-source/tests"), `${container}:/owned-app/`]);
  await required(["cp", "-a", join(output, "probe.mjs"), `${container}:/owned-app/tests/owned-gpu/`]);
  for (const [path, filename] of [[model, PARAKEET_FIXTURE.filename], [tiny, "ggml-tiny.bin"], [audio, "jfk.f32"],
    [join(build, "cpu/openwhisper_speech.node"), "cpu.node"], [join(output, "backend-input.json"), "backend-input.json"],
    [join(resolve(model, ".."), "MODEL-ATTRIBUTION.md"), "MODEL-ATTRIBUTION.md"]]) {
    if (!path || !filename) throw new Error("Missing fixed fixture path.");
    await required(["cp", "-a", path, `${container}:/fixtures/${filename}`]);
  }
  const inspected = await required(["inspect", container]); await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  z.array(z.object({ Image: z.literal(image), Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1),
      Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private") }), Mounts: z.array(z.unknown()).length(0),
  })).length(1).parse(JSON.parse(inspected));
  await required(["start", container]);
  if (mode === "loader-absent") await required(["exec", "--user", "1000:1000", container, "/bin/rm", "--", "/owned-app/node_modules/electron/dist/libvulkan.so.1"]);
  if (mode === "software-only") {
    const device = await required(["exec", "--user", "1000:1000", "--env", "VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json",
      "--env", "XDG_RUNTIME_DIR=/tmp", container, "vulkaninfo", "--summary"]);
    if (!/deviceType\s*=\s*PHYSICAL_DEVICE_TYPE_CPU/u.test(device) || !/llvmpipe/iu.test(device)) throw new Error("Expected private software CPU Vulkan device only.");
    await writeFile(join(output, "software-device.txt"), device, { mode: 0o600 });
  }
  await required(["cp", `${container}:/etc/openwhisper-gpu-test-packages.txt`, join(output, "distro-packages.txt")]);
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ image, input, cpu, vulkan, sources, originalDist, actualDist,
    compiledBuild: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/), modified: z.boolean() })
      .parse(JSON.parse(await readFile(join(distribution, "resources/development-build.json"), "utf8"))),
    model: PARAKEET_FIXTURE, packageLockSha256: await fileSha256(join(root, "package-lock.json")),
    seccompSha256: await fileSha256(seccomp), probeSha256: await fileSha256(join(output, "probe.mjs")),
    electronBundledLoaderSha256BeforeOwnedFault: await fileSha256(join(root, "node_modules/electron/dist/libvulkan.so.1")),
    scope: "Frozen development distribution plus distinct verified CPU/Vulkan native profiles. Only the private fixture binding changes; no production factory, host application, services, devices or stable storage touched." }, null, 2), { mode: 0o600 });
  const executed = await docker(["exec", "--user", "1000:1000", "--env", "OPENWHISPER_OWNED_GPU_TEST=1", "--env", "OPENWHISPER_GPU_EVIDENCE=/evidence",
    container, "/opt/node/bin/node", "--import", "tsx", "--test", "tests/owned-gpu/acceptance.test.ts"], 330_000);
  await required(["cp", `${container}:/evidence/.`, output]);
  if (executed.code !== 0) throw new Error("Owned backend runtime test failed; inspect bounded logs.");
  if (JSON.stringify(actualDist) !== JSON.stringify(await manifest(join(output, "frozen-dist")))) throw new Error("Frozen payload changed.");
  result = "PASS";
} finally {
  if (created) {
    const removed = await docker(["rm", "--force", container], 30_000);
    const remaining = await docker(["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"], 30_000);
    cleanupConfirmed = removed.code === 0 && remaining.code === 0 && remaining.stdout.trim() === "";
  }
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ result, started, completed: new Date().toISOString(), mode, image,
    container, commands, created, cleanupConfirmed }, null, 2), { mode: 0o600 });
  if (created && !cleanupConfirmed) throw new Error("Owned runtime cleanup was not confirmed.");
}
console.log(`PASS: owned ${mode} native backend test; evidence ${output}`);

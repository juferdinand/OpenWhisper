import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { publicFixtureSamples } from "../../scripts/fetch-speech-fixtures.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputArgument = process.argv[2];
if (!outputArgument || !isAbsolute(outputArgument)) throw new Error("An absolute ignored evidence directory is required.");
const output = outputArgument;
const restartProbe = process.argv.includes("--restarts");
const short = process.argv[3] === "--short" || restartProbe;
await mkdir(output, { recursive: true, mode: 0o700 });
const name = `openwhisper-owned-capture-${randomUUID()}`, image = `openwhisper-owned-capture:${randomUUID()}`;
const manifest: Record<string, string> = {};
let serial = 0;
async function docker(args: string[], timeout = 90000): Promise<string> {
  const log = join(output, `${String(++serial).padStart(2, "0")}-docker.log`);
  return await new Promise<string>((accept, reject) => {
    const child = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Owned container operation timed out.")); }, timeout);
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      void writeFile(log, `${stdout}${stderr}`, { mode: 0o600 }).then(() => {
        if (code === 0) accept(stdout); else reject(new Error(`Owned capture command failed (${serial}).`));
      }, reject);
    });
  });
}
const inputs = ["package.json", "native/node-headers.json", "native/capture/miniaudio-source.json", "native/capture/CMakeLists.txt",
  "native/capture/capture.cpp", "native/capture/miniaudio.c", "native/capture/README.md", "native/capture/.gitignore", "native/capture/notices/miniaudio-LICENSE",
  "native/capture/notices/miniaudio-header-LICENSE", "scripts/build-capture.ts", "src/workers/recording/native-capture.ts",
  "src/workers/recording/capture-protocol.ts", "src/services/recording/capture.ts", "tests/recording/capture.test.ts", "tests/owned-capture/run-virtual.ts",
  "tests/owned-capture/capture-worker.ts", "tests/owned-capture/Dockerfile", "tests/owned-capture/run.ts", "scripts/fetch-speech-fixtures.ts"];
for (const path of inputs) manifest[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
const publicSpeech = publicFixtureSamples(await readFile(join(root, "vendor/whisper.cpp/samples/jfk.wav")));
await writeFile(join(output, "public-jfk.f32"), publicSpeech, { mode: 0o600 });
await writeFile(join(output, "input-manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
let created = false;
try {
  await docker(["build", "--tag", image, join(root, "tests/owned-capture")], 900000);
  const imageId = (await docker(["image", "inspect", "--format", "{{.Id}}", image])).trim();
  await docker(["create", "--name", name, "--user", "1000:1000", "--network=none", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--pids-limit=256", "--cpus=4", "--memory=4g", "--shm-size=64m", imageId, "/bin/sleep", "1800"]);
  created = true;
  const inspectRaw = await docker(["inspect", name]);
  const config = z.array(z.object({ Image: z.string(), Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false),
      CapDrop: z.array(z.string()).refine((values) => values.includes("ALL")),
      Binds: z.null(), Devices: z.array(z.unknown()).nullable().refine((values) => values === null || values.length === 0),
      SecurityOpt: z.array(z.string()).refine((values) => values.includes("no-new-privileges")) }),
    Mounts: z.array(z.unknown()).length(0) })).length(1).parse(JSON.parse(inspectRaw) as unknown);
  await writeFile(join(output, "container-inspect.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
  await docker(["start", name]);
  await docker(["exec", name, "mkdir", "-p", "/capture-source/native/capture/notices", "/capture-source/scripts", "/capture-source/src/workers",
    "/capture-source/src/services", "/capture-source/tests/owned-capture", "/capture-source/vendor"]);
  for (const path of inputs) await docker(["cp", "--archive", join(root, path), `${name}:/capture-source/${path}`]);
  for (const path of ["node_modules", "vendor/node-headers", "vendor/miniaudio"]) {
    await docker(["cp", "--archive", join(root, path), `${name}:/capture-source/${path}`], 180000);
  }
  await docker(["cp", "--archive", join(output, "public-jfk.f32"), `${name}:/capture-source/public-jfk.f32`]);
  await docker(["exec", "--workdir=/capture-source", name, "/opt/node/bin/node", "--import", "tsx", "scripts/build-capture.ts"], 120000);
  await docker(["exec", "--workdir=/capture-source", "--env=OPENWHISPER_CAPTURE_SYNTHETIC_ADDON=/capture-source/native/capture/build/openwhisper_capture.node",
    name, "/opt/node/bin/node", "--import", "tsx", "--test", "tests/recording/capture.test.ts"]);
  await docker(["exec", "--workdir=/capture-source", "--env=OPENWHISPER_OWNED_CAPTURE=1", name, "/opt/node/bin/node", "--import", "tsx",
    "tests/owned-capture/run-virtual.ts", "/capture-source/native/capture/build/openwhisper_capture.node", "/evidence", "/capture-source/public-jfk.f32",
    ...(short ? ["--short"] : []), ...(restartProbe ? ["--restarts"] : [])], 450000);
  await docker(["cp", "--archive", `${name}:/evidence/.`, output]);
  for (const path of ["native/capture/build/openwhisper_capture.node", "native/capture/build/CMakeCache.txt",
    "native/capture/build/compile_commands.json"]) await docker(["cp", "--archive", `${name}:/capture-source/${path}`, output]);
  await writeFile(join(output, "result.json"), JSON.stringify({ status: short ? "SHORT_PASS" : "PASS", image: imageId, uid: 1000,
    network: "none", hostMounts: false, devices: false, nativeScope: "Linux-Pulse-only", fixture: "public-JFK-and-generated-tone" }, null, 2), { mode: 0o600 });
} finally {
  if (created) {
    try { await docker(["cp", "--archive", `${name}:/evidence/.`, output]); } catch { /* Preserve any available failure checkpoints. */ }
    try { await docker(["cp", "--archive", `${name}:/capture-source/native/capture/build/openwhisper_capture.node`, output]); } catch { /* Build might not have completed. */ }
    try { await docker(["rm", "--force", name]); } catch { /* Retained evidence remains outside the owned container. */ }
  }
}

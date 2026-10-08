import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PARAKEET_FIXTURE } from "../../scripts/fetch-parakeet-fixture.js";
import { buildParakeetProbe } from "./build-probe.js";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const image = "sha256:3031f986bb255608939c32b3929435c929efb4ce9be398786e369b1111d73431";
const addonSha = "e1b4c2c738285eb50cea155e65fc0b1eb4481e80a1849ded23bb2a8a679308c3";
const args = process.argv.slice(2);
if (args.length !== 8 || args[0] !== "--output" || args[2] !== "--model" || args[4] !== "--jfk" || args[6] !== "--baseline") {
  throw new Error("Usage: tsx tests/owned-parakeet/run.ts --output NEW_DIRECTORY --model PINNED_MODEL --jfk PINNED_F32 --baseline RUN4_DIRECTORY");
}
const absolutePath = z.string().refine(isAbsolute);
const values = z.tuple([absolutePath, absolutePath, absolutePath, absolutePath]).parse([args[1], args[3], args[5], args[7]]);
const [output, model, audio, baseline] = values;
if (!output || !model || !audio || !baseline || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) {
  throw new Error("The launcher requires an ordinary x64 Linux owner and explicit absolute fixture paths.");
}
await mkdir(output, { recursive: false, mode: 0o700 });
const container = `openwhisper-owned-parakeet-${randomUUID()}`;
let sequence = 0;
const commands: { args: string[]; code: number; seconds: number }[] = [];
const started = new Date().toISOString();
let result = "FAIL";
let created = false;
let cleanupConfirmed = false;

async function docker(arguments_: string[], timeout = 60_000): Promise<{ code: number; stdout: string }> {
  const start = performance.now();
  const process_ = spawn("docker", arguments_, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "", log = "", timedOut = false;
  let force: NodeJS.Timeout | undefined;
  const collect = (chunk: Buffer, standard: boolean): void => {
    if (standard && stdout.length < 1024 * 1024) stdout += chunk.toString().slice(0, 1024 * 1024 - stdout.length);
    if (log.length < 1024 * 1024) log += chunk.toString().slice(0, 1024 * 1024 - log.length);
  };
  process_.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
  process_.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
  const timer = setTimeout(() => {
    timedOut = true; process_.kill("SIGTERM");
    force = setTimeout(() => process_.kill("SIGKILL"), 5000);
  }, timeout);
  const code = await new Promise<number>((accept, reject) => {
    process_.once("error", reject); process_.once("close", (status) => accept(timedOut ? 1 : status ?? 1));
  }).finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
  await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
  commands.push({ args: arguments_, code, seconds: (performance.now() - start) / 1000 });
  return { code, stdout };
}
async function required(arguments_: string[], timeout?: number): Promise<string> {
  const executed = await docker(arguments_, timeout);
  if (executed.code !== 0) throw new Error(`Owned fixture command failed; inspect ${output}.`);
  return executed.stdout.trim();
}
async function sha(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
async function regular(path: string): Promise<void> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("Pinned inputs must be regular files.");
}
async function manifest(root: string, prefix = ""): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    const name = join(prefix, item.name);
    if (item.isSymbolicLink()) throw new Error("Frozen distribution cannot contain symlinks.");
    if (item.isDirectory()) Object.assign(entries, await manifest(join(root, item.name), name));
    else if (item.isFile()) entries[name] = await sha(join(root, item.name));
  }
  return entries;
}
const addon = join(baseline, "ubuntu22-openwhisper_speech.node");
const seccomp = join(baseline, "electron-seccomp.json");
try {
  for (const path of [model, audio, addon, seccomp]) await regular(path);
  if ((await lstat(model)).size !== PARAKEET_FIXTURE.bytes || await sha(model) !== PARAKEET_FIXTURE.sha256 ||
      (await lstat(audio)).size !== 704_000 || await sha(audio) !== "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0" ||
      await sha(addon) !== addonSha || await sha(seccomp) !== "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e") {
    throw new Error("Owned public fixture, CPU addon or security-policy pin did not match.");
  }
  const previous = z.object({ image: z.literal(image), baselineAddon: z.literal(addonSha), nativeSource: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(join(baseline, "input-provenance.json"), "utf8")));
  const nativeSource: Record<string, string> = {};
  for (const [name, expected] of Object.entries(previous.nativeSource)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Invalid native source provenance.");
    nativeSource[name] = await sha(join(packageRoot, "native", name));
    if (nativeSource[name] !== expected) throw new Error("The existing Ubuntu22 addon does not match current native source.");
  }
  const attribution = await readFile(join(resolve(model, ".."), "MODEL-ATTRIBUTION.md"), "utf8");
  if (!attribution.includes(PARAKEET_FIXTURE.originalCard) || !attribution.includes(PARAKEET_FIXTURE.license) ||
      !attribution.includes(PARAKEET_FIXTURE.conversionCard)) throw new Error("Pinned model attribution is missing.");
  const distBefore = await manifest(join(packageRoot, "dist"));
  await cp(join(packageRoot, "dist"), join(output, "frozen-dist"), { recursive: true });
  if (JSON.stringify(distBefore) !== JSON.stringify(await manifest(join(output, "frozen-dist")))) throw new Error("Distribution copy changed.");
  await mkdir(join(output, "frozen-dist/native"), { recursive: true, mode: 0o700 });
  await cp(addon, join(output, "frozen-dist/native/openwhisper_speech.node"));
  const actualDist = await manifest(join(output, "frozen-dist"));
  await buildParakeetProbe(output);
  const sources: Record<string, string> = {};
  for (const path of ["tests/owned-parakeet/run.ts", "tests/owned-parakeet/build-probe.ts", "tests/owned-parakeet/processor.ts",
    "tests/fixtures/parakeet-speech.ts", "tests/parakeet-speech.test.ts", "scripts/fetch-parakeet-fixture.ts", "tests/fixtures/parakeet-model.ts",
    "tests/fixtures/speech-bootstrap-channel.ts", "src/services/speech-client.ts", "src/services/adaptive-speech.ts",
    "src/core/transcript-cleaner.ts", "src/core/vocabulary-corrector.ts", "src/core/snippet-expander.ts",
    "src/workers/speech-entry.ts", "src/workers/speech-bootstrap.ts", "src/workers/speech-control.ts", "src/workers/speech-protocol.ts", "native/whisper-source.json", "native/node-headers.json"]) {
    sources[path] = await sha(join(packageRoot, path));
    const destination = join(output, "frozen-source", path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(join(packageRoot, path), destination, { force: false, errorOnExist: true });
    if (await sha(destination) !== sources[path] || await sha(join(packageRoot, path)) !== sources[path]) {
      throw new Error("Owned source changed during snapshot.");
    }
  }
  const inspectedImage = await required(["image", "inspect", image]);
  await writeFile(join(output, "image-inspect.json"), inspectedImage, { mode: 0o600 });
  await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "4g", "--shm-size", "256m",
    "--entrypoint", "/bin/sleep", image, "1200"]);
  created = true;
  await required(["cp", "-a", join(output, "frozen-dist"), `${container}:/owned-app/dist`]);
  for (const path of ["tests", "node_modules", "package.json", "package-lock.json", "tsconfig.json"]) {
    await required(["cp", "-a", join(packageRoot, path), `${container}:/owned-app/`]);
  }
  await mkdir(join(output, "scripts"), { mode: 0o700 });
  await cp(join(packageRoot, "scripts/fetch-parakeet-fixture.ts"), join(output, "scripts/fetch-parakeet-fixture.ts"));
  await required(["cp", "-a", join(output, "scripts"), `${container}:/owned-app/scripts`]);
  for (const file of ["probe.mjs", "processor.mjs"]) await required(["cp", "-a", join(output, file), `${container}:/owned-app/tests/owned-parakeet/`]);
  await required(["cp", "-a", model, `${container}:/fixtures/${PARAKEET_FIXTURE.filename}`]);
  await required(["cp", "-a", audio, `${container}:/fixtures/jfk.f32`]);
  await required(["cp", "-a", join(resolve(model, ".."), "MODEL-ATTRIBUTION.md"), `${container}:/fixtures/`]);
  const inspected = await required(["inspect", container]);
  await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  z.array(z.object({ Image: z.literal(image), Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1),
      Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private"), }), Mounts: z.array(z.unknown()).length(0),
  })).length(1).parse(JSON.parse(inspected));
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ image, nativeSource, sources, originalDist: distBefore, actualDist,
    compiledBuild: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/), modified: z.boolean() })
      .parse(JSON.parse(await readFile(join(output, "frozen-dist/resources/development-build.json"), "utf8"))),
    model: PARAKEET_FIXTURE, addonSha256: addonSha, baseline, electronSha256: await sha(join(packageRoot, "node_modules/electron/dist/electron")),
    packageLockSha256: await sha(join(packageRoot, "package-lock.json")), seccompSha256: await sha(seccomp),
    probeSha256: await sha(join(output, "probe.mjs")), processorSha256: await sha(join(output, "processor.mjs")),
    scope: "Reused exact reviewed Ubuntu22 CPU addon/source graph; fresh private Dev distribution. No native rebuild, GPU, microphone, host mounts, services or stable data.",
  }, null, 2), { mode: 0o600 });
  await required(["start", container]);
  await required(["cp", `${container}:/etc/openwhisper-test-packages.txt`, join(output, "distro-packages.txt")]);
  const executed = await docker(["exec", "--user", "1000:1000", "--env", "OPENWHISPER_OWNED_PARAKEET_TEST=1",
    "--env", "OPENWHISPER_PARAKEET_EVIDENCE=/evidence", container,
    "/opt/node/bin/node", "--import", "tsx", "--test", "tests/parakeet-speech.test.ts"], 450_000);
  await required(["cp", `${container}:/evidence/.`, output]);
  if (executed.code !== 0) throw new Error("Genuine Parakeet owned test failed; inspect its bounded logs.");
  if (JSON.stringify(actualDist) !== JSON.stringify(await manifest(join(output, "frozen-dist")))) throw new Error("Frozen distribution changed.");
  result = "PASS";
} finally {
  if (created) {
    const removed = await docker(["rm", "--force", container], 30_000);
    const remaining = await docker(["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"], 30_000);
    cleanupConfirmed = removed.code === 0 && remaining.code === 0 && remaining.stdout.trim() === "";
  }
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ result, started, completed: new Date().toISOString(),
    image, container, created, cleanupConfirmed, commands, output }, null, 2), { mode: 0o600 });
  if (created && !cleanupConfirmed) throw new Error("Owned container cleanup was not confirmed.");
}
console.log(`PASS: genuine Parakeet CPU utility acceptance; evidence ${output}`);

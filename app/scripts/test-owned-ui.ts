import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const fixtureRoot = join(packageRoot, "tests", "owned-ui");
const id = randomUUID();
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1])) {
  throw new Error("Usage: node --import tsx scripts/test-owned-ui.ts [--output NEW_DIRECTORY]");
}
if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) {
  throw new Error("Run the owned UI launcher on x86_64 Linux as an ordinary user.");
}
const output = resolve(args[1] ?? join(packageRoot, ".local", "owned-ui", id));
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: false, mode: 0o700 });
const container = `openwhisper-owned-ui-${id}`;
const imageTag = `openwhisper-owned-ui:${id}`;
const commands: { args: string[]; exitCode: number; seconds: number }[] = [];
let sequence = 0;

async function docker(arguments_: string[], timeout = 300_000): Promise<{ code: number; stdout: string }> {
  const start = performance.now();
  const log = join(output, `${String(++sequence).padStart(2, "0")}-docker.log`);
  const child = spawn("docker", arguments_, { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "";
  let combined = "";
  let timedOut = false;
  let forceTimer: NodeJS.Timeout | undefined;
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); combined += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { combined += chunk.toString(); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => { child.kill("SIGKILL"); }, 5000);
  }, timeout);
  const code = await new Promise<number>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (value) => { accept(timedOut ? 1 : value ?? 1); });
  }).finally(() => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); });
  await writeFile(log, combined, { mode: 0o600 });
  commands.push({ args: arguments_, exitCode: code, seconds: (performance.now() - start) / 1000 });
  return { code, stdout };
}

async function required(arguments_: string[], timeout?: number): Promise<string> {
  const result = await docker(arguments_, timeout);
  if (result.code !== 0) throw new Error(`Owned UI docker ${arguments_[0]} failed; inspect ${output}.`);
  return result.stdout.trim();
}

async function sha(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileManifest(root: string, prefix = ""): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Frozen application assets must not contain symlinks.");
    if (entry.isDirectory()) Object.assign(hashes, await fileManifest(join(root, entry.name), relative));
    else if (entry.isFile()) hashes[relative] = await sha(join(root, entry.name));
  }
  return hashes;
}

async function pinnedDownload(url: string, expected: string, path: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error("Owned sandbox policy download failed.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Owned sandbox policy checksum mismatch.");
  await writeFile(path, bytes, { mode: 0o600 });
  return bytes;
}

const policy = z.strictObject({
  upstream: z.strictObject({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), licenseUrl: z.url(), licenseSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  namespaceMask: z.literal(2114060288),
  namespaceFlags: z.tuple([z.literal(268435456), z.literal(805306368), z.literal(1342177280), z.literal(1879048192), z.literal(536870912), z.literal(1073741824), z.literal(1610612736)]),
  allowChroot: z.literal(true), scope: z.string(),
}).parse(JSON.parse(await readFile(join(fixtureRoot, "seccomp.json"), "utf8")));

let result = "FAIL";
try {
  for (const path of ["dist/main/index.js", "dist/preload/index.cjs", "node_modules/electron/dist/electron"]) {
    await access(join(packageRoot, path));
  }
  const distBefore = await fileManifest(join(packageRoot, "dist"));
  const policyBytes = await pinnedDownload(policy.upstream.url, policy.upstream.sha256, join(output, "moby-default-seccomp.json"));
  await pinnedDownload(policy.upstream.licenseUrl, policy.upstream.licenseSha256, join(output, "LICENSE-moby"));
  const upstream = z.object({
    defaultAction: z.literal("SCMP_ACT_ERRNO"),
    syscalls: z.array(z.object({ names: z.array(z.string()), action: z.string() }).passthrough()),
  }).passthrough().parse(JSON.parse(new TextDecoder().decode(policyBytes)));
  upstream.syscalls.push({ names: ["chroot"], action: "SCMP_ACT_ALLOW" });
  for (const flags of policy.namespaceFlags) {
    upstream.syscalls.push({ names: ["clone"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: policy.namespaceMask, valueTwo: flags, op: "SCMP_CMP_MASKED_EQ" }] });
    upstream.syscalls.push({ names: ["unshare"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: flags, op: "SCMP_CMP_EQ" }] });
  }
  const seccomp = join(output, "electron-seccomp.json");
  await writeFile(seccomp, JSON.stringify(upstream, null, 2), { mode: 0o600 });
  console.log("Building the pinned, private owned UI image; no application runs during provisioning.");
  await required(["build", "--tag", imageTag, fixtureRoot], 900_000);
  const image = await required(["image", "inspect", imageTag, "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Unexpected owned image identity.");
  await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000",
    "--cap-drop", "ALL", "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "3g", "--shm-size", "256m",
    "--entrypoint", "/bin/sleep", image, "300"]);
  const source = await fileManifest(join(packageRoot, "src"));
  for (const path of ["dist", "src", "tests", "node_modules", "package.json", "package-lock.json", "tsconfig.json"]) {
    await required(["cp", join(packageRoot, path), `${container}:/owned-app/`]);
  }
  if (JSON.stringify(await fileManifest(join(packageRoot, "src"))) !== JSON.stringify(source)) {
    throw new Error("Application source changed while copying the owned acceptance inputs.");
  }
  const inspected = await required(["inspect", container]);
  await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
  const [configuration] = z.array(z.object({
    Config: z.object({ User: z.literal("1000:1000") }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false),
      CapDrop: z.array(z.literal("ALL")).length(1), Devices: z.array(z.unknown()).length(0),
      PidMode: z.literal(""), IpcMode: z.literal("private"), }),
    Mounts: z.array(z.unknown()).length(0),
  })).length(1).parse(JSON.parse(inspected));
  if (!configuration) throw new Error("Missing owned container configuration.");
  await required(["start", container]);
  await required(["cp", `${container}:/etc/openwhisper-test-packages.txt`, join(output, "distro-packages.txt")]);
  console.log("Running only the Dev UI on a private display with Chromium sandbox enabled.");
  const run = await docker(["exec", "--user", "1000:1000", "--env", "DEBUG=pw:browser",
    "--env", "OPENWHISPER_OWNED_UI_TEST=1", "--env", "OPENWHISPER_UI_EVIDENCE=/evidence",
    container, "/opt/node/bin/node", "--import", "tsx", "--test", "tests/application/electron-ui.test.ts"], 180_000);
  await required(["cp", `${container}:/evidence/.`, output]);
  if (run.code !== 0) throw new Error(`Owned Electron UI failed; inspect ${output}.`);
  if (JSON.stringify(await fileManifest(join(packageRoot, "dist"))) !== JSON.stringify(distBefore)) {
    throw new Error("Application build changed during owned acceptance; rerun the frozen candidate.");
  }
  await writeFile(join(output, "input-provenance.json"), JSON.stringify({ image, dist: distBefore, source,
    electron: await sha(join(packageRoot, "node_modules/electron/dist/electron")),
    test: await sha(join(packageRoot, "tests/application/electron-ui.test.ts")),
    launcher: await sha(fileURLToPath(import.meta.url)),
    policy: await sha(join(fixtureRoot, "seccomp.json")), dockerfile: await sha(join(fixtureRoot, "Dockerfile")),
    nodeVersion: "24.21.0", scope: "Owned Dev UI preferences, security and profile isolation; no microphone, clipboard, trigger, dictation or real model quality acceptance",
  }, null, 2), { mode: 0o600 });
  result = "PASS";
} finally {
  await docker(["rm", "--force", container], 30_000);
  await writeFile(join(output, "launcher-result.json"), JSON.stringify({ result, commands, output }, null, 2), { mode: 0o600 });
}
console.log(`PASS: owned Electron Dev UI; evidence ${output}`);

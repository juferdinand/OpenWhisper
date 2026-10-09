import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildManifestSchema, runtimeInputSchema, validateProbeResult } from "./acceptance.js";
import { verifyBuiltSources } from "./build-probe.js";
import { IMAGE, SECCOMP_SHA256, FixtureError, runtimeSchema, suiteSchema } from "./contract.js";
import { HOME } from "./bootstrap.js";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const absolute = z.string().refine((value) => isAbsolute(value) && !value.includes("\0"));
async function hash(path: string): Promise<{ bytes: number; sha256: string }> {
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 512 * 1024 * 1024);
  let count = 0; const digest = createHash("sha256");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat(); assert.equal(opened.ino, before.ino); assert.equal(opened.dev, before.dev);
    for await (const bytes of file.createReadStream({ autoClose: false })) {
      count += bytes.length; assert.ok(count <= before.size); digest.update(bytes);
    }
  } finally { await file.close(); }
  const after = await lstat(path);
  assert.equal(count, before.size); assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
  assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs); return { bytes: count, sha256: digest.digest("hex") };
}
async function jsonFile(path: string, limit = 256 * 1024): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(); assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= limit);
    const bytes = Buffer.alloc(limit + 1); let used = 0;
    while (used < bytes.length) { const result = await file.read(bytes, used, bytes.length - used, null); if (!result.bytesRead) break; used += result.bytesRead; }
    assert.ok(used <= limit); return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
  } finally { await file.close(); }
}
async function files(root: string, prefix = "") {
  const result: Record<string, Awaited<ReturnType<typeof hash>>> = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink());
    if (entry.isDirectory()) Object.assign(result, await files(join(root, entry.name), relative));
    else { assert.ok(entry.isFile()); result[relative] = await hash(join(root, entry.name)); }
  }
  assert.ok(Object.keys(result).length <= 1024); return result;
}

export async function executeReviewedOwnedRetirement(args: readonly string[]): Promise<void> {
  // Deliberate CLI token; importing/building this module never launches Docker.
  if (args.length !== 11 || args[0] !== "--output" || args[2] !== "--bundle" || args[4] !== "--seccomp" ||
    args[6] !== "--runtime" || args[8] !== "--suite" || args[10] !== "--execute-reviewed-owned-retirement" ||
    process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0) throw new FixtureError();
  const output = absolute.parse(args[1]), bundles = absolute.parse(args[3]), seccomp = absolute.parse(args[5]);
  const runtime = runtimeSchema.parse(args[7]), suite = suiteSchema.parse(args[9]);
  const manifest = buildManifestSchema.parse(await jsonFile(join(bundles, "build-manifest.json")));
  await verifyBuiltSources(manifest);
  assert.equal((await hash(seccomp)).sha256, SECCOMP_SHA256);
  for (const [name, expected] of Object.entries(manifest.bundles)) assert.deepEqual(await hash(join(bundles, name)), expected);
  await mkdir(output, { mode: 0o700, recursive: false });
  const staged = join(output, "payload"); await mkdir(staged, { mode: 0o700 });
  for (const name of Object.keys(manifest.bundles)) await cp(join(bundles, name), join(staged, name), { errorOnExist: true, force: false });
  const runtimeRoot = join(packageRoot, "node_modules/electron/dist"), runtimeBefore = await files(runtimeRoot);
  const runtimeStage = join(output, "owned-runtime"); await mkdir(runtimeStage, { mode: 0o700 });
  await cp(runtimeRoot, join(runtimeStage, "electron"), { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await files(join(runtimeStage, "electron")), runtimeBefore); assert.deepEqual(await files(runtimeRoot), runtimeBefore);
  const electron = runtimeBefore["electron"]; assert.ok(electron);
  const input = runtimeInputSchema.parse({ version: 1, image: IMAGE, runtime, suite, seccompSha256: SECCOMP_SHA256,
    build: manifest, electronSha256: electron.sha256, runtimeFiles: runtimeBefore });
  await writeFile(join(staged, "input.json"), JSON.stringify(input, null, 2), { mode: 0o600 });
  await writeFile(join(output, "runtime-files.json"), JSON.stringify(runtimeBefore, null, 2), { mode: 0o600 });
  const container = `openwhisper-owned-retirement-${randomUUID()}`, commands: { args: string[]; code: number; milliseconds: number }[] = [];
  let sequence = 0, status = "FAIL", created = false, cleanupConfirmed = false;
  async function docker(arguments_: string[], timeoutMs = 30_000) {
    const origin = performance.now(), child = spawn("/usr/bin/docker", arguments_, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", log = "", exceeded = false, timedOut = false; let force: NodeJS.Timeout | undefined;
    const stop = (): void => { child.kill("SIGTERM"); force ??= setTimeout(() => { child.kill("SIGKILL"); }, 2000); };
    const collect = (data: Buffer, standard: boolean): void => {
      const text = data.toString(); if (Buffer.byteLength(log) + data.length > 1024 * 1024) { exceeded = true; stop(); return; }
      log += text; if (standard) stdout += text;
    };
    child.stdout.on("data", (data: Buffer) => { collect(data, true); }); child.stderr.on("data", (data: Buffer) => { collect(data, false); });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const code = await new Promise<number>((accept) => { child.once("error", () => { accept(1); }); child.once("close", (value) => { accept(timedOut || exceeded ? 1 : value ?? 1); }); })
      .finally(() => { clearTimeout(timer); clearTimeout(force); });
    await writeFile(join(output, `${String(++sequence).padStart(2, "0")}-docker.log`), log, { mode: 0o600 });
    commands.push({ args: arguments_, code, milliseconds: performance.now() - origin }); return { code, stdout };
  }
  async function required(arguments_: string[], timeoutMs?: number): Promise<string> {
    const result = await docker(arguments_, timeoutMs); if (result.code !== 0) throw new FixtureError(); return result.stdout.trim();
  }
  try {
    // No pulling/building: only this existing immutable local image is permitted.
    const inspectedImage = await required(["image", "inspect", IMAGE]);
    const [image] = z.array(z.object({ Id: z.literal(IMAGE) })).length(1).parse(JSON.parse(inspectedImage)); assert.ok(image);
    await writeFile(join(output, "image-inspect.json"), inspectedImage, { mode: 0o600 });
    created = true;
    await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
      "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "2g", "--shm-size", "256m",
      "--ulimit", "core=0:0", "--entrypoint", "/bin/sleep", IMAGE, "240"]);
    await required(["cp", "-a", staged, `${container}:/payload`]); await required(["cp", "-a", runtimeStage, `${container}:/owned-runtime`]);
    const inspect = await required(["inspect", container]);
    const [configuration] = z.array(z.object({ Image: z.literal(IMAGE), Config: z.object({ User: z.literal("1000:1000") }),
      HostConfig: z.object({ Init: z.literal(true), NetworkMode: z.literal("none"), Privileged: z.literal(false),
        CapDrop: z.array(z.literal("ALL")).length(1), Devices: z.array(z.unknown()).length(0), PidMode: z.literal(""), IpcMode: z.literal("private"),
        Ulimits: z.array(z.object({ Name: z.literal("core"), Hard: z.literal(0), Soft: z.literal(0) })).length(1) }), Mounts: z.array(z.unknown()).length(0),
    })).length(1).parse(JSON.parse(inspect)); assert.ok(configuration);
    await writeFile(join(output, "container-inspect.json"), inspect, { mode: 0o600 }); await required(["start", container]);
    const own = ["exec", "--user", "1000:1000", container];
    await required([...own, "/usr/bin/mkdir", "-m", "700", "-p", HOME, `${HOME}/tmp`, `${HOME}/runtime`]);
    await required([...own, "/usr/bin/chmod", "-R", "a-w", "/payload", "/owned-runtime"]);
    const environment = ["/usr/bin/env", "-i", `HOME=${HOME}`, `XDG_CONFIG_HOME=${HOME}/config`, `XDG_DATA_HOME=${HOME}/data`,
      `XDG_CACHE_HOME=${HOME}/cache`, `XDG_RUNTIME_DIR=${HOME}/runtime`, `TMPDIR=${HOME}/tmp`, "PATH=/opt/node/bin:/usr/bin:/bin",
      "LANG=C.UTF-8", "OPENWHISPER_OWNED_RETIREMENT_TEST=1", `OPENWHISPER_RETIREMENT_SUITE=${suite}`];
    const entry = runtime === "node" ? ["/opt/node/bin/node", "/payload/node-parent.mjs"]
      : ["/usr/bin/xvfb-run", "-a", "-s", "-screen 0 800x600x24 -nolisten tcp", "/owned-runtime/electron/electron",
        "--disable-gpu", "--disable-dev-shm-usage", "/payload/electron-parent.mjs"];
    const ran = await docker([...own, ...environment, ...entry], 180_000);
    await required(["cp", `${container}:/evidence/.`, output]); assert.equal(ran.code, 0);
    const result = validateProbeResult(await jsonFile(join(output, "result.json")), runtime, suite);
    await writeFile(join(output, "accepted.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    await verifyBuiltSources(manifest); for (const [name, expected] of Object.entries(manifest.bundles)) assert.deepEqual(await hash(join(bundles, name)), expected);
    assert.deepEqual(await files(runtimeRoot), runtimeBefore); status = "PASS";
  } finally {
    if (created) {
      await docker(["cp", `${container}:/evidence/.`, output]);
      const removed = await docker(["rm", "--force", container]);
      const absent = await docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`]);
      cleanupConfirmed = absent.code === 0 && absent.stdout.trim() === "";
      assert.ok(removed.code === 0 || cleanupConfirmed);
    }
    await writeFile(join(output, "launcher-result.json"), JSON.stringify({ status: cleanupConfirmed ? status : "FAIL", runtime, suite,
      image: IMAGE, cleanupConfirmed, commands, scope: "Owned synthetic retirement only; no production integration." }, null, 2), { mode: 0o600 });
    assert.equal(cleanupConfirmed, true);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void executeReviewedOwnedRetirement(process.argv.slice(2)).catch(() => { process.stderr.write("Owned retirement fixture failed; inspect private evidence.\n"); process.exitCode = 1; });
}

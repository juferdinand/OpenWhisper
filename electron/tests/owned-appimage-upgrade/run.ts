import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { waitForOriginalCommandClose } from "../owned-supervisor/run.js";
import { artifactSchema, resultSchema, updateInputSchema } from "./contract.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repository = resolve(root, "..");
const workspace = resolve(repository, "../../../");
const localPlanning = join(workspace, ".local/planning/electron-migration");
const IMAGE = "sha256:796933aebc81829a07ba245ea7e10b594f032b2b90bcaf70002ce8395f2c2b33";
const NODE_IMAGE = "sha256:403f066a165681074f19f1977b2b46617d3dd7b072cb7037400dbe01676ed3cb";
const NODE_SHA = "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c";
const SECCOMP_SHA = "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e";
const SECCOMP = join(localPlanning, "p2-owned-speech/run-4/electron-seccomp.json");
const config = join(repository, "linux/src-tauri/tauri.conf.json");
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
type Candidate = { version: string; source: { commit: string; modified: false }; filename: "OpenWhisper-Linux-x86_64.AppImage";
  image: { bytes: number; sha256: string }; signature: { bytes: number; sha256: string } };
const receiptSchema = z.object({ classification: z.enum(["OWNED_OLDER_FIXTURE_APPRUN_HANDOFF", "PRIVATE_NEWER_VERSIONED_PRODUCTION_APPRUN"]),
  version: z.string(), source: z.string().regex(/^[a-f0-9]{40}$/u), image: artifactSchema,
  signature: artifactSchema });
async function regular(path: string, maximum = 1024 ** 3): Promise<Buffer> {
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum);
  const bytes = await readFile(path); assert.equal(bytes.length, stat.size); return bytes;
}
async function candidate(path: string, expectedVersion: string, source: string, verifier: string): Promise<Candidate> {
  assert.equal(resolve(path), path); assert.equal(await realpath(path), path);
  const imagePath = join(path, "OpenWhisper-Linux-x86_64.AppImage");
  const image = await regular(imagePath), signature = await regular(`${imagePath}.sig`, 16 * 1024);
  const receiptBytes = await regular(join(path, "signed-receipt.json"), 64 * 1024), receipt = receiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")) as unknown);
  assert.equal(receipt.version, expectedVersion); assert.equal(receipt.source, source);
  assert.deepEqual(receipt.image, { bytes: image.length, sha256: digest(image) });
  assert.deepEqual(receipt.signature, { bytes: signature.length, sha256: digest(signature) });
  assert.equal(receipt.classification, expectedVersion === "0.3.0" ? "OWNED_OLDER_FIXTURE_APPRUN_HANDOFF" : "PRIVATE_NEWER_VERSIONED_PRODUCTION_APPRUN");
  for (const [version, versionPath] of [[expectedVersion, imagePath]] as const) {
    const verify = spawnSync(verifier, [config, versionPath, `${versionPath}.sig`, version], { shell: false, timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.ifError(verify.error); assert.equal(verify.status, 0); assert.equal(verify.signal, null);
    const reject = spawnSync(verifier, [config, versionPath, `${versionPath}.sig`, "0.0.0"], { shell: false, timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.ifError(reject.error); assert.notEqual(reject.status, 0); assert.equal(reject.signal, null);
  }
  return { version: expectedVersion, source: { commit: source, modified: false }, filename: "OpenWhisper-Linux-x86_64.AppImage",
    image: { bytes: image.length, sha256: digest(image) }, signature: { bytes: signature.length, sha256: digest(signature) } };
}
async function describe(path: string) {
  const stat = await lstat(path, { bigint: true }); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= 1024n ** 3n);
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; assert.ok(bytes <= 1024 ** 3); hash.update(chunk); }
  const after = await lstat(path, { bigint: true });
  for (const field of ["dev", "ino", "uid", "gid", "mode", "size", "nlink", "mtimeNs", "ctimeNs"] as const) assert.equal(after[field], stat[field]);
  assert.equal(BigInt(bytes), stat.size); return { bytes, sha256: hash.digest("hex"), mode: Number(stat.mode & 0o7777n) };
}
async function inventory(directory: string, names: readonly string[]) {
  const entries: Record<string, { bytes: number; sha256: string; mode: number }> = {};
  async function visit(name: string): Promise<void> {
    assert.ok(!name.startsWith("/") && name.split("/").every((part) => part && part !== "." && part !== "..") && !/[\p{Cc}]/u.test(name));
    const path = join(directory, name), stat = await lstat(path); assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) { for (const child of (await readdir(path)).sort()) await visit(`${name}/${child}`); }
    else { assert.ok(stat.isFile()); entries[name] = await describe(path); }
  }
  for (const name of [...names].sort()) await visit(name);
  return entries;
}
function parseArgs(args: readonly string[]) {
  assert.equal(args.length, 8); assert.deepEqual([args[0], args[2], args[4], args[6]], ["--output", "--older", "--newer", "--verifier"]);
  const [output, older, newer, verifier] = [args[1]!, args[3]!, args[5]!, args[7]!];
  for (const path of [output, older, newer, verifier]) assert.ok(resolve(path) === path && !/[\p{Cc}]/u.test(path));
  assert.ok(output.startsWith(`${localPlanning}/`)); assert.notEqual(output, older); assert.notEqual(output, newer);
  assert.equal(verifier, join(workspace, "linux/target/debug/examples/verify-update"));
  return { output, older, newer, verifier };
}
async function execute(args: readonly string[]): Promise<void> {
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64"); assert.equal(process.getuid?.(), 1000);
  const { output, older, newer, verifier } = parseArgs(args);
  const verifierStat = await lstat(verifier); assert.ok(verifierStat.isFile() && !verifierStat.isSymbolicLink() && verifierStat.size > 0 && (verifierStat.mode & 0o111) !== 0);
  assert.equal(await realpath(verifier), verifier);
  await mkdir(output, { mode: 0o700 }); assert.equal(await realpath(output), output);
  const olderInput = await candidate(older, "0.3.0", "16bb0af50432a59a1e741261497d0d6490e83fe7", verifier);
  const newerInput = await candidate(newer, "0.3.1", "8433def6e76231410569cad40909ad85c234893e", verifier);
  const input = updateInputSchema.parse({ repository: "https://github.com/juferdinand/OpenWhisper", older: olderInput, newer: newerInput });
  const payload = join(output, "payload"); await mkdir(payload, { mode: 0o700 });
  for (const name of ["older", "newer"] as const) {
    const source = name === "older" ? older : newer, directory = join(payload, name); await mkdir(directory, { mode: 0o700 });
    const image = join(source, input[name].filename); await cp(image, join(directory, input[name].filename), { errorOnExist: true, force: false });
    await cp(`${image}.sig`, join(directory, `${input[name].filename}.sig`), { errorOnExist: true, force: false });
  }
  await writeFile(join(payload, "input.json"), `${JSON.stringify(input)}\n`, { mode: 0o600 });
  const sources: Record<string, Awaited<ReturnType<typeof describe>>> = {};
  for (const name of ["host", "driver"] as const) {
    const bundled = await build({ entryPoints: [join(root, `tests/owned-appimage-upgrade/${name}.ts`)], outfile: join(payload, `${name}.mjs`),
      absWorkingDir: root, platform: "node", format: "esm", target: "node24", bundle: true, external: ["@playwright/test"], metafile: true, sourcemap: false });
    for (const path of Object.keys(bundled.metafile.inputs)) sources[path] = await describe(resolve(root, path));
  }
  sources["tests/owned-appimage-upgrade/run.ts"] = await describe(fileURLToPath(import.meta.url));
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    await mkdir(dirname(join(payload, "node_modules", name)), { mode: 0o700, recursive: true });
    await cp(join(root, "node_modules", name), join(payload, "node_modules", name), { recursive: true, errorOnExist: true, force: false });
  }
  const seccompBytes = await regular(SECCOMP, 1024 * 1024); assert.equal(digest(seccompBytes), SECCOMP_SHA);
  const seccomp = join(output, "electron-seccomp.json"); await cp(SECCOMP, seccomp, { errorOnExist: true, force: false });
  const dockerConfig = join(output, "docker-config"); await mkdir(dockerConfig, { mode: 0o700 });
  const container = `openwhisper-owned-appimage-upgrade-${randomUUID()}`, nodeContainer = `${container}-node`;
  const commands: unknown[] = [], outstanding = new Set<Promise<unknown>>(); let sequence = 0, created = false, nodeCreated = false, removed = false, status = "FAIL";
  async function docker(argv: string[], milliseconds = 30_000) {
    const start = performance.now(), end = start + milliseconds;
    const child = spawn("/usr/bin/docker", ["--config", dockerConfig, "--host", "unix:///var/run/docker.sock", ...argv],
      { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const number = ++sequence; let outputText = "", stdout = "", size = 0, expired = false, overflow = false;
    let force: NodeJS.Timeout | undefined;
    const stop = (): void => { child.kill("SIGTERM"); force ??= setTimeout(() => { child.kill("SIGKILL"); }, 2000); };
    const collect = (chunk: Buffer, standard: boolean): void => { size += chunk.length; if (size > 1024 * 1024) { overflow = true; stop(); return; }
      const text = chunk.toString("utf8"); outputText += text; if (standard) stdout += text; };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true)); child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    const timer = setTimeout(() => { expired = true; stop(); }, milliseconds);
    const closed = waitForOriginalCommandClose(child, end, () => ({ expired, overflow })); outstanding.add(closed);
    void closed.then(() => { outstanding.delete(closed); clearTimeout(timer); clearTimeout(force); });
    let guard: NodeJS.Timeout | undefined, completion = { code: 1, expired: true, overflow: false, errored: true }, closeObserved = false;
    try { completion = await Promise.race([closed, new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error("DOCKER_COMMAND_CLOSE_MISSING")), milliseconds + 5000); })]); closeObserved = true; }
    catch { stop(); } finally { clearTimeout(guard); }
    await writeFile(join(output, `${String(number).padStart(3, "0")}-docker.log`), outputText, { mode: 0o600 });
    commands.push({ argv, ...completion, closeObserved, elapsedMs: performance.now() - start }); return { ...completion, closeObserved, stdout };
  }
  async function required(argv: string[], milliseconds?: number): Promise<string> {
    const response = await docker(argv, milliseconds); assert.equal(response.code, 0); assert.equal(response.closeObserved, true); return response.stdout.trim();
  }
  let activeDriver: Promise<unknown> | undefined;
  try {
    for (const image of [IMAGE, NODE_IMAGE]) z.array(z.object({ Id: z.literal(image) })).length(1).parse(JSON.parse(await required(["image", "inspect", image])));
    nodeCreated = true;
    await required(["create", "--name", nodeContainer, "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--entrypoint", "/bin/true", NODE_IMAGE]);
    await required(["cp", "-a", `${nodeContainer}:/opt/node/bin/node`, join(payload, "node")]);
    assert.equal((await describe(join(payload, "node"))).sha256, NODE_SHA); await required(["rm", nodeContainer]); nodeCreated = false;
    const frozen = await inventory(payload, await readdir(payload));
    await writeFile(join(output, "assembly.json"), `${JSON.stringify({ input, payload: frozen, image: IMAGE, nodeSourceImage: NODE_IMAGE,
      verifier: { path: verifier, bytes: verifierStat.size, mode: verifierStat.mode & 0o777 }, seccompSha256: SECCOMP_SHA, sources })}\n`, { mode: 0o600 });
    await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "4g", "--shm-size", "256m", "--ulimit", "core=0:0", "--entrypoint", "/bin/sleep", IMAGE, "500"]);
    created = true;
    const payloadTarget = `${container}:/payload`; await required(["cp", "-a", payload, payloadTarget]);
    const evidence = join(output, "initial-evidence"), evidenceTarget = `${container}:/evidence`;
    await mkdir(evidence, { mode: 0o700 }); await required(["cp", "-a", evidence, evidenceTarget]);
    const [configuration] = z.array(z.object({ Image: z.literal(IMAGE), Config: z.object({ User: z.literal("1000:1000") }), State: z.object({ Running: z.literal(false) }),
      HostConfig: z.object({ Init: z.literal(true), NetworkMode: z.literal("none"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1),
        Devices: z.array(z.unknown()).length(0), Binds: z.null(), PidMode: z.literal(""), IpcMode: z.literal("private"), SecurityOpt: z.array(z.string()).length(2),
        PidsLimit: z.literal(256), Memory: z.literal(4 * 1024 ** 3), ShmSize: z.literal(256 * 1024 ** 2),
        Ulimits: z.array(z.object({ Name: z.literal("core"), Soft: z.literal(0), Hard: z.literal(0) })).length(1) }), Mounts: z.array(z.unknown()).length(0) })).length(1).parse(JSON.parse(await required(["inspect", container])));
    assert.ok(configuration); assert.ok(configuration.HostConfig.SecurityOpt.includes("no-new-privileges"));
    const seccompOption = configuration.HostConfig.SecurityOpt.find((value) => value.startsWith("seccomp=")); assert.ok(seccompOption);
    assert.deepEqual(JSON.parse(seccompOption.slice(8)), JSON.parse(seccompBytes.toString("utf8")));
    const roundtrip = join(output, "stopped-payload"); await required(["cp", "-a", `${container}:/payload`, roundtrip]); assert.deepEqual(await inventory(roundtrip, await readdir(roundtrip)), frozen);
    await required(["start", container]);
    const driver = docker(["exec", "--user", "1000:1000", container, "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8",
      "OPENWHISPER_OWNED_APPIMAGE_UPGRADE=1", "/payload/node", "/payload/driver.mjs"], 240_000);
    activeDriver = driver; void driver.catch(() => {});
    const completed = await driver; activeDriver = undefined; assert.equal((completed as { code: number }).code, 0);
    await required(["cp", `${container}:/evidence/.`, output]);
    const accepted = resultSchema.parse(JSON.parse(await readFile(join(output, "result.json"), "utf8")) as unknown);
    assert.equal(accepted.fromVersion, input.older.version); assert.equal(accepted.toVersion, input.newer.version);
    await required(["kill", "--signal", "TERM", container]);
    assert.equal(await required(["wait", container], 15_000), "143");
    const inspected = JSON.parse(await required(["inspect", container])) as [{ State: { Running: boolean; Pid: number; OOMKilled: boolean } }];
    assert.equal(inspected[0]!.State.Running, false); assert.equal(inspected[0]!.State.Pid, 0); assert.equal(inspected[0]!.State.OOMKilled, false);
    await writeFile(join(output, "container-terminal.json"), JSON.stringify(inspected), { mode: 0o600 }); status = "PASS";
  } finally {
    if (activeDriver) await activeDriver.catch(() => {});
    if (nodeCreated) await docker(["rm", "--force", nodeContainer], 20_000);
    if (created) {
      await docker(["cp", `${container}:/evidence/.`, output], 10_000);
      const removedResponse = await docker(status === "PASS" ? ["rm", container] : ["rm", "--force", container], 20_000);
      const absentResponse = await docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`], 10_000);
      removed = removedResponse.code === 0 && removedResponse.closeObserved && absentResponse.code === 0 && absentResponse.closeObserved && !absentResponse.stdout.trim();
    }
    await writeFile(join(output, "launcher-result.json"), `${JSON.stringify({ status: status === "PASS" && removed && outstanding.size === 0 ? "PASS" : "FAIL",
      container, image: IMAGE, removed, originalCommandsClosed: outstanding.size === 0, input, commands,
      scope: "PRIVATE_OWNED_OFFLINE_APPIMAGE_UPGRADE_NO_HOST_SESSION_OR_DEVICES" })}\n`, { mode: 0o600 });
    assert.equal(removed, true); assert.equal(outstanding.size, 0);
  }
  assert.equal(status, "PASS");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void execute(process.argv.slice(2)).catch(() => { process.stderr.write("Owned AppImage upgrade failed; inspect private evidence.\n"); process.exitCode = 1; });
}

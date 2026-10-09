import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { parseApplicationBuildModule } from "../../src/contracts/application/build-identity.js";
import { isNewerUpdateVersion, parseUpdateVersion } from "../../src/services/update/common/update-policy.js";
import { waitForOriginalCommandClose } from "../owned-supervisor/run.js";
import { candidateReceiptSchema, installResponseSchema, resultSchema, upgradeInputSchema } from "./contract.js";

const IMAGE = "sha256:796933aebc81829a07ba245ea7e10b594f032b2b90bcaf70002ce8395f2c2b33";
const NODE_IMAGE = "sha256:403f066a165681074f19f1977b2b46617d3dd7b072cb7037400dbe01676ed3cb";
const SECCOMP_SHA = "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e";
const NODE_SHA = "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c";
const PACKAGE = "OpenWhisper-Linux-x64", ARCHIVE = "OpenWhisper-Linux-amd64.deb";
const absolute = z.string().min(1).max(4096).refine((value) => value === resolve(value) && !/[\p{Cc}]/u.test(value));
type Inventory = { files: Record<string, { bytes: number; sha256: string }>; modes: Record<string, number> };
export function parseUpgradeRunnerArguments(args: readonly string[]) {
  assert.equal(args.length, 8);
  for (const [index, flag] of [[0, "--output"], [2, "--older"], [4, "--newer"], [6, "--artifacts-root"]] as const) assert.equal(args[index], flag);
  const output = absolute.parse(args[1]), older = absolute.parse(args[3]), newer = absolute.parse(args[5]), artifacts = absolute.parse(args[7]);
  for (const input of [older, newer]) assert.ok(output !== input && !output.startsWith(`${input}/`) && !input.startsWith(`${output}/`));
  assert.ok(older !== newer && !older.startsWith(`${newer}/`) && !newer.startsWith(`${older}/`));
  return { output, older, newer, artifacts };
}
async function text(path: string, limit = 8 * 1024 * 1024): Promise<string> {
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit);
  const bytes = await readFile(path); assert.ok(bytes.length <= limit); return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function describe(path: string) {
  const before = await lstat(path, { bigint: true }); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= 1024n ** 3n);
  const hash = createHash("sha256"); let bytes = 0;
  for await (const block of createReadStream(path)) { bytes += block.length; assert.ok(bytes <= 1024 ** 3); hash.update(block); }
  const after = await lstat(path, { bigint: true });
  for (const key of ["dev", "ino", "uid", "gid", "mode", "size", "nlink", "mtimeNs", "ctimeNs"] as const) assert.equal(after[key], before[key]);
  assert.equal(BigInt(bytes), before.size); return { bytes, sha256: hash.digest("hex") };
}
async function inventory(root: string, paths: readonly string[]): Promise<Inventory> {
  assert.equal(await realpath(root), root); const files: Inventory["files"] = {}, modes: Inventory["modes"] = {};
  async function visit(name: string): Promise<void> {
    assert.ok(!name.startsWith("/") && name.split("/").every((part) => part && part !== "." && part !== "..") && !/[\p{Cc}]/u.test(name));
    assert.ok(Object.keys(modes).length < 20_000); const path = join(root, name), stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory())); modes[name] = stat.mode & 0o7777;
    if (stat.isFile()) files[name] = await describe(path);
    else for (const child of (await readdir(path)).sort()) await visit(`${name}/${child}`);
  }
  for (const path of [...paths].sort()) await visit(path); return { files, modes };
}
async function candidate(root: string) {
  const receipt = candidateReceiptSchema.parse(JSON.parse(await text(join(root, "candidate-receipt.json"))));
  assert.ok(Object.keys(receipt.files).length <= 20_000 && Object.keys(receipt.modes).length <= 25_000);
  assert.deepEqual(await inventory(root, [ARCHIVE, PACKAGE]), { files: receipt.files, modes: receipt.modes });
  const app = join(root, PACKAGE, "resources/app"), version = (await text(join(app, "dist/resources/VERSION"), 128)).trim();
  parseUpdateVersion(version); assert.equal(version, receipt.sourceVersion);
  assert.equal(z.object({ version: z.string() }).parse(JSON.parse(await text(join(app, "package.json")))).version, version);
  assert.equal(parseApplicationBuildModule(await text(join(app, "dist/main/application-build.js"))).kind, "stable");
  assert.deepEqual(JSON.parse(await text(join(app, "dist/resources/development-build.json"))), receipt.source);
  assert.ok((await text(join(root, `${ARCHIVE}.sig`), 16 * 1024)).trim());
  const original = await inventory(root, [ARCHIVE, PACKAGE, "candidate-receipt.json", `${ARCHIVE}.sig`]);
  return { original, input: { source: receipt.source, sourceVersion: version, archive: receipt.files[ARCHIVE]!,
    receiptSha256: original.files["candidate-receipt.json"]!.sha256 } };
}

/** Explicit owned namespace runner. Importing this module never invokes Docker or packages. */
export async function executeOwnedDebianUpgrade(args: readonly string[]): Promise<void> {
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64"); assert.equal(process.getuid?.(), 1000);
  const { output, older, newer, artifacts } = parseUpgradeRunnerArguments(args), root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const previous = await candidate(older), successor = await candidate(newer);
  assert.ok(isNewerUpdateVersion(successor.input.sourceVersion, previous.input.sourceVersion)); assert.notEqual(previous.input.source.commit, successor.input.source.commit);
  const input = upgradeInputSchema.parse({ older: previous.input, newer: successor.input });
  const seccomp = join(artifacts, "p2-owned-speech/run-4/electron-seccomp.json"); assert.equal((await describe(seccomp)).sha256, SECCOMP_SHA);
  await mkdir(output, { mode: 0o700 }); const payload = join(output, "payload"); await mkdir(payload, { mode: 0o700 });
  for (const [name, source, expected] of [["older", older, previous.original], ["newer", newer, successor.original]] as const) {
    const destination = join(payload, name); await mkdir(destination, { mode: 0o700 });
    for (const path of [ARCHIVE, PACKAGE, "candidate-receipt.json", `${ARCHIVE}.sig`]) await cp(join(source, path), join(destination, path), { recursive: true, force: false, errorOnExist: true });
    assert.deepEqual(await inventory(destination, [ARCHIVE, PACKAGE, "candidate-receipt.json", `${ARCHIVE}.sig`]), expected);
  }
  await writeFile(join(payload, "input.json"), `${JSON.stringify(input)}\n`, { mode: 0o600 });
  const sources: Record<string, Awaited<ReturnType<typeof describe>>> = {};
  for (const name of ["host", "driver"] as const) {
    const bundled = await build({ entryPoints: [join(root, `tests/owned-debian-upgrade/${name}.ts`)], outfile: join(payload, `${name}.mjs`),
      absWorkingDir: root, platform: "node", format: "esm", target: "node24", bundle: true, external: ["@playwright/test"], metafile: true, sourcemap: false });
    for (const path of Object.keys(bundled.metafile.inputs)) sources[path] = await describe(resolve(root, path));
  }
  sources["tests/owned-debian-upgrade/run.ts"] = await describe(fileURLToPath(import.meta.url));
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    await mkdir(dirname(join(payload, "node_modules", name)), { mode: 0o700, recursive: true });
    await cp(join(root, "node_modules", name), join(payload, "node_modules", name), { recursive: true, errorOnExist: true, force: false });
  }
  const dockerConfig = join(output, "docker-config"); await mkdir(dockerConfig, { mode: 0o700 });
  const container = `openwhisper-owned-debian-upgrade-${randomUUID()}`, nodeContainer = `${container}-node`;
  const commands: unknown[] = [], outstanding = new Set<Promise<unknown>>(); let sequence = 0, created = false, nodeCreated = false, removed = false, result = "FAIL";
  async function docker(argv: string[], milliseconds = 30_000) {
    const started = performance.now(), end = started + milliseconds, child = spawn("/usr/bin/docker", ["--config", dockerConfig, "--host", "unix:///var/run/docker.sock", ...argv],
      { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const number = ++sequence; let log = "", stdout = "", bytes = 0, expired = false, overflow = false, force: NodeJS.Timeout | undefined;
    const stop = (): void => { child.kill("SIGTERM"); force ??= setTimeout(() => { child.kill("SIGKILL"); }, 2000); };
    const collect = (block: Buffer, standard: boolean): void => { bytes += block.length; if (bytes > 1024 * 1024) { overflow = true; stop(); return; }
      const value = block.toString("utf8"); log += value; if (standard) stdout += value; };
    child.stdout.on("data", (block: Buffer) => collect(block, true)); child.stderr.on("data", (block: Buffer) => collect(block, false));
    const timer = setTimeout(() => { expired = true; stop(); }, milliseconds);
    const closed = waitForOriginalCommandClose(child, end, () => ({ expired, overflow })); outstanding.add(closed);
    void closed.then(() => { outstanding.delete(closed); clearTimeout(timer); clearTimeout(force); });
    let guard: NodeJS.Timeout | undefined;
    let completion = { code: 1, expired: true, overflow: false, errored: true }, closureObserved = false;
    try { completion = await Promise.race([closed, new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error("ORIGINAL_CLOSE_MISSING")), milliseconds + 5000); })]); closureObserved = true; }
    catch { stop(); } finally { clearTimeout(guard); }
    await writeFile(join(output, `${String(number).padStart(3, "0")}-docker.log`), log, { mode: 0o600 });
    commands.push({ argv, ...completion, closureObserved, elapsedMs: performance.now() - started }); return { ...completion, closureObserved, stdout };
  }
  async function required(argv: string[], milliseconds?: number): Promise<string> {
    const observed = await docker(argv, milliseconds); assert.equal(observed.code, 0); assert.equal(observed.closureObserved, true); return observed.stdout.trim();
  }
  let activeDriver: ReturnType<typeof docker> | undefined;
  try {
    for (const image of [IMAGE, NODE_IMAGE]) z.array(z.object({ Id: z.literal(image) })).length(1).parse(JSON.parse(await required(["image", "inspect", image])));
    nodeCreated = true;
    await required(["create", "--name", nodeContainer, "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "/bin/true", NODE_IMAGE]);
    z.array(z.object({ Image: z.literal(NODE_IMAGE), State: z.object({ Running: z.literal(false), Pid: z.literal(0) }) })).length(1).parse(JSON.parse(await required(["inspect", nodeContainer])));
    await required(["cp", "-a", `${nodeContainer}:/opt/node/bin/node`, join(payload, "node")]); assert.equal((await describe(join(payload, "node"))).sha256, NODE_SHA);
    await required(["rm", nodeContainer]); nodeCreated = false;
    const frozen = await inventory(payload, await readdir(payload));
    await writeFile(join(output, "assembly.json"), `${JSON.stringify({ input, sources, payload: frozen, image: IMAGE, nodeSourceImage: NODE_IMAGE, seccompSha256: SECCOMP_SHA })}\n`, { mode: 0o600 });
    created = true;
    await required(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE",
      "--security-opt", "no-new-privileges", "--security-opt", `seccomp=${seccomp}`, "--pids-limit", "256", "--memory", "4g", "--shm-size", "256m", "--ulimit", "core=0:0", "--entrypoint", "/bin/sleep", IMAGE, "500"]);
    await required(["cp", "-a", payload, `${container}:/payload`]);
    const evidence = join(output, "initial-evidence"); await mkdir(evidence, { mode: 0o700 }); await required(["cp", "-a", evidence, `${container}:/evidence`]);
    const inspected = await required(["inspect", container]); await writeFile(join(output, "container-inspect.json"), inspected, { mode: 0o600 });
    const [configuration] = z.array(z.object({ Image: z.literal(IMAGE), Config: z.object({ User: z.literal("1000:1000") }), State: z.object({ Running: z.literal(false) }),
      HostConfig: z.object({ Init: z.literal(true), NetworkMode: z.literal("none"), Privileged: z.literal(false), CapDrop: z.array(z.literal("ALL")).length(1),
        CapAdd: z.array(z.enum(["DAC_OVERRIDE", "CAP_DAC_OVERRIDE"])).length(1), Devices: z.array(z.unknown()).length(0), Binds: z.null(), PidMode: z.literal(""), IpcMode: z.literal("private"),
        SecurityOpt: z.array(z.string()).length(2), PidsLimit: z.literal(256), Memory: z.literal(4 * 1024 ** 3), ShmSize: z.literal(256 * 1024 ** 2),
        Ulimits: z.array(z.object({ Name: z.literal("core"), Soft: z.literal(0), Hard: z.literal(0) })).length(1) }), Mounts: z.array(z.unknown()).length(0) })).length(1).parse(JSON.parse(inspected));
    assert.ok(configuration); assert.ok(configuration.HostConfig.SecurityOpt.includes("no-new-privileges"));
    const seccompOption = configuration.HostConfig.SecurityOpt.find((value) => value.startsWith("seccomp=")); assert.ok(seccompOption);
    assert.deepEqual(JSON.parse(seccompOption.slice(8)), JSON.parse(await text(seccomp, 1024 * 1024)));
    const roundtrip = join(output, "stopped-payload"); await required(["cp", "-a", `${container}:/payload`, roundtrip]); assert.deepEqual(await inventory(roundtrip, await readdir(roundtrip)), frozen);
    await required(["start", container]); const user = ["exec", "--user", "1000:1000", container];
    const absent = await docker([...user, "/usr/bin/dpkg-query", "-W", "-f=${db:Status-Abbrev}", "io-github-whisperfree"]); assert.equal(absent.code, 1); assert.equal(absent.closureObserved, true);
    await required(["exec", "--user", "0:0", container, "/usr/bin/dpkg", "--install", `/payload/older/${ARCHIVE}`], 60_000);
    assert.equal(await required([...user, "/usr/bin/dpkg-query", "-W", "-f=${db:Status-Abbrev} ${Package} ${Version} ${Architecture}", "io-github-whisperfree"]), `ii  io-github-whisperfree ${input.older.sourceVersion} amd64`);
    const driver = docker([...user, "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "OPENWHISPER_OWNED_DEBIAN_UPGRADE=1", "/payload/node", "/payload/driver.mjs"], 240_000);
    activeDriver = driver; void driver.catch(() => {});
    // One retained namespace helper waits for atomic publication; no Docker polling processes are spawned.
    await required(["exec", "--user", "0:0", container, "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "OPENWHISPER_OWNED_DEBIAN_UPGRADE=1", "/payload/node", "/payload/host.mjs", "--installer"], 150_000);
    const completed = await driver; activeDriver = undefined; assert.equal(completed.code, 0); assert.equal(completed.closureObserved, true);
    await required(["cp", `${container}:/evidence/.`, output]);
    const accepted = resultSchema.parse(JSON.parse(await text(join(output, "result.json"))));
    assert.equal(accepted.fromVersion, input.older.sourceVersion); assert.equal(accepted.toVersion, input.newer.sourceVersion);
    installResponseSchema.parse(JSON.parse(await text(join(output, "install-response.json"))));
    const returned = join(output, "returned-installed-package"); await required(["cp", "-a", `${container}:/opt/openwhisper`, returned], 60_000);
    const expected = await inventory(join(newer, PACKAGE), await readdir(join(newer, PACKAGE)));
    assert.deepEqual(await inventory(returned, await readdir(returned)), expected);
    const returnedPayload = join(output, "returned-payload"); await required(["cp", "-a", `${container}:/payload`, returnedPayload], 60_000);
    assert.deepEqual(await inventory(returnedPayload, await readdir(returnedPayload)), frozen);
    for (const [source, expectedInput] of [[older, previous.original], [newer, successor.original]] as const) assert.deepEqual(await inventory(source, [ARCHIVE, PACKAGE, "candidate-receipt.json", `${ARCHIVE}.sig`]), expectedInput);
    await required(["kill", "--signal", "TERM", container]); assert.equal(await required(["wait", container], 15_000), "143");
    const terminal = await required(["inspect", container]); z.array(z.object({ State: z.object({ Running: z.literal(false), Pid: z.literal(0), ExitCode: z.literal(143), OOMKilled: z.literal(false) }) })).length(1).parse(JSON.parse(terminal));
    await writeFile(join(output, "container-terminal.json"), terminal, { mode: 0o600 }); result = "PASS";
  } finally {
    // A failed request poll still joins the original driver command before namespace removal.
    if (activeDriver) await activeDriver.catch(() => {});
    if (nodeCreated) await docker(["rm", "--force", nodeContainer], 20_000);
    if (created) {
      await docker(["cp", `${container}:/evidence/.`, output], 10_000);
      const removal = await docker(result === "PASS" ? ["rm", container] : ["rm", "--force", container], 20_000);
      const absent = await docker(["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`], 10_000);
      removed = removal.code === 0 && removal.closureObserved && absent.code === 0 && absent.closureObserved && absent.stdout.trim() === "";
    }
    await writeFile(join(output, "launcher-result.json"), `${JSON.stringify({ status: result === "PASS" && removed && outstanding.size === 0 ? "PASS" : "FAIL", image: IMAGE,
      originalContainerRemoved: removed, originalCommandsClosed: outstanding.size === 0, input, commands, scope: "OWNED_OFFLINE_SIGNED_DEBIAN_GUI_UPGRADE_NO_HTTPS_OR_POLKIT" })}\n`, { mode: 0o600 });
    assert.equal(removed, true); assert.equal(outstanding.size, 0);
  }
  assert.equal(result, "PASS");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void executeOwnedDebianUpgrade(process.argv.slice(2)).catch(() => { process.stderr.write("Owned Debian GUI upgrade failed; inspect private evidence.\n"); process.exitCode = 1; });
}

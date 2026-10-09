import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseApplicationBuildModule } from "../src/contracts/build-identity.js";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { validateDebianUpdateMetadata } from "../src/services/linux-debian-update.js";
import { LINUX_UPDATE_PUBLIC_KEY } from "../src/services/linux-update-signature.js";
import { isNewerUpdateVersion, parseUpdateVersion } from "../src/services/update-policy.js";

// Owned CI acceptance only. Signing, root installation and namespace ownership stay in the workflow.
const artifact = "OpenWhisper-Linux-amd64.deb", directory = "OpenWhisper-Linux-x64";
const physicalFs = process.versions["electron"] ? createRequire(import.meta.url)("original-fs") as typeof nodeFs : nodeFs;
const { constants, createReadStream } = physicalFs;
const { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } = physicalFs.promises;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u), commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const fileSchema = z.strictObject({ bytes: z.number().int().nonnegative().max(1024 ** 3), sha256: hashSchema });
const receiptSchema = z.strictObject({ version: z.literal(1), classification: z.literal("CANONICAL_STABLE_VALIDATION_ONLY"),
  source: z.strictObject({ commit: commitSchema, modified: z.literal(false) }), sourceVersion: z.string(),
  files: z.record(z.string(), fileSchema), modes: z.record(z.string(), z.number().int().min(0).max(0o7777)) });
type Inventory = Pick<z.infer<typeof receiptSchema>, "files" | "modes">;
type ChildReceipt = { pid: number; code: number | null; signal: NodeJS.Signals | null; closed: true;
  absent: boolean; timedOut: boolean; stdoutBytes: number; stderrBytes: number };
const children: ChildReceipt[] = [];
let phase = "arguments", evidence: string | undefined;

function absolute(value: string | undefined): string {
  assert.ok(value && isAbsolute(value) && resolve(value) === value && !value.includes("\0")); return value;
}
export function parseOwnedSignedDebianArguments(args: readonly string[]) {
  const mode = z.enum(["capture", "admit", "verify", "embedded-verify", "audit", "audit-mismatch"]).parse(args[0]);
  const toolsRequired = mode === "admit" || mode === "verify";
  assert.equal(args.length, mode === "capture" ? 3 : toolsRequired ? 7 : 5);
  assert.equal(args[1], "--candidate");
  if (toolsRequired) assert.equal(args[3], "--tools");
  if (mode !== "capture") assert.equal(args[toolsRequired ? 5 : 3], "--evidence");
  return { mode, candidate: absolute(args[2]), tools: toolsRequired ? absolute(args[4]) : undefined,
    evidence: mode === "capture" ? undefined : absolute(args[toolsRequired ? 6 : 4]) };
}
async function bounded(path: string, limit = 2 * 1024 * 1024): Promise<string> {
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit);
  const bytes = await readFile(path); assert.ok(bytes.length <= limit); return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function hash(path: string) {
  const before = await lstat(path, { bigint: true }); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
  const digest = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; assert.ok(bytes <= 1024 ** 3); digest.update(chunk); }
  const after = await lstat(path, { bigint: true });
  for (const field of ["dev", "ino", "mode", "uid", "gid", "size", "nlink", "mtimeNs", "ctimeNs"] as const) assert.equal(after[field], before[field]);
  assert.equal(BigInt(bytes), before.size); return { bytes, sha256: digest.digest("hex") };
}
async function inventory(root: string, paths: readonly string[]): Promise<Inventory> {
  assert.equal(await realpath(root), root); const files: Inventory["files"] = {}, modes: Inventory["modes"] = {};
  async function visit(relative: string): Promise<void> {
    assert.ok(!relative.startsWith("/") && !relative.split("/").some((part) => !part || part === "." || part === "..") && !/[\0\r\n]/u.test(relative));
    assert.ok(Object.keys(modes).length < 16_384); const path = join(root, relative), stat = await lstat(path);
    assert.ok(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory())); modes[relative] = stat.mode & 0o7777;
    if (stat.isFile()) files[relative] = await hash(path);
    else for (const child of (await readdir(path)).sort()) await visit(`${relative}/${child}`);
  }
  for (const path of [...paths].sort()) await visit(path); return { files, modes };
}
async function writeReceipt(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
async function packageFacts(candidate: string) {
  const app = join(candidate, directory, "resources/app"), dist = join(app, "dist");
  assert.equal(parseApplicationBuildModule(await bounded(join(dist, "main/application-build.js"))).kind, "stable");
  const source = receiptSchema.shape.source.parse(JSON.parse(await bounded(join(dist, "resources/development-build.json"))) as unknown);
  const version = (await bounded(join(dist, "resources/VERSION"), 128)).trim(); parseUpdateVersion(version);
  assert.ok(isNewerUpdateVersion(version, "0.2.5"));
  assert.equal(z.object({ version: z.string() }).parse(JSON.parse(await bounded(join(app, "package.json"))) as unknown).version, version);
  const module = await bounded(join(dist, "main/development-recording-build.js"));
  const match = /^\s*(export\s+)?const DEVELOPMENT_RECORDING_BUILD(?:\s*:\s*unknown)?\s*=\s*(\{[^]*?\});\s*(export\s*\{\s*DEVELOPMENT_RECORDING_BUILD\s*\};)?\s*$/u.exec(module);
  assert.ok(match?.[2] && Boolean(match[1]) !== Boolean(match[3]));
  const descriptor = developmentRecordingDescriptorSchema.parse(JSON.parse(match[2]) as unknown);
  assert.equal(descriptor.platform, "linux"); assert.equal(descriptor.architecture, "x64"); assert.ok(descriptor.platformServices);
  for (const entry of [...descriptor.speechEntryGraph.entries,
    { path: "dist/native/capture/openwhisper_capture.node", ...descriptor.capture }, { path: "dist/workers/capture-entry.js", ...descriptor.captureEntry },
    ...descriptor.speech.entries.map((item) => ({ path: `dist/native/speech/${item.backend}/openwhisper_speech.node`, bytes: item.bytes, sha256: item.sha256 })),
    { path: "dist/workers/platform-entry.js", ...descriptor.platformServices.entry },
    { path: "dist/native/openwhisper_linux_bus.node", ...descriptor.platformServices.bus }]) {
    assert.deepEqual(await hash(join(app, entry.path)), { bytes: entry.bytes, sha256: entry.sha256 });
  }
  return { source, sourceVersion: version };
}
async function admittedCandidate(candidate: string, matchSource: boolean) {
  const receipt = receiptSchema.parse(JSON.parse(await bounded(join(candidate, "candidate-receipt.json"))) as unknown);
  assert.ok(Object.keys(receipt.files).length <= 16_384 && Object.keys(receipt.modes).length <= 16_384);
  assert.deepEqual(await packageFacts(candidate), { source: receipt.source, sourceVersion: receipt.sourceVersion });
  assert.deepEqual(await inventory(candidate, [artifact, directory]), { files: receipt.files, modes: receipt.modes });
  if (matchSource) {
    assert.equal(receipt.source.commit, commitSchema.parse(process.env["GITHUB_SHA"]));
    assert.equal(receipt.sourceVersion, (await bounded(join(absolute(process.env["GITHUB_WORKSPACE"]), "VERSION"), 128)).trim());
    assert.deepEqual(await hash(join(candidate, directory, "resources/app/package-lock.json")),
      await hash(join(absolute(process.env["GITHUB_WORKSPACE"]), "electron/package-lock.json")));
  }
  return receipt;
}
async function run(command: string, args: readonly string[], expected: number, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", GITHUB_ACTIONS: "true",
    OPENWHISPER_OWNED_SIGNED_DEBIAN: "1", HOME: evidence, ...extra };
  const child = spawn(command, args, { env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let failed = false, timedOut = false, stdoutBytes = 0, stderrBytes = 0, stdout = "";
  const stop = (): void => { failed = true; if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Join original close. */ } } };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 45_000);
  child.on("error", () => { failed = true; });
  child.stdout.on("error", stop); child.stderr.on("error", stop);
  child.stdout.on("data", (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > 64 * 1024) stop(); else stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) stop(); });
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => child.once("close", (code, signal) => accept({ code, signal })));
  clearTimeout(timer); assert.ok(child.pid); let absent = false;
  try { process.kill(child.pid, 0); } catch (error: unknown) { absent = error instanceof Error && "code" in error && error.code === "ESRCH"; }
  children.push({ pid: child.pid, ...closed, closed: true, absent, timedOut, stdoutBytes, stderrBytes });
  assert.ok(!failed && absent); assert.equal(closed.signal, null); assert.equal(closed.code, expected); return stdout;
}
async function admittedTools(root: string) {
  const sourceRoot = absolute(process.env["GITHUB_WORKSPACE"]), sums = await bounded(join(root, "SHA256SUMS"));
  const observed = await inventory(root, (await readdir(root)).filter((name) => name !== "SHA256SUMS"));
  const listed: Record<string, string> = {};
  for (const line of sums.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (?:\.\/)?([^\r\n]+)$/u.exec(line); assert.ok(match?.[1] && match[2]);
    assert.equal(listed[match[2]], undefined); listed[match[2]] = match[1];
  }
  assert.deepEqual(Object.keys(listed).sort(), Object.keys(observed.files).sort());
  for (const [path, sha256] of Object.entries(listed)) assert.equal(observed.files[path]?.sha256, sha256);
  assert.equal((await bounded(join(root, "source-commit.txt"), 128)).trim(), commitSchema.parse(process.env["GITHUB_SHA"]));
  for (const [name, original] of [["tauri.conf.json", "linux/src-tauri/tauri.conf.json"], ["package.json", "linux/package.json"],
    ["package-lock.json", "linux/package-lock.json"]] as const) assert.deepEqual(await hash(join(root, name)), await hash(join(sourceRoot, original)));
  const lock = z.object({ packages: z.record(z.string(), z.object({ version: z.string().optional() })) }).parse(JSON.parse(await bounded(join(root, "package-lock.json"))) as unknown);
  for (const name of ["@tauri-apps/cli", "@tauri-apps/cli-linux-x64-gnu"]) {
    const metadata = z.object({ name: z.literal(name), version: z.string() }).parse(JSON.parse(await bounded(join(root, "node_modules", name, "package.json"))) as unknown);
    assert.equal(metadata.version, lock.packages[`node_modules/${name}`]?.version);
  }
  z.object({ plugins: z.object({ updater: z.object({ pubkey: z.literal(LINUX_UPDATE_PUBLIC_KEY), requireSignedVersion: z.literal(true) }) }) })
    .parse(JSON.parse(await bounded(join(root, "tauri.conf.json"))) as unknown);
  assert.equal(observed.modes["verify-update"], 0o755); return observed;
}
async function embedded(candidate: string, mode: "embedded-verify" | "audit" | "audit-mismatch") {
  const receipt = await admittedCandidate(candidate, false);
  const installed = mode !== "embedded-verify";
  assert.equal(process.versions["electron"], "44.7.0"); assert.match(process.versions.node, /^24\./u);
  if (installed) { assert.equal(process.getuid?.(), 1000); assert.equal(process.execPath, "/opt/openwhisper/openwhisper"); }
  const root = installed ? "/opt/openwhisper/resources/app" : join(candidate, directory, "resources/app");
  const require = createRequire(join(root, "package.json"));
  const staging = require(join(root, "dist/services/update-staging.js")) as typeof import("../src/services/update-staging.js");
  const verifier = require(join(root, "dist/services/linux-update-file.js")) as typeof import("../src/services/linux-update-file.js");
  const signatures = require(join(root, "dist/services/linux-update-signature.js")) as typeof import("../src/services/linux-update-signature.js");
  const signatureBefore = await hash(join(candidate, `${artifact}.sig`));
  const stage = join(evidence!, "stage"); await mkdir(stage, { mode: 0o700 });
  const file = await open(join(stage, artifact), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let download: Awaited<ReturnType<typeof staging.retainOwnedUpdateDownload>> | undefined;
  try {
    const source = await open(join(candidate, artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const block = Buffer.alloc(64 * 1024); let position = 0;
      for (;;) {
        const { bytesRead } = await source.read(block, 0, block.length, position); if (!bytesRead) break;
        let written = 0; while (written < bytesRead) {
          const result = await file.write(block, written, bytesRead - written, position + written); assert.ok(result.bytesWritten > 0); written += result.bytesWritten;
        }
        position += bytesRead; assert.ok(position <= 1024 ** 3);
      }
      await file.sync();
    } finally { await source.close(); }
    download = await staging.retainOwnedUpdateDownload({ file, stageDirectory: stage, artifactName: artifact });
    const signature = await bounded(join(candidate, `${artifact}.sig`), 16 * 1024);
    assert.deepEqual(await hash(join(stage, artifact)), receipt.files[artifact]);
    if (!installed) {
      phase = "embedded-fixed-key";
      await verifier.verifyOwnedLinuxUpdateFile({ ...download, artifactName: artifact, signature, version: receipt.sourceVersion });
      await assert.rejects(verifier.verifyOwnedLinuxUpdateFile({ ...download, artifactName: artifact, signature, version: "0.0.0" }),
        (error: unknown) => error instanceof signatures.LinuxUpdateSignatureError && error.code === "SIGNED_VERSION_MISMATCH");
    } else {
      phase = "installed-physical-audit";
      const service = require(join(root, "dist/services/linux-debian-installed.js")) as typeof import("../src/services/linux-debian-installed.js");
      const audit = await service.prepareDebianInstalledAudit({ download, signature, expectedVersion: receipt.sourceVersion });
      if (mode === "audit") await audit.assertInstalled();
      else await assert.rejects(audit.assertInstalled(), (error: unknown) => error instanceof service.DebianInstalledAuditError && error.code === "INSTALLED_MISMATCH");
    }
    await download.assertUnchanged(); assert.equal((await file.stat()).size, download.bytes);
    assert.deepEqual(await hash(join(candidate, `${artifact}.sig`)), signatureBefore);
  } finally {
    if (download) await download.cleanup();
    else { await file.close(); await rm(stage, { recursive: true }); }
  }
  await assert.rejects(lstat(stage), { code: "ENOENT" }); await admittedCandidate(candidate, false);
  return { source: receipt.source, version: receipt.sourceVersion, archive: receipt.files[artifact], signature: signatureBefore,
    runtime: { electron: process.versions["electron"], node: process.versions.node }, uid: process.getuid?.(), originalSourceClosed: true,
    stageAbsent: true, installed: installed ? mode === "audit" ? "ACCEPTED" : "INSTALLED_MISMATCH" : "NOT_TESTED" };
}
async function main() {
  assert.ok(process.platform === "linux" && process.arch === "x64" && process.getuid?.());
  assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.equal(process.env["OPENWHISPER_OWNED_SIGNED_DEBIAN"], "1");
  for (const name of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]) assert.equal(Object.hasOwn(process.env, name), false);
  const args = parseOwnedSignedDebianArguments(process.argv.slice(2)); evidence = args.evidence;
  if (evidence) { await mkdir(evidence, { mode: 0o700 }); assert.equal(await realpath(evidence), evidence); }
  let details: unknown;
  try {
    phase = args.mode;
    if (args.mode === "capture") {
      const facts = await packageFacts(args.candidate); assert.equal(facts.source.commit, commitSchema.parse(process.env["GITHUB_SHA"]));
      const receipt = receiptSchema.parse({ version: 1, classification: "CANONICAL_STABLE_VALIDATION_ONLY", ...facts,
        ...await inventory(args.candidate, [artifact, directory]) });
      await writeReceipt(join(args.candidate, "candidate-receipt.json"), receipt); await admittedCandidate(args.candidate, true); return;
    }
    if (args.mode === "embedded-verify" || args.mode === "audit" || args.mode === "audit-mismatch") details = await embedded(args.candidate, args.mode);
    else {
      const candidate = await admittedCandidate(args.candidate, true); assert.ok(args.tools); const tools = await admittedTools(args.tools);
      phase = "canonical-debian-metadata";
      validateDebianUpdateMetadata(await run("/usr/bin/dpkg-deb", ["--showformat=${Package}\\n${Version}\\n${Architecture}\\n", "--show", join(args.candidate, artifact)], 0), candidate.sourceVersion);
      const signatureBefore = args.mode === "verify" ? await hash(join(args.candidate, `${artifact}.sig`)) : undefined;
      if (args.mode === "verify") {
        phase = "embedded-original-source-verification";
        const embeddedEvidence = join(evidence!, "embedded");
        await run(join(args.candidate, directory, "openwhisper"), [fileURLToPath(import.meta.url), "embedded-verify", "--candidate", args.candidate,
          "--evidence", embeddedEvidence], 0, { ELECTRON_RUN_AS_NODE: "1" });
        assert.equal(z.object({ status: z.literal("PASS") }).parse(JSON.parse(await bounded(join(embeddedEvidence, "result.json"))) as unknown).status, "PASS");
        phase = "native-original-source-verification";
        for (const [version, status] of [[candidate.sourceVersion, 0], ["0.0.0", 1]] as const) await run(join(args.tools, "verify-update"),
          [join(args.tools, "tauri.conf.json"), join(args.candidate, artifact), join(args.candidate, `${artifact}.sig`), version], status);
      }
      assert.deepEqual(await admittedCandidate(args.candidate, true), candidate); assert.deepEqual(await admittedTools(args.tools), tools);
      if (signatureBefore) assert.deepEqual(await hash(join(args.candidate, `${artifact}.sig`)), signatureBefore);
      details = { source: candidate.source, version: candidate.sourceVersion, archive: candidate.files[artifact], tools,
        signature: signatureBefore ?? "NOT_YET_PRESENT" };
    }
    await writeReceipt(join(evidence!, "result.json"), { status: "PASS", mode: args.mode, classification: "OWNED_SIGNED_CANDIDATE_EVIDENCE_ONLY", details, children });
  } catch {
    if (evidence) await writeReceipt(join(evidence, "result.json"), { status: "FAIL", mode: args.mode, phase, children });
    process.stderr.write("Owned signed Debian acceptance failed.\n"); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildIdentitySchema, parseApplicationBuildModule } from "../src/contracts/application/build-identity.js";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { validateDebianUpdateMetadata } from "../src/services/update/linux/linux-debian-update.js";
import { appImageLauncher } from "../src/services/update/linux/linux-appimage-launcher.js";
import { isNewerUpdateVersion, parseUpdateVersion } from "../src/services/update/common/update-policy.js";

// Owned CI acceptance only. Signing, root installation and namespace ownership stay in the workflow.
const debianArtifact = "OpenWhisper-Linux-amd64.deb", imageArtifact = "appimage/OpenWhisper-Linux-x86_64.AppImage", directory = "OpenWhisper-Linux-x64";
type Package = "deb" | "appimage";
const artifactPath = (kind: Package): string => kind === "deb" ? debianArtifact : imageArtifact;
const receiptPath = (kind: Package): string => kind === "deb" ? "candidate-receipt.json" : "appimage-candidate-receipt.json";
const candidatePaths = (kind: Package): readonly string[] => kind === "deb" ? [debianArtifact, directory] :
  [directory, imageArtifact, "appimage/openwhisper-launch", "appimage/receipt.json", "appimage/construction-command.json", "appimage/passive-extraction-command.json"];
const physicalFs = process.versions["electron"] ? createRequire(import.meta.url)("original-fs") as typeof nodeFs : nodeFs;
const { constants, createReadStream } = physicalFs;
const { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } = physicalFs.promises;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u), commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const fileSchema = z.strictObject({ bytes: z.number().int().nonnegative().max(1024 ** 3), sha256: hashSchema });
const sourceSchema = z.strictObject({ commit: commitSchema, modified: z.literal(false) });
const receiptFields = { source: sourceSchema, sourceVersion: z.string(),
  files: z.record(z.string(), fileSchema), modes: z.record(z.string(), z.number().int().min(0).max(0o7777)) };
const receiptSchema = z.union([
  z.strictObject({ version: z.literal(1), classification: z.literal("CANONICAL_STABLE_VALIDATION_ONLY"), ...receiptFields }),
  z.strictObject({ version: z.literal(2), classification: z.literal("CANONICAL_STABLE_APPIMAGE_VALIDATION_ONLY"), package: z.literal("appimage"), ...receiptFields }),
]);
type Inventory = Pick<z.infer<typeof receiptSchema>, "files" | "modes">;
type ChildReceipt = { pid: number; code: number | null; signal: NodeJS.Signals | null; closed: true;
  absent: boolean; timedOut: boolean; stdoutBytes: number; stderrBytes: number };
const children: ChildReceipt[] = [];
let phase = "arguments", evidence: string | undefined;

function absolute(value: string | undefined): string {
  assert.ok(value && isAbsolute(value) && resolve(value) === value && !value.includes("\0")); return value;
}
export function parseOwnedSignedDebianArguments(args: readonly string[]) {
  const mode = z.enum(["capture", "admit", "verify", "embedded-verify", "audit", "audit-mismatch", "audit-mutation"]).parse(args[0]);
  const count = mode === "capture" ? 3 : 5;
  const packageKind: Package = args.length === count ? "deb" : "appimage";
  assert.equal(args.length, count + (packageKind === "appimage" ? 2 : 0));
  if (packageKind === "appimage") {
    assert.equal(args[count], "--package"); assert.equal(args[count + 1], "appimage");
    assert.ok(["capture", "admit", "verify", "embedded-verify"].includes(mode));
  }
  assert.equal(args[1], "--candidate");
  if (mode !== "capture") assert.equal(args[3], "--evidence");
  return { mode, package: packageKind, candidate: absolute(args[2]),
    evidence: mode === "capture" ? undefined : absolute(args[4]) };
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
  const source = sourceSchema.parse(JSON.parse(await bounded(join(dist, "resources/development-build.json"))) as unknown);
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
/** Pure receipt consistency only; publisher authentication still requires both real signature verifiers. */
export function validateOwnedAppImageConstruction(value: unknown, expected: {
  readonly source: z.infer<typeof sourceSchema>; readonly sourceVersion: string; readonly inventory: Inventory;
}, tools: unknown): void {
  const entry = fileSchema.extend({ type: z.enum(["file", "directory"]), mode: z.number().int().min(0).max(0o7777) });
  const receipt = z.object({ classification: z.literal("UNSIGNED_CONSTRUCTION_ONLY"), applicationProducer: sourceSchema,
    buildIdentity: buildIdentitySchema, version: z.string(), canonicalStableValidation: z.literal(true), sourceDirectory: z.string(),
    sourceInventory: z.record(z.string(), entry), image: fileSchema.extend({ path: z.string() }),
    launcher: z.object({ path: z.string(), sha256: hashSchema }), tools: z.unknown(), runtimeDigestMd5Only: z.literal(true),
    passiveExtractionMatches: z.literal(true), originalInputUnchanged: z.literal(true), runtimeAcceptance: z.literal(false),
    updateAuthority: z.literal(false), publicDistributionAuthorized: z.literal(false) }).parse(value);
  assert.deepEqual(receipt.applicationProducer, expected.source); assert.equal(receipt.version, expected.sourceVersion);
  assert.equal(receipt.buildIdentity.kind, "stable"); assert.deepEqual(receipt.tools, tools);
  assert.equal(basename(absolute(receipt.sourceDirectory)), directory); assert.equal(basename(absolute(receipt.image.path)), basename(imageArtifact));
  assert.equal(basename(absolute(receipt.launcher.path)), "openwhisper-launch");
  assert.deepEqual(expected.inventory.files[imageArtifact], { bytes: receipt.image.bytes, sha256: receipt.image.sha256 });
  const launcher = Buffer.from(appImageLauncher());
  assert.deepEqual(expected.inventory.files["appimage/openwhisper-launch"], { bytes: launcher.length, sha256: createHash("sha256").update(launcher).digest("hex") });
  assert.equal(receipt.launcher.sha256, expected.inventory.files["appimage/openwhisper-launch"]?.sha256);
  assert.equal(expected.inventory.modes[imageArtifact], 0o755); assert.equal(expected.inventory.modes["appimage/openwhisper-launch"], 0o755);
  const names = Object.keys(expected.inventory.modes).filter((name) => name.startsWith(`${directory}/`)).map((name) => name.slice(directory.length + 1));
  assert.deepEqual(Object.keys(receipt.sourceInventory).sort(), names.sort());
  for (const [name, entry] of Object.entries(receipt.sourceInventory)) {
    const path = `${directory}/${name}`, file = expected.inventory.files[path];
    assert.equal(entry.mode, expected.inventory.modes[path]);
    if (file) { assert.equal(entry.type, "file"); assert.deepEqual(file, { bytes: entry.bytes, sha256: entry.sha256 }); }
    else { assert.equal(entry.type, "directory"); assert.equal(entry.bytes, 0); }
  }
}
async function admittedCandidate(candidate: string, matchSource: boolean, kind: Package = "deb") {
  const receipt = receiptSchema.parse(JSON.parse(await bounded(join(candidate, receiptPath(kind)))) as unknown);
  assert.equal(receipt.version, kind === "deb" ? 1 : 2);
  assert.ok(Object.keys(receipt.files).length <= 16_384 && Object.keys(receipt.modes).length <= 16_384);
  const facts = await packageFacts(candidate);
  assert.deepEqual(facts, { source: receipt.source, sourceVersion: receipt.sourceVersion });
  const observed = await inventory(candidate, candidatePaths(kind));
  assert.deepEqual(observed, { files: receipt.files, modes: receipt.modes });
  if (kind === "appimage") {
    const construction: unknown = JSON.parse(await bounded(join(candidate, "appimage/receipt.json")));
    const pins = matchSource ? JSON.parse(await bounded(join(absolute(process.env["GITHUB_WORKSPACE"]), "app/native/appimage-tools.json"))) as unknown
      : z.object({ tools: z.unknown() }).parse(construction).tools;
    validateOwnedAppImageConstruction(construction, { ...facts, inventory: observed }, pins);
  }
  if (matchSource) {
    assert.equal(receipt.source.commit, commitSchema.parse(process.env["GITHUB_SHA"]));
    assert.equal(receipt.sourceVersion, (await bounded(join(absolute(process.env["GITHUB_WORKSPACE"]), "VERSION"), 128)).trim());
    assert.deepEqual(await hash(join(candidate, directory, "resources/app/package-lock.json")),
      await hash(join(absolute(process.env["GITHUB_WORKSPACE"]), "app/package-lock.json")));
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
// Candidate signatures are checked by the production verifier embedded in the exact packaged Electron source.
async function embedded(candidate: string, mode: "embedded-verify" | "audit" | "audit-mismatch" | "audit-mutation", kind: Package) {
  const artifact = artifactPath(kind), stagedArtifact = kind === "deb" ? debianArtifact : "OpenWhisper-Linux-x86_64.AppImage",
    receipt = await admittedCandidate(candidate, false, kind);
  const installed = mode !== "embedded-verify"; if (installed) assert.equal(kind, "deb");
  assert.equal(process.versions["electron"], "44.7.0"); assert.match(process.versions.node, /^24\./u);
  if (installed) { assert.equal(process.getuid?.(), 1000); assert.equal(process.execPath, "/opt/openwhisper/openwhisper"); }
  const root = installed ? "/opt/openwhisper/resources/app" : join(candidate, directory, "resources/app");
  const require = createRequire(join(root, "package.json"));
  const staging = require(join(root, "dist/services/update/common/update-staging.js")) as typeof import("../src/services/update/common/update-staging.js");
  const verifier = require(join(root, "dist/services/update/linux/linux-update-file.js")) as typeof import("../src/services/update/linux/linux-update-file.js");
  const signatures = require(join(root, "dist/services/update/linux/linux-update-signature.js")) as typeof import("../src/services/update/linux/linux-update-signature.js");
  const signatureBefore = await hash(join(candidate, `${artifact}.sig`));
  const stage = join(evidence!, "stage"); await mkdir(stage, { mode: 0o700 });
  const file = await open(join(stage, stagedArtifact), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let download: Awaited<ReturnType<typeof staging.retainOwnedUpdateDownload>> | undefined;
  let finalGuard: (() => void) | undefined, mismatch: ((error: unknown) => boolean) | undefined;
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
    download = await staging.retainOwnedUpdateDownload({ file, stageDirectory: stage, artifactName: stagedArtifact });
    const signature = await bounded(join(candidate, `${artifact}.sig`), 16 * 1024);
    assert.deepEqual(await hash(join(stage, stagedArtifact)), receipt.files[artifact]);
    if (!installed) {
      phase = "embedded-fixed-key";
      await verifier.verifyOwnedLinuxUpdateFile({ ...download, artifactName: stagedArtifact, signature, version: receipt.sourceVersion });
      await assert.rejects(verifier.verifyOwnedLinuxUpdateFile({ ...download, artifactName: stagedArtifact, signature, version: "0.0.0" }),
        (error: unknown) => error instanceof signatures.LinuxUpdateSignatureError && error.code === "SIGNED_VERSION_MISMATCH");
    } else {
      phase = "installed-service-import";
      const service = require(join(root, "dist/services/update/linux/linux-debian-installed.js")) as typeof import("../src/services/update/linux/linux-debian-installed.js");
      phase = "installed-canonical-version-query";
      await service.assertCanonicalInstalledDebianVersion(receipt.sourceVersion);
      phase = "installed-audit-prepare";
      const audit = await service.prepareDebianInstalledAudit({ download, signature, expectedVersion: receipt.sourceVersion });
      mismatch = (error: unknown) => error instanceof service.DebianInstalledAuditError && error.code === "INSTALLED_MISMATCH";
      finalGuard = audit.assertForExec;
      assert.throws(finalGuard, mismatch);
      if (mode === "audit-mismatch") {
        phase = "installed-fresh-mismatch-audit";
        await assert.rejects(audit.assertInstalled(), mismatch); assert.throws(finalGuard, mismatch);
      } else {
        phase = "installed-full-positive-audit";
        await audit.assertInstalled();
        phase = "installed-final-guard"; finalGuard();
        if (mode === "audit-mutation") {
          phase = "installed-original-snapshot-mutation";
          await writeReceipt(join(evidence!, "mutation-ready.partial"), { ready: true, scope: "OWNED_FIXED_NOTICE_MUTATION_ONLY" });
          await rename(join(evidence!, "mutation-ready.partial"), join(evidence!, "mutation-ready.json"));
          const marker = join(evidence!, "mutation-complete"), deadline = performance.now() + 15_000;
          for (;;) {
            assert.ok(performance.now() < deadline);
            const present = await lstat(marker).then(() => true, (error: unknown) => {
              assert.ok(error instanceof Error && "code" in error && error.code === "ENOENT"); return false;
            });
            if (present) { assert.equal(await bounded(marker, 8), "MUTATED\n"); break; }
            await new Promise<void>((accept) => setTimeout(accept, 50));
          }
          assert.throws(finalGuard, mismatch);
          await assert.rejects(audit.assertInstalled(), mismatch); assert.throws(finalGuard, mismatch);
        }
      }
    }
    await download.assertUnchanged(); assert.equal((await file.stat()).size, download.bytes);
    assert.deepEqual(await hash(join(candidate, `${artifact}.sig`)), signatureBefore);
  } finally {
    if (download) await download.cleanup();
    else { await file.close(); await rm(stage, { recursive: true }); }
  }
  // The final installed observation deliberately survives original source descriptor cleanup.
  if (finalGuard) { assert.ok(mismatch); if (mode === "audit") finalGuard(); else assert.throws(finalGuard, mismatch); }
  await assert.rejects(lstat(stage), { code: "ENOENT" }); await admittedCandidate(candidate, false, kind);
  return { package: kind, appImageRuntime: "NOT_TESTED", migration: "NOT_TESTED", upgrade: "NOT_TESTED", source: receipt.source, version: receipt.sourceVersion, archive: receipt.files[artifact], signature: signatureBefore,
    runtime: { electron: process.versions["electron"], node: process.versions.node }, uid: process.getuid?.(), originalSourceClosed: true,
    stageAbsent: true, finalGuardAfterSourceClose: installed ? mode === "audit" ? "ACCEPTED" : "REFUSED" : "NOT_TESTED",
    installed: installed ? mode === "audit" ? "ACCEPTED" : "INSTALLED_MISMATCH" : "NOT_TESTED",
    sameSnapshotMutation: mode === "audit-mutation" ? "REFUSED" : "NOT_TESTED" };
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
      const receipt = receiptSchema.parse({ ...(args.package === "deb" ? { version: 1, classification: "CANONICAL_STABLE_VALIDATION_ONLY" }
        : { version: 2, classification: "CANONICAL_STABLE_APPIMAGE_VALIDATION_ONLY", package: "appimage" }), ...facts,
        ...await inventory(args.candidate, candidatePaths(args.package)) });
      await writeReceipt(join(args.candidate, receiptPath(args.package)), receipt); await admittedCandidate(args.candidate, true, args.package); return;
    }
    if (args.mode === "embedded-verify" || args.mode === "audit" || args.mode === "audit-mismatch" || args.mode === "audit-mutation") details = await embedded(args.candidate, args.mode, args.package);
    else {
      const artifact = artifactPath(args.package), candidate = await admittedCandidate(args.candidate, true, args.package);
      if (args.package === "deb") {
        phase = "canonical-debian-metadata";
        validateDebianUpdateMetadata(await run("/usr/bin/dpkg-deb", ["--showformat=${Package}\\n${Version}\\n${Architecture}\\n", "--show", join(args.candidate, artifact)], 0), candidate.sourceVersion);
      }
      const signatureBefore = args.mode === "verify" ? await hash(join(args.candidate, `${artifact}.sig`)) : undefined;
      if (args.mode === "verify") {
        phase = "embedded-original-source-verification";
        const embeddedEvidence = join(evidence!, "embedded");
        await run(join(args.candidate, directory, "openwhisper"), [fileURLToPath(import.meta.url), "embedded-verify", "--candidate", args.candidate,
          "--evidence", embeddedEvidence, ...(args.package === "appimage" ? ["--package", "appimage"] : [])], 0, { ELECTRON_RUN_AS_NODE: "1" });
        assert.equal(z.object({ status: z.literal("PASS") }).parse(JSON.parse(await bounded(join(embeddedEvidence, "result.json"))) as unknown).status, "PASS");
      }
      assert.deepEqual(await admittedCandidate(args.candidate, true, args.package), candidate);
      if (signatureBefore) assert.deepEqual(await hash(join(args.candidate, `${artifact}.sig`)), signatureBefore);
      details = { package: args.package, appImageRuntime: "NOT_TESTED", migration: "NOT_TESTED", upgrade: "NOT_TESTED", source: candidate.source, version: candidate.sourceVersion, archive: candidate.files[artifact],
        signature: signatureBefore ?? "NOT_YET_PRESENT" };
    }
    await writeReceipt(join(evidence!, "result.json"), { status: "PASS", mode: args.mode, classification: "OWNED_SIGNED_CANDIDATE_EVIDENCE_ONLY", details, children });
  } catch {
    if (evidence) await writeReceipt(join(evidence, "result.json"), { status: "FAIL", mode: args.mode, phase, children });
    process.stderr.write("Owned signed Linux candidate acceptance failed.\n"); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

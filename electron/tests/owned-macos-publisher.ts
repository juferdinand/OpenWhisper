import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { stageMacUniversalInputs } from "../scripts/package-macos-universal.js";
import { validateMacUpdateBundleFiles } from "../src/services/macos-update-archive.js";

// Owned publisher evidence only. The workflow owns credentials and temporary-keychain cleanup.
const modes = ["admit", "oracle", "keychain-list", "keychain-identity", "runtime-input", "result"] as const;
const commit = z.string().regex(/^[a-f0-9]{40}$/u), digest = z.string().regex(/^[a-f0-9]{64}$/u);
const pin = { release: 406203224, asset: 619942742, bytes: 4708306, tag: "v0.2.5",
  commit: "d69b43bf6e7017c61089e117e79af34f57f297c4",
  sha256: "9e9583726f1e47bc9bedf1c70a36b2cb772c7c83de7044b65a280849697befb2" } as const;
const packageResult = z.strictObject({ directory: z.string(), archive: z.string(), sha256: digest });
const oracleResult = z.object({ status: z.literal("PASS"), originalRequirement: z.literal("ACCEPTED"),
  validSameIdDifferentPublisher: z.literal("REJECTED") });

export function parseOwnedMacPublisherArguments(args: readonly string[]) {
  assert.equal(args.length, 1); return z.enum(modes).parse(args[0]);
}
function canonical(value: unknown): string {
  const path = z.string().min(1).max(4096).parse(value);
  assert.ok(isAbsolute(path) && resolve(path) === path && !/[\u0000-\u001f\u007f]/u.test(path)); return path;
}
export function parseMacPublisherKeychains(output: string): readonly string[] {
  assert.ok(output.length <= 64 * 1024 && output.endsWith("\n"));
  const lines = output.trimEnd().split("\n"); assert.ok(lines.length > 0 && lines.length <= 64);
  const paths = lines.map((line) => {
    const match = /^[ \t]*"([^"\r\n]+)"[ \t]*$/u.exec(line); assert.ok(match?.[1]); return canonical(match[1]);
  });
  assert.equal(new Set(paths).size, paths.length); return paths;
}
export function parseMacPublisherIdentity(output: string): string {
  assert.ok(output.length <= 64 * 1024 && output.endsWith("\n"));
  const lines = output.trimEnd().split("\n"); assert.equal(lines.length, 2);
  const match = /^[ \t]*1\)[ \t]+([a-fA-F0-9]{40})[ \t]+"[\x20-\x21\x23-\x7e]+"[ \t]*$/u.exec(lines[0]!);
  assert.ok(match?.[1]); assert.match(lines[1]!, /^[ \t]*1 valid identities found[ \t]*$/u); return match[1];
}
type ZipEntry = { name: string; kind: "file" | "directory" | "link"; bytes: number };
function frameworkLink(name: string): boolean {
  return name.startsWith("OpenWhisper.app/Contents/Frameworks/") && name.split("/").slice(3, -1).some((part) => part.endsWith(".framework"));
}
/** Fixed Info-ZIP `zipinfo -l -T` output, not a ZIP byte parser. Unknown formats fail closed. */
export function parseMacPublisherZipListing(output: string, archiveBytes: number): readonly ZipEntry[] {
  assert.ok(Buffer.byteLength(output) <= 8 * 1024 * 1024 && output.endsWith("\n"));
  const lines = output.trimEnd().split("\n"); assert.ok(lines.length >= 4);
  assert.match(lines.shift()!, /^Archive:  \/[^\r\n]+$/u);
  const header = /^Zip file size: (\d+) bytes, number of entries: (\d+)$/u.exec(lines.shift()!); assert.ok(header?.[1] && header[2]);
  assert.equal(Number(header[1]), archiveBytes); assert.ok(Number(header[2]) > 0 && Number(header[2]) <= 100_000);
  assert.match(lines.pop()!, /^\d+ files?, \d+ bytes uncompressed, \d+ bytes compressed:[ \t]+-?\d+(?:\.\d+)?%$/u);
  const entries: ZipEntry[] = [], names = new Set<string>(); let expanded = 0;
  for (const line of lines) {
    const match = /^([dl-])[rwxstST-]{9}[ \t]+\d+\.\d+[ \t]+[A-Za-z0-9]{3}[ \t]+(\d+)[ \t]+[bt][x-][ \t]+[A-Za-z0-9]{4}[ \t]+\d{8}\.\d{6}[ \t]+(.+)$/u.exec(line);
    assert.ok(match?.[1] && match[2] && match[3]);
    const name = match[3].endsWith("/") ? match[3].slice(0, -1) : match[3], parts = name.split("/");
    assert.ok(name.length <= 1024 && !/[\\\u0000-\u001f\u007f]/u.test(name) && parts.every((part) => part && part !== "." && part !== ".."));
    assert.ok(parts[0] === "OpenWhisper.app" || (parts[0] === "__MACOSX" && (parts.length === 1 || parts[1] === "OpenWhisper.app" ||
      (parts.length === 2 && parts[1] === "._OpenWhisper.app"))));
    assert.ok(!names.has(name)); names.add(name);
    const bytes = Number(match[2]); assert.ok(Number.isSafeInteger(bytes) && bytes >= 0); expanded += bytes; assert.ok(expanded <= 2 * 1024 ** 3);
    const kind = match[1] === "l" ? "link" : match[1] === "d" ? "directory" : "file";
    if (kind === "link") assert.ok(frameworkLink(name) && bytes <= 1024);
    entries.push({ name, kind, bytes });
  }
  assert.equal(entries.length, Number(header[2]));
  const links = new Set(entries.filter((entry) => entry.kind === "link").map((entry) => entry.name));
  for (const entry of entries) assert.ok(!entry.name.split("/").some((_, end, parts) => end > 0 && links.has(parts.slice(0, end).join("/"))));
  return entries;
}
export function validateMacPublisherCompletion(input: unknown) {
  return z.strictObject({ smoke: z.object({ status: z.literal("PASS"), architecture: z.literal("arm64"), packageFormat: z.literal("universal"),
    signatureAdmission: z.object({ signingMode: z.literal("persistent-validation"), selfAvailability: z.literal("ACCEPTED") }),
    archiveAdmission: z.object({ publisherAvailability: z.literal("ACCEPTED") }) }),
    cleanup: z.object({ status: z.literal("PASS") }), staged: oracleResult, zip: oracleResult, package: packageResult }).parse(input);
}
type Tool = "/usr/bin/git" | "/usr/bin/zipinfo" | "/usr/bin/tar" | "/usr/bin/codesign" | "/usr/bin/plutil" | "/usr/bin/swift";
const children: { tool: Tool; closed: true; absent: boolean; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }[] = [];
let phase = "arguments", evidence: string | undefined, privateRoot: string | undefined;
async function tool(executable: Tool, args: readonly string[], cwd?: string): Promise<string> {
  assert.ok(privateRoot);
  const child = spawn(executable, [...args], { shell: false, detached: true, ...(cwd ? { cwd } : {}),
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", HOME: join(privateRoot, "tool-home"), TMPDIR: join(privateRoot, "tmp") },
    stdio: ["ignore", "pipe", "pipe"] });
  let failed = false, timedOut = false, output = Buffer.alloc(0), stderrBytes = 0;
  const stop = (): void => { failed = true; if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Await original close. */ } } };
  const timer = setTimeout(() => { timedOut = true; stop(); }, executable === "/usr/bin/tar" || executable === "/usr/bin/swift" ? 120_000 : 30_000);
  child.on("error", () => { failed = true; }); child.stdout.on("error", stop); child.stderr.on("error", stop);
  child.stdout.on("data", (bytes: Buffer) => { if (output.length + bytes.length > 8 * 1024 * 1024) stop(); else output = Buffer.concat([output, bytes]); });
  child.stderr.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > 64 * 1024) stop(); });
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => child.once("close", (code, signal) => accept({ code, signal })));
  clearTimeout(timer); assert.ok(child.pid); let absent = false;
  try { process.kill(-child.pid, 0); } catch (error: unknown) { absent = error instanceof Error && "code" in error && error.code === "ESRCH"; }
  children.push({ tool: executable, closed: true, absent, ...closed, timedOut });
  assert.ok(!failed && absent); assert.equal(closed.code, 0); assert.equal(closed.signal, null);
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}
async function bounded(path: string, limit = 2 * 1024 * 1024): Promise<string> {
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit);
  const bytes = await readFile(path); assert.ok(bytes.length <= limit); return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function json(path: string): Promise<unknown> { return JSON.parse(await bounded(path)) as unknown; }
async function hash(path: string): Promise<{ bytes: number; sha256: string }> {
  const before = await lstat(path, { bigint: true }); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.uid === BigInt(process.getuid!()));
  const digest = createHash("sha256"); let bytes = 0;
  for await (const block of createReadStream(path)) { bytes += block.length; assert.ok(bytes <= 1024 ** 3); digest.update(block); }
  const after = await lstat(path, { bigint: true });
  for (const key of ["dev", "ino", "mode", "uid", "size", "nlink", "mtimeNs", "ctimeNs"] as const) assert.equal(after[key], before[key]);
  assert.equal(BigInt(bytes), before.size); return { bytes, sha256: digest.digest("hex") };
}
async function receipt(name: string, value: unknown): Promise<void> {
  assert.ok(evidence); await writeFile(join(evidence, name), `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
}
async function extract(archive: string, destination: string) {
  const original = await hash(archive);
  const entries = parseMacPublisherZipListing(await tool("/usr/bin/zipinfo", ["-l", "-T", archive]), original.bytes);
  await mkdir(destination, { mode: 0o700 });
  // Retain bsdtar's traversal/link protections; never pass -P or follow archive links.
  await tool("/usr/bin/tar", ["-x", "-f", archive, "-C", destination, "--no-same-owner"]);
  const bundle = join(destination, "OpenWhisper.app"); await validateMacUpdateBundleFiles(bundle);
  for (const entry of entries.filter((entry) => entry.kind === "link")) {
    const path = join(destination, entry.name); assert.ok((await lstat(path)).isSymbolicLink());
    const target = await readlink(path); assert.ok(target && !isAbsolute(target) && !/[\\\u0000-\u001f\u007f]/u.test(target));
    assert.ok((await realpath(path)).startsWith(`${bundle}/Contents/Frameworks/`));
  }
  assert.deepEqual(await hash(archive), original); return bundle;
}
async function admit(temp: string, workspace: string) {
  const producer = commit.parse(process.env["GITHUB_SHA"]), apiHead = commit.parse(process.env["API_HEAD"]);
  assert.equal((await tool("/usr/bin/git", ["rev-parse", "HEAD"], workspace)).trim(), producer);
  assert.equal(await tool("/usr/bin/git", ["status", "--porcelain"], workspace), "");
  for (const architecture of ["arm64", "x64"] as const) {
    const packet = join(temp, `publisher-thin-${architecture}`), archives: string[] = [];
    for (const path of [packet, join(packet, "openwhisper-mac-stable")]) {
      const names = await readdir(path).catch((error: unknown) => { assert.ok(error instanceof Error && "code" in error && error.code === "ENOENT"); return []; });
      archives.push(...names.filter((name) => name.endsWith(".zip")).map((name) => join(path, name)));
    }
    assert.equal(archives.length, 1); const archive = archives[0]!;
    z.object({ status: z.literal("PASS"), architecture: z.literal(architecture) }).parse(await json(join(packet, "openwhisper-mac-stable-smoke/result.json")));
    const result = packageResult.parse(await json(join(packet, "openwhisper-mac-stable-result.json"))), observed = await hash(archive);
    assert.equal(observed.sha256, result.sha256);
    const bundle = await extract(archive, join(temp, `publisher-extracted-${architecture}`));
    await tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", bundle]);
    await writeFile(join(evidence!, `thin-${architecture}-zip.sha256`), `${observed.sha256}\n`, { flag: "wx", mode: 0o600 });
  }
  const stage = await stageMacUniversalInputs({ arm64AppPath: join(temp, "publisher-extracted-arm64/OpenWhisper.app"),
    x64AppPath: join(temp, "publisher-extracted-x64/OpenWhisper.app"), output: join(temp, "publisher-admission-copies") });
  assert.equal(stage.input.arm64.source.commit, producer); assert.equal(stage.input.arm64.version, (await bounded(join(workspace, "VERSION"), 128)).trim());
  await rm(stage.output, { recursive: true });
  await receipt("admission.json", { status: "PASS", actualCheckoutProducer: producer, apiHead, sourceVersion: stage.input.arm64.version,
    architectures: ["arm64", "x64"], children, scope: "Same-run original thin signatures, receipts, native bytes and clean stable source; no publisher claim" });
}
async function oracle(temp: string, workspace: string) {
  const release = z.object({ id: z.literal(pin.release), tag_name: z.literal(pin.tag), draft: z.literal(false), prerelease: z.literal(false),
    assets: z.array(z.object({ id: z.number(), name: z.string(), size: z.number(), digest: z.string().nullable() })) }).parse(await json(join(evidence!, "old-release-api.json")));
  z.object({ ref: z.literal("refs/tags/v0.2.5"), object: z.object({ sha: z.literal(pin.commit), type: z.literal("commit") }) }).parse(await json(join(evidence!, "old-tag-api.json")));
  const assets = release.assets.filter((asset) => asset.name === "OpenWhisper-macOS.zip"); assert.equal(assets.length, 1);
  assert.equal(assets[0]!.id, pin.asset); assert.equal(assets[0]!.size, pin.bytes); assert.equal(assets[0]!.digest, `sha256:${pin.sha256}`);
  const archive = join(privateRoot!, "old-release.zip"); assert.deepEqual(await hash(archive), { bytes: pin.bytes, sha256: pin.sha256 });
  for (const [name, expected] of [["old-UpdateService.swift", "8dd80fce8f22d94b873ca966469f8ad269dd5609b3f5cb2dc6f435c9adf48009"],
    ["old-UpdateSignatureVerifier.swift", "bdff7023e4801612479fb2bebb5ab11b085c58ce7723132e9117cb469f1b2ae0"]] as const) assert.equal((await hash(join(evidence!, name))).sha256, expected);
  const original = await extract(archive, join(privateRoot!, "old-release"));
  const plist = JSON.parse(await tool("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(original, "Contents/Info.plist")])) as unknown;
  z.object({ CFBundleIdentifier: z.literal("io.github.whisperfree"), CFBundleShortVersionString: z.literal("0.2.5") }).parse(plist);
  await tool("/usr/bin/swift", [join(workspace, "macos/scripts/extract-signing-requirement.swift"), original, join(privateRoot!, "original-requirement.bin")]);
  await receipt("old-oracle-admission.json", { status: "PASS", releaseId: pin.release, sourceCommit: pin.commit, assetId: pin.asset,
    zipSha256: pin.sha256, binarySignature: "ACCEPTED", requirementSha256: (await hash(join(privateRoot!, "original-requirement.bin"))).sha256,
    children, scope: "Pinned unchanged original 0.2.5 binary and updater source; original Security designated requirement" });
}
async function runtimeInput(temp: string) {
  const result = packageResult.parse(await json(join(evidence!, "package-result.json")));
  assert.equal(result.directory, join(temp, "mac-publisher-output/OpenWhisper.app"));
  canonical(result.archive); assert.equal(relative(join(temp, "mac-publisher-output"), result.archive).includes("/"), false);
  assert.match(result.archive, /\/OpenWhisper-validation-macOS-universal_[0-9]+\.[0-9]+\.[0-9]+_[a-f0-9]{12}\.zip$/u);
  assert.equal((await hash(result.archive)).sha256, result.sha256);
  const bundle = await extract(result.archive, join(temp, "mac-publisher-runtime"));
  z.object({ signingMode: z.literal("persistent-validation"), source: z.object({ commit: z.literal(commit.parse(process.env["GITHUB_SHA"])), modified: z.literal(false) }) })
    .parse(await json(join(bundle, "Contents/Resources/notices/mac-universal-validation-package.json")));
  await tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", bundle]);
  await receipt("runtime-input.json", { status: "PASS", zipSha256: result.sha256, children });
}
async function result(temp: string) {
  const checked = validateMacPublisherCompletion({ smoke: await json(join(temp, "mac-publisher-smoke/result.json")), cleanup: await json(join(evidence!, "cleanup.json")),
    staged: await json(join(evidence!, "old-requirement-staged.json")), zip: await json(join(evidence!, "old-requirement-zip.json")), package: await json(join(evidence!, "package-result.json")) });
  z.object({ status: z.literal("PASS"), actualCheckoutProducer: z.literal(commit.parse(process.env["GITHUB_SHA"])) }).parse(await json(join(evidence!, "admission.json")));
  z.object({ status: z.literal("PASS"), sourceCommit: z.literal(pin.commit), zipSha256: z.literal(pin.sha256), binarySignature: z.literal("ACCEPTED") }).parse(await json(join(evidence!, "old-oracle-admission.json")));
  assert.equal((await hash(checked.package.archive)).sha256, checked.package.sha256);
  const value = { status: "PASS", selfAvailability: "ACCEPTED", publisherAvailability: "ACCEPTED", old025Requirement: "ACCEPTED",
    validSameIdDifferentPublisher: "REJECTED", architecture: process.arch, zipSha256: checked.package.sha256,
    scope: "Persistent publisher continuity and owned ARM universal runtime only; no Mac install/handoff, release, notarization or microphone acceptance" };
  await receipt("publisher-validation.json", value); console.log(JSON.stringify(value));
}
async function stdin(): Promise<string> {
  let bytes = Buffer.alloc(0); for await (const block of process.stdin) { const next = Buffer.from(block as Uint8Array); assert.ok(bytes.length + next.length <= 64 * 1024); bytes = Buffer.concat([bytes, next]); }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function main() {
  const mode = parseOwnedMacPublisherArguments(process.argv.slice(2)); phase = mode;
  assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64"); assert.ok(process.getuid?.());
  assert.equal(process.env["GITHUB_ACTIONS"], "true"); assert.equal(process.env["RUNNER_ENVIRONMENT"], "github-hosted");
  assert.equal(process.env["OPENWHISPER_OWNED_MAC_PUBLISHER"], "1");
  if (mode === "keychain-list") { console.log(parseMacPublisherKeychains(await stdin()).join("\n")); return; }
  if (mode === "keychain-identity") { console.log(parseMacPublisherIdentity(await stdin())); return; }
  const temp = canonical(process.env["RUNNER_TEMP"]), workspace = canonical(process.env["GITHUB_WORKSPACE"]);
  assert.equal(await realpath(temp), temp); assert.equal(await realpath(workspace), workspace);
  privateRoot = join(temp, "mac-publisher-private"); evidence = join(temp, "mac-publisher-evidence");
  for (const path of [privateRoot, evidence]) { const stat = await lstat(path); assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid!()); assert.equal(stat.mode & 0o7777, 0o700); }
  if (mode === "admit") { await mkdir(join(privateRoot, "tool-home"), { mode: 0o700 }); await mkdir(join(privateRoot, "tmp"), { mode: 0o700 }); }
  if (mode === "admit") await admit(temp, workspace);
  else if (mode === "oracle") await oracle(temp, workspace);
  else if (mode === "runtime-input") await runtimeInput(temp);
  else await result(temp);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch {
    const failure = { status: "FAIL", phase, category: "OWNED_MAC_PUBLISHER_REFUSED", children };
    if (evidence) await receipt(`${phase}-failure.json`, failure).catch(() => {});
    console.error(JSON.stringify(failure)); process.exitCode = 1;
  }
}

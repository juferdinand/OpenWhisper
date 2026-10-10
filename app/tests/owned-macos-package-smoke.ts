import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { z } from "zod";
import { appStateSchema, preferencesSchema, snippetSchema } from "../src/contracts/ui/state.js";
import { buildIdentitySchema, parseApplicationBuildModule } from "../src/contracts/application/build-identity.js";
import { validateMacBundleMetadata } from "../src/main/build-selection.js";
import { legacyMacosMigrationContextSchema } from "../src/services/migration/legacy-macos-data.js";
import { decodedLegacyMacosPlistSchema } from "../src/workers/migration/macos-legacy-plist.js";
import { pinnedRuntimeEnvironment } from "../scripts/runtime.js";
import { macUpdateZip } from "./fixtures/mac-update-zip.js";
import { classifyMacPublisherFixtureResult, parseMacPackageSmokeArguments, validateMacPackageUpdateConfiguration, validateUniversalMacPackageMetadata } from "./fixtures/mac-package-metadata.js";

// Stable selection changes only this launcher; the captured package must independently match.
if (process.platform !== "darwin" || process.getuid?.() === 0 || process.env["GITHUB_ACTIONS"] !== "true" ||
  process.env["OPENWHISPER_OWNED_MAC_PACKAGE_SMOKE"] !== "1") {
  throw new Error("Mac package smoke requires explicit owned non-root Mac CI execution.");
}
const { variant, packageFormat, packagePath, evidencePath, fixturePath } = parseMacPackageSmokeArguments(process.argv.slice(2));
const stable = variant === "stable";
if (stable && process.env["RUNNER_ENVIRONMENT"] !== "github-hosted") throw new Error("Stable smoke requires the disposable hosted Mac account.");
const sourceBundle = resolve(packagePath), evidence = resolve(evidencePath), fixtures = resolve(fixturePath);
const sourceRoot = join(sourceBundle, "Contents/Resources/app");
const capturedBuild = parseApplicationBuildModule(await readFile(join(sourceRoot, "dist/main/application-build.js"), "utf8"));
assert.equal(capturedBuild.kind, variant, "The explicit launcher variant must match the original package build.");
if (await realpath(sourceBundle) !== sourceBundle || !sourceBundle.endsWith(`/${capturedBuild.productName}.app`) ||
  evidence === sourceBundle || evidence.startsWith(`${sourceBundle}/`) || sourceBundle.startsWith(`${evidence}/`)) {
  throw new Error("A matching real package and separate fresh evidence directory are required.");
}
await mkdir(evidence, { mode: 0o700 });
assert.equal(await realpath(evidence), evidence);
assert.equal((await lstat(evidence)).uid, process.getuid?.());
const profile = join(evidence, "fresh-profile"), installationRoot = join(evidence, "Installation Slot");
const bundle = join(installationRoot, `${capturedBuild.productName}.app`), sourceExecutable = join(sourceBundle, `Contents/MacOS/${capturedBuild.productName}`);
const executable = join(bundle, `Contents/MacOS/${capturedBuild.productName}`), appPath = join(bundle, "Contents/Resources/app");
assert.equal((await lstat(sourceExecutable)).isSymbolicLink(), false);
const sourceDescriptorPath = join(sourceBundle, "Contents/Resources/app/dist/main/development-recording-build.js");
const sourceDescriptor = await readFile(sourceDescriptorPath);
const packageMetadata = packageFormat === "universal"
  ? validateUniversalMacPackageMetadata({
    receipt: JSON.parse(await readFile(join(sourceBundle, "Contents/Resources/notices/mac-universal-validation-package.json"), "utf8")) as unknown,
    thinReceipts: { arm64: JSON.parse(await readFile(join(sourceBundle, "Contents/Resources/notices/architectures/arm64/Contents/Resources/notices/mac-stable-validation-package.json"), "utf8")) as unknown,
      x64: JSON.parse(await readFile(join(sourceBundle, "Contents/Resources/notices/architectures/x64/Contents/Resources/notices/mac-stable-validation-package.json"), "utf8")) as unknown },
    applicationBuild: capturedBuild, source: JSON.parse(await readFile(join(sourceRoot, "dist/resources/development-build.json"), "utf8")) as unknown,
    recordingModule: sourceDescriptor.toString("utf8"), host: { platform: "darwin", architecture: process.arch },
  })
  : await (async () => {
    const receipt: unknown = JSON.parse(await readFile(join(sourceBundle,
      `Contents/Resources/notices/${stable ? "mac-stable-validation-package" : "mac-dev-package"}.json`), "utf8"));
    return { ...z.object({ architecture: z.literal(process.arch), sourceVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
      runtimeVersion: z.literal("44.7.0"), applicationBuild: buildIdentitySchema,
      signingMode: z.enum(["ad-hoc", "persistent-validation"]) }).parse(receipt),
      updateConfigured: validateMacPackageUpdateConfiguration(receipt) };
  })();
assert.deepEqual(packageMetadata.applicationBuild, capturedBuild);

const ownedHome = join(evidence, "home"), legacyRoot = join(ownedHome, "Library/Application Support/WhisperFree");
const legacySnippets = join(legacyRoot, "snippets.json"), legacyModel = join(legacyRoot, "Models/ggml-tiny.bin");
const configRoot = join(ownedHome, "Library/Application Support/io.github.whisperfree/electron");
const cacheRoot = join(ownedHome, "Library/Caches/io.github.whisperfree/electron");
const ownedSnippet = snippetSchema.parse({ id: "b445efb4-72bb-4b98-97a7-576866917ec5", trigger: "owned package",
  expansion: "OpenWhisper owned stable fixture 日本語", enabled: true });
const vocabulary = "OwnedStableFixture, 日本語";
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function frozenFile(path: string) {
  const metadata = await lstat(path, { bigint: true });
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n && metadata.uid === BigInt(process.getuid?.() ?? -1));
  return { dev: String(metadata.dev), ino: String(metadata.ino), size: String(metadata.size), mode: String(metadata.mode),
    mtimeNs: String(metadata.mtimeNs), ctimeNs: String(metadata.ctimeNs), sha256: digest(await readFile(path)) };
}
let originals: Awaited<ReturnType<typeof frozenFile>>[] | undefined;
let completionFiles: Awaited<ReturnType<typeof frozenFile>>[] | undefined;
const migrationPaths = [join(configRoot, "migration.json"), join(configRoot, "legacy/snippets.json"),
  join(configRoot, "legacy/decoded.json"), join(configRoot, "legacy/conversion.json")];
async function preserved(): Promise<void> {
  assert.deepEqual(await readFile(sourceDescriptorPath), sourceDescriptor);
  assert.deepEqual(await readFile(join(appPath, "dist/main/development-recording-build.js")), sourceDescriptor);
  assert.deepEqual(await Promise.all([legacySnippets, legacyModel].map(frozenFile)), originals);
  if (completionFiles) assert.deepEqual(await Promise.all(migrationPaths.map(frozenFile)), completionFiles);
  await assert.rejects(lstat(join(ownedHome, "Library/Preferences/io.github.whisperfree.plist")), { code: "ENOENT" });
}

let application: ElectronApplication | undefined, page: Page | undefined;
let identity: { executable: string; appPath: string; packaged: boolean; name: string;
  userData: string; sessionData: string; sandbox: boolean | undefined } | undefined;
let stage = "launch", passed = false;
let failure: { name: string; message?: string } | undefined;
let nativeUtilityLoading: unknown;
let signatureAdmission: unknown;
let archiveAdmission: unknown;
let installation: unknown;
let stableMigration: unknown;
let updateConfiguration: unknown;
let automaticUpdatePreferencePatch: unknown;
let restartExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
const checks: string[] = [];
try {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(pinnedRuntimeEnvironment(process.env))) if (value !== undefined) environment[key] = value;
  for (const key of Object.keys(environment)) if (key.startsWith("DYLD_") || key.startsWith("OPENWHISPER_") ||
    ["ELECTRON_FORCE_IS_PACKAGED", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "PULSE_SERVER", "PIPEWIRE_REMOTE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"].includes(key)) delete environment[key];
  stage = "packaged-node-cli-capability";
  const embeddedNode = execFileSync(sourceExecutable, ["--version"], { env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
  assert.match(embeddedNode.trim(), /^v(?:24|25|26)\.[0-9]+\.[0-9]+$/u, "The existing package must provide its embedded Node CLI without an app launch.");
  checks.push("Existing packaged runtime provides the embedded Node CLI without a system Node installation or fuse change");
  const installArguments = [join(sourceBundle, "Contents/Resources/app/dist/cli/install-dev.js"), "--source", sourceBundle,
    "--installation-root", installationRoot, "--profile", profile];
  const installEnvironment = { ...environment, ELECTRON_RUN_AS_NODE: "1" };
  if (stable) {
    stage = "fresh-stable-relocation";
    await mkdir(installationRoot, { mode: 0o700 });
    execFileSync("/usr/bin/ditto", [sourceBundle, bundle], { env: environment, timeout: 120_000, stdio: "ignore" });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { env: environment, timeout: 15_000, stdio: "ignore" });
    const bundleInfo: unknown = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(bundle, "Contents/Info.plist")],
      { env: environment, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }));
    validateMacBundleMetadata(capturedBuild, packageMetadata.sourceVersion, bundleInfo);
    assert.deepEqual(parseApplicationBuildModule(await readFile(join(appPath, "dist/main/application-build.js"), "utf8")), capturedBuild);
    stage = "owned-stable-legacy-source";
    await mkdir(ownedHome, { mode: 0o700 });
    await mkdir(join(legacyRoot, "Models"), { recursive: true, mode: 0o700 });
    const fixture = join(fixtures, "ggml-tiny.bin");
    assert.equal(await realpath(fixtures), fixtures);
    assert.ok((await lstat(fixture)).isFile() && !(await lstat(fixture)).isSymbolicLink());
    const fixtureBytes = await readFile(fixture);
    assert.equal(fixtureBytes.length, 77_691_713);
    assert.equal(digest(fixtureBytes), "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21");
    await copyFile(fixture, legacyModel); await chmod(legacyModel, 0o644);
    await writeFile(legacySnippets, JSON.stringify([ownedSnippet]), { flag: "wx", mode: 0o600 });
    originals = await Promise.all([legacySnippets, legacyModel].map(frozenFile));
    await assert.rejects(lstat(configRoot), { code: "ENOENT" });
    environment["HOME"] = ownedHome;
    environment["TMPDIR"] = evidence;
    installation = { applicationBuild: capturedBuild, installationRoot, application: bundle, executable,
      version: packageMetadata.sourceVersion, launchArguments: [], source: "fresh signed validation package copy; no installer" };
    await preserved();
    checks.push("Fresh signed stable app copied into owned slot; owned legacy snippets/model only; no preferences-domain write or Dev installer");
  } else {
    stage = "fresh-dev-installation";
    installation = z.object({ installationRoot: z.literal(installationRoot), application: z.literal(bundle),
      executable: z.literal(executable), profile: z.literal(profile), desktopFile: z.null(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      version: z.literal("0.3.1"), launchArguments: z.tuple([z.literal("--dev-profile"), z.literal(profile)]) }).parse(JSON.parse(
        execFileSync(sourceExecutable, installArguments, { env: installEnvironment, encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 })));
    await assert.rejects(lstat(profile), { code: "ENOENT" });
    checks.push("Embedded Node CLI copies and verifies a fresh signed Dev app, preserving source inputs and leaving the explicit profile nonexistent");
  }
  assert.deepEqual(await readFile(sourceDescriptorPath), sourceDescriptor);
  assert.equal((await lstat(executable)).isSymbolicLink(), false);
  stage = "launch";
  application = await _electron.launch({ executablePath: executable, args: stable ? [] : ["--dev-profile", profile],
    env: environment, chromiumSandbox: true, timeout: 30_000 });
  const original = application.process();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => original.once("close", (code, signal) => accept({ code, signal })));
  page = await application.firstWindow();
  await expect(page.locator(".sidebar-brand strong")).toHaveText(capturedBuild.productName, { timeout: 15_000 });
  assert.equal(page.url(), "app://openwhisper/index.html");
  const state = async () => appStateSchema.parse(await page!.evaluate(() => window.openwhisper!.invoke("get_state", {})));
  const finishSetupIfNeeded = async (setupPage: Page) => {
    const current = await state();
    if (current.preferences.setup_completed) return;
    await expect(setupPage.locator('nav button[data-tab="setup"]')).toBeVisible();
    await expect(setupPage.locator("nav button[data-tab]")).toHaveCount(1);
    await expect(setupPage.locator('nav button[data-tab="general"]')).toHaveCount(0);
    await setupPage.locator('[data-command="complete_setup"]').click();
    await expect.poll(async () => (await state()).preferences.setup_completed).toBe(true);
  };
  if (packageMetadata.updateConfigured) {
    stage = "owned-update-preference";
    const before = await state();
    updateConfiguration = { configured: before.updates.configured, macosConfigured: before.macos?.updates_configured,
      status: before.updates.status, version: before.version };
    if (!before.updates.configured || before.macos?.updates_configured !== true) {
      const observation = await application.evaluate(({ app }) => {
        const modules = process.getBuiltinModule("module"), path = process.getBuiltinModule("path");
        if (!modules || !path) throw new Error("Owned updater admission diagnostics are unavailable.");
        const appPath = app.getAppPath(), packagedRequire = modules.createRequire(path.join(appPath, "package.json"));
        const admissionModule = packagedRequire(path.join(appPath, "dist/main/macos-update-admission.js")) as {
          getLastMacosUpdateAdmissionObservation(): unknown;
        };
        return admissionModule.getLastMacosUpdateAdmissionObservation() ?? { stage: "not-attempted", outcome: "unknown" };
      });
      updateConfiguration = { ...updateConfiguration as object, admission: observation };
    }
    assert.equal(before.updates.configured, true, `Owned updater admission was refused: ${JSON.stringify(updateConfiguration)}`);
    assert.equal(before.macos?.updates_configured, true, `Owned updater state disagrees with its admission: ${JSON.stringify(updateConfiguration)}`);
    automaticUpdatePreferencePatch = { originalAutoCheckRequested: before.preferences.auto_check_updates,
      originalUpdateStatus: before.updates.status, requestedPatch: { auto_check_updates: false },
      networkAbsence: "NOT_ASSERTED; ordinary startup may already have made an authorized read-only metadata request",
      explicitCheckDownloadInstall: "NOT_INVOKED" };
    await page.evaluate(() => window.openwhisper!.invoke("save_preferences", { changes: { auto_check_updates: false } }));
    await expect.poll(async () => (await state()).preferences.auto_check_updates, { timeout: 10_000 }).toBe(false);
  }
  stage = "package-identity";
  identity = await application.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === "app://openwhisper/index.html");
    if (!window) throw new Error("Owned main window is missing.");
    const renderer = app.getAppMetrics().find((item) => item.pid === window.webContents.getOSProcessId());
    return { executable: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged, name: app.getName(),
      userData: app.getPath("userData"), sessionData: app.getPath("sessionData"),
      sandbox: renderer?.sandboxed };
  });
  assert.equal(identity.executable, executable, "The actual selected executable must run.");
  assert.equal(identity.appPath, appPath, "The package must use its own Resources/app.");
  assert.equal(identity.packaged, true, "Electron must recognize the renamed packaged executable.");
  assert.equal(identity.name, capturedBuild.productName, "The app must match its captured product name.");
  assert.equal(identity.sandbox, true, "The actual Mac renderer must have its OS sandbox enabled.");
  assert.deepEqual(await page.evaluate(() => ({ node: typeof Reflect.get(window, "process"), require: typeof Reflect.get(window, "require") })),
    { node: "undefined", require: "undefined" });
  if (stable) {
    assert.equal(identity.userData, configRoot); assert.equal(identity.sessionData, join(cacheRoot, "session"));
  } else assert.ok(identity.userData.startsWith(`${profile}/`) && identity.sessionData.startsWith(`${profile}/`));
  checks.push(`Actual packaged executable and Resources/app; isolated ${variant} storage; sandboxed shared UI`);
  stage = "owned-update-signature-admission";
  const verifyCandidate = async (candidate: string) => z.strictObject({ accepted: z.boolean(), code: z.enum(["INVALID_PATH", "UNSUPPORTED_HOST", "NATIVE_UNAVAILABLE",
    "NATIVE_RESULT_INVALID", "CURRENT_SIGNATURE_UNAVAILABLE", "INVALID_SIGNATURE", "RELEASE_FAILED"]).nullable(),
    osStatus: z.number().int().nullable() }).parse(await application!.evaluate(({ app }, staged: string) => {
    const modules = process.getBuiltinModule("module"), path = process.getBuiltinModule("path");
    if (!modules || !path) throw new Error("Owned signature test dependencies are unavailable.");
    const packagedRequire = modules.createRequire(path.join(app.getAppPath(), "package.json"));
    const service = packagedRequire(path.join(app.getAppPath(), "dist/services/update/macos/macos-update-signature.js")) as typeof import("../src/services/update/macos/macos-update-signature.js");
    try { service.verifyMacosUpdateSignature(staged); return { accepted: true, code: null, osStatus: null }; }
    catch (error: unknown) {
      if (!(error instanceof service.MacosUpdateSignatureError)) throw new Error("Unexpected owned signature failure.");
      return { accepted: false, code: error.code, osStatus: error.osStatus ?? null };
    }
  }, candidate));
  const signatureCases: { name: "self" | "different-identity" | "unsigned" | "tampered"; result: Awaited<ReturnType<typeof verifyCandidate>> }[] = [];
  const signatureContext = { flags: 25, architecture: process.arch, signingMode: packageMetadata.signingMode,
    scope: packageFormat === "universal"
      ? "Actual running universal package requirement; captured signing mode; no persistent 0.2.5 publisher or install authorization claim"
      : "Actual running package requirement; captured signing mode; no persistent 0.2.5 publisher, universal artifact or install authorization claim" };
  signatureAdmission = { ...signatureContext, cases: signatureCases };
  stage = "update-signature-self";
  const selfSignature = await verifyCandidate(bundle); signatureCases.push({ name: "self", result: selfSignature });
  const selfAvailability = classifyMacPublisherFixtureResult({ fixture: "self", packageFormat,
    signingMode: packageMetadata.signingMode, result: selfSignature });
  signatureAdmission = { ...signatureContext, cases: signatureCases, selfAvailability };
  console.log(JSON.stringify({ stage, signingMode: packageMetadata.signingMode, selfAvailability }));
  const signatureRoot = join(evidence, "signature-candidates"); await mkdir(signatureRoot, { mode: 0o700 });
  const wrongRoot = join(signatureRoot, "different-identity"), tamperedRoot = join(signatureRoot, "tampered");
  for (const path of [wrongRoot, tamperedRoot]) await mkdir(path, { mode: 0o700 });
  const wrongBundle = join(wrongRoot, `${capturedBuild.productName}.app`), tamperedBundle = join(tamperedRoot, `${capturedBuild.productName}.app`);
  for (const candidate of [wrongBundle, tamperedBundle]) execFileSync("/usr/bin/ditto", [bundle, candidate], { env: environment, timeout: 120_000, stdio: "ignore" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "io.github.whisperfree.owned-wrong-publisher", "--timestamp=none", wrongBundle],
    { env: environment, timeout: 15_000, stdio: "ignore" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", wrongBundle], { env: environment, timeout: 15_000, stdio: "ignore" });
  stage = "update-signature-different-identity";
  const differentIdentity = await verifyCandidate(wrongBundle); signatureCases.push({ name: "different-identity", result: differentIdentity });
  assert.equal(differentIdentity.accepted, false); assert.equal(differentIdentity.code, "INVALID_SIGNATURE");
  execFileSync("/usr/bin/codesign", ["--remove-signature", wrongBundle], { env: environment, timeout: 15_000, stdio: "ignore" });
  stage = "update-signature-unsigned";
  const unsigned = await verifyCandidate(wrongBundle); signatureCases.push({ name: "unsigned", result: unsigned });
  assert.equal(unsigned.accepted, false); assert.equal(unsigned.code, "INVALID_SIGNATURE");
  const sealedResource = join(tamperedBundle, "Contents/Resources/app/dist/resources/VERSION");
  assert.ok((await lstat(sealedResource)).isFile() && !(await lstat(sealedResource)).isSymbolicLink());
  await writeFile(sealedResource, "owned-invalid-sealed-resource\n");
  stage = "update-signature-tampered";
  const tampered = await verifyCandidate(tamperedBundle); signatureCases.push({ name: "tampered", result: tampered });
  assert.equal(tampered.accepted, false); assert.equal(tampered.code, "INVALID_SIGNATURE");
  assert.deepEqual(await readFile(sourceDescriptorPath), sourceDescriptor);
  assert.deepEqual(await readFile(join(appPath, "dist/main/development-recording-build.js")), sourceDescriptor);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { env: environment, timeout: 15_000, stdio: "ignore" });
  checks.push(selfAvailability === "ACCEPTED"
    ? "Current running-app requirement accepts itself and rejects valid different ad-hoc identity, unsigned code and changed sealed resource"
    : "Producer-admitted universal ad-hoc self publisher acceptance is unavailable at INVALID_SIGNATURE/-67050; different identity, unsigned code and changed sealed resource are rejected");
  stage = "owned-update-archive-admission";
  const archiveRoot = join(evidence, "archive-candidates"), outside = join(archiveRoot, "outside");
  await mkdir(archiveRoot, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
  const archiveFixtures = ["real-package", "wrong-version", "corrupt", "missing-app", "app-symlink", "external-symlink", "dotdot", "symlink-write"] as const;
  const realZIP = join(archiveRoot, "real-package.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, realZIP], { env: environment, timeout: 120_000, stdio: "ignore" });
  await chmod(realZIP, 0o600);
  await copyFile(realZIP, join(archiveRoot, "wrong-version.zip")); await chmod(join(archiveRoot, "wrong-version.zip"), 0o600);
  const product = `${capturedBuild.productName}.app`;
  const hostileZIPs = {
    corrupt: Buffer.from("not a zip"),
    "missing-app": macUpdateZip([{ name: "Other.app/Contents/Info.plist", content: "bad" }]),
    "app-symlink": macUpdateZip([{ name: product, content: outside, mode: 0o120777 }]),
    "external-symlink": macUpdateZip([{ name: `${product}/Contents/Resources/escape`, content: outside, mode: 0o120777 }]),
    dotdot: macUpdateZip([{ name: "../../outside/marker", content: "bad" }]),
    "symlink-write": macUpdateZip([{ name: "escape", content: outside, mode: 0o120777 }, { name: "escape/marker", content: "bad" }]),
  };
  for (const [name, bytes] of Object.entries(hostileZIPs)) await writeFile(join(archiveRoot, `${name}.zip`), bytes, { flag: "wx", mode: 0o600 });
  const archiveOriginals = await Promise.all(archiveFixtures.map((name) => frozenFile(join(archiveRoot, `${name}.zip`))));
  const archiveResults = await application.evaluate(async ({ app }, input) => {
    const modules = process.getBuiltinModule("module"), path = process.getBuiltinModule("path"), fs = process.getBuiltinModule("fs/promises"),
      nativeFS = process.getBuiltinModule("fs");
    const assert: { ok(value: unknown): void; equal(actual: unknown, expected: unknown): void;
      deepEqual(actual: unknown, expected: unknown): void;
      rejects: typeof import("node:assert/strict")["rejects"] } | undefined = process.getBuiltinModule("assert/strict");
    if (!modules || !path || !fs || !nativeFS || !assert) throw new Error("Owned archive dependencies are unavailable.");
    const packagedRequire = modules.createRequire(path.join(app.getAppPath(), "package.json"));
    const staging = packagedRequire(path.join(app.getAppPath(), "dist/services/update/common/update-staging.js")) as typeof import("../src/services/update/common/update-staging.js");
    const archive = packagedRequire(path.join(app.getAppPath(), "dist/services/update/macos/macos-update-archive.js")) as typeof import("../src/services/update/macos/macos-update-archive.js");
    const signature = packagedRequire(path.join(app.getAppPath(), "dist/services/update/macos/macos-update-signature.js")) as typeof import("../src/services/update/macos/macos-update-signature.js");
    const results: { name: string; accepted: boolean; code: string | null; osStatus: number | null; bytes: number; sameVersionRefused: boolean }[] = [];
    for (const name of input.names) {
      const stageDirectory = await fs.mkdtemp(path.join(input.root, "download-"));
      const file = await fs.open(path.join(stageDirectory, "OpenWhisper-macOS.zip"),
        nativeFS.constants.O_RDWR | nativeFS.constants.O_CREAT | nativeFS.constants.O_EXCL | nativeFS.constants.O_NOFOLLOW, 0o600);
      let download: Awaited<ReturnType<typeof staging.retainOwnedUpdateDownload>> | undefined;
      let extracted: Awaited<ReturnType<typeof archive.extractVerifiedMacUpdateArchive>> | undefined;
      let cleanupFailure: Error | undefined;
      try {
        const source = await fs.open(path.join(input.root, `${name}.zip`), nativeFS.constants.O_RDONLY | nativeFS.constants.O_NOFOLLOW);
        try {
          const block = Buffer.alloc(64 * 1024); let position = 0;
          for (;;) {
            const { bytesRead } = await source.read(block, 0, block.length, position); if (!bytesRead) break;
            let written = 0;
            while (written < bytesRead) {
              const result = await file.write(block, written, bytesRead - written, position + written);
              assert.ok(result.bytesWritten > 0); written += result.bytesWritten;
            }
            position += bytesRead;
          }
          await file.sync();
        } finally { await source.close(); }
        download = await staging.retainOwnedUpdateDownload({ file, stageDirectory, artifactName: "OpenWhisper-macOS.zip" });
        let sameVersionRefused = false;
        if (name === "real-package") {
          await assert.rejects(archive.extractVerifiedMacUpdateArchive({ download, build: input.build,
            expectedVersion: input.version, currentVersion: input.version }), (error: unknown) =>
            error instanceof archive.MacosUpdateArchiveError && error.code === "INVALID_INPUT");
          assert.deepEqual(await fs.readdir(stageDirectory), ["OpenWhisper-macOS.zip"]); sameVersionRefused = true;
        }
        try {
          extracted = await archive.extractVerifiedMacUpdateArchive({ download, build: input.build,
            expectedVersion: name === "wrong-version" ? "1.0.0" : input.version, currentVersion: "0.0.0" });
          assert.equal(extracted.version, input.version); assert.equal(path.basename(extracted.bundlePath), `${input.build.productName}.app`);
          assert.equal((await file.stat()).size, download.bytes);
          results.push({ name, accepted: true, code: null, osStatus: null, bytes: download.bytes, sameVersionRefused });
        } catch (error: unknown) {
          if (error instanceof signature.MacosUpdateSignatureError) {
            if (name !== "real-package" || input.selfAvailability !== "UNAVAILABLE" ||
              error.code !== "INVALID_SIGNATURE" || error.osStatus !== -67050) throw error;
          } else {
            if (!(error instanceof archive.MacosUpdateArchiveError)) throw error;
            if (error.code === "CLEANUP_FAILED") { cleanupFailure = error; throw error; }
          }
          assert.deepEqual(await fs.readdir(stageDirectory), ["OpenWhisper-macOS.zip"]);
          assert.equal((await file.stat()).size, download.bytes);
          results.push({ name, accepted: false, code: error.code,
            osStatus: error instanceof signature.MacosUpdateSignatureError ? error.osStatus ?? null : null,
            bytes: download.bytes, sameVersionRefused });
        }
      } finally {
        try {
          if (download) await archive.cleanupMacUpdateArchiveDownload(extracted, download);
          else { await file.close(); await fs.rm(stageDirectory, { recursive: true }); }
        } catch (error: unknown) {
          cleanupFailure ??= error instanceof Error ? error : new Error("UNCLASSIFIED_CLEANUP_FAILURE");
        }
        if (cleanupFailure) {
          // Fixed fixture names and categorical codes only; never expose paths or raw filesystem messages.
          if (cleanupFailure instanceof archive.MacosUpdateArchiveError) {
            throw new Error(`Owned archive fixture ${name}: ${cleanupFailure.code}:${cleanupFailure.cleanupPhase ?? "UNCLASSIFIED"}:${cleanupFailure.cleanupCause ?? "UNCLASSIFIED"}`);
          }
          if (cleanupFailure instanceof staging.UpdateStagingError) throw new Error(`Owned archive fixture ${name}: ${cleanupFailure.code}`);
          throw new Error(`Owned archive fixture ${name}: UNCLASSIFIED_CLEANUP_FAILURE`);
        }
      }
      await assert.rejects(fs.lstat(stageDirectory), { code: "ENOENT" });
      await assert.rejects(fs.lstat(path.join(input.outside, "marker")), { code: "ENOENT" });
    }
    return results;
  }, { root: archiveRoot, outside, names: [...archiveFixtures], build: capturedBuild, version: packageMetadata.sourceVersion, selfAvailability });
  const archiveContext = { cases: archiveResults, descriptor: "Original exclusively created descriptor inherited as fd3, positioned producer writes",
    scope: "Actual packaged main and ditto ZIP; synthetic prior version0.0.0; captured signing mode; no persistent release publisher or installation claim" };
  archiveAdmission = archiveContext;
  assert.equal(archiveResults.length, archiveFixtures.length);
  const realPackage = archiveResults[0]; assert.ok(realPackage); assert.equal(realPackage.name, "real-package");
  const publisherAvailability = classifyMacPublisherFixtureResult({ fixture: "real-package", packageFormat,
    signingMode: packageMetadata.signingMode, selfAvailability,
    result: { accepted: realPackage.accepted, code: realPackage.code, osStatus: realPackage.osStatus } });
  assert.equal(realPackage.sameVersionRefused, true);
  assert.ok(archiveResults.slice(1).every((result) => result.accepted === false));
  assert.equal(archiveResults[1]?.code, "INVALID_BUNDLE");
  assert.deepEqual(await Promise.all(archiveFixtures.map((name) => frozenFile(join(archiveRoot, `${name}.zip`)))), archiveOriginals);
  assert.ok((await readdir(archiveRoot)).every((name) => !name.startsWith("download-")));
  archiveAdmission = { ...archiveContext, publisherAvailability };
  console.log(JSON.stringify({ stage, signingMode: packageMetadata.signingMode, selfAvailability, publisherAvailability }));
  checks.push(publisherAvailability === "ACCEPTED"
    ? "Original fd3 Mac ZIP extraction accepts actual packaged app and refuses version, traversal, symlink and corrupt archives with complete owned cleanup"
    : "Actual original-fd3 ZIP publisher acceptance is unavailable at the measured universal ad-hoc requirement; same-version and hostile archive refusals and complete owned cleanup pass");
  stage = "native-composition";
  const initial = await state();
  assert.equal(initial.updates.configured, packageMetadata.updateConfigured);
  assert.equal(initial.macos?.updates_configured, packageMetadata.updateConfigured);
  updateConfiguration = { expected: packageMetadata.updateConfigured, updatesConfigured: initial.updates.configured,
    macosUpdatesConfigured: initial.macos?.updates_configured, signingMode: packageMetadata.signingMode,
    automaticUpdatePreferencePatch,
    scope: "Actual normal main self-publisher/build-policy/UI configuration only; no explicit check, download, installation or publication acceptance" };
  checks.push("Actual normal main update configuration matches explicit persistent producer evidence; legacy receipts default off");
  assert.equal(initial.profile, stable ? undefined : "development"); assert.equal(initial.platform, "macos");
  assert.equal(initial.native_shortcuts, true, "The packaged normal main must enable Mac keyboard controls.");
  assert.equal(initial.macos?.shortcut_toggle_only, true, "The Mac recording descriptor must be active.");
  assert.equal(initial.status, "idle"); assert.deepEqual(initial.installed, stable ? ["tiny"] : []); assert.equal(initial.microphones.length, 0);
  assert.equal(initial.preferences.macos_shortcut ?? null, null);
  if (!initial.preferences.setup_completed) {
    await expect(page.locator('nav button[data-tab="setup"]')).toBeVisible();
    await expect(page.locator("nav button[data-tab]")).toHaveCount(1);
    await expect(page.locator('nav button[data-tab="general"]')).toHaveCount(0);
  }
  checks.push("Normal production main factory initializes from signed packaged retirement/native descriptors");
  if (stable) {
    stage = "stable-native-context";
    const nativeFacts = await application.evaluate(async ({ app }) => {
      const modules = process.getBuiltinModule("module"), path = process.getBuiltinModule("path"),
        fs = process.getBuiltinModule("fs/promises"), os = process.getBuiltinModule("os");
      if (!modules || !path || !fs || !os) throw new Error("Native main facts are unavailable.");
      const root = app.getAppPath(), packagedRequire = modules.createRequire(path.join(root, "package.json"));
      const admission = packagedRequire(path.join(root, "dist/main/macos-stable-admission.js")) as typeof import("../src/main/macos-stable-admission.js");
      const build = packagedRequire(path.join(root, "dist/main/application-build.js")) as { APPLICATION_BUILD: unknown };
      const context = admission.macosMigrationContext({ languages: app.getPreferredSystemLanguages(), architecture: process.arch,
        physicalMemory: os.totalmem(), loginStatus: app.getLoginItemSettings({ type: "mainAppService" }).status,
        catalog: JSON.parse(await fs.readFile(path.join(root, "dist/resources/models.json"), "utf8")) as unknown });
      return { context, build: build.APPLICATION_BUILD, home: os.homedir(), argv: process.argv,
        logs: app.getPath("logs"), diskCache: app.commandLine.getSwitchValue("disk-cache-dir") };
    });
    const nativeContext = legacyMacosMigrationContextSchema.parse(nativeFacts.context);
    assert.deepEqual(buildIdentitySchema.parse(nativeFacts.build), capturedBuild);
    assert.equal(nativeFacts.home, ownedHome); assert.equal(nativeFacts.logs, join(cacheRoot, "logs"));
    assert.equal(nativeFacts.diskCache, join(cacheRoot, "cache"));
    assert.ok(nativeFacts.argv.every((argument) => !["--dev", "--dev-profile", "--control"].some((flag) =>
      argument === flag || argument.startsWith(`${flag}=`))));
    const backup = z.object({ bytes: z.int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
    const manifest = z.object({ version: z.literal(1), appId: z.literal("io.github.whisperfree"),
      sourceFormat: z.literal("macos-v0.2.5"), preferences: z.null(), snippets: backup, decoded: backup, conversion: backup })
      .parse(JSON.parse(await readFile(migrationPaths[0]!, "utf8")) as unknown);
    const rawSnippet = await readFile(legacySnippets);
    assert.deepEqual(await readFile(migrationPaths[1]!), rawSnippet);
    for (const [path, expected] of [[migrationPaths[1]!, manifest.snippets], [migrationPaths[2]!, manifest.decoded],
      [migrationPaths[3]!, manifest.conversion]] as const) {
      const bytes = await readFile(path); assert.equal(bytes.length, expected.bytes); assert.equal(digest(bytes), expected.sha256);
    }
    assert.deepEqual(decodedLegacyMacosPlistSchema.parse(JSON.parse(await readFile(migrationPaths[2]!, "utf8")) as unknown),
      { plist: {}, nativeValues: [] });
    const conversion = z.object({ context: legacyMacosMigrationContextSchema, snippets: z.array(snippetSchema),
      history: z.array(z.string()) }).parse(JSON.parse(await readFile(migrationPaths[3]!, "utf8")) as unknown);
    assert.deepEqual(conversion.context, nativeContext); assert.deepEqual(conversion.snippets, [ownedSnippet]);
    assert.deepEqual(conversion.history, []); assert.deepEqual(initial.preferences.snippets, [ownedSnippet]);
    assert.equal(initial.preferences.model, nativeContext.defaults.recommendedModel);
    const nativeLanguage = preferencesSchema.shape.language.safeParse(Array.from(nativeContext.systemLanguage).slice(0, 2).join(""));
    assert.equal(initial.preferences.language, nativeLanguage.success ? nativeLanguage.data : "auto");
    assert.equal(initial.preferences.gpu, nativeContext.defaults.appleSilicon);
    assert.equal(initial.preferences.launch_at_login, nativeContext.defaults.launchAtLogin);
    assert.deepEqual(preferencesSchema.parse(JSON.parse(await readFile(join(configRoot, "settings/preferences.json"), "utf8")) as unknown), initial.preferences);
    assert.deepEqual(JSON.parse(await readFile(join(configRoot, "history/history.json"), "utf8")) as unknown, []);
    for (const path of [ownedHome, configRoot, join(configRoot, "settings"), join(configRoot, "legacy"), cacheRoot, identity.sessionData, nativeFacts.logs]) {
      const metadata = await lstat(path); assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
      assert.equal(metadata.uid, process.getuid?.()); assert.equal(metadata.mode & 0o7777, 0o700);
    }
    assert.ok((await readdir(join(ownedHome, "Library/Application Support/io.github.whisperfree")))
      .every((name) => !name.startsWith(".electron-migration-")));
    completionFiles = await Promise.all(migrationPaths.map(frozenFile)); await preserved();
    stableMigration = { context: nativeContext, preferencesDomain: "actual OS current user / io.github.whisperfree / AnyHost; empty",
      archivedPlist: "ABSENT", sourceFormat: manifest.sourceFormat, legacySnippetSha256: digest(rawSnippet),
      legacyModelSha256: originals?.[1]?.sha256, preferenceWrites: "owned JSON only; no CFPreferences writes",
      readiness: "ordinary packaged main reached UI after its pre-ready profile guard" };
    stage = "stable-migrated-ui";
    await finishSetupIfNeeded(page);
    await page.locator('[data-tab="snippets"]').click();
    await expect(page.locator('#snippet-form [name="trigger"]')).toHaveValue(ownedSnippet.trigger);
    await expect(page.locator('#snippet-form [name="expansion"]')).toHaveValue(ownedSnippet.expansion);
    await page.locator('[data-tab="models"]').click();
    await expect(page.locator('[data-delete="tiny"]')).toBeVisible();
    checks.push("Normal stable migration agrees actual empty native domain, real login/hardware/language defaults, exact raw snippets backup and legacy Tiny inventory");
  }
  if (!stable) await finishSetupIfNeeded(page);
  if (!stable) {
    stage = "existing-installation-refusal";
    const refused = spawnSync(sourceExecutable, installArguments, { env: installEnvironment, encoding: "utf8", shell: false,
      timeout: 30_000, maxBuffer: 256 * 1024 });
    assert.equal(refused.error, undefined); assert.equal(refused.status, 1); assert.equal(refused.signal, null);
    assert.match(refused.stderr, /A fresh path is required/u);
    assert.equal(original.exitCode, null); assert.equal(original.signalCode, null);
    assert.equal((await state()).status, "idle");
    assert.deepEqual(await readFile(sourceDescriptorPath), sourceDescriptor);
    assert.deepEqual(await readFile(join(appPath, "dist/main/development-recording-build.js")), sourceDescriptor);
    checks.push("A second installation refuses the existing root while the original relocated app remains alive and idle");
  }
  if (!stable || packageFormat === "universal") {
    stage = "signed-native-utility-loading";
    nativeUtilityLoading = await application.evaluate(async ({ app, utilityProcess, session }, fixtureRoot: string) => {
      const path = process.getBuiltinModule("path"), modules = process.getBuiltinModule("module"), crypto = process.getBuiltinModule("crypto");
      const fs = process.getBuiltinModule("fs/promises");
      if (!path || !modules || !crypto || !fs || !app.isPackaged) throw new Error("Packaged utility inputs unavailable.");
      const root = app.getAppPath(), deadline = Date.now() + 90_000;
      let phase = "packaged-inputs";
      // Object methods avoid tsx's external function-name helper in Playwright's serialized callback.
      const bounded = { async call<T>(operation: Promise<T>, until = deadline, maximum = 8000): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try { return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${phase}: deadline`)), Math.max(1, Math.min(maximum, until - Date.now())));
        })]); } finally { if (timer) clearTimeout(timer); }
      } }.call;
      const requireCondition = { call(value: unknown, message: string): void { if (!value) throw new Error(`${phase}: ${message}`); } }.call;
      const mainInventory = { call(): boolean {
        if (process.report) { process.report.excludeEnv = true; Reflect.set(process.report, "excludeNetwork", true); }
        const report: unknown = process.report?.getReport();
        const objects: unknown = report && typeof report === "object" ? Reflect.get(report, "sharedObjects") : undefined;
        requireCondition(Array.isArray(objects) && objects.every((item: unknown) => typeof item === "string"), "main native inventory unavailable");
        return (objects as string[]).some((item) => /openwhisper_(?:macos_capture|speech)\.node$/u.test(item));
      } }.call;
      const goneReasons = ["clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction"] as const;
      type Owner = { child: ReturnType<typeof utilityProcess.fork>; spawned: Promise<number>; exit: Promise<number>;
        exited: boolean; failed: boolean; frames: unknown[]; wake: (() => void) | undefined; pid: number | undefined;
        serviceName: string; exitCode: number | undefined;
        gone: { reason: typeof goneReasons[number]; exitCode: number | null } | undefined };
      const owners: Owner[] = [];
      const observeGone = { call(_event: unknown, details: unknown): void {
        try {
          if (typeof details !== "object" || details === null || Reflect.get(details, "type") !== "Utility") return;
          const owner = owners.find((item) => item.serviceName === Reflect.get(details, "serviceName"));
          const reason = goneReasons.find((item) => item === Reflect.get(details, "reason"));
          if (!owner || !reason) return;
          const code: unknown = Reflect.get(details, "exitCode");
          owner.gone = { reason, exitCode: typeof code === "number" && Number.isSafeInteger(code) ? code : null };
        } catch { /* Observation failures cannot change utility ownership. */ }
      } }.call;
      app.on("child-process-gone", observeGone);
      let capture: { pid: number; generation: number; exitCode: number } | undefined;
      let speech: { pid: number; gpu: null; exitCode: number } | undefined;
      let inference: { recognized: boolean; modelSha256: string; audioSha256: string; sampleCount: number } | undefined;
      let error: string | undefined;
      try {
        requireCondition(!mainInventory(), "capture/speech loaded in main before utility test");
        // Inspector eval has no dynamic-import callback; require the packaged synchronous ESM graph.
        const packagedRequire = modules.createRequire(path.join(root, "package.json"));
        const build = packagedRequire(path.join(root, "dist/main/development-recording-build.js")) as { DEVELOPMENT_RECORDING_BUILD: unknown };
        const schema = packagedRequire(path.join(root, "dist/main/development-recording-descriptor.js")) as typeof import("../src/main/development-recording-descriptor.js");
        const artifacts = packagedRequire(path.join(root, "dist/services/development/development-artifact.js")) as typeof import("../src/services/development/development-artifact.js");
        const recording = packagedRequire(path.join(root, "dist/workers/recording/macos-recording-host-protocol.js")) as typeof import("../src/workers/recording/macos-recording-host-protocol.js");
        const resources = packagedRequire(path.join(root, "dist/services/speech/speech-resources.js")) as typeof import("../src/services/speech/speech-resources.js");
        const graph = packagedRequire(path.join(root, "dist/services/speech/speech-entry-graph.js")) as typeof import("../src/services/speech/speech-entry-graph.js");
        const control = packagedRequire(path.join(root, "dist/workers/speech/speech-control.js")) as typeof import("../src/workers/speech/speech-control.js");
        const protocol = packagedRequire(path.join(root, "dist/workers/speech/speech-protocol.js")) as typeof import("../src/workers/speech/speech-protocol.js");
        const mac = packagedRequire(path.join(root, "dist/main/macos-speech-host.js")) as typeof import("../src/main/macos-speech-host.js");
        const descriptor = schema.selectDevelopmentRecordingDescriptor(build.DEVELOPMENT_RECORDING_BUILD, { platform: "darwin", architecture: process.arch });
        requireCondition(descriptor.platform === "darwin" && descriptor.architecture === process.arch, "descriptor platform/architecture");
        const spawn = { call(entry: string, arguments_: string[], serviceName: string): Owner {
          const child = utilityProcess.fork(entry, arguments_, { serviceName, stdio: "ignore", execArgv: [], session: session.defaultSession,
            allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false, env: mac.macSpeechEnvironment(process.env) });
          let acceptSpawn!: (pid: number) => void, rejectSpawn!: (error: Error) => void, acceptExit!: (code: number) => void;
          const owner: Owner = { child, spawned: new Promise((accept, reject) => { acceptSpawn = accept; rejectSpawn = reject; }),
            exit: new Promise((accept) => { acceptExit = accept; }), exited: false, failed: false, frames: [], wake: undefined, pid: undefined,
            serviceName, exitCode: undefined, gone: undefined };
          owners.push(owner); void owner.spawned.catch(() => {});
          child.once("spawn", () => { const pid = child.pid;
            if (!pid) { owner.failed = true; rejectSpawn(new Error("Original utility PID missing")); }
            else { owner.pid = pid; acceptSpawn(pid); } owner.wake?.(); });
          child.on("message", (input: unknown) => { if (owner.frames.length >= 64) owner.failed = true; else owner.frames.push(input); owner.wake?.(); });
          child.on("error", () => { owner.failed = true; rejectSpawn(new Error("Original utility error")); owner.wake?.(); });
          child.once("exit", (code) => { owner.exited = true; owner.exitCode = Number.isSafeInteger(code) ? code : undefined;
            acceptExit(code); rejectSpawn(new Error("Original utility exited")); owner.wake?.(); });
          return owner;
        } }.call;
        const next = { async call(owner: Owner, maximum = 8000): Promise<unknown> {
          while (!owner.frames.length) {
            requireCondition(!owner.failed && !owner.exited, "original utility failed/exited before reply");
            await bounded(new Promise<void>((accept) => { owner.wake = accept; }), deadline, maximum); owner.wake = undefined;
          }
          requireCondition(!owner.failed, "original utility channel failed"); return owner.frames.shift();
        } }.call;
        phase = "capture-entry";
        const captureEntry = await bounded(artifacts.verifyDevelopmentMacCaptureEntry(root, descriptor.captureEntry));
        const epoch = crypto.randomUUID(), captureOwner = spawn(captureEntry, [epoch], "OpenWhisper Dev Capture Load Check");
        const capturePid = await bounded(captureOwner.spawned);
        const captureReady = recording.macRecordingHostReplySchema.parse(await next(captureOwner));
        requireCondition(captureReady.kind === "ready" && captureReady.epoch === epoch && captureReady.pid === capturePid, "original capture ready identity");
        const captureControl = { async call(command: "configure" | "close") {
          const id = crypto.randomUUID();
          const request = recording.macRecordingHostRequestSchema.parse({ version: 1, channel: "recording-host", epoch, id, command,
            ...(command === "configure" ? { capture: descriptor.capture, request: {
              model: { path: path.join(app.getPath("userData"), "unused-native-loading-model.bin"), family: "whisper", gpu: false },
              language: "auto", vocabulary: "", snippets: [] } } : {}) });
          captureOwner.child.postMessage(request);
          for (;;) {
            const reply = recording.macRecordingHostReplySchema.parse(await next(captureOwner));
            requireCondition(reply.epoch === epoch, "capture reply epoch");
            if (reply.kind === "snapshot") { requireCondition(reply.snapshot.phase === "idle" && reply.snapshot.generation === 0 && !reply.snapshot.busy, "capture must remain idle without Start"); continue; }
            requireCondition(reply.kind === "control" && reply.id === id && reply.command === command && reply.reply.ok && reply.reply.generation === 0, "capture control identity/result");
            break;
          }
        } }.call;
        phase = "capture-configure-native-load"; await captureControl("configure");
        phase = "capture-close"; await captureControl("close");
        requireCondition(captureOwner.child.kill(), "original capture termination request");
        const captureExit = await bounded(captureOwner.exit); requireCondition(captureExit === 0, "capture original exit");
        capture = { pid: capturePid, generation: 0, exitCode: captureExit };
        phase = "speech-entry";
        const catalog = await bounded(resources.prepareSpeechResources(path.join(root, "dist"), descriptor.speech));
        const preparedGraph = await bounded(graph.prepareSpeechEntryGraph(root, descriptor.speechEntryGraph));
        const entry = await bounded(graph.verifySpeechEntryGraph(preparedGraph)), resource = await bounded(resources.verifySpeechResource(catalog, "cpu"));
        const speechEpoch = crypto.randomUUID(), speechOwner = spawn(entry.entry, [resource.path, speechEpoch], "OpenWhisper Dev Speech Load Check");
        const speechPid = await bounded(speechOwner.spawned);
        protocol.speechReadySchema.parse(await next(speechOwner));
        phase = "speech-challenges";
        for (let index = 0; index < 2; index++) {
          const nonce = crypto.randomUUID(); speechOwner.child.postMessage(control.speechChallengeRequestSchema.parse({ version: 1, type: "challenge", epoch: speechEpoch, nonce }));
          const reply = control.speechChallengeReplySchema.parse(await next(speechOwner));
          requireCondition(reply.pid === speechPid && reply.epoch === speechEpoch && reply.nonce === nonce, "original speech challenge identity");
        }
        const speechRequest = { async call(command: "discover" | "shutdown") {
          const id = crypto.randomUUID(); speechOwner.child.postMessage(protocol.speechRequestSchema.parse({ version: 1, id, command }));
          const reply = protocol.speechReplySchema.parse(await next(speechOwner));
          requireCondition(reply.id === id && reply.ok && reply.value.command === command, "speech reply identity/result");
          if (reply.ok && reply.value.command === "discover") requireCondition(reply.value.gpu === null, "CPU package capability");
        } }.call;
        phase = "speech-discover-native-load"; await speechRequest("discover");
        phase = "speech-pinned-fixtures";
        requireCondition(await bounded(fs.realpath(fixtureRoot)) === fixtureRoot, "real pinned fixture directory");
        const modelPath = path.join(fixtureRoot, "ggml-tiny.bin"), audioPath = path.join(fixtureRoot, "jfk.f32");
        const modelFile = await bounded(fs.lstat(modelPath)), audioFile = await bounded(fs.lstat(audioPath));
        requireCondition(modelFile.isFile() && !modelFile.isSymbolicLink() && modelFile.size === 77_691_713 &&
          audioFile.isFile() && !audioFile.isSymbolicLink() && audioFile.size === 704_000, "pinned fixture file identities/sizes");
        const [modelBytes, audioBytes] = await bounded(Promise.all([fs.readFile(modelPath), fs.readFile(audioPath)]));
        const modelSha256 = crypto.createHash("sha256").update(modelBytes).digest("hex"), audioSha256 = crypto.createHash("sha256").update(audioBytes).digest("hex");
        requireCondition(modelBytes.length === 77_691_713 && modelSha256 === "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" &&
          audioBytes.length === 704_000 && audioSha256 === "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0", "pinned fixture byte hashes");
        const samples = new Float32Array(audioBytes.length / Float32Array.BYTES_PER_ELEMENT);
        new Uint8Array(samples.buffer).set(audioBytes); // Copy the exact public Float32 fixture bytes.
        inference = { recognized: false, modelSha256, audioSha256, sampleCount: samples.length };
        phase = "speech-transcribe-cpu-fixture";
        const transcriptionId = crypto.randomUUID();
        speechOwner.child.postMessage(protocol.speechRequestSchema.parse({ version: 1, id: transcriptionId, command: "transcribe",
          model: { path: modelPath, family: "whisper", gpu: false }, samples, language: "en", vocabulary: "" }));
        const transcription = protocol.speechReplySchema.parse(await next(speechOwner, 30_000));
        requireCondition(transcription.id === transcriptionId && transcription.ok && transcription.value.command === "transcribe", "speech transcription reply identity/result");
        inference.recognized = transcription.ok && transcription.value.command === "transcribe" && /ask not what your country can do for you/iu.test(transcription.value.text);
        requireCondition(inference.recognized, "pinned public phrase recognition");
        phase = "speech-shutdown"; await speechRequest("shutdown");
        requireCondition(speechOwner.child.kill(), "original speech termination request");
        const speechExit = await bounded(speechOwner.exit); requireCondition(speechExit === 0, "speech original exit");
        speech = { pid: speechPid, gpu: null, exitCode: speechExit };
        requireCondition(!mainInventory(), "capture/speech loaded in main after utility test");
      } catch (failure: unknown) { error = failure instanceof Error ? failure.message.slice(0, 1000) : "Unknown utility failure"; }
      const cleanupDeadline = Date.now() + 8000;
      const cleanup = await Promise.allSettled(owners.map(async (owner) => {
        if (!owner.exited && !owner.child.kill()) throw new Error("Original utility cleanup request refused");
        await bounded(owner.exit, cleanupDeadline);
        if (owner.failed) throw new Error("Original utility error/channel failure retained through exit");
      }));
      app.removeListener("child-process-gone", observeGone);
      const cleanupPassed = cleanup.every((item) => item.status === "fulfilled");
      let mainCaptureSpeechFree = false;
      try { mainCaptureSpeechFree = !mainInventory(); }
      catch (failure: unknown) { error ??= failure instanceof Error ? failure.message.slice(0, 1000) : "Main inventory unavailable after cleanup"; }
      return { status: error || !cleanupPassed || !mainCaptureSpeechFree ? "FAIL" : "PASS", phase, error, capture, speech, inference, cleanupPassed, mainCaptureSpeechFree,
        cleanupErrors: cleanup.filter((item) => item.status === "rejected").map((item) => item.reason instanceof Error ? item.reason.message : "Original exit not observed"),
        // Electron UtilityProcess exposes no separate signal value; do not infer one from its code.
        originalExitsObserved: owners.map((owner) => ({ pid: owner.pid, exited: owner.exited, exitCode: owner.exitCode ?? null,
          signal: "not-exposed-by-utility-api", gone: owner.gone ?? null })),
        scope: "Signed production capture configure + CPU Tiny/JFK inference; no Start, TCC, microphone audio or full retirement claim" };
    }, fixtures);
    assert.ok(typeof nativeUtilityLoading === "object" && nativeUtilityLoading !== null);
    assert.equal(Reflect.get(nativeUtilityLoading, "status"), "PASS", JSON.stringify(nativeUtilityLoading));
    checks.push("Signed production capture configure and pinned CPU Tiny/JFK inference in original utilities; original cleanup exits observed; no main capture/speech addon");
  }
  const accelerator = "Command+Shift+F8";
  assert.equal(await application.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), accelerator), false);
  stage = "shortcut-focus";
  await page.locator('[data-ui-language="en"]').click();
  await page.locator('[data-tab="general"]').click();
  await application.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === "app://openwhisper/index.html"); window?.show(); window?.focus(); });
  await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) =>
    item.webContents.getURL() === "app://openwhisper/index.html" && item.isFocused())), { timeout: 10_000 }).toBe(true);
  stage = "shortcut-capture-start";
  await page.locator('[data-portal="enable_shortcut"]').click();
  await expect.poll(async () => (await state()).macos?.recording_shortcut, { timeout: 10_000 }).toBe(true);
  stage = "shortcut-commit";
  const cdp = await page.context().newCDPSession(page);
  // Electron emits before-input-event for rawKeyDown/keyUp, not CDP's distinct keyDown type.
  // Dispatch only to this window's Chromium session, never the OS/global input queue.
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "F8", code: "F8", modifiers: 12,
    windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 100, autoRepeat: false });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "F8", code: "F8", modifiers: 12,
    windowsVirtualKeyCode: 119, nativeVirtualKeyCode: 100 });
  await cdp.detach();
  await expect.poll(async () => (await state()).preferences.macos_shortcut, { timeout: 10_000 }).toBe(accelerator);
  assert.equal(await application.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), accelerator), true);
  assert.equal((await state()).status, "idle");
  checks.push("Owned-window CDP Command+Shift+F8 input commits through normal setup; actual globalShortcut registration");
  stage = "shortcut-remove";
  await page.locator('[data-portal="clear_shortcut"]').click();
  await expect.poll(async () => (await state()).preferences.macos_shortcut, { timeout: 10_000 }).toBe(null);
  assert.equal(await application.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), accelerator), false);
  checks.push("Normal Remove trigger unregisters the actual shortcut");
  if (stable) {
    stage = "stable-preference-edit";
    await page.locator("#vocabulary").fill(vocabulary); await page.locator("#save-vocabulary").click();
    await expect.poll(async () => (await state()).preferences.vocabulary, { timeout: 10_000 }).toBe(vocabulary);
    await preserved();
  }
  stage = "original-quit";
  await application.close();
  const exit = await closed; application = undefined;
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  checks.push("Original packaged process exits cleanly through normal Quit and application cleanup");
  if (stable) {
    await preserved(); stage = "stable-normal-restart";
    application = await _electron.launch({ executablePath: executable, args: [], env: environment, chromiumSandbox: true, timeout: 30_000 });
    const restarted = application.process();
    const restartedClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) =>
      restarted.once("close", (code, signal) => accept({ code, signal })));
    page = await application.firstWindow();
    await expect(page.locator(".sidebar-brand strong")).toHaveText(capturedBuild.productName, { timeout: 15_000 });
    assert.equal(page.url(), "app://openwhisper/index.html");
    const retained = await state();
    assert.equal(retained.updates.configured, packageMetadata.updateConfigured);
    assert.equal(retained.macos?.updates_configured, packageMetadata.updateConfigured);
    if (packageMetadata.updateConfigured) assert.equal(retained.preferences.auto_check_updates, false);
    assert.equal(retained.profile, undefined); assert.equal(retained.status, "idle"); assert.deepEqual(retained.installed, ["tiny"]);
    assert.equal(retained.preferences.vocabulary, vocabulary); assert.deepEqual(retained.preferences.snippets, [ownedSnippet]);
    assert.equal(retained.preferences.macos_shortcut ?? null, null);
    await page.locator('[data-tab="general"]').click(); await expect(page.locator("#vocabulary")).toHaveValue(vocabulary);
    await preserved(); stage = "restarted-original-quit";
    await application.close(); restartExit = await restartedClosed; application = undefined;
    assert.equal(restartExit.code, 0); assert.equal(restartExit.signal, null); await preserved();
    checks.push("Owned vocabulary edit survives normal stable restart; raw originals and completion stay unchanged; second original Quit exits 0");
  }
  await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "PASS", architecture: process.arch, packageFormat, applicationBuild: capturedBuild, identity, checks,
    input: "CDP to owned window only; no OS global input injection", microphone: stable && packageFormat === "thin"
      ? "No permission request, capture Start, recording stream or inference in this stable smoke"
      : "No permission request, capture Start or microphone operation; pinned public inference fixture only",
    installation, nativeUtilityLoading, signatureAdmission, archiveAdmission, stableMigration, updateConfiguration, automaticUpdatePreferencePatch,
    tccAttribution: "Permission and real microphone behavior remain pending", exit, restartExit,
    scope: stable ? (packageFormat === "universal"
      ? "Actual universal stable normal main, native empty-domain migration/UI/preferences/shortcut/restart/clean Quit and host capture Configure/Close plus CPU Tiny/JFK utilities; no capture Start or microphone"
      : "Actual stable normal main/bundle/native empty-domain migration/UI/preferences/regular shortcut/restart/clean Quit; no stable recording or CPU claim")
      : "Actual Dev package plus signed capture configure and CPU fixture utilities" }, null, 2), { mode: 0o600 });
  passed = true;
} catch (error: unknown) {
  failure = error instanceof Error ? { name: error.name, message: error.message.slice(0, 2000) } : { name: "UNKNOWN" };
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(evidence, "result.json"), JSON.stringify({ status: "FAIL", stage, packageFormat, applicationBuild: capturedBuild, identity, checks, installation, nativeUtilityLoading, signatureAdmission, archiveAdmission, stableMigration, updateConfiguration, automaticUpdatePreferencePatch,
    error: failure }, null, 2), { mode: 0o600 });
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
}
console.log(JSON.stringify({ status: passed ? "PASS" : "FAIL", stage, evidence, architecture: process.arch, packageFormat, error: failure }));

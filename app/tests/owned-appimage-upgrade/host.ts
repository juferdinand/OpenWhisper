import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { updateInputSchema } from "./contract.js";

const input = updateInputSchema.parse(JSON.parse(await readFile("/payload/input.json", "utf8")) as unknown);
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const root = join(dirname(process.execPath), "resources/app"), distribution = join(root, "dist");
assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64"); assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.OPENWHISPER_OWNED_APPIMAGE_UPGRADE, "1"); assert.equal(process.versions.node, "24.21.0");
assert.ok((await lstat("/.dockerenv")).isFile());
for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri", "/dev/fuse"]) await assert.rejects(lstat(device), { code: "ENOENT" });
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const version = (await readFile(join(distribution, "resources/VERSION"), "utf8")).trim();
assert.equal(version, input.older.version); assert.equal(metadata.version, version);
assert.deepEqual(JSON.parse(await readFile(join(distribution, "resources/development-build.json"), "utf8")), input.older.source);
const require = createRequire(join(root, "package.json"));
const bootstrap = await import(pathToFileURL(join(distribution, "cli/linux-supervisor-bootstrap.js")).href) as typeof import("../../src/cli/linux-supervisor-bootstrap.js");
const { parseApplicationBuildModule } = require(join(distribution, "contracts/application/build-identity.js")) as typeof import("../../src/contracts/application/build-identity.js");
const { selectApplicationBuild } = require(join(distribution, "main/build-selection.js")) as typeof import("../../src/main/build-selection.js");
const { admitLinuxInstalledLaunch } = require(join(distribution, "main/linux-installed-launch.js")) as typeof import("../../src/main/linux-installed-launch.js");
const { admitSignedAppImageLaunch, prepareAppImageUpdate, repairSignedAppImageLaunch } = require(join(distribution, "services/update/linux/linux-appimage-update.js")) as typeof import("../../src/services/update/linux/linux-appimage-update.js");
const { readCurrentAppImageSignature } = require(join(distribution, "services/update/common/update-feed.js")) as typeof import("../../src/services/update/common/update-feed.js");
const { retainOwnedUpdateDownload } = require(join(distribution, "services/update/common/update-staging.js")) as typeof import("../../src/services/update/common/update-staging.js");
const { projectLinuxUpdateFeed, LINUX_UPDATE_FEED_URL } = require(join(distribution, "services/update/common/update-policy.js")) as typeof import("../../src/services/update/common/update-policy.js");
const build = parseApplicationBuildModule(await readFile(join(distribution, "main/application-build.js"), "utf8"));
const executable = await import("node:fs/promises").then(({ realpath }) => realpath(process.execPath));
const resourcesPath = join(dirname(executable), "resources"), appPath = join(resourcesPath, "app");
const identity = selectApplicationBuild({ build, argv: process.argv.slice(2), platform: process.platform, architecture: process.arch,
  packaged: true, executable, appPath, resourcesPath, distribution: join(appPath, "dist"), projectVersion: version, packageVersion: metadata.version });
const launch = await admitLinuxInstalledLaunch({ build: identity, packaged: true, executable, appPath, resourcesPath,
  home: homedir(), environment: process.env, pid: process.pid });
assert.ok(launch?.kind === "appimage");

const signatureBytes = await readFile(`/payload/newer/${input.newer.filename}.sig`);
assert.equal(signatureBytes.length, input.newer.signature.bytes); assert.equal(digest(signatureBytes), input.newer.signature.sha256);
const signature = signatureBytes.toString("utf8");
const selected = projectLinuxUpdateFeed({ sourceURL: LINUX_UPDATE_FEED_URL, package: "appimage", currentVersion: version,
  feed: { version: input.newer.version, platforms: { "linux-x86_64-appimage": { url:
    `${input.repository}/releases/download/v${input.newer.version}/${input.newer.filename}`, signature } } } });
assert.equal(selected.version, input.newer.version);
const updates = bootstrap.appImageUpdates(version, launch, {
  home: () => homedir(),
  admit: admitSignedAppImageLaunch,
  repair: repairSignedAppImageLaunch,
  signature: readCurrentAppImageSignature,
  async feed(options) { assert.equal(options.package, "appimage"); assert.equal(options.currentVersion, version); return selected; },
  async download(options) {
    assert.equal(options.candidate, selected); assert.notEqual(options.signal?.aborted, true);
    const stageDirectory = await mkdtemp(join(options.cacheDirectory, "update-download-"));
    const path = join(stageDirectory, input.newer.filename), file = await open(path, "wx+", 0o600), bytes = await readFile(`/payload/newer/${input.newer.filename}`);
    assert.equal(bytes.length, input.newer.image.bytes); assert.equal(digest(bytes), input.newer.image.sha256);
    let position = 0;
    while (position < bytes.length) { const result = await file.write(bytes, position, Math.min(64 * 1024, bytes.length - position), position);
      assert.ok(result.bytesWritten > 0); position += result.bytesWritten; }
    await file.sync();
    const retained = await retainOwnedUpdateDownload({ file, stageDirectory, artifactName: input.newer.filename });
    return Object.freeze({ ...retained, async cleanup() {
      await retained.cleanup();
      const descriptorClosed = file.fd === -1;
      assert.equal(descriptorClosed, true);
      await assert.rejects(lstat(stageDirectory), { code: "ENOENT" });
      await writeFile("/evidence/source-closed.json", JSON.stringify({ descriptorClosed, stageAbsent: true, stageDirectory }),
        { flag: "wx", mode: 0o600 });
    } });
  },
  prepare: prepareAppImageUpdate,
});
const installPrepared = updates.installPrepared.bind(updates);
const observed = Object.freeze({ ...updates, async installPrepared(nextVersion: string) {
  const installed = await installPrepared(nextVersion);
  return Object.freeze({
    assertForExec() {
      installed.assertForExec();
      const closure = z.object({ descriptorClosed: z.literal(true), stageAbsent: z.literal(true), stageDirectory: z.string() })
        .strict().parse(JSON.parse(readFileSync("/evidence/source-closed.json", "utf8")) as unknown);
      assert.equal(existsSync(closure.stageDirectory), false);
      const original = z.object({ supervisor: z.number().int().positive(), gui: z.number().int().positive(),
        native: z.array(z.number().int().positive()).max(128) }).strict()
        .parse(JSON.parse(readFileSync("/evidence/original-owners.json", "utf8")) as unknown);
      assert.equal(original.supervisor, process.pid);
      const oldGuiClosed = !existsSync(`/proc/${original.gui}`), oldNativeOwnersClosed = original.native.every((pid) => !existsSync(`/proc/${pid}`));
      assert.equal(oldGuiClosed, true); assert.equal(oldNativeOwnersClosed, true);
      writeFileSync("/evidence/final-exec-guard.json", JSON.stringify({ pid: process.pid, version: nextVersion, passed: true,
        sourceFdClosed: closure.descriptorClosed, sourceStageAbsent: closure.stageAbsent, oldGuiClosed, oldNativeOwnersClosed }),
        { flag: "wx", mode: 0o600 });
    },
    ...(installed.rollbackBeforeExec ? { rollbackBeforeExec: installed.rollbackBeforeExec } : {}),
  });
} });
process.exitCode = await bootstrap.bootstrapLinuxSupervisor(process.argv.slice(2), async () => ({ version, launch, updates: observed }));

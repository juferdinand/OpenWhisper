import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { installRequestSchema, installResponseSchema, upgradeInputSchema } from "./contract.js";

const root = "/opt/openwhisper/resources/app", evidence = "/evidence", artifactName = "OpenWhisper-Linux-amd64.deb";
const input = upgradeInputSchema.parse(JSON.parse(await readFile("/payload/input.json", "utf8")) as unknown);
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function absent(pid: number): Promise<void> { await assert.rejects(lstat(`/proc/${pid}`), { code: "ENOENT" }); }
async function save(name: string, value: unknown): Promise<void> {
  await writeFile(join(evidence, `${name}.partial`), JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(join(evidence, `${name}.partial`), join(evidence, name));
}
async function installer(): Promise<void> {
  assert.equal(process.getuid?.(), 0);
  const requestDeadline = performance.now() + 90_000;
  for (;;) {
    try { await lstat(join(evidence, "install-request.json")); break; }
    catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
    assert.ok(!existsSync(join(evidence, "driver-cleanup.json")) && performance.now() < requestDeadline); await delay(100);
  }
  const request = installRequestSchema.parse(JSON.parse(await readFile(join(evidence, "install-request.json"), "utf8")) as unknown);
  assert.deepEqual(request.archive, input.newer.archive);
  await absent(request.originalGui); for (const pid of request.originalNative) await absent(pid);
  const stat = await lstat(request.path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.uid, 1000); assert.equal(stat.mode & 0o7777, 0o600); assert.equal(stat.nlink, 1);
  const bytes = await readFile(request.path); assert.equal(bytes.length, input.newer.archive.bytes);
  assert.equal(digest(bytes), input.newer.archive.sha256);
  const child = spawn("/usr/bin/dpkg", ["--install", request.path], { shell: false,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, stdio: ["ignore", "ignore", "ignore"] });
  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal }));
  });
  assert.equal(closed.code, 0); assert.equal(closed.signal, null); assert.ok(child.pid); await absent(child.pid);
  assert.equal(digest(await readFile(request.path)), input.newer.archive.sha256);
  const response = installResponseSchema.parse({ ...closed, pid: child.pid, originalClosed: true, originalAbsent: true,
    originalGuiAbsent: true, originalNativeAbsent: true });
  // The unprivileged owner must read the root helper's result, without receiving write access to it.
  await writeFile(join(evidence, "install-response.json.partial"), JSON.stringify(response), { flag: "wx", mode: 0o644 });
  await rename(join(evidence, "install-response.json.partial"), join(evidence, "install-response.json"));
}

if (process.argv[2] === "--installer") await installer();
else {
  let phase = "bootstrap";
  try {
  assert.equal(process.getuid?.(), 1000); assert.equal(process.execPath, "/opt/openwhisper/openwhisper");
  assert.equal(process.env.OPENWHISPER_OWNED_DEBIAN_UPGRADE, "1");
  const require = createRequire(join(root, "package.json"));
  const bootstrap = await import(pathToFileURL(join(root, "dist/cli/linux-supervisor-bootstrap.js")).href) as typeof import("../../src/cli/linux-supervisor-bootstrap.js");
  const { runLinuxSupervisor } = require(join(root, "dist/cli/linux-supervisor.js")) as typeof import("../../src/cli/linux-supervisor.js");
  const { retainOwnedUpdateDownload } = require(join(root, "dist/services/update-staging.js")) as typeof import("../../src/services/update-staging.js");
  const { prepareDebianUpdate } = require(join(root, "dist/services/linux-debian-update.js")) as typeof import("../../src/services/linux-debian-update.js");
  const { assertCanonicalInstalledDebianVersion } = require(join(root, "dist/services/linux-debian-installed.js")) as typeof import("../../src/services/linux-debian-installed.js");
  const policy = require(join(root, "dist/services/update-policy.js")) as typeof import("../../src/services/update-policy.js");
  assert.ok(policy.isNewerUpdateVersion(input.newer.sourceVersion, input.older.sourceVersion));
  await assertCanonicalInstalledDebianVersion(input.older.sourceVersion);
  assert.deepEqual(JSON.parse(await readFile(join(root, "dist/resources/development-build.json"), "utf8")), input.older.source);
  const signature = await readFile(`/payload/newer/${artifactName}.sig`, "utf8"); assert.ok(Buffer.byteLength(signature) <= 16 * 1024);
  const selected = policy.projectLinuxUpdateFeed({ feed: { version: input.newer.sourceVersion, platforms: {
    "linux-x86_64-deb": { url: `${policy.LINUX_UPDATE_REPOSITORY}/releases/download/v${input.newer.sourceVersion}/${artifactName}`, signature },
  } }, sourceURL: policy.LINUX_UPDATE_FEED_URL, package: "deb", currentVersion: input.older.sourceVersion });
  assert.ok(selected);
  const updates = bootstrap.debianUpdates(input.older.sourceVersion, {
    home: () => process.env.HOME!,
    async feed() { return selected; },
    async download(options) {
      phase = "offline-download";
      assert.equal(options.candidate, selected); assert.notEqual(options.signal?.aborted, true);
      const stageDirectory = await mkdtemp(join(options.cacheDirectory, "update-download-"));
      const file = await open(join(stageDirectory, artifactName), "wx+", 0o600);
      const bytes = await readFile(`/payload/newer/${artifactName}`);
      assert.equal(bytes.length, input.newer.archive.bytes); assert.equal(digest(bytes), input.newer.archive.sha256);
      let position = 0;
      while (position < bytes.length) {
        const result = await file.write(bytes, position, Math.min(64 * 1024, bytes.length - position), position);
        assert.ok(result.bytesWritten > 0); position += result.bytesWritten;
      }
      await file.sync();
      const retained = await retainOwnedUpdateDownload({ file, stageDirectory, artifactName });
      return Object.freeze({ ...retained, async cleanup() {
        phase = "source-cleanup";
        await retained.cleanup(); assert.equal(file.fd, -1);
        await assert.rejects(lstat(stageDirectory), { code: "ENOENT" });
        await save("source-closed.json", { originalDescriptorClosed: true, originalStageAbsent: true });
      } });
    },
    async prepare(options) {
      phase = "signed-package-prepare";
      return prepareDebianUpdate(options, { async install(path) {
        phase = "original-kernel-retirement";
        const original = JSON.parse(await readFile(join(evidence, "original-owners.json"), "utf8")) as { gui: number; native: number[] };
        const initialLive: number[] = [];
        for (const pid of [original.gui, ...original.native]) {
          try { await lstat(`/proc/${pid}`); initialLive.push(pid); }
          catch (error: unknown) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
        }
        await save("kernel-retirement-observation.json", { initiallyPresent: initialLive });
        const retirementDeadline = performance.now() + 3000;
        for (const pid of [original.gui, ...original.native]) {
          while (performance.now() < retirementDeadline) {
            try { await absent(pid); break; } catch { await delay(20); }
          }
          await absent(pid);
        }
        phase = "installer-request-schema";
        await save("install-request.json", installRequestSchema.parse({ path, archive: input.newer.archive,
          originalGui: original.gui, originalNative: original.native }));
        const end = performance.now() + 60_000;
        while (performance.now() < end) {
          try { installResponseSchema.parse(JSON.parse(await readFile(join(evidence, "install-response.json"), "utf8"))); phase = "installed-audit"; return 0; }
          catch (error: unknown) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
          }
          await delay(100);
        }
        throw new Error("Owned original installer did not close within the test budget.");
      } });
    },
  });
  const originalInstall = updates.installPrepared;
  const observed = { ...updates, async installPrepared(version: string) {
    const installed = await originalInstall(version);
    return Object.freeze({ assertForExec() {
      phase = "final-exec-guard";
      installed.assertForExec();
      // This synchronous observation occurs after the actual source close and immediately before native exec.
      const fs = process.getBuiltinModule("fs")!;
      assert.ok(fs.existsSync(join(evidence, "source-closed.json")));
      fs.writeFileSync(join(evidence, "final-exec-guard.json"), JSON.stringify({ pid: process.pid, version, passed: true }), { flag: "wx", mode: 0o600 });
    } });
  } };
  process.exitCode = await runLinuxSupervisor({ launch: { kind: "debian", executable: process.execPath, arguments: [] },
    currentVersion: input.older.sourceVersion, argv: process.argv.slice(2), updates: observed,
    async revalidateReplacement() { assert.fail("V2 must use the installed audit continuation."); } });
  } catch (error: unknown) {
    await save("host-failure.json", { phase, name: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Unknown",
      code: error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code) ? error.code : null });
    throw new Error("Owned Debian update host failed; inspect categorical evidence.");
  }
}

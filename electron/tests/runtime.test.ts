import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installedElectronExecutable, pinnedRuntimeEnvironment } from "../scripts/runtime.js";

test("runtime environment removes every executable/mirror/checksum alias and node preloads", () => {
  const original = {
    PATH: "/owned/tools", ELECTRON_OVERRIDE_DIST_PATH: "/wrong/runtime",
    ELECTRON_RUN_AS_NODE: "1", npm_config_electron_customversion: "wrong",
    NPM_CONFIG_ELECTRON_MIRROR: "https://wrong.invalid", npm_package_config_electron_customDir: "wrong",
    electron_use_remote_checksums: "1", NODE_OPTIONS: "--require wrong", NODE_PATH: "/wrong/modules",
  };
  assert.deepEqual(pinnedRuntimeEnvironment(original), { PATH: "/owned/tools" });
  assert.equal(original.ELECTRON_RUN_AS_NODE, "1");
});

test("runtime lookup refuses absent or mismatched installation without executing its module", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-runtime-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { electron: "44.7.0" } }));
    const packageRoot = join(root, "node_modules/electron");
    const distribution = join(packageRoot, "dist");
    await mkdir(distribution, { recursive: true });
    await writeFile(join(packageRoot, "index.js"), "throw new Error('Must never execute');");
    await assert.rejects(installedElectronExecutable(root), /setup first/);
    const platformPath = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
    const executable = join(distribution, platformPath);
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, "Owned inert executable");
    await chmod(executable, 0o700);
    await writeFile(join(packageRoot, "path.txt"), platformPath);
    await writeFile(join(distribution, "version"), "44.7.0");
    assert.equal(await installedElectronExecutable(root), executable);
    assert.equal(await readFile(executable, "utf8"), "Owned inert executable");
    await writeFile(join(distribution, "version"), "44.6.0");
    await assert.rejects(installedElectronExecutable(root), /setup first/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageLinuxPreview } from "../scripts/package-linux-preview.js";

const supportedHost = process.platform === "linux" && process.arch === "x64";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "openwhisper-package-preview-")), root = join(base, "source/electron");
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text);
  };
  const metadata = JSON.stringify({ name: "openwhisper-electron", version: "0.3.0", private: true, type: "module",
    main: "dist/main/index.js", dependencies: { fixture: "1.0.0" }, devDependencies: { electron: "44.7.0" } });
  await write("package.json", metadata);
  await write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {
    "node_modules/fixture": { version: "1.0.0" }, "node_modules/@fixture/linux-x64": { version: "1.0.0" },
  } }));
  await write("node_modules/fixture/package.json", JSON.stringify({ name: "fixture", version: "1.0.0",
    optionalDependencies: { "@fixture/linux-x64": "1.0.0", "@fixture/darwin-arm64": "1.0.0" } }));
  await write("node_modules/fixture/LICENSE", "Fixture dependency license");
  await write("node_modules/@fixture/linux-x64/package.json", JSON.stringify({ name: "@fixture/linux-x64", version: "1.0.0" }));
  await write("node_modules/@fixture/linux-x64/inert.node", "Inert fixture addon; never executed");
  await write("node_modules/electron/path.txt", "electron");
  await write("node_modules/electron/dist/version", "44.7.0");
  await write("node_modules/electron/dist/electron", "Inert runtime; never executed");
  await chmod(join(root, "node_modules/electron/dist/electron"), 0o755);
  await write("node_modules/electron/dist/LICENSE", "Fixture runtime license");
  await write("node_modules/electron/dist/LICENSES.chromium.html", "Fixture Chromium notices");
  await write("node_modules/electron/dist/resources/default_app.asar", "Fixture default application");
  await write("dist/main/index.js", "Inert application; never executed");
  await write("dist/main/development-recording-build.js", "export const DEVELOPMENT_RECORDING_BUILD = null;\n");
  const build = '{"commit":"0123456789abcdef0123456789abcdef01234567","modified":true}\n';
  await write("dist/resources/development-build.json", build);
  await write("dist/resources/VERSION", "0.3.0\n");
  await write("dist/ui/app-icon.png", "Fixture existing icon");
  await write("dist/ui/fonts/LICENSE.txt", "Fixture font license");
  await write("../LICENSE", "Fixture OpenWhisper license");
  for (const name of ["LICENSE-MIT", "LICENSE-APACHE-2.0", "LICENSE.spdx"]) {
    await write(`../shared/ui/node_modules/@tauri-apps/api/${name}`, `Fixture renderer dependency ${name}`);
  }
  return { base, root, metadata, build, output: join(base, "preview") };
}

test("preview stages the runtime, exact app metadata, installed optional dependency and separate Dev Debian layout", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    const result = await packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true });
    assert.equal(result.version, "0.3.0~dev.0123456789ab.modified");
    assert.equal(result.debianPackage, null);
    const app = join(result.directory, "resources/app");
    assert.equal(await readFile(join(app, "package.json"), "utf8"), input.metadata);
    assert.equal(await readFile(join(app, "dist/resources/development-build.json"), "utf8"), input.build);
    assert.equal(await readFile(join(app, "node_modules/@fixture/linux-x64/inert.node"), "utf8"), "Inert fixture addon; never executed");
    assert.equal((await lstat(join(result.directory, "openwhisper-dev"))).mode & 0o777, 0o755);
    assert.equal((await lstat(join(input.root, "node_modules/electron/dist/electron"))).mode & 0o777, 0o755);
    assert.equal(await readFile(join(input.root, "package.json"), "utf8"), input.metadata);
    const desktop = await readFile(join(result.debianRoot, "usr/share/applications/io.github.whisperfree.dev.desktop"), "utf8");
    assert.match(desktop, /^Exec=\/opt\/openwhisper-dev\/openwhisper-dev --dev$/mu);
    assert.match(desktop, /^Name=OpenWhisper Dev$/mu);
    const control = await readFile(join(result.debianRoot, "DEBIAN/control"), "utf8");
    assert.match(control, /^Package: io-github-whisperfree-dev$/mu);
    assert.match(control, /^Version: 0\.3\.0~dev\./mu);
    assert.equal(await readFile(join(result.directory, "LICENSES.chromium.html"), "utf8"), "Fixture Chromium notices");
    assert.equal(await readFile(join(result.directory, "notices/tauri-api-LICENSE-MIT"), "utf8"), "Fixture renderer dependency LICENSE-MIT");
    await assert.rejects(lstat(join(app, "node_modules/electron")), { code: "ENOENT" });
    await assert.rejects(lstat(join(result.debianRoot, "usr/share/applications/io.github.whisperfree.desktop")), { code: "ENOENT" });
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /fresh directory/);
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("preview refuses source overlap, wrong locked dependency, unsafe symlinks and version mismatch before staging", { skip: !supportedHost }, async () => {
  const input = await fixture();
  try {
    await assert.rejects(packageLinuxPreview({ root: input.root, output: join(input.root, "output"), directoryOnly: true }), /fresh directory/);
    await writeFile(join(input.root, "node_modules/fixture/package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /lockfile/);
    await writeFile(join(input.root, "node_modules/fixture/package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    await symlink(join(input.root, "package.json"), join(input.root, "dist/unsafe"));
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /without symlinks/);
    await rm(join(input.root, "dist/unsafe"));
    await writeFile(join(input.root, "dist/resources/VERSION"), "0.2.5\n");
    await assert.rejects(packageLinuxPreview({ root: input.root, output: input.output, directoryOnly: true }), /versions differ/);
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

const hasDpkg = supportedHost && spawnSync("dpkg-deb", ["--version"], { shell: false, stdio: "ignore" }).status === 0;
test("preview builds and inspects an owned inert Debian archive without installation or app execution", { skip: !hasDpkg }, async () => {
  const input = await fixture();
  try {
    const result = await packageLinuxPreview({ root: input.root, output: input.output });
    assert.ok(result.debianPackage);
    const fields = spawnSync("dpkg-deb", ["--field", result.debianPackage, "Package"], { encoding: "utf8", shell: false });
    assert.equal(fields.status, 0); assert.equal(fields.stdout.trim(), "io-github-whisperfree-dev");
    const extracted = join(input.base, "extracted");
    assert.equal(spawnSync("dpkg-deb", ["--extract", result.debianPackage, extracted], { shell: false }).status, 0);
    assert.equal(await readFile(join(extracted, "opt/openwhisper-dev/resources/app/package.json"), "utf8"), input.metadata);
    assert.equal(await readFile(join(extracted, "opt/openwhisper-dev/resources/app/dist/resources/development-build.json"), "utf8"), input.build);
    await assert.rejects(lstat(join(extracted, "opt/openwhisper")), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

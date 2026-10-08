import assert from "node:assert/strict";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { buildIdentitySchema, parseApplicationBuildModule } from "../src/contracts/build-identity.js";
import { APPLICATION_BUILD } from "../src/main/application-build.js";
import { selectApplicationBuild, validateMacBundleMetadata, type ApplicationBuildSelectionOptions } from "../src/main/build-selection.js";

const dev = { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" };
const stable = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" };
const packaged = (build: unknown = stable): ApplicationBuildSelectionOptions => ({ build, argv: ["/owned/package/openwhisper"],
  platform: "linux", architecture: "x64", packaged: true, executable: "/owned/package/openwhisper",
  resourcesPath: "/owned/package/resources", appPath: "/owned/package/resources/app",
  distribution: "/owned/package/resources/app/dist", projectVersion: "0.3.0", packageVersion: "0.3.0" });
const macPackaged = (architecture = "arm64", build = stable): ApplicationBuildSelectionOptions => {
  const contents = `/owned/${build.productName}.app/Contents`, executable = `${contents}/MacOS/${build.productName}`;
  return { ...packaged(build), platform: "darwin", architecture, argv: [executable], executable,
    resourcesPath: `${contents}/Resources`, appPath: `${contents}/Resources/app`, distribution: `${contents}/Resources/app/dist` };
};

test("build identity has exactly the paired stable or Dev literals and defaults source startup to Dev", () => {
  assert.deepEqual(buildIdentitySchema.parse(APPLICATION_BUILD), dev);
  assert.deepEqual(selectApplicationBuild(packaged()), stable);
  assert.throws(() => buildIdentitySchema.parse({ ...stable, appId: dev.appId }));
  assert.throws(() => buildIdentitySchema.parse({ ...dev, productName: stable.productName }));
  assert.throws(() => buildIdentitySchema.parse({ ...stable, release: true }));
});

test("captured build inspection accepts both fixed emitted exports without executing arbitrary input", () => {
  assert.deepEqual(parseApplicationBuildModule(`export const APPLICATION_BUILD = ${JSON.stringify(stable)};\n`), stable);
  assert.deepEqual(parseApplicationBuildModule(`const APPLICATION_BUILD = ${JSON.stringify(dev)};\nexport { APPLICATION_BUILD };\n`), dev);
  const emitted = transformSync(`export const APPLICATION_BUILD: unknown = ${JSON.stringify(stable)};`,
    { loader: "ts", platform: "node", format: "esm", target: "node24" }).code;
  assert.deepEqual(parseApplicationBuildModule(emitted), stable);
  for (const source of [`const APPLICATION_BUILD = ${JSON.stringify(stable)};`,
    `export const APPLICATION_BUILD = ${JSON.stringify(stable)}; export { APPLICATION_BUILD };`,
    `export const APPLICATION_BUILD = (() => (${JSON.stringify(stable)}))();`,
    `export const APPLICATION_BUILD = ${JSON.stringify(stable)}; throw new Error('Must never run');`]) {
    assert.throws(() => parseApplicationBuildModule(source));
  }
});

test("stable runtime selection refuses variant flags, raw runtimes, unsupported hosts and mismatched versions or package paths", () => {
  for (const flag of ["--dev", "--dev=true", "--dev-profile", "--dev-profile=/owned/fixture", "--control", "--control=status"]) {
    assert.throws(() => selectApplicationBuild({ ...packaged(), argv: ["/owned/package/openwhisper", flag] }));
  }
  for (const changed of [{ packaged: false }, { platform: "darwin" }, { platform: "win32" }, { architecture: "ia32" },
    { packageVersion: "0.2.5" }, { projectVersion: "03.0.0", packageVersion: "03.0.0" },
    { executable: "/owned/package/openwhisper-dev" }, { resourcesPath: "/other/resources" }, { appPath: "/other/app" },
    { distribution: "/other/dist" }, { appPath: "/owned/package/resources/../app" }]) {
    assert.throws(() => selectApplicationBuild({ ...packaged(), ...changed }));
  }
  assert.deepEqual(selectApplicationBuild({ ...packaged(), argv: ["/owned/package/openwhisper", "--stable"] }), stable);
});

test("stable Mac selection admits each thin architecture only in its canonical fixed bundle and rejects Dev or control flags", () => {
  for (const architecture of ["arm64", "x64"]) {
    const mac = macPackaged(architecture);
    assert.deepEqual(selectApplicationBuild(mac), stable);
    for (const flag of ["--dev", "--dev=true", "--dev-profile=/owned/private", "--control=status"]) {
      assert.throws(() => selectApplicationBuild({ ...mac, argv: [mac.executable, flag] }));
    }
    assert.throws(() => selectApplicationBuild({ ...mac, packaged: false, executable: "/owned/Electron.app/Contents/MacOS/Electron" }));
    assert.throws(() => selectApplicationBuild({ ...mac, executable: mac.executable.replace(/OpenWhisper$/u, "Electron") }));
    for (const [from, to] of [["OpenWhisper.app", "OpenWhisper Dev.app"], ["Contents", "Alternate"], ["MacOS", "Other"]]) {
      const changed = { ...mac, executable: mac.executable.replace(from!, to!), resourcesPath: mac.resourcesPath.replace(from!, to!),
        appPath: mac.appPath.replace(from!, to!), distribution: mac.distribution.replace(from!, to!) };
      assert.throws(() => selectApplicationBuild(changed));
    }
  }
});

test("Mac bundle metadata must match the captured identity and both exact project version fields", () => {
  for (const build of [stable, dev]) {
    const metadata = { CFBundleIdentifier: build.appId, CFBundleExecutable: build.productName,
      CFBundleName: build.productName, CFBundleDisplayName: build.productName, CFBundleVersion: "0.3.0", CFBundleShortVersionString: "0.3.0" };
    validateMacBundleMetadata(build, "0.3.0", { ...metadata, CFBundleIconFile: "AppIcon" });
    for (const key of Object.keys(metadata)) {
      assert.throws(() => validateMacBundleMetadata(build, "0.3.0", { ...metadata, [key]: "different" }));
      const missing = { ...metadata }; Reflect.deleteProperty(missing, key);
      assert.throws(() => validateMacBundleMetadata(build, "0.3.0", missing));
    }
    assert.throws(() => validateMacBundleMetadata(build, "03.0.0", { ...metadata, CFBundleVersion: "03.0.0", CFBundleShortVersionString: "03.0.0" }));
    assert.throws(() => validateMacBundleMetadata(build, "0.3.0", Object.create(metadata) as unknown));
  }
});

test("Dev source and both packaged hosts keep Dev identity and cannot select stable storage", () => {
  const source = { ...packaged(dev), packaged: false, executable: "/owned/source/node_modules/electron/dist/electron",
    resourcesPath: "/owned/source/node_modules/electron/dist/resources", appPath: "/owned/source", distribution: "/owned/source/dist" };
  assert.deepEqual(selectApplicationBuild(source), dev);
  const linux = { ...packaged(dev), executable: "/owned/package/openwhisper-dev" };
  assert.deepEqual(selectApplicationBuild(linux), dev);
  const mac = macPackaged("arm64", dev);
  assert.deepEqual(selectApplicationBuild(mac), dev);
  for (const value of [source, linux, mac]) for (const flag of ["--stable", "--stable=true", "--production", "--production=true"]) {
    assert.throws(() => selectApplicationBuild({ ...value, argv: [value.executable, flag] }));
  }
  assert.throws(() => selectApplicationBuild({ ...source, executable: "/owned/package/openwhisper" }));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { buildIdentitySchema, parseApplicationBuildModule } from "../src/contracts/build-identity.js";
import { APPLICATION_BUILD } from "../src/main/application-build.js";
import { selectApplicationBuild, type ApplicationBuildSelectionOptions } from "../src/main/build-selection.js";

const dev = { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" };
const stable = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" };
const packaged = (build: unknown = stable): ApplicationBuildSelectionOptions => ({ build, argv: ["/owned/package/openwhisper"],
  platform: "linux", architecture: "x64", packaged: true, executable: "/owned/package/openwhisper",
  resourcesPath: "/owned/package/resources", appPath: "/owned/package/resources/app",
  distribution: "/owned/package/resources/app/dist", projectVersion: "0.3.0", packageVersion: "0.3.0" });

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

test("Dev source and both packaged hosts keep Dev identity and cannot select stable storage", () => {
  const source = { ...packaged(dev), packaged: false, executable: "/owned/source/node_modules/electron/dist/electron",
    resourcesPath: "/owned/source/node_modules/electron/dist/resources", appPath: "/owned/source", distribution: "/owned/source/dist" };
  assert.deepEqual(selectApplicationBuild(source), dev);
  const linux = { ...packaged(dev), executable: "/owned/package/openwhisper-dev" };
  assert.deepEqual(selectApplicationBuild(linux), dev);
  const mac = { ...packaged(dev), platform: "darwin", architecture: "arm64", executable: "/owned/OpenWhisper Dev.app/Contents/MacOS/OpenWhisper Dev",
    resourcesPath: "/owned/OpenWhisper Dev.app/Contents/Resources", appPath: "/owned/OpenWhisper Dev.app/Contents/Resources/app",
    distribution: "/owned/OpenWhisper Dev.app/Contents/Resources/app/dist" };
  assert.deepEqual(selectApplicationBuild(mac), dev);
  for (const value of [source, linux, mac]) for (const flag of ["--stable", "--stable=true", "--production", "--production=true"]) {
    assert.throws(() => selectApplicationBuild({ ...value, argv: [value.executable, flag] }));
  }
  assert.throws(() => selectApplicationBuild({ ...source, executable: "/owned/package/openwhisper" }));
});

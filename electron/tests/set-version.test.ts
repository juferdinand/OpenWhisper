import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  synchronizeVersion,
  VERSION_MANIFEST_SETS,
} from "../scripts/set-version.js";

const fixtureFiles: Readonly<Record<string, unknown | string>> = {
  VERSION: "0.3.0\n",
  "electron/package.json": {
    name: "openwhisper-electron",
    version: "0.3.0",
    private: true,
  },
  "electron/package-lock.json": {
    name: "openwhisper-electron",
    version: "0.3.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "openwhisper-electron",
        version: "0.3.0",
        dependencies: { tar: "7.5.22" },
      },
      "node_modules/tar": { version: "7.5.22" },
    },
  },
  "shared/ui/package.json": { name: "openwhisper-ui", version: "0.3.0" },
  "shared/ui/package-lock.json": {
    name: "openwhisper-ui",
    version: "0.3.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "openwhisper-ui", version: "0.3.0" },
      "node_modules/vite": { version: "8.3.3" },
    },
  },
  "linux/package.json": { name: "openwhisper-linux", version: "0.3.0" },
  "linux/package-lock.json": {
    name: "openwhisper-linux",
    version: "0.3.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "openwhisper-linux",
        version: "0.3.0",
        dependencies: { cli: "2.12.1" },
      },
    },
  },
  "linux/src-tauri/tauri.conf.json": {
    productName: "OpenWhisper",
    version: "0.3.0",
    plugins: { updater: { version: "2.13.1" } },
  },
  "linux/Cargo.toml":
    '[workspace]\nmembers = ["crates/core"]\n\n[workspace.package]\nversion = "0.3.0"\nedition = "2021"\n\n[profile.release]\ncodegen-units = 1\n',
  "linux/Cargo.lock": [
    "version = 4",
    "",
    "[[package]]",
    'name = "outside-dependency"',
    'version = "9.8.7"',
    "",
    "[[package]]",
    'name = "openwhisper-core"',
    'version = "0.3.0"',
    'dependencies = ["serde 1.0.0"]',
    "",
    "[[package]]",
    'name = "openwhisper-speech"',
    'version = "0.3.0"',
    'dependencies = ["cc 1.0.0"]',
    "",
    "[[package]]",
    'name = "openwhisper-desktop"',
    'version = "0.3.0"',
    'dependencies = ["tauri 2.0.0"]',
    "",
  ].join("\n"),
};

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-version-sync-"));
  for (const [relativePath, value] of Object.entries(fixtureFiles)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    const contents =
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path, contents);
  }
  return root;
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  for (const path of [
    ...VERSION_MANIFEST_SETS.active,
    ...VERSION_MANIFEST_SETS.legacy,
  ]) {
    values.set(path, await readFile(join(root, path), "utf8"));
  }
  return values;
}

async function removeFixtureRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

test("synchronizes active and legacy manifests while preserving dependency versions", async () => {
  const root = await createFixtureRoot();
  try {
    const paths = await synchronizeVersion(root, "1.2.3");
    assert.equal(paths.length, 10);
    assert.equal(await readFile(join(root, "VERSION"), "utf8"), "1.2.3\n");

    for (const relativePath of [
      "electron/package.json",
      "electron/package-lock.json",
      "shared/ui/package.json",
      "shared/ui/package-lock.json",
      "linux/package.json",
      "linux/package-lock.json",
      "linux/src-tauri/tauri.conf.json",
    ]) {
      const parsed: unknown = JSON.parse(
        await readFile(join(root, relativePath), "utf8"),
      );
      assert.equal(
        (parsed as { version: string }).version,
        "1.2.3",
        relativePath,
      );
      if (relativePath.endsWith("package-lock.json")) {
        assert.equal(
          (parsed as { packages: { "": { version: string } } }).packages[""]
            .version,
          "1.2.3",
        );
      }
    }

    const electronLock = JSON.parse(
      await readFile(join(root, "electron/package-lock.json"), "utf8"),
    ) as { packages: { "node_modules/tar": { version: string } } };
    const uiLock = JSON.parse(
      await readFile(join(root, "shared/ui/package-lock.json"), "utf8"),
    ) as { packages: { "node_modules/vite": { version: string } } };
    assert.equal(electronLock.packages["node_modules/tar"].version, "7.5.22");
    assert.equal(uiLock.packages["node_modules/vite"].version, "8.3.3");

    const tauri = JSON.parse(
      await readFile(join(root, "linux/src-tauri/tauri.conf.json"), "utf8"),
    ) as {
      plugins: { updater: { version: string } };
    };
    assert.equal(tauri.plugins.updater.version, "2.13.1");

    const cargo = await readFile(join(root, "linux/Cargo.toml"), "utf8");
    assert.match(cargo, /\[workspace\.package\]\nversion = "1\.2\.3"/);
    assert.match(cargo, /codegen-units = 1/);

    const cargoLock = await readFile(join(root, "linux/Cargo.lock"), "utf8");
    for (const name of [
      "openwhisper-core",
      "openwhisper-speech",
      "openwhisper-desktop",
    ]) {
      assert.match(
        cargoLock,
        new RegExp(`name = "${name}"\\nversion = "1\\.2\\.3"`),
      );
    }
    assert.match(cargoLock, /name = "outside-dependency"\nversion = "9\.8\.7"/);
    assert.match(cargoLock, /dependencies = \["serde 1\.0\.0"\]/);
    assert.match(cargoLock, /dependencies = \["tauri 2\.0\.0"\]/);
  } finally {
    await removeFixtureRoot(root);
  }
});

test("rejects invalid versions without writing any manifest", async () => {
  const root = await createFixtureRoot();
  try {
    const before = await snapshot(root);
    await assert.rejects(
      synchronizeVersion(root, "01.2.3"),
      /Version must use X\.Y\.Z/,
    );
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await removeFixtureRoot(root);
  }
});

test("rejects a malformed manifest before writing any earlier manifest", async () => {
  const root = await createFixtureRoot();
  try {
    await writeFile(join(root, "linux/package-lock.json"), "{ broken json\n");
    const before = await snapshot(root);
    await assert.rejects(
      synchronizeVersion(root, "1.2.3"),
      /linux\/package-lock\.json: invalid JSON/,
    );
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await removeFixtureRoot(root);
  }
});

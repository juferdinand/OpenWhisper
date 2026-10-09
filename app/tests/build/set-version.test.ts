import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  synchronizeVersion,
  VERSION_MANIFEST_SETS,
} from "../../scripts/set-version.js";

const fixtureFiles: Readonly<Record<string, unknown | string>> = {
  VERSION: "0.3.0\n",
  "app/package.json": {
    name: "openwhisper-electron",
    version: "0.3.0",
    private: true,
  },
  "app/package-lock.json": {
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
  "app/ui/package.json": { name: "openwhisper-ui", version: "0.3.0" },
  "app/ui/package-lock.json": {
    name: "openwhisper-ui",
    version: "0.3.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "openwhisper-ui", version: "0.3.0" },
      "node_modules/vite": { version: "8.3.3" },
    },
  },
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
  for (const path of VERSION_MANIFEST_SETS.active) {
    values.set(path, await readFile(join(root, path), "utf8"));
  }
  return values;
}

async function removeFixtureRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

test("synchronizes active app manifests while preserving dependency versions", async () => {
  const root = await createFixtureRoot();
  try {
    const paths = await synchronizeVersion(root, "1.2.3");
    assert.deepEqual(paths, [
      join(root, "VERSION"),
      join(root, "app/package.json"),
      join(root, "app/package-lock.json"),
      join(root, "app/ui/package.json"),
      join(root, "app/ui/package-lock.json"),
    ]);
    assert.equal(await readFile(join(root, "VERSION"), "utf8"), "1.2.3\n");

    for (const relativePath of [
      "app/package.json",
      "app/package-lock.json",
      "app/ui/package.json",
      "app/ui/package-lock.json",
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

    const appLock = JSON.parse(
      await readFile(join(root, "app/package-lock.json"), "utf8"),
    ) as { packages: { "node_modules/tar": { version: string } } };
    const uiLock = JSON.parse(
      await readFile(join(root, "app/ui/package-lock.json"), "utf8"),
    ) as { packages: { "node_modules/vite": { version: string } } };
    assert.equal(appLock.packages["node_modules/tar"].version, "7.5.22");
    assert.equal(uiLock.packages["node_modules/vite"].version, "8.3.3");
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
    await writeFile(join(root, "app/ui/package-lock.json"), "{ broken json\n");
    const before = await snapshot(root);
    await assert.rejects(
      synchronizeVersion(root, "1.2.3"),
      /app\/ui\/package-lock\.json: invalid JSON/,
    );
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await removeFixtureRoot(root);
  }
});

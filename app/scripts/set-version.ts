import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ManifestSpec =
  | { readonly kind: "root-version"; readonly path: string }
  | {
      readonly kind: "json-version";
      readonly path: string;
      readonly fields: readonly (readonly string[])[];
    };

const packageVersion: readonly (readonly string[])[] = [["version"]];
const npmLockVersion: readonly (readonly string[])[] = [
  ["version"],
  ["packages", "", "version"],
];

const activeManifests: readonly ManifestSpec[] = [
  { kind: "root-version", path: "VERSION" },
  {
    kind: "json-version",
    path: "app/package.json",
    fields: packageVersion,
  },
  {
    kind: "json-version",
    path: "app/package-lock.json",
    fields: npmLockVersion,
  },
  {
    kind: "json-version",
    path: "app/ui/package.json",
    fields: packageVersion,
  },
  {
    kind: "json-version",
    path: "app/ui/package-lock.json",
    fields: npmLockVersion,
  },
];

export const VERSION_MANIFEST_SETS = {
  active: activeManifests.map(({ path }) => path),
} as const;

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MAX_VERSION_PART = 18_446_744_073_709_551_615n;

function validateVersion(version: string): void {
  const match = VERSION_PATTERN.exec(version);
  if (
    !match ||
    match.slice(1).some((part) => BigInt(part) > MAX_VERSION_PART)
  ) {
    throw new Error(
      "Version must use X.Y.Z format with unsigned 64-bit numeric parts.",
    );
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function setJsonFields(
  value: unknown,
  fields: readonly (readonly string[])[],
  version: string,
  path: string,
): void {
  for (const fieldPath of fields) {
    let current: unknown = value;
    for (const field of fieldPath.slice(0, -1)) {
      const object = record(current);
      if (!object || !Object.hasOwn(object, field)) {
        throw new Error(`${path}: expected JSON field ${fieldPath.join(".")}.`);
      }
      current = object[field];
    }
    const object = record(current);
    const finalField = fieldPath.at(-1);
    if (!object || !finalField || typeof object[finalField] !== "string") {
      throw new Error(`${path}: expected string field ${fieldPath.join(".")}.`);
    }
    object[finalField] = version;
  }
}

function updateJson(
  source: string,
  fields: readonly (readonly string[])[],
  version: string,
  path: string,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  setJsonFields(parsed, fields, version, path);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function updateManifest(
  source: string,
  manifest: ManifestSpec,
  version: string,
): string {
  switch (manifest.kind) {
    case "root-version":
      return `${version}\n`;
    case "json-version":
      return updateJson(source, manifest.fields, version, manifest.path);
  }
}

export async function synchronizeVersion(
  root: string,
  version: string,
): Promise<string[]> {
  validateVersion(version);
  const manifests = activeManifests;
  const paths = manifests.map(({ path }) => path);
  if (new Set(paths).size !== paths.length)
    throw new Error("Version manifest registry contains duplicate paths.");

  // Read, parse, and validate every target before the first write.
  const prepared = await Promise.all(
    manifests.map(async (manifest) => {
      const path = resolve(root, manifest.path);
      const source = await readFile(path, "utf8");
      return { path, contents: updateManifest(source, manifest, version) };
    }),
  );

  for (const item of prepared) {
    if (item.contents !== (await readFile(item.path, "utf8"))) {
      await writeFile(item.path, item.contents, "utf8");
    }
  }
  return prepared.map(({ path }) => path);
}

async function main(): Promise<void> {
  const version = process.argv[2];
  if (!version || process.argv.length !== 3) {
    throw new Error("Usage: npm run set-version -- X.Y.Z");
  }
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const manifestPaths = await synchronizeVersion(repositoryRoot, version);
  process.stdout.write(
    `Synchronized ${version} across ${manifestPaths.length} version manifests.\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ManifestSpec =
  | { readonly kind: "root-version"; readonly path: string }
  | {
      readonly kind: "json-version";
      readonly path: string;
      readonly fields: readonly (readonly string[])[];
    }
  | { readonly kind: "cargo-workspace"; readonly path: string }
  | {
      readonly kind: "cargo-lock";
      readonly path: string;
      readonly packageNames: readonly string[];
    };

const packageVersion: readonly (readonly string[])[] = [["version"]];
const npmLockVersion: readonly (readonly string[])[] = [
  ["version"],
  ["packages", "", "version"],
];

// Remove retired-host entries from this list only after its release path is retired.
const activeManifests: readonly ManifestSpec[] = [
  { kind: "root-version", path: "VERSION" },
  {
    kind: "json-version",
    path: "electron/package.json",
    fields: packageVersion,
  },
  {
    kind: "json-version",
    path: "electron/package-lock.json",
    fields: npmLockVersion,
  },
  {
    kind: "json-version",
    path: "shared/ui/package.json",
    fields: packageVersion,
  },
  {
    kind: "json-version",
    path: "shared/ui/package-lock.json",
    fields: npmLockVersion,
  },
];

const legacyManifests: readonly ManifestSpec[] = [
  { kind: "json-version", path: "linux/package.json", fields: packageVersion },
  {
    kind: "json-version",
    path: "linux/package-lock.json",
    fields: npmLockVersion,
  },
  {
    kind: "json-version",
    path: "linux/src-tauri/tauri.conf.json",
    fields: packageVersion,
  },
  { kind: "cargo-workspace", path: "linux/Cargo.toml" },
  {
    kind: "cargo-lock",
    path: "linux/Cargo.lock",
    packageNames: [
      "openwhisper-core",
      "openwhisper-speech",
      "openwhisper-desktop",
    ],
  },
];

export const VERSION_MANIFEST_SETS = {
  active: activeManifests.map(({ path }) => path),
  legacy: legacyManifests.map(({ path }) => path),
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

function updateCargoWorkspace(
  source: string,
  version: string,
  path: string,
): string {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const sectionStarts = lines.flatMap((line, index) =>
    /^\s*\[[^\]]+\]\s*(?:#.*)?\r?\n?$/.test(line) ? [index] : [],
  );
  const workspaceStart = sectionStarts.find(
    (index) =>
      lines[index]?.replace(/\r?\n$/, "").trim() === "[workspace.package]",
  );
  if (workspaceStart === undefined)
    throw new Error(`${path}: missing [workspace.package] section.`);
  const workspaceEnd =
    sectionStarts.find((index) => index > workspaceStart) ?? lines.length;
  const versionLines = lines.flatMap((line, index) =>
    index >= workspaceStart &&
    index < workspaceEnd &&
    /^\s*version\s*=\s*"[^"]+"(?:\s*(?:#.*)?)?\r?\n?$/.test(line)
      ? [index]
      : [],
  );
  if (versionLines.length !== 1)
    throw new Error(`${path}: expected one version in [workspace.package].`);
  const index = versionLines[0];
  if (index === undefined)
    throw new Error(`${path}: could not read workspace version line.`);
  const line = lines[index];
  if (line === undefined)
    throw new Error(`${path}: could not read workspace version line.`);
  lines[index] = line.replace(/(^\s*version\s*=\s*")[^"]+/, `$1${version}`);
  return lines.join("");
}

function updateCargoLock(
  source: string,
  version: string,
  path: string,
  packageNames: readonly string[],
): string {
  const remaining = new Set(packageNames);
  const sections = source.split(/(?=^\[\[package\]\]\r?$)/m);
  const updated = sections.map((section) => {
    const name = /^name = "([^"]+)"\r?$/m.exec(section)?.[1];
    if (!name || !remaining.has(name)) return section;
    remaining.delete(name);
    const versionLines = [...section.matchAll(/^version = "[^"]+"\r?$/gm)];
    if (versionLines.length !== 1)
      throw new Error(
        `${path}: expected one version for Cargo package ${name}.`,
      );
    return section.replace(/^(version = ")[^"]+("\r?)$/m, `$1${version}$2`);
  });
  if (remaining.size > 0) {
    throw new Error(
      `${path}: missing Cargo package entries: ${[...remaining].join(", ")}.`,
    );
  }
  return updated.join("");
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
    case "cargo-workspace":
      return updateCargoWorkspace(source, version, manifest.path);
    case "cargo-lock":
      return updateCargoLock(
        source,
        version,
        manifest.path,
        manifest.packageNames,
      );
  }
}

export async function synchronizeVersion(
  root: string,
  version: string,
): Promise<string[]> {
  validateVersion(version);
  const manifests = [...activeManifests, ...legacyManifests];
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

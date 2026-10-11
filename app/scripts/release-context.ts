import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nextPatchVersion, parseUpdateVersion } from "../src/services/update/common/update-policy.js";

export interface ReleaseContext {
  readonly currentVersion: string;
  readonly successorVersion: string;
}

export type ReleaseFiles = Readonly<Record<string, string>>;

function nestedVersion(source: string, path: string, fields: readonly string[]): string {
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch { throw new Error(`${path} is not valid JSON.`); }
  for (const field of fields) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, field)) {
      throw new Error(`${path} is missing ${fields.join(".")}.`);
    }
    value = (value as Record<string, unknown>)[field];
  }
  if (typeof value !== "string") throw new Error(`${path} ${fields.join(".")} must be a string.`);
  return value;
}

export function releaseContextFromFiles(files: ReleaseFiles): ReleaseContext {
  const currentVersion = files.VERSION?.trim();
  if (!currentVersion) throw new Error("VERSION is missing or empty.");
  parseUpdateVersion(currentVersion);
  const versions = [
    nestedVersion(files["app/package.json"] ?? "", "app/package.json", ["version"]),
    nestedVersion(files["app/package-lock.json"] ?? "", "app/package-lock.json", ["version"]),
    nestedVersion(files["app/package-lock.json"] ?? "", "app/package-lock.json", ["packages", "", "version"]),
    nestedVersion(files["app/ui/package.json"] ?? "", "app/ui/package.json", ["version"]),
    nestedVersion(files["app/ui/package-lock.json"] ?? "", "app/ui/package-lock.json", ["version"]),
    nestedVersion(files["app/ui/package-lock.json"] ?? "", "app/ui/package-lock.json", ["packages", "", "version"]),
  ];
  if (versions.some((value) => value !== currentVersion)) throw new Error("Release version manifests are inconsistent.");
  return Object.freeze({ currentVersion, successorVersion: nextPatchVersion(currentVersion) });
}

const releasePaths = ["VERSION", "app/package.json", "app/package-lock.json", "app/ui/package.json", "app/ui/package-lock.json"] as const;

export async function readReleaseContext(root: string): Promise<ReleaseContext> {
  const files = Object.fromEntries(await Promise.all(releasePaths.map(async (path) => [path, await readFile(resolve(root, path), "utf8")] as const)));
  return releaseContextFromFiles(files);
}

export function releaseContextFromCommit(repository: string, commit: string): ReleaseContext {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Producer commit must be a canonical SHA-1 commit.");
  const run = (args: readonly string[]): string => {
    const result = spawnSync("git", [...args], { cwd: repository, encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.signal !== null || result.status !== 0) throw new Error("Could not read exact release context from producer commit.");
    return result.stdout;
  };
  if (run(["cat-file", "-t", commit]).trim() !== "commit") throw new Error("Producer source is not a commit.");
  const files = Object.fromEntries(releasePaths.map((path) => [path, run(["show", `${commit}:${path}`])]));
  return releaseContextFromFiles(files);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let commit: string | undefined, output: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!value || (flag !== "--commit" && flag !== "--github-output") || (flag === "--commit" ? !!commit : !!output)) throw new Error("Usage: release-context.ts [--commit SHA] [--github-output PATH]");
    if (flag === "--commit") commit = value; else output = value;
  }
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const context = commit ? releaseContextFromCommit(root, commit) : await readReleaseContext(root);
  if (output) await appendFile(output, `current_version=${context.currentVersion}\nsuccessor_version=${context.successorVersion}\n`, { mode: 0o600 });
  else process.stdout.write(`${JSON.stringify(context)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

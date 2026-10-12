import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { prepareVersionUpdates } from "./set-version.js";
import { readReleaseContext } from "./release-context.js";
import { isNewerUpdateVersion, parseUpdateVersion } from "../src/services/update/common/update-policy.js";

const highlightSchema = z.strictObject({
  en: z.array(z.string().min(1).max(512)).min(1).max(5),
  de: z.array(z.string().min(1).max(512)).min(1).max(5),
}).superRefine((value, context) => {
  for (const language of ["en", "de"] as const) {
    for (const [index, item] of value[language].entries()) {
      if (item !== item.trim() || /[\r\n\u0000-\u001f\u007f]/u.test(item) || Buffer.byteLength(item, "utf8") > 512) {
        context.addIssue({ code: "custom", path: [language, index], message: "Highlight must be one trimmed line of at most 512 UTF-8 bytes." });
      }
    }
  }
});
export type ReleaseHighlights = z.infer<typeof highlightSchema>;

export interface PreparedRelease {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly notes: string;
  readonly changes: readonly { readonly path: string; readonly contents: string }[];
}

function releaseNotesBlock(version: string, highlights: ReleaseHighlights): string {
  return `## What's new in OpenWhisper ${version}\n\n${highlights.en.map((item) => `- ${item}`).join("\n")}\n\n## Neu in OpenWhisper ${version}\n\n${highlights.de.map((item) => `- ${item}`).join("\n")}`;
}

export async function prepareRelease(root: string, targetVersionInput: unknown, authored: unknown): Promise<PreparedRelease> {
  const highlights = highlightSchema.parse(authored);
  const context = await readReleaseContext(root);
  if (typeof targetVersionInput !== "string") throw new Error("Target release version must be a string.");
  const targetVersion = targetVersionInput;
  parseUpdateVersion(targetVersion);
  if (targetVersion === context.currentVersion) {
    const [readme, releaseNotes] = await Promise.all([readFile(resolve(root, "README.md"), "utf8"), readFile(resolve(root, ".github/release-notes.md"), "utf8")]);
    const currentStatement = `The current release is **${targetVersion}**`;
    const intro = "<!-- Prepared for the gated release workflow; repository status lives in README.md. -->\n\n";
    if (readme.includes(currentStatement)) {
      if (readme.split(currentStatement).length === 2 && releaseNotes.startsWith(`${intro}${releaseNotesBlock(targetVersion, highlights)}\n\n`)) {
        return Object.freeze({ currentVersion: context.currentVersion, targetVersion, notes: releaseNotesBlock(targetVersion, highlights), changes: Object.freeze([]) });
      }
      throw new Error("A release at the current version already exists with different prepared content.");
    }
  }
  if (targetVersion !== context.currentVersion && !isNewerUpdateVersion(targetVersion, context.currentVersion)) {
    throw new Error("Target release version must be newer than VERSION.");
  }
  const versionUpdates = await prepareVersionUpdates(root, targetVersion);
  const [readme, releaseNotes] = await Promise.all([
    readFile(resolve(root, "README.md"), "utf8"),
    readFile(resolve(root, ".github/release-notes.md"), "utf8"),
  ]);
  const readmeReleases = [...readme.matchAll(/The current release is \*\*((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))\*\*/gu)];
  const marker = "Recognition runs locally.";
  const markerIndex = releaseNotes.indexOf(marker);
  const firstHeading = releaseNotes.indexOf("## What's new in OpenWhisper ");
  const curatedNotes = firstHeading < 0 || markerIndex < firstHeading ? "" : releaseNotes.slice(firstHeading, markerIndex);
  const englishVersions = [...curatedNotes.matchAll(/^## What's new in OpenWhisper ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/gmu)].map((match) => match[1]!);
  const germanVersions = [...curatedNotes.matchAll(/^## Neu in OpenWhisper ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/gmu)].map((match) => match[1]!);
  if (readmeReleases.length !== 1 || firstHeading < 0 || markerIndex < firstHeading ||
      englishVersions.length !== 1 || germanVersions.length !== 1 ||
      englishVersions[0] !== readmeReleases[0]![1] || germanVersions[0] !== readmeReleases[0]![1] ||
      isNewerUpdateVersion(readmeReleases[0]![1]!, context.currentVersion)) {
    throw new Error("Release notes must contain exactly one current bilingual curated section before the stable guidance.");
  }
  const currentStatement = `The current release is **${readmeReleases[0]![1]}**`;
  const readmeContents = readme.replace(currentStatement, `The current release is **${targetVersion}**`);
  const intro = "<!-- Prepared for the gated release workflow; repository status lives in README.md. -->\n\n";
  const notes = `${intro}${releaseNotesBlock(targetVersion, highlights)}\n\n${releaseNotes.slice(markerIndex)}`;
  const changes = [...versionUpdates, { path: resolve(root, "README.md"), contents: readmeContents },
    { path: resolve(root, ".github/release-notes.md"), contents: notes }];
  if (new Set(changes.map(({ path }) => path)).size !== changes.length) throw new Error("Release preparation contains duplicate output paths.");
  return Object.freeze({ currentVersion: context.currentVersion, targetVersion,
    notes: releaseNotesBlock(targetVersion, highlights), changes: Object.freeze(changes) });
}

export async function applyPreparedRelease(prepared: PreparedRelease): Promise<void> {
  for (const change of prepared.changes) await writeFile(change.path, change.contents, "utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--mode" || !["preview", "apply"].includes(args[1] ?? "") || args[2] !== "--version" || args[4] !== "--highlights") {
    throw new Error("Usage: npm run prepare-release -- --mode preview|apply --version X.Y.Z --highlights PATH");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const highlights = JSON.parse(await readFile(resolve(args[5]!), "utf8")) as unknown;
  const prepared = await prepareRelease(root, args[3], highlights);
  if (prepared.targetVersion !== prepared.currentVersion) {
    const git = spawnSync("git", ["tag", "--list", `v${prepared.targetVersion}`], { cwd: root, encoding: "utf8", shell: false });
    if (git.error || git.status !== 0) throw new Error("Could not verify local release tags.");
    if (git.stdout.trim()) throw new Error(`Release tag v${prepared.targetVersion} already exists.`);
  }
  if (args[1] === "preview") {
    process.stdout.write(`${JSON.stringify({ mode: "preview", currentVersion: prepared.currentVersion,
      targetVersion: prepared.targetVersion, paths: prepared.changes.map(({ path }) => path.slice(root.length + 1)),
      releaseNotes: prepared.notes }, null, 2)}\n`);
    return;
  }
  await applyPreparedRelease(prepared);
  process.stdout.write(prepared.changes.length ? `Prepared ${prepared.currentVersion} → ${prepared.targetVersion} across ${prepared.changes.length} files.\n` : `Release ${prepared.targetVersion} is already prepared.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}

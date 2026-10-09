import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findAmbiguousRunContinuations } from "./workflow-policy.js";
import { setupPreflightTools } from "./setup-preflight-tools.js";

const electronDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = resolve(electronDirectory, "..");
const workflowDirectory = join(repositoryRoot, ".github/workflows");

async function workflowFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await workflowFiles(path)));
    else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) found.push(path);
  }
  return found.sort();
}

function command(
  title: string,
  executable: string,
  args: string[],
  cwd: string,
): void {
  process.stdout.write(`\n${title}\n`);
  const result = spawnSync(executable, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${title} failed with exit code ${result.status ?? "unknown"}.`,
    );
}

async function main(): Promise<void> {
  const { actionlint, shellcheck } = await setupPreflightTools();
  const workflows = await workflowFiles(workflowDirectory);
  if (workflows.length === 0)
    throw new Error("No GitHub Actions workflow files were found.");

  const policyDiagnostics: string[] = [];
  for (const path of workflows) {
    policyDiagnostics.push(
      ...findAmbiguousRunContinuations(await readFile(path, "utf8"), path),
    );
  }
  if (policyDiagnostics.length > 0)
    throw new Error(policyDiagnostics.join("\n"));

  command(
    "Check workflow syntax and embedded shell",
    actionlint,
    ["-shellcheck", shellcheck, ...workflows],
    repositoryRoot,
  );
  command(
    "Check focused continuation regression fixtures",
    "node",
    [
      "--import",
      "tsx",
      "--test",
      "tests/workflow-policy.test.ts",
      "tests/preflight-cache.test.ts",
    ],
    electronDirectory,
  );
  command(
    "Check Electron TypeScript",
    "npm",
    ["run", "typecheck"],
    electronDirectory,
  );
  command(
    "Check shared UI formatting",
    "npm",
    ["run", "format:check", "--prefix", "../shared/ui"],
    electronDirectory,
  );
  const pullRequestBase = process.env.GITHUB_BASE_REF;
  if (pullRequestBase) {
    command(
      "Check pull request whitespace",
      "git",
      ["diff", "--check", `origin/${pullRequestBase}...HEAD`],
      repositoryRoot,
    );
  } else if (process.env.GITHUB_ACTIONS === "true") {
    const parent = spawnSync("git", ["rev-parse", "--verify", "HEAD^"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    command(
      "Check commit whitespace",
      "git",
      parent.status === 0
        ? ["diff", "--check", "HEAD^", "HEAD"]
        : ["show", "--check", "--format=", "HEAD"],
      repositoryRoot,
    );
  } else {
    command(
      "Check working tree whitespace",
      "git",
      ["diff", "--check"],
      repositoryRoot,
    );
    command(
      "Check staged whitespace",
      "git",
      ["diff", "--cached", "--check"],
      repositoryRoot,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

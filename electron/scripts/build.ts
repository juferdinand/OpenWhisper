import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) throw new Error("Application build failed.");
}

export async function buildApplication(): Promise<void> {
  await rm(join(root, "dist"), { recursive: true, force: true });
  run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], root);
  run("npm", ["run", "build"], resolve(root, "../shared/ui"));
  await build({
    entryPoints: [join(root, "src/preload/index.ts")],
    outfile: join(root, "dist/preload/index.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    sourcemap: false,
  });
  await cp(resolve(root, "../shared/ui/dist"), join(root, "dist/ui"), { recursive: true });
  await mkdir(join(root, "dist/resources"), { recursive: true });
  await cp(resolve(root, "../shared/models.json"), join(root, "dist/resources/models.json"));
  await cp(resolve(root, "../VERSION"), join(root, "dist/resources/VERSION"));
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", shell: false });
  const changes = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", shell: false });
  const commit = revision.status === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim())
    ? revision.stdout.trim() : "source";
  await writeFile(join(root, "dist/resources/development-build.json"), JSON.stringify({
    commit, modified: changes.status !== 0 || changes.stdout.length > 0,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildApplication();
}

import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildIdentitySchema } from "../src/contracts/build-identity.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error || result.status !== 0) throw new Error("Application build failed.");
}

export async function buildApplication(options: { readonly recording?: boolean; readonly stable?: boolean } = {}): Promise<void> {
  if (options.stable && (process.platform !== "linux" || process.arch !== "x64")) {
    throw new Error("A fresh stable validation build requires Linux x64.");
  }
  const identity = buildIdentitySchema.parse(options.stable ? { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" }
    : { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" });
  const projectVersion = (await readFile(resolve(root, "../VERSION"), "utf8")).trim();
  const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(projectVersion) || typeof metadata !== "object" || metadata === null ||
      Reflect.get(metadata, "version") !== projectVersion) throw new Error("Source and project versions differ.");
  await rm(join(root, "dist"), { recursive: true, force: true });
  run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], root);
  await build({ stdin: { contents: `export const APPLICATION_BUILD: unknown = ${JSON.stringify(identity)};`, loader: "ts", resolveDir: root },
    outfile: join(root, "dist/main/application-build.js"), platform: "node", format: "esm", target: "node24", sourcemap: false });
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
  await cp(resolve(root, "../shared/locales"), join(root, "dist/resources/locales"), { recursive: true });
  await cp(resolve(root, "../shared/models.json"), join(root, "dist/resources/models.json"));
  await cp(resolve(root, "../VERSION"), join(root, "dist/resources/VERSION"));
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", shell: false });
  const changes = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", shell: false });
  const commit = revision.status === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim())
    ? revision.stdout.trim() : "source";
  await writeFile(join(root, "dist/resources/development-build.json"), JSON.stringify({
    commit, modified: changes.status !== 0 || changes.stdout.length > 0,
  }));
  if (options.recording) {
    const { buildDevelopmentRecording } = await import("./build-development-recording.js");
    await buildDevelopmentRecording();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--recording" && argument !== "--stable") || new Set(args).size !== args.length) {
    throw new Error("Usage: build.ts [--recording] [--stable]");
  }
  await buildApplication({ recording: args.includes("--recording"), stable: args.includes("--stable") });
}

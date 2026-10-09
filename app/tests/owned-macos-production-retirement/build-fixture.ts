import { build } from "esbuild";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { payloadNames } from "./contracts.js";
import { fixtureSourceHashes } from "./input.js";

/** Bundle-only operation; it never loads Electron or a native module. */
export async function buildMacProductionRetirementFixture(directory: string): Promise<Record<string, string>> {
  if (!isAbsolute(directory) || directory.includes("\0")) throw new Error("Fixture output refused.");
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== process.getuid?.() ||
    (status.mode & 0o7777) !== 0o700 || await realpath(directory) !== resolve(directory)) throw new Error("Fixture output refused.");
  const source = dirname(fileURLToPath(import.meta.url)), dist = resolve(source, "../../dist");
  const before = await fixtureSourceHashes(resolve(source, "../.."));
  for (const name of payloadNames) await build({ entryPoints: [join(source, name.replace(/\.mjs$/u, ".ts"))], outfile: join(directory, name),
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"],
    plugins: [{ name: "actual-production-retirement-distribution", setup(builder) {
      builder.onResolve({ filter: /src\/.+\.js$/ }, (args) => {
        const suffix = args.path.split("/src/")[1]; if (!suffix || suffix.includes("..")) throw new Error("Invalid compiled fixture import.");
        return { path: pathToFileURL(join(dist, suffix)).href, external: true };
      });
    } }],
  });
  if (JSON.stringify(await fixtureSourceHashes(resolve(source, "../.."))) !== JSON.stringify(before)) throw new Error("Fixture source changed during bundling.");
  return before;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]; if (!directory || process.argv.length !== 3) throw new Error("One private absolute bundle directory is required.");
  await buildMacProductionRetirementFixture(directory);
}

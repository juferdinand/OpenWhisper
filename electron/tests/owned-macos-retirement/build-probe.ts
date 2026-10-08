import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Generated fixtures import the actual compiled adapter, never a source mock. */
export async function buildMacRetirementFixture(directory: string): Promise<void> {
  const source = dirname(fileURLToPath(import.meta.url)), dist = resolve(source, "../../dist");
  for (const name of ["main", "entry", "worker"]) await build({ entryPoints: [join(source, `${name}.ts`)], outfile: join(directory, `${name}.mjs`),
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"],
    plugins: [{ name: "actual-retirement-distribution", setup(builder) {
      builder.onResolve({ filter: /src\/.+\.js$/ }, (args) => {
        const suffix = args.path.split("/src/")[1]; if (!suffix || suffix.includes("..")) throw new Error("Invalid packaged fixture import.");
        return { path: pathToFileURL(join(dist, suffix)).href, external: true };
      });
    } }],
  });
}

import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Build generated fixtures; native wrapper imports use the actual built distribution. */
export async function buildMacCaptureProbe(directory: string): Promise<void> {
  const source = dirname(fileURLToPath(import.meta.url)), dist = resolve(source, "../../dist");
  for (const name of ["entry", "main"]) {
    await build({ entryPoints: [join(source, `${name}.ts`)], outfile: join(directory, `${name}.mjs`), bundle: true,
      platform: "node", format: "esm", target: "node24", external: ["electron"],
      plugins: [{ name: "exact-packaged-macos-capture", setup(builder) {
        builder.onResolve({ filter: /src\/.+\.js$/ }, (args) => {
          const suffix = args.path.split("/src/")[1];
          if (!suffix || suffix.includes("..")) throw new Error("Invalid packaged fixture import.");
          return { path: pathToFileURL(join(dist, suffix)).href, external: true };
        });
      } }],
    });
  }
}

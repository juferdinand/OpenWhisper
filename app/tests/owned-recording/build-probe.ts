import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Generated modules only. Production imports resolve to the exact frozen distribution. */
export async function buildRecordingProbe(directory: string): Promise<void> {
  const source = dirname(fileURLToPath(import.meta.url));
  for (const name of ["probe", "entry"]) {
    await build({ entryPoints: [join(source, `${name}.ts`)], outfile: join(directory, `${name}.mjs`),
      bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"],
      plugins: [{ name: "exact-packaged-recording", setup(builder) {
        builder.onResolve({ filter: /src\/.+\.js$/ }, (args) => {
          const suffix = args.path.split("/src/")[1];
          if (!suffix || suffix.includes("..")) throw new Error("Invalid packaged fixture import.");
          return { path: `file:///owned-app/dist/${suffix}`, external: true };
        });
      } }],
    });
  }
}

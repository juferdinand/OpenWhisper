import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Generated JavaScript only; test authors and production processors remain strict TypeScript. */
export async function buildParakeetProbe(directory: string): Promise<void> {
  const source = dirname(fileURLToPath(import.meta.url));
  await build({ entryPoints: [join(source, "../fixtures/parakeet-speech.ts")], outfile: join(directory, "probe.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"],
    plugins: [{ name: "actual-packaged-speech", setup(builder) {
      builder.onResolve({ filter: /src\/(services\/speech-client|workers\/speech-(control|protocol))\.js$/ }, (args) => ({
        path: `file:///owned-app/dist/${args.path.split("/src/")[1]}`, external: true,
      }));
    } }],
  });
  await build({ entryPoints: [join(source, "processor.ts")], outfile: join(directory, "processor.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"] });
}

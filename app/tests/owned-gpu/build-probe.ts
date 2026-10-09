import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildOwnedGpuProbe(output: string): Promise<void> {
  await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), "probe.ts")], outfile: output,
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"],
    plugins: [{ name: "actual-packaged-speech", setup(builder) {
      builder.onResolve({ filter: /src\/(services\/speech-client|workers\/speech-(control|protocol))\.js$/ }, (args) => ({
        path: `file:///owned-app/dist/${args.path.split("/src/")[1]}`, external: true,
      }));
    } }],
  });
}

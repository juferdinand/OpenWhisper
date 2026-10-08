import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));
export async function buildOwnedSpeechProbe(output: string): Promise<void> {
await build({
  entryPoints: [join(directory, "probe.ts")], outfile: output,
  bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"],
  plugins: [{ name: "actual-packaged-speech", setup(builder) {
    builder.onResolve({ filter: /src\/(services\/speech-client|workers\/speech-(control|protocol))\.js$/ }, (args) => ({
      path: `file:///owned-app/dist/${args.path.split("/src/")[1]}`, external: true,
    }));
  } }],
});
}

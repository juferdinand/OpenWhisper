import { build } from "esbuild";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
export async function buildBusProbe(output: string): Promise<void> {
  await build({ entryPoints: [join(root, "tests/owned-bus/probe.ts")], outfile: join(output, "probe.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"] });
  await build({ entryPoints: [join(root, "tests/owned-bus/entry.ts")], outfile: join(output, "entry.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node24",
    plugins: [{ name: "packaged-bus-facade", setup(builder) {
      builder.onResolve({ filter: /src\/platforms\/linux\/shared\/bus\.js$/ }, () => ({ path: "file:///owned-app/dist/platforms/linux/shared/bus.js", external: true }));
    } }] });
  await build({ entryPoints: [join(root, "src/platforms/linux/shared/bus.ts")], outfile: join(output, "bus.js"),
    bundle: true, platform: "node", format: "esm", target: "node24" });
}

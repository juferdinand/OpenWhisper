import { build } from "esbuild";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const packaged = { name: "fixed-owned-platform", setup(builder: import("esbuild").PluginBuild) {
  builder.onResolve({ filter: /platforms\/linux\/shared\/bus\.js$/ }, (args) => args.kind === "entry-point" ? undefined : ({ path: "file:///owned-app/dist/platforms/linux/shared/bus.js", external: true }));
  builder.onResolve({ filter: /platforms\/linux\/shared\/control\.js$/ }, (args) => args.kind === "entry-point" ? undefined : ({ path: "file:///owned-app/dist/platforms/linux/shared/control.js", external: true }));
  builder.onResolve({ filter: /main\/platform-channel\.js$/ }, (args) => args.kind === "entry-point" ? undefined : ({ path: "file:///owned-app/dist/main/platform-channel.js", external: true }));
} };
export async function buildControlProbe(output: string): Promise<void> {
  for (const [source, destination] of [["tests/owned-control/probe.ts", "probe.mjs"],
    ["tests/owned-control/entry.ts", "entry.mjs"], ["tests/owned-control/headless.ts", "headless.mjs"],
    ["src/platforms/linux/shared/bus.ts", "bus.js"], ["src/platforms/linux/shared/control.ts", "control.js"],
    ["src/main/platform-channel.ts", "platform-channel.js"], ["src/workers/platform-entry.ts", "platform-entry.js"]]) {
    if (!source || !destination) throw new Error("Invalid fixed build entry.");
    await build({ entryPoints: [join(root, source)], outfile: join(output, destination), bundle: true,
      platform: "node", format: "esm", target: "node24", external: ["electron"], plugins: [packaged,
        { name: "local-bus-class", setup(builder) {
          builder.onResolve({ filter: /^\.\/bus\.js$/ }, () => ({ path: "file:///owned-app/dist/platforms/linux/shared/bus.js", external: true }));
        } }] });
  }
  // Compile the real entry with an owned creation-failure fixture. Production has no test hook.
  const fault = join(root, "tests/owned-control/cleanup-failure.ts");
  await build({ entryPoints: [join(root, "src/workers/platform-entry.ts")], outfile: join(output, "platform-fault.mjs"),
    bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron"], plugins: [{
      name: "owned-control-creation-failure", setup(builder) {
        builder.onResolve({ filter: /platforms\/linux\/shared\/control\.js$/ }, (args) =>
          args.importer === join(root, "src/workers/platform-entry.ts") ? ({ path: fault }) : undefined);
      },
    }, packaged, { name: "fault-local-bus", setup(builder) {
      builder.onResolve({ filter: /^\.\/bus\.js$/ }, () => ({ path: "file:///owned-app/dist/platforms/linux/shared/bus.js", external: true }));
    } }] });
}

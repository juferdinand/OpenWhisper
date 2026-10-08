import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { frozenCore, HEADER_SHA, IMAGE, packageSchema, RUNTIME_ARCHIVE_SHA, RUNTIME_SHA, sameHashes, SECCOMP_SHA } from "./launch-contracts.js";
import { Commands, hash, tree } from "./launch-io.js";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const additionalSources = Object.freeze(["native/node-headers.json", "tests/owned-bus/Dockerfile", "tests/owned-ui/seccomp.json",
  "package.json", "package-lock.json", "tests/owned-bus-opening/launch-contracts.ts", "tests/owned-bus-opening/launch-io.ts",
  "tests/owned-bus-opening/process-witness.ts", "tests/owned-bus-opening/launcher.test.ts", "tests/owned-bus-opening/prepare.ts",
  "tests/owned-bus-opening/execute.ts", "tests/owned-bus-opening/run.ts", "tests/owned-bus-opening/parent.ts", "tests/owned-bus-opening/driver.ts",
  "tests/owned-bus-opening/diagnostics.ts", "tests/owned-bus-opening/diagnostics.test.ts", "tests/owned-bus-opening/retained-contracts.ts",
  "tests/owned-bus-opening/prepare-retained.ts", "tests/owned-bus-opening/execute-retained.ts", "tests/owned-bus-opening/run-retained.ts",
  "tests/owned-bus-opening/daemon-owner.ts", "tests/owned-bus-opening/daemon-owner.test.ts",
  "tests/owned-bus-opening/remaining-contracts.ts", "tests/owned-bus-opening/prepare-remaining.ts",
  "tests/owned-bus-opening/execute-remaining.ts", "tests/owned-bus-opening/run-remaining.ts", "tests/owned-bus-opening/remaining.test.ts",
  "tests/owned-bus-opening/legacy-diagnostics.ts", "tests/owned-bus-opening/legacy-diagnostics.test.ts",
  "tests/owned-bus-opening/legacy-retained-contracts.ts", "tests/owned-bus-opening/prepare-legacy.ts",
  "tests/owned-bus-opening/execute-legacy.ts", "tests/owned-bus-opening/run-legacy.ts", "tests/owned-bus-opening/legacy-retained.test.ts"]);
export async function prepare(output: string, headers: string, seccomp: string): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000) throw new Error("Owned preparation requires Linux x64 UID1000.");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await mkdir(output, { mode: 0o700 });
  const commands = new Commands(output), source = join(output, "source"), payload = join(output, "payload");
  await mkdir(source, { mode: 0o700 }); await mkdir(payload, { mode: 0o700 });
  const sourceHashes: Record<string, string> = {};
  for (const path of [...Object.keys(frozenCore), ...additionalSources]) {
    const expected = frozenCore[path], before = await hash(join(root, path));
    if (expected !== undefined && before !== expected) throw new Error("Reviewed source changed before preparation.");
    const target = join(source, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await cp(join(root, path), target, { errorOnExist: true, force: false });
    if (await hash(target) !== before || await hash(join(root, path)) !== before) throw new Error("Source changed during snapshot.");
    sourceHashes[path] = before;
  }
  const pin = z.strictObject({ version: z.literal("24.21.0"), napiVersion: z.literal(8), sha256: z.literal(HEADER_SHA),
    source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt") }).parse(JSON.parse(await readFile(join(source, "native/node-headers.json"), "utf8")));
  if (await hash(headers) !== pin.sha256 || await hash(seccomp) !== SECCOMP_SHA) throw new Error("Retained header/profile checksum mismatch.");
  await cp(headers, join(payload, "headers.tar.gz")); await cp(seccomp, join(output, "seccomp.json"));
  const zip = join(root, "node_modules/.cache/electron/5a625dfd3df3efc3971556afe64989f9aa6ea0f4cd6e33889c1951789041498f/electron-v44.7.0-linux-x64.zip");
  if (await hash(zip) !== RUNTIME_ARCHIVE_SHA) throw new Error("Pinned Electron archive mismatch; run the existing checksum-verifying setup first.");
  await cp(zip, join(output, "electron-v44.7.0-linux-x64.zip"));
  await commands.run("unzip", ["-q", join(output, "electron-v44.7.0-linux-x64.zip"), "-d", join(payload, "runtime")]);
  if (await hash(join(payload, "runtime/electron")) !== RUNTIME_SHA || (await readFile(join(payload, "runtime/version"), "utf8")).trim() !== "44.7.0") throw new Error("Unexpected extracted runtime.");
  for (const name of ["CMakeLists.txt", "binding.cpp", "codec.cpp", "codec.hpp"]) {
    await mkdir(join(payload, "native-linux-bus"), { recursive: true, mode: 0o700 });
    await cp(join(source, "native/linux-bus", name), join(payload, "native-linux-bus", name));
  }
  const parent = join(payload, "opening-parent"); await mkdir(parent, { mode: 0o700 });
  await writeFile(join(parent, "package.json"), JSON.stringify({ name: "openwhisper-owned-opening-parent", private: true, type: "module", main: "main.mjs" }), { mode: 0o600 });
  await writeFile(join(parent, "renderer.html"), "<!doctype html><meta charset=utf-8><title>Owned sandbox probe</title><p>Owned bus fixture</p>\n", { mode: 0o600 });
  const bundle = async (entry: string, outfile: string, facade = false): Promise<void> => {
    await mkdir(dirname(outfile), { recursive: true, mode: 0o700 });
    await build({ entryPoints: [join(source, entry)], outfile, bundle: true, platform: "node", format: "esm", target: "node24",
      nodePaths: [join(root, "node_modules")], external: ["electron"], plugins: facade ? [{ name: "fixed-owned-facade", setup(builder) {
        builder.onResolve({ filter: /platforms\/linux\/shared\/bus\.js$/ }, () => ({ path: "file:///owned-app/dist/platforms/linux/shared/bus.js", external: true }));
      } }] : [] });
  };
  await bundle("tests/owned-bus-opening/parent.ts", join(parent, "main.mjs"));
  await bundle("tests/owned-bus-opening/driver.ts", join(payload, "driver.mjs"));
  await bundle("tests/owned-bus-opening/entry.ts", join(payload, "tests/owned-bus-opening/entry.mjs"), true);
  await bundle("tests/owned-bus/entry.ts", join(payload, "tests/owned-bus/entry.mjs"), true);
  await bundle("src/platforms/linux/shared/bus.ts", join(payload, "dist/platforms/linux/shared/bus.js"));
  await cp(join(source, "tests/owned-bus/service.cpp"), join(payload, "tests/owned-bus/service.cpp"));
  await writeFile(join(payload, "package.json"), JSON.stringify({ name: "openwhisper-owned-bus-opening-fixture", private: true, type: "module" }), { mode: 0o600 });
  sameHashes(await tree(source), sourceHashes);
  const value = packageSchema.parse({ version: 1, image: IMAGE, runtime: RUNTIME_SHA, header: HEADER_SHA, seccomp: SECCOMP_SHA,
    source: sourceHashes, payload: await tree(payload), node: "24.21.0", electron: "44.7.0", napi: 8 });
  await writeFile(join(output, "manifest.json"), JSON.stringify(value, null, 2), { mode: 0o600 });
  await writeFile(join(output, "prepare-result.json"), JSON.stringify({ result: "PASS", commands: commands.records, nativeBuilt: false,
    runtimeExecuted: false, imageReproductionRecipe: "source/tests/owned-bus/Dockerfile", runtimeArchiveSha256: RUNTIME_ARCHIVE_SHA,
    scope: "Checksummed input copies, archive extraction and strict TypeScript fixture bundles only." }, null, 2), { mode: 0o600 });
}

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fileSha256, nativeTool, pinnedNativeSource } from "./native-dependencies.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const headersSchema = z.strictObject({ version: z.literal("24.21.0"), napiVersion: z.literal(8),
  sha256: z.literal("57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2"),
  source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt") });
const licenseSchema = z.strictObject({ version: z.literal("24.21.0"),
  source: z.literal("https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE"),
  sha256: z.literal("5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace"), scope: z.string() });

/** Closed build roles; the historical probe remains the default target. */
export function macRetirementBuildLayout(production: boolean): Readonly<{ target: string; directory: string; notices: string; args: readonly string[] }> {
  return Object.freeze({ target: production ? "openwhisper_macos_retirement" : "openwhisper_macos_retirement_probe",
    directory: production ? "build-production" : "build", notices: production ? "macos-retirement-notices" : "macos-retirement-probe-notices",
    args: Object.freeze(production ? ["--target", "openwhisper_macos_retirement", "--parallel", "2"] : ["--parallel", "2"]) });
}
export function validateMacProductionCompileCommands(input: unknown, source: string, output: string): void {
  const commands = z.array(z.object({ directory: z.string(), command: z.string(), file: z.string(), output: z.string().optional() })).parse(input);
  const own = commands.filter((item) => item.file === source && item.directory === output &&
    /CMakeFiles\/openwhisper_macos_retirement\.dir\//u.test(item.command));
  if (own.length !== 1 || !/(?:^|\s)-DOPENWHISPER_RETIREMENT_PRODUCTION=1(?:\s|$)/u.test(own[0]?.command ?? "") ||
    !/(?:^|\s)-DNAPI_VERSION=8(?:\s|$)/u.test(own[0]?.command ?? "") ||
    /-DOPENWHISPER_RETIREMENT_PROBE(?:=|\s)/u.test(own[0]?.command ?? "")) throw new Error("Production retirement compile role did not match.");
}

/** Apple SDK build only. Never loads either role or queries a process. */
async function buildMacRetirement(production: boolean): Promise<void> {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error(production ?
    "The production retirement build requires an Apple runner." : "The retirement probe build requires an Apple runner.");
  const headers = headersSchema.parse(JSON.parse(await readFile(join(root, "native/node-headers.json"), "utf8")));
  const license = licenseSchema.parse(JSON.parse(await readFile(join(root, "native/node-header-license.json"), "utf8")));
  if (await fileSha256(join(root, "native/NODE-HEADERS-LICENSE")) !== license.sha256) throw new Error("Pinned header license did not match.");
  const node = join(root, "vendor/node-headers");
  await pinnedNativeSource(`https://nodejs.org/download/release/v${headers.version}/node-v${headers.version}-headers.tar.gz`, headers.sha256, node);
  const layout = macRetirementBuildLayout(production);
  const inputs = ["native/macos-retirement/CMakeLists.txt", "native/macos-retirement/retirement.cpp", "scripts/build-macos-retirement.ts",
    ...(production ? ["scripts/build-macos-retirement-production.ts"] : []),
    "scripts/native-dependencies.ts", "native/node-headers.json", "native/node-header-license.json", "native/NODE-HEADERS-LICENSE",
    ...["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"].map((name) => `vendor/node-headers/include/node/${name}`)];
  const sourceHashes: Record<string, string> = {};
  for (const name of inputs) sourceHashes[name] = await fileSha256(join(root, name));
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  const output = join(root, "native/macos-retirement", layout.directory, architecture);
  const sdk = (await nativeTool("xcrun", ["--sdk", "macosx", "--show-sdk-path"], root, 30000)).trim();
  const sdkVersion = (await nativeTool("xcrun", ["--sdk", "macosx", "--show-sdk-version"], root, 30000)).trim();
  const compiler = (await nativeTool("xcrun", ["clang++", "--version"], root, 30000)).trim();
  await nativeTool("cmake", ["-S", join(root, "native/macos-retirement"), "-B", output, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0", `-DCMAKE_OSX_ARCHITECTURES=${architecture}`, `-DCMAKE_OSX_SYSROOT=${sdk}`,
    `-DNODE_HEADERS=${join(node, "include/node")}`, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"], root);
  await nativeTool("cmake", ["--build", output, ...layout.args], root);
  if (production) validateMacProductionCompileCommands(JSON.parse(await readFile(join(output, "compile_commands.json"), "utf8")),
    join(root, "native/macos-retirement/retirement.cpp"), output);
  const binding = join(output, `${layout.target}.node`);
  const macho = await nativeTool("otool", ["-l", binding], root, 30000);
  const dependencies = await nativeTool("otool", ["-L", binding], root, 30000);
  const arch = (await nativeTool("lipo", ["-archs", binding], root, 30000)).trim();
  if (arch !== architecture || !/\bminos 14\.0\b/u.test(macho)) throw new Error("Retirement architecture/minOS metadata did not match.");
  for (const name of inputs) if (await fileSha256(join(root, name)) !== sourceHashes[name]) throw new Error("Retirement source changed during compilation.");
  await writeFile(join(output, "build-manifest.json"), JSON.stringify({ version: 1, platform: "darwin", architecture, minimumOS: "14.0", napiVersion: 8,
    ...(production ? { role: "production", target: layout.target, probeOnly: false, mainOnly: true, workerSyntheticOnly: false,
      exports: ["create", "bindCandidate", "observe", "close", "abi"] } : { probeOnly: true, mainOnlyKernel: true, workerSyntheticOnly: true }),
    zombieLookupArgument: 1, headers, license, sourceHashes,
    bindingSha256: await fileSha256(binding), sdk, sdkVersion, compiler, macho, dependencies,
    scope: production ? "Distinct production native role build only; no production loader/catalog/factory, audio/TCC or signed package acceptance." :
      "Standalone public-SDK/lifetime probe only; no production admission, native factories, audio/TCC or signed package acceptance." }, null, 2));
  const destination = join(root, "dist/native", layout.notices);
  await mkdir(destination, { recursive: true });
  await cp(binding, join(root, "dist/native", `${layout.target}.node`));
  await cp(join(output, "build-manifest.json"), join(destination, "build-manifest.json"));
  await cp(join(root, "../LICENSE"), join(destination, "PROJECT-LICENSE"));
  await cp(join(root, "native/NODE-HEADERS-LICENSE"), join(destination, "NODE-HEADERS-LICENSE"));
  await cp(join(root, "native/node-header-license.json"), join(destination, "node-header-license.json"));
}
export async function buildMacRetirementProbe(): Promise<void> { await buildMacRetirement(false); }
export async function buildMacRetirementProduction(): Promise<void> { await buildMacRetirement(true); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildMacRetirementProbe();

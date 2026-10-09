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
  sha256: z.literal("5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace"),
  scope: z.string() });

/** Opt-in Apple build only. This function never loads the addon or accesses capture/permissions. */
export async function buildMacCapture(): Promise<void> {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("The macOS capture build requires an Apple runner.");
  const headers = headersSchema.parse(JSON.parse(await readFile(join(root, "native/node-headers.json"), "utf8")));
  const license = licenseSchema.parse(JSON.parse(await readFile(join(root, "native/macos-capture/node-header-license.json"), "utf8")));
  if (await fileSha256(join(root, "native/macos-capture/NODE-HEADERS-LICENSE")) !== license.sha256) throw new Error("Pinned header license snapshot did not match.");
  const node = join(root, "vendor/node-headers");
  await pinnedNativeSource(`https://nodejs.org/download/release/v${headers.version}/node-v${headers.version}-headers.tar.gz`, headers.sha256, node);
  const inputs = ["native/macos-capture/CMakeLists.txt", "native/macos-capture/capture.mm", "native/macos-capture/reference.mm",
    "scripts/build-macos-capture.ts", "scripts/native-dependencies.ts", "native/node-headers.json", "native/macos-capture/node-header-license.json",
    "native/macos-capture/NODE-HEADERS-LICENSE", ...["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"]
      .map((name) => `vendor/node-headers/include/node/${name}`)];
  const sourceHashes: Record<string, string> = {};
  for (const name of inputs) sourceHashes[name] = await fileSha256(join(root, name));
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  const output = join(root, "native/macos-capture/build", architecture);
  const sdk = (await nativeTool("xcrun", ["--sdk", "macosx", "--show-sdk-path"], root, 30000)).trim();
  const sdkVersion = (await nativeTool("xcrun", ["--sdk", "macosx", "--show-sdk-version"], root, 30000)).trim();
  const compiler = (await nativeTool("xcrun", ["clang++", "--version"], root, 30000)).trim();
  await nativeTool("cmake", ["-S", join(root, "native/macos-capture"), "-B", output, "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0", `-DCMAKE_OSX_ARCHITECTURES=${architecture}`,
    `-DCMAKE_OSX_SYSROOT=${sdk}`, `-DNODE_HEADERS=${join(node, "include/node")}`, "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON"], root);
  await nativeTool("cmake", ["--build", output, "--parallel", "2"], root);
  const binding = join(output, "openwhisper_macos_capture.node");
  const macho = await nativeTool("otool", ["-l", binding], root, 30000);
  const dependencies = await nativeTool("otool", ["-L", binding], root, 30000);
  const arch = (await nativeTool("lipo", ["-archs", binding], root, 30000)).trim();
  if (arch !== architecture || !/\bminos 14\.0\b/u.test(macho)) throw new Error("Native capture architecture/minOS metadata did not match.");
  for (const name of inputs) {
    if (await fileSha256(join(root, name)) !== sourceHashes[name]) throw new Error("Mac capture input changed while compiling.");
  }
  await writeFile(join(output, "build-manifest.json"), JSON.stringify({ version: 1, backend: "avfoundation", platform: "darwin",
    architecture, minimumOS: "14.0", napiVersion: 8, headers, license, sourceHashes, bindingSha256: await fileSha256(binding),
    sdk, sdkVersion, compiler, macho, dependencies, scope: "Build only; synthetic load/conversion and physical permission/device acceptance are separate." }, null, 2));
  const destination = join(root, "dist/native/macos-capture-notices");
  await mkdir(destination, { recursive: true });
  await cp(binding, join(root, "dist/native/openwhisper_macos_capture.node"));
  await cp(join(output, "build-manifest.json"), join(destination, "build-manifest.json"));
  await cp(join(root, "../LICENSE"), join(destination, "PROJECT-LICENSE"));
  await cp(join(root, "native/macos-capture/NODE-HEADERS-LICENSE"), join(destination, "NODE-HEADERS-LICENSE"));
  await cp(join(root, "native/macos-capture/node-header-license.json"), join(destination, "node-header-license.json"));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildMacCapture();

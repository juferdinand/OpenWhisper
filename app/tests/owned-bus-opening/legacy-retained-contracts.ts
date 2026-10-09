import { z } from "zod";
import { packageSchema, sameHashes } from "./launch-contracts.js";
import { remainingPackageSchema, serviceCompileArguments, SERVICE_SOURCE_SHA, validateServiceMetadata } from "./remaining-contracts.js";
import { retainedPinsSchema, RETAINED_SHA } from "./retained-contracts.js";

export const LEGACY_BASE_SHA = "7d0dc46f07430549066d86eec26de951ee40bde2138f99c1acb4f24bdb8f7233";
export const SERVICE_SHA = "3cd4dd127f233db34295adab0b96d85f71606a326425fda1f822f432df7a16f5";
export const SERVICE_MANIFEST_SHA = "b04fbaf4a68a284d6659d8ad377ba2f30598f92c751145fa92b5c8fbdce2e9a8";
export const serviceProofHashes = Object.freeze({
  "original-manifest.json": SERVICE_MANIFEST_SHA,
  "service-provenance.json": "f3ea868f3a71cfbd7f35333f2ac82c6b647ab5af411c336a3eaa9b913b15af28",
  "compiler.txt": "cc595f478202ca6bcb060ad5e59018499dcd4f81667c244a91dd781b49b2429b",
  "compiler-binary.sha256": "ce748358505cc1599e7f9cd095c1e0acc707f37aafa1a6bc2d20d1670795318b",
  "gio-version.txt": "adb85518e6c3646657d582f812db78525a4d011cb547f106cb5a71cbae3aa656",
  "service-elf-header.txt": "ba95e08f88cf9ba13b3de22a86135a9f9271f3e21bbb23771f3b982559af7016",
  "service-elf-dynamic.txt": "6df0a714c0d30ac6c8055e00bc7e5413c188af8346ad387176f72bf185b01328",
  "service-elf-versions.txt": "30f58573c6acbf731f9794e2ef9dc967bc38bccdfff109d926254e883298d8e3",
  "service-elf-notes.txt": "abe313e11f5b19ccf7a634889f646ab9b4d48d404d348668e76f3b35f9a03c98",
  "service-elf-symbols.txt": "8346822764194386af1105e2d93314959aa974e28f251ce66b6484e2b6cd56c7",
  "distro-packages.txt": "942c5c0c7ef7a78bbbd4d6e9e2c80b44b41e4180e05a88e92ac24e169860350b",
  "installed-gio-copyright": "607a2dbcf41b82733bc93345da5470995a7f80515774fbabc4689158fae956c2",
});
const proofShape = {
  binary: z.literal(SERVICE_SHA), manifest: z.literal(SERVICE_MANIFEST_SHA),
  provenance: z.literal(serviceProofHashes["service-provenance.json"]), source: z.literal(SERVICE_SOURCE_SHA),
};
export const serviceReuseSchema = z.strictObject(proofShape);
export const legacyPackageSchema = packageSchema.extend({ mode: z.literal("retained-legacy-diagnostic"), retained: retainedPinsSchema,
  service: serviceReuseSchema, profiles: z.tuple([z.literal("legacy")]), legacyBase: z.literal(LEGACY_BASE_SHA) });
export function validateServiceReuse(pins: unknown, proofFiles: Readonly<Record<string, string>>, provenance: unknown,
  originalManifest: unknown, metadata: Readonly<Record<string, string>>): void {
  serviceReuseSchema.parse(pins); sameHashes(proofFiles, serviceProofHashes);
  const original = remainingPackageSchema.parse(originalManifest);
  if (original.source["tests/owned-bus/service.cpp"] !== SERVICE_SOURCE_SHA || original.source["tests/owned-bus/entry.ts"] !== LEGACY_BASE_SHA) throw new Error("Original service source differs.");
  const parsed = z.strictObject({ serviceHash: z.literal(SERVICE_SHA), sourceHash: z.literal(SERVICE_SOURCE_SHA),
    compileArgv: z.array(z.string().max(256)).max(32), manifest: remainingPackageSchema,
    abi: z.record(z.enum(["GLIBC", "GLIBCXX", "CXXABI"]), z.array(z.string().max(32)).max(16)),
    nativeHash: z.literal(RETAINED_SHA), nativeBuilt: z.literal(false),
    scope: z.literal("New test service only, fixed Ubuntu22 image/compiler/GIO as UID1000; unchanged retained Node-API addon.") }).parse(provenance);
  if (JSON.stringify(parsed.manifest) !== JSON.stringify(original)) throw new Error("Original service compile manifest differs.");
  const compile = serviceCompileArguments(parsed.compileArgv.slice(8).join(" "));
  if (JSON.stringify(parsed.compileArgv) !== JSON.stringify(compile)) throw new Error("Original service compiler argv differs.");
  if (JSON.stringify(parsed.abi) !== JSON.stringify(validateServiceMetadata(metadata))) throw new Error("Original service ABI evidence differs.");
}
export function legacyCommandPlan(): readonly (readonly string[])[] {
  return [["sha256sum", "/owned-app/dist/native/openwhisper_linux_bus.node", "/owned-app/tests/owned-bus/service"],
    ["OPENWHISPER_OWNED_BUS_OPENING_DRIVER=1", "/opt/node/bin/node", "/owned-app/driver.mjs", "legacy"],
    ["sha256sum", "/owned-app/dist/native/openwhisper_linux_bus.node", "/owned-app/tests/owned-bus/service"]];
}
export function validateArtifactHashOutput(value: unknown): void {
  z.literal(`${RETAINED_SHA}  /owned-app/dist/native/openwhisper_linux_bus.node\n${SERVICE_SHA}  /owned-app/tests/owned-bus/service`).parse(value);
}
/** Explicit inserted markers are removable; all original assertion bytes remain. */
export function stripLegacyDiagnostics(source: string): string {
  return source.replace(/\/\* owned-legacy-diagnostic \*\/[\s\S]*?\/\* end-owned-legacy-diagnostic \*\//gu, "");
}

/** The diagnostic can only reuse the independently frozen failed-run artifact. */
import { z } from "zod";
import { frozenCore, packageSchema } from "./launch-contracts.js";

export const RETAINED_SHA = "fa2261553121de7817a222c7d172f9431d0a49bd5ace90e443de24a63988d324";
export const RETAINED_MANIFEST_SHA = "703331d891ffbb210303106c10c403882b45767481512375be5cfbb002b395a1";
export const RETAINED_PROVENANCE_SHA = "bfe1d4b7fb41948074bb7aa27930007dd8a5824611a83ea85aa7759ea195fb9d";
export const retainedPinsSchema = z.strictObject({ native: z.literal(RETAINED_SHA),
  manifest: z.literal(RETAINED_MANIFEST_SHA), provenance: z.literal(RETAINED_PROVENANCE_SHA) });
export const diagnosticPackageSchema = packageSchema.extend({
  mode: z.literal("retained-opening-diagnostic"), retained: retainedPinsSchema,
});
export function validateRetainedProvenance(pins: unknown, provenance: unknown): void {
  retainedPinsSchema.parse(pins);
  const parsed = z.object({ nativeHash: z.literal(RETAINED_SHA), manifest: packageSchema }).parse(provenance);
  // Only production and the unchanged mechanical scenario are provenance
  // prerequisites. Diagnostic TS entry/launcher bytes intentionally differ.
  for (const path of ["native/linux-bus/binding.cpp", "native/linux-bus/CMakeLists.txt", "native/linux-bus/codec.cpp",
    "native/linux-bus/codec.hpp", "src/platforms/linux/shared/bus.ts", "src/platforms/linux/shared/bus-values.ts",
    "tests/owned-bus-opening/scenarios.ts"]) {
    if (parsed.manifest.source[path] !== frozenCore[path]) throw new Error("Retained native source provenance differs.");
  }
}
/** The finite diagnostic plan has no compiler, service build or later profile. */
export function diagnosticCommandPlan(): readonly (readonly string[])[] {
  return [
    ["sha256sum", "/owned-app/dist/native/openwhisper_linux_bus.node"],
    ["OPENWHISPER_OWNED_BUS_OPENING_DRIVER=1", "/opt/node/bin/node", "/owned-app/driver.mjs", "opening"],
    ["sha256sum", "/owned-app/dist/native/openwhisper_linux_bus.node"],
  ];
}

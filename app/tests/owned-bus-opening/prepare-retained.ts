import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diagnosticPackageSchema, validateRetainedProvenance } from "./retained-contracts.js";
import { hash, tree } from "./launch-io.js";
import { prepare } from "./prepare.js";

/** Inert copy/TypeScript bundling only; no compiler, bus or Electron execution. */
export async function prepareRetained(output: string, headers: string, seccomp: string, original: string): Promise<void> {
  const addon = join(original, "artifacts/openwhisper_linux_bus.node"), provenance = join(original, "artifacts/native-provenance.json");
  const pins = { native: await hash(addon), manifest: await hash(join(original, "manifest.json")), provenance: await hash(provenance) };
  validateRetainedProvenance(pins, JSON.parse(await readFile(provenance, "utf8")));
  await prepare(output, headers, seccomp);
  const retained = join(output, "retained"), native = join(output, "payload/dist/native");
  await mkdir(retained, { mode: 0o700 }); await mkdir(native, { mode: 0o700 });
  await cp(addon, join(native, "openwhisper_linux_bus.node"));
  await cp(join(original, "manifest.json"), join(retained, "original-manifest.json"));
  await cp(provenance, join(retained, "native-provenance.json"));
  const copied = { native: await hash(join(native, "openwhisper_linux_bus.node")),
    manifest: await hash(join(retained, "original-manifest.json")), provenance: await hash(join(retained, "native-provenance.json")) };
  validateRetainedProvenance(copied, JSON.parse(await readFile(join(retained, "native-provenance.json"), "utf8")));
  validateRetainedProvenance({ native: await hash(addon), manifest: await hash(join(original, "manifest.json")), provenance: await hash(provenance) },
    JSON.parse(await readFile(provenance, "utf8")));
  const base: unknown = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  const manifest = diagnosticPackageSchema.parse({ ...diagnosticPackageSchema.omit({ mode: true, retained: true }).parse(base),
    payload: await tree(join(output, "payload")), mode: "retained-opening-diagnostic", retained: copied });
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(join(output, "retained-prepare-result.json"), JSON.stringify({ result: "PASS", nativeBuilt: false,
    runtimeExecuted: false, originalPackage: original, retained: copied, scope: "Source-only TS diagnostic bundles and exact frozen failed-run ELF copy." }, null, 2), { mode: 0o600 });
}

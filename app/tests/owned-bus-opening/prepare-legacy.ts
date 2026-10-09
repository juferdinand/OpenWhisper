import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash, tree } from "./launch-io.js";
import { diagnosticPackageSchema } from "./retained-contracts.js";
import { prepareRetained } from "./prepare-retained.js";
import { legacyPackageSchema, LEGACY_BASE_SHA, serviceProofHashes, SERVICE_MANIFEST_SHA, SERVICE_SHA,
  stripLegacyDiagnostics, validateServiceReuse } from "./legacy-retained-contracts.js";
import { SERVICE_SOURCE_SHA } from "./remaining-contracts.js";

/** Inert bundles and exact two-ELF reuse; no compiler, native load or runtime. */
export async function prepareLegacy(output: string, headers: string, seccomp: string, nativeOriginal: string, serviceOriginal: string): Promise<void> {
  await prepareRetained(output, headers, seccomp, nativeOriginal);
  const base = diagnosticPackageSchema.parse(JSON.parse(await readFile(join(output, "manifest.json"), "utf8")));
  const entry = await readFile(join(output, "source/tests/owned-bus/entry.ts"), "utf8");
  if (createHash("sha256").update(stripLegacyDiagnostics(entry)).digest("hex") !== LEGACY_BASE_SHA) throw new Error("Non-diagnostic legacy source changed.");
  const proofs = join(output, "retained-service"); await mkdir(proofs, { mode: 0o700 });
  for (const [name, expected] of Object.entries(serviceProofHashes)) {
    const source = name === "original-manifest.json" ? join(serviceOriginal, "manifest.json") : join(serviceOriginal, "artifacts", name);
    if (await hash(source) !== expected) throw new Error("Original service proof differs.");
    await cp(source, join(proofs, name));
    if (await hash(join(proofs, name)) !== expected || await hash(source) !== expected) throw new Error("Service proof changed during copy.");
  }
  const source = join(serviceOriginal, "artifacts/owned-test-service"), target = join(output, "payload/tests/owned-bus/service");
  if (await hash(source) !== SERVICE_SHA) throw new Error("Retained test service differs.");
  await cp(source, target);
  if (await hash(source) !== SERVICE_SHA || await hash(target) !== SERVICE_SHA) throw new Error("Retained test service changed during copy.");
  const metadata: Record<string, string> = {};
  for (const name of Object.keys(serviceProofHashes)) metadata[name] = await readFile(join(proofs, name), "utf8");
  const pins = { binary: await hash(target), manifest: SERVICE_MANIFEST_SHA,
    provenance: serviceProofHashes["service-provenance.json"], source: SERVICE_SOURCE_SHA };
  validateServiceReuse(pins, await tree(proofs), JSON.parse(metadata["service-provenance.json"] ?? ""),
    JSON.parse(metadata["original-manifest.json"] ?? ""), metadata);
  const manifest = legacyPackageSchema.parse({ ...base,
    mode: "retained-legacy-diagnostic", service: pins, profiles: ["legacy"], legacyBase: LEGACY_BASE_SHA, payload: await tree(join(output, "payload")) });
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(join(output, "legacy-prepare-result.json"), JSON.stringify({ result: "PASS", nativeBuilt: false, serviceBuilt: false,
    runtimeExecuted: false, retained: manifest.retained, service: pins,
    scope: "Source-only bundles, exact retained addon and previously proven test service plus intact original compile receipts; no new native or service compilation." }, null, 2), { mode: 0o600 });
}

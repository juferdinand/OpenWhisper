import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "./launch-io.js";
import { diagnosticPackageSchema } from "./retained-contracts.js";
import { prepareRetained } from "./prepare-retained.js";
import { remainingPackageSchema, remainingProfiles, SERVICE_SOURCE_SHA } from "./remaining-contracts.js";

/** Copies and bundles only. The separate test service is NOT compiled here. */
export async function prepareRemaining(output: string, headers: string, seccomp: string, original: string): Promise<void> {
  await prepareRetained(output, headers, seccomp, original);
  const base = diagnosticPackageSchema.parse(JSON.parse(await readFile(join(output, "manifest.json"), "utf8")));
  if (await hash(join(output, "payload/tests/owned-bus/service.cpp")) !== SERVICE_SOURCE_SHA) throw new Error("Fixed service source changed.");
  const manifest = remainingPackageSchema.parse({ ...base, mode: "retained-remaining-profiles", profiles: remainingProfiles, serviceSource: SERVICE_SOURCE_SHA });
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(join(output, "remaining-prepare-result.json"), JSON.stringify({ result: "PASS", nativeBuilt: false,
    serviceBuilt: false, runtimeExecuted: false, retained: manifest.retained, profiles: manifest.profiles,
    scope: "Inert exact retained-addon copy, source snapshots and TypeScript bundles; service-only compile awaits execution approval." }, null, 2), { mode: 0o600 });
}

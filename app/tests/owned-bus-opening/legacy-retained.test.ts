import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { IMAGE, HEADER_SHA, oldChecks, RUNTIME_SHA, SECCOMP_SHA } from "./launch-contracts.js";
import { retainedPinsSchema, RETAINED_SHA, RETAINED_MANIFEST_SHA, RETAINED_PROVENANCE_SHA } from "./retained-contracts.js";
import { remainingPackageSchema, serviceCompileArguments, SERVICE_SOURCE_SHA } from "./remaining-contracts.js";
import { legacyCommandPlan, legacyPackageSchema, LEGACY_BASE_SHA, SERVICE_MANIFEST_SHA, SERVICE_SHA, serviceProofHashes,
  stripLegacyDiagnostics, validateArtifactHashOutput, validateServiceReuse } from "./legacy-retained-contracts.js";
import { parseLegacyArguments } from "./run-legacy.js";

const retained = retainedPinsSchema.parse({ native: RETAINED_SHA, manifest: RETAINED_MANIFEST_SHA, provenance: RETAINED_PROVENANCE_SHA });
const pins = { binary: SERVICE_SHA, source: SERVICE_SOURCE_SHA, manifest: SERVICE_MANIFEST_SHA, provenance: serviceProofHashes["service-provenance.json"] };
const base = { version: 1, image: IMAGE, runtime: RUNTIME_SHA, header: HEADER_SHA, seccomp: SECCOMP_SHA,
  source: { "tests/owned-bus/service.cpp": SERVICE_SOURCE_SHA, "tests/owned-bus/entry.ts": LEGACY_BASE_SHA }, payload: {}, node: "24.21.0", electron: "44.7.0", napi: 8 };
const original = remainingPackageSchema.parse({ ...base, mode: "retained-remaining-profiles", retained, profiles: ["cleanup", "legacy"], serviceSource: SERVICE_SOURCE_SHA });
const flags = "-I/usr/include/glib-2.0 -I/usr/lib/x86_64-linux-gnu/glib-2.0/include -pthread -I/usr/include/libmount -I/usr/include/blkid -I/usr/include/gio-unix-2.0 -lgio-2.0 -lgobject-2.0 -lglib-2.0";
const metadata = { "compiler.txt": "c++ (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0", "gio-version.txt": "2.72.4",
  "service-elf-header.txt": "ELF64 Advanced Micro Devices X86-64", "service-elf-symbols.txt": "g_dbus_connection_call_sync",
  "service-elf-dynamic.txt": "(NEEDED) [libgio-2.0.so.0]", "service-elf-versions.txt": "GLIBC_2.34 GLIBCXX_3.4.29 CXXABI_1.3.9" };
const provenance = { serviceHash: SERVICE_SHA, sourceHash: SERVICE_SOURCE_SHA, compileArgv: serviceCompileArguments(flags), manifest: original,
  abi: { GLIBC: ["2.34"], GLIBCXX: ["3.4.29"], CXXABI: ["1.3.9"] }, nativeHash: RETAINED_SHA, nativeBuilt: false,
  scope: "New test service only, fixed Ubuntu22 image/compiler/GIO as UID1000; unchanged retained Node-API addon." };

test("service reuse retains original source/compiler/ABI/manifest proof and refuses changed provenance", () => {
  validateServiceReuse(pins, serviceProofHashes, provenance, original, metadata);
  for (const bad of [{ ...pins, binary: "a".repeat(64) }, { ...pins, manifest: "a".repeat(64) }, { ...pins, source: "a".repeat(64) }]) assert.throws(() => validateServiceReuse(bad, serviceProofHashes, provenance, original, metadata));
  assert.throws(() => validateServiceReuse(pins, { ...serviceProofHashes, "compiler.txt": "a".repeat(64) }, provenance, original, metadata));
  for (const changed of [{ ...provenance, compileArgv: ["/host/c++", ...provenance.compileArgv.slice(1)] },
    { ...provenance, compileArgv: [...provenance.compileArgv, "binding.cpp"] }, { ...provenance, nativeBuilt: true },
    { ...provenance, manifest: { ...original, source: {} } }, { ...provenance, abi: { ...provenance.abi, GLIBC: ["2.43"] } }]) {
    assert.throws(() => validateServiceReuse(pins, serviceProofHashes, changed, original, metadata));
  }
  assert.throws(() => validateServiceReuse(pins, serviceProofHashes, provenance, original, { ...metadata, "compiler.txt": "host" }));
});
test("legacy-only package rejects other profiles, compiler flags and changed prior source", () => {
  const value = { ...base, mode: "retained-legacy-diagnostic", retained, service: pins, profiles: ["legacy"], legacyBase: LEGACY_BASE_SHA };
  legacyPackageSchema.parse(value);
  for (const bad of [{ ...value, profiles: ["cleanup", "legacy"] }, { ...value, profiles: ["opening"] }, { ...value, compile: true },
    { ...value, legacyBase: "a".repeat(64) }, { ...value, service: { ...pins, binary: "a".repeat(64) } }]) assert.equal(legacyPackageSchema.safeParse(bad).success, false);
});
test("legacy execution plan has one fixed profile and hashes both reused binaries without compile or download", () => {
  const plan = legacyCommandPlan(); assert.equal(plan.length, 3); assert.equal(plan[1]?.at(-1), "legacy");
  assert.equal(plan.flat().some((item) => /(?:c\+\+|cmake|ninja|headers|curl|wget|tar)/u.test(item)), false);
  const output = `${RETAINED_SHA}  /owned-app/dist/native/openwhisper_linux_bus.node\n${SERVICE_SHA}  /owned-app/tests/owned-bus/service`;
  validateArtifactHashOutput(output);
  for (const bad of [output.replace(SERVICE_SHA, "a".repeat(64)), output + "\nextra", output.replace("/owned-app/tests/owned-bus/service", "/other")]) assert.throws(() => validateArtifactHashOutput(bad));
});
test("diagnostic reverse-delta exactly restores original 7d source and all19 assertions and names", async () => {
  const source = await readFile(new URL("../owned-bus/entry.ts", import.meta.url), "utf8");
  const reversed = stripLegacyDiagnostics(source);
  assert.equal(createHash("sha256").update(reversed).digest("hex"), LEGACY_BASE_SHA);
  assert.deepEqual([...reversed.matchAll(/(?:checks: string\[\] = \[|checks\.push\()"([^"\n]+)"/gu)].map((match) => match[1]), oldChecks);
  const burst = source.slice(source.indexOf('const burst = bus.call'), source.indexOf('await burstRefused;'));
  assert.equal(burst.includes("diagnosis."), false);
  assert.equal(source.includes("error.message") || source.includes("error.stack"), false);
});
test("legacy parser requires both original artifacts for prepare and no appended execution flags", () => {
  assert.equal(parseLegacyArguments(["--prepare", "--output", "/new", "--headers", "/h", "--seccomp", "/s", "--retained", "/native", "--service", "/service"]).mode, "prepare");
  assert.equal(parseLegacyArguments(["--execute", "--package", "/reviewed"]).mode, "execute");
  for (const bad of [[], ["--execute", "--package", "/reviewed", "--compile"], ["--execute", "--package", "/reviewed", "--profile", "cleanup"],
    ["--prepare", "--output", "/new", "--headers", "/h", "--seccomp", "/s", "--retained", "/native"]]) assert.throws(() => parseLegacyArguments(bad));
});

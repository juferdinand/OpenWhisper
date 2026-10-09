import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { oldChecks, packageSchema, IMAGE, HEADER_SHA, RUNTIME_SHA, SECCOMP_SHA } from "./launch-contracts.js";
import { safeFailure } from "./diagnostics.js";
import { RETAINED_SHA, RETAINED_MANIFEST_SHA, RETAINED_PROVENANCE_SHA } from "./retained-contracts.js";
import { foreignCommand, remainingPackageSchema, runRemainingProfiles, serviceCompileArguments, SERVICE_BINARY,
  SERVICE_SOURCE, SERVICE_SOURCE_SHA, validateForeignReply, validateServiceMetadata } from "./remaining-contracts.js";
import { parseRemainingArguments } from "./run-remaining.js";

const flags = "-I/usr/include/glib-2.0 -I/usr/lib/x86_64-linux-gnu/glib-2.0/include -pthread -I/usr/include/libmount -I/usr/include/blkid -I/usr/include/gio-unix-2.0 -lgio-2.0 -lgobject-2.0 -lglib-2.0";
function manifest() {
  return { ...packageSchema.parse({ version: 1, image: IMAGE, runtime: RUNTIME_SHA, header: HEADER_SHA, seccomp: SECCOMP_SHA,
    source: {}, payload: {}, node: "24.21.0", electron: "44.7.0", napi: 8 }), mode: "retained-remaining-profiles",
    retained: { native: RETAINED_SHA, manifest: RETAINED_MANIFEST_SHA, provenance: RETAINED_PROVENANCE_SHA },
    profiles: ["cleanup", "legacy"], serviceSource: SERVICE_SOURCE_SHA };
}
test("remaining package refuses implicit opening, reordered profiles, unknown fields and changed proof", () => {
  remainingPackageSchema.parse(manifest());
  for (const value of [{ ...manifest(), profiles: ["opening", "cleanup", "legacy"] }, { ...manifest(), profiles: ["legacy", "cleanup"] },
    { ...manifest(), compileAddon: true }, { ...manifest(), serviceSource: "a".repeat(64) },
    { ...manifest(), retained: { ...manifest().retained, native: "a".repeat(64) } }, { ...manifest(), mode: "retained-opening-diagnostic" }]) {
    assert.equal(remainingPackageSchema.safeParse(value).success, false);
  }
});
test("service argv is a single fixed source and rejects compiler injection, alternate links and incomplete flags", () => {
  const argv = serviceCompileArguments(flags);
  assert.deepEqual(argv.slice(0, 8), ["/usr/bin/c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", SERVICE_SOURCE, "-o", SERVICE_BINARY]);
  assert.equal(argv.some((value) => value.endsWith(".node") || value.includes("binding.cpp") || value.includes("codec.cpp")), false);
  for (const bad of ["", flags + " -include /tmp/preload", flags + " -Wl,-rpath,/tmp", flags + " -lother", flags + " ; touch /tmp/escape",
    flags.replace("-lgio-2.0", "-lgobject-2.0"), flags.replace("-pthread", ""), "x".repeat(4097)]) assert.throws(() => serviceCompileArguments(bad));
});
test("service metadata distinguishes Ubuntu22 test executable from foreign compiler or runtime links", () => {
  const metadata = { "compiler.txt": "c++ (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0\nfixed installed notice", "gio-version.txt": "2.72.4",
    "service-elf-header.txt": "Class: ELF64 Machine: Advanced Micro Devices X86-64", "service-elf-symbols.txt": "U g_dbus_connection_call_sync",
    "service-elf-dynamic.txt": "(NEEDED) Shared library: [libgio-2.0.so.0]\n(NEEDED) Shared library: [libc.so.6]",
    "service-elf-versions.txt": "GLIBC_2.34 GLIBCXX_3.4.22 CXXABI_1.3.13" };
  validateServiceMetadata(metadata);
  for (const changed of [{ ...metadata, "compiler.txt": "c++ host future compiler" }, { ...metadata, "gio-version.txt": "other" },
    { ...metadata, "service-elf-header.txt": "ELF64 AArch64" }, { ...metadata, "service-elf-symbols.txt": "napi_register_module_v1" },
    { ...metadata, "service-elf-dynamic.txt": metadata["service-elf-dynamic.txt"] + "\n(RUNPATH) [/tmp]" },
    { ...metadata, "service-elf-dynamic.txt": "(NEEDED) [libother.so]" }, { ...metadata, "service-elf-versions.txt": "GLIBC_2.43 GLIBCXX_3.4.22 CXXABI_1.3.13" }]) {
    assert.throws(() => validateServiceMetadata(changed));
  }
});
test("fixed foreign probe uses original address unique owner and requires exact zero exit denial", () => {
  const marker = { address: "unix:path=/tmp/openwhisper-owned-bus,guid=" + "a".repeat(32), owner: ":1.42" };
  assert.deepEqual(foreignCommand(marker), [SERVICE_BINARY, marker.address, "foreign-control", ":1.42"]);
  for (const bad of [{ ...marker, address: "unix:path=/run/user/1000/bus" }, { ...marker, owner: "org.openwhisper.Owned.Test" },
    { ...marker, method: "Execute" }, { ...marker, address: marker.address + ";unix:path=/other" }]) assert.throws(() => foreignCommand(bad));
  validateForeignReply({ code: 0, stdout: "FOREIGN_UID_DENIED:1001", stderr: "" });
  for (const bad of [{ code: 7, stdout: "FOREIGN_UID_DENIED:1001", stderr: "" }, { code: 0, stdout: "some io.github.whisperfree.Error.Denied", stderr: "" },
    { code: 0, stdout: "FOREIGN_UID_DENIED:1000", stderr: "" }, { code: 0, stdout: "FOREIGN_UID_DENIED:1001", stderr: "extra" }]) assert.throws(() => validateForeignReply(bad));
});
test("remaining profiles run serially and never start old19 after cleanup refuses", async () => {
  const calls: string[] = []; let complete: (() => void) | undefined;
  const operation = runRemainingProfiles(async (profile) => { calls.push(profile); if (profile === "cleanup") await new Promise<void>((accept) => { complete = accept; }); });
  assert.deepEqual(calls, ["cleanup"]); assert.ok(complete); complete(); await operation;
  assert.deepEqual(calls, ["cleanup", "legacy"]);
  calls.length = 0;
  await assert.rejects(runRemainingProfiles(async (profile) => { calls.push(profile); throw new Error("owned refusal"); }));
  assert.deepEqual(calls, ["cleanup"]);
});
test("remaining parser has disjoint explicit preparation and execution without appended controls", () => {
  assert.equal(parseRemainingArguments(["--prepare", "--output", "/new", "--headers", "/headers", "--seccomp", "/seccomp", "--retained", "/old"]).mode, "prepare");
  assert.equal(parseRemainingArguments(["--execute", "--package", "/frozen"]).mode, "execute");
  for (const args of [[], ["--execute"], ["--execute", "--package", "/old", "--profile", "opening"], ["--execute", "--package", "/old", "--no-sandbox"],
    ["--prepare", "--output", "/new", "--headers", "/headers", "--seccomp", "/seccomp"]]) assert.throws(() => parseRemainingArguments(args));
});
test("legacy retains all exact check names and only finite failure metadata", async () => {
  const source = await readFile(new URL("../owned-bus/entry.ts", import.meta.url), "utf8");
  const names = [...source.matchAll(/(?:checks: string\[\] = \[|checks\.push\()"([^"\n]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(names, oldChecks);
  assert.ok(source.includes('JSON.stringify(safeFailure("SCENARIO", error))'));
  assert.equal(source.includes("error.message") || source.includes("error.stack"), false);
  const privateError = Object.assign(new Error("private assertion text"), { stack: "private payload stack", code: "UNKNOWN_PRIVATE" });
  const serialized = JSON.stringify(safeFailure("SCENARIO", privateError));
  assert.equal(serialized.includes("private") || serialized.includes("UNKNOWN_PRIVATE"), false);
});

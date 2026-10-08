import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestSchema, type BuildManifest } from "./acceptance.js";
import { EXPECTED_WITNESS_SHA256 } from "./contract.js";

const source = dirname(fileURLToPath(import.meta.url)), packageRoot = resolve(source, "../..");
async function described(path: string) {
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
  const bytes = await readFile(path); assert.equal(bytes.length, stat.size);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function sourceManifest() {
  const records: Record<string, Awaited<ReturnType<typeof described>>> = {};
  for (const name of (await readdir(source)).filter((name) => name.endsWith(".ts")).sort()) {
    records[`tests/owned-retirement/${name}`] = await described(join(source, name));
  }
  for (const name of ["src/services/process-retirement.ts", "src/services/profiles.ts", "package.json", "package-lock.json", "tsconfig.json"]) {
    records[name] = await described(join(packageRoot, name));
  }
  assert.equal(records["src/services/process-retirement.ts"]?.sha256, EXPECTED_WITNESS_SHA256);
  return records;
}
export async function buildOwnedRetirement(directory: string): Promise<BuildManifest> {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const before = await sourceManifest();
  for (const name of ["node-parent", "electron-parent", "child-entry", "utility-entry"]) {
    const result = await build({ entryPoints: [join(source, `${name}.ts`)], outfile: join(directory, `${name}.mjs`),
      bundle: true, platform: "node", format: "esm", target: "node24", external: ["electron", "original-fs"], metafile: true });
    await writeFile(join(directory, `${name}.metafile.json`), JSON.stringify(result.metafile, null, 2), { mode: 0o600 });
  }
  assert.deepEqual(await sourceManifest(), before, "Source changed while compiling the reviewed fixture.");
  const manifest = buildManifestSchema.parse({ version: 1, witnessSha256: EXPECTED_WITNESS_SHA256, sources: before,
    bundles: { "node-parent.mjs": await described(join(directory, "node-parent.mjs")),
      "electron-parent.mjs": await described(join(directory, "electron-parent.mjs")),
      "child-entry.mjs": await described(join(directory, "child-entry.mjs")), "utility-entry.mjs": await described(join(directory, "utility-entry.mjs")) },
    packages: { electron: "44.7.0", node: "24.21.0", zod: "4.6.5", typescript: "7.0.2", esbuild: "0.28.2" } });
  await writeFile(join(directory, "build-manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 }); return manifest;
}
export async function verifyBuiltSources(manifest: BuildManifest): Promise<void> { assert.deepEqual(await sourceManifest(), manifest.sources); }

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { FixtureError, IMAGE, NODE_ARCHIVE_SHA256, NODE_BINARY_SHA256, NODE_VERSION, inputSchema } from "./contracts.js";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const repositoryRoot = dirname(packageRoot);
const fixtureRoot = join(packageRoot, "tests/owned-model-download");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function files(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new FixtureError();
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
    else throw new FixtureError();
  }
  return output;
}
/** Compilation only: no fixture import, certificates, server or runtime. */
export async function buildFixture(output: string): Promise<void> {
  if (!isAbsolute(output) || resolve(output) !== output || output.includes("\0")) throw new FixtureError();
  await mkdir(output, { mode: 0o700 });
  const outputStats = await lstat(output);
  if (!outputStats.isDirectory() || outputStats.isSymbolicLink() || (outputStats.mode & 0o7777) !== 0o700) throw new FixtureError();
  const candidates = [...await files(join(packageRoot, "src")), ...await files(fixtureRoot),
    ...await files(join(packageRoot, "node_modules/zod")), join(packageRoot, "tests/owned-model-download.test.ts"),
    join(packageRoot, "package.json"), join(packageRoot, "package-lock.json"), join(packageRoot, "tsconfig.json"),
    join(repositoryRoot, "shared/models.json")];
  if (candidates.length > 3000) throw new FixtureError();
  const before = new Map<string, string>();
  for (const path of candidates.sort()) {
    const stats = await lstat(path); if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 8 * 1024 * 1024) throw new FixtureError();
    before.set(path, sha(await readFile(path)));
  }
  const compiled = await build({ absWorkingDir: packageRoot, entryPoints: [join(fixtureRoot, "fixture.ts")], outfile: "fixture.mjs",
    bundle: true, platform: "node", target: "node24", format: "esm", write: false, metafile: true, logLevel: "silent", sourcemap: false });
  const bytes = compiled.outputFiles?.[0]?.contents;
  if (!bytes || compiled.outputFiles?.length !== 1 || bytes.length > 4 * 1024 * 1024 || !compiled.metafile) throw new FixtureError();
  const consumed = new Set(Object.keys(compiled.metafile.inputs).map((path) => resolve(packageRoot, path)));
  for (const path of consumed) if (!before.has(path)) throw new FixtureError();
  for (const [path, digest] of before) if (sha(await readFile(path)) !== digest) throw new FixtureError();
  for (const path of candidates) {
    if (path.startsWith(fixtureRoot + "/") || path.endsWith("/owned-model-download.test.ts") ||
      path.endsWith("/package.json") || path.endsWith("/package-lock.json") || path.endsWith("/tsconfig.json")) consumed.add(path);
  }
  const catalog = await readFile(join(repositoryRoot, "shared/models.json")), license = await readFile(join(packageRoot, "node_modules/zod/LICENSE"));
  if (sha(catalog) !== before.get(join(repositoryRoot, "shared/models.json")) ||
    sha(license) !== before.get(join(packageRoot, "node_modules/zod/LICENSE"))) throw new FixtureError();
  consumed.add(join(repositoryRoot, "shared/models.json")); consumed.add(join(packageRoot, "node_modules/zod/LICENSE"));
  const sources: Record<string, string> = {};
  for (const path of [...consumed].sort()) {
    const digest = before.get(path); if (!digest) throw new FixtureError(); sources[relative(repositoryRoot, path)] = digest;
  }
  const input = inputSchema.parse({ version: 1, image: IMAGE, node: NODE_VERSION, nodeArchiveSha256: NODE_ARCHIVE_SHA256,
    nodeBinarySha256: NODE_BINARY_SHA256,
    fixtureSha256: sha(bytes), catalogSha256: sha(catalog), zodLicenseSha256: sha(license), sources,
    authoredLanguage: "TypeScript", runtimeReviewedSeparately: true });
  await writeFile(join(output, "fixture.mjs"), bytes, { mode: 0o600, flag: "wx" });
  await writeFile(join(output, "models.json"), catalog, { mode: 0o600, flag: "wx" });
  await writeFile(join(output, "LICENSE-zod"), license, { mode: 0o600, flag: "wx" });
  await writeFile(join(output, "input.json"), JSON.stringify(input, null, 2), { mode: 0o600, flag: "wx" });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw new FixtureError();
  await buildFixture(args[1]);
}

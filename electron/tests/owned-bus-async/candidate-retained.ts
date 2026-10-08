import { cp, chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hash, tree } from "../owned-bus-opening/launch-io.js";
import { sameHashes } from "../owned-bus-opening/launch-contracts.js";
import { candidatePackageSchema, validateCandidateArtifactHashes } from "./candidate-contracts.js";
import { prepareCandidate } from "./candidate-prepare.js";

export const candidateNativeSha = "0d32cffa96fb5255bb49ec95ca6404c30887b068bf159fdcc966b7ceb7d2d0e1";
export const nativeProofHashes = Object.freeze({
  "original-manifest.json": "3e929f42efd3c37938539d74aa6579000004a10d6c5457d6cd6cb9eb0810ee4a",
  "native-provenance.json": "7b7812850bc4c017bec801c3eca7529cecae4177ae13a17a3255ee9e788a59a1",
  "compile_commands.json": "280b0d96076a08f54d9de05c7d307dc0244c1190072e22904d38c5b9d20dcd7a",
  "CMakeCache.txt": "1a2c6e1ccd081a85339394767053767286c7e5df71877501656d735f30c0707d",
  "build.ninja": "34f9b274651fa87d3b2047f9ee55860c381f7a8e4fcefa69638b6c87ab2db92f",
  "compiler.txt": "cc595f478202ca6bcb060ad5e59018499dcd4f81667c244a91dd781b49b2429b",
  "compiler-binary.sha256": "ca9538aa56110dfb6b11c101579382ac4f45e12429db3da92549855222f0ed7a",
  "node-build-runtime.txt": "b5026427ea7bcc8a18fc1a01329a9501af2b3915acc609b01181b14e8d46bbee",
  "node-build-binary.sha256": "775432de82dad7ba3ed08f9f6a1d4bfaa3d4c5a3f80d8a7ee8d80e64230555bc",
  "header-files.sha256": "01dd34435bb2e29f665afed2873b4a9317e631d0a2190bebc0d20eb209def982",
  "native-inputs.sha256": "9140c1c57cdb4f023c347d16e4d2b4159d647b00bdd6ea4d2983c66b725ee8d8",
  "elf-header.txt": "2105175ce068347df2af260c08c660a5ac6f7c7c3d293364457535aef623ff11",
  "elf-dynamic.txt": "cb74c45ab1e06580d9a7b125ccb749fbea85143a06022d010da9cfb013060909",
  "elf-versions.txt": "6703cd8e7ec244b66d76c59ab5057ce3d07ae89d84898776d357a2837dd31d58",
  "elf-notes.txt": "87eba3208e52c7d73da4365b905598f7900692d7f25f417b50e8195cc8af1b9e",
  "elf-symbols.txt": "06b9f1cf058b00cfcef057fa1a3b2b00e65e37fd13ea2b2967fc9eea96675c1c",
  "gio-version.txt": "adb85518e6c3646657d582f812db78525a4d011cb547f106cb5a71cbae3aa656",
  "distro-packages.txt": "942c5c0c7ef7a78bbbd4d6e9e2c80b44b41e4180e05a88e92ac24e169860350b",
  "installed-gio-copyright": "607a2dbcf41b82733bc93345da5470995a7f80515774fbabc4689158fae956c2",
});
export const retainedCandidateSchema = candidatePackageSchema.extend({ mode: z.literal("retained-async-candidate-legacy"),
  profiles: z.tuple([z.literal("legacy")]), retained: z.strictObject({ native: z.literal(candidateNativeSha),
    manifest: z.literal(nativeProofHashes["original-manifest.json"]), provenance: z.literal(nativeProofHashes["native-provenance.json"]) }) });
export const traversalModes = Object.freeze([
  { path: ".", kind: "directory", mode: 0o701 }, { path: "tests", kind: "directory", mode: 0o701 },
  { path: "tests/owned-bus", kind: "directory", mode: 0o701 }, { path: "tests/owned-bus/service", kind: "file", mode: 0o755 },
  { path: "runtime", kind: "directory", mode: 0o755 },
  ...["native-linux-bus", "dist", "tests/owned-bus-opening", "tests/owned-bus-async"].map((path) => ({ path, kind: "directory", mode: 0o700 })),
]);
export function validateTraversalModes(value: unknown): void {
  const facts = z.array(z.strictObject({ path: z.string().max(128), kind: z.enum(["directory", "file"]),
    mode: z.number().int().min(0).max(0o7777), uid: z.literal(1000) })).length(traversalModes.length).parse(value);
  for (const [index, expected] of traversalModes.entries()) {
    const actual = facts[index]; if (!actual || actual.path !== expected.path || actual.kind !== expected.kind || actual.mode !== expected.mode) throw new Error("Fixed foreign traversal modes refused.");
  }
}
export async function checkTraversalModes(root: string): Promise<void> {
  const facts = await Promise.all(traversalModes.map(async ({ path }) => {
    const info = await lstat(join(root, path));
    return { path, uid: info.uid, mode: info.mode & 0o7777, kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" };
  })); validateTraversalModes(facts);
}
export function validateRetainedArtifact(value: unknown): void { validateCandidateArtifactHashes(value, candidateNativeSha); }
export async function validateCandidateReuse(directory: string): Promise<void> {
  z.literal(candidateNativeSha).parse(await hash(join(directory, "payload/dist/native/openwhisper_linux_bus.node")));
  sameHashes(await tree(join(directory, "retained-native")), nativeProofHashes);
}
const sources = ["candidate-retained.ts", "candidate-retained-execute.ts", "candidate-retained-run.ts", "candidate-retained.test.ts"];
/** Exact accepted build receipts and fixed service reuse; no compiler/native/runtime. */
export async function prepareRetainedCandidate(output: string, headers: string, seccomp: string, nativeOriginal: string, serviceOriginal: string): Promise<void> {
  await prepareCandidate(output, headers, seccomp, serviceOriginal);
  const base = candidatePackageSchema.parse(JSON.parse(await readFile(join(output, "manifest.json"), "utf8")));
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url))), source = join(output, "source"), payload = join(output, "payload");
  for (const name of sources) {
    const path = `tests/owned-bus-async/${name}`, original = join(root, path), destination = join(source, path), before = await hash(original);
    await cp(original, destination, { errorOnExist: true, force: false });
    if (await hash(original) !== before || await hash(destination) !== before) throw new Error("Retained runner source changed during copy.");
  }
  const proofs = join(output, "retained-native"); await mkdir(proofs, { mode: 0o700 });
  for (const [name, expected] of Object.entries(nativeProofHashes)) {
    const original = name === "original-manifest.json" ? join(nativeOriginal, "manifest.json") : join(nativeOriginal, "artifacts", name);
    if (await hash(original) !== expected) throw new Error("Original candidate proof differs.");
    await cp(original, join(proofs, name));
    if (await hash(original) !== expected || await hash(join(proofs, name)) !== expected) throw new Error("Candidate proof changed during copy.");
  }
  const original = join(nativeOriginal, "artifacts/openwhisper_linux_bus.node"), destination = join(payload, "dist/native/openwhisper_linux_bus.node");
  if (await hash(original) !== candidateNativeSha) throw new Error("Accepted candidate ELF differs.");
  await mkdir(dirname(destination), { mode: 0o700 }); await cp(original, destination);
  await validateCandidateReuse(output);
  for (const path of [".", "tests", "tests/owned-bus"]) await chmod(join(payload, path), 0o701);
  await checkTraversalModes(payload);
  const manifest = retainedCandidateSchema.parse({ ...base, mode: "retained-async-candidate-legacy", profiles: ["legacy"],
    retained: { native: candidateNativeSha, manifest: nativeProofHashes["original-manifest.json"], provenance: nativeProofHashes["native-provenance.json"] },
    source: await tree(source), payload: await tree(payload) });
  // Copy the fixed directory name, including its mode, rather than only its contents.
  const archiveRoot = join(output, "container-root"); await mkdir(archiveRoot, { mode: 0o700 });
  await cp(payload, join(archiveRoot, "owned-app"), { recursive: true, errorOnExist: true, force: false });
  sameHashes(await tree(join(archiveRoot, "owned-app")), manifest.payload); await checkTraversalModes(join(archiveRoot, "owned-app"));
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFile(join(output, "retained-prepare-result.json"), JSON.stringify({ result: "PASS", nativeBuilt: false, serviceBuilt: false, runtimeExecuted: false,
    retained: manifest.retained, traversalDirectories: [".", "tests", "tests/owned-bus"], directoryMode: "0701", scope: "Legacy-only retained candidate; exact public-service traversal, all private siblings unchanged." }, null, 2), { mode: 0o600 });
}

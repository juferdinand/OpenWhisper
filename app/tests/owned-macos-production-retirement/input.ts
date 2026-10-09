import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { buildManifestSchema, digest, distributionNames, inputSchema, payloadNames, sourceNames } from "./contracts.js";
import type { FixtureInput } from "./contracts.js";

export async function checkedBytes(path: string): Promise<Buffer> {
  const file = await lstat(path);
  if (!isAbsolute(path) || !file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() ||
    (file.mode & 0o022) !== 0 || await realpath(path) !== resolve(path) || file.size > 16 * 1024 * 1024) throw new Error("INPUT_REFUSED");
  return readFile(path);
}
export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export async function nodeExecutableHash(path: string): Promise<string> {
  const file = await lstat(path);
  if (!isAbsolute(path) || !file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() && file.uid !== 0 ||
    (file.mode & 0o022) !== 0 || await realpath(path) !== resolve(path) || file.size > 256 * 1024 * 1024 || (file.mode & 0o111) === 0)
    throw new Error("NODE_REFUSED");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
}
export async function captureNodeExecutable(): Promise<FixtureInput["nodeExecutable"]> {
  if (process.versions.node !== "24.21.0" || !["arm64", "x64"].includes(process.arch)) throw new Error("NODE_REFUSED");
  const path = await realpath(process.execPath);
  return { path, sha256: await nodeExecutableHash(path), version: "24.21.0", architecture: process.arch as "arm64" | "x64" };
}
export async function captureDescriptor(project: string): Promise<Readonly<{ bindingSha256: string; buildManifestSha256: string }>> {
  const bytes = await checkedBytes(join(project, "dist/native/macos-retirement-notices/build-manifest.json"));
  const manifest = buildManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (manifest.architecture !== (process.arch === "arm64" ? "arm64" : "x86_64")) throw new Error("INPUT_REFUSED");
  for (const [name, hash] of Object.entries(manifest.sourceHashes)) {
    if (name.includes("..") || isAbsolute(name) || name.includes("\0") || sha256(await checkedBytes(join(project, name))) !== hash) throw new Error("INPUT_REFUSED");
  }
  const bindingSha256 = sha256(await checkedBytes(join(project, "dist/native/openwhisper_macos_retirement.node")));
  if (bindingSha256 !== manifest.bindingSha256) throw new Error("INPUT_REFUSED");
  return Object.freeze({ bindingSha256, buildManifestSha256: sha256(bytes) });
}
async function hashes(root: string, names: readonly string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of names) result[name] = sha256(await checkedBytes(join(root, name))); return result;
}
export async function fixtureSourceHashes(project: string): Promise<Record<string, string>> { return hashes(project, sourceNames); }
/** Called before the child is spawned: never refresh expected bytes in runtime. */
export async function freezeInput(project: string, fixture: string, descriptor: Readonly<{ bindingSha256: string; buildManifestSha256: string }>,
  nodeExecutable: FixtureInput["nodeExecutable"]): Promise<FixtureInput> {
  const current = await captureDescriptor(project);
  if (current.bindingSha256 !== descriptor.bindingSha256 || current.buildManifestSha256 !== descriptor.buildManifestSha256) throw new Error("INPUT_REFUSED");
  if (nodeExecutable.architecture !== process.arch || await nodeExecutableHash(nodeExecutable.path) !== nodeExecutable.sha256) throw new Error("NODE_REFUSED");
  return inputSchema.parse({ version: 1, fixture: "macos-production-retirement", architecture: process.arch, nodeExecutable,
    ...descriptor, sourceHashes: await hashes(project, sourceNames), payloadHashes: await hashes(fixture, payloadNames),
    distributionHashes: await hashes(join(project, "dist"), distributionNames) });
}
export async function verifyInput(project: string, fixture: string, expected: string): Promise<FixtureInput> {
  digest.parse(expected);
  const bytes = await checkedBytes(join(fixture, "fixture-input.json")); if (sha256(bytes) !== expected) throw new Error("INPUT_REFUSED");
  const input = inputSchema.parse(JSON.parse(bytes.toString("utf8")));
  const current = await freezeInput(project, fixture, input, input.nodeExecutable);
  if (input.architecture !== process.arch || JSON.stringify(current) !== JSON.stringify(input)) throw new Error("INPUT_REFUSED"); return input;
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FixtureError, inputSchema } from "./contracts.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const reviewedBundleSchema = z.strictObject({ directory: z.string().min(1).refine((path) =>
  isAbsolute(path) && resolve(path) === path && !path.includes("\0") && !path.split("/").some((part) => part === "." || part === "..")),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/u) });
export type ReviewedBundle = z.infer<typeof reviewedBundleSchema>;
export const PAYLOAD_NAMES = ["input.json", "fixture.mjs", "models.json", "LICENSE-zod"] as const;
type PayloadName = typeof PAYLOAD_NAMES[number];
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function fixedRead(path: string, maximum: number, privateFile: boolean): Promise<Buffer> {
  if (await realpath(path) !== path) throw new FixtureError();
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum) || before.uid !== BigInt(process.getuid?.() ?? -1) ||
    before.nlink !== 1n || (privateFile ? (before.mode & 0o7777n) !== 0o600n : (before.mode & 0o022n) !== 0n)) throw new FixtureError();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new FixtureError();
    const buffer = Buffer.alloc(Number(opened.size) + 1); let position = 0;
    while (position < buffer.length) {
      const value = await file.read(buffer, position, Math.min(65_536, buffer.length - position), position);
      if (!value.bytesRead) break; position += value.bytesRead;
    }
    const bytes = buffer.subarray(0, position), after = await file.stat({ bigint: true });
    if (bytes.length !== Number(opened.size) || bytes.length > maximum || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw new FixtureError();
    return bytes;
  } finally { await file.close(); }
}
/** Captures reviewed bytes, not a new build. Caller copies these exact Buffers
 * into its own private payload; approval drift cannot select working files. */
export async function readReviewedBundle(value: unknown): Promise<Readonly<Record<PayloadName, Buffer>>> {
  const selected = reviewedBundleSchema.parse(value);
  if (await realpath(selected.directory) !== selected.directory) throw new FixtureError();
  const stats = await lstat(selected.directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o7777) !== 0o700) throw new FixtureError();
  const entries = await readdir(selected.directory); if (JSON.stringify(entries.sort()) !== JSON.stringify([...PAYLOAD_NAMES].sort())) throw new FixtureError();
  const inputBytes = await fixedRead(join(selected.directory, "input.json"), 256 * 1024, true);
  if (sha(inputBytes) !== selected.inputSha256) throw new FixtureError();
  const input = inputSchema.parse(JSON.parse(inputBytes.toString("utf8")));
  const sourceNames = Object.keys(input.sources); if (!sourceNames.length || sourceNames.length > 3000) throw new FixtureError();
  for (const name of sourceNames) {
    if (name.split("/").some((part) => part === "" || part === "." || part === "..")) throw new FixtureError();
    const path = resolve(repositoryRoot, name);
    if (!path.startsWith(repositoryRoot + "/") || dirname(path) === repositoryRoot ||
      sha(await fixedRead(path, 8 * 1024 * 1024, false)) !== input.sources[name]) throw new FixtureError();
  }
  const fixture = await fixedRead(join(selected.directory, "fixture.mjs"), 4 * 1024 * 1024, true);
  const catalog = await fixedRead(join(selected.directory, "models.json"), 64 * 1024, true);
  const license = await fixedRead(join(selected.directory, "LICENSE-zod"), 64 * 1024, true);
  if (sha(fixture) !== input.fixtureSha256 || sha(catalog) !== input.catalogSha256 || sha(license) !== input.zodLicenseSha256) throw new FixtureError();
  return Object.freeze({ "input.json": inputBytes, "fixture.mjs": fixture, "models.json": catalog, "LICENSE-zod": license });
}

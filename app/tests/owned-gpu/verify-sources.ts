import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { digestSchema, fileSha256, pinnedNativeSource, shaderSourcesSchema, vulkanHeadersSchema } from "../../scripts/native-dependencies.js";

assert.equal(process.getuid?.(), 1000);
assert.equal((await lstat("/.dockerenv")).isFile(), true);
const pin = z.strictObject({ repository: z.literal("ggml-org/whisper.cpp"), tag: z.literal("b5130"), revision: z.string().regex(/^[a-f0-9]{40}$/), sha256: digestSchema })
  .parse(JSON.parse(await readFile("/owned-app/native/whisper-source.json", "utf8")));
const node = z.strictObject({ version: z.literal("24.21.0"), napiVersion: z.literal(8), sha256: digestSchema,
  source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt") }).parse(JSON.parse(await readFile("/owned-app/native/node-headers.json", "utf8")));
const headers = vulkanHeadersSchema.parse(JSON.parse(await readFile("/owned-app/native/vulkan-headers.json", "utf8")));
const shaders = shaderSourcesSchema.parse(JSON.parse(await readFile("/owned-app/native/shaderc-source.json", "utf8")));
const root = await mkdtemp("/tmp/openwhisper-empty-native-sources-");
const inputs = [
  { name: "whisper", url: `https://codeload.github.com/${pin.repository}/tar.gz/${pin.revision}`, sha256: pin.sha256 },
  { name: "node", url: `https://nodejs.org/download/release/v${node.version}/node-v${node.version}-headers.tar.gz`, sha256: node.sha256 },
  ...Object.entries(headers).map(([name, value]) => ({ name, url: `https://codeload.github.com/KhronosGroup/${name}/tar.gz/${value.revision}`, sha256: value.sha256 })),
  ...Object.entries(shaders).map(([name, value]) => ({ name, url: `https://codeload.github.com/${value.repository}/tar.gz/${value.revision}`, sha256: value.sha256 })),
];
const results: { name: string; archiveSha256: string; treeSha256: string; files: number; directories: number; bytes: number }[] = [];
const started = new Date().toISOString();
// Two independent downloads at once; every destination is absent and has no cache marker.
for (let offset = 0; offset < inputs.length; offset += 2) {
  await Promise.all(inputs.slice(offset, offset + 2).map(async (input) => {
    const destination = join(root, input.name);
    await assert.rejects(lstat(destination), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
    await pinnedNativeSource(input.url, input.sha256, destination);
    assert.equal((await readFile(join(destination, ".verified-archive"), "utf8")).trim(), input.sha256);
    let files = 0, directories = 0, bytes = 0;
    const hash = createHash("sha256");
    const walk = async (path: string, prefix = ""): Promise<void> => {
      const entries = await readdir(path, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const entry of entries) {
        const name = join(prefix, entry.name), member = join(path, entry.name);
        assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) { directories++; await walk(member, name); }
        else { assert.equal(entry.isFile(), true); files++; bytes += (await lstat(member)).size;
          hash.update(name).update("\0").update(await fileSha256(member)).update("\n"); }
      }
    };
    await walk(destination);
    results.push({ name: input.name, archiveSha256: input.sha256, treeSha256: hash.digest("hex"), files, directories, bytes });
  }));
}
assert.equal(results.length, 8);
assert.equal((await lstat(join(root, "whisper/include/parakeet.h"))).isFile(), true);
assert.equal((await lstat(join(root, "node/include/node/node_api.h"))).isFile(), true);
await mkdir("/evidence", { recursive: true, mode: 0o700 });
await writeFile("/evidence/empty-source-result.json", JSON.stringify({ result: "PASS", started, completed: new Date().toISOString(),
  helperSha256: await fileSha256("/owned-app/scripts/native-dependencies.ts"), emptyDestinations: true, results,
  scope: "Fresh checksum-pinned downloads into empty owned directories through production tar inventory/type/path validation and extraction; no build, native load, model or application execution." }, null, 2), { mode: 0o600 });
console.log("PASS: all eight pinned archives validated and extracted from empty owned destinations.");

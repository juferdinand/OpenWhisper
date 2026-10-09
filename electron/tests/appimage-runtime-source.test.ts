import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appImageRuntimeSourceSchema, packagePinnedAppImageRuntimeSources, verifyPinnedAppImageRuntimeSources } from "../scripts/appimage-runtime-source.js";

const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

test("AppImage runtime source pin requires runtime, LGPL source, upstream patch, and relinking instructions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-runtime-source-test-")), input = join(directory, "input"), output = join(directory, "output");
  try {
    await mkdir(input);
    const contents = new Map([
      ["type2-runtime.tar.gz", Buffer.from("pinned runtime source")],
      ["fuse-3.15.0.tar.xz", Buffer.from("complete LGPL source")],
      ["squashfuse-0.5.2.tar.gz", Buffer.from("upstream squashfuse source")],
      ["mount.c.diff", Buffer.from("the exact libfuse patch")],
      ["RELINKING.md", Buffer.from("apply the patch, rebuild, and relink")],
    ]);
    const pins = [...contents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
    for (const [path, bytes] of contents) await writeFile(join(input, path), bytes);

    await verifyPinnedAppImageRuntimeSources(input, pins);
    const missingPatch = Object.fromEntries([...contents].filter(([path]) => path !== "mount.c.diff"));
    await assert.rejects(packagePinnedAppImageRuntimeSources(output, missingPatch, pins), /APPIMAGE_RUNTIME_SOURCE_SET_MISMATCH/);
    await assert.rejects(lstat(output), { code: "ENOENT" });
    await packagePinnedAppImageRuntimeSources(output, Object.fromEntries(contents), pins);
    await verifyPinnedAppImageRuntimeSources(output, pins);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AppImage source pins identify the immutable upstream commit and source archive hashes", async () => {
  const notice = JSON.parse(await readFile(new URL("../native/appimage-runtime-notices/manifest.json", import.meta.url), "utf8")) as { sourceBundle: unknown };
  const manifest = appImageRuntimeSourceSchema.parse(notice.sourceBundle);
  const relinking = await readFile(new URL("../native/appimage-runtime-notices/RELINKING.md", import.meta.url), "utf8");
  assert.match(manifest.runtimeSource.url, /dd6cebedcbddde9c82f89b011e8e1d40b6e43868/u);
  assert.equal(manifest.libfuseSource.sha256, "70589cfd5e1cff7ccd6ac91c86c01be340b227285c5e200baa284e401eea2ca0");
  assert.equal(manifest.libfusePatch.sha256, "1c7fd9e26717545a476b226b083a9f9d05676c180edbd71a04bbd8a73599dc44");
  assert.equal(manifest.relinkingInstructions.sha256, "9512d72dd276f0a243471733c0842d32bbd2c0f42217ed489d9b8e04989891c0");
  assert.match(relinking, /squashfs-root\/usr\/lib\/openwhisper(?:"|\s)/u);
  assert.match(relinking, /squashfs-root\/usr\/lib\/openwhisper-dev(?:"|\s)/u);
  assert.match(relinking, /git diff --binary HEAD > .*patches\/libfuse\/mount\.c\.diff/u);
  assert.match(relinking, /ARCH=x86_64 bash scripts\/docker\/build-with-docker\.sh/u);
  assert.match(relinking, /scripts\/build-runtime\.sh` writes the rebuilt runtime at/u);
  assert.match(relinking, /`runtime-relink-work\/type2-runtime-[a-f0-9]{40}\/runtime-x86_64`/u);
  assert.match(relinking, /squashfs-tools/u);
});

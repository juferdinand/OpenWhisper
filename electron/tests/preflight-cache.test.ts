import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadVerifiedAsset } from "../scripts/setup-preflight-tools.js";

test("reuses a checksum-verified cached asset without network access", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openwhisper-preflight-cache-"),
  );
  try {
    const cachePath = join(directory, "pinned-tool.tar.gz");
    const bytes = Buffer.from("pinned official release asset");
    const digest = createHash("sha256").update(bytes).digest("hex");
    let downloadCount = 0;
    const downloader = async (): Promise<Uint8Array> => {
      downloadCount += 1;
      return bytes;
    };

    assert.deepEqual(
      await loadVerifiedAsset(
        cachePath,
        "https://release.invalid/asset",
        digest,
        1024,
        downloader,
      ),
      bytes,
    );
    assert.deepEqual(await readFile(cachePath), bytes);

    await assert.doesNotReject(
      loadVerifiedAsset(
        cachePath,
        "https://release.invalid/asset",
        digest,
        1024,
        async () => {
          throw new Error("network must not be used for a valid cache entry");
        },
      ),
    );
    assert.equal(downloadCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

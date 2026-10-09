import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { finalizeLinuxRelease } from "../scripts/finalize-linux-release.js";
import { LINUX_UPDATE_PUBLIC_KEY } from "../src/services/linux-update-signature.js";
import {
  LINUX_UPDATE_FEED_URL,
  projectLinuxUpdateFeed,
} from "../src/services/update-policy.js";

const ownedAssets = process.env["OPENWHISPER_OWNED_UPDATE_SIGNATURE_ASSETS"];
const publicAssetPins: Readonly<Record<string, string>> = {
  "OpenWhisper-Linux-amd64.deb":
    "412d06d5475b430fd290c560ea9cd03818b6c471075f064833ebca021313b6cb",
  "OpenWhisper-Linux-amd64.deb.sig":
    "13032b0a95929f0061f0c596eb6ced59152165418b6f288e414caa8a8ebdff39",
  "OpenWhisper-Linux-x86_64.AppImage":
    "81ee1be21506a3deb0a5e90846c639e81df766eab728b9970f4af14ef166ffab",
  "OpenWhisper-Linux-x86_64.AppImage.sig":
    "5994738ed14e8a375ac762bf44f80ba0dc6939a0b672df66f857b60ce158a084",
};

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

test("release finalizer refuses an invalid signature before writing feed or checksums", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openwhisper-release-finalizer-"),
  );
  try {
    const commit = "0123456789abcdef0123456789abcdef01234567",
      version = "0.3.0";
    const debianName = "OpenWhisper-Linux-amd64.deb",
      imageName = "OpenWhisper-Linux-x86_64.AppImage";
    const debianBytes = Buffer.from("inert package bytes"),
      imageBytes = Buffer.from("inert image bytes");
    await writeFile(join(directory, debianName), debianBytes);
    await writeFile(join(directory, imageName), imageBytes, { mode: 0o755 });
    await writeFile(
      join(directory, `${debianName}.sig`),
      "malformed signature\n",
    );
    await writeFile(
      join(directory, `${imageName}.sig`),
      "malformed signature\n",
    );
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    await writeFile(
      join(directory, "release-construction-receipt.json"),
      JSON.stringify({
        classification: "CANONICAL_STABLE_LINUX_RELEASE_CONSTRUCTION_UNSIGNED",
        source: { commit, modified: false },
        version,
        updatePolicy: {
          publicKey: LINUX_UPDATE_PUBLIC_KEY,
          feedURL: LINUX_UPDATE_FEED_URL,
          requireSignedVersion: true,
        },
        artifacts: {
          debian: {
            path: join(directory, debianName),
            bytes: debianBytes.length,
            sha256: digest(debianBytes),
            package: "io-github-whisperfree",
            version,
            architecture: "amd64",
          },
          appImage: {
            path: join(directory, imageName),
            bytes: imageBytes.length,
            sha256: digest(imageBytes),
            mode: 0o755,
          },
        },
      }),
    );
    await assert.rejects(finalizeLinuxRelease({ directory, version, commit }));
    await assert.rejects(lstat(join(directory, "latest.json")), {
      code: "ENOENT",
    });
    await assert.rejects(lstat(join(directory, "SHA256SUMS")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "finalizer verifies existing public 0.2.5 signatures and production feed projection",
  {
    skip: !ownedAssets
      ? "Requires the existing public signed fixture directory; no download or signing fallback."
      : false,
  },
  async () => {
    assert.ok(ownedAssets && isAbsolute(ownedAssets));
    const directory = await mkdtemp(
      join(tmpdir(), "openwhisper-release-finalizer-valid-"),
    );
    try {
      const version = "0.2.5",
        commit = "0123456789abcdef0123456789abcdef01234567";
      for (const [name, expected] of Object.entries(publicAssetPins)) {
        const source = join(ownedAssets, name);
        assert.equal(await sha256(source), expected, name);
        await cp(source, join(directory, name));
      }
      const debianName = "OpenWhisper-Linux-amd64.deb",
        imageName = "OpenWhisper-Linux-x86_64.AppImage";
      await chmod(join(directory, imageName), 0o755);
      const debian = await readFile(join(directory, debianName)),
        image = await readFile(join(directory, imageName));
      const digest = (bytes: Uint8Array) =>
        createHash("sha256").update(bytes).digest("hex");
      await writeFile(
        join(directory, "release-construction-receipt.json"),
        JSON.stringify({
          classification:
            "CANONICAL_STABLE_LINUX_RELEASE_CONSTRUCTION_UNSIGNED",
          source: { commit, modified: false },
          version,
          updatePolicy: {
            publicKey: LINUX_UPDATE_PUBLIC_KEY,
            feedURL: LINUX_UPDATE_FEED_URL,
            requireSignedVersion: true,
          },
          artifacts: {
            debian: {
              path: join(directory, debianName),
              bytes: debian.length,
              sha256: digest(debian),
              package: "io-github-whisperfree",
              version,
              architecture: "amd64",
            },
            appImage: {
              path: join(directory, imageName),
              bytes: image.length,
              sha256: digest(image),
              mode: 0o755,
            },
          },
        }),
      );
      await finalizeLinuxRelease({ directory, version, commit });
      const feed: unknown = JSON.parse(
        await readFile(join(directory, "latest.json"), "utf8"),
      );
      for (const kind of ["deb", "appimage"] as const) {
        const candidate = projectLinuxUpdateFeed({
          sourceURL: LINUX_UPDATE_FEED_URL,
          package: kind,
          currentVersion: "0.2.4",
          feed,
        });
        assert.equal(candidate.version, version);
        assert.equal(candidate.package, kind);
        assert.equal(
          candidate.assetName,
          kind === "deb" ? debianName : imageName,
        );
        assert.equal(
          candidate.signature,
          (
            await readFile(
              join(directory, `${candidate.assetName}.sig`),
              "utf8",
            )
          ).trim(),
        );
      }
      const checksums = await readFile(join(directory, "SHA256SUMS"), "utf8");
      const checksumNames = new Set(
        checksums
          .trimEnd()
          .split("\n")
          .map((line) => line.split("  ")[1]),
      );
      for (const name of [...Object.keys(publicAssetPins), "latest.json"])
        assert.ok(checksumNames.has(name));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const artifactSchema = z.strictObject({ path: z.string().regex(/^[A-Za-z0-9._-]+$/u), url: z.string().url(),
  bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
export const appImageRuntimeSourceSchema = z.strictObject({
  runtimeSource: artifactSchema,
  libfuseSource: artifactSchema,
  squashfuseSource: artifactSchema,
  libfusePatch: artifactSchema,
  relinkingInstructions: z.strictObject({ path: z.literal("RELINKING.md"), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }),
});
export type AppImageRuntimeSourcePins = z.infer<typeof appImageRuntimeSourceSchema>;
export type PinnedSourceFile = { readonly path: string; readonly bytes: number; readonly sha256: string };

const digest = (content: Uint8Array): string => createHash("sha256").update(content).digest("hex");

/** Check an exact source-file set before it is placed in a distributable AppImage. */
export async function verifyPinnedAppImageRuntimeSources(directory: string, pins: readonly PinnedSourceFile[]): Promise<void> {
  const expected = new Set(pins.map((entry) => entry.path));
  if (expected.size !== pins.length || pins.some((entry) => !/^[A-Za-z0-9._-]+$/u.test(entry.path))) throw new Error("APPIMAGE_RUNTIME_SOURCE_PIN_INVALID");
  const actualNames = (await readdir(directory)).sort();
  if (actualNames.length !== expected.size || actualNames.some((name) => !expected.has(name))) throw new Error("APPIMAGE_RUNTIME_SOURCE_SET_MISMATCH");
  for (const pin of pins) {
    const path = join(directory, pin.path), stat = await lstat(path), content = await readFile(path);
    if (!stat.isFile() || stat.isSymbolicLink() || content.length !== pin.bytes || digest(content) !== pin.sha256) {
      throw new Error("APPIMAGE_RUNTIME_SOURCE_PIN_MISMATCH");
    }
  }
}

/** Write a verified source set as the recipient-visible AppImage bundle. */
export async function packagePinnedAppImageRuntimeSources(destination: string, files: Readonly<Record<string, Buffer>>,
  pins: readonly PinnedSourceFile[]): Promise<void> {
  const expected = new Set(pins.map((entry) => entry.path));
  const actualNames = Object.keys(files).sort();
  if (expected.size !== pins.length || actualNames.length !== expected.size || actualNames.some((name) => !expected.has(name))) {
    throw new Error("APPIMAGE_RUNTIME_SOURCE_SET_MISMATCH");
  }
  for (const pin of pins) {
    const content = files[pin.path];
    if (!content || content.length !== pin.bytes || digest(content) !== pin.sha256) throw new Error("APPIMAGE_RUNTIME_SOURCE_PIN_MISMATCH");
  }
  await mkdir(destination, { mode: 0o755 });
  for (const pin of pins) {
    const content = files[pin.path];
    if (!content) throw new Error("APPIMAGE_RUNTIME_SOURCE_PIN_MISMATCH");
    await writeFile(join(destination, pin.path), content, { mode: 0o644, flag: "wx" });
  }
}

async function downloadPinned(url: string, bytes: number, sha256: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.url.startsWith("https://") || !response.body) throw new Error("APPIMAGE_RUNTIME_SOURCE_DOWNLOAD_FAILED");
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > bytes) { await reader.cancel(); throw new Error("APPIMAGE_RUNTIME_SOURCE_PIN_MISMATCH"); }
    chunks.push(Buffer.from(next.value));
  }
  const content = Buffer.concat(chunks);
  if (content.length !== bytes || digest(content) !== sha256) throw new Error("APPIMAGE_RUNTIME_SOURCE_PIN_MISMATCH");
  return content;
}

/** Download only exact pinned public sources into a private temporary cache. */
export async function createAppImageRuntimeSourceBundle(runtimeCommit: string, pins: AppImageRuntimeSourcePins): Promise<{
  readonly files: Readonly<Record<string, Buffer>>;
  readonly sourceFiles: readonly PinnedSourceFile[];
}> {
  if (!/^[a-f0-9]{40}$/u.test(runtimeCommit) ||
      pins.runtimeSource.path !== `type2-runtime-${runtimeCommit}.tar.gz` ||
      pins.runtimeSource.url !== `https://codeload.github.com/AppImage/type2-runtime/tar.gz/${runtimeCommit}` ||
      pins.libfuseSource.path !== "fuse-3.15.0.tar.xz" ||
      pins.libfuseSource.url !== "https://github.com/libfuse/libfuse/releases/download/fuse-3.15.0/fuse-3.15.0.tar.xz" ||
      pins.squashfuseSource.path !== "squashfuse-0.5.2.tar.gz" ||
      pins.squashfuseSource.url !== "https://github.com/vasi/squashfuse/archive/0.5.2.tar.gz" ||
      pins.libfusePatch.path !== "mount.c.diff" ||
      pins.libfusePatch.url !== `https://raw.githubusercontent.com/AppImage/type2-runtime/${runtimeCommit}/patches/libfuse/mount.c.diff`) {
    throw new Error("APPIMAGE_RUNTIME_SOURCE_PROVENANCE_MISMATCH");
  }
  const cache = await mkdtemp(join(tmpdir(), "ow-appimage-src-"));
  await chmod(cache, 0o700);
  try {
    const stat = await lstat(cache);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("APPIMAGE_RUNTIME_SOURCE_CACHE_UNSAFE");
    const files = [pins.runtimeSource, pins.libfuseSource, pins.squashfuseSource, pins.libfusePatch];
    for (const pin of files) await writeFile(join(cache, pin.path), await downloadPinned(pin.url, pin.bytes, pin.sha256), { mode: 0o600, flag: "wx" });
    const relinkingPath = resolve(dirname(fileURLToPath(import.meta.url)), "../native/appimage-runtime-notices", pins.relinkingInstructions.path);
    const relinking = await readFile(relinkingPath);
    if (relinking.length !== pins.relinkingInstructions.bytes || digest(relinking) !== pins.relinkingInstructions.sha256) {
      throw new Error("APPIMAGE_RUNTIME_RELINKING_NOTICE_MISMATCH");
    }
    await writeFile(join(cache, pins.relinkingInstructions.path), relinking, { mode: 0o600, flag: "wx" });
    const sourceFiles = [...files, { ...pins.relinkingInstructions, url: "" }];
    await verifyPinnedAppImageRuntimeSources(cache, sourceFiles);
    await writeFile(join(cache, "source-manifest.json"), `${JSON.stringify({
      runtimeCommit,
      files: sourceFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const bundled: Record<string, Buffer> = {};
    for (const pin of sourceFiles) bundled[pin.path] = await readFile(join(cache, pin.path));
    bundled["source-manifest.json"] = await readFile(join(cache, "source-manifest.json"));
    const sourceManifest = bundled["source-manifest.json"];
    return { files: bundled, sourceFiles: [...sourceFiles,
      { path: "source-manifest.json", bytes: sourceManifest.length, sha256: digest(sourceManifest) }] };
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pinSchema = z.strictObject({ version: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/u),
  url: z.url().startsWith("https://"), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const manifestSchema = z.strictObject({ appimagetool: pinSchema, runtime: pinSchema.extend({
  digestMd5Offset: z.number().int().nonnegative(), licenseBytes: z.number().int().positive(),
  licenseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}) });
export type AppImageToolPins = z.infer<typeof manifestSchema>;
const inside = (base: string, path: string): boolean => {
  const value = relative(base, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith(sep));
};

export async function readAppImageToolPins(source = join(root, "native/appimage-tools.json")): Promise<AppImageToolPins> {
  return manifestSchema.parse(JSON.parse(await readFile(source, "utf8")) as unknown);
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
async function requestPinnedHttps(url: string, signal: AbortSignal, request: typeof fetch): Promise<Response> {
  let current = new URL(url);
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= 10; redirects += 1) {
    if (current.protocol !== "https:" || visited.has(current.href)) throw new Error("Pinned AppImage tool redirect is invalid.");
    visited.add(current.href);
    const response = await request(current.href, { signal, redirect: "manual" });
    if (!redirectStatuses.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 10) throw new Error("Pinned AppImage tool redirect limit exceeded.");
    let next: URL;
    try { next = new URL(location, current); }
    catch { throw new Error("Pinned AppImage tool redirect location is invalid."); }
    if (next.protocol !== "https:") throw new Error("Pinned AppImage tool redirect must remain HTTPS.");
    current = next;
  }
  throw new Error("Pinned AppImage tool redirect limit exceeded.");
}

/** Download only the exact pinned AppImage executables into a caller-owned fresh directory. */
export async function fetchAppImageTools(output: string, pins: AppImageToolPins, request: typeof fetch = fetch): Promise<void> {
  const destination = resolve(output);
  if (!output || !output.startsWith("/")) {
    throw new Error("AppImage tools require a fresh absolute directory outside the source tree.");
  }
  const parent = dirname(destination);
  if (await realpath(parent) !== parent || inside(root, destination) || inside(destination, root)) {
    throw new Error("AppImage tools require a canonical parent outside the source tree.");
  }
  try { await lstat(destination); throw new Error("AppImage tool output directory already exists."); }
  catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(destination, { recursive: false, mode: 0o700 });
  let complete = false;
  try {
    for (const [component, filename] of [["appimagetool", "appimagetool-x86_64.AppImage"], ["runtime", "runtime-x86_64"]] as const) {
      const pin = pins[component];
      const deadline = AbortSignal.timeout(120_000);
      const response = await requestPinnedHttps(pin.url, deadline, request);
      if (!response.ok || !response.url.startsWith("https://") || !response.body) throw new Error("Pinned AppImage tool download failed.");
      const announcedSize = Number(response.headers.get("content-length") ?? "0");
      if (announcedSize > pin.bytes) throw new Error("Pinned AppImage tool exceeds its expected size.");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > pin.bytes) {
          await reader.cancel();
          throw new Error("Pinned AppImage tool exceeds its expected size.");
        }
        chunks.push(chunk.value);
      }
      const bytes = Buffer.concat(chunks, size);
      if (bytes.byteLength !== pin.bytes || createHash("sha256").update(bytes).digest("hex") !== pin.sha256) {
        throw new Error("Pinned AppImage tool checksum or size mismatch.");
      }
      const path = join(destination, filename);
      await writeFile(path, bytes, { mode: 0o755, flag: "wx" });
    }
    complete = true;
  } finally {
    if (!complete) await rm(destination, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw new Error("Usage: fetch-appimage-tools.ts --output NEW_DIRECTORY");
  await fetchAppImageTools(args[1], await readAppImageToolPins());
}

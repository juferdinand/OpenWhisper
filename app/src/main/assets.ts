import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const APP_ORIGIN = "app://openwhisper";
export const MAIN_URL = `${APP_ORIGIN}/index.html`;
export const OVERLAY_URL = `${MAIN_URL}?overlay=1`;
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
  "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

const mediaTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

export async function readApplicationAsset(
  url: string,
  assetRoot: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mediaType: string }> {
  const requested = new URL(url);
  if (requested.protocol !== "app:" || requested.hostname !== "openwhisper" ||
      requested.username || requested.password || requested.port || requested.hash) {
    throw new Error("Untrusted application asset.");
  }
  if (requested.search && url !== OVERLAY_URL) throw new Error("Unexpected asset query.");
  const path = decodeURIComponent(requested.pathname);
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      path.split("/").includes("..")) throw new Error("Invalid application asset path.");
  const root = await realpath(assetRoot);
  const candidate = resolve(root, `.${path}`);
  const resolved = await realpath(candidate);
  const within = relative(root, resolved);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) ||
      (await lstat(candidate)).isSymbolicLink()) throw new Error("Invalid application asset path.");
  const mediaType = mediaTypes[extname(resolved)];
  if (!mediaType || !(await lstat(resolved)).isFile()) throw new Error("Unknown application asset.");
  return { bytes: new Uint8Array(await readFile(resolved)), mediaType };
}

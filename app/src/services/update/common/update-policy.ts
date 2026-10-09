import { z } from "zod";

export const LINUX_UPDATE_REPOSITORY = "https://github.com/juferdinand/OpenWhisper";
export const LINUX_UPDATE_FEED_URL = `${LINUX_UPDATE_REPOSITORY}/releases/latest/download/latest.json`;
export const MACOS_UPDATE_ASSET = "OpenWhisper-macOS.zip";
export const UPDATE_POLICY_LIMITS = Object.freeze({ assets: 128, notesBytes: 64 * 1024, signatureBytes: 16 * 1024 });
const uint64Max = 18_446_744_073_709_551_615n;
type Version = readonly [bigint, bigint, bigint];
type Failure = "INVALID_VERSION" | "INVALID_REPOSITORY" | "INVALID_SOURCE" | "INVALID_METADATA" | "INVALID_PACKAGE" | "NOT_NEWER";
export class UpdatePolicyError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "UpdatePolicyError"; }
}

/** UInt64 components preserve the native policy beyond JavaScript's safe integer range. */
export function parseUpdateVersion(value: unknown): Version {
  if (typeof value !== "string" || value.length > 62) throw new UpdatePolicyError("INVALID_VERSION");
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !part.length || part.length > 20 || /[^0-9]/u.test(part) ||
      (part.length > 1 && part.startsWith("0")))) throw new UpdatePolicyError("INVALID_VERSION");
  const numbers = parts.map((part) => BigInt(part));
  if (numbers.some((number) => number > uint64Max)) throw new UpdatePolicyError("INVALID_VERSION");
  return Object.freeze([numbers[0]!, numbers[1]!, numbers[2]!]);
}
function newer(candidate: Version, current: Version): boolean {
  for (const component of [0, 1, 2] as const) if (candidate[component] !== current[component]) return candidate[component] > current[component];
  return false;
}
export function isNewerUpdateVersion(candidate: unknown, current: unknown): boolean {
  try { return newer(parseUpdateVersion(candidate), parseUpdateVersion(current)); } catch { return false; }
}
function requireNewer(candidate: string, current: unknown): void {
  if (!newer(parseUpdateVersion(candidate), parseUpdateVersion(current))) throw new UpdatePolicyError("NOT_NEWER");
}
function macosRepository(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) throw new UpdatePolicyError("INVALID_REPOSITORY");
  const parts = value.split("/"), owner = parts[0], repository = parts[1];
  if (parts.length !== 2 || !owner || !repository || /[^A-Za-z0-9-]/u.test(owner) ||
      /[^A-Za-z0-9_.-]/u.test(repository) || repository === "." || repository === "..") throw new UpdatePolicyError("INVALID_REPOSITORY");
  return value;
}
/** The admitted host build supplies this repository; preferences and IPC cannot choose it. */
export function macosUpdateEndpoint(repository: unknown): string {
  return `https://api.github.com/repos/${macosRepository(repository)}/releases/latest`;
}
const utf8 = (bytes: number) => z.string().max(bytes).refine((value) => Buffer.byteLength(value, "utf8") <= bytes);
const assetSchema = z.object({ name: utf8(256).min(1), browser_download_url: utf8(2048).min(1) });
const macReleaseSchema = z.object({ tag_name: utf8(63).min(1), html_url: utf8(2048).min(1), draft: z.literal(false),
  prerelease: z.literal(false), body: utf8(UPDATE_POLICY_LIMITS.notesBytes).nullable().optional(),
  assets: z.array(assetSchema).max(UPDATE_POLICY_LIMITS.assets) });
const linuxTargetSchema = z.object({ url: utf8(2048).min(1), signature: utf8(UPDATE_POLICY_LIMITS.signatureBytes)
  .refine((value) => value.trim().length > 0) });
const linuxReleaseSchema = z.object({ version: utf8(62).min(1), notes: utf8(UPDATE_POLICY_LIMITS.notesBytes).optional() });
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UpdatePolicyError("INVALID_METADATA");
  return value as Record<string, unknown>;
}
function own(value: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(value, key)) throw new UpdatePolicyError("INVALID_METADATA");
  return value[key];
}
function optional(value: Record<string, unknown>, key: string): unknown { return Object.hasOwn(value, key) ? value[key] : undefined; }
function metadata<T>(operation: () => T): T {
  try { return operation(); } catch (error: unknown) {
    if (error instanceof UpdatePolicyError) throw error;
    throw new UpdatePolicyError("INVALID_METADATA");
  }
}
interface Candidate {
  readonly authentication: "unauthenticated";
  readonly version: string; readonly notes: string; readonly assetName: string; readonly assetURL: string; readonly pageURL: string;
}
export interface MacosUpdateCandidate extends Candidate { readonly package: "macos"; readonly repository: string }
export interface LinuxUpdateCandidate extends Candidate {
  readonly package: "deb" | "appimage"; readonly feedURL: string; readonly target: "linux-x86_64-deb" | "linux-x86_64-appimage";
  /** Opaque announced signature text; this projection performs no cryptographic verification. */
  readonly signature: string;
}

/** Projects required API fields only. Exact source policy does not authenticate downloaded bytes. */
export function projectMacosUpdateRelease(options: {
  readonly repository: unknown; readonly currentVersion: unknown; readonly release: unknown;
}): MacosUpdateCandidate {
  const repository = macosRepository(options.repository);
  return metadata(() => {
    const source = record(options.release), assets = own(source, "assets");
    // Refuse excessive arrays before the schema visits their elements.
    if (!Array.isArray(assets) || assets.length > UPDATE_POLICY_LIMITS.assets) throw new UpdatePolicyError("INVALID_METADATA");
    const release = macReleaseSchema.parse({ tag_name: own(source, "tag_name"), html_url: own(source, "html_url"),
      draft: own(source, "draft"), prerelease: own(source, "prerelease"), body: optional(source, "body"),
      assets: assets.map((item: unknown) => { const asset = record(item); return { name: own(asset, "name"), browser_download_url: own(asset, "browser_download_url") }; }) });
    if (!release.tag_name.startsWith("v")) throw new UpdatePolicyError("INVALID_VERSION");
    const version = release.tag_name.slice(1); requireNewer(version, options.currentVersion);
    const matches = release.assets.filter((asset) => asset.name === MACOS_UPDATE_ASSET);
    const assetURL = `https://github.com/${repository}/releases/download/v${version}/${MACOS_UPDATE_ASSET}`;
    const pageURL = `https://github.com/${repository}/releases/tag/v${version}`;
    if (matches.length !== 1 || matches[0]?.browser_download_url !== assetURL || release.html_url !== pageURL) throw new UpdatePolicyError("INVALID_SOURCE");
    return Object.freeze({ authentication: "unauthenticated", package: "macos", repository, version, notes: release.body ?? "",
      assetName: MACOS_UPDATE_ASSET, assetURL, pageURL });
  });
}

/** Package kind must come from actual installation admission, not a displayed package label. */
export function projectLinuxUpdateFeed(options: {
  readonly sourceURL: unknown; readonly package: unknown; readonly currentVersion: unknown; readonly feed: unknown;
}): LinuxUpdateCandidate {
  if (options.sourceURL !== LINUX_UPDATE_FEED_URL) throw new UpdatePolicyError("INVALID_SOURCE");
  if (options.package !== "deb" && options.package !== "appimage") throw new UpdatePolicyError("INVALID_PACKAGE");
  const packageKind = options.package;
  return metadata(() => {
    const source = record(options.feed), release = linuxReleaseSchema.parse({ version: own(source, "version"), notes: optional(source, "notes") });
    requireNewer(release.version, options.currentVersion);
    const target = packageKind === "deb" ? "linux-x86_64-deb" : "linux-x86_64-appimage";
    const assetName = packageKind === "deb" ? "OpenWhisper-Linux-amd64.deb" : "OpenWhisper-Linux-x86_64.AppImage";
    const announced = record(own(record(own(source, "platforms")), target));
    const artifact = linuxTargetSchema.parse({ url: own(announced, "url"), signature: own(announced, "signature") });
    const assetURL = `${LINUX_UPDATE_REPOSITORY}/releases/download/v${release.version}/${assetName}`;
    if (artifact.url !== assetURL) throw new UpdatePolicyError("INVALID_SOURCE");
    return Object.freeze({ authentication: "unauthenticated", package: packageKind, version: release.version, notes: release.notes ?? "",
      assetName, assetURL, pageURL: `${LINUX_UPDATE_REPOSITORY}/releases/tag/v${release.version}`, feedURL: LINUX_UPDATE_FEED_URL,
      target, signature: artifact.signature });
  });
}

import { z } from "zod";
import { updateDetailsSchema, type UpdateChannel, type UpdateDetails } from "../../../contracts/ui/state.js";
export type { UpdateChannel } from "../../../contracts/ui/state.js";

export const LINUX_UPDATE_REPOSITORY = "https://github.com/juferdinand/OpenWhisper";
export const LINUX_UPDATE_FEED_URL = `${LINUX_UPDATE_REPOSITORY}/releases/latest/download/latest.json`;
export const PREVIEW_RELEASES_API_URL = "https://api.github.com/repos/juferdinand/OpenWhisper/releases?per_page=100";
export const MACOS_UPDATE_ASSET = "OpenWhisper-macOS.zip";
export const UPDATE_POLICY_LIMITS = Object.freeze({ assets: 128, notesBytes: 64 * 1024, signatureBytes: 16 * 1024 });
const uint64Max = 18_446_744_073_709_551_615n;
type Version = readonly [bigint, bigint, bigint];
type Failure = "INVALID_VERSION" | "INVALID_REPOSITORY" | "INVALID_SOURCE" | "INVALID_METADATA" | "INVALID_PACKAGE" | "INVALID_CHANNEL" | "NOT_NEWER";
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
/** Return the next patch using the same UInt64 policy as release admission. */
export function nextPatchVersion(value: unknown): string {
  const [major, minor, patch] = parseUpdateVersion(value);
  if (patch === uint64Max) throw new UpdatePolicyError("INVALID_VERSION");
  return `${major}.${minor}.${patch + 1n}`;
}
function newer(candidate: Version, current: Version): boolean {
  for (const component of [0, 1, 2] as const) if (candidate[component] !== current[component]) return candidate[component] > current[component];
  return false;
}
function compare(candidate: Version, current: Version): number {
  for (const component of [0, 1, 2] as const) {
    if (candidate[component] !== current[component]) return candidate[component] > current[component] ? 1 : -1;
  }
  return 0;
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
const assetSchema = z.object({ name: utf8(256).min(1), browser_download_url: utf8(2048).min(1),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
const macReleaseSchema = z.object({ tag_name: utf8(63).min(1), html_url: utf8(2048).min(1), draft: z.literal(false),
  prerelease: z.boolean(), body: utf8(UPDATE_POLICY_LIMITS.notesBytes).nullable().optional(),
  assets: z.array(assetSchema).max(UPDATE_POLICY_LIMITS.assets) });
const releaseListSchema = z.array(macReleaseSchema).max(100);
const linuxTargetSchema = z.object({ url: utf8(2048).min(1), signature: utf8(UPDATE_POLICY_LIMITS.signatureBytes)
  .refine((value) => value.trim().length > 0), size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() });
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
/** Preview releases use the same canonical numeric version triplet as stable releases.
 * A preview consumes its version; a later stable release must have a greater triplet. */
export function selectLatestPreviewRelease(value: unknown): Readonly<{ version: string; release: z.infer<typeof macReleaseSchema> }> | undefined {
  return metadata(() => {
    const releases = releaseListSchema.parse(value);
    // A full page cannot establish which preview is newest without following an untrusted Link URL.
    if (releases.length === 100) throw new UpdatePolicyError("INVALID_METADATA");
    let selected: { version: string; release: z.infer<typeof macReleaseSchema> } | undefined;
    const versions = new Set<string>();
    for (const release of releases) {
      if (!release.prerelease) continue;
      if (!release.tag_name.startsWith("v")) throw new UpdatePolicyError("INVALID_VERSION");
      const version = release.tag_name.slice(1);
      try { parseUpdateVersion(version); } catch { throw new UpdatePolicyError("INVALID_VERSION"); }
      if (release.tag_name !== `v${version}` || release.html_url !== `${LINUX_UPDATE_REPOSITORY}/releases/tag/v${version}` || versions.has(version)) {
        throw new UpdatePolicyError("INVALID_SOURCE");
      }
      versions.add(version);
      if (!selected || compare(parseUpdateVersion(version), parseUpdateVersion(selected.version)) > 0) selected = { version, release };
    }
    return selected && Object.freeze(selected);
  });
}
interface Candidate {
  readonly authentication: "unauthenticated"; readonly channel: UpdateChannel; readonly details: UpdateDetails;
  readonly version: string; readonly notes: string; readonly assetName: string; readonly assetURL: string; readonly pageURL: string;
}

function boundedHighlight(value: string): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > 512) break;
    result += character;
  }
  return result.trim();
}
function plainMarkdown(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1").replace(/\*([^*]+)\*/gu, "$1").replace(/_([^_]+)_/gu, "$1").trim();
}
/** Extract only the curated What's new bullets; raw Markdown remains available to release tooling only. */
export function extractUpdateHighlights(notes: string, language: "en" | "de" = "en"): readonly string[] {
  if (Buffer.byteLength(notes, "utf8") > UPDATE_POLICY_LIMITS.notesBytes) throw new UpdatePolicyError("INVALID_METADATA");
  const lines = notes.replace(/\r\n?/gu, "\n").split("\n"), heading = lines.findIndex((line) => language === "de"
    ? /^#{1,6}\s+neu\s+in\s+openwhisper\b/iu.test(line)
    : /^#{1,6}\s+what['’]s\s+new\b/iu.test(line));
  if (heading < 0) return Object.freeze([]);
  const bullets: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (/^#{1,6}\s+/u.test(line)) break;
    const bullet = /^\s*[-*+]\s+(.+?)\s*$/u.exec(line);
    if (bullet) { if (bullets.length === 5) break; bullets.push(bullet[1]!); }
    else if (bullets.length && /^\s{2,}\S/u.test(line)) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  return Object.freeze(bullets.map((item) => boundedHighlight(plainMarkdown(item))).filter(Boolean));
}
function details(notes: string, size: number | undefined): UpdateDetails {
  const highlights = extractUpdateHighlights(notes, "en"), german = extractUpdateHighlights(notes, "de");
  return updateDetailsSchema.parse({ highlights,
    ...(german.length ? { localized_highlights: { en: highlights, de: german } } : {}),
    ...(size === undefined ? {} : { size }) });
}
export interface MacosUpdateCandidate extends Candidate { readonly package: "macos"; readonly repository: string }
export interface LinuxUpdateCandidate extends Candidate {
  readonly package: "deb" | "appimage"; readonly feedURL: string; readonly target: "linux-x86_64-deb" | "linux-x86_64-appimage";
  /** Opaque announced signature text; this projection performs no cryptographic verification. */
  readonly signature: string;
}

/** Projects required API fields only. Exact source policy does not authenticate downloaded bytes. */
export function projectMacosUpdateRelease(options: {
  readonly repository: unknown; readonly currentVersion: unknown; readonly release: unknown; readonly channel?: UpdateChannel;
}): MacosUpdateCandidate {
  const repository = macosRepository(options.repository);
  const channel = options.channel ?? "stable";
  if (channel !== "stable" && channel !== "preview") throw new UpdatePolicyError("INVALID_CHANNEL");
  return metadata(() => {
    const source = record(options.release), assets = own(source, "assets");
    // Refuse excessive arrays before the schema visits their elements.
    if (!Array.isArray(assets) || assets.length > UPDATE_POLICY_LIMITS.assets) throw new UpdatePolicyError("INVALID_METADATA");
    const release = macReleaseSchema.parse({ tag_name: own(source, "tag_name"), html_url: own(source, "html_url"),
      draft: own(source, "draft"), prerelease: own(source, "prerelease"), body: optional(source, "body"),
      assets: assets.map((item: unknown) => { const asset = record(item), size = optional(asset, "size"); return { name: own(asset, "name"), browser_download_url: own(asset, "browser_download_url"),
        ...(size === undefined ? {} : { size }) }; }) });
    if (release.prerelease !== (channel === "preview")) throw new UpdatePolicyError("INVALID_SOURCE");
    if (!release.tag_name.startsWith("v")) throw new UpdatePolicyError("INVALID_VERSION");
    const version = release.tag_name.slice(1); requireNewer(version, options.currentVersion);
    const matches = release.assets.filter((asset) => asset.name === MACOS_UPDATE_ASSET);
    const assetURL = `https://github.com/${repository}/releases/download/v${version}/${MACOS_UPDATE_ASSET}`;
    const pageURL = `https://github.com/${repository}/releases/tag/v${version}`;
    if (matches.length !== 1 || matches[0]?.browser_download_url !== assetURL || release.html_url !== pageURL) throw new UpdatePolicyError("INVALID_SOURCE");
    return Object.freeze({ authentication: "unauthenticated", channel, package: "macos", repository, version, notes: release.body ?? "",
      details: details(release.body ?? "", matches[0]!.size),
      assetName: MACOS_UPDATE_ASSET, assetURL, pageURL });
  });
}

/** Package kind must come from actual installation admission, not a displayed package label. */
export function projectLinuxUpdateFeed(options: {
  readonly sourceURL: unknown; readonly package: unknown; readonly currentVersion: unknown; readonly feed: unknown; readonly channel?: UpdateChannel;
}): LinuxUpdateCandidate {
  const channel = options.channel ?? "stable";
  if (channel !== "stable" && channel !== "preview") throw new UpdatePolicyError("INVALID_CHANNEL");
  if (options.package !== "deb" && options.package !== "appimage") throw new UpdatePolicyError("INVALID_PACKAGE");
  const packageKind = options.package;
  return metadata(() => {
    const source = record(options.feed), release = linuxReleaseSchema.parse({ version: own(source, "version"), notes: optional(source, "notes") });
    const expectedFeedURL = channel === "stable" ? LINUX_UPDATE_FEED_URL : `${LINUX_UPDATE_REPOSITORY}/releases/download/v${release.version}/latest.json`;
    if (options.sourceURL !== expectedFeedURL) throw new UpdatePolicyError("INVALID_SOURCE");
    requireNewer(release.version, options.currentVersion);
    const target = packageKind === "deb" ? "linux-x86_64-deb" : "linux-x86_64-appimage";
    const assetName = packageKind === "deb" ? "OpenWhisper-Linux-amd64.deb" : "OpenWhisper-Linux-x86_64.AppImage";
    const announced = record(own(record(own(source, "platforms")), target));
    const size = optional(announced, "size");
    const artifact = linuxTargetSchema.parse({ url: own(announced, "url"), signature: own(announced, "signature"), ...(size === undefined ? {} : { size }) });
    const assetURL = `${LINUX_UPDATE_REPOSITORY}/releases/download/v${release.version}/${assetName}`;
    if (artifact.url !== assetURL) throw new UpdatePolicyError("INVALID_SOURCE");
    return Object.freeze({ authentication: "unauthenticated", channel, package: packageKind, version: release.version, notes: release.notes ?? "",
      details: details(release.notes ?? "", artifact.size),
      assetName, assetURL, pageURL: `${LINUX_UPDATE_REPOSITORY}/releases/tag/v${release.version}`, feedURL: expectedFeedURL,
      target, signature: artifact.signature });
  });
}

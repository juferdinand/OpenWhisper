import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { resolve } from "node:path";
import { validateMacBundleMetadata } from "./build-selection.js";
import type { BuildIdentity } from "../contracts/build-identity.js";
import { StableMigrationError } from "../contracts/stable-migration.js";
import { legacyMacosMigrationContextSchema, type LegacyMacosMigrationContext } from "../services/legacy-macos-data.js";
import { parseModelCatalog, recommendationsFor } from "../core/model-catalog.js";

/** Inspect only the selected package. This verifies its ad-hoc validation signature, not release-key continuity. */
export function verifyMacApplicationBundle(identity: BuildIdentity, version: string, executable: string): void {
  if (process.platform !== "darwin") throw new Error("Mac bundle admission requires Darwin.");
  const bundle = resolve(executable, "../../..");
  const signature = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle],
    { encoding: "utf8", shell: false, timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (signature.error || signature.status !== 0) throw new Error("The Mac package signature is invalid.");
  const info = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${bundle}/Contents/Info.plist`],
    { encoding: "utf8", shell: false, timeout: 5000, maxBuffer: 1024 * 1024 });
  if (info.error || info.status !== 0) throw new Error("The Mac package metadata is unavailable.");
  let metadata: unknown;
  try { metadata = JSON.parse(info.stdout); } catch { throw new Error("The Mac package metadata is invalid."); }
  validateMacBundleMetadata(identity, version, metadata);
}

export interface MacosLoginFact { readonly requested: boolean; readonly pending: boolean;
  readonly status: "enabled" | "requires-approval" | "not-registered" }
/** Unknown OS service state must not silently disable a saved/requested login item. */
export function macosLoginFact(status: unknown): MacosLoginFact {
  if (status === "enabled") return { requested: true, pending: false, status };
  if (status === "requires-approval") return { requested: true, pending: true, status };
  if (status === "not-registered") return { requested: false, pending: false, status };
  throw new StableMigrationError("LOGIN_STATE_UNKNOWN");
}

/** The admitted main supplies languages/login state; architecture preserves the native compile-architecture policy. */
export function macosMigrationContext(input: { readonly languages: readonly string[]; readonly architecture: string;
  readonly physicalMemory?: number; readonly loginStatus: unknown; readonly catalog: unknown }): LegacyMacosMigrationContext {
  // Legacy requested state was true only for enabled or pending approval. A
  // known absent service is preserved for migration, without granting control.
  const login = input.loginStatus === "not-found" ? { status: "not-found" as const, requested: false } : macosLoginFact(input.loginStatus);
  const catalog = parseModelCatalog(input.catalog);
  const memory = input.physicalMemory ?? totalmem();
  if (!Number.isFinite(memory) || memory <= 0 || !["arm64", "x64"].includes(input.architecture) ||
      input.languages.some((language) => typeof language !== "string" || language.length > 128)) throw new Error("Invalid Mac migration facts.");
  const appleSilicon = input.architecture === "arm64", language = input.languages[0] ?? "";
  const prefix = Array.from(language).slice(0, 2).join("");
  const tier = !appleSilicon ? "cpuOnly" : Math.round(memory / 1_073_741_824) >= 8 ? "strong" : "weak";
  return legacyMacosMigrationContextSchema.parse({ systemLanguage: language, loginStatus: login.status, defaults: { appleSilicon, launchAtLogin: login.requested,
    recommendedModel: recommendationsFor(catalog, tier, language ? prefix : "en")[0]?.id ?? "large-v3-turbo-q5_0" } });
}

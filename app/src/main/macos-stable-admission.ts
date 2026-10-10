import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { validateMacBundleMetadata } from "./build-selection.js";
import type { BuildIdentity } from "../contracts/application/build-identity.js";
import { StableMigrationError } from "../contracts/migration/stable-migration.js";
import { legacyMacosMigrationContextSchema, type LegacyMacosMigrationContext } from "../services/migration/legacy-macos-data.js";
import { parseModelCatalog, recommendationsFor } from "../core/models/catalog.js";

const bundleSignals = ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL"] as const;
const bundleFailureSchema = z.strictObject({
  code: z.enum(["signature-timeout", "signature-output-limit", "signature-spawn", "signature-signal", "signature-exit",
    "metadata-timeout", "metadata-output-limit", "metadata-spawn", "metadata-signal", "metadata-exit", "metadata-json", "metadata-mismatch"]),
  status: z.number().int().min(0).max(255).nullable(), signal: z.enum([...bundleSignals, "other"]).nullable(),
  elapsedMs: z.number().int().min(0).max(20_000),
}).readonly();
type BundleFailure = z.infer<typeof bundleFailureSchema>;
type BundleToolResult = Readonly<{ status: unknown; signal: unknown; error?: unknown }>;

/** Owned diagnostics contain no tool output, arguments, paths or exception messages. */
export class MacBundleAdmissionError extends Error {
  readonly observation: BundleFailure;
  constructor(observation: unknown) {
    const admitted = bundleFailureSchema.parse(observation);
    super(admitted.code); this.name = "MacBundleAdmissionError"; this.observation = admitted;
  }
}
function bundleFailure(code: BundleFailure["code"], result: BundleToolResult, elapsedMs: number): MacBundleAdmissionError {
  return new MacBundleAdmissionError({ code,
    status: typeof result.status === "number" && Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : null,
    signal: result.signal == null ? null : bundleSignals.find((signal) => signal === result.signal) ?? "other",
    // Synchronous tool observation only; this cap never changes the tool deadline.
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.min(20_000, Math.floor(elapsedMs))) : 0 });
}
/** Pure result classification; success retains the existing error/status gate exactly. */
export function macBundleToolFailure(tool: "signature" | "metadata", result: BundleToolResult, elapsedMs: number): MacBundleAdmissionError | undefined {
  if (!result.error && result.status === 0) return undefined;
  let code: unknown;
  try { if (result.error instanceof Error && "code" in result.error) code = result.error.code; }
  catch { /* Unreadable exception details remain a generic fixed spawn failure. */ }
  const reason = result.error ? code === "ETIMEDOUT" ? "timeout" : code === "ENOBUFS" ? "output-limit" : "spawn"
    : result.signal ? "signal" : "exit";
  return bundleFailure(`${tool}-${reason}`, result, elapsedMs);
}
/** Formatter revalidates the closed fields; structural lookalikes and altered observations stay generic. */
export function readMacBundleFailure(error: unknown): BundleFailure | undefined {
  try {
    if (error instanceof MacBundleAdmissionError) {
      const value = bundleFailureSchema.safeParse(error.observation); if (value.success) return value.data;
    }
  } catch { /* Never reveal unreadable exception fields. */ }
  return undefined;
}

/** Inspect only the selected package. This verifies its ad-hoc validation signature, not release-key continuity. */
export function verifyMacApplicationBundle(identity: BuildIdentity, version: string, executable: string): void {
  if (process.platform !== "darwin") throw new Error("Mac bundle admission requires Darwin.");
  const bundle = resolve(executable, "../../..");
  const signatureStarted = performance.now();
  // Cold Intel runners can take longer to verify every nested slice in a universal bundle.
  const signature = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle],
    { encoding: "utf8", shell: false, timeout: 60_000, maxBuffer: 1024 * 1024 });
  const signatureFailure = macBundleToolFailure("signature", signature, performance.now() - signatureStarted);
  if (signatureFailure) throw signatureFailure;
  const metadataStarted = performance.now();
  const info = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${bundle}/Contents/Info.plist`],
    { encoding: "utf8", shell: false, timeout: 5000, maxBuffer: 1024 * 1024 });
  const metadataFailure = macBundleToolFailure("metadata", info, performance.now() - metadataStarted);
  if (metadataFailure) throw metadataFailure;
  let metadata: unknown;
  try { metadata = JSON.parse(info.stdout); }
  catch { throw bundleFailure("metadata-json", info, performance.now() - metadataStarted); }
  try { validateMacBundleMetadata(identity, version, metadata); }
  catch { throw bundleFailure("metadata-mismatch", info, performance.now() - metadataStarted); }
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

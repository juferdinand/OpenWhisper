import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { buildIdentitySchema, type BuildIdentity } from "../contracts/build-identity.js";
import { MacosUpdateSignatureError, verifyMacosUpdateSignature } from "../services/macos-update-signature.js";
import { parseUpdateVersion } from "../services/update-policy.js";

export const macosUpdateBuildSchema = z.strictObject({ version: z.literal(1),
  repository: z.literal("juferdinand/OpenWhisper"), certificateFingerprint: z.string().regex(/^[a-f0-9]{40}$/u) }).readonly();
export interface MacosUpdateAdmission {
  readonly repository: "juferdinand/OpenWhisper";
  readonly bundle: string;
  readonly executable: string;
}
interface Effects {
  readonly platform: string;
  readonly uid: number | undefined;
  canonical(path: string): string;
  writableParent(path: string): void;
  verifyPublisher(bundle: string, fingerprint: string): void;
  verifyRunningBundle(bundle: string): void;
}
export type MacosUpdateAdmissionObservation = Readonly<{ stage: "input" | "path" | "publisher" | "self" | "complete";
  outcome: "accepted" | "refused"; reason?: "INVALID_INPUT" | "TIMEOUT" | "SPAWN" | "SIGNAL" | "EXIT" | "SIGNATURE" | "UNAVAILABLE" }>;
let lastObservation: MacosUpdateAdmissionObservation | undefined;
class PublisherVerificationError extends Error {
  constructor(readonly reason: "TIMEOUT" | "SPAWN" | "SIGNAL" | "EXIT") { super(reason); }
}
/** Trusted main-process diagnostic for the original optional admission attempt; contains no path or tool output. */
export function getLastMacosUpdateAdmissionObservation(): MacosUpdateAdmissionObservation | undefined { return lastObservation; }

/** Fixed code-signing arguments also reject an ad-hoc self with an enabled build literal. */
// https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html
export function macosUpdatePublisherArguments(bundle: string, fingerprint: string): readonly string[] {
  if (!/^[a-f0-9]{40}$/u.test(fingerprint)) throw new Error("Invalid Mac update publisher.");
  return ["--verify", "--deep", "--strict", "--all-architectures", "--test-requirement",
    `certificate leaf = H\"${fingerprint}\"`, bundle];
}
const effects: Effects = { platform: process.platform, uid: process.getuid?.(), canonical: realpathSync,
  writableParent: (path) => accessSync(path, constants.W_OK | constants.X_OK),
  verifyRunningBundle: verifyMacosUpdateSignature,
  verifyPublisher: (bundle, fingerprint) => {
    const result = spawnSync("/usr/bin/codesign", [...macosUpdatePublisherArguments(bundle, fingerprint)], {
      shell: false, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" } });
    if (result.error) {
      const reason = "code" in result.error && result.error.code === "ETIMEDOUT" ? "TIMEOUT" : "SPAWN";
      throw new PublisherVerificationError(reason);
    }
    if (result.signal !== null) throw new PublisherVerificationError("SIGNAL");
    if (result.status !== 0) throw new PublisherVerificationError("EXIT");
  } };

/** Optional host capability: no environment, preference, receipt or IPC value can enable it. */
export function admitMacosUpdates(input: { readonly policy: unknown; readonly identity: BuildIdentity;
  readonly packaged: boolean; readonly currentVersion: string; readonly executable: string },
  trusted: Effects = effects): Readonly<MacosUpdateAdmission> | undefined {
  let stage: MacosUpdateAdmissionObservation["stage"] = "input";
  const report = (value: MacosUpdateAdmissionObservation): void => { lastObservation = Object.freeze(value); };
  try {
    if (trusted.platform !== "darwin" || trusted.uid === undefined || trusted.uid === 0 || !input.packaged ||
        buildIdentitySchema.parse(input.identity).kind !== "stable") { report({ stage, outcome: "refused", reason: "INVALID_INPUT" }); return undefined; }
    const policy = macosUpdateBuildSchema.parse(input.policy); parseUpdateVersion(input.currentVersion);
    stage = "path";
    const executable = input.executable;
    if (!isAbsolute(executable) || resolve(executable) !== executable || /[\p{Cc}]/u.test(executable) ||
        trusted.canonical(executable) !== executable || basename(executable) !== "OpenWhisper") { report({ stage, outcome: "refused", reason: "INVALID_INPUT" }); return undefined; }
    const bundle = resolve(executable, "../../..");
    if (basename(bundle) !== "OpenWhisper.app" || executable !== join(bundle, "Contents/MacOS/OpenWhisper") ||
        trusted.canonical(bundle) !== bundle) { report({ stage, outcome: "refused", reason: "INVALID_INPUT" }); return undefined; }
    trusted.writableParent(dirname(bundle));
    stage = "publisher";
    trusted.verifyPublisher(bundle, policy.certificateFingerprint);
    // Bind that exact on-disk bundle to the original process's designated requirement.
    report({ stage, outcome: "accepted" }); stage = "self";
    trusted.verifyRunningBundle(bundle);
    report({ stage, outcome: "accepted" });
    stage = "complete";
    report({ stage, outcome: "accepted" });
    return Object.freeze({ repository: policy.repository, bundle, executable });
  } catch (error: unknown) {
    const reason = error instanceof PublisherVerificationError ? error.reason : error instanceof MacosUpdateSignatureError ? "SIGNATURE" : "UNAVAILABLE";
    report({ stage, outcome: "refused", reason }); return undefined;
  }
}

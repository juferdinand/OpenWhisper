import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { buildIdentitySchema, type BuildIdentity } from "../contracts/build-identity.js";
import { verifyMacosUpdateSignature } from "../services/macos-update-signature.js";
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
      shell: false, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" } });
    if (result.error || result.status !== 0 || result.signal !== null) throw new Error("Mac update publisher is unavailable.");
  } };

/** Optional host capability: no environment, preference, receipt or IPC value can enable it. */
export function admitMacosUpdates(input: { readonly policy: unknown; readonly identity: BuildIdentity;
  readonly packaged: boolean; readonly currentVersion: string; readonly executable: string },
  trusted: Effects = effects): Readonly<MacosUpdateAdmission> | undefined {
  try {
    if (trusted.platform !== "darwin" || trusted.uid === undefined || trusted.uid === 0 || !input.packaged ||
        buildIdentitySchema.parse(input.identity).kind !== "stable") return undefined;
    const policy = macosUpdateBuildSchema.parse(input.policy); parseUpdateVersion(input.currentVersion);
    const executable = input.executable;
    if (!isAbsolute(executable) || resolve(executable) !== executable || /[\p{Cc}]/u.test(executable) ||
        trusted.canonical(executable) !== executable || basename(executable) !== "OpenWhisper") return undefined;
    const bundle = resolve(executable, "../../..");
    if (basename(bundle) !== "OpenWhisper.app" || executable !== join(bundle, "Contents/MacOS/OpenWhisper") ||
        trusted.canonical(bundle) !== bundle) return undefined;
    trusted.writableParent(dirname(bundle));
    trusted.verifyPublisher(bundle, policy.certificateFingerprint);
    // Bind that exact on-disk bundle to the original process's designated requirement.
    trusted.verifyRunningBundle(bundle);
    return Object.freeze({ repository: policy.repository, bundle, executable });
  } catch { return undefined; }
}

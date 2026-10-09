import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const version = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const source = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) });
export const artifactSchema = z.strictObject({ bytes: z.number().int().positive().max(1024 ** 3), sha256: hash });
export const candidateReceiptSchema = z.strictObject({ version: z.literal(1),
  classification: z.literal("CANONICAL_STABLE_VALIDATION_ONLY"), source, sourceVersion: version,
  files: z.record(z.string(), artifactSchema.extend({ bytes: z.number().int().nonnegative().max(1024 ** 3) })),
  modes: z.record(z.string(), z.number().int().min(0).max(0o7777)) });
const packageInput = z.strictObject({ source, sourceVersion: version, archive: artifactSchema, receiptSha256: hash });
export const upgradeInputSchema = z.strictObject({ older: packageInput, newer: packageInput });
export type UpgradeInput = z.infer<typeof upgradeInputSchema>;
export const installRequestSchema = z.strictObject({ path: z.string().regex(/^\/tmp\/openwhisper-owned-upgrade-[A-Za-z0-9]+\/home\/cache\/whisperfree\/electron\/cache\/update-download-[A-Za-z0-9]{6}\/OpenWhisper-Linux-amd64\.deb$/u),
  archive: artifactSchema, originalGui: z.number().int().positive(), originalNative: z.array(z.number().int().positive()).max(32) });
export const installResponseSchema = z.strictObject({ code: z.literal(0), signal: z.null(), pid: z.number().int().positive(),
  originalClosed: z.literal(true), originalAbsent: z.literal(true), originalGuiAbsent: z.literal(true), originalNativeAbsent: z.literal(true) });
export const resultSchema = z.object({ status: z.literal("PASS"), classification: z.literal("SIGNED_DEBIAN_GUI_UPGRADE_COMPOSITION"),
  fromVersion: version, toVersion: version, supervisorPid: z.number().int().positive(), sameStartTicks: z.literal(true),
  originalGuiAbsentBeforeInstall: z.literal(true), originalNativeAbsentBeforeInstall: z.literal(true),
  sourceClosedBeforeExec: z.literal(true), actualFixedExec: z.literal(true), successorVersionAndSource: z.literal(true),
  preferencesPreserved: z.literal(true), originalNormalQuit: z.literal(true), descendantsAbsent: z.literal(true),
  scope: z.literal("OWNED_OFFLINE_FEED_AND_NAMESPACE_INSTALLER_NO_HTTPS_OR_POLKIT") });

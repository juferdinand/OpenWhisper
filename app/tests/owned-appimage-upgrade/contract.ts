import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const artifactSchema = z.strictObject({ bytes: z.number().int().positive().max(1024 ** 3), sha256: hash });
export const inputImageSchema = z.strictObject({ version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
  source: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/u), modified: z.literal(false) }),
  filename: z.literal("OpenWhisper-Linux-x86_64.AppImage"), image: artifactSchema, signature: artifactSchema });
export const updateInputSchema = z.strictObject({ repository: z.literal("https://github.com/juferdinand/OpenWhisper"),
  older: inputImageSchema, newer: inputImageSchema }).refine((value) => value.older.version === "0.3.0" && value.newer.version === "0.3.1" &&
    value.older.source.commit === "16bb0af50432a59a1e741261497d0d6490e83fe7" && value.newer.source.commit === "8433def6e76231410569cad40909ad85c234893e");
export type UpgradeInput = z.infer<typeof updateInputSchema>;
export const resultSchema = z.strictObject({ status: z.literal("PASS"), classification: z.literal("SIGNED_APPIMAGE_GUI_UPGRADE_WITH_OWNED_OLDER_APPRUN_FIXTURE"),
  fromVersion: z.literal("0.3.0"), toVersion: z.literal("0.3.1"), supervisorPid: z.number().int().positive(), sameStartTicks: z.literal(true),
  oldGuiClosedBeforeExec: z.literal(true), oldNativeOwnersClosedBeforeExec: z.literal(true), sourceFdClosedBeforeExec: z.literal(true),
  sourceStageAbsentBeforeExec: z.literal(true), sourceClosedBeforeExec: z.literal(true),
  actualFixedExec: z.literal(true), successorVersionAndSource: z.literal(true), preferencesPreserved: z.literal(true),
  normalQuit: z.literal(true), descendantsAbsent: z.literal(true), scope: z.literal("OFFLINE_PRIVATE_SIGNED_IMAGES_NO_HOST_DESKTOP_AUDIO_DEVICES_OR_NETWORK") });

import { z } from "zod";

export const ownedGpuModeSchema = z.enum(["no-device", "software-only", "loader-absent"]);
export type OwnedGpuMode = z.infer<typeof ownedGpuModeSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ownedGpuInputSchema = z.strictObject({ mode: ownedGpuModeSchema,
  cpuSha256: digest, vulkanSha256: digest, electronSha256: digest,
});
const ownerSchema = z.strictObject({ pid: z.number().int().positive(), creationTime: z.number().finite().positive(),
  nativeSha256: digest, loaderPaths: z.array(z.string().min(1).max(4096)).max(10),
});
export const ownedGpuResultSchema = z.strictObject({ result: z.literal("PASS"), mode: ownedGpuModeSchema,
  checks: z.array(z.string().min(1).max(1024)).min(3).max(10), mainAlive: z.literal(true),
  cpuSha256: digest, vulkanSha256: digest, owners: z.array(ownerSchema).min(1).max(2),
  inference: z.array(z.strictObject({ family: z.enum(["whisper", "parakeet"]), requestedGpu: z.boolean(),
    sha256: digest, characters: z.number().int().positive().max(16384), seconds: z.number().finite().nonnegative(),
  })).min(1).max(4),
  nativeDevice: z.null(), startupFailure: z.literal("START_FAILED").nullable(),
  explicitFixtureCpuReplacement: z.boolean(), versions: z.record(z.string(), z.string()), scope: z.string().max(4096),
}).refine((value) => value.mode === "loader-absent"
  ? value.startupFailure === "START_FAILED" && value.explicitFixtureCpuReplacement && value.inference.length === 1
  : value.startupFailure === null && !value.explicitFixtureCpuReplacement && value.inference.length === 4,
"Owned backend result must describe its actual test mode.");

import { z } from "zod";

/** Build selection is fixed by source compilation, never a renderer or launch argument. */
export const buildIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ version: z.literal(1), kind: z.literal("development"),
    appId: z.literal("io.github.whisperfree.dev"), productName: z.literal("OpenWhisper Dev") }),
  z.strictObject({ version: z.literal(1), kind: z.literal("stable"),
    appId: z.literal("io.github.whisperfree"), productName: z.literal("OpenWhisper") }),
]).readonly();
export type BuildIdentity = z.infer<typeof buildIdentitySchema>;

/** Inspect only the fixed JSON-literal export; never execute package inputs. */
export function parseApplicationBuildModule(source: string): BuildIdentity {
  const match = /^\s*(export\s+)?const APPLICATION_BUILD(?:\s*:\s*unknown)?\s*=\s*(\{[^]*?\});\s*(export\s*\{\s*APPLICATION_BUILD\s*\};)?\s*$/u.exec(source);
  if (!match?.[2] || Boolean(match[1]) === Boolean(match[3])) throw new Error("A captured application build identity is required.");
  return buildIdentitySchema.parse(JSON.parse(match[2]) as unknown);
}

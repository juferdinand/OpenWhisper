import { z } from "zod";
import { baselineAbi, foreignSchema, packageSchema } from "./launch-contracts.js";
import { retainedPinsSchema } from "./retained-contracts.js";

export const SERVICE_SOURCE_SHA = "6f122f6c3bcb831979ac9eb07256261297d902966b78bba6837bbdfaae116451";
export const SERVICE_SOURCE = "/owned-app/tests/owned-bus/service.cpp";
export const SERVICE_BINARY = "/owned-app/tests/owned-bus/service";
export const remainingProfiles = Object.freeze(["cleanup", "legacy"] as const);
export type RemainingProfile = typeof remainingProfiles[number];
export const remainingPackageSchema = packageSchema.extend({ mode: z.literal("retained-remaining-profiles"),
  retained: retainedPinsSchema, profiles: z.tuple([z.literal("cleanup"), z.literal("legacy")]),
  serviceSource: z.literal(SERVICE_SOURCE_SHA) });

const allowedFlags = new Set(["-I/usr/include/gio-unix-2.0", "-I/usr/include/glib-2.0",
  "-I/usr/lib/x86_64-linux-gnu/glib-2.0/include", "-pthread", "-I/usr/include/libmount", "-I/usr/include/blkid",
  "-lgio-2.0", "-lgobject-2.0", "-lglib-2.0"]);
/** Only the fixed installed image's GIO flags; never shell text or addon inputs. */
export function serviceCompileArguments(output: string): readonly string[] {
  if (Buffer.byteLength(output) > 4096) throw new Error("Service flags exceeded their bound.");
  const flags = output.trim().split(/\s+/u);
  if (flags.length !== allowedFlags.size || new Set(flags).size !== allowedFlags.size ||
      flags.some((flag) => !allowedFlags.has(flag))) throw new Error("Installed service flags differ from the reviewed whitelist.");
  return ["/usr/bin/c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", SERVICE_SOURCE, "-o", SERVICE_BINARY, ...flags];
}
export function validateServiceMetadata(metadata: Readonly<Record<string, string>>): Readonly<Record<string, readonly string[]>> {
  if (metadata["compiler.txt"]?.split("\n")[0] !== "c++ (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0" ||
      metadata["gio-version.txt"] !== "2.72.4" || !metadata["service-elf-header.txt"]?.includes("ELF64") ||
      !metadata["service-elf-header.txt"]?.includes("Advanced Micro Devices X86-64") ||
      !metadata["service-elf-symbols.txt"]?.includes("g_dbus_connection_call_sync")) throw new Error("Service baseline metadata differs.");
  const dynamic = metadata["service-elf-dynamic.txt"] ?? "";
  const libraries = [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/gu)].map((match) => match[1]);
  const permitted = new Set(["libgio-2.0.so.0", "libgobject-2.0.so.0", "libglib-2.0.so.0", "libstdc++.so.6", "libgcc_s.so.1", "libc.so.6"]);
  if (libraries.length === 0 || libraries.some((name) => name === undefined || !permitted.has(name)) ||
      !libraries.includes("libgio-2.0.so.0") || /\((?:RPATH|RUNPATH)\)/u.test(dynamic)) throw new Error("Service links unexpected libraries or paths.");
  return baselineAbi(metadata["service-elf-versions.txt"] ?? "");
}
/** Both values come from the original owned marker; no well-known replacement. */
export function foreignCommand(value: unknown): readonly string[] {
  const marker = foreignSchema.parse(value);
  return [SERVICE_BINARY, marker.address, "foreign-control", marker.owner];
}
export function validateForeignReply(value: unknown): void {
  z.strictObject({ code: z.literal(0), stdout: z.literal("FOREIGN_UID_DENIED:1001"), stderr: z.literal("") }).parse(value);
}
/** Serial order and first refusal are part of the reviewed execution contract. */
export async function runRemainingProfiles(run: (profile: RemainingProfile) => Promise<void>): Promise<void> {
  for (const profile of remainingProfiles) await run(profile);
}

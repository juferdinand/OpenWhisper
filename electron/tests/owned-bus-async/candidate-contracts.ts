import { z } from "zod";
import { frozenCore, packageSchema } from "../owned-bus-opening/launch-contracts.js";
import { LEGACY_BASE_SHA, serviceReuseSchema, SERVICE_SHA } from "../owned-bus-opening/legacy-retained-contracts.js";
import { RETAINED_SHA } from "../owned-bus-opening/retained-contracts.js";
import { asyncCallResultSchema } from "./contracts.js";

export const candidateProfileSchema = z.enum(["opening", "cleanup", "async", "legacy"]);
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;
export const candidateCore: Readonly<Record<string, string>> = Object.freeze({ ...frozenCore,
  "native/linux-bus/binding.cpp": "807e2703bfcc11edb7ccc59ce4430d86e1e1c3b4dd476cbcefcf896a519f4e36",
  "native/linux-bus/codec.cpp": "143c8ad36ede0985b377adfc23001d8dc579c34c2a0b4ca920586dc0fe8b0413",
  "tests/owned-bus-async/scenarios.ts": "b13ef7969fe86d97d2709252e3f946e7316f95d17f54cfdc32423340c8a24c17",
  "tests/owned-bus-async/contracts.ts": "227baf39f030fe838de1fe594faa65e016e1cd9e33d7a5480685ea55dd43b84c",
  "tests/owned-bus-async/contracts.test.ts": "6aa94e9e6c118bbefd17182663513082eb2bb5aac9c6d6849bfb4975455cc67b",
});
export const candidatePackageSchema = packageSchema.extend({ mode: z.literal("candidate-async-native-build"),
  service: serviceReuseSchema, legacyBase: z.literal(LEGACY_BASE_SHA),
  profiles: z.tuple([z.literal("opening"), z.literal("cleanup"), z.literal("async"), z.literal("legacy")]) });
export const asyncUtilityResultSchema = asyncCallResultSchema.extend({ pid: z.number().int().positive(), uid: z.literal(1000), nativeApi: z.literal(8) });
export const asyncRequestSchema = z.strictObject({ version: z.literal(1), id: z.uuid(), command: z.literal("run"),
  address: z.string().max(1024).regex(/^unix:path=\/tmp\/openwhisper-owned-bus(?:,guid=[a-f0-9]{32})?$/u) });
export function candidateBuildPlan(): readonly (readonly string[])[] {
  return [["cmake", "-S", "/owned-app/native-linux-bus", "-B", "/owned-app/native-linux-bus/build", "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "-DCMAKE_CXX_STANDARD=17",
    "-DCMAKE_CXX_STANDARD_REQUIRED=ON", "-DCMAKE_CXX_EXTENSIONS=OFF", "-DNODE_HEADERS=/owned-app/vendor/node-headers/include/node"],
    ["cmake", "--build", "/owned-app/native-linux-bus/build", "--parallel", "4"]];
}
export function validateCandidateArtifactHashes(value: unknown, nativeHash: unknown): void {
  const digest = z.string().regex(/^[a-f0-9]{64}$/u).parse(nativeHash);
  if (digest === RETAINED_SHA) throw new Error("Candidate must not relabel the retained addon.");
  z.literal(`${digest}  /owned-app/dist/native/openwhisper_linux_bus.node\n${SERVICE_SHA}  /owned-app/tests/owned-bus/service`).parse(value);
}
export function validateCandidateNativeInputHashes(value: unknown): void {
  const names = ["CMakeLists.txt", "binding.cpp", "codec.cpp", "codec.hpp"];
  const expected = names.map((name) => `${candidateCore[`native/linux-bus/${name}`]}  /owned-app/native-linux-bus/${name}`).join("\n");
  z.literal(expected).parse(value);
}

import { performance } from "node:perf_hooks";
import { z } from "zod";
import { speechChallengeReplySchema } from "../../src/workers/speech/speech-control.js";

export const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const abiSchema = z.strictObject({ version: z.literal(1), role: z.literal("production"), napiVersion: z.literal(8),
  mainOnly: z.literal(true), zombieLookupArgument: z.literal(1), probeOnly: z.literal(false) });
export const exportNames = Object.freeze(["abi", "bindCandidate", "close", "create", "observe"]);
export const sourceNames = Object.freeze(["tests/owned-macos-production-retirement.test.ts", "tests/owned-macos-production-retirement/contracts.ts",
  "tests/owned-macos-production-retirement/build-fixture.ts", "tests/owned-macos-production-retirement/input.ts",
  "tests/owned-macos-production-retirement/main.ts", "tests/owned-macos-production-retirement/entry.ts", "tests/owned-macos-production-retirement/guard.ts",
  "tests/owned-macos-production-retirement/lifetime.ts",
  "src/services/platforms/macos/macos-retirement-boundary.ts", "src/services/platforms/macos/macos-process-retirement.ts", "src/workers/speech/speech-control.ts"]);
export const payloadNames = Object.freeze(["main.mjs", "entry.mjs", "guard.mjs"]);
export const distributionNames = Object.freeze(["services/platforms/macos/macos-retirement-boundary.js", "services/platforms/macos/macos-process-retirement.js", "workers/speech/speech-control.js"]);
const hashes = z.record(z.string().min(1).max(4096), digest);
const headers = z.strictObject({ version: z.literal("24.21.0"), napiVersion: z.literal(8),
  sha256: z.literal("57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2"),
  source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt") });
const license = z.strictObject({ version: z.literal("24.21.0"), source: z.literal("https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE"),
  sha256: z.literal("5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace"), scope: z.string() });
export const buildSourceNames = Object.freeze(["native/macos-retirement/CMakeLists.txt", "native/macos-retirement/retirement.cpp",
  "scripts/build-macos-retirement.ts", "scripts/build-macos-retirement-production.ts", "scripts/native-dependencies.ts", "native/node-headers.json",
  "native/node-header-license.json", "native/NODE-HEADERS-LICENSE",
  ...["node_api.h", "node_api_types.h", "js_native_api.h", "js_native_api_types.h"].map((name) => `vendor/node-headers/include/node/${name}`)]);
export const buildManifestSchema = z.strictObject({ version: z.literal(1), platform: z.literal("darwin"), architecture: z.enum(["arm64", "x86_64"]),
  minimumOS: z.literal("14.0"), napiVersion: z.literal(8), role: z.literal("production"), target: z.literal("openwhisper_macos_retirement"),
  probeOnly: z.literal(false), mainOnly: z.literal(true), workerSyntheticOnly: z.literal(false),
  exports: z.array(z.string()).refine((names) => names.length === exportNames.length && [...names].sort().join() === exportNames.join()),
  zombieLookupArgument: z.literal(1), headers, license, sourceHashes: hashes.refine((value) => exactHashes(value, buildSourceNames)), bindingSha256: digest,
  sdk: z.string().min(1).max(4096), sdkVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u), compiler: z.string().min(1).max(16384),
  macho: z.string().max(131072), dependencies: z.string().max(65536), scope: z.string().max(4096) });
function exactHashes(value: Record<string, string>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every((name) => digest.safeParse(value[name]).success);
}
export const inputSchema = z.strictObject({ version: z.literal(1), fixture: z.literal("macos-production-retirement"),
  architecture: z.enum(["arm64", "x64"]), bindingSha256: digest, buildManifestSha256: digest,
  nodeExecutable: z.strictObject({ path: z.string().min(1).max(4096).refine((path) => path.startsWith("/") && !path.includes("\0")),
    sha256: digest, version: z.literal("24.21.0"), architecture: z.enum(["arm64", "x64"]) }),
  sourceHashes: hashes.refine((value) => exactHashes(value, sourceNames)), payloadHashes: hashes.refine((value) => exactHashes(value, payloadNames)),
  distributionHashes: hashes.refine((value) => exactHashes(value, distributionNames)) });
export type FixtureInput = z.infer<typeof inputSchema>;
export const modeSchema = z.enum(["clean", "nonzero", "kill", "early", "fresh"]);
export const exitRequestSchema = z.strictObject({ version: z.literal(1), type: z.literal("fixture-exit") });
export const guardSchema = z.strictObject({ context: z.enum(["worker", "node"]), result: z.literal("TEARDOWN_FAILED"),
  kernelTargetProvided: z.literal(false), nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u), architecture: z.enum(["arm64", "x64"]) });
export const caseSchema = z.strictObject({ name: modeSchema, admitted: z.boolean(), initialLevel: z.enum(["running", "non-running", "reaped"]),
  firstNonceConfirmed: z.boolean(), secondNonceConfirmed: z.boolean(), sameBirthRunningConfirmed: z.boolean(),
  reservationRefused: z.literal(true), fullReapConfirmed: z.literal(true), closeReadReceiptConfirmed: z.literal(true),
  helperExitObserved: z.literal(true), exitCode: z.number().int(), elapsedMs: z.number().nonnegative().max(20000) }).superRefine((item, context) => {
    const early = item.name === "early";
    if (early ? item.admitted || item.firstNonceConfirmed || item.secondNonceConfirmed || item.sameBirthRunningConfirmed || item.initialLevel !== "reaped" :
      !item.admitted || !item.firstNonceConfirmed || !item.secondNonceConfirmed || !item.sameBirthRunningConfirmed || item.initialLevel !== "running")
      context.addIssue({ code: "custom", message: "Invalid admission evidence." });
  });
export const resultSchema = z.strictObject({ fixture: z.literal("macos-production-retirement"), architecture: z.enum(["arm64", "x64"]),
  abi: abiSchema, guards: z.array(guardSchema).length(2).refine((items) => items[0]?.context === "worker" && items[1]?.context === "node"),
  cases: z.array(caseSchema).length(5).refine((items) => items.map((item) => item.name).join() === modeSchema.options.join()),
  runtime: z.strictObject({ node: z.string(), electron: z.string(), systemVersion: z.string(), kernelRelease: z.string() }),
  inputSha256: digest, bindingSha256: digest, rendererCreated: z.literal(false), audioOperations: z.literal(0), permissionOperations: z.literal(0),
  productionFactoryWired: z.literal(false), signedHelperLoadingVerified: z.literal(false), deterministicZombieVerified: z.literal(false) });
export type FixtureResult = z.infer<typeof resultSchema>;
export type Stage = "ready" | "verify-input" | "load" | "guards" | "spawn" | "wait-absence" | "first-challenge" | "bind" | "second-challenge" |
  "observe" | "reservation" | "request-exit" | "wait-reap" | "close-read" | "helper-exit" | "complete" | "cleanup";

/** One absolute fixture deadline; late effects remain owned by their callers. */
export async function bounded<T>(effect: Promise<T>, until: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const remaining = until - performance.now(); if (remaining <= 0) throw new Error("FIXTURE_DEADLINE");
    const result = await Promise.race([effect, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error("FIXTURE_DEADLINE")); }, remaining);
    })]);
    if (performance.now() >= until) throw new Error("FIXTURE_DEADLINE"); return result;
  } finally { if (timer) clearTimeout(timer); }
}

/** Establish only this fixture's absent-at-bind precondition; native reap/close still must succeed. */
export async function waitForOriginalProcessAbsence(pid: number, until: number,
  probe: (pid: number) => void = (original) => { process.kill(original, 0); }): Promise<void> {
  for (;;) {
    if (performance.now() >= until) throw new Error("FIXTURE_DEADLINE");
    try { probe(pid); }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      if (performance.now() >= until) throw new Error("FIXTURE_DEADLINE");
      return;
    }
    await bounded(new Promise<void>((accept) => { setTimeout(accept, 5); }), until);
  }
}
export function nativeGuardCode(error: unknown): "TEARDOWN_FAILED" | "LOAD_REFUSED" {
  return error instanceof Error && "code" in error && error.code === "TEARDOWN_FAILED" ? "TEARDOWN_FAILED" : "LOAD_REFUSED";
}
export function validateOriginalChallenge(input: unknown, expected: Readonly<{ epoch: string; nonce: string; pid: number }>): void {
  const reply = speechChallengeReplySchema.parse(input);
  if (reply.epoch !== expected.epoch || reply.nonce !== expected.nonce || reply.pid !== expected.pid) throw new Error("CHALLENGE_FAILED");
}

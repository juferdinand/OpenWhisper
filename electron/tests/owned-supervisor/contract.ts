import assert from "node:assert/strict";
import { z } from "zod";
import { speechEntryGraphSchema } from "../../src/services/speech-entry-graph.js";

export const IMAGE = "sha256:3031f986bb255608939c32b3929435c929efb4ce9be398786e369b1111d73431";
export const SECCOMP_SHA256 = "4bcf8ff0af5c805b491cb621380b3980bea2aaed270c68e794687b57d811c49e";
export const ELECTRON_SHA256 = "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564";
export const NODE_SHA256 = "7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c";
export const CPU_SHA256 = "e1b4c2c738285eb50cea155e65fc0b1eb4481e80a1849ded23bb2a8a679308c3";
export const CPU_BUILD_MANIFEST_SHA256 = "ed87efb43797a90f8cfa7e0fb594b6237ae4c1a89b2b34e10f29c1d86f92c7bc";
export const MODEL_SHA256 = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";
export const PCM_SHA256 = "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0";
export const HOME = "/home/tester/supervisor-home";
export const PROFILE = `${HOME}/dev-profile`;
export class FixtureError extends Error { constructor() { super("Owned CPU supervisor fixture failed."); } }
export const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const pathSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u)
  .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."));
export const fileSchema = z.strictObject({ bytes: z.number().int().nonnegative().max(512 * 1024 * 1024), sha256: shaSchema });
export const fileInventorySchema = z.record(pathSchema, fileSchema).refine((value) => Object.keys(value).length <= 2048 &&
  Object.values(value).reduce((sum, file) => sum + file.bytes, 0) <= 2 * 1024 * 1024 * 1024);
export const cpuCatalog = Object.freeze({ version: 1, platform: "linux", architecture: "x64", napiVersion: 8,
  speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a", speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde",
  entries: [{ backend: "cpu", bytes: 2389936, sha256: CPU_SHA256 }] });
export const buildManifestSchema = z.strictObject({ version: z.literal(1), mode: z.literal("cpu"),
  cpuBuildManifestSha256: z.literal(CPU_BUILD_MANIFEST_SHA256),
  sources: fileInventorySchema, payloadFiles: fileInventorySchema,
  graph: speechEntryGraphSchema, packages: z.strictObject({ electron: z.literal("44.7.0"), zod: z.literal("4.6.5"), typescript: z.literal("7.0.2"), esbuild: z.literal("0.28.2") }) });
export type BuildManifest = z.infer<typeof buildManifestSchema>;
export const inputSchema = z.strictObject({ version: z.literal(1), mode: z.literal("cpu"), image: z.literal(IMAGE),
  seccompSha256: z.literal(SECCOMP_SHA256), electronSha256: z.literal(ELECTRON_SHA256), nodeSha256: z.literal(NODE_SHA256),
  build: buildManifestSchema, runtimeFiles: fileInventorySchema });
const pidSchema = z.number().int().positive().max(0x7fff_ffff);
export const mainIdentitySchema = z.strictObject({ pid: pidSchema, parentPid: pidSchema, uid: z.literal(1000),
  startTicks: z.string().regex(/^[1-9][0-9]{0,19}$/u).refine((value) => BigInt(value) <= (1n << 64n) - 1n) });
export const eventSchema = z.enum(["challenge", "bind-running", "observe-running", "observe-non-running", "observe-reaped",
  "observe-ambiguous", "command-discover", "command-transcribe", "command-shutdown", "terminate", "wait-retired", "reads-settled", "current-reaped"]);
export type Event = z.infer<typeof eventSchema>;
export const jobResultSchema = z.strictObject({ pid: pidSchema, parentPid: pidSchema, uid: z.literal(1000), epoch: z.string().uuid(), startTicks: mainIdentitySchema.shape.startTicks,
  nonceHashes: z.array(shaSchema).min(2).max(8), events: z.array(eventSchema).max(128), genericExitObserved: z.boolean(),
  outputSha256: shaSchema, outputBytes: z.number().int().positive().max(1024 * 1024),
  selection: z.strictObject({ backend: z.literal("cpu"), requestedGpu: z.literal(false), gpu: z.literal(false), detection: z.literal("none") }),
  leaseReleased: z.literal(true), modelIdentityHash: shaSchema });
export const resultSchema = z.strictObject({ version: z.literal(1), status: z.literal("PASS"), mode: z.literal("cpu"),
  main: mainIdentitySchema, startedAtUtc: z.iso.datetime(), finishedAtUtc: z.iso.datetime(),
  jobs: z.array(jobResultSchema).length(2), verificationBackends: z.array(z.literal("cpu")).length(2),
  scope: z.literal("Owned Linux manual-CPU supervisor/inventory/process composition; no capture, delivery, GPU, macOS, desktop or package parity.") });
export type Result = z.infer<typeof resultSchema>;
export function validateResult(input: unknown): Result {
  const parsed = resultSchema.parse(input), [first, second] = parsed.jobs; assert.ok(first && second);
  assert.notEqual(first.epoch, second.epoch); assert.equal(first.modelIdentityHash, second.modelIdentityHash);
  assert.ok(first.pid !== second.pid || first.startTicks !== second.startTicks);
  assert.equal(first.outputSha256, second.outputSha256); assert.equal(first.outputBytes, second.outputBytes);
  for (const job of parsed.jobs) {
    assert.equal(job.parentPid, parsed.main.pid);
    assert.equal(job.genericExitObserved, true);
    assert.equal(new Set(job.nonceHashes).size, job.nonceHashes.length);
    assert.equal(job.events.filter((event) => event === "command-discover").length, 0);
    assert.equal(job.events.filter((event) => event === "command-transcribe").length, 1);
    const before = job.events.indexOf("challenge"), bind = job.events.indexOf("bind-running"), secondNonce = job.events.indexOf("challenge", before + 1);
    const running = job.events.indexOf("observe-running", secondNonce + 1), infer = job.events.indexOf("command-transcribe");
    assert.ok(before >= 0 && bind > before && secondNonce > bind && running > secondNonce && infer > running);
    const retired = job.events.indexOf("wait-retired"), reap = job.events.indexOf("observe-reaped", retired + 1), reads = job.events.indexOf("reads-settled"), final = job.events.indexOf("current-reaped");
    assert.ok(retired > infer && reap > retired && reads > reap && final > reads);
  }
  return parsed;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createLinuxSpeechBindings } from "../../src/main/linux-speech-host.js";
import { initializeBackendSupervisor, backendIdentitySchema, backendObservationSchema, backendChallengeSchema,
  type BackendBindings, type ProvisionalBackendOwner, type RetirementBoundary } from "../../src/services/speech/backend-supervisor.js";
import { ModelInventory } from "../../src/services/models/model-inventory.js";
import type { SpeechChannel } from "../../src/services/speech/speech-client.js";
import type { DevelopmentProfile } from "../../src/services/settings/profiles.js";
import { prepareSpeechResources } from "../../src/services/speech/speech-resources.js";
import { prepareSpeechEntryGraph } from "../../src/services/speech/speech-entry-graph.js";
import { createLinuxProcfsReadProvider, parseLinuxProcStat, parseLinuxProcStatus } from "../../src/services/platform-lifecycle/process-retirement.js";
import { speechRequestSchema } from "../../src/workers/speech/speech-protocol.js";
import { speechWindowSchema } from "../../src/workers/speech/native-speech.js";
import { boundedJson, describe } from "./files.js";
import { cpuCatalog, inputSchema, mainIdentitySchema, jobResultSchema, validateResult, MODEL_SHA256, PCM_SHA256, type Event } from "./contract.js";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export async function currentMainIdentity() {
  const reader = createLinuxProcfsReadProvider(), signal = AbortSignal.timeout(8000); await reader.verify(signal);
  const first = parseLinuxProcStat(await reader.read(process.pid, "stat", 4096, signal));
  const status = parseLinuxProcStatus(await reader.read(process.pid, "status", 65536, signal));
  const last = parseLinuxProcStat(await reader.read(process.pid, "stat", 4096, signal));
  assert.equal(first.startTicks, last.startTicks); assert.equal(first.parentPid, process.ppid); assert.equal(last.parentPid, process.ppid);
  assert.equal(status.pid, process.pid); assert.equal(status.parentPid, process.ppid); assert.ok(status.uids.every((uid) => uid === 1000));
  return mainIdentitySchema.parse({ pid: process.pid, parentPid: process.ppid, uid: process.getuid?.(), startTicks: first.startTicks.toString() });
}
interface Receipt { pid: number; parentPid: number; uid: 1000; epoch: string; startTicks: string; nonceHashes: string[]; events: Event[]; genericExitObserved: boolean }
/** Observation only: every effect/method delegates to the exact real production
 * object. No clock, observer, factory, identity or resource is substituted. */
function observeBindings(bindings: BackendBindings) {
  const backends: string[] = [], receipts: Receipt[] = [];
  const effect: BackendBindings["effects"] = {
    verify(backend) { backends.push(backend); return bindings.effects.verify(backend); },
    async open(resource, epoch, signal) {
      const opened = await bindings.effects.open(resource, epoch, signal); if (opened.kind !== "owner") return opened;
      const original = opened.owner, receipt: Receipt = { pid: original.pid, parentPid: process.pid, uid: 1000, epoch, startTicks: "", nonceHashes: [], events: [], genericExitObserved: false };
      receipts.push(receipt);
      const note = (event: Event): void => { assert.ok(receipt.events.length < 128); receipt.events.push(event); };
      let bound: Promise<RetirementBoundary> | undefined;
      const owner: ProvisionalBackendOwner = Object.freeze({ pid: original.pid,
        challenge(nonce, challengedEpoch, cleanup) {
          const accepted = original.challenge(nonce, challengedEpoch, cleanup);
          return accepted.then((value) => { const reply = backendChallengeSchema.parse(value);
            assert.equal(reply.pid, original.pid); assert.equal(reply.epoch, epoch); assert.equal(reply.nonce, nonce);
            receipt.nonceHashes.push(digest(nonce)); note("challenge"); return value; });
        },
        bindRetirement(challengedEpoch, cleanup) {
          if (!bound) {
            // Original holder/bind is retained before this observational await.
            const accepted = original.bindRetirement(challengedEpoch, cleanup);
            bound = accepted.then((witness) => {
              const initial = z.strictObject({ level: z.literal("running"), canAdmit: z.literal(true), identity: backendIdentitySchema }).parse(witness.initial);
              assert.equal(initial.identity.birth.platform, "linux");
              assert.equal(initial.identity.pid, original.pid); assert.equal(initial.identity.uid, receipt.uid); assert.equal(initial.identity.parentPid, receipt.parentPid);
              if (initial.identity.birth.platform !== "linux") throw new Error("Unexpected fixture birth platform.");
              receipt.startTicks = initial.identity.birth.startTicks.toString(); note("bind-running");
              return Object.freeze({ initial: witness.initial,
                get current() { const value = witness.current; if (value.level === "reaped") note("current-reaped"); return value; },
                async observe(nextSignal) { const value = await witness.observe(nextSignal), observation = backendObservationSchema.parse(value);
                  note(`observe-${observation.level}`); return value; },
                async waitForRetirement(nextSignal) { await witness.waitForRetirement(nextSignal); note("wait-retired"); },
                async settleReads() { await witness.settleReads(); note("reads-settled"); },
              } satisfies RetirementBoundary);
            }); void bound.catch(() => {});
          }
          return bound;
        },
        channel: Object.freeze({
          send(value) { const command = speechRequestSchema.parse(value).command; note(`command-${command}`); original.channel.send(value); },
          onMessage: (listener) => original.channel.onMessage(listener),
          onExit: (listener) => original.channel.onExit(() => { receipt.genericExitObserved = true; listener(); }),
          terminate() { note("terminate"); return original.channel.terminate(); },
        } satisfies SpeechChannel),
      } satisfies ProvisionalBackendOwner);
      return { kind: "owner", owner };
    },
  };
  return { bindings: Object.freeze({ ...bindings, effects: Object.freeze(effect) }), backends, receipts };
}
async function publicPcm(): Promise<Float32Array> {
  assert.deepEqual(await describe("/payload/fixtures/jfk.f32"), { bytes: 704000, sha256: PCM_SHA256 });
  const file = await open("/payload/fixtures/jfk.f32", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(704001); let used = 0;
    while (used < bytes.length) { const read = await file.read(bytes, used, bytes.length - used, null); if (!read.bytesRead) break; used += read.bytesRead; }
    assert.equal(used, 704000); assert.equal(digest(bytes.subarray(0, used)), PCM_SHA256);
    const samples = new Float32Array(176000); for (let index = 0; index < samples.length; index++) samples[index] = bytes.readFloatLE(index * 4);
    return speechWindowSchema.parse(samples);
  } finally { await file.close(); }
}
export async function runCpuComposition(profile: DevelopmentProfile) {
  const startedAtUtc = new Date().toISOString(), main = await currentMainIdentity();
  const input = inputSchema.parse(await boundedJson("/payload/input.json"));
  const inventory = await ModelInventory.open(profile, await boundedJson("/payload/dist/resources/models.json"));
  const imported = await inventory.import("/payload/fixtures/ggml-tiny.bin", { expected: { bytes: 77691713, sha256: MODEL_SHA256 } });
  assert.equal(imported.model.id, "tiny"); assert.equal(imported.copiedSha256, MODEL_SHA256);
  const preparedNative = await prepareSpeechResources("/payload", cpuCatalog, { platform: "linux", architecture: "x64" });
  const preparedCode = await prepareSpeechEntryGraph("/payload", input.build.graph);
  const observed = observeBindings(await createLinuxSpeechBindings(preparedNative, preparedCode));
  // Exactly one normal module import and one continuing allocation; no reset/query.
  const supervisor = initializeBackendSupervisor(observed.bindings), samples = await publicPcm();
  const jobs: z.infer<typeof jobResultSchema>[] = [];
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    assert.equal(observed.receipts.length, ordinal);
    const lease = await inventory.acquire("tiny", { gpu: false }); await lease.validate();
    await assert.rejects(inventory.remove("tiny"), { code: "LEASED" });
    const modelIdentityHash = digest(JSON.stringify(lease.identity, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
    const job = supervisor.createJob(lease), selection = await job.prepare();
    assert.deepEqual(selection, { backend: "cpu", requestedGpu: false, gpu: false, detection: "none" });
    const text = await job.transcribeWindow(lease.model, samples, "en", "");
    // Assertions are limited to this exact public fixture; no arbitrary text is logged.
    assert.ok(/ask not what your country can do for you/iu.test(text) && /what you can do for your country/iu.test(text));
    const closed = job.close(); await closed; await lease.release(closed);
    const receipt = observed.receipts[ordinal]; assert.ok(receipt);
    const result = jobResultSchema.parse({ ...receipt, selection, outputSha256: digest(text), outputBytes: Buffer.byteLength(text), leaseReleased: true, modelIdentityHash });
    jobs.push(result); assert.equal(observed.receipts.length, ordinal + 1);
    await writeFile("/evidence/progress.json", JSON.stringify({ stage: "job-retired-and-lease-released", completedJobs: jobs.length }), { mode: 0o600 });
    // Validate the first full OS/read receipt before even acquiring/creating job 2.
    const retired = receipt.events.indexOf("wait-retired"), reads = receipt.events.indexOf("reads-settled"), final = receipt.events.indexOf("current-reaped");
    assert.ok(retired >= 0 && reads > retired && final > reads);
  }
  assert.deepEqual(await currentMainIdentity(), main);
  return validateResult({ version: 1, status: "PASS", mode: "cpu", main, startedAtUtc, finishedAtUtc: new Date().toISOString(),
    jobs, verificationBackends: observed.backends,
    scope: "Owned Linux manual-CPU supervisor/inventory/process composition; no capture, delivery, GPU, macOS, desktop or package parity." });
}

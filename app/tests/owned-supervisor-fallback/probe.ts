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
import { speechRequestSchema, speechReadySchema, speechReplySchema } from "../../src/workers/speech-protocol.js";
import { speechWindowSchema } from "../../src/workers/native-speech.js";
import { boundedJson, describe } from "../owned-supervisor/files.js";
import { catalog, inputSchema, mainIdentitySchema, jobSchema, validateResult, MODEL_SHA256, PCM_SHA256, MAX_METADATA_BYTES, serializeMainDiagnostic, serializeCandidate, DiagnosticError, checkPredicate, type Event, type Trace } from "./contract.js";

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
interface Receipt { job: number; backend: "cpu" | "vulkan"; pid: number; parentPid: number; uid: 1000; epoch: string; startTicks: string; nonceHashes: string[]; genericExitObserved: boolean }
/** Every observation delegates the exact production object/promise. No identity,
 * clock, resource, reader, factory, reply or termination decision is substituted. */
function observeBindings(bindings: BackendBindings) {
  const receipts: Receipt[] = [], trace: Trace[] = []; let job = 1, invalidReply = false;
  const note = (event: Event, backend: "cpu" | "vulkan" | null, epoch: string | null): void => {
    assert.ok(trace.length < 512); trace.push({ order: trace.length + 1, job, event, backend, epoch });
  };
  const effects: BackendBindings["effects"] = {
    verify(backend) { assert.ok(backend === "cpu" || backend === "vulkan"); note("verify", backend, null); return bindings.effects.verify(backend); },
    async open(resource, epoch, signal) {
      assert.ok(resource.backend === "cpu" || resource.backend === "vulkan");
      const opened = await bindings.effects.open(resource, epoch, signal); if (opened.kind !== "owner") return opened;
      const original = opened.owner, backend = resource.backend;
      const receipt: Receipt = { job, backend, pid: original.pid, parentPid: process.pid, uid: 1000, epoch, startTicks: "", nonceHashes: [], genericExitObserved: false };
      receipts.push(receipt); note("owner-open", backend, epoch); let bound: Promise<RetirementBoundary> | undefined;
      const sent = new Map<string, "discover" | "transcribe" | "shutdown">();
      const owner: ProvisionalBackendOwner = Object.freeze({ pid: original.pid,
        challenge(nonce, challengedEpoch, cleanup) {
          const accepted = original.challenge(nonce, challengedEpoch, cleanup);
          return accepted.then((value) => { const reply = backendChallengeSchema.parse(value);
            assert.equal(reply.pid, original.pid); assert.equal(reply.epoch, epoch); assert.equal(reply.nonce, nonce);
            receipt.nonceHashes.push(digest(nonce)); note("challenge", backend, epoch); return value; });
        },
        bindRetirement(challengedEpoch, cleanup) {
          if (!bound) {
            const accepted = original.bindRetirement(challengedEpoch, cleanup);
            // The original host retains partial witness/bind/read ownership too.
            bound = accepted.then((witness) => {
              const initial = z.strictObject({ level: z.literal("running"), canAdmit: z.literal(true), identity: backendIdentitySchema }).parse(witness.initial);
              assert.equal(initial.identity.pid, original.pid); assert.equal(initial.identity.uid, 1000); assert.equal(initial.identity.parentPid, process.pid);
              assert.equal(initial.identity.epoch, epoch); if (initial.identity.birth.platform !== "linux") throw new Error("Unexpected fixture birth platform.");
              receipt.startTicks = initial.identity.birth.startTicks.toString(); note("bind-running", backend, epoch);
              return Object.freeze({ initial: witness.initial,
                get current() { const value = witness.current; if (value.level === "reaped") note("current-reaped", backend, epoch); return value; },
                async observe(nextSignal) { const value = await witness.observe(nextSignal); note(`observe-${backendObservationSchema.parse(value).level}`, backend, epoch); return value; },
                async waitForRetirement(nextSignal) { await witness.waitForRetirement(nextSignal); note("wait-retired", backend, epoch); },
                async settleReads() { await witness.settleReads(); note("reads-settled", backend, epoch); },
              } satisfies RetirementBoundary);
            }); void bound.catch(() => {});
          }
          return bound;
        },
        channel: Object.freeze({
          send(value) {
            const request = speechRequestSchema.parse(value); assert.ok(!sent.has(request.id)); sent.set(request.id, request.command);
            if (request.command === "transcribe") { assert.equal(backend, "cpu"); assert.equal(request.model.gpu, false); }
            if (request.command === "discover") assert.equal(backend, "vulkan");
            note(`command-${request.command}`, backend, epoch); original.channel.send(value);
          },
          onMessage(listener) { return original.channel.onMessage((value) => {
            if (!speechReadySchema.safeParse(value).success) {
              const parsed = speechReplySchema.safeParse(value);
              if (!parsed.success || !sent.has(parsed.data.id)) invalidReply = true;
              else { const reply = parsed.data, command = sent.get(reply.id); sent.delete(reply.id);
                if (reply.ok && command !== reply.value.command) invalidReply = true;
                else if (!reply.ok && command === "discover" && reply.code === "START_FAILED") note("reply-start-failed", backend, epoch);
                else if (reply.ok && reply.value.command === "discover") {
                  const gpu = reply.value.gpu;
                  note(gpu === null ? "reply-discover-none" : /\b(?:lavapipe|llvmpipe|swiftshader|software|cpu)\b/iu.test(gpu) ? "reply-discover-software" : "reply-discover-device", backend, epoch);
                }
              }
            }
            listener(value); // Never persist native reply bodies/device names/text.
          }); },
          onExit: (listener) => original.channel.onExit(() => { receipt.genericExitObserved = true; listener(); }),
          terminate() { note("terminate", backend, epoch); return original.channel.terminate(); },
        } satisfies SpeechChannel),
      } satisfies ProvisionalBackendOwner);
      return { kind: "owner", owner };
    },
  };
  return { bindings: Object.freeze({ ...bindings, effects: Object.freeze(effects) }), receipts, trace, note,
    setJob(value: number) { assert.ok(value >= 1 && value <= 3); job = value; }, assertReplies() { assert.equal(invalidReply, false); } };
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
async function writeDiagnostic(path: "/evidence/main-identity.json" | "/evidence/main-final-identity.json" | "/evidence/candidate.json", serialized: string): Promise<void> {
  try { await writeFile(path, serialized, { mode: 0o600, flag: "wx" }); }
  catch { throw new DiagnosticError("DIAGNOSTIC_WRITE"); }
}
export async function runFallbackComposition(profile: DevelopmentProfile) {
  const startedAtUtc = new Date().toISOString(), main = await currentMainIdentity();
  await writeDiagnostic("/evidence/main-identity.json", serializeMainDiagnostic({ status: "CANDIDATE_NOT_ACCEPTED", main }));
  const input = inputSchema.parse(await boundedJson("/payload/input.json", MAX_METADATA_BYTES));
  const inventory = await ModelInventory.open(profile, await boundedJson("/payload/dist/resources/models.json"));
  const imported = await inventory.import("/payload/fixtures/ggml-tiny.bin", { expected: { bytes: 77691713, sha256: MODEL_SHA256 } });
  assert.equal(imported.model.id, "tiny"); assert.equal(imported.copiedSha256, MODEL_SHA256);
  const native = await prepareSpeechResources("/payload", catalog, { platform: "linux", architecture: "x64" });
  const code = await prepareSpeechEntryGraph("/payload", input.build.graph);
  const observed = observeBindings(await createLinuxSpeechBindings(native, code));
  const supervisor = initializeBackendSupervisor(observed.bindings), samples = await publicPcm(); // One normal continuing import/allocation.
  const jobs: z.infer<typeof jobSchema>[] = [];
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    observed.setJob(ordinal); const lease = await inventory.acquire("tiny", { gpu: ordinal === 2 }); await lease.validate();
    await assert.rejects(inventory.remove("tiny"), { code: "LEASED" });
    const modelIdentityHash = digest(JSON.stringify(lease.identity, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
    const job = supervisor.createJob(lease), selection = await job.prepare();
    assert.deepEqual(selection, { backend: "cpu", requestedGpu: ordinal === 2, gpu: false, detection: ordinal === 2 && input.profile === "loader-absent" ? "unavailable" : "none" });
    const text = await job.transcribeWindow(lease.model, samples, "en", "");
    assert.ok(/ask not what your country can do for you/iu.test(text) && /what you can do for your country/iu.test(text));
    const originalClosed = job.close(); await originalClosed; observed.note("job-closed", null, null);
    await lease.release(originalClosed); observed.note("lease-released", null, null); observed.assertReplies();
    jobs.push(jobSchema.parse({ ordinal, selection, outputSha256: digest(text), outputBytes: Buffer.byteLength(text), leaseReleased: true, modelIdentityHash }));
    await writeFile("/evidence/progress.json", JSON.stringify({ stage: "job-retired-and-lease-released", completedJobs: ordinal }), { mode: 0o600 });
  }
  await writeDiagnostic("/evidence/candidate.json", serializeCandidate({ version: 1, status: "CANDIDATE_NOT_ACCEPTED", profile: input.profile, main,
    startedAtUtc, finishedAtUtc: new Date().toISOString(), jobs, owners: observed.receipts, trace: observed.trace,
    scope: "Owned Linux automatic pre-inference Vulkan-to-CPU selection only; no physical GPU, capture, delivery, macOS, desktop or release-package parity." }));
  let finalMain: z.infer<typeof mainIdentitySchema>;
  try { finalMain = await currentMainIdentity(); } catch { throw new DiagnosticError("FINAL_MAIN_OBSERVATION"); }
  checkPredicate("FINAL_MAIN_IDENTITY", null, null, () => { assert.deepEqual(finalMain, main); });
  await writeDiagnostic("/evidence/main-final-identity.json", serializeMainDiagnostic({ status: "CANDIDATE_NOT_ACCEPTED", main: finalMain }));
  return validateResult({ version: 1, status: "PASS", profile: input.profile, main, startedAtUtc, finishedAtUtc: new Date().toISOString(), jobs, owners: observed.receipts, trace: observed.trace,
    scope: "Owned Linux automatic pre-inference Vulkan-to-CPU selection only; no physical GPU, capture, delivery, macOS, desktop or release-package parity." });
}

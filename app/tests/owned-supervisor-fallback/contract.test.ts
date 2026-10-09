import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { catalog, CPU_SHA256, VULKAN_SHA256, ELECTRON_SHA256, LOADER, PROFILE_IMAGES, resultSchema, validateResult, validateRuntimeDerivative,
  preflightSchema, eventSchema, inputSchema, classifyCommandCompletion, waitForOriginalCommandClose, candidateSchema, mainDiagnosticSchema, serializeCandidate, serializeMainDiagnostic, boundedDiagnosticJson, MAX_METADATA_BYTES, failureMetadata, DiagnosticError, type Result, type Event, type Profile } from "./contract.js";
import { SpeechClient, type SpeechChannel } from "../../src/services/speech/speech-client.js";
import { speechRequestSchema } from "../../src/workers/speech/speech-protocol.js";
import { summarizeVulkanOutput, classifyMainRetirement } from "./verify-main.js";
import { externalProductionImport } from "./build-probe.js";
import { parseExecutionArguments, validateConfiguration } from "./run.js";

function result(profile: Profile = "loader-present"): Result {
  const owners = [[1, "cpu"], [2, "vulkan"], [2, "cpu"], [3, "cpu"]].map(([job, backend], index) => ({ job, backend, pid: 201 + index, parentPid: 100, uid: 1000,
    epoch: randomUUID(), startTicks: String(30 + index), nonceHashes: [String(201 + index).padStart(64, "a"), String(201 + index).padStart(64, "b")], genericExitObserved: true }));
  const trace: { order: number; job: unknown; event: Event; backend: unknown; epoch: string | null }[] = [];
  const add = (job: unknown, backend: unknown, epoch: string | null, event: Event): void => { trace.push({ order: trace.length + 1, job, backend, epoch, event }); };
  for (const owner of owners) {
    add(owner.job, owner.backend, null, "verify");
    const events: Event[] = ["owner-open", "challenge", "bind-running", "challenge", "observe-running", owner.backend === "vulkan" ? "command-discover" : "command-transcribe"];
    if (owner.backend === "vulkan") events.push(profile === "loader-present" ? "reply-discover-none" : "reply-start-failed");
    events.push("command-shutdown", "observe-running", "observe-running", "terminate", "wait-retired", "observe-reaped", "reads-settled", "current-reaped");
    for (const event of events) add(owner.job, owner.backend, owner.epoch, event);
    if (owner.backend === "cpu") { add(owner.job, null, null, "job-closed"); add(owner.job, null, null, "lease-released"); }
  }
  return resultSchema.parse({ version: 1, status: "PASS", profile, main: { pid: 100, parentPid: 99, uid: 1000, startTicks: "15" },
    startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(), owners, trace,
    jobs: [1, 2, 3].map((ordinal) => ({ ordinal, selection: { backend: "cpu", requestedGpu: ordinal === 2, gpu: false, detection: ordinal === 2 && profile === "loader-absent" ? "unavailable" : "none" },
      outputSha256: "c".repeat(64), outputBytes: 100, modelIdentityHash: "d".repeat(64), leaseReleased: true })),
    scope: "Owned Linux automatic pre-inference Vulkan-to-CPU selection only; no physical GPU, capture, delivery, macOS, desktop or release-package parity." });
}
const renumber = (value: Result): void => { value.trace.forEach((entry, index) => { entry.order = index + 1; }); };
test("both closed profiles require normal manual CPU, actual Vulkan category, separate CPU and final manual CPU", () => {
  for (const profile of ["loader-present", "loader-absent"] as const) assert.equal(validateResult(result(profile)).owners.length, 4);
  assert.deepEqual(catalog.entries.map((entry) => [entry.backend, entry.sha256]), [["cpu", CPU_SHA256], ["vulkan", VULKAN_SHA256]]);
});
for (const event of ["owner-open", "challenge", "bind-running", "observe-running", "wait-retired", "observe-reaped", "reads-settled", "current-reaped"] as const) {
  test(`missing ${event} cannot establish admission or full retirement`, () => {
    const broken = result(); broken.trace = broken.trace.filter((entry) => entry.event !== event); renumber(broken); assert.throws(() => validateResult(broken));
  });
}
test("CPU verification cannot occur before the original Vulkan read/current-reaped barrier", () => {
  for (const cutoff of ["wait-retired", "reads-settled", "current-reaped"] as const) {
    const broken = result(), cpuIndex = broken.trace.findIndex((entry) => entry.job === 2 && entry.backend === "cpu" && entry.event === "verify");
    const [cpuVerify] = broken.trace.splice(cpuIndex, 1); assert.ok(cpuVerify);
    const before = broken.trace.findIndex((entry) => entry.job === 2 && entry.backend === "vulkan" && entry.event === cutoff);
    broken.trace.splice(before, 0, cpuVerify); renumber(broken); assert.throws(() => validateResult(broken));
  }
});
test("lease release precedes neither exact job close nor a later job allocation", () => {
  for (const kind of ["close", "next-job"] as const) {
    const broken = result(), index = broken.trace.findIndex((entry) => entry.job === 1 && entry.event === "lease-released");
    const [release] = broken.trace.splice(index, 1); assert.ok(release);
    const replacement = broken.trace.findIndex((entry) => entry.job === (kind === "close" ? 1 : 2) && entry.event === (kind === "close" ? "job-closed" : "owner-open"));
    broken.trace.splice(replacement, 0, release); renumber(broken); assert.throws(() => validateResult(broken));
  }
});
test("stale epochs, duplicate nonces/births and changed fixture/model fail", () => {
  for (const kind of ["epoch", "nonce", "birth", "parent", "text", "model", "order"] as const) {
    const broken = result(), first = broken.owners[0], second = broken.owners[1], middle = broken.jobs[1], entry = broken.trace[0]; assert.ok(first && second && middle && entry);
    if (kind === "epoch") second.epoch = first.epoch;
    else if (kind === "nonce") second.nonceHashes = [...first.nonceHashes];
    else if (kind === "birth") { second.pid = first.pid; second.startTicks = first.startTicks; }
    else if (kind === "parent") first.parentPid++;
    else if (kind === "text") middle.outputSha256 = "f".repeat(64);
    else if (kind === "model") middle.modelIdentityHash = "e".repeat(64);
    else entry.order++;
    assert.throws(() => validateResult(broken));
  }
});
test("manual CPU never promotes; null is not relabeled software and absent-loader requires START_FAILED", () => {
  const promoted = result(), first = promoted.jobs[0], middle = promoted.jobs[1]; assert.ok(first && middle);
  first.selection.requestedGpu = true; assert.throws(() => validateResult(promoted));
  assert.throws(() => validateResult({ ...result(), jobs: [{ ...first, selection: { ...first.selection, gpu: true } }, ...result().jobs.slice(1)] }));
  assert.throws(() => validateResult({ ...result(), jobs: [result().jobs[0], { ...middle, selection: { ...middle.selection, detection: "software" } }, result().jobs[2]] }));
  const absent = result("loader-absent"), reply = absent.trace.find((entry) => entry.event === "reply-start-failed"); assert.ok(reply); reply.event = "reply-discover-none";
  assert.throws(() => validateResult(absent));
});
test("closed evidence rejects explicit fixture replacement, cancellation/stale arbitrary data and raw text", () => {
  for (const extra of [{ explicitFixtureCpuReplacement: true }, { transcript: "private text" }, { deviceName: "private device" }, { cancelled: true }]) assert.throws(() => validateResult({ ...result(), ...extra }));
  assert.equal(eventSchema.safeParse("arbitrary-shell").success, false);
  assert.equal(inputSchema.safeParse({ version: 1, profile: "arbitrary-image" }).success, false);
  const unknown = result(), entry = unknown.trace[0]; assert.ok(entry);
  assert.throws(() => validateResult({ ...unknown, trace: [{ ...entry, rawReply: "private text" }, ...unknown.trace.slice(1)] }));
});
test("runtime derivative omits exactly the pinned loader and preserves every other raw byte", () => {
  const original = { electron: { bytes: 100, sha256: ELECTRON_SHA256 }, [LOADER.file]: { bytes: LOADER.bytes, sha256: LOADER.sha256 }, "resources/default_app.asar": { bytes: 10, sha256: "a".repeat(64) } };
  const absent = { electron: original.electron, "resources/default_app.asar": original["resources/default_app.asar"] }; validateRuntimeDerivative(original, absent);
  for (const broken of [original, { electron: original.electron }, { ...absent, electron: { bytes: 101, sha256: ELECTRON_SHA256 } }, { ...absent, extra: { bytes: 1, sha256: "b".repeat(64) } }]) assert.throws(() => validateRuntimeDerivative(original, broken));
  assert.throws(() => validateRuntimeDerivative({ ...original, [LOADER.file]: { ...original[LOADER.file], sha256: "b".repeat(64) } }, absent));
});
test("bounded transient Vulkan summary persists only counts/hash and rejects hardware/unknown/malformed output", () => {
  const bytes = Buffer.from("deviceName = SECRET DEVICE\n deviceType = PHYSICAL_DEVICE_TYPE_CPU\n"), summarized = summarizeVulkanOutput(bytes, 11);
  assert.equal(summarized.profile, "loader-present"); assert.equal(JSON.stringify(summarized).includes("SECRET"), false);
  assert.equal(preflightSchema.safeParse({ ...summarized, rawOutput: "SECRET" }).success, false);
  for (const data of [Buffer.from("deviceName = SECRET\n"), Buffer.from("deviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU\n"), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1),
    Buffer.from("deviceType = PHYSICAL_DEVICE_TYPE_CPU\ndeviceType = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU\n")]) assert.throws(() => summarizeVulkanOutput(data, 0));
  assert.throws(() => summarizeVulkanOutput(bytes, 1024 * 1024 + 1));
  assert.throws(() => summarizeVulkanOutput(Buffer.from("deviceType = PHYSICAL_DEVICE_TYPE_CPU\ndeviceType = UNKNOWN\n"), 0));
});
test("original close owns errors and post-settlement monotonic deadline", async () => {
  const events = new EventEmitter(); let released = false;
  const pending = waitForOriginalCommandClose(events, 100, () => ({ expired: false, overflow: false }), () => 99).finally(() => { released = true; });
  events.emit("error", new Error("inert error")); events.emit("error", new Error("inert later error")); await Promise.resolve(); await Promise.resolve(); assert.equal(released, false);
  events.emit("close", 0); assert.deepEqual(await pending, { code: 1, expired: false, overflow: false, errored: true });
  assert.deepEqual(classifyCommandCompletion({ end: 100, closedAt: 101, exitCode: 0, expired: false, overflow: false, errored: false }), { code: 1, expired: true, overflow: false, errored: false });
  assert.equal(classifyCommandCompletion({ end: 100, closedAt: 99, exitCode: 0, expired: false, overflow: true, errored: false }).code, 1);
});
test("only two fixed profiles, canonical paths and explicit execution token are admitted", () => {
  const valid = ["--output", "/owned/output", "--build", "/owned/build", "--profile", "loader-present", "--seccomp", "/owned/seccomp", "--execute-reviewed-owned-fallback"];
  assert.deepEqual(parseExecutionArguments(valid), { output: "/owned/output", build: "/owned/build", seccomp: "/owned/seccomp", profile: "loader-present" });
  for (const args of [valid.slice(0, -1), [...valid, "--device"], valid.map((value) => value === "loader-present" ? "host" : value), valid.map((value) => value === "/owned/output" ? "/owned/build/run" : value)]) assert.throws(() => parseExecutionArguments(args));
  const importer = fileURLToPath(new URL("./probe.ts", import.meta.url)); assert.equal(externalProductionImport("../../src/main/linux-speech-host.js", importer), "./dist/main/linux-speech-host.js");
  assert.equal(externalProductionImport("../../src/services/speech/backend-supervisor.js?reset", importer), undefined);
});
test("fixed container profile retains exact seccomp, private namespaces and zero host resources", () => {
  const seccomp = { defaultAction: "SCMP_ACT_ERRNO" }, good = [{ Image: PROFILE_IMAGES["loader-present"], Config: { User: "1000:1000" }, HostConfig: { Init: true, Memory: 2147483648,
    ShmSize: 268435456, PidsLimit: 256, NetworkMode: "none", Privileged: false, CapDrop: ["ALL"], Devices: [], PidMode: "", IpcMode: "private",
    SecurityOpt: ["no-new-privileges", `seccomp=${JSON.stringify(seccomp)}`], Ulimits: [{ Name: "core", Hard: 0, Soft: 0 }] }, Mounts: [] }];
  validateConfiguration(good, seccomp, "loader-present"); assert.throws(() => validateConfiguration(good, seccomp, "loader-absent"));
  assert.throws(() => validateConfiguration(good, {}, "loader-present")); const first = good[0]; assert.ok(first);
  for (const changes of [{ Mounts: [{}] }, { Config: { User: "0" } }, { HostConfig: { ...first.HostConfig, NetworkMode: "host" } }, { HostConfig: { ...first.HostConfig, Devices: [{}] } },
    { HostConfig: { ...first.HostConfig, Memory: 0 } }, { HostConfig: { ...first.HostConfig, PidsLimit: 0 } }]) assert.throws(() => validateConfiguration([{ ...first, ...changes }], seccomp, "loader-present"));
});
test("live and zombie original main births remain reserved without signal or generic-exit inference", () => {
  const main = result().main;
  const stat = (state: string, ticks: string) => { const fields = Array<string>(50).fill("0"); fields[0] = state; fields[1] = String(main.parentPid); fields[19] = ticks; return Buffer.from(`${main.pid} (inert) ${fields.join(" ")}\n`); };
  for (const state of ["S", "R", "D", "Z", "T"]) assert.equal(classifyMainRetirement(main, stat(state, main.startTicks)), "reserved");
  assert.equal(classifyMainRetirement(main, null), "absence"); assert.equal(classifyMainRetirement(main, stat("S", "16")), "different-birth");
});

test("false incidental exit remains observational while candidates never grant acceptance", () => {
  const original = result(), owner = original.owners[1]; assert.ok(owner);
  const candidate = { ...original, status: "CANDIDATE_NOT_ACCEPTED", owners: original.owners.map((item, index) => index === 1 ? { ...item, genericExitObserved: false } : item) };
  const parsed = candidateSchema.parse(JSON.parse(serializeCandidate(candidate))); assert.equal(parsed.owners[1]?.genericExitObserved, false);
  assert.equal(parsed.status, "CANDIDATE_NOT_ACCEPTED");
  assert.equal(validateResult({ ...candidate, status: "PASS" }).owners[1]?.genericExitObserved, false);
  assert.throws(() => validateResult(candidate));
  assert.equal(mainDiagnosticSchema.parse(JSON.parse(serializeMainDiagnostic({ status: "CANDIDATE_NOT_ACCEPTED", main: original.main }))).main.startTicks, original.main.startTicks);
});
test("neither incidental exit value replaces kernel retirement read closure or original admission", () => {
  for (const genericExitObserved of [false, true]) {
    for (const profile of ["loader-present", "loader-absent"] as const) {
      const complete = result(profile); complete.owners = complete.owners.map((owner) => ({ ...owner, genericExitObserved }));
      assert.equal(validateResult(complete).owners.every((owner) => owner.genericExitObserved === genericExitObserved), true);
      for (const event of ["challenge", "bind-running", "observe-running", "wait-retired", "observe-reaped", "reads-settled", "current-reaped"] as const) {
        const broken = structuredClone(complete); broken.trace = broken.trace.filter((entry) => entry.event !== event); renumber(broken);
        assert.throws(() => validateResult(broken));
      }
    }
  }
  const complete = result(), first = complete.owners[0]; assert.ok(first);
  for (const genericExitObserved of [null, "false", 0]) {
    assert.throws(() => validateResult({ ...complete, owners: [{ ...first, genericExitObserved }, ...complete.owners.slice(1)] }));
  }
});
test("diagnostics reject raw/private fields and malformed identity without exporting their content", () => {
  const candidate = { ...result(), status: "CANDIDATE_NOT_ACCEPTED" };
  for (const extra of [{ text: "SECRET TRANSCRIPT" }, { deviceName: "SECRET DEVICE" }, { nativeReply: "SECRET NATIVE" }, { rawOutput: "x".repeat(MAX_METADATA_BYTES + 1) }]) {
    assert.throws(() => serializeCandidate({ ...candidate, ...extra }), (error: unknown) => {
      assert.deepEqual(failureMetadata(error), { predicate: "DIAGNOSTIC_SCHEMA", ownerIndex: null, jobIndex: null }); return true;
    });
  }
  for (const identity of [{ ...candidate.main, uid: 0 }, { ...candidate.main, pid: 0 }, { ...candidate.main, startTicks: "0" }]) assert.throws(() => serializeMainDiagnostic({ status: "CANDIDATE_NOT_ACCEPTED", main: identity }));
  const malformed = result(), first = malformed.owners[0]; assert.ok(first);
  assert.throws(() => serializeCandidate({ ...candidate, owners: [{ ...first, epoch: "invalid-uuid" }, ...malformed.owners.slice(1)] }));
  assert.throws(() => serializeCandidate({ ...candidate, jobs: [{ ...malformed.jobs[0], outputSha256: "bad" }, ...malformed.jobs.slice(1)] }));
  assert.deepEqual(failureMetadata(new Error("SECRET ERROR WITH PRIVATE REPLY")), { predicate: "COMPOSITION_OR_FIXTURE_FAILED", ownerIndex: null, jobIndex: null });
  assert.throws(() => new DiagnosticError("OWNER_ADMISSION_ORDER", 5, 1)); assert.throws(() => new DiagnosticError("JOB_CLOSE_LEASE_FENCE", 1, 4));
});
test("UTF8 diagnostic byte limit has a fixed boundary and categorical size failure", () => {
  const exact = "é".repeat(MAX_METADATA_BYTES / 2); assert.equal(boundedDiagnosticJson(exact), exact);
  assert.throws(() => boundedDiagnosticJson(`${exact}é`), (error: unknown) => {
    assert.deepEqual(failureMetadata(error), { predicate: "DIAGNOSTIC_SIZE", ownerIndex: null, jobIndex: null }); return true;
  });
});
test("unchanged admission retirement and lease predicates report only exact fixed categories and indices", () => {
  const cases = ["parent", "admission", "retirement", "gpu-fence", "lease"] as const;
  for (const kind of cases) {
    const broken = result();
    let expected: ReturnType<typeof failureMetadata>;
    if (kind === "parent") {
      const first = broken.owners[0]; assert.ok(first); first.parentPid++;
      expected = { predicate: "OWNER_PARENT_NONCES", ownerIndex: 1, jobIndex: 1 };
    } else if (kind === "admission" || kind === "retirement") {
      broken.trace = broken.trace.filter((entry) => !(entry.job === (kind === "admission" ? 1 : 2) && entry.backend === (kind === "admission" ? "cpu" : "vulkan") && entry.event === (kind === "admission" ? "bind-running" : "reads-settled"))); renumber(broken);
      expected = { predicate: kind === "admission" ? "OWNER_ADMISSION_ORDER" : "OWNER_RETIREMENT_ORDER", ownerIndex: kind === "admission" ? 1 : 2, jobIndex: kind === "admission" ? 1 : 2 };
    } else if (kind === "gpu-fence") {
      const cpuIndex = broken.trace.findIndex((entry) => entry.job === 2 && entry.backend === "cpu" && entry.event === "verify"), [cpu] = broken.trace.splice(cpuIndex, 1); assert.ok(cpu);
      const before = broken.trace.findIndex((entry) => entry.job === 2 && entry.backend === "vulkan" && entry.event === "current-reaped"); broken.trace.splice(before, 0, cpu); renumber(broken);
      expected = { predicate: "GPU_CPU_RETIREMENT_FENCE", ownerIndex: null, jobIndex: 2 };
    } else {
      const releaseIndex = broken.trace.findIndex((entry) => entry.job === 1 && entry.event === "lease-released"), [release] = broken.trace.splice(releaseIndex, 1); assert.ok(release);
      const before = broken.trace.findIndex((entry) => entry.job === 1 && entry.event === "job-closed"); broken.trace.splice(before, 0, release); renumber(broken);
      expected = { predicate: "JOB_CLOSE_LEASE_FENCE", ownerIndex: null, jobIndex: 1 };
    }
    assert.throws(() => validateResult(broken), (error: unknown) => { assert.deepEqual(failureMetadata(error), expected); return true; });
  }
});
test("actual SpeechClient detaches incidental exit listener before original delegated termination", async () => {
  let message: ((value: unknown) => void) | undefined, genericExitObserved = false, detached = false, terminated = 0, closeSettled = false;
  const exits = new Set<() => void>();
  let acceptTermination: () => void = () => {}, announceTermination: () => void = () => {};
  const termination = new Promise<void>((accept) => { acceptTermination = accept; }), started = new Promise<void>((accept) => { announceTermination = accept; });
  const channel: SpeechChannel = {
    send(input) {
      const request = speechRequestSchema.parse(input); assert.ok(request.command === "discover" || request.command === "shutdown");
      const value = request.command === "discover" ? { command: "discover", gpu: null } : { command: "shutdown" };
      queueMicrotask(() => { message?.({ version: 1, id: request.id, ok: true, value }); });
    },
    onMessage(listener) { message = listener; queueMicrotask(() => { message?.({ version: 1, type: "ready" }); }); return () => { message = undefined; }; },
    onExit(listener) {
      const observed = (): void => { genericExitObserved = true; listener(); }; exits.add(observed);
      return () => { detached = true; exits.delete(observed); };
    },
    async terminate() {
      terminated++; assert.equal(detached, true); assert.equal(exits.size, 0);
      for (const callback of exits) callback(); announceTermination(); await termination;
    },
  };
  const client = new SpeechClient(async () => channel, { startupMs: 3000, requestMs: 3000, teardownMs: 3000 });
  assert.equal(await client.gpuDevice(), null);
  const closed = client.close().then(() => { closeSettled = true; }); await started;
  assert.equal(terminated, 1); assert.equal(genericExitObserved, false); assert.equal(closeSettled, false);
  acceptTermination(); await closed; assert.equal(closeSettled, true);
  // Inert listener ownership only; no actual PID/kernel retirement is supplied by this fake channel.
});

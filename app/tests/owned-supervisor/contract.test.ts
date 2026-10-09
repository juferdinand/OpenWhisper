import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { eventSchema, validateResult, inputSchema, IMAGE, type Event } from "./contract.js";
import { classifyMainRetirement } from "./verify-main.js";
import { externalProductionImport } from "./build-probe.js";
import { classifyCommandCompletion, waitForOriginalCommandClose, parseExecutionArguments, validateConfiguration } from "./run.js";
import { boundedJson, describe } from "./files.js";

const main = { pid: 100, parentPid: 99, uid: 1000, startTicks: "15" };
const events: Event[] = ["challenge", "bind-running", "challenge", "observe-running", "command-transcribe", "terminate", "wait-retired", "observe-reaped", "reads-settled", "current-reaped"];
function result() {
  return { version: 1, status: "PASS", mode: "cpu", main, startedAtUtc: new Date().toISOString(), finishedAtUtc: new Date().toISOString(),
    jobs: [201, 202].map((pid) => ({ pid, parentPid: main.pid, uid: 1000, startTicks: "20", epoch: randomUUID(), nonceHashes: ["a".repeat(64), "b".repeat(64)], events: [...events],
      genericExitObserved: true, outputSha256: "c".repeat(64), outputBytes: 100, selection: { backend: "cpu", requestedGpu: false, gpu: false, detection: "none" }, leaseReleased: true, modelIdentityHash: "d".repeat(64) })),
    verificationBackends: ["cpu", "cpu"], scope: "Owned Linux manual-CPU supervisor/inventory/process composition; no capture, delivery, GPU, macOS, desktop or package parity." };
}
test("closed inert receipt requires both admission and complete retirement ordering", () => {
  const valid = result(); assert.equal(validateResult(valid).jobs.length, 2);
  for (const event of ["bind-running", "observe-running", "wait-retired", "observe-reaped", "reads-settled", "current-reaped"] as const) {
    const broken = result(); for (const job of broken.jobs) job.events = job.events.filter((item) => item !== event);
    assert.throws(() => validateResult(broken));
  }
  const reordered = result(); for (const job of reordered.jobs) job.events = ["command-transcribe", ...job.events.filter((item) => item !== "command-transcribe")];
  assert.throws(() => validateResult(reordered));
});
test("generic exit, repeated nonce, wrong parent, reused birth and changed model cannot pass", () => {
  for (const kind of ["nonce", "parent", "birth", "model", "text", "gpu", "generic"] as const) {
    const broken = result(), first = broken.jobs[0], second = broken.jobs[1]; assert.ok(first && second);
    if (kind === "nonce") first.nonceHashes = ["a".repeat(64), "a".repeat(64)];
    else if (kind === "parent") first.parentPid++;
    else if (kind === "birth") { second.pid = first.pid; second.startTicks = first.startTicks; }
    else if (kind === "model") second.modelIdentityHash = "e".repeat(64);
    else if (kind === "text") second.outputSha256 = "e".repeat(64);
    else if (kind === "gpu") first.events.push("command-discover"); else first.genericExitObserved = false;
    assert.throws(() => validateResult(broken));
  }
  const unexpected = { ...result(), transcript: "This must never be serialized." }; assert.throws(() => validateResult(unexpected));
});
test("execution token and canonical paths are mandatory before effects", () => {
  const valid = ["--output", "/owned/new-output", "--build", "/owned/build", "--seccomp", "/owned/seccomp.json", "--execute-reviewed-owned-cpu-supervisor"];
  assert.deepEqual(parseExecutionArguments(valid), { output: "/owned/new-output", build: "/owned/build", seccomp: "/owned/seccomp.json" });
  for (const args of [valid.slice(0, -1), [...valid, "--gpu"], valid.map((value) => value === "/owned/new-output" ? "/owned/build/run" : value),
    valid.map((value) => value === "/owned/build" ? "/owned/../build" : value)]) assert.throws(() => parseExecutionArguments(args));
});
test("monotonic command deadline refuses late successful close before delayed timer dispatch", () => {
  const beforeTimer = { end: 100, closedAt: 101, exitCode: 0, expired: false, overflow: false, errored: false };
  assert.deepEqual(classifyCommandCompletion(beforeTimer), { code: 1, expired: true, overflow: false, errored: false });
  assert.equal(classifyCommandCompletion({ ...beforeTimer, closedAt: 100 }).code, 1);
  assert.deepEqual(classifyCommandCompletion({ ...beforeTimer, closedAt: 99 }), { code: 0, expired: false, overflow: false, errored: false });
  assert.deepEqual(classifyCommandCompletion({ ...beforeTimer, closedAt: 99, overflow: true }), { code: 1, expired: false, overflow: true, errored: false });
  assert.deepEqual(classifyCommandCompletion({ ...beforeTimer, closedAt: 99, expired: true }), { code: 1, expired: true, overflow: false, errored: false });
});
test("original CLI error cannot settle ownership or clear cleanup before held close", async () => {
  const events = new EventEmitter(); let cleanupReleased = false, expired = false;
  const accepted = waitForOriginalCommandClose(events, 100, () => ({ expired, overflow: false }), () => 99)
    .finally(() => { cleanupReleased = true; });
  events.emit("error", new Error("Inert owned command error."));
  events.emit("error", new Error("A later failed signal remains handled."));
  await Promise.resolve(); await Promise.resolve(); assert.equal(cleanupReleased, false);
  expired = true; events.emit("close", 0);
  assert.deepEqual(await accepted, { code: 1, expired: true, overflow: false, errored: true });
  assert.equal(cleanupReleased, true);
  const codeZero = new EventEmitter(), poisoned = waitForOriginalCommandClose(codeZero, 100, () => ({ expired: false, overflow: false }), () => 99);
  codeZero.emit("error", new Error("Inert early error.")); codeZero.emit("close", 0);
  assert.deepEqual(await poisoned, { code: 1, expired: false, overflow: false, errored: true });
});
test("canonical production imports remain external and have no query/reset route", () => {
  const importer = fileURLToPath(new URL("./probe.ts", import.meta.url));
  assert.equal(externalProductionImport("../../src/main/linux-speech-host.js", importer), "./dist/main/linux-speech-host.js");
  assert.equal(externalProductionImport("../../src/services/speech/backend-supervisor.js", importer), "./dist/services/speech/backend-supervisor.js");
  assert.equal(externalProductionImport("../../src/services/speech/backend-supervisor.js?new-main", importer), undefined);
  assert.equal(externalProductionImport("../../src/main/index.js", importer), undefined);
  assert.equal(externalProductionImport("/foreign/entry.js", importer), undefined);
});
function stat(state: string, ticks: string, pid = main.pid): Buffer {
  const fields = Array<string>(50).fill("0"); fields[0] = state; fields[1] = String(main.parentPid); fields[19] = ticks;
  return Buffer.from(`${pid} (owned inert fixture) ${fields.join(" ")}\n`);
}
test("read-only original-main classification reserves live and zombie, accepts only absence or changed birth", () => {
  for (const state of ["R", "S", "D", "Z", "T"]) assert.equal(classifyMainRetirement(main, stat(state, main.startTicks)), "reserved");
  assert.equal(classifyMainRetirement(main, null), "absence"); assert.equal(classifyMainRetirement(main, stat("S", "16")), "different-birth");
  assert.throws(() => classifyMainRetirement(main, stat("S", "16", main.pid + 1)));
  assert.throws(() => classifyMainRetirement(main, Buffer.from("malformed")));
});
test("container guard retains actual seccomp semantics, private namespace and zero host mounts/devices", () => {
  const policy = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }] };
  const good = [{ Image: IMAGE, Config: { User: "1000:1000" }, HostConfig: { Init: true, NetworkMode: "none", Privileged: false, CapDrop: ["ALL"], Devices: [], PidMode: "", IpcMode: "private",
    SecurityOpt: ["no-new-privileges", `seccomp=${JSON.stringify(policy)}`], Ulimits: [{ Name: "core", Hard: 0, Soft: 0 }] }, Mounts: [] }];
  validateConfiguration(good, policy); assert.throws(() => validateConfiguration(good, { defaultAction: "SCMP_ACT_ALLOW" }));
  const first = good[0]; assert.ok(first);
  for (const change of [{ Mounts: [{}] }, { Config: { User: "0" } }, { HostConfig: { ...first.HostConfig, NetworkMode: "host" } },
    { HostConfig: { ...first.HostConfig, Devices: [{}] } }, { HostConfig: { ...first.HostConfig, SecurityOpt: [`seccomp=${JSON.stringify(policy)}`] } }]) {
    assert.throws(() => validateConfiguration([{ ...first, ...change }], policy));
  }
});
test("bounded private metadata preserves UTF8 bytes and rejects invalid UTF8, oversize, symlink and hardlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-owned-cpu-contract-"));
  try {
    await mkdir(join(root, "private"), { mode: 0o700 }); const file = join(root, "private/input.json");
    const original = { fixture: "👩‍💻 العربية 日本語" }; await writeFile(file, JSON.stringify(original), { mode: 0o600 });
    assert.deepEqual(await boundedJson(file), original); await assert.rejects(boundedJson(file, 1));
    const descriptor = await describe(file); assert.ok(descriptor.bytes > 0);
    await symlink(file, join(root, "alias")); await assert.rejects(describe(join(root, "alias")));
    await link(file, join(root, "hardlink")); await assert.rejects(describe(file)); await rm(join(root, "hardlink"));
    await writeFile(file, Buffer.from([0xff])); await assert.rejects(boundedJson(file));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("closed mode/schema prevents fixture promotion to GPU or arbitrary event payloads", () => {
  assert.equal(eventSchema.safeParse("command-shell").success, false);
  assert.equal(inputSchema.safeParse({ version: 1, mode: "gpu" }).success, false);
});

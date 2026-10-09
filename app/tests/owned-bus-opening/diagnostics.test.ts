import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, access, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Diagnosis, EntryRequestHandler, diagnosisSchema, safeFailure } from "./diagnostics.js";
import { awaitNonRunning, bindBirth, observeBirth, type ProcReader } from "./process-witness.js";
import { diagnosticCommandPlan, diagnosticPackageSchema, RETAINED_MANIFEST_SHA, RETAINED_PROVENANCE_SHA,
  RETAINED_SHA, validateRetainedProvenance } from "./retained-contracts.js";
import { frozenCore, HEADER_SHA, IMAGE, RUNTIME_SHA, SECCOMP_SHA } from "./launch-contracts.js";
import { parseDiagnosticArguments } from "./run-retained.js";
import { prepareRetained } from "./prepare-retained.js";

const request = () => ({ version: 1, id: randomUUID(), command: "run", address: "unix:path=/tmp/openwhisper-owned-bus" });
function ledger() {
  const written: Array<z.infer<typeof diagnosisSchema>> = [];
  const diagnosis = new Diagnosis((value) => { written.push(value); }); return { diagnosis, written };
}
test("invalid and duplicate requests refuse before loading and retain only categorical metadata", async () => {
  const { diagnosis, written } = ledger(); let loads = 0, runs = 0;
  const handler = new EntryRequestHandler(diagnosis, () => { loads++; return {}; }, async () => { runs++; return null; });
  assert.deepEqual(await handler.handle({ ...request(), privateContent: "untrusted request content" }), { ok: false, id: null, category: "INVALID_REQUEST" });
  assert.equal(loads, 0); assert.equal(runs, 0);
  assert.equal((await handler.handle(request())).ok, true);
  assert.deepEqual(await handler.handle(request()), { ok: false, id: null, category: "DUPLICATE_REQUEST" });
  assert.equal(loads, 1); assert.equal(runs, 1);
  assert.equal(JSON.stringify(written).includes("untrusted request content"), false);
});
test("synchronous native loading and asynchronous scenario failures have distinct persisted stages", async () => {
  for (const kind of ["NATIVE_LOAD", "SCENARIO"] as const) {
    const { diagnosis, written } = ledger(); let runs = 0;
    const problem = Object.assign(new Error("arbitrary native detail"), { code: "ERR_DLOPEN_FAILED" });
    const handler = new EntryRequestHandler(diagnosis, () => {
      assert.equal(written.at(-1)?.stages.at(-1)?.stage, "NATIVE_LOAD_STARTED");
      if (kind === "NATIVE_LOAD") throw problem; return {};
    }, async () => {
      runs++; assert.equal(written.at(-1)?.stages.at(-1)?.stage, "SCENARIO_ENTERED"); throw problem;
    });
    const result = await handler.handle(request()); assert.equal(result.ok, false);
    if (result.ok) assert.fail("Expected categorical refusal.");
    assert.equal(result.category, kind); assert.equal(runs, kind === "NATIVE_LOAD" ? 0 : 1);
    assert.equal(written.at(-1)?.operationFailure?.category, kind);
    assert.equal(written.at(-1)?.stages.at(-1)?.stage, `${kind}_REFUSED`);
    assert.equal(JSON.stringify(written).includes("arbitrary native detail"), false);
  }
});
test("large messages unknown codes and getters cannot enter the finite diagnosis", () => {
  const { diagnosis, written } = ledger();
  const error = Object.assign(new Error("private".repeat(100_000)), { code: "arbitrary-code" });
  diagnosis.refuseOperation("INVALID_RESULT", error); diagnosis.mark("OPERATION_REFUSED");
  diagnosis.refuseCleanup(Object.assign(new Error("cleanup detail"), { code: "ESRCH" }));
  diagnosis.exit(127);
  const output = JSON.stringify(written.at(-1));
  assert.ok(output.length < 2048); assert.equal(output.includes("private"), false); assert.equal(output.includes("cleanup detail"), false);
  assert.equal(written.at(-1)?.operationFailure?.category, "INVALID_RESULT");
  assert.equal(written.at(-1)?.operationFailure?.code, "UNRECOGNIZED");
  assert.equal(written.at(-1)?.cleanupFailure?.code, "ESRCH"); assert.equal(written.at(-1)?.utilityExitCode, 127);
  let accessed = false; const accessor = Object.defineProperty(new Error(), "code", { get() { accessed = true; throw new Error(); } });
  safeFailure("UNEXPECTED", accessor); assert.equal(accessed, false);
  assert.equal(diagnosisSchema.safeParse({ ...diagnosis.snapshot(), rawFrame: request() }).success, false);
  assert.equal(diagnosisSchema.safeParse({ ...diagnosis.snapshot(), utilityExitCode: Number.NaN }).success, false);
});
test("diagnostic records retain the first operation failure independently of later cleanup and outer refusal", () => {
  const { diagnosis } = ledger(); diagnosis.refuseOperation("NATIVE_LOAD", new Error());
  diagnosis.refuseCleanup(Object.assign(new Error(), { code: "EPERM" })); diagnosis.refuseOperation("UNEXPECTED", new Error());
  assert.equal(diagnosis.snapshot().operationFailure?.category, "NATIVE_LOAD");
  assert.equal(diagnosis.snapshot().cleanupFailure?.code, "EPERM");
  for (let index = 0; index < 32; index++) diagnosis.mark("APP_READY");
  assert.throws(() => diagnosis.mark("APP_READY")); assert.equal(diagnosis.snapshot().stages.length, 32);
});
function stat(state = "S", ticks = "123", parent = "42"): string {
  return `77 (owned fixture) ${[state, parent, ...Array<string>(17).fill("0"), ticks].join(" ")}\n`;
}
const uid = "Uid:\t1000\t1000\t1000\t1000\n";
const good: ProcReader = async (path) => path.endsWith("/stat") ? stat() : uid;
test("witness retains mechanical refusal component and never treats ESRCH as absence", async () => {
  const birth = await bindBirth(77, 42, good);
  for (const component of ["FIRST_STAT", "STATUS", "SECOND_STAT"] as const) {
    let stats = 0;
    const refused: ProcReader = async (path) => {
      if (path.endsWith("/stat")) stats++;
      if (component === "FIRST_STAT" && stats === 1 || component === "STATUS" && path.endsWith("/status") ||
          component === "SECOND_STAT" && stats === 2) throw Object.assign(new Error("private process info"), { code: "ESRCH" });
      return path.endsWith("/stat") ? stat() : uid;
    };
    await assert.rejects(observeBirth(birth, refused), (error: unknown) => {
      const detail = safeFailure("PROCESS_OBSERVATION", error);
      assert.deepEqual(detail.witness, { reason: "READ_REFUSED", component, ioCode: "ESRCH" });
      assert.equal(JSON.stringify(detail).includes("private process info"), false); return true;
    });
  }
  assert.deepEqual(await observeBirth(birth, async () => null), { level: "absent", reason: "absence" });
  assert.deepEqual(await observeBirth(birth, async (path) => path.endsWith("/stat") ? stat("Z") : uid), { level: "non-running", reason: "zombie" });
});
test("witness preserves status topology UID birth and held deadline refusal categories", async () => {
  const birth = await bindBirth(77, 42, good);
  const cases: Array<Readonly<{ reason: string; reader: ProcReader }>> = [
    { reason: "STATUS_ABSENT_WITH_STAT_PRESENT", reader: async (path) => path.endsWith("/status") ? null : stat() },
    { reason: "UID_CHANGED", reader: async (path) => path.endsWith("/status") ? uid.replaceAll("1000", "1001") : stat() },
    { reason: "TOPOLOGY_CHANGED", reader: async (path) => path.endsWith("/stat") ? stat("S", "123", "43") : uid },
    { reason: "BIRTH_CHANGED", reader: async (path) => path.endsWith("/stat") ? stat("S", "124") : uid },
  ];
  for (const item of cases) await assert.rejects(observeBirth(birth, item.reader), (error: unknown) => {
    assert.equal(safeFailure("PROCESS_OBSERVATION", error).witness?.reason, item.reason); return true;
  });
  await assert.rejects(awaitNonRunning(birth, 5, async () => new Promise<string | null>(() => undefined)), (error: unknown) => {
    assert.equal(safeFailure("PROCESS_OBSERVATION", error).witness?.reason, "LOOKUP_UNCONFIRMED"); return true;
  });
});
test("an observation resolving after the deadline remains refused with its category", async () => {
  const birth = await bindBirth(77, 42, good);
  await assert.rejects(awaitNonRunning(birth, 5, async () => {
    const end = performance.now() + 15; while (performance.now() < end) { /* Inert delayed absence. */ } return null;
  }), (error: unknown) => {
    assert.equal(safeFailure("PROCESS_OBSERVATION", error).witness?.reason, "DEADLINE_EXPIRED"); return true;
  });
});
const pins = { native: RETAINED_SHA, manifest: RETAINED_MANIFEST_SHA, provenance: RETAINED_PROVENANCE_SHA };
const provenance = () => ({ nativeHash: RETAINED_SHA, manifest: { version: 1, image: IMAGE, runtime: RUNTIME_SHA,
  header: HEADER_SHA, seccomp: SECCOMP_SHA, source: { ...frozenCore }, payload: {}, node: "24.21.0", electron: "44.7.0", napi: 8 } });
test("retained diagnostic rejects changed artifact provenance source and compiler fallback arguments", () => {
  validateRetainedProvenance(pins, provenance());
  for (const key of ["native", "manifest", "provenance"] as const) assert.throws(() => validateRetainedProvenance({ ...pins, [key]: "0".repeat(64) }, provenance()));
  const changed = provenance(); changed.manifest.source["native/linux-bus/binding.cpp"] = "0".repeat(64);
  assert.throws(() => validateRetainedProvenance(pins, changed));
  const plan = diagnosticCommandPlan(); assert.equal(plan.length, 3); assert.equal(plan[1]?.at(-1), "opening");
  assert.equal(plan.some((args) => args.some((arg) => /cmake|(?:^|\/)c\+\+$|--build|service\.cpp|cleanup|legacy/u.test(arg))), false);
  assert.equal(diagnosticPackageSchema.safeParse({ ...provenance().manifest, mode: "retained-opening-diagnostic", retained: pins }).success, true);
  assert.equal(parseDiagnosticArguments(["--prepare", "--output", "/new", "--headers", "/pin", "--seccomp", "/profile", "--retained", "/original"]).mode, "prepare");
  for (const args of [["--prepare", "--output", "/new", "--headers", "/pin", "--seccomp", "/profile"],
    ["--execute", "--package", "/frozen", "--rebuild"], ["--execute", "--package", "/frozen", "--no-sandbox"]]) assert.throws(() => parseDiagnosticArguments(args));
});
test("wrong retained files refuse inert preparation before the output directory or bundle is created", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-inert-retained-"));
  try {
    const original = join(directory, "original"), output = join(directory, "new"); await mkdir(join(original, "artifacts"), { recursive: true });
    await writeFile(join(original, "manifest.json"), "{}"); await writeFile(join(original, "artifacts/native-provenance.json"), "{}");
    await writeFile(join(original, "artifacts/openwhisper_linux_bus.node"), "inert wrong artifact");
    await assert.rejects(prepareRetained(output, "/unused-header", "/unused-seccomp", original));
    await assert.rejects(access(output));
  } finally { await rm(directory, { recursive: true }); }
});

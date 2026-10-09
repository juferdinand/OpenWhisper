import test from "node:test";
import assert from "node:assert/strict";
import { LegacyDiagnosis, legacyDiagnosisSchema, operationSchema } from "./legacy-diagnostics.js";
import { oldChecks } from "./launch-contracts.js";

test("legacy ledger only accepts fixed operation fields and exact completed-check prefixes", () => {
  const diagnosis = new LegacyDiagnosis(() => undefined); diagnosis.enter("ECHO");
  for (const value of ["private method", "", { operation: "ECHO", body: "private" }]) assert.equal(operationSchema.safeParse(value).success, false);
  for (const field of ["body", "message", "stack", "destination", "transcript"] as const) {
    assert.equal(legacyDiagnosisSchema.safeParse({ ...diagnosis.snapshot(), [field]: "private" }).success, false);
  }
  assert.throws(() => diagnosis.checks([oldChecks[1]]));
  assert.throws(() => diagnosis.checks(oldChecks.slice(0, 2)));
  diagnosis.checks(oldChecks.slice(0, 1)); assert.throws(() => diagnosis.checks(oldChecks.slice(0, 1)));
});
test("timeout preserves unfinished original operation and prefix through separate cleanup", () => {
  const persisted: unknown[] = []; const diagnosis = new LegacyDiagnosis((value) => persisted.push(value));
  diagnosis.enter("OWNER_UID"); diagnosis.complete("OWNER_UID"); diagnosis.checks(oldChecks.slice(0, 1));
  diagnosis.enter("CONTROL_STATUS");
  diagnosis.beginCleanup(); diagnosis.cleanupEnter("FINAL_BUS_CLOSE"); diagnosis.cleanupComplete("FINAL_BUS_CLOSE");
  diagnosis.cleanupEnter("FINAL_CHILD_STOP"); diagnosis.cleanupComplete("FINAL_CHILD_STOP");
  diagnosis.refuse(Object.assign(new Error("private request result"), { code: "TIMEOUT" }));
  const snapshot = diagnosis.snapshot();
  assert.deepEqual(snapshot.active, { operation: "CONTROL_STATUS", phase: "entered" });
  assert.deepEqual(snapshot.completedChecks, oldChecks.slice(0, 1));
  assert.equal(snapshot.failure?.code, "TIMEOUT");
  assert.deepEqual(snapshot.cleanup, { operation: "FINAL_CHILD_STOP", phase: "completed" });
  assert.equal(JSON.stringify(persisted).includes("private"), false);
  assert.throws(() => diagnosis.enter("ECHO"));
  diagnosis.refuse(new Error("another private failure")); assert.equal(diagnosis.snapshot().failure?.code, "TIMEOUT");
});
test("completed operations require entered ordering and snapshot mutation cannot change ownership metadata", () => {
  const diagnosis = new LegacyDiagnosis(() => undefined);
  assert.throws(() => diagnosis.complete("ECHO")); diagnosis.enter("ECHO"); assert.throws(() => diagnosis.complete("OWNER_UID"));
  diagnosis.complete("ECHO"); assert.throws(() => diagnosis.complete("ECHO"));
  const copy = diagnosis.snapshot(); copy.completedChecks.push("private mutation");
  assert.deepEqual(diagnosis.snapshot().completedChecks, []);
});
test("FD labels derive only from fixed test modes and supported stages", () => {
  const diagnosis = new LegacyDiagnosis(() => undefined);
  diagnosis.enterFd("receive", "extra"); diagnosis.completeFd("receive", "extra");
  assert.equal(diagnosis.snapshot().active?.operation, "FD_EXTRA_RECEIVE");
  for (const mode of ["private", null, { body: "private" }]) assert.throws(() => diagnosis.enterFd("receive", mode));
  assert.throws(() => diagnosis.enterFd("consume", "pipe"));
});
test("cleanup cannot certify success before its original entered operation", () => {
  const diagnosis = new LegacyDiagnosis(() => undefined);
  assert.throws(() => diagnosis.cleanupEnter("FINAL_BUS_CLOSE")); diagnosis.beginCleanup();
  assert.throws(() => diagnosis.cleanupComplete("FINAL_BUS_CLOSE")); diagnosis.cleanupEnter("FINAL_BUS_CLOSE");
  assert.throws(() => diagnosis.cleanupComplete("FINAL_CHILD_STOP"));
});
test("transition capacity is finite and unknown failure remains categorical", () => {
  const diagnosis = new LegacyDiagnosis(() => undefined);
  diagnosis.refuse({ message: "private", stack: "private", code: "PRIVATE" });
  for (let index = 1; index < 256; index++) diagnosis.enter("ECHO");
  assert.equal(diagnosis.snapshot().transitions, 256); assert.throws(() => diagnosis.enter("ECHO"));
  assert.equal(JSON.stringify(diagnosis.snapshot()).includes("private"), false);
});

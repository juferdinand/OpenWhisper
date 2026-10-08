import assert from "node:assert/strict";
import { test } from "node:test";
import { asyncCallChecks, asyncCallDiagnosisSchema, asyncCallResultSchema } from "./contracts.js";

const result = { checks: [...asyncCallChecks], oneWorker: true, progressWhilePending: true,
  outstandingAfterClose: 0, ownedMemfdsAfterClose: 0 };

test("owned async-call success requires every progress and retirement receipt", () => {
  assert.deepEqual(asyncCallResultSchema.parse(result), result);
  assert.equal(asyncCallResultSchema.safeParse({ ...result, checks: [asyncCallChecks[0]] }).success, false);
  assert.equal(asyncCallResultSchema.safeParse({ ...result, checks: [...asyncCallChecks].reverse() }).success, false);
});
test("async-call diagnostics preserve an operation failure separately from cleanup", () => {
  const operationFailure = { category: "SCENARIO", family: "NODE_SYSTEM", code: "TIMEOUT", witness: null };
  const cleanupFailure = { category: "SCENARIO", family: "NODE_SYSTEM", code: "TEARDOWN_FAILED", witness: null };
  assert.deepEqual(asyncCallDiagnosisSchema.parse({ checks: [asyncCallChecks[0]], operationFailure, cleanupFailure }),
    { checks: [asyncCallChecks[0]], operationFailure, cleanupFailure });
  assert.equal(asyncCallDiagnosisSchema.safeParse({ checks: [asyncCallChecks[2]], operationFailure, cleanupFailure }).success, false);
});
test("held calls or FD ownership cannot be serialized as async-call success", () => {
  for (const patch of [{ progressWhilePending: false }, { oneWorker: false },
    { outstandingAfterClose: 1 }, { ownedMemfdsAfterClose: 1 }, { untrustedDetail: "payload" }]) {
    assert.equal(asyncCallResultSchema.safeParse({ ...result, ...patch }).success, false);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { InvalidControlStatus, MAX_CONTROL_ELAPSED, parseControlStatus, serializeControlStatus } from "../src/platforms/linux/shared/control-status.js";

test("stable status preserves every uint64 digit and all five status values", () => {
  for (const state of ["idle", "recording", "transcribing", "done", "error"]) {
    for (const elapsed of [0n, 9007199254740991n, 9007199254740993n, MAX_CONTROL_ELAPSED]) {
      const parsed = parseControlStatus(` \n{"recovery_available":true, "elapsed":${elapsed}, "status":"${state}"}\t`);
      assert.deepEqual(parsed, { status: state, elapsed, recovery_available: true });
      assert.equal(serializeControlStatus(parsed), `{"status":"${state}","elapsed":${elapsed},"recovery_available":true}`);
      assert.deepEqual(parseControlStatus(serializeControlStatus(parsed)), parsed);
      assert.equal(Object.isFrozen(parsed), true);
    }
  }
  assert.equal(parseControlStatus('{"status":"idle","elapsed":0,"recovery_available":false}').recovery_available, false);
});

test("status refuses lossy, duplicate, extra, incomplete and legacy enum replies", () => {
  for (const elapsed of ["-1", "00", "01", "1.0", "1e3", "18446744073709551616", '"4"', "null", "false"]) {
    assert.throws(() => parseControlStatus(`{"status":"idle","elapsed":${elapsed},"recovery_available":false}`), InvalidControlStatus);
  }
  for (const input of [null, {}, "idle", "unavailable", "{}", '{"status":"idle","elapsed":0}',
    '{"status":"idle","elapsed":0,"status":"idle"}',
    '{"status":"idle","elapsed":0,"recovery_available":false,"text":"private"}',
    '{"status":"idle","elapsed":0,"recovery_available":false,}',
    '{"status":"idle","elapsed":0,"recovery_available":"false"}',
    '{"status":"unavailable","elapsed":0,"recovery_available":false}',
    '{"status":"idle","elapsed":0,"recovery_available":false} trailing',
    '{"status":"idle","elapsed":0,"recovery_available":false}\0',
    " ".repeat(4097), "\ud800", "\udc00"]) assert.throws(() => parseControlStatus(input), InvalidControlStatus);
  assert.throws(() => serializeControlStatus({ status: "idle", elapsed: -1n, recovery_available: false }), InvalidControlStatus);
  assert.throws(() => serializeControlStatus({ status: "idle", elapsed: MAX_CONTROL_ELAPSED + 1n, recovery_available: false }), InvalidControlStatus);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bindLinuxProcessRetirement, type ProcessRetirementReadProvider } from "../../src/services/platform-lifecycle/process-retirement.js";

test("reader settlement includes an observation accepted before the barrier", async () => {
  const launch = { pid: 70002, uid: process.getuid?.(), parentPid: process.pid, epoch: randomUUID() };
  const fields = ["S", String(process.pid), ...Array.from({ length: 48 }, () => "0")];
  fields[19] = "123456790";
  const stat = Buffer.from(`${launch.pid} (owned fixture) ${fields.join(" ")}\n`);
  const status = Buffer.from(`Tgid:\t${launch.pid}\nPid:\t${launch.pid}\nPPid:\t${process.pid}\nUid:\t${launch.uid}\t${launch.uid}\t${launch.uid}\t${launch.uid}\n`);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let holding = false;
  const provider: ProcessRetirementReadProvider = {
    verify: async () => {},
    read: async (_pid, field) => {
      if (holding) await held;
      return field === "stat" ? stat : status;
    },
  };
  const witness = await bindLinuxProcessRetirement(launch, { deadlineMs: 250, pollMs: 1 }, provider);
  assert.equal(witness.initial.canAdmit, true);
  holding = true;
  const observation = witness.observe();
  let settled = false;
  const barrier = witness.settleReads().then(() => { settled = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "Accepted observation still holds a provider read.");
  } finally {
    release();
    await Promise.allSettled([observation, barrier]);
  }
});

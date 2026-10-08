import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { LinuxBus } from "../src/platforms/linux/shared/bus.js";
import { createControlAdapter } from "../src/platforms/linux/shared/control-adapter.js";
import { runApplicationControl } from "../src/platforms/linux/shared/control-client.js";
import { controlTarget } from "../src/platforms/linux/shared/control-identity.js";

function fixture() {
  const connection = randomUUID(), calls: Record<string, unknown>[] = [];
  let closes = 0, subscribed = false;
  const binding = {
    open: () => ({ connection, uniqueName: ":1.8" }), close: () => { closes++; }, cancel: () => {},
    subscribe: () => { subscribed = true; return randomUUID(); }, unsubscribe: () => {},
    exportControl: () => {}, reply: () => {}, reject: () => {}, readFd: () => Buffer.alloc(0), closeFd: () => {},
    call: (_connection: unknown, request: unknown) => {
      assert.ok(typeof request === "object" && request !== null); assert.equal(subscribed, true);
      const record = request as Record<string, unknown>; calls.push(record);
      const member = record.member, uid = member === "GetConnectionUnixUser";
      return { connection, id: record.id, sender: record.destination, signature: uid ? "u" : "s",
        body: [{ type: uid ? "u" : "s", value: uid ? 1000 : member === "GetNameOwner" ? ":1.9" : '{"status":"done","elapsed":9007199254740993,"recovery_available":false}' }] };
    },
  };
  return { binding, calls, closed: () => closes };
}

test("actual typed bus adapter selects one fixed identity and pins daemon and action calls without activation", async () => {
  for (const kind of ["stable", "development"] as const) for (const command of ["status", "start"] as const) {
    const f = fixture(), target = controlTarget(kind);
    const factory = createControlAdapter({ kind, address: "unix:path=/tmp/owned", open: (address) => LinuxBus.open(f.binding, address) });
    const result = await runApplicationControl({ kind: "control", command }, { uid: 1000, kind, factory });
    assert.equal(result?.exitCode, 0); assert.match(result?.stdout ?? "", /9007199254740993/u); assert.equal(f.closed(), 1);
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls[0]?.body, [{ type: "s", value: target.name }]);
    assert.deepEqual(f.calls[1]?.body, [{ type: "s", value: ":1.9" }]);
    assert.equal(f.calls[2]?.destination, ":1.9"); assert.equal(f.calls[2]?.path, target.path);
    assert.equal(f.calls[2]?.member, command === "status" ? "Status" : "Execute");
    for (const call of f.calls) { assert.equal(call.noAutoStart, true); assert.ok(typeof call.timeoutMs === "number" && call.timeoutMs <= 5000); }
  }
});

test("adapter refuses absent or untrusted session addresses before any native opening", async () => {
  let opens = 0;
  for (const address of [undefined, "", "autolaunch:", "tcp:host=localhost", "unix:path=/tmp/owned;system"]) {
    const result = await runApplicationControl({ kind: "control", command: "start" }, { uid: 1000, kind: "stable",
      factory: createControlAdapter({ kind: "stable", address, open: async () => { opens++; throw new Error("Must never open."); } }) });
    assert.deepEqual(result, { exitCode: 1, stdout: "", stderr: "No session bus. Open OpenWhisper in this desktop session first.\n" });
  }
  assert.equal(opens, 0);
});

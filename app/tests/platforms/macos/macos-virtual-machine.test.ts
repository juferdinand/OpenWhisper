import assert from "node:assert/strict";
import test from "node:test";
import { runsInMacosVirtualMachine } from "../../../src/main/macos-virtual-machine.js";

test("Metal is withheld only when macOS reports a hypervisor", () => {
  assert.equal(runsInMacosVirtualMachine(() => "1\n"), true);
  assert.equal(runsInMacosVirtualMachine(() => "0\n"), false);
  assert.equal(runsInMacosVirtualMachine(() => { throw new Error("sysctl unavailable"); }), false);
});

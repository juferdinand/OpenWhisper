import assert from "node:assert/strict";
import { test } from "node:test";
import { KdeMouse, type KdeMouseState } from "../../../src/platforms/linux/kde/mouse.js";

test("observer failure retires the monitor before queuing trigger cleanup", () => {
  let closeCalls = 0;
  let clearCalls = 0;
  let state: KdeMouseState = {
    available: true,
    middleAvailable: true,
    button: 8,
    configuring: false,
    result: "ENABLED",
  };
  const instance = Object.create(KdeMouse.prototype) as unknown as { pump(): void };
  Object.assign(instance, {
    closed: false,
    observer: {
      pump: () => false,
      close: () => { closeCalls++; throw new Error("observer close failed"); },
    },
    snapshot: state,
    publish: (changes: Partial<KdeMouseState>) => {
      state = { ...state, ...changes };
      Object.assign(instance, { snapshot: state });
    },
    clear: () => { clearCalls++; return new Promise<void>(() => {}); },
  });

  instance.pump();
  instance.pump();

  assert.equal(closeCalls, 1);
  assert.equal(clearCalls, 1);
  assert.equal(state.available, false);
  assert.equal(state.middleAvailable, false);
  assert.equal(state.result, "FAILED");
});

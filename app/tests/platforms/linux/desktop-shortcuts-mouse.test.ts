import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopShortcuts } from "../../../src/platforms/linux/shared/desktop-shortcuts.js";
import { kdeMouseConfigKey } from "../../../src/platforms/linux/kde/mouse.js";

function shortcutHarness() {
  const calls: string[] = [];
  const changed: unknown[] = [];
  const desktop = Object.create(DesktopShortcuts.prototype) as Pick<DesktopShortcuts, "command" | "state">;
  Object.assign(desktop, {
    changed: (state: unknown) => changed.push(state),
    portal: { command: (...args: unknown[]) => calls.push(`portal:${args[0]}`) },
    portalState: { available: true, configuring: false, label: null, result: "NONE" },
    kde: { cancelSetup: async () => { calls.push("keyboard:cancel"); } },
    kdeState: { available: true, configuring: false, key: null, result: "NONE" },
    mouse: { clear: async () => { calls.push("mouse:clear"); } },
    mouseState: { available: true, middleAvailable: true, button: 8, configuring: false, result: "ENABLED" },
    mouseSelected: true,
    native: false,
    epoch: 0,
    preparing: false,
  });
  return { desktop, calls, changed };
}

test("clear releases a selected mouse lease even before native keyboard selection", async () => {
  const { desktop, calls } = shortcutHarness();
  desktop.command("clear", false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["mouse:clear"]);
  assert.equal(desktop.state().nativeMouseButton, null);
});

test("cancel preserves an existing mouse lease while cancelling keyboard setup", async () => {
  const { desktop, calls } = shortcutHarness();
  desktop.command("cancel", false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["keyboard:cancel"]);
  assert.equal(desktop.state().nativeMouseButton, 8);
});

test("KWin mapping names cover only supported middle and extra button numbers", () => {
  assert.equal(kdeMouseConfigKey(2), "MiddleButton");
  assert.equal(kdeMouseConfigKey(8), "ExtraButton1");
  assert.equal(kdeMouseConfigKey(31), "ExtraButton24");
  for (const button of [3, 7, 32]) assert.throws(() => kdeMouseConfigKey(button));
});

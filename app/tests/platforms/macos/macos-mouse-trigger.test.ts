import assert from "node:assert/strict";
import test from "node:test";
import { createNativeMacosMouseTap, MacosMouseTrigger, macosMouseAccelerator, macosMouseButton, type MacosMouseTapNative } from "../../../src/main/macos-mouse-trigger.js";

function fakeTap(startResult = true) {
  const events = { starts: 0, stops: 0 };
  let deliver: ((button: number) => void) | undefined;
  const native: MacosMouseTapNative = {
    start(onButton) { events.starts++; deliver = onButton; return startResult; },
    stop() { events.stops++; deliver = undefined; },
  };
  return { events, factory: () => native, press: (button: number) => { deliver?.(button); } };
}

test("Mac mouse accelerators cover only the middle, back and forward buttons", () => {
  assert.equal(macosMouseAccelerator(8), "Mouse8"); assert.equal(macosMouseAccelerator(1), undefined);
  assert.equal(macosMouseButton("Mouse9"), 9);
  for (const invalid of ["Mouse1", "Mouse3", "mouse8", "Mouse8+Shift", "F8"]) assert.equal(macosMouseButton(invalid), undefined, invalid);
});

test("the Mac mouse listener maps native button numbers and stops with its last trigger", () => {
  const tap = fakeTap(), trigger = MacosMouseTrigger.create(tap.factory, "darwin")!;
  const pressed: string[] = [];
  assert.equal(trigger.register("Mouse8", () => { pressed.push("back"); }), true);
  assert.equal(trigger.register("Mouse2", () => { pressed.push("middle"); }), true);
  assert.equal(trigger.register("Mouse8", () => {}), false);
  // macOS numbers the middle button 2, back 3 and forward 4.
  tap.press(3); tap.press(2); tap.press(4); tap.press(0);
  assert.deepEqual(pressed, ["back", "middle"]);
  assert.equal(tap.events.starts, 1);
  trigger.unregister("Mouse8"); assert.equal(tap.events.stops, 0);
  trigger.unregister("Mouse2"); assert.equal(tap.events.stops, 1);
});

test("a refused Mac mouse listener fails registration and only exists on macOS", () => {
  const tap = fakeTap(false), trigger = MacosMouseTrigger.create(tap.factory, "darwin")!;
  assert.throws(() => trigger.register("Mouse8", () => {}));
  assert.equal(MacosMouseTrigger.create(tap.factory, "linux"), undefined);
});

test("the native Mac mouse listener can be stopped and started again", { skip: process.platform !== "darwin" }, () => {
  // Choosing a second mouse trigger closes and reopens the listener; this once failed on a duplicate FFI type.
  for (let round = 0; round < 3; round++) {
    const tap = createNativeMacosMouseTap();
    try { assert.equal(tap.start(() => {}), true); } finally { tap.stop(); }
  }
});

test("the Mac mouse listener is reopened once when the Accessibility state changes", () => {
  const tap = fakeTap(), trigger = MacosMouseTrigger.create(tap.factory, "darwin")!;
  trigger.refresh("false");
  trigger.register("Mouse2", () => {});
  assert.equal(tap.events.starts, 1);
  trigger.refresh("false"); assert.equal(tap.events.starts, 1);
  trigger.refresh("true");
  assert.equal(tap.events.starts, 2); assert.equal(tap.events.stops, 1);
  trigger.refresh("true"); assert.equal(tap.events.starts, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { X11Trigger } from "../src/contracts/ui.js";
import type { ControlCapturePort } from "../src/platforms/linux/shared/control.js";
import { X11Keyboard, X11KeyboardError, isGenuineX11,
  type X11KeyboardEvent, type X11KeyboardNative, type X11KeyboardState } from "../src/platforms/linux/x11/keyboard.js";

const original: X11Trigger = { keycode: 74, keysym: 0xffc5, modifiers: 4, group: 0 };
const replacement: X11Trigger = { keycode: 38, keysym: 0x61, modifiers: 8, group: 0 };
const ticks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Native implements X11KeyboardNative {
  events: X11KeyboardEvent[] = [];
  bound: X11Trigger | null = null;
  capture: number | undefined;
  focused = true;
  conflict: number | undefined;
  closes = 0;
  binds: X11Trigger[] = [];
  bind(trigger: X11Trigger): X11Trigger {
    if (trigger.keycode === this.conflict) throw new X11KeyboardError("CONFLICT");
    this.binds.push({ ...trigger }); this.bound = { ...trigger }; return { ...trigger };
  }
  unbind(): void { this.bound = null; }
  beginCapture(windowId: number): void { this.capture = windowId; }
  endCapture(): void { this.capture = undefined; }
  focusWithin(): boolean { return this.focused; }
  nextEvent(): X11KeyboardEvent | null { return this.events.shift() ?? null; }
  label(trigger: X11Trigger): string { return trigger.keycode === 74 ? "Ctrl+F8" : "Alt+A"; }
  close(): void { this.closes++; this.bound = null; this.capture = undefined; }
  key(type: "press" | "release", trigger: X11Trigger, keysym = trigger.keysym): void {
    this.events.push({ type, keycode: trigger.keycode, state: trigger.modifiers | (trigger.group << 13), keysym, trigger });
  }
}
async function fixture() {
  const native = new Native(), states: X11KeyboardState[] = [];
  let status: "idle" | "recording" = "idle", starts = 0, stops = 0, cancels = 0;
  const capture: ControlCapturePort = {
    status: () => status,
    start: async () => {
      starts++; status = "recording";
      return { stop: async () => { stops++; status = "idle"; }, cancel: async () => { cancels++; status = "idle"; } };
    },
  };
  // The injected connection is inert. Do not let the test process's desktop select a backend.
  const session = process.env.XDG_SESSION_TYPE, wayland = process.env.WAYLAND_DISPLAY;
  process.env.XDG_SESSION_TYPE = "x11"; delete process.env.WAYLAND_DISPLAY;
  let keyboard: X11Keyboard | undefined;
  try { keyboard = await X11Keyboard.create(":120", capture, (state) => { states.push(state); }, () => native); }
  finally {
    if (session === undefined) delete process.env.XDG_SESSION_TYPE; else process.env.XDG_SESSION_TYPE = session;
    if (wayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = wayland;
  }
  assert.ok(keyboard);
  return { keyboard, native, states, counts: () => ({ starts, stops, cancels }) };
}

test("genuine X11 guard rejects Wayland even with a local XWayland DISPLAY", () => {
  assert.equal(isGenuineX11(":120", { XDG_SESSION_TYPE: "wayland" }), false);
  assert.equal(isGenuineX11(":120", { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "x11" }), false);
  assert.equal(isGenuineX11("remote:0", { XDG_SESSION_TYPE: "x11" }), false);
  assert.equal(isGenuineX11(":120.1", { XDG_SESSION_TYPE: "x11" }), true);
  assert.equal(isGenuineX11(":120", {}), true);
});

test("native setup commits a regular key on its matching hardware release only", async () => {
  const f = await fixture();
  try {
    await f.keyboard.bind(original, false); await f.keyboard.prepareCapture(123, true);
    assert.equal(f.native.bound, null); assert.equal(f.native.capture, 123);
    f.native.key("press", replacement); f.keyboard.pump();
    assert.equal(f.keyboard.state().configuring, true); assert.equal(f.keyboard.state().result, "NONE");
    f.native.key("release", original); f.keyboard.pump(); assert.equal(f.keyboard.state().configuring, true);
    f.native.key("release", replacement); f.keyboard.pump();
    assert.deepEqual(f.keyboard.state().trigger, replacement); assert.equal(f.keyboard.state().result, "ENABLED");
    assert.equal(f.native.capture, undefined); assert.deepEqual(f.counts(), { starts: 0, stops: 0, cancels: 0 });
  } finally { await f.keyboard.close(); }
});

test("Escape and actual focus loss restore the old binding without saving a candidate", async () => {
  const f = await fixture();
  try {
    await f.keyboard.bind(original, false); await f.keyboard.prepareCapture(123, false);
    f.native.key("press", replacement); f.native.key("press", replacement, 0xff1b); f.keyboard.pump();
    assert.equal(f.keyboard.state().result, "CANCELLED"); assert.deepEqual(f.native.bound, original);
    await f.keyboard.prepareCapture(123, false); f.native.key("press", replacement); f.keyboard.pump();
    f.native.focused = false; f.keyboard.pump();
    assert.equal(f.keyboard.state().configuring, false); assert.deepEqual(f.keyboard.state().trigger, original);
    assert.equal(f.native.capture, undefined);
  } finally { await f.keyboard.close(); }
});

test("a conflicting captured key rolls back to the previous working profile", async () => {
  const f = await fixture();
  try {
    await f.keyboard.bind(original, false); await f.keyboard.prepareCapture(123, false);
    f.native.conflict = replacement.keycode;
    f.native.key("press", replacement); f.native.key("release", replacement); f.keyboard.pump();
    assert.equal(f.keyboard.state().result, "CONFLICT"); assert.deepEqual(f.keyboard.state().trigger, original);
    assert.deepEqual(f.native.bound, original); assert.equal(f.native.capture, undefined);
  } finally { await f.keyboard.close(); }
});

test("held recording suppresses repeat and stops on a real release using press-time mode", async () => {
  const f = await fixture();
  try {
    await f.keyboard.bind(original, true);
    f.native.key("press", original); f.native.key("press", original); f.keyboard.pump(); await ticks();
    assert.equal(f.counts().starts, 1);
    f.keyboard.mode(false); f.native.key("release", original); f.native.key("release", original); f.keyboard.pump(); await ticks();
    assert.deepEqual(f.counts(), { starts: 1, stops: 1, cancels: 0 });
  } finally { await f.keyboard.close(); }
});

test("layout invalidation releases grabs and cancels only the acquired recording lease", async () => {
  const f = await fixture();
  try {
    await f.keyboard.bind(original, true); f.native.key("press", original); f.keyboard.pump(); await ticks();
    f.native.events.push({ type: "layout" }); f.keyboard.pump(); await ticks();
    assert.equal(f.native.bound, null); assert.equal(f.keyboard.state().result, "ENDED");
    assert.equal(f.keyboard.state().trigger, null); assert.deepEqual(f.counts(), { starts: 1, stops: 0, cancels: 1 });
  } finally { await f.keyboard.close(); }
});

test("setup accepts a current-map key after an initial notice but retires a candidate on later mapping", async () => {
  const f = await fixture();
  try {
    await f.keyboard.prepareCapture(123, false);
    f.native.events.push({ type: "layout" });
    f.native.key("press", replacement); f.native.key("release", replacement); f.keyboard.pump();
    assert.equal(f.keyboard.state().result, "ENABLED"); assert.deepEqual(f.native.bound, replacement);
    await f.keyboard.prepareCapture(123, false);
    f.native.key("press", original); f.native.events.push({ type: "layout" });
    f.native.key("release", original); f.keyboard.pump(); await ticks();
    assert.equal(f.keyboard.state().result, "ENDED"); assert.equal(f.keyboard.state().trigger, null);
    assert.equal(f.native.capture, undefined); assert.equal(f.native.bound, null);
    assert.deepEqual(f.counts(), { starts: 0, stops: 0, cancels: 0 });
  } finally { await f.keyboard.close(); }
});

test("clear and repeated close remove the original connection and owned recording once", async () => {
  const f = await fixture();
  await f.keyboard.bind(original, true); f.native.key("press", original); f.keyboard.pump(); await ticks();
  await f.keyboard.clear(); assert.equal(f.native.bound, null); assert.equal(f.keyboard.state().trigger, null);
  assert.equal(f.counts().cancels, 1);
  await Promise.all([f.keyboard.close(), f.keyboard.close()]); assert.equal(f.native.closes, 1);
  await assert.rejects(f.keyboard.prepareCapture(123, false), (error: unknown) => error instanceof X11KeyboardError && error.code === "CLOSED");
});

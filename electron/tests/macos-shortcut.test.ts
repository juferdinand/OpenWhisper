import assert from "node:assert/strict";
import test from "node:test";
import { MacosShortcut, MacosShortcutError, normalizeMacosShortcutAccelerator,
  type MacosShortcutInput, type MacosShortcutState } from "../src/main/macos-shortcut.js";
import { createRecordingControlPort } from "../src/main/recording-control.js";
import type { RecordingIdentity } from "../src/main/development-recording-host.js";
import type { RecordingSnapshot } from "../src/core/recording.js";
import { deferred, turn } from "./fixtures/speech-port.js";

class Shortcuts {
  readonly callbacks = new Map<string, () => void>();
  readonly retired: (() => void)[] = [];
  readonly removed: string[] = [];
  readonly conflicts = new Set<string>();
  register(accelerator: string, callback: () => void): boolean {
    if (this.conflicts.has(accelerator) || this.callbacks.has(accelerator)) return false;
    this.callbacks.set(accelerator, callback); return true;
  }
  unregister(accelerator: string): void {
    const callback = this.callbacks.get(accelerator);
    if (callback) this.retired.push(callback);
    this.removed.push(accelerator); this.callbacks.delete(accelerator);
  }
  fire(accelerator = "F8"): void { this.callbacks.get(accelerator)?.(); }
}
function key(type: "keyDown" | "keyUp", name = "F8", overrides: Partial<MacosShortcutInput> = {}): MacosShortcutInput {
  return { type, key: name, code: name, shift: false, control: false, alt: false, meta: false, ...overrides };
}
function fixture(configure = async () => {}, setupAllowed?: () => boolean) {
  const shortcuts = new Shortcuts(), states: MacosShortcutState[] = [], commands: string[] = [];
  let allowed = true, identity: RecordingIdentity = { epoch: "original", generation: 0 };
  let snapshot: Pick<RecordingSnapshot, "phase" | "busy" | "recoveryAvailable"> =
    { phase: "idle", busy: false, recoveryAvailable: false };
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation); queue = next.then(() => {}, () => {}); return next;
  };
  const capture = createRecordingControlPort({
    owner: { currentIdentity: () => identity, async command(command, expected) {
      if (expected) assert.deepEqual(expected, identity);
      commands.push(command);
      if (command === "start") {
        identity = { ...identity, generation: identity.generation + 1 };
        snapshot = { phase: "recording", busy: true, recoveryAvailable: false };
      } else snapshot = { phase: command === "stop" ? "transcribing" : "idle", busy: command === "stop", recoveryAvailable: false };
      return identity;
    } }, snapshot: () => snapshot, available: () => allowed, configure, serialize, cleanupSerialize: serialize,
  });
  const adapter = new MacosShortcut({ shortcuts, capture, allowed: () => allowed,
    ...(setupAllowed ? { setupAllowed } : {}), changed: (state) => { states.push(state); } });
  return { adapter, shortcuts, states, commands,
    deny: () => { allowed = false; },
    phase: (phase: typeof snapshot.phase, recoveryAvailable = false) => {
      snapshot = { phase, busy: phase === "recording" || phase === "transcribing", recoveryAvailable };
    },
    guiRecording: () => { identity = { epoch: "gui", generation: 9 };
      snapshot = { phase: "recording", busy: true, recoveryAvailable: false }; },
  };
}

test("saved Mac accelerators use an explicit regular key and canonical modifiers", () => {
  assert.equal(normalizeMacosShortcutAccelerator("Shift+Command+D"), "Command+Shift+D");
  assert.equal(normalizeMacosShortcutAccelerator("F8"), "F8");
  assert.equal(normalizeMacosShortcutAccelerator("Control+Plus"), "Control+Plus");
  for (const invalid of ["", "Command", "Command+Command+D", "CommandOrControl+D", "Fn+F8", "F25", "Mouse2", "MediaPlayPause", "Escape", "é"]) {
    assert.equal(normalizeMacosShortcutAccelerator(invalid), undefined, invalid);
  }
});

test("explicit capture commits only on matching release with press-time modifiers", async () => {
  const f = fixture();
  try {
    assert.equal(f.adapter.consume(key("keyDown")), false);
    f.adapter.prepareCapture();
    f.adapter.consume(key("keyDown", "Shift", { shift: true }));
    f.adapter.consume(key("keyDown", "d", { code: "KeyD", meta: true, shift: true }));
    f.adapter.consume(key("keyDown", "d", { code: "KeyD", meta: true, shift: true, isAutoRepeat: true }));
    f.adapter.consume(key("keyUp", "F9"));
    assert.equal(f.adapter.state().configuring, true); assert.equal(f.shortcuts.callbacks.size, 0);
    f.adapter.consume(key("keyUp", "d", { code: "KeyD" }));
    assert.equal(f.adapter.state().accelerator, "Command+Shift+D");
    assert.equal(f.adapter.state().result, "ENABLED"); assert.deepEqual(f.commands, []);
  } finally { await f.adapter.close(); }
});

test("an owned setup reservation admits capture while global recording stays blocked and update denial still applies", async () => {
  let setupAllowed = true;
  const f = fixture(undefined, () => setupAllowed);
  try {
    f.adapter.bind("F8"); f.deny(); f.shortcuts.fire(); await turn();
    assert.deepEqual(f.commands, []);
    f.adapter.prepareCapture(); assert.equal(f.adapter.state().configuring, true);
    f.adapter.consume(key("keyDown", "F9")); f.adapter.consume(key("keyUp", "F9"));
    assert.equal(f.adapter.state().accelerator, "F9"); f.shortcuts.fire("F9"); await turn();
    assert.deepEqual(f.commands, []);
    setupAllowed = false;
    assert.throws(() => f.adapter.prepareCapture(), (error: unknown) => error instanceof MacosShortcutError && error.code === "UNAVAILABLE");
    assert.equal(f.adapter.state().configuring, false); assert.equal(f.adapter.state().accelerator, "F9");
  } finally { await f.adapter.close(); }
});

test("Escape, explicit cancellation and focus loss restore the previous binding", async () => {
  const f = fixture();
  try {
    f.adapter.bind("F8");
    for (const cancel of [() => { f.adapter.consume(key("keyDown", "Escape")); },
      () => { f.adapter.cancelSetup(); }, () => { f.adapter.focusLost(); }]) {
      f.adapter.prepareCapture(); f.adapter.consume(key("keyDown", "F9"));
      assert.equal(f.shortcuts.callbacks.has("F8"), false);
      cancel();
      assert.equal(f.adapter.state().result, "CANCELLED");
      assert.equal(f.adapter.state().accelerator, "F8"); assert.equal(f.shortcuts.callbacks.has("F8"), true);
      assert.equal(f.adapter.consume(key("keyUp", "F9")), false);
    }
    assert.deepEqual(f.commands, []);
  } finally { await f.adapter.close(); }
});

test("modifier-only, Fn, mouse, composition and keypad setup preserve the old profile", async () => {
  const f = fixture();
  try {
    f.adapter.bind("F8");
    const unsupported: MacosShortcutInput[][] = [
      [key("keyDown", "Control"), key("keyUp", "Control")],
      [key("keyDown", "Fn")], [key("keyDown", "F9", { modifiers: ["fn"] })],
      [{ ...key("keyDown"), type: "mouseDown" }],
      [key("keyDown", "a", { code: "KeyA", isComposing: true })],
      [key("keyDown", "1", { code: "Numpad1" })],
    ];
    for (const sequence of unsupported) {
      f.adapter.prepareCapture(); for (const input of sequence) f.adapter.consume(input);
      assert.equal(f.adapter.state().result, "UNSUPPORTED");
      assert.equal(f.adapter.state().accelerator, "F8"); assert.equal(f.shortcuts.callbacks.has("F8"), true);
    }
  } finally { await f.adapter.close(); }
});

test("a registration conflict preserves the previous binding and never unregisters another owner", async () => {
  const f = fixture();
  try {
    f.shortcuts.register("Command+Q", () => {}); f.adapter.bind("F8");
    assert.throws(() => { f.adapter.bind("Command+Q"); }, (error: unknown) =>
      error instanceof MacosShortcutError && error.code === "CONFLICT");
    assert.equal(f.adapter.state().accelerator, "F8"); assert.equal(f.shortcuts.removed.length, 0);
    f.shortcuts.conflicts.add("F9"); f.adapter.prepareCapture();
    f.adapter.consume(key("keyDown", "F9")); f.adapter.consume(key("keyUp", "F9"));
    assert.equal(f.adapter.state().result, "CONFLICT"); assert.equal(f.adapter.state().accelerator, "F8");
    f.adapter.bind("F10");
    for (const callback of f.shortcuts.retired) callback(); await turn(); assert.deepEqual(f.commands, []);
    f.adapter.clear(); assert.equal(f.adapter.state().accelerator, null);
    assert.equal(f.shortcuts.callbacks.has("Command+Q"), true);
    assert.deepEqual(f.shortcuts.removed, ["F8", "F8", "F10"]);
  } finally { await f.adapter.close(); }
  assert.equal(f.shortcuts.callbacks.has("Command+Q"), true);
});

test("toggle callbacks serialize acquisition and stop the exact current GUI recording", async () => {
  const held = deferred<void>(), f = fixture(() => held.promise);
  try {
    f.adapter.bind("F8"); f.shortcuts.fire(); f.shortcuts.fire(); await turn();
    assert.deepEqual(f.commands, []); held.accept(); await turn(); assert.deepEqual(f.commands, ["start"]);
    f.guiRecording(); f.shortcuts.fire(); await turn(); assert.deepEqual(f.commands, ["start", "stop"]);
    f.shortcuts.fire(); await turn(); assert.deepEqual(f.commands, ["start", "stop"]);
  } finally { await f.adapter.close(); }
  // The old shortcut acquisition cannot cancel the later GUI generation.
  assert.deepEqual(f.commands, ["start", "stop"]);
});

test("transcription, retained recovery, setup and shutdown reject global recording callbacks", async () => {
  const f = fixture();
  try {
    f.adapter.bind("F8"); f.phase("transcribing"); f.shortcuts.fire(); await turn();
    f.phase("error", true); f.shortcuts.fire(); await turn();
    f.phase("idle"); const old = f.shortcuts.callbacks.get("F8"); f.adapter.prepareCapture(); old?.(); await turn();
    f.adapter.cancelSetup(); f.deny(); f.shortcuts.fire(); await turn();
    assert.deepEqual(f.commands, []);
  } finally { await f.adapter.close(); }
});

test("close aborts a pending start, retires the original owned lease and ignores stale callbacks", async () => {
  const held = deferred<void>(), f = fixture(() => held.promise);
  f.adapter.bind("F8"); const callback = f.shortcuts.callbacks.get("F8");
  f.shortcuts.fire(); await turn();
  const closed = f.adapter.close(); assert.equal(f.adapter.close(), closed);
  callback?.(); held.accept(); await closed;
  assert.deepEqual(f.commands, []); assert.deepEqual(f.shortcuts.removed, ["F8"]);
  assert.equal(f.adapter.state().available, false);
  assert.throws(() => { f.adapter.prepareCapture(); }, (error: unknown) => error instanceof MacosShortcutError && error.code === "CLOSED");
  const acquired = fixture(); acquired.adapter.bind("F8"); acquired.shortcuts.fire(); await turn();
  await acquired.adapter.close(); assert.deepEqual(acquired.commands, ["start", "cancel"]);
});

test("a native Start that finishes after shutdown is cancelled through its original acquired lease", async () => {
  const acquired = deferred<void>(), shortcuts = new Shortcuts();
  let signal: AbortSignal | undefined, starts = 0, cancels = 0, stops = 0, completed = false;
  const adapter = new MacosShortcut({ shortcuts, allowed: () => true, changed: () => {}, capture: {
    status: () => "idle",
    async start(abort) {
      starts++; signal = abort; await acquired.promise;
      return { async stop() { stops++; }, async cancel() { cancels++; } };
    },
  } });
  adapter.bind("F8"); shortcuts.fire(); await turn(); assert.equal(starts, 1);
  const close = adapter.close().then(() => { completed = true; });
  await turn(); assert.equal(signal?.aborted, true); assert.equal(completed, false);
  acquired.accept(); await close;
  assert.equal(cancels, 1); assert.equal(stops, 0);
});

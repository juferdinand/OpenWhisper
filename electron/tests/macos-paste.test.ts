import assert from "node:assert/strict";
import test from "node:test";
import { MacosPaste, createNativeMacosPaste, type MacosPasteNative } from "../src/main/macos-paste.js";
import { deliverClipboard } from "../src/services/clipboard-output.js";

class Native implements MacosPasteNative {
  target: number | undefined = process.pid + 1;
  readonly calls: string[] = [];
  readonly held = new Set<string>();
  readonly flags = new Map<number, bigint>();
  readonly released: bigint[] = [];
  readonly posted: bigint[] = [];
  readonly allocations: bigint[] = [];
  next = 10n;
  allocationFailure: number | undefined;
  flagsFailure = false;
  postFailure: bigint | undefined;
  releaseFailure: bigint | undefined;
  focusCalls = 0;
  onFocus: (() => void) | undefined;
  onAllocate: (() => void) | undefined;
  focusedApplicationPid(): number | undefined {
    this.calls.push("focus"); this.focusCalls++; this.onFocus?.(); return this.target;
  }
  flagsState(state: 0 | 1): bigint { this.calls.push(`flags:${state}`); return this.flags.get(state) ?? 0n; }
  keyState(state: 0 | 1, key: number): boolean { return this.held.has(`${state}:${key}`); }
  private allocate(): bigint | null {
    this.onAllocate?.();
    if (this.allocations.length === this.allocationFailure) return null;
    const pointer = this.next++; this.allocations.push(pointer); return pointer;
  }
  createSource(state: 0): bigint | null { assert.equal(state, 0); this.calls.push("source"); return this.allocate(); }
  createKeyboardEvent(source: bigint, key: number, down: boolean): bigint | null {
    assert.equal(source, 10n); assert.equal(key, 9); this.calls.push(down ? "create-down" : "create-up"); return this.allocate();
  }
  setFlags(event: bigint, flags: bigint): void {
    assert.ok(event === 11n || event === 12n); assert.equal(flags, 1n << 20n);
    this.calls.push(`command:${event}`); if (this.flagsFailure) throw new Error("Inert flag failure.");
  }
  post(event: bigint): void {
    this.posted.push(event); if (event === this.postFailure) throw new Error("Inert post failure.");
  }
  release(reference: bigint): void {
    this.released.push(reference); if (reference === this.releaseFailure) throw new Error("Inert release failure.");
  }
}
function fixture() {
  const native = new Native(); let granted = true, targetAllowed = true, loads = 0;
  const paste = MacosPaste.create({ accessibilityGranted: () => granted, targetAllowed: () => targetAllowed },
    () => { loads++; return native; }, "darwin");
  assert.ok(paste);
  return { paste, native, loads: () => loads,
    deny: () => { granted = false; }, refuse: () => { targetAllowed = false; } };
}

test("Mac-only creation and denied permission or target admission do not load native libraries", async () => {
  let loads = 0;
  assert.equal(MacosPaste.create({ accessibilityGranted: () => true, targetAllowed: () => true },
    () => { loads++; return new Native(); }, "linux"), undefined);
  assert.equal(loads, 0);
  for (const gate of ["deny", "refuse"] as const) {
    const f = fixture(); f[gate](); assert.equal(await f.paste.paste(), false);
    assert.equal(f.loads(), 0); assert.deepEqual(f.native.calls, []); f.paste.close();
  }
  if (process.platform !== "darwin") assert.throws(createNativeMacosPaste, /unavailable/u);
});

test("an unknown, invalid or owned focused application is refused before creating CGEvents", async () => {
  for (const target of [undefined, 0, 1, -1, NaN, 1.5, 0x80000000, process.pid]) {
    const f = fixture(); f.native.target = target;
    assert.equal(await f.paste.paste(), false); assert.deepEqual(f.native.allocations, []);
    assert.deepEqual(f.native.posted, []); f.paste.close();
  }
});

test("physical and combined-session modifiers or held V are refused without clearing state", async () => {
  for (const state of [0, 1] as const) {
    for (const flag of [16n, 17n, 18n, 19n, 20n, 22n, 23n]) {
      const f = fixture(); f.native.flags.set(state, 1n << flag);
      assert.equal(await f.paste.paste(), false); assert.deepEqual(f.native.allocations, []);
      assert.equal(f.native.flags.get(state), 1n << flag); f.paste.close();
    }
    for (const key of [9, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 114]) {
      const f = fixture(); f.native.held.add(`${state}:${key}`);
      assert.equal(await f.paste.paste(), false); assert.deepEqual(f.native.allocations, []);
      assert.equal(f.native.held.has(`${state}:${key}`), true); f.paste.close();
    }
  }
});

test("one admitted paste posts precisely Command V down and up and releases all original references", async () => {
  const f = fixture();
  assert.equal(await f.paste.paste(), true);
  assert.deepEqual(f.native.posted, [11n, 12n]); assert.deepEqual(f.native.released, [12n, 11n, 10n]);
  assert.equal(f.native.focusCalls, 2); assert.equal(f.loads(), 1);
  assert.ok(f.native.calls.indexOf("focus") < f.native.calls.indexOf("source"));
  assert.ok(f.native.calls.indexOf("create-up") < f.native.calls.indexOf("command:11"));
  f.paste.close(); f.paste.close(); assert.equal(f.paste.isClosed, true);
  assert.equal(await f.paste.paste(), false); assert.deepEqual(f.native.posted, [11n, 12n]);
});

test("allocation and flag failures release every created reference without any native post", async () => {
  for (const failure of [0, 1, 2, "flags"] as const) {
    const f = fixture();
    if (failure === "flags") f.native.flagsFailure = true; else f.native.allocationFailure = failure;
    assert.equal(await f.paste.paste(), false); assert.deepEqual(f.native.posted, []);
    assert.deepEqual(f.native.released, [...f.native.allocations].reverse()); f.paste.close();
  }
});

test("focus, permission and physical-state changes before posting retain clipboard-only fallback", async () => {
  for (const change of ["focus", "permission", "late-permission", "modifier", "close"] as const) {
    const f = fixture();
    f.native.onFocus = () => {
      if (f.native.focusCalls !== 2) return;
      if (change === "focus") f.native.target = process.pid + 2;
      else if (change === "modifier") f.native.held.add("1:55");
      else if (change === "late-permission") f.deny();
    };
    f.native.onAllocate = () => {
      if (change === "permission") f.deny(); else if (change === "close") f.paste.close();
    };
    assert.equal(await f.paste.paste(), false); assert.deepEqual(f.native.posted, []);
    assert.deepEqual(f.native.released, [12n, 11n, 10n]); f.paste.close();
  }
});

test("an uncertain down post still releases V once and never retries the paste", async () => {
  const f = fixture(); f.native.postFailure = 11n;
  assert.equal(await f.paste.paste(), false); assert.deepEqual(f.native.posted, [11n, 12n]);
  assert.deepEqual(f.native.released, [12n, 11n, 10n]); f.paste.close();
});

test("failed V release or native-reference cleanup blocks later paste attempts", async () => {
  for (const failure of ["release-key", "release-reference"] as const) {
    const f = fixture();
    if (failure === "release-key") f.native.postFailure = 12n; else f.native.releaseFailure = 12n;
    assert.equal(await f.paste.paste(), false); assert.deepEqual(f.native.released, [12n, 11n, 10n]);
    const calls = [...f.native.calls]; assert.equal(await f.paste.paste(), false);
    assert.deepEqual(f.native.calls, calls); assert.deepEqual(f.native.posted, [11n, 12n]); f.paste.close();
  }
});

test("denied or failed paste is a confirmed clipboard delivery with no automatic replay", async () => {
  for (const denied of [true, false]) {
    const f = fixture(); if (denied) f.deny(); else f.native.postFailure = 11n;
    let clipboard = "", attempts = 0;
    const text = "Hello — Grüße, 你好.";
    const result = await deliverClipboard(text, { generation: 4, attempt: 2, signal: new AbortController().signal }, {
      writeText: (value) => { clipboard = value; }, readText: () => clipboard,
      paste: () => { attempts++; return f.paste.paste(); },
    });
    assert.deepEqual(result, { generation: 4, attempt: 2, outcome: "clipboard", clipboardConfirmed: true });
    assert.equal(clipboard, text); assert.equal(attempts, 1);
    assert.deepEqual(f.native.posted, denied ? [] : [11n, 12n]); f.paste.close();
  }
});

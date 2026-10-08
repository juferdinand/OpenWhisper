import { createRequire } from "node:module";
import type { LibraryHandle } from "koffi";

export interface MacosPasteOptions {
  /** Probe only; asking for Accessibility belongs to the explicit main UI command. */
  readonly accessibilityGranted: () => boolean;
  readonly targetAllowed: () => boolean;
}
export interface MacosPasteNative {
  focusedApplicationPid(): number | undefined;
  flagsState(state: 0 | 1): bigint;
  keyState(state: 0 | 1, key: number): boolean;
  createSource(state: 0): bigint | null;
  createKeyboardEvent(source: bigint, key: number, down: boolean): bigint | null;
  setFlags(event: bigint, flags: bigint): void;
  post(event: bigint): void;
  release(reference: bigint): void;
}
export type MacosPasteNativeFactory = () => MacosPasteNative;
class NativeReleaseError extends Error {
  constructor() { super("Mac paste native cleanup failed."); }
}
const commandFlag = 1n << 20n;
// Caps Lock, Shift, Control, Option, Command, Help and Fn. Never reset user state.
const unsafeFlags = (1n << 16n) | (1n << 17n) | (1n << 18n) | (1n << 19n) | commandFlag | (1n << 22n) | (1n << 23n);
const modifierKeys = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 114] as const;
const pasteKey = 9; // kVK_ANSI_V, matching the native Swift TextInjector.

/** One confirmed clipboard transaction may request one Command+V pair; no content crosses FFI. */
export class MacosPaste {
  private native: MacosPasteNative | undefined;
  private closed = false;
  private failed = false;
  private busy = false;
  private constructor(private readonly options: MacosPasteOptions, private readonly factory: MacosPasteNativeFactory) {}

  static create(options: MacosPasteOptions, factory: MacosPasteNativeFactory = createNativeMacosPaste,
    platform: string = process.platform): MacosPaste | undefined {
    return platform === "darwin" ? new MacosPaste(options, factory) : undefined;
  }
  get isClosed(): boolean { return this.closed; }
  private admitted(): boolean {
    return !this.closed && !this.failed && this.options.accessibilityGranted() && this.options.targetAllowed();
  }
  private freeKeyboard(native: MacosPasteNative): boolean {
    for (const state of [0, 1] as const) {
      if ((native.flagsState(state) & unsafeFlags) !== 0n || native.keyState(state, pasteKey) ||
          modifierKeys.some((key) => native.keyState(state, key))) return false;
    }
    return true;
  }
  paste(): Promise<boolean> {
    // All admission, event creation and posting are synchronous in one main-thread turn.
    if (this.busy) return Promise.resolve(false);
    this.busy = true;
    let accepted = false, downAttempted = false;
    let native: MacosPasteNative | undefined;
    let source: bigint | null = null, down: bigint | null = null, up: bigint | null = null;
    try {
      if (!this.admitted()) return Promise.resolve(false);
      native = this.native ??= this.factory();
      const target = native.focusedApplicationPid();
      if (!Number.isSafeInteger(target) || target === undefined || target <= 1 || target > 0x7fffffff ||
          target === process.pid || !this.freeKeyboard(native)) return Promise.resolve(false);
      source = native.createSource(0);
      if (source === null) return Promise.resolve(false);
      down = native.createKeyboardEvent(source, pasteKey, true);
      if (down === null) return Promise.resolve(false);
      up = native.createKeyboardEvent(source, pasteKey, false);
      if (up === null) return Promise.resolve(false);
      native.setFlags(down, commandFlag); native.setFlags(up, commandFlag);
      // Focus/permission can change during AX messaging or allocation. Refuse before posting.
      if (!this.admitted() || native.focusedApplicationPid() !== target || !this.freeKeyboard(native) || !this.admitted()) return Promise.resolve(false);
      downAttempted = true; native.post(down); accepted = true;
    } catch (error: unknown) { accepted = false; if (error instanceof NativeReleaseError) this.failed = true; }
    finally {
      if (native) {
        // Even an uncertain down post must attempt the already-created matching release.
        if (downAttempted && up !== null) {
          try { native.post(up); }
          catch { accepted = false; this.failed = true; }
        }
        for (const reference of [up, down, source]) {
          if (reference === null) continue;
          try { native.release(reference); }
          catch { accepted = false; this.failed = true; }
        }
      }
      this.busy = false;
    }
    // Posting is an accepted attempt, not a target-field readback or permission grant.
    return Promise.resolve(accepted);
  }
  close(): void { this.closed = true; }
}

type Koffi = typeof import("koffi");
type NativeCall = (...args: unknown[]) => unknown;
function bind(library: LibraryHandle, definition: string): NativeCall {
  const native = library.func(definition);
  return (...args) => { const result: unknown = native(...args); return result; };
}
function pointer(value: unknown): bigint | null {
  if (value === null || value === 0n) return null;
  if (typeof value !== "bigint" || value < 0n) throw new Error("Mac paste native result is invalid.");
  return value;
}
function integer(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) throw new Error("Mac paste native result is invalid.");
  return number;
}
function flags(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  const number = integer(value);
  if (number < 0) throw new Error("Mac paste native result is invalid.");
  return BigInt(number);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Mac paste native result is invalid."); return value;
}

/** Fixed Apple libraries only. Importing this module does not load them or inspect input. */
export function createNativeMacosPaste(): MacosPasteNative {
  if (process.platform !== "darwin") throw new Error("Mac paste is unavailable.");
  const imported: unknown = createRequire(import.meta.url)("koffi");
  if (typeof imported !== "object" || imported === null || typeof Reflect.get(imported, "load") !== "function") throw new Error("Mac paste is unavailable.");
  const ffi = imported as Koffi;
  const graphics = ffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  const foundation = ffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const accessibility = ffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
  const f = {
    source: bind(graphics, "void *CGEventSourceCreate(int32_t state)"),
    keyboard: bind(graphics, "void *CGEventCreateKeyboardEvent(void *source, uint16_t key, bool down)"),
    flags: bind(graphics, "void CGEventSetFlags(void *event, uint64_t flags)"),
    post: bind(graphics, "void CGEventPost(int32_t tap, void *event)"),
    stateFlags: bind(graphics, "uint64_t CGEventSourceFlagsState(int32_t state)"),
    stateKey: bind(graphics, "bool CGEventSourceKeyState(int32_t state, uint16_t key)"),
    release: bind(foundation, "void CFRelease(void *reference)"),
    string: bind(foundation, "void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)"),
    type: bind(foundation, "unsigned long CFGetTypeID(void *reference)"),
    systemWide: bind(accessibility, "void *AXUIElementCreateSystemWide(void)"),
    timeout: bind(accessibility, "int32_t AXUIElementSetMessagingTimeout(void *element, float seconds)"),
    attribute: bind(accessibility, "int32_t AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)"),
    pid: bind(accessibility, "int32_t AXUIElementGetPid(void *element, _Out_ int32_t *pid)"),
    axType: bind(accessibility, "unsigned long AXUIElementGetTypeID(void)"),
  };
  return {
    focusedApplicationPid() {
      const references: bigint[] = [];
      try {
        const system = pointer(f.systemWide()); if (system === null) return undefined; references.push(system);
        if (integer(f.timeout(system, 0.2)) !== 0) return undefined;
        const attribute = pointer(f.string(null, "AXFocusedApplication", 0x08000100));
        if (attribute === null) return undefined; references.push(attribute);
        const value: unknown[] = [null], code = integer(f.attribute(system, attribute, value));
        const application = pointer(value[0]); if (application !== null) references.push(application);
        if (code !== 0 || application === null || integer(f.type(application)) !== integer(f.axType())) return undefined;
        const pid: unknown[] = [0];
        return integer(f.pid(application, pid)) === 0 ? integer(pid[0]) : undefined;
      } finally {
        let failed = false;
        for (const reference of references.reverse()) {
          try { f.release(reference); } catch { failed = true; }
        }
        if (failed) throw new NativeReleaseError();
      }
    },
    flagsState: (state) => flags(f.stateFlags(state)),
    keyState: (state, key) => boolean(f.stateKey(state, key)),
    createSource: (state) => pointer(f.source(state)),
    createKeyboardEvent: (source, key, down) => pointer(f.keyboard(source, key, down)),
    setFlags: (event, flags) => { f.flags(event, flags); },
    post: (event) => { f.post(0, event); },
    release: (reference) => { f.release(reference); },
  };
}

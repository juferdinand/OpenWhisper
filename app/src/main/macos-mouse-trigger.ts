import { createRequire } from "node:module";
import type { LibraryHandle } from "koffi";

/** Trigger buttons shared with the renderer and Linux: middle, back and forward. */
export type MacosMouseButton = 2 | 8 | 9;
const macosButtons: Readonly<Record<number, MacosMouseButton>> = { 2: 2, 3: 8, 4: 9 };
const acceleratorPattern = /^Mouse(2|8|9)$/u;

/** Saved Mac profiles store a mouse trigger as "Mouse2", "Mouse8" or "Mouse9". */
export function macosMouseAccelerator(button: number): string | undefined {
  return button === 2 || button === 8 || button === 9 ? `Mouse${button}` : undefined;
}
export function macosMouseButton(accelerator: string): MacosMouseButton | undefined {
  const match = acceleratorPattern.exec(accelerator);
  return match ? Number(match[1]) as MacosMouseButton : undefined;
}

export interface MacosMouseTapNative {
  /** Installs a listen-only tap for other-mouse-down events; returns false when macOS refuses it. */
  start(onButton: (macosButton: number) => void): boolean;
  stop(): void;
}
export type MacosMouseTapFactory = () => MacosMouseTapNative;

/**
 * Global listener for extra mouse buttons. Only the button number of other-mouse-down events
 * crosses FFI; no pointer position, keyboard input or event content is read or modified.
 */
export class MacosMouseTrigger {
  private native: MacosMouseTapNative | undefined;
  private readonly callbacks = new Map<MacosMouseButton, () => void>();
  private constructor(private readonly factory: MacosMouseTapFactory) {}

  static create(factory: MacosMouseTapFactory = createNativeMacosMouseTap, platform: string = process.platform): MacosMouseTrigger | undefined {
    return platform === "darwin" ? new MacosMouseTrigger(factory) : undefined;
  }
  register(accelerator: string, callback: () => void): boolean {
    const button = macosMouseButton(accelerator);
    if (button === undefined || this.callbacks.has(button)) return false;
    if (!this.native) {
      const native = this.factory();
      if (!native.start((value) => { const mapped = macosButtons[value]; if (mapped !== undefined) this.callbacks.get(mapped)?.(); })) {
        throw new Error("The Mac mouse trigger listener is unavailable.");
      }
      this.native = native;
    }
    this.callbacks.set(button, callback);
    return true;
  }
  unregister(accelerator: string): void {
    const button = macosMouseButton(accelerator);
    if (button === undefined) return;
    this.callbacks.delete(button);
    if (this.callbacks.size === 0) this.close();
  }
  close(): void {
    this.callbacks.clear();
    const native = this.native; this.native = undefined;
    native?.stop();
  }
}

const kCGSessionEventTap = 1, kCGHeadInsertEventTap = 0, kCGEventTapOptionListenOnly = 1;
const kCGEventOtherMouseDown = 25, kCGMouseEventButtonNumber = 3;
// macOS disables a tap that is too slow or interrupted by user input; it must be re-enabled.
const kCGEventTapDisabledByTimeout = 0xfffffffe, kCGEventTapDisabledByUserInput = 0xffffffff;

function createNativeMacosMouseTap(): MacosMouseTapNative {
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const libraries: LibraryHandle[] = [];
  let tap: unknown, source: unknown, callback: unknown;
  let release: ((reference: unknown) => void) | undefined;
  let removeSource: (() => void) | undefined, disable: (() => void) | undefined;
  return {
    start(onButton) {
      const cg = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"); libraries.push(cg);
      const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"); libraries.push(cf);
      const prototype = koffi.proto("void *OpenWhisperMouseTapCallback(void *proxy, uint32_t type, void *event, void *info)");
      const create = cg.func("void *CGEventTapCreate(uint32_t tap, uint32_t place, uint32_t options, uint64_t mask, OpenWhisperMouseTapCallback *callback, void *info)");
      const field = cg.func("int64_t CGEventGetIntegerValueField(void *event, uint32_t field)");
      const enable = cg.func("void CGEventTapEnable(void *tap, bool enable)");
      const createSource = cf.func("void *CFMachPortCreateRunLoopSource(void *allocator, void *port, long order)");
      const mainLoop = cf.func("void *CFRunLoopGetMain(void)");
      const add = cf.func("void CFRunLoopAddSource(void *loop, void *source, void *mode)");
      const remove = cf.func("void CFRunLoopRemoveSource(void *loop, void *source, void *mode)");
      const invalidate = cf.func("void CFMachPortInvalidate(void *port)");
      const cfRelease = cf.func("void CFRelease(void *reference)");
      release = (reference) => { cfRelease(reference); };
      const commonModes: unknown = koffi.decode(cf.symbol("kCFRunLoopCommonModes", "void *"), "void *");
      callback = koffi.register((_proxy: unknown, type: number, event: unknown) => {
        if (type === kCGEventTapDisabledByTimeout || type === kCGEventTapDisabledByUserInput) { if (tap) enable(tap, true); return event; }
        if (type === kCGEventOtherMouseDown) {
          try { onButton(Number(field(event, kCGMouseEventButtonNumber))); } catch { /* Never let a trigger failure break event delivery. */ }
        }
        return event;
      }, koffi.pointer(prototype));
      tap = create(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, 1n << BigInt(kCGEventOtherMouseDown), callback, null);
      if (!tap) { this.stop(); return false; }
      source = createSource(null, tap, 0);
      if (!source) { this.stop(); return false; }
      const loop: unknown = mainLoop();
      add(loop, source, commonModes);
      removeSource = () => { remove(loop, source, commonModes); };
      disable = () => { enable(tap, false); invalidate(tap); };
      enable(tap, true);
      return true;
    },
    stop() {
      try { removeSource?.(); } catch { /* Continue releasing owned references. */ }
      try { disable?.(); } catch { /* Continue releasing owned references. */ }
      for (const reference of [source, tap]) { try { if (reference) release?.(reference); } catch { /* Best effort. */ } }
      try { if (callback) koffi.unregister(callback as never); } catch { /* Best effort. */ }
      for (const library of libraries.reverse()) { try { library.unload(); } catch { /* Best effort. */ } }
      libraries.length = 0; tap = source = callback = undefined; removeSource = disable = undefined;
    },
  };
}

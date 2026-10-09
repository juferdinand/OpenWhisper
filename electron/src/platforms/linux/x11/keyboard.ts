import { createRequire } from "node:module";
import type { LibraryHandle } from "koffi";
import { x11TriggerSchema, type X11Trigger } from "../../../contracts/ui.js";
import type { ControlCapturePort } from "../../../core/recording-control.js";
import { ShortcutRecording } from "../../../core/shortcut-recording.js";

export interface X11KeyboardState {
  available: boolean;
  configuring: boolean;
  trigger: X11Trigger | null;
  label: string | null;
  result: "NONE" | "ENABLED" | "CANCELLED" | "ENDED" | "FAILED" | "CONFLICT";
}
export class X11KeyboardError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "CONFLICT" | "LAYOUT" | "CLOSED") {
    super("Native X11 keyboard operation failed."); this.name = "X11KeyboardError";
  }
}
export type X11KeyboardEvent =
  | { type: "press" | "release"; keycode: number; state: number; keysym: number; trigger: X11Trigger | null }
  | { type: "layout" };
/** The inert seam exercises ownership and real edge semantics without opening a display. */
export interface X11KeyboardNative {
  bind(trigger: X11Trigger): X11Trigger;
  unbind(): void;
  beginCapture(windowId: number): void;
  endCapture(): void;
  focusWithin(windowId: number): boolean;
  nextEvent(): X11KeyboardEvent | null;
  label(trigger: X11Trigger): string;
  close(): void;
}
export type X11KeyboardNativeFactory = (display: string) => X11KeyboardNative;

export function isGenuineX11(display: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return /^:[0-9]+(?:\.[0-9]+)?$/.test(display) && display.length <= 33 &&
    environment.XDG_SESSION_TYPE?.toLowerCase() !== "wayland" && !environment.WAYLAND_DISPLAY;
}

export class X11Keyboard {
  private snapshot: X11KeyboardState = { available: true, configuring: false, trigger: null, label: null, result: "NONE" };
  private recording: ShortcutRecording;
  private holding = false;
  private held = false;
  private previous: X11Trigger | null = null;
  private candidate: X11Trigger | null = null;
  private captureWindow: number | undefined;
  private closed = false;
  private operation: Promise<void> = Promise.resolve();
  private busy = false;
  private readonly timer: NodeJS.Timeout;
  private closeTask: Promise<void> | undefined;

  private constructor(private readonly native: X11KeyboardNative, private readonly capture: ControlCapturePort,
    private readonly changed: (state: X11KeyboardState) => void) {
    this.recording = this.newRecording();
    this.timer = setInterval(() => { this.pump(); }, 15); this.timer.unref();
  }
  static async create(display: string, capture: ControlCapturePort, changed: (state: X11KeyboardState) => void,
    factory: X11KeyboardNativeFactory = createNativeX11Keyboard): Promise<X11Keyboard | undefined> {
    if (!isGenuineX11(display)) return undefined;
    try { return new X11Keyboard(factory(display), capture, changed); } catch { return undefined; }
  }
  state(): X11KeyboardState { return { ...this.snapshot, trigger: this.snapshot.trigger && { ...this.snapshot.trigger } }; }
  mode(hold: boolean): void { this.holding = hold; }
  private newRecording(): ShortcutRecording {
    return new ShortcutRecording(this.capture, () => this.holding, () => { this.publish("FAILED"); });
  }
  private publish(result: X11KeyboardState["result"], trigger: X11Trigger | null = this.snapshot.trigger): void {
    this.snapshot = { available: !this.closed, configuring: this.captureWindow !== undefined, trigger,
      label: trigger ? this.native.label(trigger) : null, result };
    this.changed(this.state());
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(async () => {
      if (this.closed) throw new X11KeyboardError("CLOSED");
      this.busy = true;
      try { return await action(); } finally { this.busy = false; }
    });
    this.operation = next.then(() => {}, () => {}); return next;
  }
  private async resetRecording(): Promise<void> {
    this.held = false; await this.recording.close(); this.recording = this.newRecording();
  }
  async bind(trigger: X11Trigger, hold: boolean): Promise<X11Trigger> {
    return this.run(async () => {
      const previous = this.snapshot.trigger;
      await this.resetRecording(); this.finishCapture(); this.native.unbind();
      try {
        const bound = this.native.bind(x11TriggerSchema.parse(trigger));
        this.holding = hold; this.publish("ENABLED", bound); return bound;
      } catch (error: unknown) {
        this.restore(previous); this.publish(error instanceof X11KeyboardError && error.code === "CONFLICT" ? "CONFLICT" : "FAILED");
        throw error;
      }
    });
  }
  async prepareCapture(windowId: number, hold: boolean): Promise<void> {
    return this.run(async () => {
      if (!Number.isSafeInteger(windowId) || windowId <= 1) throw new X11KeyboardError("UNAVAILABLE");
      const previous = this.captureWindow === undefined ? this.snapshot.trigger : this.previous;
      await this.resetRecording(); this.finishCapture(); this.native.unbind();
      this.previous = previous; this.holding = hold;
      try { this.native.beginCapture(windowId); this.captureWindow = windowId; this.candidate = null; this.publish("NONE"); }
      catch (error: unknown) { this.restore(previous); this.publish("FAILED"); throw error; }
    });
  }
  async cancelSetup(): Promise<void> {
    return this.run(async () => { if (this.captureWindow !== undefined) this.cancelCapture(); });
  }
  async clear(): Promise<void> {
    return this.run(async () => {
      await this.resetRecording(); this.finishCapture(); this.native.unbind(); this.previous = null; this.publish("NONE", null);
    });
  }
  private finishCapture(): void {
    if (this.captureWindow !== undefined) this.native.endCapture();
    this.captureWindow = undefined; this.candidate = null;
  }
  private restore(trigger: X11Trigger | null): void {
    if (!trigger) { this.snapshot.trigger = null; return; }
    try { this.snapshot.trigger = this.native.bind(trigger); }
    catch { this.snapshot.trigger = null; }
  }
  private cancelCapture(): void {
    const previous = this.previous; this.finishCapture(); this.restore(previous); this.previous = null; this.publish("CANCELLED");
  }
  private commitCapture(): void {
    const candidate = this.candidate, previous = this.previous;
    this.finishCapture(); this.previous = null;
    if (!candidate) return;
    try { this.publish("ENABLED", this.native.bind(candidate)); }
    catch (error: unknown) {
      this.restore(previous); this.publish(error instanceof X11KeyboardError && error.code === "CONFLICT" ? "CONFLICT" : "FAILED");
    }
  }
  /** Bounded queue draining; XNextEvent is called only after XPending. */
  pump(): void {
    if (this.closed || this.busy) return;
    try {
      if (this.captureWindow !== undefined && !this.native.focusWithin(this.captureWindow)) this.cancelCapture();
      for (let count = 0; count < 64; count++) {
        const event = this.native.nextEvent(); if (!event) break;
        if (event.type === "layout") {
          // Before a candidate exists, setup can capture the forthcoming key
          // against the current map. Never carry a captured or active key across it.
          if (this.captureWindow !== undefined && this.candidate === null) continue;
          this.finishCapture(); this.native.unbind(); this.previous = null;
          void this.run(async () => { await this.resetRecording(); this.publish("ENDED", null); }).catch(() => { this.publish("FAILED", null); });
          break;
        }
        if (this.captureWindow !== undefined) {
          if (event.type === "press" && event.keysym === 0xff1b) { this.cancelCapture(); continue; }
          if (event.type === "press" && !this.candidate && event.trigger) this.candidate = event.trigger;
          else if (event.type === "release" && this.candidate?.keycode === event.keycode) this.commitCapture();
          continue;
        }
        const trigger = this.snapshot.trigger;
        if (!trigger || event.keycode !== trigger.keycode || ((event.state >>> 13) & 3) !== trigger.group) continue;
        if (event.type === "press" && !this.held) { this.held = true; this.recording.activate(); }
        else if (event.type === "release" && this.held) { this.held = false; this.recording.deactivate(); }
      }
    } catch {
      try { this.finishCapture(); this.native.unbind(); } catch { /* Original utility exit remains the final cleanup boundary. */ }
      void this.run(async () => { await this.resetRecording(); this.publish("FAILED", null); }).catch(() => {});
    }
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true; clearInterval(this.timer);
    this.closeTask = this.operation.then(async () => {
      try { await this.recording.close(); } finally { this.native.close(); }
    });
    void this.closeTask.catch(() => {}); return this.closeTask;
  }
}

type Koffi = typeof import("koffi");
type NativeCall = (...args: unknown[]) => unknown;
function bindFunction(library: LibraryHandle, definition: string): NativeCall {
  const fn = library.func(definition); return (...args) => { const result: unknown = fn(...args); return result; };
}
function integer(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) throw new X11KeyboardError("UNAVAILABLE");
  return result;
}
function pointer(value: unknown): bigint {
  if (typeof value !== "bigint" || value === 0n) throw new X11KeyboardError("UNAVAILABLE"); return value;
}
function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) throw new X11KeyboardError("UNAVAILABLE"); return Reflect.get(value, name);
}

/** Fixed system libraries and one private Xlib connection, confined to the platform utility. */
export function createNativeX11Keyboard(displayName: string): X11KeyboardNative {
  if (!isGenuineX11(displayName)) throw new X11KeyboardError("UNAVAILABLE");
  const imported: unknown = createRequire(import.meta.url)("koffi");
  if (typeof imported !== "object" || imported === null || typeof Reflect.get(imported, "load") !== "function") throw new X11KeyboardError("UNAVAILABLE");
  const ffi = imported as Koffi;
  const library = ffi.load("libX11.so.6"), symbols = ffi.load("libxkbcommon.so.0");
  const f = {
    open: bindFunction(library, "void *XOpenDisplay(const char *name)"), close: bindFunction(library, "int XCloseDisplay(void *display)"),
    handler: bindFunction(library, "void *XSetErrorHandler(void *handler)"), sync: bindFunction(library, "int XSync(void *display, int discard)"),
    screenCount: bindFunction(library, "int XScreenCount(void *display)"), root: bindFunction(library, "unsigned long XRootWindow(void *display, int screen)"),
    extension: bindFunction(library, "int XkbQueryExtension(void *display, _Out_ int *opcode, _Out_ int *event, _Out_ int *error, _Inout_ int *major, _Inout_ int *minor)"),
    repeat: bindFunction(library, "int XkbSetDetectableAutoRepeat(void *display, int enabled, _Out_ int *supported)"),
    getState: bindFunction(library, "int XkbGetState(void *display, unsigned int device, _Out_ void *state)"),
    getModifiers: bindFunction(library, "void *XGetModifierMapping(void *display)"), freeModifiers: bindFunction(library, "int XFreeModifiermap(void *map)"),
    keySymbol: bindFunction(library, "unsigned long XkbKeycodeToKeysym(void *display, unsigned char keycode, int group, int level)"),
    lookup: bindFunction(library, "int XkbLookupKeySym(void *display, unsigned char keycode, unsigned int state, _Out_ unsigned int *remaining, _Out_ unsigned long *symbol)"),
    lower: bindFunction(symbols, "uint32_t xkb_keysym_to_lower(uint32_t symbol)"), unicode: bindFunction(symbols, "uint32_t xkb_keysym_to_utf32(uint32_t symbol)"),
    name: bindFunction(library, "const char *XKeysymToString(unsigned long symbol)"),
    grab: bindFunction(library, "int XGrabKey(void *display, int keycode, unsigned int modifiers, unsigned long window, int owner_events, int pointer_mode, int keyboard_mode)"),
    ungrab: bindFunction(library, "int XUngrabKey(void *display, int keycode, unsigned int modifiers, unsigned long window)"),
    grabKeyboard: bindFunction(library, "int XGrabKeyboard(void *display, unsigned long window, int owner_events, int pointer_mode, int keyboard_mode, unsigned long time)"),
    ungrabKeyboard: bindFunction(library, "int XUngrabKeyboard(void *display, unsigned long time)"),
    select: bindFunction(library, "int XkbSelectEvents(void *display, unsigned int device, unsigned int affect, unsigned int values)"),
    selectDetails: bindFunction(library, "int XkbSelectEventDetails(void *display, unsigned int device, unsigned int event, unsigned long affect, unsigned long details)"),
    pending: bindFunction(library, "int XPending(void *display)"), next: bindFunction(library, "int XNextEvent(void *display, _Out_ void *event)"),
    focus: bindFunction(library, "int XGetInputFocus(void *display, _Out_ unsigned long *focus, _Out_ int *revert)"),
    tree: bindFunction(library, "int XQueryTree(void *display, unsigned long window, _Out_ unsigned long *root, _Out_ unsigned long *parent, _Out_ void **children, _Out_ unsigned int *count)"),
    free: bindFunction(library, "int XFree(void *pointer)"),
  };
  const keyEvent = ffi.struct({ type: "int", serial: "unsigned long", send_event: "int", display: "void *", window: "unsigned long",
    root: "unsigned long", subwindow: "unsigned long", time: "unsigned long", x: "int", y: "int", x_root: "int", y_root: "int",
    state: "unsigned int", keycode: "unsigned int", same_screen: "int" });
  const xkbEvent = ffi.struct({ type: "int", serial: "unsigned long", send_event: "int", display: "void *", time: "unsigned long", xkb_type: "int", device: "unsigned int" });
  const mappingEvent = ffi.struct({ type: "int", serial: "unsigned long", send_event: "int", display: "void *", window: "unsigned long",
    request: "int", first_keycode: "int", count: "int" });
  const errorEvent = ffi.struct({ type: "int", display: "void *", resourceid: "unsigned long", serial: "unsigned long", error_code: "unsigned char", request_code: "unsigned char", minor_code: "unsigned char" });
  const modifierMap = ffi.struct({ max_keypermod: "int", modifiermap: "void *" });
  // XKBstr.h order is authoritative; the legacy x11-dl record had a different order.
  const keyboardState = ffi.struct({ group: "unsigned char", locked_group: "unsigned char", base_group: "unsigned short", latched_group: "unsigned short",
    mods: "unsigned char", base_mods: "unsigned char", latched_mods: "unsigned char", locked_mods: "unsigned char", compat_state: "unsigned char",
    grab_mods: "unsigned char", compat_grab_mods: "unsigned char", lookup_mods: "unsigned char", compat_lookup_mods: "unsigned char", ptr_buttons: "unsigned short" });
  if (ffi.sizeof(keyboardState) !== 18 || ffi.offsetof(keyboardState, "mods") !== 6 || ffi.offsetof(keyboardState, "ptr_buttons") !== 16) throw new X11KeyboardError("UNAVAILABLE");
  const display = pointer(f.open(displayName));
  let lastError = 0, callbackFailed = false, closed = false, capture = false;
  const errorCallback = ffi.register((_display: unknown, event: unknown) => {
    try { lastError = integer(field(ffi.decode(pointer(event), errorEvent), "error_code")); }
    catch { callbackFailed = true; } return 0;
  }, ffi.pointer(ffi.proto("int", ["void *", "void *"])));
  const oldHandler = f.handler(errorCallback);
  const roots: number[] = [];
  let current: X11Trigger | null = null;
  function sync(): void {
    f.sync(display, 0); const error = lastError; lastError = 0;
    if (callbackFailed || error) throw new X11KeyboardError(error === 10 ? "CONFLICT" : "UNAVAILABLE");
  }
  function stateGroup(): number {
    const state = Buffer.alloc(ffi.sizeof(keyboardState));
    if (integer(f.getState(display, 0x100, state)) !== 0) throw new X11KeyboardError("UNAVAILABLE");
    sync(); return integer(field(ffi.decode(state, keyboardState), "group"));
  }
  function symbolFor(keycode: number, state: number): number {
    const symbol: unknown[] = [0], remaining: unknown[] = [0];
    if (!integer(f.lookup(display, keycode, state, remaining, symbol))) return 0;
    return integer(f.lower(integer(symbol[0])));
  }
  function supported(symbol: number): boolean {
    if (symbol === 0 || symbol === 0xff1b || symbol > 0x1fffffff || (symbol >= 0xffe1 && symbol <= 0xffee) ||
      [0xff7f, 0xff14, 0xfe03, 0xfe11].includes(symbol) || typeof f.name(symbol) !== "string") return false;
    const unicode = integer(f.unicode(symbol));
    return unicode === 0 || (unicode <= 0x10ffff && !/\p{Cc}/u.test(String.fromCodePoint(unicode)));
  }
  function ignoredLocks(): number {
    const map = pointer(f.getModifiers(display));
    try {
      const decoded: unknown = ffi.decode(map, modifierMap), maximum = integer(field(decoded, "max_keypermod"));
      if (maximum < 1 || maximum > 32) throw new X11KeyboardError("UNAVAILABLE");
      const codes: unknown = ffi.decode(pointer(field(decoded, "modifiermap")), ffi.array("unsigned char", maximum * 8));
      let ignored = 2;
      for (let modifier = 0; modifier < 8; modifier++) for (let index = 0; index < maximum; index++) {
        const code = integer(field(codes, String(modifier * maximum + index))); if (!code) continue;
        for (let level = 0; level < 4; level++) if ([0xff7f, 0xff14, 0xffe5].includes(integer(f.keySymbol(display, code, 0, level)))) ignored |= 1 << modifier;
      }
      sync(); return ignored;
    } finally { f.freeModifiers(map); }
  }
  function unbind(): void {
    // Removing a passive grab alone does not release its already active grab.
    f.ungrabKeyboard(display, 0); capture = false;
    for (const root of roots) f.ungrab(display, 0, 1 << 15, root);
    current = null; sync();
  }
  function endCapture(): void { if (capture) { f.ungrabKeyboard(display, 0); capture = false; sync(); } }
  function focusWithin(windowId: number): boolean {
    const focus: unknown[] = [0], revert: unknown[] = [0]; f.focus(display, focus, revert); sync();
    let window = integer(focus[0]);
    for (let count = 0; count < 64 && window > 1; count++) {
      if (window === windowId) return true;
      const root: unknown[] = [0], parent: unknown[] = [0], children: unknown[] = [null], size: unknown[] = [0];
      const available = integer(f.tree(display, window, root, parent, children, size));
      if (typeof children[0] === "bigint" && children[0] !== 0n) f.free(children[0]);
      sync(); if (!available) return false;
      const next = integer(parent[0]); if (next === window) return false; window = next;
    }
    return false;
  }
  function close(): void {
    if (closed) return; closed = true;
    try { endCapture(); unbind(); }
    finally { try { f.close(display); } finally { f.handler(oldHandler); ffi.unregister(errorCallback); } }
  }
  try {
    const count = integer(f.screenCount(display)); if (count < 1 || count > 64) throw new X11KeyboardError("UNAVAILABLE");
    for (let screen = 0; screen < count; screen++) roots.push(integer(f.root(display, screen)));
    const opcode: unknown[] = [0], event: unknown[] = [0], error: unknown[] = [0], major: unknown[] = [1], minor: unknown[] = [0], repeat: unknown[] = [0];
    if (!integer(f.extension(display, opcode, event, error, major, minor)) || !integer(f.repeat(display, 1, repeat)) || !integer(repeat[0])) throw new X11KeyboardError("UNAVAILABLE");
    const eventBase = integer(event[0]);
    f.select(display, 0x100, 3, 3); f.selectDetails(display, 0x100, 2, 1 << 4, 1 << 4); sync();
    const eventBuffer = Buffer.alloc(ffi.sizeof(ffi.array("long", 24)));
    return {
      bind(value) {
        const trigger = x11TriggerSchema.parse(value); if (!supported(trigger.keysym)) throw new X11KeyboardError("UNAVAILABLE");
        if (stateGroup() !== trigger.group) throw new X11KeyboardError("LAYOUT");
        const ignored = ignoredLocks(), wanted = { ...trigger, modifiers: trigger.modifiers & ~ignored };
        if (symbolFor(wanted.keycode, wanted.modifiers | (wanted.group << 13)) !== wanted.keysym) throw new X11KeyboardError("LAYOUT");
        const locks = Array.from({ length: 8 }, (_, bit) => 1 << bit).filter((mask) => ignored & mask);
        const variants = Array.from({ length: 1 << locks.length }, (_, variant) =>
          locks.reduce((mask, lock, bit) => mask | ((variant & (1 << bit)) ? lock : 0), wanted.modifiers));
        // A keypad key must not silently change meaning when NumLock changes.
        if (variants.some((modifiers) => symbolFor(wanted.keycode, modifiers | (wanted.group << 13)) !== wanted.keysym)) {
          throw new X11KeyboardError("LAYOUT");
        }
        try {
          for (const root of roots) for (const modifiers of variants) {
            f.grab(display, wanted.keycode, modifiers, root, 0, 1, 1); sync();
          }
        } catch (error: unknown) { unbind(); throw error; }
        current = wanted; return wanted;
      }, unbind, endCapture, focusWithin,
      beginCapture(windowId) {
        if (!focusWithin(windowId)) throw new X11KeyboardError("UNAVAILABLE");
        // Prior startup/map notices belong to the retired binding. Start the
        // explicit grab with a fresh queue; current key/group is checked at bind.
        f.sync(display, 1); sync();
        if (integer(f.grabKeyboard(display, windowId, 0, 1, 1, 0)) !== 0) throw new X11KeyboardError("CONFLICT");
        capture = true; sync();
      },
      nextEvent() {
        // Ignore unrelated messages while retaining a fixed processing budget.
        for (let count = 0; count < 64 && integer(f.pending(display)) > 0; count++) {
          f.next(display, eventBuffer); const type = integer(ffi.decode(eventBuffer, "int"));
          if (type === 34) {
            const request = integer(field(ffi.decode(eventBuffer, mappingEvent), "request"));
            if (request === 0 || request === 1) return { type: "layout" };
            continue; // Pointer mapping does not change the keyboard binding.
          }
          if (type === eventBase) {
            const subtype = integer(field(ffi.decode(eventBuffer, xkbEvent), "xkb_type"));
            if (subtype === 0 || subtype === 1 || (subtype === 2 && current && stateGroup() !== current.group)) return { type: "layout" };
          }
          if (type !== 2 && type !== 3) continue;
          const decoded: unknown = ffi.decode(eventBuffer, keyEvent), keycode = integer(field(decoded, "keycode")), state = integer(field(decoded, "state"));
          const keysym = symbolFor(keycode, state);
          const candidate = { keycode, keysym, modifiers: state & 255 & ~2, group: (state >>> 13) & 3 };
          const parsed = x11TriggerSchema.safeParse(candidate);
          return { type: type === 2 ? "press" : "release", keycode, state, keysym, trigger: parsed.success && supported(keysym) ? parsed.data : null };
        }
        return null;
      },
      label(trigger) {
        const parts = [[4, "Ctrl"], [8, "Alt"], [1, "Shift"], [64, "Super"]] as const;
        const labels: string[] = parts.filter(([mask]) => trigger.modifiers & mask).map(([, name]) => name);
        for (const [mask, name] of [[16, "Mod2"], [32, "Mod3"], [128, "Mod5"]] as const) if (trigger.modifiers & mask) labels.push(name);
        const unicode = integer(f.unicode(trigger.keysym)), name: unknown = f.name(trigger.keysym);
        const character = unicode > 0 && unicode <= 0x10ffff ? String.fromCodePoint(unicode) : "";
        labels.push(character && !/[\p{Cc}\s]/u.test(character) ? character.toUpperCase() : name === "space" ? "Space" : typeof name === "string" ? name : "Unknown key");
        return labels.join("+");
      }, close,
    };
  } catch (error: unknown) { close(); throw error; }
}

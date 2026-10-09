import type { GlobalShortcut, Input } from "electron";
import type { ControlCapturePort } from "../platforms/linux/shared/control.js";
import { ShortcutRecording } from "../platforms/linux/shared/shortcut-recording.js";

export interface MacosShortcutState {
  available: boolean;
  configuring: boolean;
  accelerator: string | null;
  label: string | null;
  result: "NONE" | "ENABLED" | "CANCELLED" | "UNSUPPORTED" | "CONFLICT" | "FAILED";
}
export interface MacosShortcutOptions {
  readonly shortcuts: Pick<GlobalShortcut, "register" | "unregister">;
  readonly capture: ControlCapturePort;
  readonly allowed: () => boolean;
  /** Explicit setup can already own the recording-control reservation that blocks global callbacks. */
  readonly setupAllowed?: () => boolean;
  readonly changed: (state: MacosShortcutState) => void;
}
export type MacosShortcutInput = Pick<Input, "type" | "key" | "code" | "shift" | "control" | "alt" | "meta"> &
  Partial<Pick<Input, "isAutoRepeat" | "isComposing" | "modifiers">>;
export class MacosShortcutError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "UNSUPPORTED" | "CONFLICT" | "FAILED" | "CLOSED") {
    super("Mac shortcut operation failed."); this.name = "MacosShortcutError";
  }
}

const modifierOrder = ["Command", "Control", "Alt", "Shift"] as const;
const modifiers = new Set<string>(modifierOrder);
const modifierKeys = new Set(["Meta", "Control", "Alt", "Shift"]);
const namedKeys = new Set(["Space", "Tab", "Return", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "Up", "Down", "Left", "Right", "Plus"]);
const inputNames: Readonly<Record<string, string>> = { " ": "Space", Enter: "Return", ArrowUp: "Up",
  ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", "+": "Plus" };
function regularKey(key: string): boolean {
  return /^[A-Z0-9]$/u.test(key) || (key.length === 1 && ",./;'[]\\-=`".includes(key)) ||
    /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(key) || namedKeys.has(key);
}
/** Saved profiles contain one regular key, with explicit Mac modifiers and no aliases. */
export function normalizeMacosShortcutAccelerator(value: string): string | undefined {
  if (value.length === 0 || value.length > 128) return undefined;
  const parts = value.split("+"), key = parts.pop();
  if (!key || !regularKey(key) || new Set(parts).size !== parts.length || parts.some((part) => !modifiers.has(part))) return undefined;
  return [...modifierOrder.filter((modifier) => parts.includes(modifier)), key].join("+");
}
function acceleratorFor(input: MacosShortcutInput): string | undefined {
  if (input.isComposing || input.code.startsWith("Numpad") || input.modifiers?.some((modifier) =>
    /^(?:fn|function|iskeypad|leftbuttondown|middlebuttondown|rightbuttondown)$/iu.test(modifier))) return undefined;
  const key = inputNames[input.key] ?? (/^[a-z]$/u.test(input.key) ? input.key.toUpperCase() : input.key);
  const parts = [input.meta ? "Command" : "", input.control ? "Control" : "", input.alt ? "Alt" : "",
    input.shift ? "Shift" : "", key].filter(Boolean);
  return normalizeMacosShortcutAccelerator(parts.join("+"));
}
interface Binding { readonly accelerator: string; readonly token: object }

/** Explicit main-window setup only; globalShortcut supplies discrete toggle callbacks, never release edges. */
export class MacosShortcut {
  private binding: Binding | undefined;
  private previous: string | null = null;
  private candidate: { code: string; accelerator: string } | undefined;
  private configuring = false;
  private closed = false;
  private result: MacosShortcutState["result"] = "NONE";
  private closeTask: Promise<void> | undefined;
  private readonly recording: ShortcutRecording;

  constructor(private readonly options: MacosShortcutOptions) {
    const capture: ControlCapturePort = {
      status: () => this.admitted() ? options.capture.status() : "unavailable",
      start: (signal) => {
        if (!this.admitted()) return Promise.reject(new MacosShortcutError("UNAVAILABLE"));
        return options.capture.start(signal);
      },
      currentLease: async () => this.admitted() ? options.capture.currentLease?.() : undefined,
    };
    this.recording = new ShortcutRecording(capture, () => false, () => { this.publish("FAILED"); });
  }
  state(): MacosShortcutState {
    const accelerator = this.binding?.accelerator ?? (this.configuring ? this.previous : null);
    return { available: !this.closed, configuring: this.configuring, accelerator, label: accelerator, result: this.result };
  }
  private admitted(): boolean { return !this.closed && !this.configuring && this.options.allowed(); }
  private ensureOpen(): void { if (this.closed) throw new MacosShortcutError("CLOSED"); }
  private publish(result: MacosShortcutState["result"]): void {
    this.result = result; this.options.changed(this.state());
  }
  private register(accelerator: string): Binding {
    const token = {};
    let registered: boolean;
    try {
      registered = this.options.shortcuts.register(accelerator, () => {
        if (this.binding?.token !== token || !this.admitted()) return;
        // A Carbon hotkey callback is one toggle, not a physical held-key edge.
        this.recording.activate(); this.recording.deactivate();
      });
    } catch { throw new MacosShortcutError("FAILED"); }
    if (!registered) throw new MacosShortcutError("CONFLICT");
    return { accelerator, token };
  }
  private unregister(): void {
    const binding = this.binding;
    if (!binding) return;
    this.options.shortcuts.unregister(binding.accelerator); this.binding = undefined;
  }
  bind(value: string): void {
    this.ensureOpen();
    if (this.configuring) throw new MacosShortcutError("UNAVAILABLE");
    const accelerator = normalizeMacosShortcutAccelerator(value);
    if (!accelerator) { this.publish("UNSUPPORTED"); throw new MacosShortcutError("UNSUPPORTED"); }
    if (accelerator === this.binding?.accelerator) { this.publish("ENABLED"); return; }
    let replacement: Binding;
    try { replacement = this.register(accelerator); }
    catch (error: unknown) { this.publish(error instanceof MacosShortcutError && error.code === "CONFLICT" ? "CONFLICT" : "FAILED"); throw error; }
    try { this.unregister(); }
    catch { this.options.shortcuts.unregister(replacement.accelerator); this.publish("FAILED"); throw new MacosShortcutError("FAILED"); }
    this.binding = replacement; this.publish("ENABLED");
  }
  prepareCapture(): void {
    this.ensureOpen();
    if (!(this.options.setupAllowed ?? this.options.allowed)()) throw new MacosShortcutError("UNAVAILABLE");
    if (this.configuring) return;
    this.previous = this.binding?.accelerator ?? null;
    this.unregister(); this.candidate = undefined; this.configuring = true; this.publish("NONE");
  }
  private finishSetup(result: MacosShortcutState["result"], candidate?: string): void {
    const previous = this.previous;
    this.previous = null; this.candidate = undefined; this.configuring = false;
    if (candidate) {
      try { this.binding = this.register(candidate); this.publish("ENABLED"); return; }
      catch (error: unknown) { result = error instanceof MacosShortcutError && error.code === "CONFLICT" ? "CONFLICT" : "FAILED"; }
    }
    if (previous) {
      try { this.binding = this.register(previous); }
      catch { result = "FAILED"; }
    }
    this.publish(result);
  }
  consume(input: MacosShortcutInput): boolean {
    if (this.closed || !this.configuring) return false;
    if (input.type !== "keyDown" && input.type !== "keyUp") { this.finishSetup("UNSUPPORTED"); return true; }
    if (input.key === "Escape" && input.type === "keyDown") { this.cancelSetup(); return true; }
    if (input.isAutoRepeat) return true;
    if (input.type === "keyDown") {
      if (modifierKeys.has(input.key)) return true;
      if (this.candidate) return true;
      const accelerator = acceleratorFor(input);
      if (!accelerator || !input.code) this.finishSetup("UNSUPPORTED");
      else this.candidate = { code: input.code, accelerator };
    } else if (this.candidate?.code === input.code) {
      this.finishSetup("ENABLED", this.candidate.accelerator);
    } else if (!this.candidate && modifierKeys.has(input.key)) { this.finishSetup("UNSUPPORTED"); }
    return true;
  }
  cancelSetup(): void { this.ensureOpen(); if (this.configuring) this.finishSetup("CANCELLED"); }
  focusLost(): void { if (!this.closed && this.configuring) this.finishSetup("CANCELLED"); }
  clear(): void {
    this.ensureOpen(); this.unregister(); this.previous = null; this.candidate = undefined;
    this.configuring = false; this.publish("NONE");
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true; this.configuring = false; this.previous = null; this.candidate = undefined;
    let unregisterFailed = false;
    try { this.unregister(); } catch { unregisterFailed = true; }
    this.closeTask = this.recording.close().then(() => {
      if (unregisterFailed) throw new MacosShortcutError("FAILED");
    });
    this.publish("NONE"); return this.closeTask;
  }
}

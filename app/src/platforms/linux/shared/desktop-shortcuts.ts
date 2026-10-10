import { KdeKeyboard, keyLabel, type KdeJournal, type KdeKeyboardState } from "../kde/keyboard.js";
import { PortalShortcuts, portalShortcutStateSchema, linuxApplicationIdSchema, type LinuxApplicationId,
  type PortalShortcutState, type ShortcutBus } from "./portal-shortcuts.js";
import type { ControlCapturePort } from "../../../core/recording/control.js";
import { X11Keyboard, type X11KeyboardState } from "../x11/keyboard.js";
import { KdeMouse, type KdeMouseState } from "../kde/mouse.js";

/** Only one desktop adapter may own a recording trigger. Portal probing stays independent. */
export class DesktopShortcuts {
  private portal!: PortalShortcuts;
  private kde: KdeKeyboard | undefined;
  private x11: X11Keyboard | undefined;
  private x11State: X11KeyboardState | undefined;
  private mouse: KdeMouse | undefined;
  private mouseState: KdeMouseState = { available: false, middleAvailable: false, button: null, configuring: false, result: "NONE" };
  private mouseSelected = false;
  private portalState = portalShortcutStateSchema.parse({ available: false, configuring: false, label: null, result: "NONE" });
  private kdeState: KdeKeyboardState = { available: false, configuring: false, key: null, result: "NONE" };
  private native = false;
  private epoch = 0;
  private preparing = false;
  private constructor(private readonly changed: (state: PortalShortcutState) => void) {}
  static async create(bus: ShortcutBus, capture: ControlCapturePort, changed: (state: PortalShortcutState) => void,
    journal?: KdeJournal, appId: LinuxApplicationId = "io.github.whisperfree.dev", mouseLeasePath?: string): Promise<DesktopShortcuts> {
    linuxApplicationIdSchema.parse(appId);
    const desktop = new DesktopShortcuts(changed);
    try {
      desktop.portal = await PortalShortcuts.create(bus, capture, (state) => { desktop.portalState = state; desktop.publish(); }, undefined, appId);
      desktop.x11 = await X11Keyboard.create(process.env["DISPLAY"] ?? "", capture,
        (state) => { desktop.x11State = state; desktop.publish(); });
      if (desktop.x11) { desktop.x11State = desktop.x11.state(); desktop.publish(); }
      if (journal && !desktop.x11) {
        desktop.kde = await KdeKeyboard.create(bus, capture, journal, (state) => { desktop.kdeState = state; desktop.publish(); }, appId);
        if (mouseLeasePath) desktop.mouse = await KdeMouse.create(bus, desktop.kde, mouseLeasePath,
          (state) => { desktop.mouseState = state; desktop.publish(); });
      }
      return desktop;
    } catch (error: unknown) {
      await Promise.allSettled([desktop.mouse?.close(), desktop.kde?.close(), desktop.x11?.close(), desktop.portal?.close()]);
      throw error;
    }
  }
  state(): PortalShortcutState {
    if (this.x11State) return portalShortcutStateSchema.parse({ available: this.portalState.available,
      configuring: this.x11State.configuring, label: this.x11State.label, result: this.x11State.result,
      nativeAvailable: this.x11State.available, nativeKey: null, nativeX11: true, x11Trigger: this.x11State.trigger });
    const selected = this.mouseSelected ? { configuring: this.mouseState.configuring,
      label: this.mouseState.button === null ? null : this.mouseState.button === 2 ? "Middle mouse button" : `Mouse button ${this.mouseState.button}`,
      result: this.mouseState.result } : this.native ? { configuring: this.kdeState.configuring,
      label: this.kdeState.key === null ? null : keyLabel(this.kdeState.key), result: this.kdeState.result } : this.portalState;
    return portalShortcutStateSchema.parse({ ...selected, configuring: this.preparing || selected.configuring, available: this.portalState.available,
      nativeAvailable: this.kdeState.available || this.mouseState.available, nativeKey: this.native && !this.mouseSelected ? this.kdeState.key : null,
      nativeMouse: this.mouseState.available, nativeMiddleMouse: this.mouseState.middleAvailable,
      nativeMouseButton: this.mouseSelected ? this.mouseState.button : null });
  }
  private publish(): void { this.changed(this.state()); }
  async prepareKeyCapture(windowId?: number, hold = false): Promise<void> {
    if (this.x11) {
      if (windowId === undefined) throw new Error("X11 capture requires the owned main window.");
      await this.portal.clear(); await this.x11.prepareCapture(windowId, hold); return;
    }
    if (!this.kde || !this.kdeState.available) throw new Error("KDE keyboard shortcuts are unavailable.");
    const epoch = ++this.epoch; this.preparing = true; this.publish();
    try { await this.kde.prepareCapture(); }
    finally { if (epoch === this.epoch) { this.preparing = false; this.publish(); } }
  }
  async bind(key: number, hold: boolean): Promise<void> {
    if (!this.kde || !this.kdeState.available) throw new Error("KDE keyboard shortcuts are unavailable.");
    const epoch = ++this.epoch; this.native = true; this.preparing = true; this.publish();
    try {
      if (this.mouseSelected) { await this.mouse?.clear("ENDED"); this.mouseSelected = false; }
      await this.portal.clear();
      if (epoch === this.epoch) await this.kde.bind(key, hold);
    } finally { if (epoch === this.epoch) { this.preparing = false; this.publish(); } }
  }
  async prepareMouseCapture(button: number): Promise<void> {
    if (!this.mouse) throw new Error("KDE mouse triggers are unavailable.");
    await this.mouse.prepareCapture(button);
  }
  async bindMouse(button: number, hold: boolean): Promise<void> {
    if (!this.mouse) throw new Error("KDE mouse triggers are unavailable.");
    const epoch = ++this.epoch; this.mouseSelected = true; this.preparing = true; this.publish();
    try {
      await this.portal.clear();
      if (epoch === this.epoch) await this.mouse.bind(button, hold);
    } finally { if (epoch === this.epoch) { this.preparing = false; this.publish(); } }
  }
  command(action: "enable" | "configure" | "clear" | "cancel" | "mode", hold: boolean): void {
    if (this.x11) {
      if (action === "mode") { this.x11.mode(hold); return; }
      if (action === "configure" || action === "enable") {
        this.changed({ ...this.state(), result: "CONFIGURE_UNAVAILABLE" }); return;
      }
      const cleanup = action === "cancel" ? this.x11.cancelSetup() : this.x11.clear();
      void cleanup.catch(() => this.changed({ ...this.state(), result: "FAILED" })); return;
    }
    if (action === "mode") {
      this.kde?.mode(hold); this.portal.command(action, hold);
      const button = this.mouseSelected ? this.mouseState.button : null;
      if (button !== null) void this.mouse?.bind(button, hold).catch(() => this.changed({ ...this.state(), result: "FAILED" }));
      return;
    }
    if (!this.native && !this.mouseSelected) { this.portal.command(action, hold); return; }
    if (action === "configure" || action === "enable") {
      this.changed({ ...this.state(), result: "CONFIGURE_UNAVAILABLE" }); return;
    }
    this.epoch++; this.preparing = false;
    if (this.mouseSelected) {
      if (action === "cancel") { void this.kde?.cancelSetup().catch(() => this.changed({ ...this.state(), result: "FAILED" })); return; }
      void this.mouse?.clear("NONE").then(() => { this.mouseSelected = false; this.publish(); },
        () => this.changed({ ...this.state(), result: "FAILED" }));
      return;
    }
    const cleanup = action === "cancel" ? this.kde?.cancelSetup() : this.kde?.clear();
    void cleanup?.catch(() => this.changed({ ...this.state(), result: "FAILED" }));
  }
  async close(): Promise<void> {
    this.epoch++; this.preparing = false;
    const failures: unknown[] = [];
    for (const close of [() => this.x11?.close(), () => this.mouse?.close(), () => this.kde?.close(), () => this.portal.close()]) {
      try { await close(); } catch (error: unknown) { failures.push(error); }
    }
    if (failures.length > 0) throw failures[0];
  }
}

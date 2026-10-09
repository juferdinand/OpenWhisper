import { KdeKeyboard, keyLabel, type KdeJournal, type KdeKeyboardState } from "../kde/keyboard.js";
import { PortalShortcuts, portalShortcutStateSchema, linuxApplicationIdSchema, type LinuxApplicationId,
  type PortalShortcutState, type ShortcutBus } from "./portal-shortcuts.js";
import type { ControlCapturePort } from "../../../core/recording-control.js";
import { X11Keyboard, type X11KeyboardState } from "../x11/keyboard.js";

/** Only one desktop adapter may own a recording trigger. Portal probing stays independent. */
export class DesktopShortcuts {
  private portal!: PortalShortcuts;
  private kde: KdeKeyboard | undefined;
  private x11: X11Keyboard | undefined;
  private x11State: X11KeyboardState | undefined;
  private portalState = portalShortcutStateSchema.parse({ available: false, configuring: false, label: null, result: "NONE" });
  private kdeState: KdeKeyboardState = { available: false, configuring: false, key: null, result: "NONE" };
  private native = false;
  private epoch = 0;
  private preparing = false;
  private constructor(private readonly changed: (state: PortalShortcutState) => void) {}
  static async create(bus: ShortcutBus, capture: ControlCapturePort, changed: (state: PortalShortcutState) => void,
    journal?: KdeJournal, appId: LinuxApplicationId = "io.github.whisperfree.dev"): Promise<DesktopShortcuts> {
    linuxApplicationIdSchema.parse(appId);
    const desktop = new DesktopShortcuts(changed);
    desktop.portal = await PortalShortcuts.create(bus, capture, (state) => { desktop.portalState = state; desktop.publish(); }, undefined, appId);
    desktop.x11 = await X11Keyboard.create(process.env["DISPLAY"] ?? "", capture,
      (state) => { desktop.x11State = state; desktop.publish(); });
    if (desktop.x11) { desktop.x11State = desktop.x11.state(); desktop.publish(); }
    if (journal && !desktop.x11) desktop.kde = await KdeKeyboard.create(bus, capture, journal, (state) => { desktop.kdeState = state; desktop.publish(); }, appId);
    return desktop;
  }
  state(): PortalShortcutState {
    if (this.x11State) return portalShortcutStateSchema.parse({ available: this.portalState.available,
      configuring: this.x11State.configuring, label: this.x11State.label, result: this.x11State.result,
      nativeAvailable: this.x11State.available, nativeKey: null, nativeX11: true, x11Trigger: this.x11State.trigger });
    const selected = this.native ? { configuring: this.kdeState.configuring,
      label: this.kdeState.key === null ? null : keyLabel(this.kdeState.key), result: this.kdeState.result } : this.portalState;
    return portalShortcutStateSchema.parse({ ...selected, configuring: this.preparing || selected.configuring, available: this.portalState.available,
      nativeAvailable: this.kdeState.available, nativeKey: this.native ? this.kdeState.key : null });
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
      await this.portal.clear();
      if (epoch === this.epoch) await this.kde.bind(key, hold);
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
    if (action === "mode") { this.kde?.mode(hold); this.portal.command(action, hold); return; }
    if (!this.native) { this.portal.command(action, hold); return; }
    if (action === "configure" || action === "enable") {
      this.changed({ ...this.state(), result: "CONFIGURE_UNAVAILABLE" }); return;
    }
    this.epoch++; this.preparing = false;
    const cleanup = action === "cancel" ? this.kde?.cancelSetup() : this.kde?.clear();
    void cleanup?.catch(() => this.changed({ ...this.state(), result: "FAILED" }));
  }
  async close(): Promise<void> { this.epoch++; this.preparing = false; await this.x11?.close(); await this.kde?.close(); await this.portal.close(); }
}

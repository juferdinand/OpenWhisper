import { KdeKeyboard, keyLabel, type KdeJournal, type KdeKeyboardState } from "../kde/keyboard.js";
import { PortalShortcuts, portalShortcutStateSchema, type PortalShortcutState, type ShortcutBus } from "./portal-shortcuts.js";
import type { ControlCapturePort } from "./control.js";

/** Only one desktop adapter may own a recording trigger. Portal probing stays independent. */
export class DesktopShortcuts {
  private portal!: PortalShortcuts;
  private kde: KdeKeyboard | undefined;
  private portalState = portalShortcutStateSchema.parse({ available: false, configuring: false, label: null, result: "NONE" });
  private kdeState: KdeKeyboardState = { available: false, configuring: false, key: null, result: "NONE" };
  private native = false;
  private epoch = 0;
  private preparing = false;
  private constructor(private readonly changed: (state: PortalShortcutState) => void) {}
  static async create(bus: ShortcutBus, capture: ControlCapturePort, changed: (state: PortalShortcutState) => void,
    journal?: KdeJournal): Promise<DesktopShortcuts> {
    const desktop = new DesktopShortcuts(changed);
    desktop.portal = await PortalShortcuts.create(bus, capture, (state) => { desktop.portalState = state; desktop.publish(); });
    if (journal) desktop.kde = await KdeKeyboard.create(bus, capture, journal, (state) => { desktop.kdeState = state; desktop.publish(); });
    return desktop;
  }
  state(): PortalShortcutState {
    const selected = this.native ? { configuring: this.kdeState.configuring,
      label: this.kdeState.key === null ? null : keyLabel(this.kdeState.key), result: this.kdeState.result } : this.portalState;
    return portalShortcutStateSchema.parse({ ...selected, configuring: this.preparing || selected.configuring, available: this.portalState.available,
      nativeAvailable: this.kdeState.available, nativeKey: this.native ? this.kdeState.key : null });
  }
  private publish(): void { this.changed(this.state()); }
  async bind(key: number, hold: boolean): Promise<void> {
    if (!this.kde || !this.kdeState.available) throw new Error("KDE keyboard shortcuts are unavailable.");
    const epoch = ++this.epoch; this.native = true; this.preparing = true; this.publish();
    try {
      await this.portal.clear();
      if (epoch === this.epoch) await this.kde.bind(key, hold);
    } finally { if (epoch === this.epoch) { this.preparing = false; this.publish(); } }
  }
  command(action: "enable" | "configure" | "clear" | "cancel" | "mode", hold: boolean): void {
    if (action === "mode") { this.kde?.mode(hold); this.portal.command(action, hold); return; }
    if (!this.native) { this.portal.command(action, hold); return; }
    if (action === "configure" || action === "enable") {
      this.changed({ ...this.state(), result: "CONFIGURE_UNAVAILABLE" }); return;
    }
    this.epoch++; this.preparing = false;
    const cleanup = action === "cancel" ? this.kde?.cancelSetup() : this.kde?.clear();
    void cleanup?.catch(() => this.changed({ ...this.state(), result: "FAILED" }));
  }
  async close(): Promise<void> { this.epoch++; this.preparing = false; await this.kde?.close(); await this.portal.close(); }
}

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { nativeMouseButtonSchema } from "../../../contracts/ui/state.js";
import { PrivateStateStore } from "../../../services/settings/private-state.js";
import { BusFailure } from "../shared/bus.js";
import type { ShortcutBus } from "../shared/portal-shortcuts.js";
import type { KdeKeyboard } from "./keyboard.js";
import { WaylandKeymapObserver } from "./wayland-keymap.js";
import type { SafeSurrogates } from "./keymap.js";

const configFile = "kcminputrc", configGroup = "ButtonRebinds";
const absent = "__OPENWHISPER_ABSENT_812c1e4f__";
const leaseSchema = z.strictObject({ version: z.literal(1), pid: z.int().min(1), started: z.string().regex(/^[0-9]+$/),
  button: nativeMouseButtonSchema, original: z.literal("").nullable(), assigned: z.enum(["Key,F19", "Key,F24"]) });
type Lease = z.infer<typeof leaseSchema>;
export function kdeMouseLeaseSurrogateIsSafe(assigned: Lease["assigned"], safe: SafeSurrogates): boolean {
  return assigned === "Key,F19" ? safe.f19 : safe.f24;
}
const mouseLeaseStoreSchema = z.nullable(leaseSchema);
export interface KdeMouseState { available: boolean; middleAvailable: boolean; button: number | null; configuring: boolean;
  result: "NONE" | "ENABLED" | "ENDED" | "FAILED" | "CONFLICT" }

export function kdeMouseConfigKey(buttonInput: number): string {
  const button = nativeMouseButtonSchema.parse(buttonInput);
  return button === 2 ? "MiddleButton" : `ExtraButton${button - 7}`;
}
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")"); if (close < 0) return undefined;
    return stat.slice(close + 1).trim().split(/\s+/u)[19];
  } catch { return undefined; }
}
function executable(path: string): boolean {
  try { const stats = lstatSync(path); return stats.isFile() && !stats.isSymbolicLink() && stats.uid === 0 && (stats.mode & 0o111) !== 0; }
  catch { return false; }
}
function command(path: string, args: string[]): string {
  if (!executable(path)) throw new Error("KDE mouse rebinding utilities are unavailable.");
  const environment = { ...process.env };
  for (const name of ["LD_LIBRARY_PATH", "LD_PRELOAD", "QT_PLUGIN_PATH", "QT_QPA_PLATFORM_PLUGIN_PATH", "QML2_IMPORT_PATH"]) delete environment[name];
  const result = spawnSync(path, args, { encoding: "utf8", timeout: 1500, maxBuffer: 4096,
    env: environment });
  if (result.error || result.status !== 0 || result.signal || result.stdout.length > 4096) throw new Error("KDE mouse mapping could not be updated safely.");
  return result.stdout;
}
function readMapping(button: number): string | null {
  const output = command("/usr/bin/kreadconfig6", ["--file", configFile, "--group", configGroup, "--group", "Mouse",
    "--key", kdeMouseConfigKey(button), "--default", absent]).replace(/[\r\n]+$/u, "");
  return output === absent ? null : output;
}
function writeMapping(button: number, value: string | null): void {
  const args = ["--file", configFile, "--group", configGroup, "--group", "Mouse", "--key", kdeMouseConfigKey(button), "--notify"];
  if (value === null) args.push("--delete"); else args.push(value);
  command("/usr/bin/kwriteconfig6", args);
}
function version(text: string): { major: number; minor: number } {
  if (text.length > 65_536) throw new Error("KWin version is unavailable.");
  const match = /^KWin version: (\d+)\.(\d+)(?:\.[^\r\n]*)?$/mu.exec(text);
  if (!match) throw new Error("KWin version is unavailable.");
  const major = Number(match[1]), minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major > 99 || minor > 99) throw new Error("KWin version is unavailable.");
  return { major, minor };
}
async function capability(bus: ShortcutBus): Promise<{ available: boolean; middleAvailable: boolean }> {
  try {
    if (process.env["XDG_SESSION_TYPE"]?.toLowerCase() !== "wayland" || !process.env["WAYLAND_DISPLAY"]) return { available: false, middleAvailable: false };
    const owner = await bus.owner("org.kde.KWin");
    const reply = await bus.call({ destination: owner, path: "/KWin", interface: "org.kde.KWin", member: "supportInformation",
      inputSignature: "", outputSignature: "s", body: [], timeoutMs: 1500 });
    const information = reply.body[0]; if (information?.type !== "s") return { available: false, middleAvailable: false };
    const kwin = version(information.value);
    if (kwin.major < 6 || !executable("/usr/bin/kreadconfig6") || !executable("/usr/bin/kwriteconfig6")) return { available: false, middleAvailable: false };
    const plugins = await bus.call({ destination: owner, path: "/Plugins", interface: "org.freedesktop.DBus.Properties", member: "Get",
      inputSignature: "ss", outputSignature: "v", body: [{ type: "s", value: "org.kde.KWin.Plugins" }, { type: "s", value: "LoadedPlugins" }], timeoutMs: 1500 });
    const value = plugins.body[0];
    if (value?.type !== "v" || value.signature !== "as" || value.value.type !== "a" || value.value.element !== "s") return { available: false, middleAvailable: false };
    const loaded = value.value.value.filter((item) => item.type === "s").map((item) => item.type === "s" ? item.value : "");
    const enabled = loaded.includes("buttonsrebind");
    return { available: enabled, middleAvailable: enabled && (kwin.major > 6 || kwin.minor >= 3) };
  } catch { return { available: false, middleAvailable: false }; }
}

/** Session-only KWin mouse-button lease, paired with one verified KGlobalAccel surrogate. */
export class KdeMouse {
  private snapshot: KdeMouseState = { available: false, middleAvailable: false, button: null, configuring: false, result: "NONE" };
  private observer: WaylandKeymapObserver | undefined;
  private readonly leaseStore: PrivateStateStore<Lease | null>;
  private operation: Promise<void> = Promise.resolve();
  private cleanupFailed = false;
  private closed = false;
  private readonly timer: NodeJS.Timeout;
  private closeTask: Promise<void> | undefined;
  private constructor(private readonly keyboard: KdeKeyboard, private readonly changed: (state: KdeMouseState) => void,
    private readonly support: { available: boolean; middleAvailable: boolean },
    leaseStore: PrivateStateStore<Lease | null>) { this.leaseStore = leaseStore;
    this.timer = setInterval(() => this.pump(), 50); this.timer.unref(); }
  static async create(bus: ShortcutBus, keyboard: KdeKeyboard, leasePath: string,
    changed: (state: KdeMouseState) => void): Promise<KdeMouse> {
    const store = await PrivateStateStore.open(leasePath, mouseLeaseStoreSchema, null, 4096, { invalidContent: "reject" });
    const support = await capability(bus);
    const instance = new KdeMouse(keyboard, changed, support, store);
    try {
      await instance.recover();
      if (support.available) {
        try {
          instance.observer = WaylandKeymapObserver.open();
          instance.publish({ available: instance.observer.safe.f19 || instance.observer.safe.f24,
            middleAvailable: support.middleAvailable && (instance.observer.safe.f19 || instance.observer.safe.f24) });
        } catch { instance.observer?.close(); instance.observer = undefined; }
      }
      return instance;
    } catch (error: unknown) { await instance.close(); throw error; }
  }
  state(): KdeMouseState { return { ...this.snapshot }; }
  private publish(changes: Partial<KdeMouseState>): void { this.snapshot = { ...this.snapshot, ...changes }; this.changed(this.state()); }
  private pump(): void {
    const observer = this.observer;
    if (this.closed || !observer) return;
    if (!observer.pump()) {
      // Retire the failed monitor before queueing asynchronous cleanup. The
      // interval must not enqueue a second clear on every subsequent tick.
      this.observer = undefined;
      let result: KdeMouseState["result"] = "ENDED";
      try { observer.close(); } catch { result = "FAILED"; }
      this.publish({ available: false, middleAvailable: false, result });
      if (this.snapshot.button !== null) void this.clear(result).catch(() => this.publish({ result: "FAILED" }));
    }
  }
  private async recover(): Promise<void> {
    const lease = this.leaseStore.snapshot(); if (!lease) return;
    if (processStartTime(lease.pid) === lease.started) throw new Error("Another KDE mouse trigger owner is still running.");
    const current = readMapping(lease.button);
    if (current === lease.assigned) writeMapping(lease.button, lease.original);
    await this.leaseStore.update(() => null);
  }
  prepareCapture(buttonInput: number): Promise<void> {
    const button = nativeMouseButtonSchema.parse(buttonInput);
    return this.run(async () => {
      if (this.closed || this.cleanupFailed || !this.support.available || button === 2 && !this.support.middleAvailable) throw new Error("KDE mouse triggers are unavailable.");
      if (!this.observer || !this.observer.pump(0) || this.observer.hasChanged()) {
        this.observer?.close(); this.observer = WaylandKeymapObserver.open();
      }
      if (!this.observer.safe.f19 && !this.observer.safe.f24) throw new Error("No safe keyboard surrogate is available.");
    });
  }
  bind(buttonInput: number, hold: boolean): Promise<void> {
    const button = nativeMouseButtonSchema.parse(buttonInput);
    return this.run(async () => {
      if (!this.support.available || button === 2 && !this.support.middleAvailable || this.closed || this.cleanupFailed) throw new Error("KDE mouse triggers are unavailable.");
      const existingLease = this.leaseStore.snapshot();
      if (!this.observer || !this.observer.pump(0) || this.observer.hasChanged()) { this.observer?.close(); this.observer = WaylandKeymapObserver.open(); }
      const observer = this.observer; const safe = observer.safe;
      if (!observer.pump(0) || observer.hasChanged()) throw new Error("The desktop keyboard layout changed during setup.");
      if (existingLease) {
        if (existingLease.button !== button) throw new Error("Clear the current KDE mouse trigger before choosing another button.");
        if (readMapping(button) !== existingLease.assigned) throw new Error("The KDE mouse mapping changed after setup.");
        if (!kdeMouseLeaseSurrogateIsSafe(existingLease.assigned, safe)) {
          try { await this.release("ENDED"); }
          catch { this.cleanupFailed = true; this.publish({ result: "FAILED" }); throw new Error("The invalidated KDE mouse trigger could not be released safely."); }
          throw new Error("The KDE keyboard layout changed; the mouse trigger was released.");
        }
        const key = existingLease.assigned === "Key,F19" ? 0x01000042 : 0x01000047;
        await this.keyboard.bind(key, hold);
        if (this.keyboard.state().key !== key || this.keyboard.state().result !== "ENABLED" || !observer.pump(0) || observer.hasChanged()) {
          throw new Error("The KDE mouse trigger could not be restored safely.");
        }
        this.publish({ button, result: "ENABLED" }); return;
      }
      const before = readMapping(button);
      if (before !== null && before !== "") { this.publish({ result: "CONFLICT" }); throw new Error("KDE already owns a mapping for this mouse button."); }
      let candidate: { key: number; assigned: "Key,F19" | "Key,F24" } | undefined;
      for (const item of [{ key: 0x01000042, assigned: "Key,F19" as const, safe: safe.f19 },
        { key: 0x01000047, assigned: "Key,F24" as const, safe: safe.f24 }]) {
        if (item.safe && await this.keyboard.canBind(item.key)) { candidate = item; break; }
      }
      if (!candidate) { this.publish({ result: "CONFLICT" }); throw new Error("No free safe KDE keyboard surrogate is available."); }
      const originalKey = this.keyboard.state().key;
      const originalHold = this.keyboard.holdMode();
      const started = processStartTime(process.pid);
      if (!started) throw new Error("Could not identify the KDE mouse trigger owner.");
      const lease = leaseSchema.parse({ version: 1, pid: process.pid, started, button, original: before, assigned: candidate.assigned });
      await this.leaseStore.update(() => lease);
      try {
        if (!observer.pump(0) || observer.hasChanged()) throw new Error("The desktop keyboard layout changed during setup.");
        if (readMapping(button) !== before) throw new Error("The KDE mouse mapping changed during setup.");
        await this.keyboard.bind(candidate.key, hold);
        if (this.keyboard.state().key !== candidate.key || this.keyboard.state().result !== "ENABLED") {
          throw new Error("The KDE keyboard surrogate could not be bound.");
        }
        if (!observer.pump(0) || observer.hasChanged()) throw new Error("The desktop keyboard layout changed during setup.");
        if (readMapping(button) !== before) throw new Error("The KDE mouse mapping changed during setup.");
        writeMapping(button, candidate.assigned);
        if (!observer.pump(0) || observer.hasChanged()) throw new Error("The desktop keyboard layout changed during setup.");
        if (observer.hasChanged()) throw new Error("The desktop keyboard layout changed during setup.");
        this.publish({ button, result: "ENABLED", available: true, middleAvailable: this.support.middleAvailable && (safe.f19 || safe.f24) });
      } catch (error: unknown) {
        try {
          if (readMapping(button) === candidate.assigned) writeMapping(button, before);
          await this.leaseStore.update(() => null);
          if (originalKey !== null) await this.keyboard.bind(originalKey, originalHold);
          else await this.keyboard.clear();
        } catch { this.cleanupFailed = true; this.publish({ result: "FAILED" }); throw new Error("KDE mouse trigger cleanup failed; the lease was retained."); }
        throw error;
      }
    });
  }
  clear(result: KdeMouseState["result"] = "NONE"): Promise<void> {
    return this.run(async () => {
      try { await this.release(result); }
      catch { this.cleanupFailed = true; this.publish({ result: "FAILED" }); throw new Error("KDE mouse trigger cleanup failed; the lease was retained."); }
    });
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(async () => {
      if (this.closed) throw new BusFailure("CLOSED");
      this.publish({ configuring: true });
      try { return await action(); } finally { this.publish({ configuring: false }); }
    });
    this.operation = next.then(() => {}, () => {}); return next;
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true; clearInterval(this.timer);
    this.closeTask = this.operation.then(async () => {
      try { await this.release("ENDED"); } finally { this.observer?.close(); this.observer = undefined; }
    });
    void this.closeTask.catch(() => {}); return this.closeTask;
  }
  private async release(result: KdeMouseState["result"]): Promise<void> {
    const lease = this.leaseStore.snapshot();
    if (lease) {
      // Stop advertising an enabled trigger before the first asynchronous cleanup
      // callback can reach main and persist the old button again.
      this.publish({ result });
      let failure: unknown;
      try { await this.keyboard.clear(); } catch (error: unknown) { failure = error; }
      try {
        if (readMapping(lease.button) === lease.assigned) writeMapping(lease.button, lease.original);
      } catch (error: unknown) { failure ??= error; }
      // Keep the ownership receipt until both independently owned resources have
      // been released. A later owner can then finish recovery without guessing.
      if (failure !== undefined) throw failure;
      await this.leaseStore.update(() => null);
    }
    this.publish({ button: null, result });
  }
}

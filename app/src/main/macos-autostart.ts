import type { App } from "electron";
import { createRequire } from "node:module";
import { endianness } from "node:os";
import type { LibraryHandle } from "koffi";
import { macosLoginFact, type MacosLoginFact } from "./macos-stable-admission.js";

export class MacosAutostartError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "UNKNOWN_STATE" | "CHANGE_FAILED" | "SETTINGS_FAILED") {
    super(code); this.name = "MacosAutostartError";
  }
}
type LoginItemApp = Pick<App, "getLoginItemSettings" | "setLoginItemSettings">;
function supported(): void {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || endianness() !== "LE") throw new MacosAutostartError("UNAVAILABLE");
}
function pointer(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n) throw new MacosAutostartError("SETTINGS_FAILED"); return value;
}

/** Stable main-process adapter; constructing or reading it never changes registration. */
export class MacosAutostart {
  private constructor(private readonly app: LoginItemApp) {}
  static open(input: { readonly appId: string; readonly app: LoginItemApp }): MacosAutostart {
    supported(); if (input.appId !== "io.github.whisperfree") throw new MacosAutostartError("UNAVAILABLE");
    return new MacosAutostart(input.app);
  }
  status(): MacosLoginFact {
    supported();
    try { return macosLoginFact(this.app.getLoginItemSettings({ type: "mainAppService" }).status); }
    catch { throw new MacosAutostartError("UNKNOWN_STATE"); }
  }
  set(requested: boolean): MacosLoginFact {
    if (typeof requested !== "boolean") throw new MacosAutostartError("UNAVAILABLE");
    const before = this.status(); if (before.requested === requested) return before;
    try { this.app.setLoginItemSettings({ type: "mainAppService", openAtLogin: requested }); }
    catch { throw new MacosAutostartError("CHANGE_FAILED"); }
    // Electron's setter returns void: a nonthrowing call is not evidence of registration.
    const after = this.status(); if (after.requested !== requested) throw new MacosAutostartError("CHANGE_FAILED"); return after;
  }
  /** Fixed public approval action; no arbitrary URL, service name or renderer path. */
  openSettings(): void {
    supported();
    const libraries: LibraryHandle[] = []; let pool: bigint | undefined, drain: bigint | undefined;
    let messageVoid: ((receiver: bigint, selector: bigint) => void) | undefined;
    try {
      const ffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
      if (ffi.sizeof("void *") !== 8) throw new MacosAutostartError("SETTINGS_FAILED");
      libraries.push(ffi.load("/System/Library/Frameworks/Foundation.framework/Foundation"));
      libraries.push(ffi.load("/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement"));
      const objc = ffi.load("/usr/lib/libobjc.A.dylib"); libraries.push(objc);
      const getClass = objc.func("void *objc_getClass(const char *name)");
      const selector = objc.func("void *sel_registerName(const char *name)");
      const messagePointer = objc.func("void *objc_msgSend(void *receiver, void *selector)");
      const invoke = objc.func("void objc_msgSend(void *receiver, void *selector)");
      messageVoid = (receiver, method) => { invoke(receiver, method); };
      const poolClass: unknown = getClass("NSAutoreleasePool"), newMethod: unknown = selector("new"), drainMethod: unknown = selector("drain");
      drain = pointer(drainMethod); const allocated: unknown = messagePointer(pointer(poolClass), pointer(newMethod)); pool = pointer(allocated);
      const service: unknown = getClass("SMAppService"), settings: unknown = selector("openSystemSettingsLoginItems");
      messageVoid(pointer(service), pointer(settings));
    } catch { throw new MacosAutostartError("SETTINGS_FAILED"); }
    finally {
      let failed = false;
      try { if (pool !== undefined && drain !== undefined) messageVoid?.(pool, drain); } catch { failed = true; }
      for (const library of libraries.reverse()) { try { library.unload(); } catch { failed = true; } }
      if (failed) throw new MacosAutostartError("SETTINGS_FAILED");
    }
  }
}

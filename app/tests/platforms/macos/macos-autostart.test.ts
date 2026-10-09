import assert from "node:assert/strict";
import type { App } from "electron";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import type { LibraryHandle } from "koffi";
import { MacosAutostart, MacosAutostartError } from "../../../src/main/macos-autostart.js";

function darwin(operation: () => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try { Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); operation(); }
  finally { Object.defineProperty(process, "platform", platform); }
}
function category(code: MacosAutostartError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof MacosAutostartError && error.code === code && error.message === code;
}
function loginApp(initial: string, update?: (requested: boolean) => string): { app: Pick<App, "getLoginItemSettings" | "setLoginItemSettings">; calls: boolean[] } {
  let status = initial; const calls: boolean[] = [];
  return { calls, app: {
    getLoginItemSettings(options) { assert.deepEqual(options, { type: "mainAppService" });
      const result: ReturnType<App["getLoginItemSettings"]> = { openAtLogin: status === "enabled", wasOpenedAtLogin: false, status: "not-registered",
        executableWillLaunchAtLogin: false, launchItems: [] };
      // Model an unknown runtime OS response without claiming it belongs to Electron's declared union.
      Reflect.set(result, "status", status); return result; },
    setLoginItemSettings(settings) { assert.deepEqual(Object.keys(settings).sort(), ["openAtLogin", "type"]); assert.equal(settings.type, "mainAppService");
      assert.equal(typeof settings.openAtLogin, "boolean"); const requested = settings.openAtLogin!; calls.push(requested);
      if (update) status = update(requested); },
  } };
}

test("Portable hosts and Dev identity refuse before any login API call", () => {
  const input = loginApp("enabled");
  if (process.platform !== "darwin") assert.throws(() => MacosAutostart.open({ appId: "io.github.whisperfree", app: input.app }), category("UNAVAILABLE"));
  darwin(() => { assert.throws(() => MacosAutostart.open({ appId: "io.github.whisperfree.dev", app: input.app }), category("UNAVAILABLE")); });
  assert.deepEqual(input.calls, []);
});

test("Construction and status keep enabled, disabled and pending facts without registering", () => darwin(() => {
  for (const [status, requested, pending] of [["enabled", true, false], ["not-registered", false, false], ["requires-approval", true, true]] as const) {
    const input = loginApp(status), service = MacosAutostart.open({ appId: "io.github.whisperfree", app: input.app });
    assert.deepEqual(service.status(), { status, requested, pending }); assert.deepEqual(input.calls, []);
    assert.deepEqual(service.set(requested), { status, requested, pending }); assert.deepEqual(input.calls, []);
  }
}));

test("Explicit enable verifies registered or pending status; pending remains removable", () => darwin(() => {
  for (const admitted of ["enabled", "requires-approval"]) {
    const input = loginApp("not-registered", (requested) => requested ? admitted : "not-registered");
    const service = MacosAutostart.open({ appId: "io.github.whisperfree", app: input.app });
    assert.equal(service.set(true).requested, true); assert.equal(service.status().pending, admitted === "requires-approval");
    assert.deepEqual(service.set(false), { status: "not-registered", requested: false, pending: false });
    assert.deepEqual(input.calls, [true, false]);
  }
}));

test("Unknown and not-found states refuse without silently disabling or registering", () => darwin(() => {
  for (const status of ["not-found", "", "future-status", "PRIVATE_VALUE"]) {
    const input = loginApp(status), service = MacosAutostart.open({ appId: "io.github.whisperfree", app: input.app });
    assert.throws(() => service.status(), category("UNKNOWN_STATE")); assert.throws(() => service.set(true), category("UNKNOWN_STATE"));
    assert.deepEqual(input.calls, []);
  }
  const input = loginApp("enabled"); input.app.getLoginItemSettings = () => { throw new Error("PRIVATE_OS_DETAIL"); };
  assert.throws(() => MacosAutostart.open({ appId: "io.github.whisperfree", app: input.app }).status(), category("UNKNOWN_STATE"));
}));

test("A silent setter no-op or an uncertain post-change state never reports success", () => darwin(() => {
  for (const initial of ["not-registered", "enabled", "requires-approval"]) {
    const input = loginApp(initial), service = MacosAutostart.open({ appId: "io.github.whisperfree", app: input.app });
    assert.throws(() => service.set(initial === "not-registered"), category("CHANGE_FAILED"));
    assert.deepEqual(input.calls, [initial === "not-registered"]);
  }
  const input = loginApp("not-registered", () => "not-found");
  assert.throws(() => MacosAutostart.open({ appId: "io.github.whisperfree", app: input.app }).set(true), category("UNKNOWN_STATE"));
}));

test("Thrown setters and malformed requests are categorical and never expose OS details", () => darwin(() => {
  const input = loginApp("not-registered"); input.app.setLoginItemSettings = () => { throw new Error("PRIVATE_OS_DETAIL"); };
  const service = MacosAutostart.open({ appId: "io.github.whisperfree", app: input.app });
  assert.throws(() => service.set(true), category("CHANGE_FAILED"));
  assert.throws(() => Reflect.apply(service.set, service, ["true"]), category("UNAVAILABLE"));
}));

const ffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
const info = ffi.proto("void *AutostartSettingsFixture(void)").proto; assert.ok(info);
function settingsFixture(input: { missingService?: boolean; failSettings?: boolean; failDrain?: boolean }, operation: (events: string[]) => void): void {
  const events: string[] = [], selectors = new Map<string, bigint>();
  function func(definition: string | number): ReturnType<LibraryHandle["func"]> {
    assert.equal(typeof definition, "string"); const name = /\b([A-Za-z_][A-Za-z_0-9]*)\s*\(/u.exec(String(definition))?.[1];
    const call = (...arguments_: unknown[]): unknown => {
      if (name === "objc_getClass") { const value = arguments_[0]; assert.ok(value === "NSAutoreleasePool" || value === "SMAppService");
        return value === "NSAutoreleasePool" ? 10n : input.missingService ? null : 20n; }
      if (name === "sel_registerName") { const value = String(arguments_[0]); assert.ok(["new", "drain", "openSystemSettingsLoginItems"].includes(value));
        const ref = BigInt(selectors.size + 100); selectors.set(value, ref); return ref; }
      if (name === "objc_msgSend") {
        const selector = [...selectors].find(([, ref]) => ref === arguments_[1])?.[0]; assert.ok(selector);
        events.push(selector);
        if (selector === "new") { assert.equal(arguments_[0], 10n); return 30n; }
        if (selector === "drain") { assert.equal(arguments_[0], 30n); if (input.failDrain) throw new Error("PRIVATE_NATIVE_DETAIL"); return undefined; }
        assert.equal(arguments_[0], 20n); if (input.failSettings) throw new Error("PRIVATE_NATIVE_DETAIL"); return undefined;
      }
      assert.fail("Unexpected native function");
    };
    return Object.assign(call, { async: (): never => { throw new Error("Unexpected asynchronous call"); }, info: info! });
  }
  const load = mock.method(ffi, "load", (path: string): LibraryHandle => {
    assert.ok(["/System/Library/Frameworks/Foundation.framework/Foundation", "/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement", "/usr/lib/libobjc.A.dylib"].includes(path));
    events.push(`load:${path}`); return { func, cdecl: func, stdcall: func, fastcall: func, thiscall: func,
      symbol(): never { throw new Error("No native symbol lookup expected"); }, unload() { events.push(`unload:${path}`); } };
  });
  try { darwin(() => operation(events)); } finally { load.mock.restore(); }
}

test("The fixed approval action invokes only the public class method and closes its native owners", () => {
  settingsFixture({}, (events) => {
    MacosAutostart.open({ appId: "io.github.whisperfree", app: loginApp("requires-approval").app }).openSettings();
    assert.deepEqual(events.filter((event) => !event.includes(":")), ["new", "openSystemSettingsLoginItems", "drain"]);
    assert.equal(events.filter((event) => event.startsWith("unload:")).length, 3);
  });
  for (const input of [{ missingService: true }, { failSettings: true }, { failDrain: true }]) settingsFixture(input, (events) => {
    assert.throws(() => MacosAutostart.open({ appId: "io.github.whisperfree", app: loginApp("requires-approval").app }).openSettings(), category("SETTINGS_FAILED"));
    assert.ok(events.includes("drain")); assert.equal(events.filter((event) => event.startsWith("unload:")).length, 3);
  });
});

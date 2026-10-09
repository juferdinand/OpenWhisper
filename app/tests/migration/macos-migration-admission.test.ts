import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import type { LibraryHandle } from "koffi";
import { assertLegacyMacosHostStopped, MacosMigrationAdmissionError, readLegacyMacosPreferencesSnapshot } from "../../src/workers/macos-migration-admission.js";
import { StableMigrationError } from "../../src/contracts/migration/stable-migration.js";
import { MAX_LEGACY_PLIST_BYTES } from "../../src/workers/macos-legacy-plist.js";

const ffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
const fixturePrototype = ffi.proto("void *AdmissionFixture(void)").proto; assert.ok(fixturePrototype);
const fixtureInfo = fixturePrototype;
interface NativeFixture {
  readonly pids?: readonly unknown[];
  readonly counts?: readonly unknown[];
  readonly missingApplications?: boolean;
  readonly missingPool?: boolean;
  readonly snapshot?: unknown;
  readonly snapshotType?: unknown;
  readonly data?: unknown;
  readonly dataLengths?: readonly unknown[];
  readonly error?: unknown;
  readonly missingConstant?: boolean;
  readonly releaseFailure?: boolean;
}
// Only the existing FFI boundary is mocked. Production readers accept no injected effects or domain.
function nativeFixture(input: NativeFixture, operation: (events: string[]) => void): void {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const events: string[] = [], pids = input.pids ?? [], selectors = new Map<string, bigint>();
  let countCalls = 0, lengthCalls = 0;
  function callable(name: string): ReturnType<LibraryHandle["func"]> {
    const invoke = (...arguments_: unknown[]): unknown => {
      if (name === "objc_getClass") return arguments_[0] === "NSAutoreleasePool" ? 10n : 11n;
      if (name === "sel_registerName") {
        const value = arguments_[0]; assert.equal(typeof value, "string");
        const key = String(value); let ref = selectors.get(key);
        if (ref === undefined) { ref = BigInt(selectors.size + 100); selectors.set(key, ref); } return ref;
      }
      if (name === "objc_msgSend") {
        const [receiver, selector] = arguments_;
        const key = [...selectors].find(([, ref]) => ref === selector)?.[0];
        if (key === "new") { events.push("pool:new"); return input.missingPool ? null : 20n; }
        if (key === "drain") { assert.equal(receiver, 20n); events.push("pool:drain"); return undefined; }
        if (key === "runningApplicationsWithBundleIdentifier:") {
          assert.equal(arguments_[2], 30n); events.push("apps:fresh"); return input.missingApplications ? null : 40n;
        }
        if (key === "processIdentifier") { events.push("pid:read"); return pids[Number(receiver) - 50]; }
        assert.fail("Unexpected Objective-C selector");
      }
      if (name === "CFRelease") {
        events.push(`release:${String(arguments_[0])}`);
        if (input.releaseFailure) throw new Error("Native release failed"); return undefined;
      }
      if (name === "CFStringCreateWithCString") {
        assert.deepEqual(arguments_, [null, "io.github.whisperfree", 0x08000100]); return 30n;
      }
      if (name === "CFStringGetTypeID") return 1n;
      if (name === "CFArrayGetTypeID") return 2n;
      if (name === "CFDictionaryGetTypeID") return 3n;
      if (name === "CFDataGetTypeID") return 4n;
      if (name === "CFGetTypeID") {
        if (arguments_[0] === 40n) return 2n;
        if (arguments_[0] === 60n) return input.snapshotType ?? 3n;
        if (arguments_[0] === 70n) return 4n; return 1n;
      }
      if (name === "CFArrayGetCount") return input.counts?.[countCalls++] ?? pids.length;
      if (name === "CFArrayGetValueAtIndex") return BigInt(Number(arguments_[1]) + 50);
      if (name === "CFPreferencesCopyMultiple") {
        assert.deepEqual(arguments_, [null, 30n, 81n, 82n]); events.push("prefs:copy"); return input.snapshot ?? null;
      }
      if (name === "CFPropertyListCreateData") {
        assert.deepEqual(arguments_.slice(0, 4), [null, 60n, 200, 0]);
        const error = arguments_[4]; assert.ok(Array.isArray(error)); error[0] = input.error ?? null;
        return input.data ?? null;
      }
      if (name === "CFDataGetLength") return input.dataLengths?.[lengthCalls++] ?? 1;
      if (name === "CFDataGetBytes") { events.push("data:copy"); return undefined; }
      assert.fail(`Unexpected native function: ${name}`);
    };
    return Object.assign(invoke, { async: (..._arguments: unknown[]): never => { throw new Error("Unexpected asynchronous native call"); }, info: fixtureInfo });
  }
  function func(definition: string | number, ..._arguments: unknown[]): ReturnType<LibraryHandle["func"]> {
    assert.equal(typeof definition, "string");
    const name = /\b([A-Za-z_][A-Za-z_0-9]*)\s*\(/u.exec(String(definition))?.[1] ?? String(definition);
    return callable(name);
  }
  const load = mock.method(ffi, "load", (path: string): LibraryHandle => {
    events.push(`load:${path}`);
    return { func, cdecl: func, stdcall: func, fastcall: func, thiscall: func,
      symbol(name: string): unknown { assert.ok(["kCFPreferencesCurrentUser", "kCFPreferencesAnyHost"].includes(name));
        return input.missingConstant ? null : name === "kCFPreferencesCurrentUser" ? 91n : 92n; },
      unload() { events.push(`unload:${path}`); } };
  });
  const decode = mock.method(ffi, "decode", (address: unknown, type: unknown): unknown => {
    assert.equal(type, "void *"); assert.ok(address === 91n || address === 92n); return address === 91n ? 81n : 82n;
  });
  try { Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" }); operation(events); }
  finally { Object.defineProperty(process, "platform", originalPlatform); decode.mock.restore(); load.mock.restore(); }
}
function refuses(operation: () => unknown, code: MacosMigrationAdmissionError["code"] | StableMigrationError["code"]): void {
  assert.throws(operation, (error: unknown) => (error instanceof MacosMigrationAdmissionError || error instanceof StableMigrationError) && error.code === code && error.message === code);
}

test("Portable hosts refuse both readers before any native library query", { skip: process.platform === "darwin" }, () => {
  const loading = mock.method(ffi, "load", (): never => { throw new Error("Native loading must not occur"); });
  try {
    refuses(assertLegacyMacosHostStopped, "UNAVAILABLE"); refuses(readLegacyMacosPreferencesSnapshot, "UNAVAILABLE");
    assert.equal(loading.mock.callCount(), 0);
  } finally { loading.mock.restore(); }
});

test("Fresh empty application inventory and only current main PID are admitted", () => {
  for (const pids of [[], [process.pid]]) nativeFixture({ pids }, (events) => {
    assertLegacyMacosHostStopped(); assert.equal(events.filter((event) => event === "apps:fresh").length, 1);
    assert.equal(events.filter((event) => event === "pool:drain").length, 1); assert.ok(events.includes("release:30"));
    assert.equal(events.filter((event) => event.startsWith("unload:")).length, 3);
  });
});

test("Another matching application refuses even alongside the current process and closes every owner", () => {
  nativeFixture({ pids: [process.pid, process.pid + 1] }, (events) => {
    refuses(assertLegacyMacosHostStopped, "LEGACY_APP_RUNNING");
    assert.ok(events.includes("pool:drain") && events.includes("release:30"));
    assert.equal(events.filter((event) => event.startsWith("unload:")).length, 3);
  });
});

test("Application arrays above 64 are refused before any application property is read", () => {
  nativeFixture({ pids: Array.from({ length: 65 }, () => process.pid) }, (events) => {
    refuses(assertLegacyMacosHostStopped, "UNSAFE_SOURCE"); assert.equal(events.includes("pid:read"), false); assert.ok(events.includes("pool:drain"));
  });
});

test("Malformed PID, changing array and NULL application response are categorical refusals", () => {
  for (const input of [{ pids: [0] }, { pids: [-1] }, { pids: ["PRIVATE_VALUE"] },
    { counts: [0, 1] }, { missingApplications: true }]) nativeFixture(input, (events) => {
    refuses(assertLegacyMacosHostStopped, "UNSAFE_SOURCE"); assert.ok(events.includes("pool:drain"));
  });
});

test("Failed autorelease pool construction never queries the application inventory", () => {
  nativeFixture({ missingPool: true }, (events) => {
    refuses(assertLegacyMacosHostStopped, "UNSAFE_SOURCE"); assert.equal(events.includes("apps:fresh"), false);
    assert.equal(events.filter((event) => event.startsWith("unload:")).length, 3);
  });
});

test("NULL preference result refuses instead of inventing an empty legacy domain", () => {
  nativeFixture({}, (events) => {
    refuses(readLegacyMacosPreferencesSnapshot, "PREFERENCES_SNAPSHOT_UNAVAILABLE");
    assert.ok(events.includes("prefs:copy") && events.includes("release:30"));
    assert.equal(events.filter((event) => event.startsWith("unload:")).length, 1);
  });
});

test("Preference dictionary type is checked before serialization and copied references are released", () => {
  nativeFixture({ snapshot: 60n, snapshotType: 2n }, (events) => {
    refuses(readLegacyMacosPreferencesSnapshot, "PREFERENCES_SNAPSHOT_UNAVAILABLE");
    assert.deepEqual(events.filter((event) => event.startsWith("release:")), ["release:60", "release:30"]);
  });
});

test("Serialization failure releases its error, data and dictionary references", () => {
  nativeFixture({ snapshot: 60n, data: 70n, error: 80n }, (events) => {
    refuses(readLegacyMacosPreferencesSnapshot, "PREFERENCES_SNAPSHOT_UNAVAILABLE");
    assert.deepEqual(events.filter((event) => event.startsWith("release:")), ["release:80", "release:70", "release:60", "release:30"]);
  });
});

test("Zero, oversize and changed serialized lengths refuse before the archive decoder", () => {
  for (const dataLengths of [[0], [MAX_LEGACY_PLIST_BYTES + 1], [1, 2]]) nativeFixture({ snapshot: 60n, data: 70n, dataLengths }, (events) => {
    refuses(readLegacyMacosPreferencesSnapshot, "PREFERENCES_SNAPSHOT_UNAVAILABLE");
    assert.deepEqual(events.filter((event) => event.startsWith("release:")), ["release:70", "release:60", "release:30"]);
  });
});

test("Missing fixed CFPreferences symbols refuse before querying any preference domain", () => {
  nativeFixture({ missingConstant: true }, (events) => {
    refuses(readLegacyMacosPreferencesSnapshot, "PREFERENCES_SNAPSHOT_UNAVAILABLE"); assert.equal(events.includes("prefs:copy"), false);
    assert.deepEqual(events.filter((event) => event.startsWith("release:")), ["release:30"]);
  });
});

test("A release failure still drains the pool or releases remaining copies and unloads libraries", () => {
  nativeFixture({ releaseFailure: true }, (events) => {
    refuses(assertLegacyMacosHostStopped, "UNSAFE_SOURCE"); assert.ok(events.includes("pool:drain"));
    assert.equal(events.filter((event) => event.startsWith("unload:")).length, 3);
  });
  nativeFixture({ releaseFailure: true, snapshot: 60n }, (events) => {
    refuses(readLegacyMacosPreferencesSnapshot, "PREFERENCES_SNAPSHOT_UNAVAILABLE");
    assert.deepEqual(events.filter((event) => event.startsWith("release:")), ["release:60", "release:30"]);
    assert.equal(events.filter((event) => event.startsWith("unload:")).length, 1);
  });
});

import { createRequire } from "node:module";
import { endianness } from "node:os";
import type { LibraryHandle } from "koffi";
import { StableMigrationError } from "../contracts/stable-migration.js";
import { decodeLegacyMacosPlist, MAX_LEGACY_PLIST_BYTES, type DecodedLegacyMacosPlist } from "./macos-legacy-plist.js";

export class MacosMigrationAdmissionError extends Error {
  readonly code = "UNAVAILABLE";
  constructor() { super("UNAVAILABLE"); this.name = "MacosMigrationAdmissionError"; }
}
type NativeCall = (...arguments_: unknown[]) => unknown;
function bind(library: LibraryHandle, definition: string): NativeCall {
  const callable = library.func(definition); return (...arguments_) => { const value: unknown = callable(...arguments_); return value; };
}
function pointer(value: unknown): bigint | null {
  if (value === null || value === 0n) return null;
  if (typeof value !== "bigint" || value <= 0n) throw new MacosMigrationAdmissionError();
  return value;
}
function requiredPointer(value: unknown): bigint {
  const result = pointer(value); if (result === null) throw new MacosMigrationAdmissionError(); return result;
}
function integer(value: unknown, maximum: number): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new MacosMigrationAdmissionError();
  }
  return result;
}
function supportedPlatform(): void {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || endianness() !== "LE") {
    throw new MacosMigrationAdmissionError();
  }
}
function nativeLibrary() {
  const ffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  if (ffi.sizeof("void *") !== 8 || ffi.sizeof("long") !== 8) throw new MacosMigrationAdmissionError();
  return ffi;
}
const coreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

/** Fresh public application inventory; never terminates or activates another app. */
export function assertLegacyMacosHostStopped(): void {
  supportedPlatform();
  const libraries: LibraryHandle[] = [];
  let release: NativeCall | undefined, messageVoid: NativeCall | undefined, drain: bigint | undefined;
  let identifier: bigint | undefined, pool: bigint | undefined;
  try {
    const ffi = nativeLibrary();
    const appKit = ffi.load("/System/Library/Frameworks/AppKit.framework/AppKit"); libraries.push(appKit);
    const objc = ffi.load("/usr/lib/libobjc.A.dylib"); libraries.push(objc);
    const cf = ffi.load(coreFoundation); libraries.push(cf);
    const getClass = bind(objc, "void *objc_getClass(const char *name)");
    const selector = bind(objc, "void *sel_registerName(const char *name)");
    const select = (name: string): bigint => requiredPointer(selector(name));
    // Each fixed selector has its actual method ABI; no variadic/struct-return dispatch.
    const messagePointer = bind(objc, "void *objc_msgSend(void *receiver, void *selector)");
    const messageArgument = bind(objc, "void *objc_msgSend(void *receiver, void *selector, void *argument)");
    const messagePid = bind(objc, "int objc_msgSend(void *receiver, void *selector)");
    messageVoid = bind(objc, "void objc_msgSend(void *receiver, void *selector)");
    release = bind(cf, "void CFRelease(void *reference)");
    const type = bind(cf, "unsigned long CFGetTypeID(void *reference)");
    const stringType = integer(bind(cf, "unsigned long CFStringGetTypeID(void)")(), Number.MAX_SAFE_INTEGER);
    const arrayType = integer(bind(cf, "unsigned long CFArrayGetTypeID(void)")(), Number.MAX_SAFE_INTEGER);
    if (stringType === 0 || arrayType === 0 || stringType === arrayType) throw new MacosMigrationAdmissionError();
    drain = select("drain");
    // NSObject.new returns an owned initialized pool; drain releases it in the same call scope.
    pool = requiredPointer(messagePointer(requiredPointer(getClass("NSAutoreleasePool")), select("new")));
    identifier = requiredPointer(bind(cf, "void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)")(
      null, "io.github.whisperfree", 0x08000100));
    if (integer(type(identifier), Number.MAX_SAFE_INTEGER) !== stringType) throw new MacosMigrationAdmissionError();
    const applications = requiredPointer(messageArgument(requiredPointer(getClass("NSRunningApplication")),
      select("runningApplicationsWithBundleIdentifier:"), identifier));
    if (integer(type(applications), Number.MAX_SAFE_INTEGER) !== arrayType) throw new MacosMigrationAdmissionError();
    const count = bind(cf, "long CFArrayGetCount(void *array)"), at = bind(cf, "void *CFArrayGetValueAtIndex(void *array, long index)");
    const length = integer(count(applications), 64), processIdentifier = select("processIdentifier");
    for (let index = 0; index < length; index++) {
      const application = requiredPointer(at(applications, index));
      const pid = integer(messagePid(application, processIdentifier), 0x7fffffff);
      if (pid === 0) throw new MacosMigrationAdmissionError();
      if (pid !== process.pid) throw new StableMigrationError("LEGACY_APP_RUNNING");
    }
    if (integer(count(applications), 64) !== length) throw new MacosMigrationAdmissionError();
  } catch (error: unknown) {
    throw error instanceof StableMigrationError && error.code === "LEGACY_APP_RUNNING"
      ? error : new StableMigrationError("UNSAFE_SOURCE");
  } finally {
    let failed = false;
    try { if (identifier !== undefined) release?.(identifier); } catch { failed = true; }
    try { if (pool !== undefined && drain !== undefined) messageVoid?.(pool, drain); } catch { failed = true; }
    for (const library of libraries.reverse()) { try { library.unload(); } catch { failed = true; } }
    if (failed) throw new StableMigrationError("UNSAFE_SOURCE");
  }
}

/** Exact persisted domain snapshot; no defaults search, preference writes or synchronization. */
export function readLegacyMacosPreferencesSnapshot(): DecodedLegacyMacosPlist {
  supportedPlatform();
  let library: LibraryHandle | undefined, release: NativeCall | undefined;
  const references: bigint[] = [];
  try {
    const ffi = nativeLibrary();
    library = ffi.load(coreFoundation);
    release = bind(library, "void CFRelease(void *reference)");
    const own = (value: unknown): bigint | null => { const ref = pointer(value); if (ref !== null) references.push(ref); return ref; };
    const identifier = own(bind(library, "void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)")(
      null, "io.github.whisperfree", 0x08000100));
    if (identifier === null) throw new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
    const type = bind(library, "unsigned long CFGetTypeID(void *reference)");
    const stringType = integer(bind(library, "unsigned long CFStringGetTypeID(void)")(), Number.MAX_SAFE_INTEGER);
    const dictionaryType = integer(bind(library, "unsigned long CFDictionaryGetTypeID(void)")(), Number.MAX_SAFE_INTEGER);
    const dataType = integer(bind(library, "unsigned long CFDataGetTypeID(void)")(), Number.MAX_SAFE_INTEGER);
    if (new Set([stringType, dictionaryType, dataType]).size !== 3 || [stringType, dictionaryType, dataType].includes(0) ||
      integer(type(identifier), Number.MAX_SAFE_INTEGER) !== stringType) throw new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
    const constant = (name: "kCFPreferencesCurrentUser" | "kCFPreferencesAnyHost"): bigint => {
      const address: unknown = library!.symbol(name);
      const value: unknown = ffi.decode(requiredPointer(address), "void *");
      const ref = requiredPointer(value);
      if (integer(type(ref), Number.MAX_SAFE_INTEGER) !== stringType) throw new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
      return ref;
    };
    const snapshot = own(bind(library, "void *CFPreferencesCopyMultiple(void *keys, void *application, void *user, void *host)")(
      null, identifier, constant("kCFPreferencesCurrentUser"), constant("kCFPreferencesAnyHost")));
    // NULL is a failed native read, never evidence of an absent/empty domain.
    if (snapshot === null || integer(type(snapshot), Number.MAX_SAFE_INTEGER) !== dictionaryType) {
      throw new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
    }
    const error: unknown[] = [null];
    const data = own(bind(library, "void *CFPropertyListCreateData(void *allocator, void *plist, long format, unsigned long options, _Out_ void **error)")(
      null, snapshot, 200, 0, error));
    const failure = own(error[0]);
    if (data === null || failure !== null || integer(type(data), Number.MAX_SAFE_INTEGER) !== dataType) {
      throw new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
    }
    const length = bind(library, "long CFDataGetLength(void *data)"), size = integer(length(data), MAX_LEGACY_PLIST_BYTES);
    if (size === 0) throw new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
    const bytes = Buffer.alloc(size), range = ffi.struct({ location: "long", length: "long" });
    const copy = library.func("CFDataGetBytes", "void", ["void *", range, "void *"]);
    copy(data, { location: 0, length: size }, bytes);
    if (integer(length(data), MAX_LEGACY_PLIST_BYTES) !== size) throw new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
    return decodeLegacyMacosPlist(bytes);
  } catch (error: unknown) {
    throw error instanceof StableMigrationError && error.code === "PREFERENCES_SNAPSHOT_UNAVAILABLE"
      ? error : new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
  } finally {
    let failed = false;
    for (const reference of references.reverse()) { try { release?.(reference); } catch { failed = true; } }
    try { library?.unload(); } catch { failed = true; }
    if (failed) throw new StableMigrationError("PREFERENCES_SNAPSHOT_UNAVAILABLE");
  }
}

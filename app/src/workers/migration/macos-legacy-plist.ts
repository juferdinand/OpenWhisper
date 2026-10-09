import { createRequire } from "node:module";
import { endianness } from "node:os";
import type { LibraryHandle } from "koffi";
import { z } from "zod";

export const MAX_LEGACY_PLIST_BYTES = 8 * 1024 * 1024;
const maximumDepth = 64, maximumNodes = 100_000;
export type PlistJsonValue = z.infer<ReturnType<typeof z.json>>;
const bits = z.string().regex(/^[a-f0-9]{16}$/);
const numberBase = { $nativePlist: z.literal("number"), storageType: z.int().min(1).max(255) };
const nativeProjectionSchema = z.union([
  z.strictObject({ $nativePlist: z.literal("data"), base64: z.string().max(MAX_LEGACY_PLIST_BYTES)
    .refine((value) => Buffer.from(value, "base64").toString("base64") === value) }),
  // Big-endian IEEE-754 CFAbsoluteTime bits; its epoch is 2001-01-01 UTC.
  z.strictObject({ $nativePlist: z.literal("date"), absoluteTimeBits: bits }),
  z.discriminatedUnion("representation", [
    z.strictObject({ ...numberBase, representation: z.literal("signed-int64"), decimal: z.string()
      .regex(/^-?(?:0|[1-9][0-9]{0,18})$/).refine((value) => BigInt(value) >= -(1n << 63n) && BigInt(value) < (1n << 63n)) }),
    z.strictObject({ ...numberBase, representation: z.literal("float64"), bits }),
    z.strictObject({ ...numberBase, representation: z.literal("opaque"),
      reason: z.enum(["LOSSFUL_EXTRACTION", "UNSUPPORTED_STORAGE"]) }),
  ]),
]);
export const nativePlistValueSchema = z.strictObject({
  path: z.array(z.union([z.string().max(MAX_LEGACY_PLIST_BYTES), z.int().min(0).max(maximumNodes)])).min(1).max(maximumDepth).readonly(),
  value: nativeProjectionSchema.readonly(),
}).readonly();
type NativePlistValue = z.infer<typeof nativePlistValueSchema>;
type NativeProjection = z.infer<typeof nativeProjectionSchema>;
export interface DecodedLegacyMacosPlist {
  readonly plist: Record<string, PlistJsonValue>;
  readonly nativeValues: readonly NativePlistValue[];
}
export class LegacyMacosPlistError extends Error {
  constructor(readonly code: "INVALID_DATA" | "UNAVAILABLE" = "INVALID_DATA") { super(code); this.name = "LegacyMacosPlistError"; }
}
function invalid(): never { throw new LegacyMacosPlistError(); }

/** Validate JSON without z.record's intentional stripping of __proto__ keys. */
function boundedJson(input: unknown): boolean {
  let nodes = 0, bytes = 0;
  const ancestors = new Set<object>();
  const spend = (amount: number): void => { bytes += amount; if (bytes > MAX_LEGACY_PLIST_BYTES) invalid(); };
  function visit(value: unknown, depth: number): void {
    if (++nodes > maximumNodes || depth > maximumDepth + 4) invalid();
    if (value === null || typeof value === "boolean") { spend(value === null ? 4 : value ? 4 : 5); return; }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) invalid(); spend(JSON.stringify(value).length); return;
    }
    if (typeof value === "string") {
      if (value.length > MAX_LEGACY_PLIST_BYTES) invalid(); spend(Buffer.byteLength(JSON.stringify(value), "utf8")); return;
    }
    if (typeof value !== "object" || ancestors.has(value)) invalid();
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) invalid();
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (keys.length > maximumNodes) invalid();
      spend(2);
      let count = 0;
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string" || key.length > MAX_LEGACY_PLIST_BYTES) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
        if (array && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) !== count)) invalid();
        if (count++ > 0) spend(1);
        if (!array) spend(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        const child: unknown = descriptor.value; visit(child, depth + 1);
      }
      if (array && count !== value.length) invalid();
    } finally { ancestors.delete(value); }
  }
  try { visit(input, 0); return true; } catch { return false; }
}
const jsonDictionary = z.custom<Record<string, PlistJsonValue>>((value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && boundedJson(value));
export const decodedLegacyMacosPlistSchema = z.custom<unknown>(boundedJson).pipe(z.strictObject({
  plist: jsonDictionary, nativeValues: z.array(nativePlistValueSchema).max(maximumNodes).readonly(),
}).superRefine((result, context) => {
  const paths = new Set<string>();
  for (const entry of result.nativeValues) {
    const key = JSON.stringify(entry.path); let value: unknown = result.plist;
    if (paths.has(key)) { context.addIssue({ code: "custom", message: "Invalid native plist sidecar." }); continue; }
    paths.add(key);
    for (const segment of entry.path) {
      if (typeof value !== "object" || value === null || (typeof segment === "number") !== Array.isArray(value)) { value = undefined; break; }
      const descriptor = Object.getOwnPropertyDescriptor(value, segment);
      value = descriptor && "value" in descriptor ? descriptor.value as unknown : undefined;
    }
    if (JSON.stringify(value) !== JSON.stringify(entry.value)) context.addIssue({ code: "custom", message: "Invalid native plist sidecar." });
  }
}).readonly());

type NativeCall = (...args: unknown[]) => unknown;
function bind(library: LibraryHandle, definition: string): NativeCall {
  const callable = library.func(definition); return (...args) => { const result: unknown = callable(...args); return result; };
}
function pointer(value: unknown): bigint | null {
  if (value === null || value === 0n) return null;
  if (typeof value !== "bigint" || value <= 0n) invalid(); return value;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0 || result > maximum) invalid(); return result;
}
function boolean(value: unknown): boolean { const result = integer(value, 1); return result === 1; }
function doubleBits(value: unknown): string {
  if (typeof value !== "number") invalid(); const buffer = Buffer.alloc(8); buffer.writeDoubleBE(value); return buffer.toString("hex");
}

/** Archive bytes only: never reads CFPreferences, a file, device or login service. */
export function decodeLegacyMacosPlist(bytes: Uint8Array): DecodedLegacyMacosPlist {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_LEGACY_PLIST_BYTES || bytes.buffer instanceof SharedArrayBuffer) invalid();
  const frozen = Buffer.from(bytes);
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) || endianness() !== "LE") throw new LegacyMacosPlistError("UNAVAILABLE");
  let library: LibraryHandle | undefined, release: NativeCall | undefined;
  const references: bigint[] = [];
  try {
    const ffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
    if (ffi.sizeof("void *") !== 8 || ffi.sizeof("long") !== 8) invalid();
    library = ffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
    const range = ffi.struct({ location: "long", length: "long" });
    release = bind(library, "void CFRelease(void *reference)");
    const f = {
      dataCreate: bind(library, "void *CFDataCreate(void *allocator, const uint8_t *bytes, long length)"),
      parse: bind(library, "void *CFPropertyListCreateWithData(void *allocator, void *data, unsigned long options, _Out_ long *format, _Out_ void **error)"),
      type: bind(library, "unsigned long CFGetTypeID(void *reference)"),
      stringLength: bind(library, "long CFStringGetLength(void *reference)"),
      characters: ((callable) => (...args: unknown[]): unknown => { const result: unknown = callable(...args); return result; })(
        library.func("CFStringGetCharacters", "void", ["void *", range, "void *"])),
      dataLength: bind(library, "long CFDataGetLength(void *reference)"),
      dataBytes: ((callable) => (...args: unknown[]): unknown => { const result: unknown = callable(...args); return result; })(
        library.func("CFDataGetBytes", "void", ["void *", range, "void *"])),
      arrayCount: bind(library, "long CFArrayGetCount(void *reference)"),
      arrayValue: bind(library, "void *CFArrayGetValueAtIndex(void *reference, long index)"),
      dictionaryCount: bind(library, "long CFDictionaryGetCount(void *reference)"),
      dictionaryValues: bind(library, "void CFDictionaryGetKeysAndValues(void *reference, void *keys, void *values)"),
      boolean: bind(library, "uint8_t CFBooleanGetValue(void *reference)"),
      date: bind(library, "double CFDateGetAbsoluteTime(void *reference)"),
      numberType: bind(library, "long CFNumberGetType(void *reference)"),
      floating: bind(library, "uint8_t CFNumberIsFloatType(void *reference)"),
      numberValue: bind(library, "uint8_t CFNumberGetValue(void *reference, long type, void *buffer)"),
    };
    const ids = Object.fromEntries(["String", "Data", "Array", "Dictionary", "Boolean", "Date", "Number"].map((name) =>
      [name, integer(bind(library!, `unsigned long CF${name}GetTypeID(void)`)())]));
    if (new Set(Object.values(ids)).size !== 7 || Object.values(ids).some((id) => id === 0)) invalid();
    const own = (value: unknown): bigint | null => { const ref = pointer(value); if (ref !== null) references.push(ref); return ref; };
    const data = own(f.dataCreate(null, frozen, frozen.length));
    if (data === null || integer(f.dataLength(data), MAX_LEGACY_PLIST_BYTES) !== frozen.length) invalid();
    const format: unknown[] = [0], error: unknown[] = [null];
    const plist = own(f.parse(null, data, 0, format, error));
    const failure = own(error[0]);
    if (plist === null || failure !== null || ![100, 200].includes(integer(format[0])) || integer(f.type(plist)) !== ids["Dictionary"]) invalid();
    let nodes = 0, outputBytes = 32;
    const nativeValues: NativePlistValue[] = [];
    const active = new Set<bigint>();
    const spend = (amount: number): void => { outputBytes += amount; if (outputBytes > MAX_LEGACY_PLIST_BYTES) invalid(); };
    const native = (path: (string | number)[], value: NativeProjection): PlistJsonValue => {
      const entry = nativePlistValueSchema.parse({ path, value });
      spend(Buffer.byteLength(JSON.stringify(entry), "utf8") + 1); nativeValues.push(entry); return value;
    };
    const string = (ref: bigint): string => {
      const length = integer(f.stringLength(ref), MAX_LEGACY_PLIST_BYTES);
      if (length > MAX_LEGACY_PLIST_BYTES - outputBytes) invalid();
      const buffer = Buffer.alloc(length * 2);
      if (length > 0) f.characters(ref, { location: 0, length }, buffer);
      if (integer(f.stringLength(ref)) !== length) invalid(); return buffer.toString("utf16le");
    };
    function visit(ref: bigint, path: (string | number)[]): PlistJsonValue {
      if (++nodes > maximumNodes || path.length > maximumDepth || active.has(ref)) invalid();
      active.add(ref);
      try {
        const type = integer(f.type(ref)); let value: PlistJsonValue;
        if (type === ids["String"]) value = string(ref);
        else if (type === ids["Boolean"]) value = boolean(f.boolean(ref));
        else if (type === ids["Date"]) value = native(path, { $nativePlist: "date", absoluteTimeBits: doubleBits(f.date(ref)) });
        else if (type === ids["Data"]) {
          const length = integer(f.dataLength(ref), MAX_LEGACY_PLIST_BYTES);
          if (4 * Math.ceil(length / 3) > MAX_LEGACY_PLIST_BYTES - outputBytes) invalid();
          const buffer = Buffer.alloc(length); if (length > 0) f.dataBytes(ref, { location: 0, length }, buffer);
          if (integer(f.dataLength(ref)) !== length) invalid(); value = native(path, { $nativePlist: "data", base64: buffer.toString("base64") });
        } else if (type === ids["Number"]) {
          const storageType = integer(f.numberType(ref), 255); if (storageType < 1) invalid();
          const floating = boolean(f.floating(ref)), buffer = Buffer.alloc(8);
          if (storageType > 16) value = native(path, { $nativePlist: "number", storageType, representation: "opaque", reason: "UNSUPPORTED_STORAGE" });
          else if (!boolean(f.numberValue(ref, floating ? 6 : 4, buffer))) value = native(path,
            { $nativePlist: "number", storageType, representation: "opaque", reason: "LOSSFUL_EXTRACTION" });
          else if (floating) {
            const number = buffer.readDoubleLE(); value = Number.isFinite(number) && !Object.is(number, -0) ? number : native(path,
              { $nativePlist: "number", storageType, representation: "float64", bits: doubleBits(number) });
          } else {
            const number = buffer.readBigInt64LE(); value = Number.isSafeInteger(Number(number)) ? Number(number) : native(path,
              { $nativePlist: "number", storageType, representation: "signed-int64", decimal: number.toString() });
          }
        } else if (type === ids["Array"]) {
          const count = integer(f.arrayCount(ref), maximumNodes - nodes), array: PlistJsonValue[] = []; spend(count + 2);
          for (let index = 0; index < count; index++) { const child = pointer(f.arrayValue(ref, index)); if (child === null) invalid(); array.push(visit(child, [...path, index])); }
          if (integer(f.arrayCount(ref)) !== count) invalid(); return array;
        } else if (type === ids["Dictionary"]) {
          const count = integer(f.dictionaryCount(ref), Math.floor((maximumNodes - nodes) / 2)), keys = Buffer.alloc(count * 8), values = Buffer.alloc(count * 8);
          if (count > 0) f.dictionaryValues(ref, keys, values);
          const object: Record<string, PlistJsonValue> = {}; spend(count + 2);
          for (let index = 0; index < count; index++) {
            if (++nodes > maximumNodes) invalid();
            const key = pointer(keys.readBigUInt64LE(index * 8)), child = pointer(values.readBigUInt64LE(index * 8));
            if (key === null || child === null || integer(f.type(key)) !== ids["String"]) invalid();
            const name = string(key); if (Object.hasOwn(object, name)) invalid(); spend(Buffer.byteLength(JSON.stringify(name), "utf8") + 1);
            Object.defineProperty(object, name, { enumerable: true, configurable: true, writable: true, value: visit(child, [...path, name]) });
          }
          if (integer(f.dictionaryCount(ref)) !== count) invalid(); return object;
        } else invalid();
        spend(Buffer.byteLength(JSON.stringify(value), "utf8")); return value;
      } finally { active.delete(ref); }
    }
    return decodedLegacyMacosPlistSchema.parse({ plist: visit(plist, []), nativeValues });
  } catch (error: unknown) { throw error instanceof LegacyMacosPlistError ? error : new LegacyMacosPlistError(); }
  finally {
    let failed = false;
    for (const reference of references.reverse()) { try { release?.(reference); } catch { failed = true; } }
    try { library?.unload(); } catch { failed = true; }
    if (failed) throw new LegacyMacosPlistError("UNAVAILABLE");
  }
}

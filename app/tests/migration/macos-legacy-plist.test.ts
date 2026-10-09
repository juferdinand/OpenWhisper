import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { decodeLegacyMacosPlist, decodedLegacyMacosPlistSchema, nativePlistValueSchema,
  LegacyMacosPlistError, MAX_LEGACY_PLIST_BYTES, type DecodedLegacyMacosPlist, type PlistJsonValue } from "../../src/workers/migration/macos-legacy-plist.js";

const execute = promisify(execFile);
const xml = (body: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${body}</plist>`);
const doubleBits = (value: number): string => { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return bytes.toString("hex"); };
const errorCode = (code: "INVALID_DATA" | "UNAVAILABLE") => (error: unknown): boolean => error instanceof LegacyMacosPlistError && error.code === code && error.message === code;

test("archival plist rejects empty oversized and shared bytes before opening native libraries", () => {
  for (const bytes of [new Uint8Array(), new Uint8Array(MAX_LEGACY_PLIST_BYTES + 1), new Uint8Array(new SharedArrayBuffer(8))]) {
    assert.throws(() => decodeLegacyMacosPlist(bytes), errorCode("INVALID_DATA"));
  }
});
test("archival decoder remains importable and categorically unavailable on other platforms", { skip: process.platform === "darwin" }, () => {
  assert.throws(() => decodeLegacyMacosPlist(xml("<dict/>")), errorCode("UNAVAILABLE"));
});
test("decoded snapshot preserves prototype-name keys and distinguishes array indexes from key segments", () => {
  const value = { $nativePlist: "data", base64: "AP9B" };
  const plist = JSON.parse('{"__proto__":{"0":null},"constructor":"retained","a.b\\n🦉":[null],"lookalike":{"$nativePlist":"data","base64":""}}') as Record<string, PlistJsonValue>;
  const prototypeKey = plist["__proto__"]; assert.ok(prototypeKey && typeof prototypeKey === "object" && !Array.isArray(prototypeKey));
  prototypeKey["0"] = value; plist["a.b\n🦉"] = [value];
  const snapshot = decodedLegacyMacosPlistSchema.parse({ plist, nativeValues: [
    { path: ["__proto__", "0"], value }, { path: ["a.b\n🦉", 0], value },
  ] });
  assert.equal(Object.hasOwn(snapshot.plist, "__proto__"), true);
  assert.deepEqual(snapshot.plist, plist); assert.equal(Object.getPrototypeOf(snapshot.plist), Object.prototype);
  assert.equal(snapshot.nativeValues.length, 2); assert.equal(Object.hasOwn(snapshot.plist, "lookalike"), true);
  assert.equal(decodedLegacyMacosPlistSchema.safeParse({ plist, nativeValues: [{ path: ["__proto__", 0], value }] }).success, false);
});
test("native sidecar schemas retain exact double bits and integer decimals while rejecting malformed tags", () => {
  for (const value of [
    { $nativePlist: "date", absoluteTimeBits: doubleBits(-0) },
    { $nativePlist: "number", storageType: 4, representation: "signed-int64", decimal: "9223372036854775807" },
    { $nativePlist: "number", storageType: 4, representation: "signed-int64", decimal: "-9223372036854775808" },
    { $nativePlist: "number", storageType: 6, representation: "float64", bits: doubleBits(Infinity) },
    { $nativePlist: "number", storageType: 17, representation: "opaque", reason: "UNSUPPORTED_STORAGE" },
  ]) assert.deepEqual(nativePlistValueSchema.parse({ path: ["native"], value }).value, value);
  for (const value of [
    { $nativePlist: "data", base64: " AP9B" }, { $nativePlist: "data", base64: "A" },
    { $nativePlist: "date", absoluteTimeBits: "0" }, { $nativePlist: "date", absoluteTimeBits: doubleBits(0), unexpected: true },
    { $nativePlist: "number", storageType: 0, representation: "opaque", reason: "UNSUPPORTED_STORAGE" },
    { $nativePlist: "number", storageType: 4, representation: "signed-int64", decimal: "9223372036854775808" },
    { $nativePlist: "number", storageType: 4, representation: "signed-int64", decimal: "00" },
  ]) assert.equal(nativePlistValueSchema.safeParse({ path: ["native"], value }).success, false);
});
test("snapshot validation rejects sidecar replay mismatches accessors cycles and lossy JSON values", () => {
  const value = { $nativePlist: "data", base64: "AP9B" }, entry = { path: ["native"], value };
  const valid = { plist: { native: value }, nativeValues: [entry] };
  for (const input of [
    { ...valid, nativeValues: [entry, entry] }, { ...valid, nativeValues: [{ path: ["missing"], value }] },
    { ...valid, nativeValues: [{ path: ["native"], value: { $nativePlist: "data", base64: "" } }] },
    { ...valid, extra: true }, { plist: [value], nativeValues: [] },
    { plist: { number: NaN }, nativeValues: [] }, { plist: { number: -0 }, nativeValues: [] },
    { plist: { sparse: Array(2) }, nativeValues: [] }, { plist: { missing: undefined }, nativeValues: [] },
  ]) assert.equal(decodedLegacyMacosPlistSchema.safeParse(input).success, false);
  const cyclic: Record<string, unknown> = {}; cyclic["child"] = cyclic;
  assert.equal(decodedLegacyMacosPlistSchema.safeParse({ plist: cyclic, nativeValues: [] }).success, false);
  const accessor = Object.defineProperty({}, "private", { enumerable: true, get() { assert.fail("Accessor must not execute."); } });
  assert.equal(decodedLegacyMacosPlistSchema.safeParse({ plist: accessor, nativeValues: [] }).success, false);
});
test("snapshot validation bounds combined projection and native sidecar bytes and structure", () => {
  const value = { $nativePlist: "data", base64: Buffer.alloc(3 * 1024 * 1024 + 16).toString("base64") };
  assert.equal(decodedLegacyMacosPlistSchema.safeParse({ plist: { native: value }, nativeValues: [{ path: ["native"], value }] }).success, false);
  let nested: unknown = "retained"; for (let depth = 0; depth < 72; depth++) nested = [nested];
  assert.equal(decodedLegacyMacosPlistSchema.safeParse({ plist: { nested }, nativeValues: [] }).success, false);
  assert.equal(decodedLegacyMacosPlistSchema.safeParse({ plist: { many: Array(100_001).fill(null) }, nativeValues: [] }).success, false);
});

const fixture = xml(`<dict>
  <key>setupShown</key><true/><key>keepHistory</key><false/><key>numeric</key><integer>1</integer>
  <key>fraction</key><real>1.25</real><key>text</key><string>Grüße 🦉 漢字</string>
  <key>trigger</key><data>bnVsbA==</data><key>emptyData</key><data></data>
  <key>epoch</key><date>2001-01-01T00:00:00Z</date><key>unixEpoch</key><date>1970-01-01T00:00:00Z</date>
  <key>large</key><integer>9007199254740993</integer><key>maximum</key><integer>9223372036854775807</integer>
  <key>__proto__</key><dict><key>0</key><data>AP9B</data></dict><key>constructor</key><string>retained</string>
  <key>a.b&#10;🦉</key><array><dict><key>key</key><data>AP9B</data></dict><string>tail</string></array>
  <key>lookalike</key><dict><key>$nativePlist</key><string>data</string><key>base64</key><string>AP9B</string></dict>
</dict>`);
function nativeValue(result: DecodedLegacyMacosPlist, path: (string | number)[]): unknown {
  return result.nativeValues.find((entry) => JSON.stringify(entry.path) === JSON.stringify(path))?.value;
}
function checkFixture(result: DecodedLegacyMacosPlist): void {
  assert.equal(result.plist["setupShown"], true); assert.equal(result.plist["keepHistory"], false);
  assert.equal(result.plist["numeric"], 1); assert.equal(result.plist["fraction"], 1.25); assert.equal(result.plist["text"], "Grüße 🦉 漢字");
  assert.deepEqual(nativeValue(result, ["trigger"]), { $nativePlist: "data", base64: "bnVsbA==" });
  assert.deepEqual(nativeValue(result, ["emptyData"]), { $nativePlist: "data", base64: "" });
  assert.deepEqual(nativeValue(result, ["epoch"]), { $nativePlist: "date", absoluteTimeBits: doubleBits(0) });
  assert.deepEqual(nativeValue(result, ["unixEpoch"]), { $nativePlist: "date", absoluteTimeBits: doubleBits(-978_307_200) });
  for (const [key, decimal] of [["large", "9007199254740993"], ["maximum", "9223372036854775807"]]) {
    assert.ok(key); const value = nativeValue(result, [key]); assert.ok(value && typeof value === "object");
    assert.equal(Reflect.get(value, "$nativePlist"), "number"); assert.equal(Reflect.get(value, "representation"), "signed-int64");
    assert.equal(Reflect.get(value, "decimal"), decimal);
  }
  assert.deepEqual(nativeValue(result, ["__proto__", "0"]), { $nativePlist: "data", base64: "AP9B" });
  assert.deepEqual(nativeValue(result, ["a.b\n🦉", 0, "key"]), { $nativePlist: "data", base64: "AP9B" });
  assert.equal(nativeValue(result, ["lookalike"]), undefined); assert.equal(Object.hasOwn(result.plist, "__proto__"), true);
  assert.equal(result.plist["constructor"], "retained"); assert.equal(Object.getPrototypeOf(result.plist), Object.prototype);
}
test("real CF archival XML parser preserves typed values Unicode and exact dictionary paths", { skip: process.platform !== "darwin" }, () => {
  const original = Buffer.from(fixture); checkFixture(decodeLegacyMacosPlist(fixture)); assert.deepEqual(fixture, original);
});
test("real CF parser reads the owned plutil binary1 equivalent with the same preserved values", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-owned-plist-"));
  try {
    const source = join(directory, "fixture.plist"), binary = join(directory, "fixture-binary.plist");
    await writeFile(source, fixture, { mode: 0o600 });
    await execute("/usr/bin/plutil", ["-convert", "binary1", "-o", binary, source], { timeout: 5000, maxBuffer: 4096 });
    const bytes = await readFile(binary); assert.equal(bytes.subarray(0, 8).toString("ascii"), "bplist00");
    checkFixture(decodeLegacyMacosPlist(bytes)); assert.deepEqual(await readFile(source), fixture);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("real CF parser retains signed zero and nonfinite reals as native number projections", { skip: process.platform !== "darwin" }, () => {
  const result = decodeLegacyMacosPlist(xml("<dict><key>zero</key><real>-0.0</real><key>positive</key><real>+infinity</real><key>negative</key><real>-infinity</real><key>nan</key><real>nan</real></dict>"));
  for (const [name, expected] of [["zero", -0], ["positive", Infinity], ["negative", -Infinity], ["nan", NaN]] as const) {
    const value = nativeValue(result, [name]); assert.ok(value && typeof value === "object");
    assert.equal(Reflect.get(value, "$nativePlist"), "number");
    if (Reflect.get(value, "representation") === "opaque") assert.equal(Reflect.get(value, "reason"), "LOSSFUL_EXTRACTION");
    else {
      assert.equal(Reflect.get(value, "representation"), "float64"); const bits: unknown = Reflect.get(value, "bits"); assert.equal(typeof bits, "string");
      assert.ok(typeof bits === "string"); const recovered = Buffer.from(bits, "hex").readDoubleBE();
      assert.equal(Object.is(recovered, expected), true);
    }
  }
});
test("real CF parser rejects malformed unsupported-root overexpanded deep and oversized-node archives", { skip: process.platform !== "darwin" }, () => {
  for (const bytes of [Buffer.from("private invalid fixture"), xml("<array><string>value</string></array>"), xml("<integer>1</integer>"),
    xml(`<dict><key>nested</key>${"<array>".repeat(65)}<string>value</string>${"</array>".repeat(65)}</dict>`),
    xml(`<dict><key>many</key><array>${"<string/>".repeat(100_001)}</array></dict>`),
    xml(`<dict><key>native</key><data>${Buffer.alloc(3 * 1024 * 1024 + 16).toString("base64")}</data></dict>`),
  ]) assert.throws(() => decodeLegacyMacosPlist(bytes), errorCode("INVALID_DATA"));
});

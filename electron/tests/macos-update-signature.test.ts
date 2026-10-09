import assert from "node:assert/strict";
import test from "node:test";
import { MACOS_UPDATE_SIGNATURE_FLAGS, MacosUpdateSignatureError, verifyMacosUpdateSignature,
  type MacosUpdateSignatureNative } from "../src/services/macos-update-signature.js";

const candidate = "/private/owned stage/OpenWhisper 日本語.app";
type CopyStage = "self" | "static-self" | "requirement" | "candidate";
function fixture(failureAt?: CopyStage, status = -67050) {
  const calls: string[] = [], released: bigint[] = []; let disposed = 0, urlBytes: Uint8Array | undefined;
  const copy = (stage: CopyStage, reference: bigint, output: unknown[]) => {
    calls.push(stage); output[0] = reference; return failureAt === stage ? status : 0;
  };
  const native: MacosUpdateSignatureNative = {
    copySelf(flags, output) { assert.equal(flags, 0); return copy("self", 1n, output); },
    copyStaticCode(code, flags, output) { assert.equal(code, 1n); assert.equal(flags, 0); return copy("static-self", 2n, output); },
    copyDesignatedRequirement(code, flags, output) { assert.equal(code, 2n); assert.equal(flags, 0); return copy("requirement", 3n, output); },
    createFileURL(bytes) { calls.push("url"); urlBytes = bytes; return 4n; },
    createStaticCode(url, flags, output) { assert.equal(url, 4n); assert.equal(flags, 0); return copy("candidate", 5n, output); },
    checkValidity(code, flags, requirement) { calls.push("check"); assert.equal(code, 5n); assert.equal(flags, 25); assert.equal(requirement, 3n); return 0; },
    release(reference) { released.push(reference); }, dispose() { disposed++; },
  };
  return { native, calls, released, get disposed() { return disposed; }, get urlBytes() { return urlBytes; } };
}
function failure(code: string, osStatus?: number) {
  return (error: unknown) => error instanceof MacosUpdateSignatureError && error.code === code && error.osStatus === osStatus && error.message === code;
}

test("Mac update verification uses the current self requirement and all architecture, nested and strict validation", () => {
  const f = fixture(); verifyMacosUpdateSignature(candidate, () => f.native);
  assert.equal(MACOS_UPDATE_SIGNATURE_FLAGS, 25);
  assert.deepEqual(f.calls, ["self", "static-self", "requirement", "url", "candidate", "check"]);
  assert.deepEqual(Buffer.from(f.urlBytes!), Buffer.from(candidate, "utf8"));
  assert.deepEqual(f.released, [5n, 4n, 3n, 2n, 1n]); assert.equal(f.disposed, 1);
});

test("Mac update verification releases partial copied ownership on every native status failure", () => {
  for (const [stage, released] of [["self", [1n]], ["static-self", [2n, 1n]], ["requirement", [3n, 2n, 1n]],
    ["candidate", [5n, 4n, 3n, 2n, 1n]]] as const) {
    const f = fixture(stage);
    assert.throws(() => verifyMacosUpdateSignature(candidate, () => f.native), failure(stage === "candidate" ? "INVALID_SIGNATURE" : "CURRENT_SIGNATURE_UNAVAILABLE", -67050));
    assert.deepEqual(f.released, released); assert.equal(f.disposed, 1); assert.equal(f.calls.includes("check"), false);
  }
});

test("Mac update verification rejects missing current requirement rather than validating without it", () => {
  const f = fixture(); f.native.copyDesignatedRequirement = (_code, _flags, output) => { output[0] = null; return 0; };
  assert.throws(() => verifyMacosUpdateSignature(candidate, () => f.native), failure("CURRENT_SIGNATURE_UNAVAILABLE", 0));
  assert.deepEqual(f.released, [2n, 1n]); assert.equal(f.disposed, 1); assert.equal(f.calls.includes("url"), false);
});

test("Mac update verification preserves the signature OSStatus and rejects malformed statuses", () => {
  const refused = fixture(); refused.native.checkValidity = () => -67062;
  assert.throws(() => verifyMacosUpdateSignature(candidate, () => refused.native), failure("INVALID_SIGNATURE", -67062));
  assert.deepEqual(refused.released, [5n, 4n, 3n, 2n, 1n]); assert.equal(refused.disposed, 1);
  for (const status of [NaN, 1.5, 0n, "0", 0x80000000, -0x80000001]) {
    const f = fixture(); f.native.checkValidity = () => status;
    assert.throws(() => verifyMacosUpdateSignature(candidate, () => f.native), failure("NATIVE_RESULT_INVALID"));
    assert.deepEqual(f.released, [5n, 4n, 3n, 2n, 1n]); assert.equal(f.disposed, 1);
  }
});

test("Mac update verification never passes malformed or null native references to later calls", () => {
  for (const reference of [null, 0n, "private native value", -1n, 0x10000000000000000n]) {
    const f = fixture(); f.native.createFileURL = () => reference;
    assert.throws(() => verifyMacosUpdateSignature(candidate, () => f.native), failure(reference === null || reference === 0n ? "NATIVE_UNAVAILABLE" : "NATIVE_RESULT_INVALID"));
    assert.deepEqual(f.released, [3n, 2n, 1n]); assert.equal(f.disposed, 1); assert.equal(f.calls.includes("candidate"), false);
  }
});

test("Mac update verification retains copied output and categorical privacy if the native invocation throws", () => {
  const f = fixture(); f.native.createStaticCode = (_url, _flags, output) => { output[0] = 5n; throw new Error("Private staged path and opaque native exception"); };
  assert.throws(() => verifyMacosUpdateSignature(candidate, () => f.native), failure("NATIVE_UNAVAILABLE"));
  assert.deepEqual(f.released, [5n, 4n, 3n, 2n, 1n]); assert.equal(f.disposed, 1);
  assert.throws(() => verifyMacosUpdateSignature(candidate, () => { throw new Error("Private native loader details"); }), failure("NATIVE_UNAVAILABLE"));
});

test("Mac update verification attempts every release and library disposal and never accepts failed cleanup", () => {
  for (const failedReference of [5n, 4n, 3n, 2n, 1n]) {
    const f = fixture(); f.native.release = (reference) => { f.released.push(reference); if (reference === failedReference) throw new Error("Private cleanup"); };
    assert.throws(() => verifyMacosUpdateSignature(candidate, () => f.native), failure("RELEASE_FAILED"));
    assert.deepEqual(f.released, [5n, 4n, 3n, 2n, 1n]); assert.equal(f.disposed, 1);
  }
  const f = fixture(); f.native.dispose = () => { throw new Error("Private library cleanup"); };
  assert.throws(() => verifyMacosUpdateSignature(candidate, () => f.native), failure("RELEASE_FAILED"));
  assert.deepEqual(f.released, [5n, 4n, 3n, 2n, 1n]);
  const refused = fixture(); refused.native.checkValidity = () => -67062; refused.native.release = () => { throw new Error("Private cleanup"); };
  assert.throws(() => verifyMacosUpdateSignature(candidate, () => refused.native), failure("INVALID_SIGNATURE", -67062));
  assert.equal(refused.disposed, 1);
});

test("Mac update verification refuses untrusted path forms before constructing the native bridge", () => {
  let opened = 0;
  for (const path of ["relative.app", "/private/../owned.app", "/private//owned.app", "/private/app", "/private/owned.app\0", "/private/\ud800.app", `/${"a".repeat(4096)}.app`]) {
    assert.throws(() => verifyMacosUpdateSignature(path, () => { opened++; return fixture().native; }), failure("INVALID_PATH"));
  }
  assert.equal(opened, 0);
});

test("Mac update signature module stays inert and refuses native construction on another host", { skip: process.platform === "darwin" }, () => {
  assert.throws(() => verifyMacosUpdateSignature(candidate), failure("UNSUPPORTED_HOST"));
});

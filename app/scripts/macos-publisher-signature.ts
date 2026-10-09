import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { LibraryHandle } from "koffi";
import { MACOS_UPDATE_SIGNATURE_FLAGS, type MacosUpdateSignatureNative } from "../src/services/update/macos/macos-update-signature.js";

type PublisherNative = Pick<MacosUpdateSignatureNative, "createFileURL" | "createStaticCode" | "copyDesignatedRequirement" |
  "checkValidity" | "release" | "dispose"> & {
    copyRequirementData(requirement: bigint, flags: number, output: unknown[]): unknown;
    readRequirementData(data: bigint): Uint8Array;
  };
export class MacosPublisherSignatureError extends Error {
  constructor(readonly category: "INVALID_PATH" | "NATIVE_UNAVAILABLE" | "ORIGINAL_SIGNATURE_REFUSED" |
    "REQUIREMENT_UNAVAILABLE" | "CANDIDATE_SIGNATURE_REFUSED" | "CLEANUP_FAILED" | "ADHOC_SIGNING_FAILED") {
    super(category); this.name = "MacosPublisherSignatureError";
  }
}
export interface MacosPublisherRequirementReceipt { readonly bytes: number; readonly sha256: string }
function fail(category: MacosPublisherSignatureError["category"]): never { throw new MacosPublisherSignatureError(category); }
function pointer(value: unknown): bigint | null {
  if (value === null || value === 0n) return null;
  if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) fail("NATIVE_UNAVAILABLE");
  return value;
}
function status(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) fail("NATIVE_UNAVAILABLE");
  return value;
}
function appPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value !== resolve(value) || !value.endsWith(".app") || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4096 || Buffer.from(value, "utf8").toString("utf8") !== value) fail("INVALID_PATH");
  return value;
}

export async function copyMacosPublisherAdversary(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
    dereference: false, verbatimSymlinks: true });
}
function createNative(): PublisherNative {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) fail("NATIVE_UNAVAILABLE");
  const libraries: LibraryHandle[] = [];
  try {
    const loaded: unknown = createRequire(import.meta.url)("koffi");
    if (typeof loaded !== "object" || loaded === null || typeof Reflect.get(loaded, "load") !== "function") fail("NATIVE_UNAVAILABLE");
    const ffi = loaded as typeof import("koffi");
    if (ffi.sizeof("void *") !== 8 || ffi.sizeof("long") !== 8) fail("NATIVE_UNAVAILABLE");
    const core = ffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"); libraries.push(core);
    const security = ffi.load("/System/Library/Frameworks/Security.framework/Security"); libraries.push(security);
    const bind = (library: LibraryHandle, definition: string): ((...args: unknown[]) => unknown) => {
      const call = library.func(definition); return (...args) => { const result: unknown = call(...args); return result; };
    };
    const createURL = bind(core, "void *CFURLCreateFromFileSystemRepresentation(void *allocator, const uint8_t *bytes, long length, uint8_t isDirectory)");
    const createStaticCode = bind(security, "int32_t SecStaticCodeCreateWithPath(void *url, uint32_t flags, _Out_ void **code)");
    const copyRequirement = bind(security, "int32_t SecCodeCopyDesignatedRequirement(void *code, uint32_t flags, _Out_ void **requirement)");
    const requirementData = bind(security, "int32_t SecRequirementCopyData(void *requirement, uint32_t flags, _Out_ void **data)");
    const check = bind(security, "int32_t SecStaticCodeCheckValidity(void *code, uint32_t flags, void *requirement)");
    const length = bind(core, "long CFDataGetLength(void *data)");
    const dataBytes = bind(core, "const uint8_t *CFDataGetBytePtr(void *data)");
    const release = bind(core, "void CFRelease(void *reference)");
    return {
      createFileURL(bytes) { return createURL(null, bytes, bytes.length, 1); },
      createStaticCode(url, flags, output) { return createStaticCode(url, flags, output); },
      copyDesignatedRequirement(code, flags, output) { return copyRequirement(code, flags, output); },
      copyRequirementData(requirement, flags, output) { return requirementData(requirement, flags, output); },
      checkValidity(code, flags, requirement) { return check(code, flags, requirement); },
      readRequirementData(data) {
        const rawLength = length(data);
        const size = typeof rawLength === "bigint" ? Number(rawLength) : rawLength;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > 64 * 1024) fail("REQUIREMENT_UNAVAILABLE");
        const address = pointer(dataBytes(data)); if (address === null) fail("REQUIREMENT_UNAVAILABLE");
        const decoded: unknown = ffi.decode(address, ffi.array("uint8_t", size));
        if (!(decoded instanceof Uint8Array) && !Array.isArray(decoded)) fail("REQUIREMENT_UNAVAILABLE");
        const bytes = Buffer.from(decoded as Uint8Array | number[]);
        if (bytes.length !== size) fail("REQUIREMENT_UNAVAILABLE");
        return bytes;
      },
      release(reference) { release(reference); },
      dispose() { let failed = false; for (const library of libraries.reverse()) { try { library.unload(); } catch { failed = true; } }
        if (failed) fail("CLEANUP_FAILED"); },
    };
  } catch (error: unknown) {
    for (const library of libraries.reverse()) { try { library.unload(); } catch { /* Keep native setup details private. */ } }
    throw error instanceof MacosPublisherSignatureError ? error : new MacosPublisherSignatureError("NATIVE_UNAVAILABLE");
  }
}

function verified(originalValue: string, candidateValue: string, open: () => PublisherNative): Buffer {
  const original = appPath(originalValue), candidate = appPath(candidateValue);
  let native: PublisherNative;
  try { native = open(); } catch { return fail("NATIVE_UNAVAILABLE"); }
  const references: bigint[] = [];
  let operationError: MacosPublisherSignatureError | undefined, requirementBytes: Buffer | undefined;
  const take = (call: (output: unknown[]) => unknown, category: MacosPublisherSignatureError["category"]): bigint => {
    const output: unknown[] = [null]; let ref: bigint | null = null, result: unknown;
    try { result = call(output); } finally { ref = pointer(output[0]); if (ref !== null) references.push(ref); }
    if (status(result) !== 0 || ref === null) fail(category);
    return ref;
  };
  const url = (path: string): bigint => {
    const ref = pointer(native.createFileURL(Buffer.from(path, "utf8")));
    if (ref === null) fail("NATIVE_UNAVAILABLE");
    references.push(ref); return ref;
  };
  try {
    const originalCode = take((output) => native.createStaticCode(url(original), 0, output), "ORIGINAL_SIGNATURE_REFUSED");
    if (status(native.checkValidity(originalCode, MACOS_UPDATE_SIGNATURE_FLAGS, 0n)) !== 0) fail("ORIGINAL_SIGNATURE_REFUSED");
    const requirement = take((output) => native.copyDesignatedRequirement(originalCode, 0, output), "ORIGINAL_SIGNATURE_REFUSED");
    const data = take((output) => native.copyRequirementData(requirement, 0, output), "REQUIREMENT_UNAVAILABLE");
    const bytes = native.readRequirementData(data);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 64 * 1024) fail("REQUIREMENT_UNAVAILABLE");
    requirementBytes = Buffer.from(bytes);
    const candidateCode = take((output) => native.createStaticCode(url(candidate), 0, output), "CANDIDATE_SIGNATURE_REFUSED");
    if (status(native.checkValidity(candidateCode, MACOS_UPDATE_SIGNATURE_FLAGS, requirement)) !== 0) fail("CANDIDATE_SIGNATURE_REFUSED");
  } catch (error: unknown) {
    operationError = error instanceof MacosPublisherSignatureError ? error : new MacosPublisherSignatureError("NATIVE_UNAVAILABLE");
  } finally {
    for (const ref of references.reverse()) { try { native.release(ref); } catch { operationError ??= new MacosPublisherSignatureError("CLEANUP_FAILED"); } }
    try { native.dispose(); } catch { operationError ??= new MacosPublisherSignatureError("CLEANUP_FAILED"); }
  }
  if (operationError) throw operationError;
  if (!requirementBytes) fail("REQUIREMENT_UNAVAILABLE");
  return requirementBytes;
}

/** Reads the original bundle's binary Security requirement after strict all-architecture validation. */
export function readMacosPublisherRequirement(original: string, open: () => PublisherNative = createNative): MacosPublisherRequirementReceipt {
  const bytes = verified(original, original, open);
  return Object.freeze({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}

/** Require the pinned original publisher, then prove a valid same-ID ad-hoc copy is refused by that exact requirement. */
export async function verifyMacosPublisherCandidate(originalValue: string, candidateValue: string): Promise<{
  readonly status: "PASS"; readonly originalRequirement: "ACCEPTED"; readonly validSameIdDifferentPublisher: "REJECTED";
  readonly flags: "all-architectures,nested-code,strict-resources";
}> {
  const original = appPath(originalValue), candidate = appPath(candidateValue);
  verified(original, candidate, createNative);
  const temporary = await mkdtemp(join(tmpdir(), "openwhisper-publisher-requirement-"));
  try {
    const adversary = join(temporary, "OpenWhisper.app");
    await copyMacosPublisherAdversary(candidate, adversary);
    const sign = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", adversary],
      { encoding: "utf8", shell: false, timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (sign.error || sign.signal !== null || sign.status !== 0) fail("ADHOC_SIGNING_FAILED");
    const selfValid = spawnSync("/usr/bin/codesign", ["--verify", "--all-architectures", "--deep", "--strict", adversary],
      { encoding: "utf8", shell: false, timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (selfValid.error || selfValid.signal !== null || selfValid.status !== 0) fail("ADHOC_SIGNING_FAILED");
    const bundleID = (path: string): string => {
      const result = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Contents/Info.plist")],
        { encoding: "utf8", shell: false, timeout: 10_000, maxBuffer: 4096 });
      if (result.error || result.signal !== null || result.status !== 0) fail("ADHOC_SIGNING_FAILED");
      return result.stdout.trim();
    };
    if (!bundleID(original) || bundleID(adversary) !== bundleID(original)) fail("ADHOC_SIGNING_FAILED");
    let rejected = false;
    try {
      verified(original, adversary, createNative);
    } catch (error: unknown) {
      if (!(error instanceof MacosPublisherSignatureError) || error.category !== "CANDIDATE_SIGNATURE_REFUSED") throw error;
      rejected = true;
    }
    if (!rejected) fail("CANDIDATE_SIGNATURE_REFUSED");
    return Object.freeze({ status: "PASS", originalRequirement: "ACCEPTED", validSameIdDifferentPublisher: "REJECTED",
      flags: "all-architectures,nested-code,strict-resources" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

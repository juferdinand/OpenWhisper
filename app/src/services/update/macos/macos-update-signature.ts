import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import type { LibraryHandle } from "koffi";

type Failure = "INVALID_PATH" | "UNSUPPORTED_HOST" | "NATIVE_UNAVAILABLE" | "NATIVE_RESULT_INVALID" |
  "CURRENT_SIGNATURE_UNAVAILABLE" | "INVALID_SIGNATURE" | "RELEASE_FAILED";
export class MacosUpdateSignatureError extends Error {
  constructor(readonly code: Failure, readonly osStatus?: number) { super(code); this.name = "MacosUpdateSignatureError"; }
}

// SecStaticCode.h: all architectures, nested code and strict sealed resources.
export const MACOS_UPDATE_SIGNATURE_FLAGS = (1 << 0) | (1 << 3) | (1 << 4);
export interface MacosUpdateSignatureNative {
  copySelf(flags: number, output: unknown[]): unknown;
  copyStaticCode(code: bigint, flags: number, output: unknown[]): unknown;
  copyDesignatedRequirement(code: bigint, flags: number, output: unknown[]): unknown;
  createFileURL(bytes: Uint8Array): unknown;
  createStaticCode(url: bigint, flags: number, output: unknown[]): unknown;
  checkValidity(code: bigint, flags: number, requirement: bigint): unknown;
  release(reference: bigint): void;
  dispose(): void;
}
function fail(code: Failure, status?: number): never { throw new MacosUpdateSignatureError(code, status); }
function pointer(value: unknown): bigint | null {
  if (value === null || value === 0n) return null;
  if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) return fail("NATIVE_RESULT_INVALID");
  return value;
}
function osStatus(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) return fail("NATIVE_RESULT_INVALID");
  return value;
}

/** Caller owns and freezes the staged bundle. This checks its signature, not replacement authorization.
 * The optional native factory is a trusted test seam, never an IPC or preference value. */
export function verifyMacosUpdateSignature(candidate: string, open: () => MacosUpdateSignatureNative = createNative): void {
  if (typeof candidate !== "string" || !isAbsolute(candidate) || candidate !== resolve(candidate) ||
    !candidate.endsWith(".app") || candidate.includes("\0")) fail("INVALID_PATH");
  const bytes = Buffer.from(candidate, "utf8");
  if (bytes.length > 4096 || bytes.toString("utf8") !== candidate) fail("INVALID_PATH");
  let native: MacosUpdateSignatureNative;
  try { native = open(); } catch (error: unknown) {
    throw error instanceof MacosUpdateSignatureError ? error : new MacosUpdateSignatureError("NATIVE_UNAVAILABLE");
  }
  const references: bigint[] = [];
  let failure: MacosUpdateSignatureError | undefined;
  const copy = (operation: (output: unknown[]) => unknown, code: "CURRENT_SIGNATURE_UNAVAILABLE" | "INVALID_SIGNATURE"): bigint => {
    const output: unknown[] = [null]; let reference: bigint | null = null, result: unknown;
    try { result = operation(output); }
    finally { reference = pointer(output[0]); if (reference !== null) references.push(reference); }
    const status = osStatus(result);
    if (status !== 0 || reference === null) fail(code, status);
    return reference;
  };
  try {
    const self = copy((output) => native.copySelf(0, output), "CURRENT_SIGNATURE_UNAVAILABLE");
    const staticSelf = copy((output) => native.copyStaticCode(self, 0, output), "CURRENT_SIGNATURE_UNAVAILABLE");
    const requirement = copy((output) => native.copyDesignatedRequirement(staticSelf, 0, output), "CURRENT_SIGNATURE_UNAVAILABLE");
    const url = pointer(native.createFileURL(bytes)); if (url === null) fail("NATIVE_UNAVAILABLE"); references.push(url);
    const candidateCode = copy((output) => native.createStaticCode(url, 0, output), "INVALID_SIGNATURE");
    const status = osStatus(native.checkValidity(candidateCode, MACOS_UPDATE_SIGNATURE_FLAGS, requirement));
    if (status !== 0) fail("INVALID_SIGNATURE", status);
  } catch (error: unknown) {
    failure = error instanceof MacosUpdateSignatureError ? error : new MacosUpdateSignatureError("NATIVE_UNAVAILABLE");
  } finally {
    for (const reference of references.reverse()) {
      try { native.release(reference); } catch { failure ??= new MacosUpdateSignatureError("RELEASE_FAILED"); }
    }
    try { native.dispose(); } catch { failure ??= new MacosUpdateSignatureError("RELEASE_FAILED"); }
  }
  if (failure) throw failure;
}

function createNative(): MacosUpdateSignatureNative {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) fail("UNSUPPORTED_HOST");
  const libraries: LibraryHandle[] = [];
  try {
    const imported: unknown = createRequire(import.meta.url)("koffi");
    if (typeof imported !== "object" || imported === null || typeof Reflect.get(imported, "load") !== "function") fail("NATIVE_UNAVAILABLE");
    const ffi = imported as typeof import("koffi");
    if (ffi.sizeof("void *") !== 8 || ffi.sizeof("long") !== 8) fail("UNSUPPORTED_HOST");
    const foundation = ffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"); libraries.push(foundation);
    const security = ffi.load("/System/Library/Frameworks/Security.framework/Security"); libraries.push(security);
    const bind = (library: LibraryHandle, definition: string): ((...args: unknown[]) => unknown) => {
      const call = library.func(definition); return (...args) => { const result: unknown = call(...args); return result; };
    };
    const self = bind(security, "int32_t SecCodeCopySelf(uint32_t flags, _Out_ void **code)");
    const staticCode = bind(security, "int32_t SecCodeCopyStaticCode(void *code, uint32_t flags, _Out_ void **staticCode)");
    const requirement = bind(security, "int32_t SecCodeCopyDesignatedRequirement(void *code, uint32_t flags, _Out_ void **requirement)");
    const create = bind(security, "int32_t SecStaticCodeCreateWithPath(void *url, uint32_t flags, _Out_ void **code)");
    const check = bind(security, "int32_t SecStaticCodeCheckValidity(void *code, uint32_t flags, void *requirement)");
    const url = bind(foundation, "void *CFURLCreateFromFileSystemRepresentation(void *allocator, const uint8_t *bytes, long length, uint8_t isDirectory)");
    const release = bind(foundation, "void CFRelease(void *reference)");
    return {
      copySelf: (flags, output) => self(flags, output), copyStaticCode: (code, flags, output) => staticCode(code, flags, output),
      copyDesignatedRequirement: (code, flags, output) => requirement(code, flags, output),
      createFileURL: (bytes) => url(null, bytes, bytes.length, 1), createStaticCode: (path, flags, output) => create(path, flags, output),
      checkValidity: (code, flags, requirement) => check(code, flags, requirement), release: (reference) => { release(reference); },
      dispose: () => { let failed = false; for (const library of libraries.reverse()) { try { library.unload(); } catch { failed = true; } }
        if (failed) fail("RELEASE_FAILED"); },
    };
  } catch (error: unknown) {
    for (const library of libraries.reverse()) { try { library.unload(); } catch { /* Preserve categorical construction failure. */ } }
    throw error instanceof MacosUpdateSignatureError ? error : new MacosUpdateSignatureError("NATIVE_UNAVAILABLE");
  }
}

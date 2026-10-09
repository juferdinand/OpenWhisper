import { createPublicKey, verify } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";
import { parseUpdateVersion, UPDATE_POLICY_LIMITS } from "./update-policy.js";

// Preserve the native updater's publisher key; callers cannot supply a replacement.
export const LINUX_UPDATE_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEMxQTY3Q0I1MzY1RjJCODgKUldTSUsxODJ0WHltd1ZnN3ZNZUphSysrMXNRY2RESlZCV1BMajBtc3ZLR25iOTBnaXNpK01wM1oK";
export const MAX_LINUX_UPDATE_BYTES = 1024 ** 3;
type Failure = "INVALID_FORMAT" | "INVALID_VERSION" | "INVALID_LIMIT" | "INVALID_PAYLOAD" | "KEY_ID_MISMATCH" |
  "INVALID_SIGNATURE" | "SIGNED_VERSION_MISMATCH" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_LEGACY_STREAM" | "READ_FAILED" | "CRYPTO_UNAVAILABLE";
export class LinuxUpdateSignatureError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "LinuxUpdateSignatureError"; }
}
const fail = (code: Failure): never => { throw new LinuxUpdateSignatureError(code); };
function crypto<T>(operation: () => T): T {
  try { return operation(); } catch { return fail("CRYPTO_UNAVAILABLE"); }
}
function base64(value: string): Buffer {
  if (!value.length || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(value)) return fail("INVALID_FORMAT");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return fail("INVALID_FORMAT");
  return bytes;
}
function envelope(value: unknown, count: number): readonly string[] {
  if (typeof value !== "string" || value.length > UPDATE_POLICY_LIMITS.signatureBytes ||
      Buffer.byteLength(value, "utf8") > UPDATE_POLICY_LIMITS.signatureBytes) return fail("INVALID_FORMAT");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(base64(value.trim())); }
  catch { return fail("INVALID_FORMAT"); }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== count || lines.some((line) => line.includes("\r"))) return fail("INVALID_FORMAT");
  return lines;
}
function mode(packet: Buffer): "Ed" | "ED" {
  if (packet[0] !== 0x45 || (packet[1] !== 0x64 && packet[1] !== 0x44)) return fail("INVALID_FORMAT");
  return packet[1] === 0x64 ? "Ed" : "ED";
}
function admitted(signature: unknown, announcedVersion: unknown) {
  try { parseUpdateVersion(announcedVersion); } catch { return fail("INVALID_VERSION"); }
  const keyPacket = base64(envelope(LINUX_UPDATE_PUBLIC_KEY, 2)[1]!);
  const lines = envelope(signature, 4), packet = base64(lines[1]!), globalSignature = base64(lines[3]!);
  if (keyPacket.length !== 42 || packet.length !== 74 || globalSignature.length !== 64 ||
      !lines[2]!.startsWith("trusted comment: ")) return fail("INVALID_FORMAT");
  mode(keyPacket);
  const algorithm = mode(packet);
  if (!keyPacket.subarray(2, 10).equals(packet.subarray(2, 10))) return fail("KEY_ID_MISMATCH");
  const key = crypto(() => createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: keyPacket.subarray(10).toString("base64url") } }));
  return { algorithm, key, payloadSignature: packet.subarray(10), globalSignature,
    comment: lines[2]!.slice("trusted comment: ".length), announcedVersion };
}
type Admission = ReturnType<typeof admitted>;
function finish(message: Uint8Array, admission: Admission): void {
  const { key, payloadSignature, globalSignature, comment, announcedVersion } = admission;
  if (!crypto(() => verify(null, message, key, payloadSignature)) ||
      !crypto(() => verify(null, Buffer.concat([payloadSignature, Buffer.from(comment, "utf8")]), key, globalSignature))) return fail("INVALID_SIGNATURE");
  // Match the native core's first exact tab-separated version field, after both signatures pass.
  if (comment.split("\t").find((field) => field.startsWith("version:"))?.slice(8) !== announcedVersion) return fail("SIGNED_VERSION_MISMATCH");
}
function limit(maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_LINUX_UPDATE_BYTES) return fail("INVALID_LIMIT");
}
function view(value: Uint8Array): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || value.buffer instanceof SharedArrayBuffer) return fail("INVALID_PAYLOAD");
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } catch { return fail("INVALID_PAYLOAD"); }
}

/** Authenticates supplied bytes only; source policy, file ownership and installation remain separate. */
export function verifyLinuxUpdateBytes(bytes: Uint8Array, signature: unknown, announcedVersion: unknown,
  maximumBytes = MAX_LINUX_UPDATE_BYTES): void {
  limit(maximumBytes);
  const admission = admitted(signature, announcedVersion), payload = view(bytes);
  if (payload.byteLength > maximumBytes) return fail("PAYLOAD_TOO_LARGE");
  // Minisign ED uses ordinary Ed25519 over BLAKE2b-512, not RFC Ed25519ph or SHA-512.
  const message = admission.algorithm === "ED" ? crypto(() => blake2b(payload, { dkLen: 64 })) : payload;
  finish(message, admission);
}

/** Consumes caller-owned chunks once. Legacy Ed requires bounded bytes and cannot be prehashed. */
export async function verifyLinuxUpdateStream(chunks: AsyncIterable<Uint8Array>, signature: unknown, announcedVersion: unknown,
  maximumBytes = MAX_LINUX_UPDATE_BYTES): Promise<void> {
  limit(maximumBytes);
  const admission = admitted(signature, announcedVersion);
  if (admission.algorithm !== "ED") return fail("UNSUPPORTED_LEGACY_STREAM");
  const hash = crypto(() => blake2b.create({ dkLen: 64 }));
  let length = 0, localFailure: unknown;
  try {
    for await (const chunk of chunks) {
      try {
        const payload = view(chunk);
        if (payload.byteLength > maximumBytes - length) return fail("PAYLOAD_TOO_LARGE");
        length += payload.byteLength;
        crypto(() => hash.update(payload));
      } catch (error: unknown) { localFailure = error; throw error; }
    }
  } catch (error: unknown) {
    if (localFailure !== undefined && error === localFailure) throw localFailure;
    return fail("READ_FAILED");
  }
  finish(crypto(() => hash.digest()), admission);
}

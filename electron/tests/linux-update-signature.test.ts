import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { test } from "node:test";
import { z } from "zod";
import { blake2b } from "@noble/hashes/blake2.js";
import { LINUX_UPDATE_PUBLIC_KEY, LinuxUpdateSignatureError, MAX_LINUX_UPDATE_BYTES,
  verifyLinuxUpdateBytes, verifyLinuxUpdateStream } from "../src/services/linux-update-signature.js";
import { UPDATE_POLICY_LIMITS } from "../src/services/update-policy.js";

// Original public 0.2.5 envelope, without payload or private signing material.
const releaseSignature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTSUsxODJ0WHltd1NSQ1VqNWY4dzlHNi9PTHZsWFNIbEFtdS9FZDZqWnFhRVZqQ29WMVoycmJEWlljNS9qMi9sUERLWCtqL25UclZYbEhQQWVNWEZseFF0NmowYktweEFZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNDEwNTQwCWZpbGU6T3BlbldoaXNwZXItTGludXgtYW1kNjQuZGViCXZlcnNpb246MC4yLjUKQysxdTllc3FxSnBZWVY1YXRGWTlVTXlJZ0hEUHZSRk94TkVvQTRzYm56YTF3MWFLaGdhVU5sQkhrQ2hraUVNcXNZRTQ3Mlhhd0xMeTRpMzd1OTd3QkE9PQo=";
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
const failure = (code: string) => (error: unknown): boolean => error instanceof LinuxUpdateSignatureError && error.code === code && error.message === code;
function rewrite(signature: string, change: (lines: string[]) => void): string {
  const lines = Buffer.from(signature, "base64").toString("utf8").trimEnd().split("\n");
  change(lines); return encode(lines.join("\n") + "\n");
}
function packetChange(signature: string, offset: number, value: number): string {
  return rewrite(signature, (lines) => { const packet = Buffer.from(lines[1]!, "base64"); packet[offset] = value; lines[1] = packet.toString("base64"); });
}
async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> { yield* values; }
const byteFailure = (signature: unknown, code: string) =>
  assert.throws(() => verifyLinuxUpdateBytes(Buffer.from("test"), signature, "0.2.5"), failure(code));

// Published minisign-verify 0.3.0 vectors: primitive compatibility only, not fixed-publisher positives.
const vectorKey = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const vectors = [
  ["Ed", "RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=",
    "timestamp:1555779966\tfile:test", "QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA=="],
  ["ED", "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=",
    "timestamp:1556193335\tfile:test", "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg=="],
] as const;
test("published Ed and ED primitives verify exact raw or BLAKE2b bytes and global comment", () => {
  const key = createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(vectorKey, "base64").subarray(10).toString("base64url") } });
  for (const [algorithm, signature, comment, global] of vectors) {
    const payloadSignature = Buffer.from(signature, "base64").subarray(10), raw = Buffer.from("test");
    const digest = blake2b(raw, { dkLen: 64 });
    assert.equal(digest.byteLength, 64);
    assert.deepEqual(blake2b.create({ dkLen: 64 }).update(raw.subarray(0, 1)).update(raw.subarray(1)).digest(), digest);
    const message = algorithm === "Ed" ? raw : digest;
    assert.equal(verify(null, message, key, payloadSignature), true);
    assert.equal(verify(null, Buffer.concat([payloadSignature, Buffer.from(comment)]), key, Buffer.from(global, "base64")), true);
    assert.equal(verify(null, algorithm === "Ed" ? digest : raw, key, payloadSignature), false);
    assert.equal(verify(null, Buffer.concat([payloadSignature, Buffer.from(comment + "\tversion:0.2.5")]), key, Buffer.from(global, "base64")), false);
    const envelope = encode(`untrusted comment: published upstream vector\n${signature}\ntrusted comment: ${comment}\n${global}\n`);
    byteFailure(envelope, "KEY_ID_MISMATCH");
    // Copying the publisher's public ID cannot make a foreign key authoritative.
    byteFailure(rewrite(envelope, (lines) => {
      const packet = Buffer.from(lines[1]!, "base64"); Buffer.from("882b5f36b57ca6c1", "hex").copy(packet, 2); lines[1] = packet.toString("base64");
    }), "INVALID_SIGNATURE");
  }
});
test("fixed publisher key and signature ID retain the native key packet and prehash mode", () => {
  const key = Buffer.from(Buffer.from(LINUX_UPDATE_PUBLIC_KEY, "base64").toString("utf8").split("\n")[1]!, "base64");
  const signature = Buffer.from(Buffer.from(releaseSignature, "base64").toString("utf8").split("\n")[1]!, "base64");
  assert.equal(key.length, 42); assert.equal(key.subarray(0, 2).toString(), "Ed");
  assert.equal(key.subarray(2, 10).toString("hex"), "882b5f36b57ca6c1");
  assert.equal(signature.subarray(0, 2).toString(), "ED"); assert.deepEqual(signature.subarray(2, 10), key.subarray(2, 10));
  byteFailure(packetChange(releaseSignature, 2, 0), "KEY_ID_MISMATCH");
  byteFailure(packetChange(releaseSignature, 1, 0), "INVALID_FORMAT");
});
test("outer whitespace and LF or CRLF preserve authenticated comment bytes", () => {
  const text = Buffer.from(releaseSignature, "base64").toString("utf8");
  for (const signature of [releaseSignature, ` \t${releaseSignature}\r\n`, encode(text.trimEnd()), encode(text.replaceAll("\n", "\r\n"))]) {
    byteFailure(signature, "INVALID_SIGNATURE"); // The small test payload is deliberately not the release package.
  }
});
test("bounded canonical base64, UTF-8 and packet structure refuse malformed envelopes", () => {
  for (const signature of [undefined, null, 1, "", "====", "YWJj\nZA==", "YQ=", "YR==", "YQ-_", Buffer.from([0xff]).toString("base64"),
    "A".repeat(UPDATE_POLICY_LIMITS.signatureBytes + 1), rewrite(releaseSignature, (lines) => { lines.push("extra"); }),
    rewrite(releaseSignature, (lines) => { lines.pop(); }), rewrite(releaseSignature, (lines) => { lines[2] = "trusted comment:missing-space"; }),
    rewrite(releaseSignature, (lines) => { lines[1] = Buffer.alloc(73).toString("base64"); }),
    rewrite(releaseSignature, (lines) => { lines[3] = Buffer.alloc(65).toString("base64"); }),
    rewrite(releaseSignature, (lines) => { lines[0] += "\rprivate"; })]) byteFailure(signature, "INVALID_FORMAT");
});
test("announced versions must be exact canonical UInt64 values before verification", () => {
  for (const version of [undefined, "v0.2.5", "00.2.5", "0.2.5-beta", "0.2.5\n", "18446744073709551616.0.0"]) {
    assert.throws(() => verifyLinuxUpdateBytes(Buffer.from("test"), releaseSignature, version), failure("INVALID_VERSION"));
  }
});
test("payload views exclude shared or malformed bytes and ceilings can only be lowered", async () => {
  for (const maximum of [-1, 0.5, NaN, Infinity, MAX_LINUX_UPDATE_BYTES + 1]) {
    assert.throws(() => verifyLinuxUpdateBytes(Buffer.alloc(0), releaseSignature, "0.2.5", maximum), failure("INVALID_LIMIT"));
    await assert.rejects(verifyLinuxUpdateStream(chunks(), releaseSignature, "0.2.5", maximum), failure("INVALID_LIMIT"));
  }
  for (const payload of [null, [1], new Uint16Array(2), new Uint8Array(new SharedArrayBuffer(2)), new Proxy(new Uint8Array(2), {})]) {
    assert.throws(() => verifyLinuxUpdateBytes(payload as Uint8Array, releaseSignature, "0.2.5"), failure("INVALID_PAYLOAD"));
  }
  assert.throws(() => verifyLinuxUpdateBytes(Buffer.from("test"), releaseSignature, "0.2.5", 3), failure("PAYLOAD_TOO_LARGE"));
  await assert.rejects(verifyLinuxUpdateStream(chunks(Buffer.from("ab"), Buffer.from("cd")), releaseSignature, "0.2.5", 3), failure("PAYLOAD_TOO_LARGE"));
});
test("legacy Ed streaming refuses before consuming caller-owned input", async () => {
  let consumed = false;
  async function* input() { consumed = true; yield Buffer.from("test"); }
  await assert.rejects(verifyLinuxUpdateStream(input(), packetChange(releaseSignature, 1, 0x64), "0.2.5"), failure("UNSUPPORTED_LEGACY_STREAM"));
  assert.equal(consumed, false);
});
test("stream errors stay categorical and overflow closes the acquired iterator", async () => {
  for (const error of [new Error("PRIVATE PATH AND TOKEN"), Object.assign(new LinuxUpdateSignatureError("INVALID_SIGNATURE"), { message: "PRIVATE EXCEPTION" })]) {
    async function* failing() { yield Buffer.from("t"); throw error; }
    await assert.rejects(verifyLinuxUpdateStream(failing(), releaseSignature, "0.2.5"), failure("READ_FAILED"));
  }
  let closed = false;
  async function* excessive() { try { yield Buffer.from("too large"); } finally { closed = true; } }
  await assert.rejects(verifyLinuxUpdateStream(excessive(), releaseSignature, "0.2.5", 1), failure("PAYLOAD_TOO_LARGE"));
  assert.equal(closed, true);
  await assert.rejects(verifyLinuxUpdateStream(chunks(new Uint8Array(new SharedArrayBuffer(1))), releaseSignature, "0.2.5"), failure("INVALID_PAYLOAD"));
  await assert.rejects(verifyLinuxUpdateStream(chunks(), releaseSignature, "0.2.5"), failure("INVALID_SIGNATURE"));
});

const assets = process.env["OPENWHISPER_OWNED_UPDATE_SIGNATURE_ASSETS"], oracle = process.env["OPENWHISPER_OWNED_UPDATE_SIGNATURE_ORACLE"];
const pins = {
  "OpenWhisper-Linux-amd64.deb": "412d06d5475b430fd290c560ea9cd03818b6c471075f064833ebca021313b6cb",
  "OpenWhisper-Linux-amd64.deb.sig": "13032b0a95929f0061f0c596eb6ced59152165418b6f288e414caa8a8ebdff39",
  "OpenWhisper-Linux-x86_64.AppImage": "81ee1be21506a3deb0a5e90846c639e81df766eab728b9970f4af14ef166ffab",
  "OpenWhisper-Linux-x86_64.AppImage.sig": "5994738ed14e8a375ac762bf44f80ba0dc6939a0b672df66f857b60ce158a084",
  "latest.json": "387316f27d23406d2580cdc7cfede721f32a385eadf2ad707a648a321d770224",
  "SHA256SUMS": "8c223aa16a69b75f8c160f6054e0840fc66d0be54cd3621a74c7addedb2318fa",
};
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); return hash.digest("hex");
}
test("explicit owned 0.2.5 Debian and AppImage authenticate under the fixed key with Rust agreement", {
  skip: !assets && !oracle ? "Requires explicit owned asset/oracle paths; no download or network fallback." : false,
}, async () => {
  assert.ok(assets && oracle && isAbsolute(assets) && isAbsolute(oracle));
  const oracleHash = "6908d45153af03dc37c6e4b67b21d9699d2d4c9722c00cd2f711328f5388ba3d";
  assert.equal(await sha256(oracle), oracleHash);
  for (const [name, hash] of Object.entries(pins)) assert.equal(await sha256(join(assets, name)), hash, name);
  const configPath = join(assets, "../../../../linux/src-tauri/tauri.conf.json");
  const config = z.object({ plugins: z.object({ updater: z.object({ pubkey: z.string(), requireSignedVersion: z.literal(true) }) }) }).parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  assert.equal(config.plugins.updater.pubkey, LINUX_UPDATE_PUBLIC_KEY);
  const feed = z.object({ version: z.literal("0.2.5"), platforms: z.record(z.string(), z.object({ signature: z.string() })) }).parse(JSON.parse(await readFile(join(assets, "latest.json"), "utf8")) as unknown);
  for (const [name, target] of [["OpenWhisper-Linux-amd64.deb", "linux-x86_64-deb"], ["OpenWhisper-Linux-x86_64.AppImage", "linux-x86_64-appimage"]]) {
    const path = join(assets, name!), signature = await readFile(`${path}.sig`, "utf8"), bytes = await readFile(path);
    assert.equal(signature, feed.platforms[target!]?.signature);
    if (target === "linux-x86_64-deb") assert.equal(signature, releaseSignature);
    assert.equal(verifyLinuxUpdateBytes(bytes, signature, feed.version), undefined);
    // A nonzero-offset view must authenticate only its supplied bytes.
    const padded = Buffer.concat([Buffer.from([0]), bytes, Buffer.from([0])]);
    assert.equal(verifyLinuxUpdateBytes(padded.subarray(1, -1), signature, feed.version), undefined);
    for (const highWaterMark of [64 * 1024, 777_777]) await verifyLinuxUpdateStream(createReadStream(path, { highWaterMark }), signature, feed.version);
    const native: SpawnSyncReturns<string> = spawnSync(oracle, [configPath, path, `${path}.sig`, feed.version], { encoding: "utf8", timeout: 60_000, maxBuffer: 4096 });
    assert.equal(native.status, 0); assert.equal(native.signal, null); assert.equal(native.stderr, "");
    assert.equal(native.stdout.trim(), "Update signature and version verified.");
    assert.throws(() => verifyLinuxUpdateBytes(bytes, signature, "0.3.1"), failure("SIGNED_VERSION_MISMATCH"));
    assert.throws(() => verifyLinuxUpdateBytes(bytes.subarray(1), signature, feed.version), failure("INVALID_SIGNATURE"));
    assert.throws(() => verifyLinuxUpdateBytes(bytes, packetChange(signature, 1, 0x64), feed.version), failure("INVALID_SIGNATURE"));
    for (const changed of [rewrite(signature, (lines) => { lines[2] += "\tversion:0.3.1"; }),
      rewrite(signature, (lines) => { lines[2] = lines[2]!.replace("version:0.2.5", "version:0.3.1"); }),
      rewrite(signature, (lines) => { lines[2] = lines[2]!.replace("\tversion:0.2.5", ""); }),
      rewrite(signature, (lines) => { const global = Buffer.from(lines[3]!, "base64"); global[0] = global[0]! ^ 1; lines[3] = global.toString("base64"); })]) {
      assert.throws(() => verifyLinuxUpdateBytes(bytes, changed, feed.version), failure("INVALID_SIGNATURE"));
    }
    const once = chunks(bytes);
    await verifyLinuxUpdateStream(once, signature, feed.version);
    await assert.rejects(verifyLinuxUpdateStream(once, signature, feed.version), failure("INVALID_SIGNATURE"));
  }
  for (const [name, hash] of Object.entries(pins)) assert.equal(await sha256(join(assets, name)), hash, name);
  assert.equal(await sha256(oracle), oracleHash);
});

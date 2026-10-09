import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LinuxUpdateFileError, verifyOwnedLinuxUpdateFile } from "../../../src/services/update/linux/linux-update-file.js";
import type { OwnedLinuxUpdateFile } from "../../../src/services/update/linux/linux-update-file.js";
import { LinuxUpdateSignatureError, MAX_LINUX_UPDATE_BYTES } from "../../../src/services/update/linux/linux-update-signature.js";

const linuxTest = process.platform === "linux" ? test : test.skip;
const artifactName = "OpenWhisper-Linux-amd64.deb";
const legacyConfigPath = fileURLToPath(new URL("../../fixtures/legacy-linux/tauri.conf.json", import.meta.url));
const legacyConfigSha256 = "2d901a9a06e9844697fab1ef3da0f2d44315254d3ab5bf9045066b9bdc743731";
// The original public envelope is not a signature for the small fault-test files.
const signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTSUsxODJ0WHltd1NSQ1VqNWY4dzlHNi9PTHZsWFNIbEFtdS9FZDZqWnFhRVZqQ29WMVoycmJEWlljNS9qMi9sUERLWCtqL25UclZYbEhQQWVNWEZseFF0NmowYktweEFZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNDEwNTQwCWZpbGU6T3BlbldoaXNwZXItTGludXgtYW1kNjQuZGViCXZlcnNpb246MC4yLjUKQysxdTllc3FxSnBZWVY1YXRGWTlVTXlJZ0hEUHZSRk94TkVvQTRzYm56YTF3MWFLaGdhVU5sQkhrQ2hraUVNcXNZRTQ3Mlhhd0xMeTRpMzd1OTd3QkE9PQo=";
const fileFailure = (code: string) => (error: unknown): boolean => error instanceof LinuxUpdateFileError && error.code === code && error.message === code;
const signatureFailure = (code: string) => (error: unknown): boolean => error instanceof LinuxUpdateSignatureError && error.code === code && error.message === code;
async function fixture(bytes = Buffer.from("test"), name: OwnedLinuxUpdateFile["artifactName"] = artifactName) {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-update-file-")), stageDirectory = join(root, "stage");
  await mkdir(stageDirectory, { mode: 0o700 });
  const path = join(stageDirectory, name), file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  // Positioned fixture writes leave the original descriptor's implicit read position at zero.
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(bytes, written, bytes.length - written, written);
    assert.ok(result.bytesWritten > 0); written += result.bytesWritten;
  }
  await file.sync();
  return { root, path, file, input: { file, stageDirectory, artifactName: name, signature, version: "0.2.5" } satisfies OwnedLinuxUpdateFile };
}

linuxTest("unauthenticated small files refuse without closing or deleting the caller's original handle", async () => {
  const f = await fixture(), close = f.file.close.bind(f.file); let closes = 0;
  f.file.close = async () => { closes++; await close(); };
  try {
    await assert.rejects(verifyOwnedLinuxUpdateFile(f.input), signatureFailure("INVALID_SIGNATURE"));
    assert.equal(closes, 0); assert.equal((await f.file.stat()).size, 4);
    assert.equal(await readFile(f.path, "utf8"), "test");
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
  assert.equal(closes, 1);
});
linuxTest("file admission requires canonical private stage paths and literal artifact names", async () => {
  const f = await fixture();
  try {
    for (const stageDirectory of ["relative", `${f.input.stageDirectory}/../stage`, `${f.input.stageDirectory}\0`]) {
      await assert.rejects(verifyOwnedLinuxUpdateFile({ ...f.input, stageDirectory }), fileFailure("INVALID_INPUT"));
    }
    await assert.rejects(verifyOwnedLinuxUpdateFile({ ...f.input, artifactName: "../escape" as OwnedLinuxUpdateFile["artifactName"] }), fileFailure("INVALID_INPUT"));
    const alias = join(f.root, "alias"); await symlink(f.input.stageDirectory, alias);
    await assert.rejects(verifyOwnedLinuxUpdateFile({ ...f.input, stageDirectory: alias }), fileFailure("UNSAFE_STAGING"));
    await chmod(f.input.stageDirectory, 0o755);
    await assert.rejects(verifyOwnedLinuxUpdateFile(f.input), fileFailure("UNSAFE_STAGING"));
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
linuxTest("file admission refuses writable modes, multiple links and symlink replacement", async () => {
  for (const variant of ["mode", "hardlink", "symlink"] as const) {
    const f = await fixture();
    try {
      if (variant === "mode") await chmod(f.path, 0o644);
      else if (variant === "hardlink") await link(f.path, join(f.root, "second-link"));
      else { await unlink(f.path); await writeFile(join(f.root, "target"), "owned replacement", { mode: 0o600 }); await symlink(join(f.root, "target"), f.path); }
      await assert.rejects(verifyOwnedLinuxUpdateFile(f.input), fileFailure("UNSAFE_STAGING"));
      assert.ok((await f.file.stat()).isFile());
      if (variant === "symlink") assert.equal(await readFile(join(f.root, "target"), "utf8"), "owned replacement");
    } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});
linuxTest("original handle and named file must agree before any read", async () => {
  const f = await fixture();
  try {
    await rename(f.path, join(f.input.stageDirectory, "original"));
    await writeFile(f.path, "test", { mode: 0o600 });
    await assert.rejects(verifyOwnedLinuxUpdateFile(f.input), fileFailure("FILE_CHANGED"));
    assert.equal(await readFile(f.path, "utf8"), "test");
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
linuxTest("file ceilings can only be lowered and overflow refuses before reading", async () => {
  const f = await fixture(); let reads = 0;
  const read = f.file.read.bind(f.file);
  f.file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => { reads++; return read(buffer, offset, length, position); }) as FileHandle["read"];
  try {
    for (const maximumBytes of [-1, 0.5, NaN, Infinity, MAX_LINUX_UPDATE_BYTES + 1]) {
      await assert.rejects(verifyOwnedLinuxUpdateFile({ ...f.input, maximumBytes }), fileFailure("INVALID_INPUT"));
    }
    await assert.rejects(verifyOwnedLinuxUpdateFile({ ...f.input, maximumBytes: 3 }), fileFailure("PAYLOAD_TOO_LARGE"));
    assert.equal(reads, 0);
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
linuxTest("read failures stay categorical while the original descriptor remains caller-owned", async () => {
  const f = await fixture();
  f.file.read = (async () => { throw new Error("PRIVATE PATH AND TOKEN"); }) as FileHandle["read"];
  try {
    await assert.rejects(verifyOwnedLinuxUpdateFile(f.input), fileFailure("READ_FAILED"));
    assert.ok((await f.file.stat()).isFile());
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
});
linuxTest("premature EOF and invalid read counts cannot authenticate a file", async () => {
  for (const count of [0, -1, 0.5, 65_537, NaN]) {
    const f = await fixture();
    f.file.read = (async (buffer: Buffer) => ({ buffer, bytesRead: count })) as FileHandle["read"];
    try { await assert.rejects(verifyOwnedLinuxUpdateFile(f.input), fileFailure("FILE_CHANGED")); }
    finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});
linuxTest("changes during reading refuse same-size rewrite, truncation, growth, modes and pathname swaps", async () => {
  for (const change of ["rewrite", "truncate", "grow", "mode", "path", "directory"] as const) {
    const f = await fixture(), read = f.file.read.bind(f.file); let changed = false;
    // Host-only perturbation: actual reads still use the same real original descriptor.
    f.file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      if (!changed) {
        changed = true;
        if (change === "rewrite") await f.file.write(Buffer.from("Test"), 0, 4, 0);
        else if (change === "truncate") await f.file.truncate(2);
        else if (change === "grow") await f.file.write(Buffer.from("!"), 0, 1, 4);
        else if (change === "mode") await f.file.chmod(0o644);
        else if (change === "path") { await rename(f.path, join(f.input.stageDirectory, "original")); await writeFile(f.path, "replacement", { mode: 0o600 }); }
        else { await rename(f.input.stageDirectory, `${f.input.stageDirectory}-original`); await mkdir(f.input.stageDirectory, { mode: 0o700 }); await writeFile(f.path, "replacement", { mode: 0o600 }); }
      }
      return result;
    }) as FileHandle["read"];
    try {
      await assert.rejects(verifyOwnedLinuxUpdateFile(f.input), fileFailure("FILE_CHANGED"));
      assert.ok((await f.file.stat()).isFile());
      if (change === "path" || change === "directory") assert.equal(await readFile(f.path, "utf8"), "replacement");
    } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});
linuxTest("legacy Ed file streaming refuses before consuming the original descriptor", async () => {
  const f = await fixture(); let reads = 0;
  f.file.read = (async () => { reads++; throw new Error("Must not read legacy Ed"); }) as FileHandle["read"];
  const lines = Buffer.from(signature, "base64").toString("utf8").split("\n"), packet = Buffer.from(lines[1]!, "base64");
  packet[1] = 0x64; lines[1] = packet.toString("base64");
  try {
    await assert.rejects(verifyOwnedLinuxUpdateFile({ ...f.input, signature: Buffer.from(lines.join("\n")).toString("base64") }), signatureFailure("UNSUPPORTED_LEGACY_STREAM"));
    assert.equal(reads, 0);
  } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
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
linuxTest("explicit owned original 0.2.5 private files authenticate with live handles, partial reads and Rust agreement", {
  skip: !assets && !oracle ? "Requires explicit owned cached assets/oracle; no network fallback." : false,
}, async () => {
  assert.ok(assets && oracle && isAbsolute(assets) && isAbsolute(oracle));
  const oracleHash = "6908d45153af03dc37c6e4b67b21d9699d2d4c9722c00cd2f711328f5388ba3d";
  assert.equal(await sha256(oracle), oracleHash);
  assert.equal(await sha256(legacyConfigPath), legacyConfigSha256);
  for (const [name, hash] of Object.entries(pins)) assert.equal(await sha256(join(assets, name)), hash);
  for (const name of [artifactName, "OpenWhisper-Linux-x86_64.AppImage"] as const) {
    const original = join(assets, name), bytes = await readFile(original), f = await fixture(bytes, name);
    try {
      const publicSignature = await readFile(`${original}.sig`, "utf8");
      if (name === artifactName) assert.equal(publicSignature, signature);
      await f.file.read(Buffer.alloc(3), 0, 3, null);
      const receipt = await verifyOwnedLinuxUpdateFile({ ...f.input, signature: publicSignature });
      assert.deepEqual(receipt, { bytes: bytes.length, version: "0.2.5" }); assert.ok(Object.isFrozen(receipt));
      const next = Buffer.alloc(3); await f.file.read(next, 0, 3, null); assert.deepEqual(next, bytes.subarray(3, 6));
      assert.equal((await f.file.stat()).size, bytes.length); assert.equal((await lstat(f.path)).nlink, 1);
      const native: SpawnSyncReturns<string> = spawnSync(oracle, [legacyConfigPath, f.path, `${original}.sig`, "0.2.5"], { encoding: "utf8", timeout: 60_000, maxBuffer: 4096 });
      assert.equal(native.status, 0); assert.equal(native.signal, null); assert.equal(native.stderr, "");
      assert.equal(native.stdout.trim(), "Update signature and version verified.");
      if (name === artifactName) {
        const read = f.file.read.bind(f.file);
        f.file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => read(buffer, offset, Math.min(length, 4093), position)) as FileHandle["read"];
        assert.deepEqual(await verifyOwnedLinuxUpdateFile({ ...f.input, signature: publicSignature }), receipt);
      }
    } finally { await f.file.close(); await rm(f.root, { recursive: true, force: true }); }
  }
  for (const [name, hash] of Object.entries(pins)) assert.equal(await sha256(join(assets, name)), hash);
  assert.equal(await sha256(oracle), oracleHash);
});

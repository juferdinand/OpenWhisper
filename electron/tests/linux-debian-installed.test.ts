import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, existsSync, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { Header, Pax, type HeaderData } from "tar";
import { DebianInstalledAuditError, DEBIAN_AUDIT_LIMITS, inspectDebianDataTar, inspectDebianFileBytes,
  assertCanonicalInstalledDebianVersion, prepareDebianInstalledAudit, validateDebianInstalledMetadata } from "../src/services/linux-debian-installed.js";
import { LinuxUpdateSignatureError } from "../src/services/linux-update-signature.js";
import { retainOwnedUpdateDownload } from "../src/services/update-staging.js";
import { parseOwnedSignedDebianArguments } from "./owned-signed-debian.js";

test("Owned signed Debian roles require exact argument selectors and canonical absolute paths", () => {
  assert.equal(parseOwnedSignedDebianArguments(["capture", "--candidate", "/owned/candidate"]).mode, "capture");
  for (const mode of ["admit", "verify"]) {
    assert.deepEqual(parseOwnedSignedDebianArguments([mode, "--candidate", "/owned/candidate", "--tools", "/owned/tools", "--evidence", "/owned/evidence"]),
      { mode, candidate: "/owned/candidate", tools: "/owned/tools", evidence: "/owned/evidence" });
  }
  for (const mode of ["embedded-verify", "audit", "audit-mismatch", "audit-mutation"]) {
    assert.equal(parseOwnedSignedDebianArguments([mode, "--candidate", "/owned/candidate", "--evidence", "/owned/evidence"]).mode, mode);
  }
  for (const args of [["other", "--candidate", "/owned/candidate"], ["capture", "--candidate", "relative"],
    ["capture", "--candidate", "/owned/../candidate"], ["capture", "--candidate", "/owned/candidate\0"],
    ["capture", "--candidate", "/owned/candidate", "--evidence", "/owned/evidence"],
    ["audit", "--tools", "/owned/candidate", "--evidence", "/owned/evidence"],
    ["verify", "--candidate", "/owned/candidate", "--evidence", "/owned/tools", "--tools", "/owned/evidence"]]) {
    assert.throws(() => parseOwnedSignedDebianArguments(args));
  }
});

const failure = (code: DebianInstalledAuditError["code"]) => (error: unknown): boolean =>
  error instanceof DebianInstalledAuditError && error.code === code && error.message === code;

test("Current Debian admission refuses preview and noncanonical versions before invoking system tools", async () => {
  for (const version of ["0.3.0~dev.abcd", "v0.3.0", "0.3", "0.03.0", "18446744073709551616.0.0", "0.3.0\n"]) {
    await assert.rejects(assertCanonicalInstalledDebianVersion(version), failure("INVALID_INPUT"));
  }
});

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function member(path: string, body = Buffer.alloc(0), values: HeaderData = {}): Buffer {
  const header = new Header({ path, type: "File", mode: 0o644, uid: 0, gid: 0, size: body.length, ...values });
  const block = Buffer.alloc(512); header.encode(block);
  return Buffer.concat([block, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}
function tar(...members: Buffer[]): Buffer { return Buffer.concat([...members, Buffer.alloc(1024)]); }
async function* split(bytes: Buffer, size = 37): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

test("Unauthenticated inventory hashes split file bodies and treats ASAR-shaped bytes as ordinary data", async () => {
  const bytes = Buffer.from("ASAR-shaped physical bytes\0unchanged");
  const raw = tar(member("./opt", undefined, { type: "Directory", mode: 0o755 }),
    member("./opt/openwhisper", undefined, { type: "Directory", mode: 0o755 }), member("./opt/openwhisper/resources/default_app.asar", bytes));
  const inventory = await inspectDebianDataTar(split(raw, 7));
  assert.ok(Object.isFrozen(inventory)); assert.ok(Object.isFrozen(inventory.entries));
  assert.deepEqual(inventory.entries[2], { path: "opt/openwhisper/resources/default_app.asar", type: "file", mode: 0o644,
    bytes: bytes.length, sha256: digest(bytes) });
  assert.equal(inventory.bytes, bytes.length);
});

test("Bounded GNU next-file long names are decoded by the maintained parser", async () => {
  const path = `opt/openwhisper/${"directory/".repeat(14)}file.txt`, data = Buffer.from("owned fixture");
  const raw = tar(member("././@LongLink", Buffer.from(`${path}\0`), { type: "NextFileHasLongPath" }), member("placeholder", data));
  assert.equal((await inspectDebianDataTar(split(raw, 4096))).entries[0]?.path, path);
  const dangling = tar(member("././@LongLink", Buffer.from(`${path}\0`), { type: "NextFileHasLongPath" }));
  await assert.rejects(inspectDebianDataTar(split(dangling)), failure("INVALID_ARCHIVE"));
});

test("Invalid checksums, truncation, ignored types, links and trailing archives never yield an inventory", async () => {
  const valid = tar(member("opt/openwhisper/a", Buffer.from("body")));
  const checksum = Buffer.from(valid); checksum[0] = checksum[0]! ^ 1;
  for (const bytes of [checksum, valid.subarray(0, 600), valid.subarray(0, -512), Buffer.concat([valid, valid]),
    Buffer.concat([valid, Buffer.from("trailing")]), tar(member("opt/openwhisper/a", undefined, { type: "Inode" })),
    tar(member("opt/openwhisper/a", undefined, { type: "SymbolicLink", linkpath: "a" })),
    tar(member("opt/openwhisper/a", undefined, { type: "Link", linkpath: "a" })),
    tar(member("opt/openwhisper/a", undefined, { type: "FIFO" }))]) {
    await assert.rejects(inspectDebianDataTar(split(bytes)), failure("INVALID_ARCHIVE"));
  }
});

test("Paths, aliases, duplicate members and file-directory collisions refuse before admission", async () => {
  for (const path of ["/opt/openwhisper/a", "opt/openwhisper/../a", "opt//openwhisper/a", "opt/openwhisper/a\nb", "../opt/openwhisper/a", "etc/foreign"]) {
    await assert.rejects(inspectDebianDataTar(split(tar(member(path)))), DebianInstalledAuditError);
  }
  for (const raw of [tar(member("opt/openwhisper/a"), member("./opt/openwhisper/a")),
    tar(member("opt/openwhisper/a"), member("opt/openwhisper/a/b"))]) {
    await assert.rejects(inspectDebianDataTar(split(raw)), failure("INVALID_ARCHIVE"));
  }
});

test("Archive owners, writable or privileged modes, body ceilings and unsafe PAX metadata refuse", async () => {
  for (const values of [{ uid: 1000 }, { gid: 1000 }, { mode: 0o666 }, { mode: 0o4755 }, { size: DEBIAN_AUDIT_LIMITS.bytes + 1 }]) {
    await assert.rejects(inspectDebianDataTar(split(tar(member("opt/openwhisper/a", undefined, values)))), DebianInstalledAuditError);
  }
  for (const pax of [new Pax({ path: "opt/openwhisper/a", mode: 0o4755 }).encode(),
    member("pax", Buffer.from("29 SCHILY.xattr.security.capability=bad\n"), { type: "ExtendedHeader" })]) {
    await assert.rejects(inspectDebianDataTar(split(tar(pax, member("opt/openwhisper/a")))), failure("INVALID_ARCHIVE"));
  }
  const oversizedMeta = member("././@LongLink", Buffer.alloc(DEBIAN_AUDIT_LIMITS.metadataBytes + 1, 0x61), { type: "NextFileHasLongPath" });
  await assert.rejects(inspectDebianDataTar(split(tar(oversizedMeta))), failure("INVALID_ARCHIVE"));
});

test("Entry and metadata limits are hard bounds", async () => {
  const repeated = Array.from({ length: DEBIAN_AUDIT_LIMITS.entries + 1 }, (_, index) => member(`opt/openwhisper/f${index}`));
  await assert.rejects(inspectDebianDataTar(split(tar(...repeated), 64 * 1024)), failure("LIMIT_EXCEEDED"));
  const tooDeep = `opt/openwhisper/${"d/".repeat(DEBIAN_AUDIT_LIMITS.depth)}file`;
  await assert.rejects(inspectDebianDataTar(split(tar(member("././@LongLink", Buffer.from(`${tooDeep}\0`),
    { type: "NextFileHasLongPath" }), member("placeholder")))), failure("INVALID_ARCHIVE"));
});

test("Cancellation waits the original pending source read and its finally settlement", async () => {
  const controller = new AbortController(); let entered!: () => void, release!: () => void, returned = false, settled = false;
  const started = new Promise<void>((accept) => { entered = accept; }), gate = new Promise<void>((accept) => { release = accept; });
  async function* source() {
    try { yield member("opt/openwhisper/a", Buffer.from("body")).subarray(0, 512); entered(); await gate; yield Buffer.alloc(1024); }
    finally { returned = true; }
  }
  const original = inspectDebianDataTar(source(), controller.signal); void original.finally(() => { settled = true; }).catch(() => {});
  try {
    await started; controller.abort("private reason"); await new Promise<void>((accept) => setImmediate(accept));
    assert.equal(settled, false); assert.equal(returned, false); release();
    await assert.rejects(original, failure("CANCELED")); assert.equal(returned, true);
  } finally { release(); await original.catch(() => {}); }
});

test("Invalid inventory waits the original source return rather than releasing it on parser failure", async () => {
  let entered!: () => void, release!: () => void, returned = false, settled = false;
  const started = new Promise<void>((accept) => { entered = accept; }), gate = new Promise<void>((accept) => { release = accept; });
  async function* source() {
    try { yield member("etc/foreign"); }
    finally { entered(); await gate; returned = true; }
  }
  const original = inspectDebianDataTar(source()); void original.finally(() => { settled = true; }).catch(() => {});
  try {
    await started; assert.equal(settled, false); release(); await assert.rejects(original, failure("INVALID_LAYOUT")); assert.equal(returned, true);
  } finally { release(); await original.catch(() => {}); }
});

test("Original source errors and already canceled requests refuse with categorical failures", async () => {
  async function* failed() { yield Buffer.alloc(17); throw new Error("private source detail"); }
  await assert.rejects(inspectDebianDataTar(failed()), failure("INVALID_ARCHIVE"));
  const controller = new AbortController(); controller.abort(); let consumed = false;
  async function* untouched() { consumed = true; yield Buffer.alloc(0); }
  await assert.rejects(inspectDebianDataTar(untouched(), controller.signal), failure("CANCELED")); assert.equal(consumed, false);
});

async function fileFixture() {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-debian-audit-")), path = join(root, "physical.asar"), bytes = Buffer.from("owned bytes");
  await writeFile(path, bytes, { mode: 0o644 }); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  return { root, path, bytes, file, expected: { bytes: bytes.length, sha256: digest(bytes) },
    async cleanup() { await file.close(); await rm(root, { recursive: true, force: true }); } };
}
test("Borrowed physical-file comparison preserves the original handle and refuses changed bytes, paths, modes and links", async () => {
  for (const change of ["none", "bytes", "path", "mode", "link"] as const) {
    const f = await fileFixture();
    try {
      if (change === "none") { await inspectDebianFileBytes(f.file, f.path, f.expected); assert.ok((await f.file.stat()).isFile()); continue; }
      let first = true;
      const reading = { stat: f.file.stat.bind(f.file), async read(buffer: Buffer, offset: number, length: number, position: number) {
        const result = await f.file.read(buffer, offset, length, position);
        if (first) { first = false;
          if (change === "bytes") await writeFile(f.path, "changed!!!");
          if (change === "path") { await rename(f.path, `${f.path}.original`); await writeFile(f.path, f.bytes); }
          if (change === "mode") await chmod(f.path, 0o600);
          if (change === "link") await link(f.path, `${f.path}.link`);
        }
        return result;
      } };
      await assert.rejects(inspectDebianFileBytes(reading, f.path, f.expected), failure("INSTALLED_MISMATCH"));
      assert.ok((await f.file.stat()).isFile());
    } finally { await f.cleanup(); }
  }
});

test("Root ownership policy uses labeled synthetic stats; owned user files never establish installation admission", async () => {
  const f = await fileFixture();
  try {
    const actual = await lstat(f.path, { bigint: true }), expected = { path: "opt/openwhisper/a", type: "file" as const, mode: 0o644, ...f.expected };
    const synthetic = (changes: Partial<BigIntStats>): BigIntStats => Object.assign(Object.create(Object.getPrototypeOf(actual)) as BigIntStats, actual, { uid: 0n, gid: 0n }, changes);
    validateDebianInstalledMetadata(synthetic({}), expected);
    for (const changes of [{ uid: 1000n }, { gid: 1000n }, { nlink: 2n }, { mode: 0o100666n }, { size: actual.size + 1n }]) {
      assert.throws(() => validateDebianInstalledMetadata(synthetic(changes), expected), failure("INSTALLED_MISMATCH"));
    }
    // Final observations compare identity/timestamps, even when the same length and permissions remain.
    const original = synthetic({}); validateDebianInstalledMetadata(synthetic({}), expected, original);
    for (const changes of [{ dev: actual.dev + 1n }, { ino: actual.ino + 1n },
      { mtimeNs: actual.mtimeNs + 1n }, { ctimeNs: actual.ctimeNs + 1n }]) {
      assert.throws(() => validateDebianInstalledMetadata(synthetic(changes), expected, original), failure("INSTALLED_MISMATCH"));
    }
    const directory = synthetic({ mode: 0o40755n }), expectedDirectory = { path: "opt/openwhisper", type: "directory" as const, mode: 0o755, bytes: 0 };
    validateDebianInstalledMetadata(directory, expectedDirectory, directory);
    assert.throws(() => validateDebianInstalledMetadata(synthetic({ mode: 0o40755n, size: actual.size + 1n }),
      expectedDirectory, directory), failure("INSTALLED_MISMATCH"));
    if (process.getuid?.() !== 0) assert.throws(() => validateDebianInstalledMetadata(actual, expected), failure("INSTALLED_MISMATCH"));
  } finally { await f.cleanup(); }
});

test("Unsigned packages cannot create an authenticated installed-audit closure or consume their borrowed source", {
  skip: process.platform !== "linux" || process.arch !== "x64" || !process.getuid?.(),
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-debian-unauthenticated-")), stageDirectory = join(root, "stage");
  await mkdir(stageDirectory, { mode: 0o700 });
  const file = await open(join(stageDirectory, "OpenWhisper-Linux-amd64.deb"), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await file.write(Buffer.from("unsigned"), 0, 8, 0); const download = await retainOwnedUpdateDownload({ file, stageDirectory, artifactName: "OpenWhisper-Linux-amd64.deb" });
  try {
    await assert.rejects(prepareDebianInstalledAudit({ download, signature: "", expectedVersion: "0.2.5" }), LinuxUpdateSignatureError);
    const fields = { download, signature: "", expectedVersion: "0.2.5", signal: new AbortController().signal };
    const reads = { download: 0, signature: 0, expectedVersion: 0, signal: 0 };
    const preparation = prepareDebianInstalledAudit({
      get download() { reads.download++; return fields.download; }, get signature() { reads.signature++; return fields.signature; },
      get expectedVersion() { reads.expectedVersion++; return fields.expectedVersion; }, get signal() { reads.signal++; return fields.signal; },
    });
    fields.expectedVersion = "changed after entry"; fields.signature = "changed after entry";
    fields.download = { ...download, artifactName: "OpenWhisper-macOS.zip" }; fields.signal = AbortSignal.abort("private changed signal");
    await assert.rejects(preparation, LinuxUpdateSignatureError);
    assert.deepEqual(reads, { download: 1, signature: 1, expectedVersion: 1, signal: 1 });
    await download.assertUnchanged(); assert.equal((await file.stat()).size, 8); assert.equal(await readFile(join(stageDirectory, download.artifactName), "utf8"), "unsigned");
  } finally { await download.cleanup(); await rm(root, { recursive: true, force: true }); }
});


test("Borrowed partial reads and cancellation await the original read without closing its handle", async () => {
  const f = await fileFixture(), controller = new AbortController();
  try {
    const partial = { stat: f.file.stat.bind(f.file), read: (buffer: Buffer, offset: number, length: number, position: number) =>
      f.file.read(buffer, offset, Math.min(length, 2), position) };
    await inspectDebianFileBytes(partial, f.path, f.expected);
    let entered!: () => void, release!: () => void, settled = false;
    const started = new Promise<void>((accept) => { entered = accept; }), gate = new Promise<void>((accept) => { release = accept; });
    const reading = { stat: f.file.stat.bind(f.file), async read(buffer: Buffer, offset: number, length: number, position: number) {
      entered(); await gate; return f.file.read(buffer, offset, length, position);
    } };
    const original = inspectDebianFileBytes(reading, f.path, f.expected, controller.signal);
    void original.finally(() => { settled = true; }).catch(() => {});
    try {
      await started; controller.abort(); await new Promise<void>((accept) => setImmediate(accept)); assert.equal(settled, false);
      release(); await assert.rejects(original, failure("CANCELED")); assert.ok((await f.file.stat()).isFile());
    } finally { release(); await original.catch(() => {}); }
    const readFailure = { stat: f.file.stat.bind(f.file), async read() { throw new Error("owned read failure"); } };
    await assert.rejects(inspectDebianFileBytes(readFailure, f.path, f.expected)); assert.ok((await f.file.stat()).isFile());
  } finally { await f.cleanup(); }
});

const assets = process.env["OPENWHISPER_OWNED_UPDATE_SIGNATURE_ASSETS"];
test("Original signed 0.2.5 Debian source refuses its native launcher exceeding the bounded Electron literal inventory", {
  skip: !assets || process.platform !== "linux" || process.arch !== "x64" || !process.getuid?.()
    ? "Requires explicit pinned cached signed 0.2.5 archive; no download, installation or execution fallback."
    : !existsSync("/usr/bin/dpkg-deb") ? "Requires the actual Debian metadata tool; no host installation fallback." : false,
}, async () => {
  assert.ok(assets && isAbsolute(assets));
  const artifactName = "OpenWhisper-Linux-amd64.deb", bytes = await readFile(join(assets, artifactName));
  const signature = await readFile(join(assets, `${artifactName}.sig`), "utf8");
  assert.equal(bytes.length, 21_152_538);
  assert.equal(digest(bytes), "412d06d5475b430fd290c560ea9cd03818b6c471075f064833ebca021313b6cb");
  assert.equal(digest(Buffer.from(signature)), "13032b0a95929f0061f0c596eb6ced59152165418b6f288e414caa8a8ebdff39");
  const root = await mkdtemp(join(tmpdir(), "openwhisper-debian-original-")), stageDirectory = join(root, "stage");
  await mkdir(stageDirectory, { mode: 0o700 });
  const file = await open(join(stageDirectory, artifactName), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let download: Awaited<ReturnType<typeof retainOwnedUpdateDownload>> | undefined;
  try {
    let position = 0;
    while (position < bytes.length) { const result = await file.write(bytes, position, bytes.length - position, position); assert.ok(result.bytesWritten > 0); position += result.bytesWritten; }
    await file.sync(); download = await retainOwnedUpdateDownload({ file, stageDirectory, artifactName });
    await assert.rejects(prepareDebianInstalledAudit({ download, signature, expectedVersion: "0.2.5" }), failure("LIMIT_EXCEEDED"));
    await download.assertUnchanged(); assert.ok((await file.stat()).isFile());
  } finally { if (download) await download.cleanup(); else await file.close(); await rm(root, { recursive: true, force: true }); }
});

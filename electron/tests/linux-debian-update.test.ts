import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { LinuxDebianUpdateError, prepareDebianUpdate, validateDebianUpdateMetadata } from "../src/services/linux-debian-update.js";
import { LinuxUpdateSignatureError } from "../src/services/linux-update-signature.js";
import { retainOwnedUpdateDownload } from "../src/services/update-staging.js";

const supported = process.platform === "linux" && process.arch === "x64" && process.getuid?.() !== 0;
const artifactName = "OpenWhisper-Linux-amd64.deb";
const valid = "io-github-whisperfree\n0.2.5\namd64\n";
const failure = (code: LinuxDebianUpdateError["code"]) => (error: unknown): boolean =>
  error instanceof LinuxDebianUpdateError && error.code === code && error.message === code;

test("Debian metadata requires the exact persistent package, canonical signed version and amd64 architecture", () => {
  validateDebianUpdateMetadata(valid, "0.2.5");
  for (const output of [valid.replace("io-github-whisperfree", "openwhisper"), valid.replace("amd64", "arm64"),
    valid.replace("0.2.5", "0.2.6"), valid.replace("\n", "\r\n"), valid.trimEnd(), `${valid}\n`, ` ${valid}`,
    `${valid}private diagnostic`, null, {}, Buffer.from(valid)]) {
    assert.throws(() => validateDebianUpdateMetadata(output, "0.2.5"), failure("INVALID_PACKAGE"));
  }
  for (const version of ["v0.2.5", "00.2.5", "0.2.5-1", "18446744073709551616.0.0", null]) {
    assert.throws(() => validateDebianUpdateMetadata(valid, version), failure("INVALID_INPUT"));
  }
});

async function fixture(bytes = Buffer.from("unsigned private test")) {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-debian-update-")), stageDirectory = join(root, "stage");
  await mkdir(stageDirectory, { mode: 0o700 });
  const path = join(stageDirectory, artifactName), file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let position = 0;
  while (position < bytes.length) {
    const { bytesWritten } = await file.write(bytes, position, bytes.length - position, position);
    assert.ok(bytesWritten > 0); position += bytesWritten;
  }
  await file.sync();
  const download = await retainOwnedUpdateDownload({ file, stageDirectory, artifactName });
  return { root, path, download, input: { download, signature: "", expectedVersion: "0.2.5", currentVersion: "0.2.4" },
    async cleanup() { await download.cleanup().catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

test("Unsigned files refuse before metadata or elevation and remain owned by their original caller", { skip: !supported }, async () => {
  const f = await fixture(); let metadata = 0, install = 0;
  try {
    await assert.rejects(prepareDebianUpdate(f.input, {
      async metadata() { metadata++; return valid; }, async install() { install++; return 0; },
    }), LinuxUpdateSignatureError);
    assert.equal(metadata, 0); assert.equal(install, 0); assert.equal(await readFile(f.path, "utf8"), "unsigned private test");
    assert.equal((await f.download.file.stat()).size, f.download.bytes);
    for (const currentVersion of ["0.2.5", "0.3.0", "invalid"]) {
      await assert.rejects(prepareDebianUpdate({ ...f.input, currentVersion }), failure("INVALID_INPUT"));
    }
  } finally { await f.cleanup(); }
});

const assets = process.env["OPENWHISPER_OWNED_UPDATE_SIGNATURE_ASSETS"];
const ownedOptions = { skip: !supported || !assets ? "Requires explicit existing original 0.2.5 assets; no network or installation fallback." : false };
async function originalFixture() {
  assert.ok(assets && isAbsolute(assets));
  const bytes = await readFile(join(assets, artifactName)), signature = await readFile(join(assets, `${artifactName}.sig`), "utf8");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "412d06d5475b430fd290c560ea9cd03818b6c471075f064833ebca021313b6cb");
  assert.equal(createHash("sha256").update(signature).digest("hex"), "13032b0a95929f0061f0c596eb6ced59152165418b6f288e414caa8a8ebdff39");
  const f = await fixture(bytes); return { ...f, input: { ...f.input, signature } };
}

test("Original signed Debian bytes pass real inherited-descriptor metadata without invoking an installer", {
  skip: ownedOptions.skip || (!existsSync("/usr/bin/dpkg-deb") ? "Requires the actual Debian metadata tool; no host installation fallback." : false),
}, async () => {
  const f = await originalFixture(); let installs = 0;
  try {
    const prepared = await prepareDebianUpdate(f.input, { async install() { installs++; throw new Error("must remain inactive"); } });
    assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.version, "0.2.5"); assert.equal(prepared.bytes, 21_152_538);
    await prepared.assertUnchanged(); assert.equal(installs, 0);
    const start = Buffer.alloc(8); await f.download.file.read(start, 0, start.length, null);
    assert.equal(start.toString("ascii"), "!<arch>\n");
    await f.download.cleanup();
    await assert.rejects(f.download.file.stat()); await assert.rejects(readFile(f.path));
  } finally { await f.cleanup(); }
});

test("Authenticated metadata mismatches and tool failures cannot invoke elevation", ownedOptions, async () => {
  const f = await originalFixture(); let installs = 0;
  try {
    for (const metadata of [valid.replace("0.2.5", "0.3.0"), valid.replace("amd64", "arm64"), valid.replace("io-github-whisperfree", "other")]) {
      await assert.rejects(prepareDebianUpdate(f.input, { async metadata() { return metadata; }, async install() { installs++; return 0; } }), failure("INVALID_PACKAGE"));
    }
    await assert.rejects(prepareDebianUpdate(f.input, { async metadata() { throw new Error("private package diagnostic"); } }), failure("METADATA_FAILED"));
    assert.equal(installs, 0);
  } finally { await f.cleanup(); }
});

test("A changed original pathname after preparation prevents installation", ownedOptions, async () => {
  const f = await originalFixture(); let installs = 0;
  try {
    const prepared = await prepareDebianUpdate(f.input, { async metadata() { return valid; }, async install() { installs++; return 0; } });
    await rename(f.path, `${f.path}.original`); await writeFile(f.path, "replacement", { mode: 0o600 });
    await assert.rejects(prepared.install(), failure("SOURCE_CHANGED")); assert.equal(installs, 0);
    assert.equal(await readFile(f.path, "utf8"), "replacement");
  } finally { await f.cleanup(); }
});

test("One original elevation settles before success and repeated calls cannot start another transaction", ownedOptions, async () => {
  const f = await originalFixture(); let installs = 0, settle!: (code: number) => void;
  try {
    const original = new Promise<number>((resolve) => { settle = resolve; });
    const prepared = await prepareDebianUpdate(f.input, { async metadata() { return valid; }, async install(path) { installs++; assert.equal(path, f.path); return original; } });
    let completed = false; const first = prepared.install(); void first.then(() => { completed = true; });
    assert.equal(prepared.install(), first);
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    assert.equal(installs, 1); assert.equal(completed, false); assert.ok((await f.download.file.stat()).isFile());
    settle(0); await first; assert.equal(completed, true); await prepared.install(); assert.equal(installs, 1);
  } finally { await f.cleanup(); }
});

test("Cancelled or failed elevation has no fallback and keeps the original download available for caller cleanup", ownedOptions, async () => {
  const f = await originalFixture();
  try {
    for (const code of [126, 127, 1]) {
      let installs = 0;
      const prepared = await prepareDebianUpdate(f.input, { async metadata() { return valid; }, async install() { installs++; return code; } });
      const first = prepared.install(); assert.equal(prepared.install(), first);
      await assert.rejects(first, failure(code === 126 ? "INSTALL_CANCELLED" : "INSTALL_FAILED"));
      await assert.rejects(prepared.install(), failure(code === 126 ? "INSTALL_CANCELLED" : "INSTALL_FAILED"));
      assert.equal(installs, 1); assert.equal((await f.download.file.stat()).size, 21_152_538);
    }
  } finally { await f.cleanup(); }
});

test("Changes during metadata or settled elevation are refused and no changed pathname is removed", ownedOptions, async () => {
  for (const phase of ["metadata", "install"] as const) {
    const f = await originalFixture();
    try {
      const replace = async () => { await rename(f.path, `${f.path}.original`); await writeFile(f.path, "replacement", { mode: 0o600 }); };
      if (phase === "metadata") {
        await assert.rejects(prepareDebianUpdate(f.input, { async metadata() { await replace(); return valid; } }), failure("SOURCE_CHANGED"));
      } else {
        const prepared = await prepareDebianUpdate(f.input, { async metadata() { return valid; }, async install() { await replace(); return 0; } });
        await assert.rejects(prepared.install(), failure("SOURCE_CHANGED"));
      }
      assert.equal(await readFile(f.path, "utf8"), "replacement");
    } finally { await f.cleanup(); }
  }
});

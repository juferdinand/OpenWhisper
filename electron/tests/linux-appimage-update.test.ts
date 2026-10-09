import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { LinuxAppImageUpdateError, prepareAppImageUpdate, validateAppImageUpdateHeader } from "../src/services/linux-appimage-update.js";
import { LinuxUpdateSignatureError } from "../src/services/linux-update-signature.js";
import { retainOwnedUpdateDownload } from "../src/services/update-staging.js";

const supported = process.platform === "linux" && process.arch === "x64" && process.getuid?.() !== 0;
const artifactName = "OpenWhisper-Linux-x86_64.AppImage";
const failure = (code: LinuxAppImageUpdateError["code"]) => (error: unknown): boolean =>
  error instanceof LinuxAppImageUpdateError && error.code === code && error.message === code;

test("AppImage format admission requires a complete x64 little-endian type-2 ELF header", () => {
  const header = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header);
  Buffer.from([0x41, 0x49, 2]).copy(header, 8);
  header.writeUInt16LE(3, 16); header.writeUInt16LE(62, 18); header.writeUInt32LE(1, 20);
  validateAppImageUpdateHeader(header);
  const executable = Buffer.from(header); executable.writeUInt16LE(2, 16); validateAppImageUpdateHeader(executable);
  for (const offset of [0, 4, 5, 6, 8, 9, 10, 16, 18, 20]) {
    const changed = Buffer.from(header); changed[offset] = 0;
    assert.throws(() => validateAppImageUpdateHeader(changed), failure("INVALID_PACKAGE"));
  }
  assert.throws(() => validateAppImageUpdateHeader(header.subarray(0, 63)), failure("INVALID_PACKAGE"));
});

async function fixture(bytes = Buffer.from("unsigned private test")) {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-appimage-update-"));
  const home = join(root, "home"), image = join(home, ".local/lib/whisperfree/OpenWhisper.AppImage");
  const launcher = join(dirname(image), "openwhisper-launch"), stageDirectory = join(root, "download");
  await mkdir(dirname(image), { recursive: true, mode: 0o700 }); await mkdir(stageDirectory, { mode: 0o700 });
  await writeFile(image, "inert private predecessor", { mode: 0o755 });
  await writeFile(launcher, "inert private launcher", { mode: 0o755 });
  const path = join(stageDirectory, artifactName);
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await file.writeFile(bytes); await file.sync();
  const download = await retainOwnedUpdateDownload({ file, stageDirectory, artifactName });
  // Host-installed admission is synthetic here; real ancestry is tested separately. No image is executed.
  const launch = Object.freeze({ kind: "appimage" as const, executable: launcher, arguments: Object.freeze([image] as const), assertUnchanged() {} });
  return { root, image, launcher, path, download,
    input: { download, signature: "", expectedVersion: "0.2.5", currentVersion: "0.2.4", home, launch },
    async cleanup() { await download.cleanup().catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}

test("Unsigned AppImage refuses before copying or installation and preserves the caller's download", { skip: !supported }, async () => {
  const f = await fixture(); let moves = 0, publishes = 0;
  try {
    await assert.rejects(prepareAppImageUpdate(f.input, {
      async move() { moves++; }, async publish() { publishes++; },
    }), LinuxUpdateSignatureError);
    assert.equal(moves, 0); assert.equal(publishes, 0);
    assert.equal(await readFile(f.image, "utf8"), "inert private predecessor");
    assert.equal(await readFile(f.path, "utf8"), "unsigned private test");
    for (const currentVersion of ["0.2.5", "0.3.0", "invalid"]) {
      await assert.rejects(prepareAppImageUpdate({ ...f.input, currentVersion }), failure("INVALID_INPUT"));
    }
    await assert.rejects(prepareAppImageUpdate({ ...f.input, launch: { ...f.input.launch, arguments: [f.path] } }), failure("INVALID_INPUT"));
    assert.deepEqual((await readdir(dirname(f.image))).sort(), ["OpenWhisper.AppImage", "openwhisper-launch"]);
  } finally { await f.cleanup(); }
});

const assets = process.env["OPENWHISPER_OWNED_UPDATE_SIGNATURE_ASSETS"];
const ownedOptions = { skip: !supported || !assets ? "Requires explicit original signed 0.2.5 bytes; no network or image execution fallback." : false };
async function originalFixture() {
  assert.ok(assets && isAbsolute(assets));
  const bytes = await readFile(join(assets, artifactName)), signature = await readFile(join(assets, `${artifactName}.sig`), "utf8");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "81ee1be21506a3deb0a5e90846c639e81df766eab728b9970f4af14ef166ffab");
  assert.equal(createHash("sha256").update(signature).digest("hex"), "5994738ed14e8a375ac762bf44f80ba0dc6939a0b672df66f857b60ce158a084");
  const f = await fixture(bytes); return { ...f, input: { ...f.input, signature } };
}
const cleanInstallation = async (image: string): Promise<void> => {
  assert.deepEqual((await readdir(dirname(image))).sort(), ["OpenWhisper.AppImage", "openwhisper-launch"]);
};

test("Original signed AppImage installs once and retains its predecessor until explicit commit", ownedOptions, async () => {
  const f = await originalFixture();
  try {
    const prepared = await prepareAppImageUpdate(f.input);
    assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.bytes, 96_164_344);
    assert.equal(await readFile(f.image, "utf8"), "inert private predecessor");
    const first = prepared.install(); assert.equal(prepared.install(), first);
    await assert.rejects(prepared.discard(), failure("INVALID_STATE"));
    await first; await prepared.assertInstalled();
    assert.equal(createHash("sha256").update(await readFile(f.image)).digest("hex"), "81ee1be21506a3deb0a5e90846c639e81df766eab728b9970f4af14ef166ffab");
    const stages = (await readdir(dirname(f.image))).filter((name) => name.startsWith(".openwhisper-update-"));
    assert.equal(stages.length, 1);
    assert.equal(await readFile(join(dirname(f.image), stages[0]!, "previous.AppImage"), "utf8"), "inert private predecessor");
    const committed = prepared.commit(); assert.equal(prepared.commit(), committed); await committed;
    await cleanInstallation(f.image); await f.download.assertUnchanged();
    await assert.rejects(prepared.rollback(), failure("INVALID_STATE"));
  } finally { await f.cleanup(); }
});

test("Explicit rollback restores the exact inert predecessor and preparation can be discarded", ownedOptions, async () => {
  const f = await originalFixture();
  try {
    const prepared = await prepareAppImageUpdate(f.input); await prepared.install();
    const rolledBack = prepared.rollback(); assert.equal(prepared.rollback(), rolledBack); await rolledBack;
    assert.equal(await readFile(f.image, "utf8"), "inert private predecessor"); await cleanInstallation(f.image);
    const cancelled = await prepareAppImageUpdate(f.input); await cancelled.discard();
    assert.equal(await readFile(f.image, "utf8"), "inert private predecessor"); await cleanInstallation(f.image);
    await f.download.assertUnchanged();
  } finally { await f.cleanup(); }
});

test("Publication failure restores the predecessor, while a foreign destination is preserved", ownedOptions, async () => {
  for (const state of ["moved", "absent", "published", "foreign"] as const) {
    const foreign = state === "foreign";
    const f = await originalFixture();
    try {
      const prepared = await prepareAppImageUpdate(f.input, {
        async move(from, to) { await rename(from, to); if (state === "moved") throw new Error("private move fault"); },
        async publish(from, to) {
          if (foreign) await writeFile(to, "foreign destination", { mode: 0o755 });
          if (state === "published") await link(from, to);
          throw new Error("private fault");
        },
      });
      await assert.rejects(prepared.install(), failure(foreign ? "ROLLBACK_FAILED" : "INSTALL_FAILED"));
      assert.equal(await readFile(f.image, "utf8"), foreign ? "foreign destination" : "inert private predecessor");
      if (foreign) {
        await assert.rejects(prepared.discard(), failure("INVALID_STATE"));
        const stage = (await readdir(dirname(f.image))).find((name) => name.startsWith(".openwhisper-update-")); assert.ok(stage);
        assert.equal(await readFile(join(dirname(f.image), stage, "previous.AppImage"), "utf8"), "inert private predecessor");
      } else { await prepared.discard(); await cleanInstallation(f.image); }
      await f.download.assertUnchanged();
    } finally { await f.cleanup(); }
  }
});

test("Changed launch files refuse before replacement and caller cleanup cannot race an original move", ownedOptions, async () => {
  const f = await originalFixture();
  try {
    const changed = await prepareAppImageUpdate(f.input);
    await rename(f.launcher, `${f.launcher}.original`); await writeFile(f.launcher, "foreign launcher", { mode: 0o755 });
    await assert.rejects(changed.install(), failure("INSTALL_FAILED"));
    assert.equal(await readFile(f.image, "utf8"), "inert private predecessor");
    await assert.rejects(changed.discard(), failure("CLEANUP_FAILED"));
    assert.equal(await readFile(f.launcher, "utf8"), "foreign launcher");
  } finally { await f.cleanup(); }
  const pending = await originalFixture(); let release!: () => void, entered!: () => void;
  const started = new Promise<void>((accept) => { entered = accept; }), gate = new Promise<void>((accept) => { release = accept; });
  try {
    const prepared = await prepareAppImageUpdate(pending.input, { async move(from, to) { entered(); await gate; await rename(from, to); } });
    const installing = prepared.install(); await started;
    await assert.rejects(prepared.discard(), failure("INVALID_STATE"));
    release(); await installing; await prepared.rollback(); await cleanInstallation(pending.image);
  } finally { release?.(); await pending.cleanup(); }
});

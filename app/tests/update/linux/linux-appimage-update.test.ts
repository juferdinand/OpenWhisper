import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";
import { LinuxAppImageUpdateError, admitSignedAppImageLaunch, repairSignedAppImageLaunch, prepareAppImageUpdate, validateAppImageUpdateHeader,
  type AppImageExecContinuation, type PreparedAppImageUpdate } from "../../../src/services/update/linux/linux-appimage-update.js";
import { LinuxUpdateSignatureError } from "../../../src/services/update/linux/linux-update-signature.js";
import { retainOwnedUpdateDownload } from "../../../src/services/update/common/update-staging.js";
import { appImageLauncher } from "../../../src/services/update/linux/linux-appimage-launcher.js";

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
  const signed = `${image}.sig`; await writeFile(signed, "inert predecessor signature", { mode: 0o600 });
  await writeFile(launcher, "inert private launcher", { mode: 0o755 });
  const path = join(stageDirectory, artifactName);
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await file.writeFile(bytes); await file.sync();
  const download = await retainOwnedUpdateDownload({ file, stageDirectory, artifactName });
  // Host-installed admission and unsigned predecessor are synthetic filesystem evidence only.
  // Production additionally requires signed-current-pair admission; no image is executed.
  const launch = Object.freeze({ kind: "appimage" as const, executable: launcher, arguments: Object.freeze([image] as const), assertUnchanged() {} });
  return { root, image, signed, launcher, path, download,
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
    assert.deepEqual((await readdir(dirname(f.image))).sort(), ["OpenWhisper.AppImage", "OpenWhisper.AppImage.sig", "openwhisper-launch"]);
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
  assert.deepEqual((await readdir(dirname(image))).sort(), ["OpenWhisper.AppImage", "OpenWhisper.AppImage.sig", "openwhisper-launch"]);
};

test("Signed candidate filesystem transaction retains an inert predecessor pair until explicit commit", ownedOptions, async () => {
  const f = await originalFixture();
  try {
    const prepared = await prepareAppImageUpdate(f.input);
    assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.bytes, 96_164_344);
    assert.equal(await readFile(f.image, "utf8"), "inert private predecessor");
    const first = prepared.install(); assert.equal(prepared.install(), first);
    await assert.rejects(prepared.discard(), failure("INVALID_STATE"));
    await first; await prepared.assertInstalled();
    assert.equal(await readFile(f.signed, "utf8"), f.input.signature);
    assert.equal((await lstat(f.signed)).mode & 0o777, 0o644);
    assert.equal(createHash("sha256").update(await readFile(f.image)).digest("hex"), "81ee1be21506a3deb0a5e90846c639e81df766eab728b9970f4af14ef166ffab");
    const stages = (await readdir(dirname(f.image))).filter((name) => name.startsWith(".openwhisper-update-"));
    assert.equal(stages.length, 1);
    assert.equal(await readFile(join(dirname(f.image), stages[0]!, "previous.AppImage"), "utf8"), "inert private predecessor");
    assert.equal(await readFile(join(dirname(f.image), stages[0]!, "previous.AppImage.sig"), "utf8"), "inert predecessor signature");
    assert.equal((await lstat(join(dirname(f.image), stages[0]!, "previous.AppImage.sig"))).mode & 0o777, 0o600);
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
    assert.equal(await readFile(f.image, "utf8"), "inert private predecessor");
    assert.equal(await readFile(f.signed, "utf8"), "inert predecessor signature");
    assert.equal((await lstat(f.signed)).mode & 0o777, 0o600); await cleanInstallation(f.image);
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

async function continuationFixture() {
  const f = await originalFixture();
  await writeFile(f.launcher, appImageLauncher(), { mode: 0o755 });
  return f;
}
async function retainedDescriptors(paths: readonly string[]): Promise<number> {
  const names = await readdir("/proc/self/fd");
  const identities = await Promise.all(paths.map((path) => lstat(path, { bigint: true }).catch(() => undefined)));
  const descriptors = await Promise.all(names.map((name) => stat(`/proc/self/fd/${name}`, { bigint: true }).catch(() => undefined)));
  return descriptors.filter((value) => value && identities.some((identity) => identity && identity.dev === value.dev && identity.ino === value.ino)).length;
}
async function continuationStage(image: string): Promise<string> {
  const names = (await readdir(dirname(image))).filter((name) => name.startsWith(".openwhisper-update-"));
  assert.equal(names.length, 1); return join(dirname(image), names[0]!);
}

test("Durable continuation retains the predecessor and settles original descriptors before inactive exec admission", ownedOptions, async () => {
  const f = await continuationFixture();
  let prepared: PreparedAppImageUpdate | undefined, continuation: AppImageExecContinuation | undefined;
  try {
    prepared = await prepareAppImageUpdate(f.input);
    await assert.rejects(prepared.prepareExecContinuation(), failure("INVALID_STATE"));
    await prepared.install(); const stage = await continuationStage(f.image), backup = join(stage, "previous.AppImage");
    assert.equal(await retainedDescriptors([f.image, backup]), 2);
    const first = prepared.prepareExecContinuation(); assert.equal(prepared.prepareExecContinuation(), first);
    await assert.rejects(prepared.commit(), failure("INVALID_STATE"));
    await assert.rejects(prepared.rollback(), failure("INVALID_STATE"));
    continuation = await first; assert.ok(Object.isFrozen(continuation));
    assert.equal(await retainedDescriptors([f.image, backup, join(stage, "continuation.json")]), 0);
    assert.equal((await lstat(stage)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(stage, "continuation.json"))).mode & 0o777, 0o600);
    const bytes = await readFile(join(stage, "continuation.json")); assert.ok(bytes.length <= 32 * 1024);
    const record: unknown = JSON.parse(bytes.toString("utf8"));
    assert.ok(record && typeof record === "object");
    assert.deepEqual(Object.keys(record).sort(), ["artifact", "directory", "installed", "installedVersion", "launcher",
      "installedSignature", "predecessor", "predecessorSha256", "predecessorSignature", "predecessorVersion", "schemaVersion", "signature", "stage"].sort());
    assert.ok(!bytes.toString("utf8").includes(f.root));
    assert.throws(continuation.assertForExec, failure("INVALID_STATE"));
    const check = continuation.assertInstalledForExec(); assert.equal(continuation.assertInstalledForExec(), check); await check;
    assert.equal(await retainedDescriptors([f.image, backup]), 0);
    assert.equal(await readFile(backup, "utf8"), "inert private predecessor");
    await f.download.assertUnchanged(); await f.download.cleanup(); continuation.assertForExec();
    assert.equal(await retainedDescriptors([f.image, f.signed, backup, `${backup}.sig`, join(stage, "continuation.json")]), 0);
    // No image or exec is invoked. The same parent can still restore after a refused handoff.
    const rollback = continuation.rollbackBeforeExec(); assert.equal(continuation.rollbackBeforeExec(), rollback); await rollback;
    assert.equal(await readFile(f.image, "utf8"), "inert private predecessor"); await cleanInstallation(f.image);
    assert.equal(await retainedDescriptors([f.image, backup]), 0);
    await assert.rejects(continuation.assertInstalledForExec(), failure("INVALID_STATE"));
  } finally {
    await continuation?.rollbackBeforeExec().catch(() => {});
    await prepared?.rollback().catch(() => {}); await prepared?.discard().catch(() => {}); await f.cleanup();
  }
});

test("Continuation refuses foreign records before closure and preserves replacements after closure", ownedOptions, async () => {
  for (const changed of ["record-before", "record-after", "candidate", "signature", "backup-signature", "backup-mode", "unknown-child"] as const) {
    const f = await continuationFixture();
    let prepared: PreparedAppImageUpdate | undefined, continuation: AppImageExecContinuation | undefined;
    try {
      prepared = await prepareAppImageUpdate(f.input); await prepared.install();
      const stage = await continuationStage(f.image), record = join(stage, "continuation.json"), backup = join(stage, "previous.AppImage");
      if (changed === "record-before") {
        await writeFile(record, "foreign record", { mode: 0o600 });
        await assert.rejects(prepared.prepareExecContinuation(), failure("SOURCE_CHANGED"));
        assert.equal(await readFile(record, "utf8"), "foreign record");
        // Existing rollback restores the old image but refuses to remove the foreign stage child.
        await assert.rejects(prepared.rollback(), failure("ROLLBACK_FAILED"));
        assert.equal(await readFile(f.image, "utf8"), "inert private predecessor");
        continue;
      }
      continuation = await prepared.prepareExecContinuation();
      if (changed === "record-after") { await rename(record, `${record}.original`); await writeFile(record, "foreign record", { mode: 0o600 }); }
      if (changed === "candidate") { await rename(f.image, `${f.image}.original`); await writeFile(f.image, "foreign candidate", { mode: 0o755 }); }
      if (changed === "signature") await writeFile(f.signed, "foreign signature");
      if (changed === "backup-signature") await writeFile(`${backup}.sig`, "foreign predecessor signature");
      if (changed === "backup-mode") await chmod(backup, 0o700);
      if (changed === "unknown-child") await writeFile(join(stage, "unknown"), "foreign child", { mode: 0o600 });
      await assert.rejects(continuation.assertInstalledForExec());
      assert.throws(continuation.assertForExec, failure("INVALID_STATE"));
      await assert.rejects(continuation.rollbackBeforeExec(), failure("ROLLBACK_FAILED"));
      assert.equal(await readFile(backup, "utf8"), "inert private predecessor");
      assert.equal(await retainedDescriptors([f.image, backup, record]), 0);
      if (changed === "candidate") assert.equal(await readFile(f.image, "utf8"), "foreign candidate");
      if (changed === "record-after") assert.equal(await readFile(record, "utf8"), "foreign record");
      await f.download.assertUnchanged();
    } finally {
      await continuation?.rollbackBeforeExec().catch(() => {});
      await prepared?.rollback().catch(() => {}); await prepared?.discard().catch(() => {}); await f.cleanup();
    }
  }
});


test("Signed-current admission refuses missing, writable, linked and foreign launcher inputs without retained descriptors", { skip: !supported }, async () => {
  for (const kind of ["missing", "writable", "hardlink", "symlink", "launcher"] as const) {
    const f = await fixture();
    try {
      await writeFile(f.launcher, appImageLauncher());
      if (kind === "missing") await unlink(f.signed);
      if (kind === "writable") await chmod(f.signed, 0o666);
      if (kind === "hardlink") await link(f.signed, `${f.signed}.other`);
      if (kind === "symlink") { await rename(f.signed, `${f.signed}.other`); await symlink(`${f.signed}.other`, f.signed); }
      if (kind === "launcher") await writeFile(f.launcher, "foreign launcher");
      await assert.rejects(admitSignedAppImageLaunch({ home: f.input.home, version: "0.2.5", launch: f.input.launch }), failure("SOURCE_CHANGED"));
      assert.equal(await retainedDescriptors([f.image, f.signed, f.launcher]), 0);
    } finally { await f.cleanup(); }
  }
});

test("Original signed current pair admits only its exact version and retains a post-close mutation guard", ownedOptions, async () => {
  const f = await originalFixture();
  try {
    await writeFile(f.image, await readFile(f.path)); await writeFile(f.launcher, appImageLauncher());
    await writeFile(f.signed, f.input.signature); await chmod(f.signed, 0o644);
    const admitted = await admitSignedAppImageLaunch({ home: f.input.home, version: "0.2.5", launch: f.input.launch });
    assert.ok(Object.isFrozen(admitted)); admitted.assertUnchanged();
    assert.equal(await retainedDescriptors([f.image, f.signed, f.launcher]), 0);
    await assert.rejects(admitSignedAppImageLaunch({ home: f.input.home, version: "0.2.4", launch: f.input.launch }),
      (error: unknown) => error instanceof LinuxUpdateSignatureError && error.code === "SIGNED_VERSION_MISMATCH");
    assert.equal(await retainedDescriptors([f.image, f.signed, f.launcher]), 0);
    await writeFile(f.signed, "stale or replaced sidecar");
    assert.throws(admitted.assertUnchanged, failure("SOURCE_CHANGED"));
    assert.equal(await readFile(f.signed, "utf8"), "stale or replaced sidecar");
  } finally { await f.cleanup(); }
});


test("Current-signature repair refuses unauthenticated bytes before any sidecar mutation", { skip: !supported }, async () => {
  const f = await fixture();
  try {
    const header = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header);
    Buffer.from([0x41, 0x49, 2]).copy(header, 8); header.writeUInt16LE(3, 16); header.writeUInt16LE(62, 18); header.writeUInt32LE(1, 20);
    await writeFile(f.image, header); await writeFile(f.launcher, appImageLauncher());
    const input = { home: f.input.home, version: "0.2.5", launch: f.input.launch, signature: "" };
    await assert.rejects(repairSignedAppImageLaunch(input), LinuxUpdateSignatureError);
    assert.equal(await readFile(f.signed, "utf8"), "inert predecessor signature"); await cleanInstallation(f.image);
    await unlink(f.signed);
    await assert.rejects(repairSignedAppImageLaunch(input), LinuxUpdateSignatureError);
    assert.equal(await lstat(f.signed).catch(() => undefined), undefined);
    assert.deepEqual((await readdir(dirname(f.image))).sort(), ["OpenWhisper.AppImage", "openwhisper-launch"]);
    assert.equal(await retainedDescriptors([f.image, f.launcher]), 0);
  } finally { await f.cleanup(); }
});

test("Current-signature repair authenticates exact cached bytes and repairs stale and missing sidecars without execution", ownedOptions, async () => {
  const f = await originalFixture();
  try {
    await writeFile(f.image, await readFile(f.path)); await writeFile(f.launcher, appImageLauncher());
    const input = { home: f.input.home, version: "0.2.5", launch: f.input.launch, signature: f.input.signature };
    await assert.rejects(repairSignedAppImageLaunch({ ...input, version: "0.2.4" }),
      (error: unknown) => error instanceof LinuxUpdateSignatureError && error.code === "SIGNED_VERSION_MISMATCH");
    assert.equal(await readFile(f.signed, "utf8"), "inert predecessor signature"); await cleanInstallation(f.image);
    const first = await repairSignedAppImageLaunch(input); first.assertUnchanged();
    assert.equal(await readFile(f.signed, "utf8"), f.input.signature);
    assert.equal((await lstat(f.signed)).mode & 0o777, 0o644); await cleanInstallation(f.image);
    assert.equal(await retainedDescriptors([f.image, f.signed, f.launcher]), 0);
    await unlink(f.signed); assert.throws(first.assertUnchanged, failure("SOURCE_CHANGED"));
    const second = await repairSignedAppImageLaunch(input); second.assertUnchanged(); await cleanInstallation(f.image);
    assert.equal(await readFile(f.signed, "utf8"), f.input.signature);
    await writeFile(f.signed, "later replacement"); assert.throws(second.assertUnchanged, failure("SOURCE_CHANGED"));
    assert.equal(await retainedDescriptors([f.image, f.signed, f.launcher]), 0);
  } finally { await f.cleanup(); }
});

test("Current-signature repair restores its captured sidecar on partial move/publication and preserves foreign destinations", ownedOptions, async () => {
  for (const state of ["moved", "published", "foreign"] as const) {
    const f = await originalFixture();
    try {
      await writeFile(f.image, await readFile(f.path)); await writeFile(f.launcher, appImageLauncher());
      const old = await lstat(f.signed, { bigint: true });
      await assert.rejects(repairSignedAppImageLaunch({ home: f.input.home, version: "0.2.5", launch: f.input.launch, signature: f.input.signature }, {
        async move(from, to) { await rename(from, to); if (state === "moved") throw new Error("owned post-move fault"); },
        async publish(from, to) {
          if (state === "published") await link(from, to);
          if (state === "foreign") await writeFile(to, "foreign signature", { mode: 0o644 });
          throw new Error("owned publication fault");
        },
      }), failure(state === "foreign" ? "ROLLBACK_FAILED" : "PREPARE_FAILED"));
      assert.equal(await readFile(f.signed, "utf8"), state === "foreign" ? "foreign signature" : "inert predecessor signature");
      if (state === "foreign") {
        const stage = (await readdir(dirname(f.image))).find((name) => name.startsWith(".openwhisper-signature-")); assert.ok(stage);
        const backup = join(dirname(f.image), stage, "previous.sig");
        assert.equal(await readFile(backup, "utf8"), "inert predecessor signature");
        assert.equal((await lstat(backup, { bigint: true })).ino, old.ino);
      } else {
        assert.equal((await lstat(f.signed, { bigint: true })).ino, old.ino);
        assert.equal((await lstat(f.signed)).mode & 0o777, 0o600); await cleanInstallation(f.image);
      }
      assert.equal(await retainedDescriptors([f.image, f.signed, f.launcher]), 0);
    } finally { await f.cleanup(); }
  }
});

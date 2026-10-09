import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { LinuxAutostart, LinuxAutostartError, linuxAutostartArgument, selectLinuxAutostartExecutable } from "../../../src/services/platforms/linux/linux-autostart.js";
import { appImageLauncher } from "../../../src/services/update/linux/linux-appimage-launcher.js";

const supported = process.platform === "linux" && process.getuid?.() !== 0;
const identity = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" };
async function fixture(operation: (input: { root: string; configHome: string; configDirs: string[]; executable: string; entry: string;
  service: LinuxAutostart }) => Promise<void>): Promise<void> {
  const root = await filesystem.realpath(await filesystem.mkdtemp(join(tmpdir(), "openwhisper-login-")));
  const configHome = join(root, "user-config"), configDirs = [join(root, "system-one"), join(root, "system-two")];
  const executable = join(root, 'Open Whisper % "quote" $value`tail\\binary');
  await filesystem.writeFile(executable, "inert owned executable; never launched", { mode: 0o700 });
  const service = await LinuxAutostart.open({ appId: identity.appId, configHome, configDirs, executable });
  try { await operation({ root, configHome, configDirs, executable, entry: join(configHome, "autostart/io.github.whisperfree.desktop"), service }); }
  finally { await filesystem.rm(root, { recursive: true, force: true }); }
}
function desktop(executable: string, additional = "", image = false): string {
  return `[Desktop Entry]\nType=Application\nName=OpenWhisper\nComment=Free, local dictation\nExec=${image ? "env APPIMAGE_EXTRACT_AND_RUN=1 " : ""}${linuxAutostartArgument(executable)}\nIcon=io.github.whisperfree\nStartupWMClass=io.github.whisperfree\nTerminal=false\n${additional}`;
}
async function write(path: string, text: string): Promise<void> {
  await filesystem.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await filesystem.writeFile(path, text, { mode: 0o600 });
}
function category(code: LinuxAutostartError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof LinuxAutostartError && error.code === code && error.message === code;
}

test("Debian selector requires stable captured identity and the exact admitted installed layout", () => {
  const input = { build: identity, packaged: true, executable: "/opt/openwhisper/openwhisper", appPath: "/opt/openwhisper/resources/app" };
  assert.equal(selectLinuxAutostartExecutable(input), input.executable);
  for (const changes of [{ packaged: false }, { executable: "/tmp/.mount_openwhisper/openwhisper" },
    { executable: "/tmp/package/openwhisper", appPath: "/tmp/package/resources/app" }, { appPath: "/opt/openwhisper-dev/resources/app" },
    { build: { ...identity, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" } }, { build: null }]) {
    assert.equal(selectLinuxAutostartExecutable({ ...input, ...changes }), undefined);
  }
});

test("Desktop arguments escape literal percent and both quote layers and reject entry injection", () => {
  assert.equal(linuxAutostartArgument("/a b/%name"), '"/a b/%%name"');
  assert.equal(linuxAutostartArgument('/a"$`\\'), String.raw`"/a\\"\\$\\` + '`' + String.raw`\\\\"`);
  for (const value of ["relative", "/a/../b", "/a\nHidden=false", "/a\0b", "/a=b"]) assert.throws(() => linuxAutostartArgument(value), category("UNSAFE_PATH"));
});

test("Opening and status are read-only; explicit enable, reopen and disable preserve unrelated files", { skip: !supported }, async () => fixture(async (input) => {
  assert.deepEqual(await input.service.status(), { requested: false });
  await assert.rejects(filesystem.lstat(input.configHome), { code: "ENOENT" });
  const sentinel = join(input.root, "stable-private-sentinel"); await filesystem.writeFile(sentinel, "keep saved opt-ins/data", { mode: 0o600 });
  assert.deepEqual(await input.service.set(true), { requested: true });
  assert.equal(await filesystem.readFile(input.entry, "utf8"), desktop(input.executable));
  assert.equal((await filesystem.lstat(input.entry)).mode & 0o7777, 0o600);
  assert.equal((await filesystem.lstat(dirname(input.entry))).mode & 0o7777, 0o700);
  const validate = spawnSync("desktop-file-validate", [input.entry], { encoding: "utf8" });
  assert.ifError(validate.error);
  assert.equal(validate.status, 0, validate.stderr);
  const reopened = await LinuxAutostart.open({ appId: identity.appId, configHome: input.configHome, configDirs: input.configDirs, executable: input.executable });
  assert.deepEqual(await reopened.status(), { requested: true });
  const enabled = await filesystem.lstat(input.entry, { bigint: true }); await reopened.set(true);
  assert.equal((await filesystem.lstat(input.entry, { bigint: true })).ino, enabled.ino);
  await reopened.set(false); assert.deepEqual(await input.service.status(), { requested: false });
  const disabled = await filesystem.readFile(input.entry, "utf8"); assert.match(disabled, /^Hidden=true$/mu); assert.equal(disabled.includes("Exec="), false);
  assert.equal(await filesystem.readFile(sentinel, "utf8"), "keep saved opt-ins/data");
}));

test("Effective XDG precedence reads system entries and user Hidden overrides without altering system data", { skip: !supported }, async () => fixture(async (input) => {
  const first = join(input.configDirs[0]!, "autostart/io.github.whisperfree.desktop"), second = join(input.configDirs[1]!, "autostart/io.github.whisperfree.desktop");
  await write(first, desktop(input.executable)); await write(second, desktop(input.executable, "Hidden=true\n"));
  assert.deepEqual(await input.service.status(), { requested: true });
  await input.service.set(false); assert.deepEqual(await input.service.status(), { requested: false });
  assert.equal(await filesystem.readFile(first, "utf8"), desktop(input.executable));
  assert.equal(await filesystem.readFile(second, "utf8"), desktop(input.executable, "Hidden=true\n"));
  await filesystem.writeFile(input.entry, desktop(input.executable, "X-GNOME-Autostart-enabled=false\n"));
  assert.deepEqual(await input.service.status(), { requested: false }); await input.service.set(true);
  assert.deepEqual(await input.service.status(), { requested: true });
}));

test("Native AppImage entries are recognized without executing them and retarget only on explicit enable", { skip: !supported }, async () => fixture(async (input) => {
  const old = join(input.root, "Old permanent.AppImage"), raw = desktop(old, "", true); await write(input.entry, raw);
  assert.deepEqual(await input.service.status(), { requested: true }); assert.equal(await filesystem.readFile(input.entry, "utf8"), raw);
  await input.service.set(true); assert.equal(await filesystem.readFile(input.entry, "utf8"), desktop(input.executable));
  await assert.rejects(filesystem.lstat(old), { code: "ENOENT" });
}));

test("Admitted permanent AppImage status preserves native bytes; explicit enable writes only quoted launcher and image", { skip: !supported }, async () => fixture(async (input) => {
  const directory = join(input.root, 'Permanent % "quoted" $value`tail\\image'); await filesystem.mkdir(directory, { mode: 0o700 });
  const image = join(directory, "OpenWhisper.AppImage"), launcher = join(directory, "openwhisper-launch");
  await filesystem.writeFile(image, "owned image, never launched", { mode: 0o700 });
  await filesystem.writeFile(launcher, appImageLauncher(), { mode: 0o700 });
  let checks = 0;
  const service = await LinuxAutostart.open({ appId: identity.appId, configHome: input.configHome, configDirs: input.configDirs,
    executable: launcher, appImage: { image, assertUnchanged() { checks++; } } });
  const native = desktop(image, "", true); await write(input.entry, native);
  assert.deepEqual(await service.status(), { requested: true }); assert.equal(await filesystem.readFile(input.entry, "utf8"), native);
  await service.set(true);
  const expected = desktop(launcher).replace(`Exec=${linuxAutostartArgument(launcher)}`, `Exec=${linuxAutostartArgument(launcher)} ${linuxAutostartArgument(image)}`);
  assert.equal(await filesystem.readFile(input.entry, "utf8"), expected);
  const validate = spawnSync("desktop-file-validate", [input.entry], { encoding: "utf8" }); assert.ifError(validate.error); assert.equal(validate.status, 0, validate.stderr);
  const before = await filesystem.lstat(input.entry, { bigint: true }); await service.set(true);
  assert.equal((await filesystem.lstat(input.entry, { bigint: true })).ino, before.ino);
  assert(checks >= 8); await service.set(false); assert.deepEqual(await service.status(), { requested: false });
  assert.equal(await filesystem.readFile(image, "utf8"), "owned image, never launched");
}));

test("Permanent AppImage identity change during staging preserves the original desktop and removes only owned unused staging", { skip: !supported }, async () => fixture(async (input) => {
  const image = join(input.root, "OpenWhisper.AppImage"), launcher = join(input.root, "openwhisper-launch");
  await filesystem.writeFile(image, "owned image, never launched", { mode: 0o700 }); await filesystem.writeFile(launcher, appImageLauncher(), { mode: 0o700 });
  let changed = false;
  const service = await LinuxAutostart.open({ appId: identity.appId, configHome: input.configHome, configDirs: input.configDirs,
    executable: launcher, appImage: { image, assertUnchanged() { if (changed) throw new Error("INSTALLED_LAUNCH_CHANGED"); } } });
  const original = desktop(image, "", true); await write(input.entry, original);
  await afterStageSync(async () => { changed = true; }, async () => { await assert.rejects(service.set(true), category("SOURCE_CHANGED")); });
  assert.equal(await filesystem.readFile(input.entry, "utf8"), original);
  assert.deepEqual(await filesystem.readdir(dirname(input.entry)), ["io.github.whisperfree.desktop"]);
  await assert.rejects(service.status(), category("SOURCE_CHANGED"));
}));

test("AppImage entries with extra or non-fixed launcher arguments are retained as conflicts", { skip: !supported }, async () => fixture(async (input) => {
  const launcher = join(input.root, "openwhisper-launch"), image = join(input.root, "OpenWhisper.AppImage");
  for (const command of [`${linuxAutostartArgument(launcher)} ${linuxAutostartArgument(image)} ${linuxAutostartArgument("/extra")}`,
    `${linuxAutostartArgument(input.executable)} ${linuxAutostartArgument(image)}`,
    `env APPIMAGE_EXTRACT_AND_RUN=1 ${linuxAutostartArgument(launcher)} ${linuxAutostartArgument(image)}`]) {
    const raw = desktop(input.executable).replace(`Exec=${linuxAutostartArgument(input.executable)}`, `Exec=${command}`);
    await write(input.entry, raw); await assert.rejects(input.service.status(), category("CONFLICT"));
    await assert.rejects(input.service.set(true), category("CONFLICT")); assert.equal(await filesystem.readFile(input.entry, "utf8"), raw);
  }
}));

test("Foreign, restricted, ambiguous, invalid and oversized entries remain untouched", { skip: !supported }, async () => fixture(async (input) => {
  for (const raw of [desktop(input.executable, "OnlyShowIn=GNOME;\n"), desktop(input.executable, "TryExec=/unknown\n"),
    desktop(input.executable, "X-Unrecognized=private retained value\n"), desktop(input.executable, "Exec=/foreign\n"),
    desktop(input.executable).replace("Exec=", "Exec=sh "), "[Desktop Entry]\nHidden=true\nName=Foreign\n", "not desktop data",
    "x".repeat(32 * 1024 + 1)]) {
    await write(input.entry, raw);
    await assert.rejects(input.service.status(), category(raw.length > 32 * 1024 ? "UNSAFE_PATH" : "CONFLICT"));
    await assert.rejects(input.service.set(true)); assert.equal(await filesystem.readFile(input.entry, "utf8"), raw);
  }
  await filesystem.writeFile(input.entry, Buffer.from([0xff])); await assert.rejects(input.service.status(), category("CONFLICT"));
}));

test("Dev, symlink ancestors/entries, hardlinks and writable executable are refused without changes", { skip: !supported }, async () => fixture(async (input) => {
  const options = { appId: identity.appId, configHome: input.configHome, configDirs: input.configDirs, executable: input.executable };
  await assert.rejects(LinuxAutostart.open({ ...options, appId: "io.github.whisperfree.dev" }), category("UNAVAILABLE"));
  await filesystem.mkdir(input.configHome, { mode: 0o700 }); const unrelated = join(input.root, "unrelated"); await write(unrelated, "unchanged");
  await filesystem.symlink(input.root, join(input.configHome, "autostart"));
  await assert.rejects(input.service.status(), category("UNSAFE_PATH")); await filesystem.unlink(join(input.configHome, "autostart"));
  await filesystem.mkdir(dirname(input.entry), { mode: 0o700 }); await filesystem.symlink(unrelated, input.entry);
  await assert.rejects(input.service.set(true), category("UNSAFE_PATH")); assert.equal(await filesystem.readFile(unrelated, "utf8"), "unchanged");
  await filesystem.unlink(input.entry); await filesystem.link(unrelated, input.entry); await assert.rejects(input.service.status(), category("UNSAFE_PATH"));
  await filesystem.unlink(input.entry); await filesystem.chmod(input.executable, 0o722);
  await assert.rejects(LinuxAutostart.open(options), category("UNSAFE_PATH"));
}));

// The fixed Node filesystem boundary is intercepted only to inject changes between stage sync and final checks.
async function afterStageSync(operation: (path: string) => Promise<void>, run: () => Promise<void>): Promise<void> {
  const originalOpen = filesystem.open;
  const hook = mock.method(filesystem, "open", async (...arguments_: Parameters<typeof filesystem.open>) => {
    const file = await originalOpen(...arguments_);
    if (typeof arguments_[0] === "string" && arguments_[0].endsWith(".tmp") && arguments_[1] !== constants.O_RDONLY) {
      const path = arguments_[0], originalSync = file.sync.bind(file);
      mock.method(file, "sync", async () => { await originalSync(); await operation(path); });
    }
    return file;
  });
  syncBuiltinESMExports();
  try { await run(); } finally { hook.mock.restore(); syncBuiltinESMExports(); }
}

test("An entry changed during staging is preserved and the owned unused stage is removed", { skip: !supported }, async () => fixture(async (input) => {
  await write(input.entry, desktop(input.executable, "Hidden=true\n"));
  await afterStageSync(async () => { await filesystem.writeFile(input.entry, "a later user edit"); }, async () => {
    await assert.rejects(input.service.set(true), category("SOURCE_CHANGED"));
  });
  assert.equal(await filesystem.readFile(input.entry, "utf8"), "a later user edit");
  assert.deepEqual(await filesystem.readdir(dirname(input.entry)), ["io.github.whisperfree.desktop"]);
}));

test("A replaced parent and foreign temporary file are retained rather than cleaned through a changed path", { skip: !supported }, async () => fixture(async (input) => {
  await write(input.entry, desktop(input.executable, "Hidden=true\n")); const retained = `${dirname(input.entry)}.retained`;
  await afterStageSync(async (path) => {
    await filesystem.rename(dirname(input.entry), retained); await filesystem.mkdir(dirname(input.entry), { mode: 0o700 });
    await filesystem.writeFile(join(dirname(input.entry), path.split("/").at(-1)!), "foreign temporary bytes", { mode: 0o600 });
  }, async () => { await assert.rejects(input.service.set(true), category("SOURCE_CHANGED")); });
  assert.equal(await filesystem.readFile(join(retained, "io.github.whisperfree.desktop"), "utf8"), desktop(input.executable, "Hidden=true\n"));
  const foreign = await filesystem.readdir(dirname(input.entry)); assert.equal(foreign.length, 1);
  assert.equal(await filesystem.readFile(join(dirname(input.entry), foreign[0]!), "utf8"), "foreign temporary bytes");
}));

test("Cleanup never follows a replaced parent alias back into the retained original directory", { skip: !supported }, async () => fixture(async (input) => {
  await write(input.entry, desktop(input.executable, "Hidden=true\n")); const retained = `${dirname(input.entry)}.retained`;
  let stageName = "";
  await afterStageSync(async (path) => {
    stageName = path.split("/").at(-1)!;
    await filesystem.rename(dirname(input.entry), retained); await filesystem.symlink(retained, dirname(input.entry));
  }, async () => { await assert.rejects(input.service.set(true), category("UNSAFE_PATH")); });
  assert.equal(await filesystem.readFile(join(retained, stageName), "utf8"), desktop(input.executable));
  assert.equal(await filesystem.readFile(join(retained, "io.github.whisperfree.desktop"), "utf8"), desktop(input.executable, "Hidden=true\n"));
}));

test("A failed stage sync reports failure, keeps the original entry and closes the original descriptor", { skip: !supported }, async () => fixture(async (input) => {
  const raw = desktop(input.executable, "Hidden=true\n"); await write(input.entry, raw);
  await afterStageSync(async () => { throw new Error("PRIVATE_FAILURE_DETAIL"); }, async () => {
    await assert.rejects(input.service.set(true), category("CHANGE_FAILED"));
  });
  assert.equal(await filesystem.readFile(input.entry, "utf8"), raw);
  // A failed operation does not poison the serialization queue.
  assert.deepEqual(await input.service.set(true), { requested: true });
}));

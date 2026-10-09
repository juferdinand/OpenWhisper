import assert from "node:assert/strict";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { admitLinuxInstalledLaunch, ensureLinuxAppImageLauncher, LinuxInstalledLaunchError } from "../../../src/main/linux-installed-launch.js";
import { appImageLauncher } from "../../../src/services/update/linux/linux-appimage-launcher.js";

const supported = process.platform === "linux" && process.getuid?.() !== 0;
const identity = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" };
type AdmissionInput = Parameters<typeof admitLinuxInstalledLaunch>[0];
async function fixture(operation: (input: AdmissionInput, files: { image: string; launcher: string; ancestorStat: string; ancestorExe: string; status: string }) => Promise<void>): Promise<void> {
  const root = filesystem.realpathSync(filesystem.mkdtempSync(join(tmpdir(), "openwhisper-installed-launch-")));
  const home = join(root, "home"), appDir = join(root, "extract"), payload = join(appDir, "usr/lib/openwhisper");
  const image = join(home, ".local/lib/whisperfree/OpenWhisper.AppImage"), launcher = join(home, ".local/lib/whisperfree/openwhisper-launch");
  filesystem.mkdirSync(join(home, ".local/lib/whisperfree"), { recursive: true, mode: 0o700 });
  filesystem.mkdirSync(join(payload, "resources/app"), { recursive: true, mode: 0o700 });
  filesystem.writeFileSync(image, "owned permanent image, never executed", { mode: 0o700 });
  filesystem.writeFileSync(launcher, appImageLauncher(), { mode: 0o700 });
  const executable = join(payload, "openwhisper"); filesystem.writeFileSync(executable, "owned extracted executable, never executed", { mode: 0o700 });
  const ancestor = 77_777_777, uid = process.getuid!(), proc = join(root, "kernel-fixture"); filesystem.mkdirSync(proc, { mode: 0o700 });
  function processStat(pid: number, parent: number, start: string): string {
    const fields = ["S", String(parent), ...Array<string>(17).fill("0"), start]; return `${pid} (owned fixture) ${fields.join(" ")}\n`;
  }
  const selfStat = join(proc, "self-stat"), ancestorStat = join(proc, "ancestor-stat"), status = join(proc, "status");
  filesystem.writeFileSync(selfStat, processStat(process.pid, ancestor, "100"));
  filesystem.writeFileSync(ancestorStat, processStat(ancestor, 0, "200"));
  filesystem.writeFileSync(status, `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  const routes = new Map<string, string>([[`/proc/${process.pid}/stat`, selfStat], [`/proc/${ancestor}/stat`, ancestorStat],
    [`/proc/${process.pid}/status`, status], [`/proc/${ancestor}/status`, status]]);
  const originalOpen = filesystem.openSync, originalLstat = filesystem.lstatSync, originalStat = filesystem.statSync;
  let ancestorExe = image;
  const hooks = [mock.method(filesystem, "openSync", (...args: Parameters<typeof originalOpen>) => {
    const name = typeof args[0] === "string" ? routes.get(args[0]) : undefined; return originalOpen(name ?? args[0], args[1], args[2]);
  }), mock.method(filesystem, "lstatSync", (...args: Parameters<typeof originalLstat>) => {
    const name = args[0] === `/proc/${process.pid}` || args[0] === `/proc/${ancestor}` ? proc : args[0]; return originalLstat(name, args[1]);
  }), mock.method(filesystem, "statSync", (...args: Parameters<typeof originalStat>) => {
    const name = args[0] === `/proc/${process.pid}/exe` ? executable : args[0] === `/proc/${ancestor}/exe` ? ancestorExe : args[0];
    return originalStat(name, args[1]);
  })];
  syncBuiltinESMExports();
  const files = { image, launcher, ancestorStat, status, get ancestorExe() { return ancestorExe; }, set ancestorExe(value: string) { ancestorExe = value; } };
  try { await operation({ build: identity, packaged: true, home, executable, resourcesPath: join(payload, "resources"),
    appPath: join(payload, "resources/app"), environment: { APPIMAGE: image, APPDIR: appDir }, pid: process.pid }, files); }
  finally { for (const hook of hooks) hook.mock.restore(); syncBuiltinESMExports(); filesystem.rmSync(root, { recursive: true, force: true }); }
}

test("Permanent Debian admission remains exact and Dev or environment-only AppImage admission is refused", async () => {
  const input: AdmissionInput = { build: identity, packaged: true, home: "/missing-owned-home", executable: "/opt/openwhisper/openwhisper",
    appPath: "/opt/openwhisper/resources/app", resourcesPath: "/opt/openwhisper/resources", environment: {}, pid: process.pid };
  assert.deepEqual(await admitLinuxInstalledLaunch(input), process.platform === "linux" ? { kind: "debian", executable: input.executable, arguments: [] } : undefined);
  assert.equal(await admitLinuxInstalledLaunch({ ...input, build: { ...identity, kind: "development" } }), undefined);
  assert.equal(await admitLinuxInstalledLaunch({ ...input, executable: "/tmp/extract/openwhisper", environment: { APPIMAGE: "/tmp/image" } }), undefined);
});

test("The owned kernel boundary admits only the frozen permanent launcher and image, without filesystem changes", { skip: !supported }, async () => fixture(async (input, files) => {
  const before = filesystem.statSync(files.launcher, { bigint: true });
  const launch = await admitLinuxInstalledLaunch(input); assert.equal(launch?.kind, "appimage");
  assert(launch?.kind === "appimage"); assert.equal(launch.executable, files.launcher); assert.deepEqual(launch.arguments, [files.image]);
  assert(Object.isFrozen(launch)); assert(Object.isFrozen(launch.arguments)); launch.assertUnchanged();
  assert.equal(filesystem.statSync(files.launcher, { bigint: true }).ino, before.ino);
  assert.deepEqual(filesystem.readdirSync(input.home), [".local"]);
  filesystem.unlinkSync(files.launcher);
  assert.throws(launch.assertUnchanged, LinuxInstalledLaunchError);
}));

test("Forged environment, transient layout, different ancestor inode and changed launcher are refused", { skip: !supported }, async () => fixture(async (input, files) => {
  assert.equal(await admitLinuxInstalledLaunch({ ...input, environment: { ...input.environment, APPIMAGE: `${files.image}.other` } }), undefined);
  assert.equal(await admitLinuxInstalledLaunch({ ...input, appPath: join(input.home, "resources/app") }), undefined);
  files.ancestorExe = input.executable; assert.equal(await admitLinuxInstalledLaunch(input), undefined); files.ancestorExe = files.image;
  filesystem.appendFileSync(files.launcher, "# changed\n"); assert.equal(await admitLinuxInstalledLaunch(input), undefined);
}));

test("PID reuse and permanent inode replacement invalidate an already admitted launch categorically", { skip: !supported }, async () => fixture(async (input, files) => {
  const launch = await admitLinuxInstalledLaunch(input); assert(launch?.kind === "appimage");
  const raw = filesystem.readFileSync(files.ancestorStat, "utf8"); filesystem.writeFileSync(files.ancestorStat, raw.replace(/200\n$/u, "201\n"));
  assert.throws(() => launch.assertUnchanged(), LinuxInstalledLaunchError);
  filesystem.writeFileSync(files.ancestorStat, raw);
  filesystem.renameSync(files.image, `${files.image}.retained`); filesystem.writeFileSync(files.image, "replacement", { mode: 0o700 });
  assert.throws(() => launch.assertUnchanged(), LinuxInstalledLaunchError);
}));

test("Symlink and hardlink permanent images are refused without changing their original bytes", { skip: !supported }, async () => fixture(async (input, files) => {
  const retained = `${files.image}.retained`; filesystem.renameSync(files.image, retained); filesystem.symlinkSync(retained, files.image);
  assert.equal(await admitLinuxInstalledLaunch(input), undefined); filesystem.unlinkSync(files.image); filesystem.linkSync(retained, files.image);
  assert.equal(await admitLinuxInstalledLaunch(input), undefined);
  assert.equal(filesystem.readFileSync(retained, "utf8"), "owned permanent image, never executed");
}));

test("Mixed process credentials, oversized kernel records and writable permanent images cannot establish admission", { skip: !supported }, async () => fixture(async (input, files) => {
  const status = filesystem.readFileSync(files.status, "utf8");
  filesystem.writeFileSync(files.status, status.replace(/\d+\n$/u, "0\n")); assert.equal(await admitLinuxInstalledLaunch(input), undefined);
  filesystem.writeFileSync(files.status, "x".repeat(16 * 1024 + 1)); assert.equal(await admitLinuxInstalledLaunch(input), undefined);
  filesystem.writeFileSync(files.status, status); filesystem.chmodSync(files.image, 0o722);
  assert.equal(await admitLinuxInstalledLaunch(input), undefined);
}));


test("Missing legacy launcher is provisioned locally only after synthetic live-image admission", { skip: !supported }, async () => fixture(async (input, files) => {
  filesystem.unlinkSync(files.launcher);
  assert.equal(await admitLinuxInstalledLaunch(input), undefined);
  const before = filesystem.statSync(files.image, { bigint: true });
  await ensureLinuxAppImageLauncher(input);
  assert.equal(filesystem.readFileSync(files.launcher, "utf8"), appImageLauncher());
  assert.equal(filesystem.statSync(files.launcher).mode & 0o777, 0o755);
  assert.equal(filesystem.statSync(files.launcher).nlink, 1);
  assert.deepEqual(filesystem.statSync(files.image, { bigint: true }), before);
  const launch = await admitLinuxInstalledLaunch(input); assert.equal(launch?.kind, "appimage");
  const retained = filesystem.statSync(files.launcher, { bigint: true });
  await ensureLinuxAppImageLauncher(input); assert.deepEqual(filesystem.statSync(files.launcher, { bigint: true }), retained);
  assert.deepEqual(filesystem.readdirSync(files.launcher.slice(0, files.launcher.lastIndexOf("/"))).sort(), ["OpenWhisper.AppImage", "openwhisper-launch"]);
}));

test("Launcher migration refuses forged ancestry and preserves unexpected existing launchers", { skip: !supported }, async () => fixture(async (input, files) => {
  filesystem.unlinkSync(files.launcher); files.ancestorExe = input.executable;
  await assert.rejects(ensureLinuxAppImageLauncher(input), LinuxInstalledLaunchError);
  assert.equal(filesystem.existsSync(files.launcher), false);
  files.ancestorExe = files.image; filesystem.writeFileSync(files.launcher, "foreign launcher", { mode: 0o755 });
  await assert.rejects(ensureLinuxAppImageLauncher(input), LinuxInstalledLaunchError);
  assert.equal(filesystem.readFileSync(files.launcher, "utf8"), "foreign launcher");
  filesystem.unlinkSync(files.launcher); filesystem.symlinkSync(files.image, files.launcher);
  await assert.rejects(ensureLinuxAppImageLauncher(input), LinuxInstalledLaunchError);
  assert.equal(filesystem.lstatSync(files.launcher).isSymbolicLink(), true);
}));

test("Exclusive launcher publication preserves a racing destination and closes original staging handles", { skip: !supported }, async () => fixture(async (input, files) => {
  filesystem.unlinkSync(files.launcher);
  const originalLink = filesystem.linkSync, originalClose = filesystem.closeSync; let written = -1, closed = false;
  const publication = mock.method(filesystem, "linkSync", (...args: Parameters<typeof originalLink>) => {
    if (args[1] === files.launcher) filesystem.writeFileSync(files.launcher, "racing launcher", { mode: 0o755 });
    return originalLink(...args);
  });
  const close = mock.method(filesystem, "closeSync", (fd: number) => { if (fd === written) closed = true; return originalClose(fd); });
  const originalWrite = filesystem.writeSync;
  const writes = mock.method(filesystem, "writeSync", (...args: Parameters<typeof originalWrite>) => { written = args[0]; return originalWrite(...args); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(ensureLinuxAppImageLauncher(input), LinuxInstalledLaunchError);
    assert.equal(await filesystem.promises.readFile(files.launcher, "utf8"), "racing launcher"); assert.equal(closed, true);
    assert.deepEqual(filesystem.readdirSync(files.launcher.slice(0, files.launcher.lastIndexOf("/"))).sort(), ["OpenWhisper.AppImage", "openwhisper-launch"]);
  } finally { publication.mock.restore(); close.mock.restore(); writes.mock.restore(); syncBuiltinESMExports(); }
}));

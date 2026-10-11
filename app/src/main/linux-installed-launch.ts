import { constants, closeSync, fstatSync, futimesSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, fchmodSync, fsyncSync, linkSync, mkdtempSync, rmdirSync, unlinkSync, writeSync, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildIdentitySchema } from "../contracts/application/build-identity.js";
import { appImageLauncher } from "../services/update/linux/linux-appimage-launcher.js";
import { selectLinuxAutostartExecutable } from "../services/platforms/linux/linux-autostart.js";

export type LinuxInstalledLaunch = Readonly<{ kind: "debian"; executable: string; arguments: readonly [] }> |
  Readonly<{ kind: "appimage"; executable: string; arguments: readonly [string]; assertUnchanged(): void }>;
interface Input {
  readonly build: unknown; readonly packaged: boolean; readonly home: string; readonly executable: string;
  readonly appPath: string; readonly resourcesPath: string; readonly environment: Readonly<{ APPIMAGE?: string; APPDIR?: string;
    XDG_DATA_HOME?: string; XDG_CURRENT_DESKTOP?: string; KDE_FULL_SESSION?: string }>;
  readonly pid: number;
}
interface ProcessIdentity { readonly pid: number; readonly parent: number; readonly start: string }
export class LinuxInstalledLaunchError extends Error {
  constructor() { super("INSTALLED_LAUNCH_CHANGED"); this.name = "LinuxInstalledLaunchError"; }
}
const refuse = (): never => { throw new LinuxInstalledLaunchError(); };
const path = (value: string): boolean => isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\p{Cc}]/u.test(value);
const legacyIconHash = "394c7a4e172149d2f3099650c23e3ef2f64f2c177feb9cea9310c8e0171d747b";
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.size === b.size &&
    a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function directories(directory: string, home: string, uid: bigint): Map<string, BigIntStats> {
  const values = new Map<string, BigIntStats>();
  for (let cursor = directory;; cursor = dirname(cursor)) {
    const value = lstatSync(cursor, { bigint: true }), mode = value.mode & 0o7777n;
    if (!value.isDirectory() || value.isSymbolicLink() || (value.uid !== uid && value.uid !== 0n) ||
      ((mode & 0o022n) !== 0n && !(value.uid === 0n && (mode & 0o1000n) !== 0n)) ||
      ((cursor === home || cursor.startsWith(`${home}/`)) && value.uid !== uid)) refuse();
    values.set(cursor, value); if (dirname(cursor) === cursor) break;
  }
  return values;
}
function fileIdentity(name: string, uid: bigint): BigIntStats {
  const value = lstatSync(name, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid || value.nlink !== 1n ||
      (value.mode & 0o022n) !== 0n || (value.mode & 0o111n) === 0n) refuse();
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!same(value, fstatSync(fd, { bigint: true })) || !same(value, lstatSync(name, { bigint: true }))) refuse(); }
  finally { closeSync(fd); }
  return value;
}
function boundedText(name: string, limit: number): string {
  const fd = openSync(name, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
    if (size > limit) refuse();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}
function fileSnapshot(name: string, limit: number, uid?: bigint): Readonly<{ identity: BigIntStats; bytes: Buffer }> {
  const identity = lstatSync(name, { bigint: true });
  if (!identity.isFile() || identity.isSymbolicLink() || (uid !== undefined && identity.uid !== uid) || identity.nlink !== 1n ||
      (identity.mode & 0o022n) !== 0n || identity.size > BigInt(limit)) return refuse();
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(identity, fstatSync(fd, { bigint: true }))) return refuse();
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, null); if (!count) break; size += count; }
    if (size > limit || size !== Number(identity.size) || !same(identity, fstatSync(fd, { bigint: true })) ||
        !same(identity, lstatSync(name, { bigint: true }))) return refuse();
    return { identity, bytes: bytes.subarray(0, size) };
  } finally { closeSync(fd); }
}
function assertDirectories(before: ReadonlyMap<string, BigIntStats>): void {
  for (const [name, identity] of before) {
    const current = lstatSync(name, { bigint: true });
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid || current.mode !== identity.mode) refuse();
  }
}
function legacyDesktopEntry(image: string): string {
  const argument = `"${[...image].map((char) => `${["\\", '"', "`", "$"].includes(char) ? "\\" : ""}${char === "%" ? "%%" : char}`).join("").replaceAll("\\", "\\\\")}"`;
  return `[Desktop Entry]\nType=Application\nName=OpenWhisper\nComment=Free, local dictation\nExec=env APPIMAGE_EXTRACT_AND_RUN=1 ${argument}\nIcon=io.github.whisperfree\nStartupWMClass=io.github.whisperfree\nStartupNotify=true\nTerminal=false\nCategories=AudioVideo;Audio;\n`;
}
function validAppIcon(bytes: Buffer): boolean {
  return bytes.length >= 24 && bytes.length <= 2 * 1024 * 1024 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 1024 && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 1024;
}
function notifyKdeIconChanged(): void {
  spawnSync("/usr/bin/dbus-send", ["--session", "--type=signal", "/KIconLoader", "org.kde.KIconLoader.iconChanged", "int32:0"],
    { stdio: "ignore", timeout: 500, windowsHide: true });
}
function processIdentity(pid: number, uid: bigint): ProcessIdentity {
  const root = `/proc/${pid}`, owner = lstatSync(root, { bigint: true });
  if (!owner.isDirectory() || owner.uid !== uid) refuse();
  const status = boundedText(`${root}/status`, 16 * 1024), ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/mu.exec(status);
  if (!ids || ids.slice(1).some((value) => BigInt(value) !== uid)) refuse();
  const raw = boundedText(`${root}/stat`, 4096), end = raw.lastIndexOf(")"), first = raw.slice(0, raw.indexOf(" "));
  const fields = raw.slice(end + 2).trim().split(/\s+/u), parent = fields[1], start = fields[19];
  if (first !== String(pid) || end < 0 || !parent || !/^[0-9]{1,10}$/u.test(parent) || !start || !/^[0-9]{1,30}$/u.test(start)) return refuse();
  return { pid, parent: Number(parent), start };
}
const sameProcess = (a: ProcessIdentity, b: ProcessIdentity): boolean => a.pid === b.pid && a.parent === b.parent && a.start === b.start;

/** Read-only structural admission, without a launcher or publisher/signature capability. */
function appImageStructure(input: Input): Readonly<{ image: string; launcher: string; uid: bigint; assertUnchanged(): void }> {
  const build = buildIdentitySchema.safeParse(input.build), user = process.getuid?.();
  if (process.platform !== "linux" || !build.success || build.data.kind !== "stable" || !input.packaged ||
      user === undefined || user === 0 || input.pid !== process.pid) return refuse();
  const home = input.home, appDir = input.environment.APPDIR, image = input.environment.APPIMAGE;
  if (!path(home) || !appDir || !path(appDir) || !image || image !== join(home, ".local/lib/whisperfree/OpenWhisper.AppImage") ||
      realpathSync(home) !== home || realpathSync(appDir) !== appDir) return refuse();
  const payload = join(appDir, "usr/lib/openwhisper"), launcher = join(home, ".local/lib/whisperfree/openwhisper-launch");
  if (input.executable !== join(payload, "openwhisper") || input.resourcesPath !== join(payload, "resources") ||
      input.appPath !== join(payload, "resources/app") || realpathSync(input.executable) !== input.executable ||
      realpathSync(input.appPath) !== input.appPath || realpathSync(input.resourcesPath) !== input.resourcesPath) refuse();
  const uid = BigInt(user), beforeDirectories = directories(dirname(image), home, uid), imageIdentity = fileIdentity(image, uid);
  if (!same(statSync(`/proc/${input.pid}/exe`, { bigint: true }), statSync(input.executable, { bigint: true }))) refuse();
  const chain: ProcessIdentity[] = []; let pid = input.pid, matched = false;
  for (let depth = 0; depth < 8 && pid > 0; depth++) {
    if (chain.some((value) => value.pid === pid)) refuse();
    const before = processIdentity(pid, uid), running = statSync(`/proc/${pid}/exe`, { bigint: true });
    const after = processIdentity(pid, uid); if (!sameProcess(before, after)) refuse();
    chain.push(before);
    if (pid !== input.pid && same(running, imageIdentity)) { matched = true; break; }
    pid = before.parent;
  }
  if (!matched) refuse();
  const assertUnchanged = (): void => {
    try {
      for (const [name, before] of beforeDirectories) {
        const current = lstatSync(name, { bigint: true });
        if (current.dev !== before.dev || current.ino !== before.ino || current.uid !== before.uid || current.mode !== before.mode) refuse();
      }
      if (!same(imageIdentity, fileIdentity(image, uid))) refuse();
      for (const before of chain) if (!sameProcess(before, processIdentity(before.pid, uid))) refuse();
      if (!same(imageIdentity, statSync(`/proc/${chain.at(-1)!.pid}/exe`, { bigint: true }))) refuse();
    } catch { refuse(); }
  };
  assertUnchanged(); return Object.freeze({ image, launcher, uid, assertUnchanged });
}
function launcherGuard(launcher: string, uid: bigint): () => void {
  const identity = fileIdentity(launcher, uid), template = appImageLauncher(), hash = createHash("sha256").update(template).digest("hex");
  const check = (): void => {
    if (identity.size !== BigInt(Buffer.byteLength(template)) ||
        createHash("sha256").update(boundedText(launcher, 16 * 1024)).digest("hex") !== hash || !same(identity, fileIdentity(launcher, uid))) refuse();
  };
  check(); return check;
}
const absent = (name: string): boolean => {
  try { lstatSync(name); return false; } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true; throw error;
  }
};

/** Local compatibility repair only; no network, signature admission, desktop edit or replacement of existing files. */
export async function ensureLinuxAppImageLauncher(input: Input): Promise<void> {
  try {
    const structural = appImageStructure(input), { launcher, uid } = structural;
    if (!absent(launcher)) { launcherGuard(launcher, uid)(); structural.assertUnchanged(); return; }
    const stage = mkdtempSync(join(dirname(launcher), ".openwhisper-launch-")), staged = join(stage, "launcher");
    const stageIdentity = lstatSync(stage, { bigint: true });
    let identity: BigIntStats | undefined, published = false;
    const guardStage = (): void => {
      structural.assertUnchanged();
      const current = lstatSync(stage, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== uid || (current.mode & 0o7777n) !== 0o700n ||
          current.dev !== stageIdentity.dev || current.ino !== stageIdentity.ino) refuse();
    };
    try {
      guardStage();
      const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        identity = fstatSync(fd, { bigint: true });
        const bytes = Buffer.from(appImageLauncher()); let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!Number.isInteger(written) || written < 1 || written > bytes.length - offset) refuse(); offset += written;
        }
        fchmodSync(fd, 0o755); fsyncSync(fd); identity = fstatSync(fd, { bigint: true });
        if (!same(identity, fileIdentity(staged, uid))) refuse();
      } finally { closeSync(fd); }
      guardStage(); linkSync(staged, launcher); published = true;
      const linked = lstatSync(launcher, { bigint: true });
      if (!identity || linked.dev !== identity.dev || linked.ino !== identity.ino || linked.nlink !== 2n ||
          !same(linked, lstatSync(staged, { bigint: true }))) refuse();
      unlinkSync(staged); identity = fileIdentity(launcher, uid);
      launcherGuard(launcher, uid)(); structural.assertUnchanged();
    } catch {
      // Only our captured inode can be withdrawn. A racing destination or unsafe ancestry is preserved.
      guardStage();
      if (published && identity && !absent(launcher)) {
        const named = lstatSync(launcher, { bigint: true });
        if (named.dev !== identity.dev || named.ino !== identity.ino || named.uid !== uid) refuse();
        unlinkSync(launcher);
      }
      refuse();
    } finally {
      guardStage();
      if (!absent(staged)) {
        const named = lstatSync(staged, { bigint: true });
        if (!identity || named.dev !== identity.dev || named.ino !== identity.ino || named.uid !== uid || !named.isFile()) refuse();
        unlinkSync(staged);
      }
      rmdirSync(stage);
    }
  } catch { refuse(); }
}

/** Refresh only the exact icon owned by the former stable AppImage installer. */
export function refreshLinuxAppImageIcon(input: Input, notifyKde: () => void = notifyKdeIconChanged): void {
  let refreshed = false;
  try {
    const structural = appImageStructure(input), uid = structural.uid;
    const dataHome = input.environment.XDG_DATA_HOME ?? join(input.home, ".local/share");
    if (!path(dataHome)) return;
    const applications = join(dataHome, "applications"), iconDirectory = join(dataHome, "icons/hicolor/256x256/apps");
    const desktopPath = join(applications, "io.github.whisperfree.desktop");
    const iconPath = join(iconDirectory, "io.github.whisperfree.png");
    const checkedDirectories = new Map([...directories(applications, input.home, uid), ...directories(iconDirectory, input.home, uid)]);
    const desktop = fileSnapshot(desktopPath, 32 * 1024, uid);
    if (new TextDecoder("utf-8", { fatal: true }).decode(desktop.bytes) !== legacyDesktopEntry(structural.image)) return;
    const icon = fileSnapshot(iconPath, 2 * 1024 * 1024, uid);
    if (createHash("sha256").update(icon.bytes).digest("hex") !== legacyIconHash) return;
    const sourcePath = join(input.appPath, "dist/ui/app-icon.png"), source = fileSnapshot(sourcePath, 2 * 1024 * 1024);
    if (!validAppIcon(source.bytes)) return;

    const stage = join(iconDirectory, `.io.github.whisperfree.png.${randomUUID()}.tmp`);
    let staged: BigIntStats | undefined;
    try {
      const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let offset = 0;
        while (offset < source.bytes.length) {
          const count = writeSync(fd, source.bytes, offset, source.bytes.length - offset, offset);
          if (!Number.isInteger(count) || count < 1 || count > source.bytes.length - offset) return refuse();
          offset += count;
        }
        fchmodSync(fd, 0o644); fsyncSync(fd); staged = fstatSync(fd, { bigint: true });
      } finally { closeSync(fd); }
      assertDirectories(checkedDirectories);
      const currentDesktop = fileSnapshot(desktopPath, 32 * 1024, uid), currentIcon = fileSnapshot(iconPath, 2 * 1024 * 1024, uid);
      if (!same(desktop.identity, currentDesktop.identity) || !desktop.bytes.equals(currentDesktop.bytes) ||
          !same(icon.identity, currentIcon.identity) || createHash("sha256").update(currentIcon.bytes).digest("hex") !== legacyIconHash ||
          !same(source.identity, lstatSync(sourcePath, { bigint: true }))) return;
      const currentStage = lstatSync(stage, { bigint: true });
      if (!staged || !same(staged, currentStage) || currentStage.uid !== uid || currentStage.nlink !== 1n ||
          currentStage.size !== BigInt(source.bytes.length)) return;
      renameSync(stage, iconPath);
      refreshed = true;
      const themeRoot = join(dataHome, "icons/hicolor"), expectedRoot = checkedDirectories.get(themeRoot);
      const directory = openSync(themeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const currentRoot = fstatSync(directory, { bigint: true });
        if (expectedRoot && currentRoot.dev === expectedRoot.dev && currentRoot.ino === expectedRoot.ino && currentRoot.uid === uid) {
          const nextMtime = new Date(Math.max(Date.now(), Number(currentRoot.mtimeNs / 1_000_000n) + 1000));
          futimesSync(directory, new Date(Number(currentRoot.atimeNs / 1_000_000n)), nextMtime); fsyncSync(directory);
        }
      } finally { closeSync(directory); }
      const iconDirectoryFd = openSync(iconDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(iconDirectoryFd); } finally { closeSync(iconDirectoryFd); }
    } finally {
      try {
        const current = lstatSync(stage, { bigint: true });
        if (staged && same(staged, current) && current.nlink === 1n) unlinkSync(stage);
      } catch { /* The staged path is already published or no longer ours. */ }
    }
  } catch { /* A stale, custom or unsafe desktop icon must never block ordinary app launch. */ }
  if (refreshed && (input.environment.KDE_FULL_SESSION === "true" || input.environment.XDG_CURRENT_DESKTOP?.split(":").includes("KDE"))) {
    try { notifyKde(); } catch { /* KDE cache notification is optional and never blocks startup. */ }
  }
}

/** Environment values are hints only. The permanent image must be a live same-user kernel ancestor executable. */
export async function admitLinuxInstalledLaunch(input: Input): Promise<LinuxInstalledLaunch | undefined> {
  if (process.platform !== "linux") return undefined;
  const executable = selectLinuxAutostartExecutable(input);
  if (executable) return Object.freeze({ kind: "debian", executable, arguments: Object.freeze([] as const) });
  try {
    const structural = appImageStructure(input), checkLauncher = launcherGuard(structural.launcher, structural.uid);
    const assertUnchanged = (): void => {
      try { structural.assertUnchanged(); checkLauncher(); } catch { refuse(); }
    };
    assertUnchanged();
    return Object.freeze({ kind: "appimage", executable: structural.launcher,
      arguments: Object.freeze([structural.image] as const), assertUnchanged });
  } catch { return undefined; }
}

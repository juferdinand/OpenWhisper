import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildIdentitySchema } from "../contracts/build-identity.js";
import { appImageLauncher } from "../services/linux-appimage-launcher.js";
import { selectLinuxAutostartExecutable } from "../services/linux-autostart.js";

export type LinuxInstalledLaunch = Readonly<{ kind: "debian"; executable: string; arguments: readonly [] }> |
  Readonly<{ kind: "appimage"; executable: string; arguments: readonly [string]; assertUnchanged(): void }>;
interface Input {
  readonly build: unknown; readonly packaged: boolean; readonly home: string; readonly executable: string;
  readonly appPath: string; readonly resourcesPath: string; readonly environment: Readonly<{ APPIMAGE?: string; APPDIR?: string }>;
  readonly pid: number;
}
interface ProcessIdentity { readonly pid: number; readonly parent: number; readonly start: string }
export class LinuxInstalledLaunchError extends Error {
  constructor() { super("INSTALLED_LAUNCH_CHANGED"); this.name = "LinuxInstalledLaunchError"; }
}
const refuse = (): never => { throw new LinuxInstalledLaunchError(); };
const path = (value: string): boolean => isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\p{Cc}]/u.test(value);
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

/** Environment values are hints only. The permanent image must be a live same-user kernel ancestor executable. */
export async function admitLinuxInstalledLaunch(input: Input): Promise<LinuxInstalledLaunch | undefined> {
  if (process.platform !== "linux") return undefined;
  const executable = selectLinuxAutostartExecutable(input);
  if (executable) return Object.freeze({ kind: "debian", executable, arguments: Object.freeze([] as const) });
  const build = buildIdentitySchema.safeParse(input.build), user = process.getuid?.();
  if (!build.success || build.data.kind !== "stable" || !input.packaged || user === undefined || user === 0 || input.pid !== process.pid) return undefined;
  try {
    const home = input.home, appDir = input.environment.APPDIR, image = input.environment.APPIMAGE;
    if (!path(home) || !appDir || !path(appDir) || !image || image !== join(home, ".local/lib/whisperfree/OpenWhisper.AppImage") ||
        realpathSync(home) !== home || realpathSync(appDir) !== appDir) return undefined;
    const payload = join(appDir, "usr/lib/openwhisper"), launcher = join(home, ".local/lib/whisperfree/openwhisper-launch");
    if (input.executable !== join(payload, "openwhisper") || input.resourcesPath !== join(payload, "resources") ||
        input.appPath !== join(payload, "resources/app") || realpathSync(input.executable) !== input.executable ||
        realpathSync(input.appPath) !== input.appPath || realpathSync(input.resourcesPath) !== input.resourcesPath) return undefined;
    const uid = BigInt(user), beforeDirectories = directories(dirname(image), home, uid);
    const imageIdentity = fileIdentity(image, uid), launcherIdentity = fileIdentity(launcher, uid);
    const template = appImageLauncher(), launcherHash = createHash("sha256").update(template).digest("hex");
    const checkLauncher = (): void => {
      if (launcherIdentity.size !== BigInt(Buffer.byteLength(template)) ||
          createHash("sha256").update(boundedText(launcher, 16 * 1024)).digest("hex") !== launcherHash ||
          !same(launcherIdentity, fileIdentity(launcher, uid))) refuse();
    };
    checkLauncher();
    if (!same(statSync(`/proc/${input.pid}/exe`, { bigint: true }), statSync(input.executable, { bigint: true }))) return undefined;
    const chain: ProcessIdentity[] = []; let pid = input.pid, matched = false;
    for (let depth = 0; depth < 8 && pid > 0; depth++) {
      if (chain.some((value) => value.pid === pid)) refuse();
      const before = processIdentity(pid, uid), running = statSync(`/proc/${pid}/exe`, { bigint: true });
      const after = processIdentity(pid, uid); if (!sameProcess(before, after)) refuse();
      chain.push(before);
      if (pid !== input.pid && same(running, imageIdentity)) { matched = true; break; }
      pid = before.parent;
    }
    if (!matched) return undefined;
    const assertUnchanged = (): void => {
      try {
        for (const [name, before] of beforeDirectories) {
          const current = lstatSync(name, { bigint: true });
          if (current.dev !== before.dev || current.ino !== before.ino || current.uid !== before.uid || current.mode !== before.mode) refuse();
        }
        if (!same(imageIdentity, fileIdentity(image, uid))) refuse(); checkLauncher();
        for (const before of chain) if (!sameProcess(before, processIdentity(before.pid, uid))) refuse();
        const ancestor = chain.at(-1)!;
        if (!same(imageIdentity, statSync(`/proc/${ancestor.pid}/exe`, { bigint: true }))) refuse();
      } catch { refuse(); }
    };
    assertUnchanged();
    return Object.freeze({ kind: "appimage", executable: launcher, arguments: Object.freeze([image] as const), assertUnchanged });
  } catch { return undefined; }
}

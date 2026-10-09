import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Duplex, Readable } from "node:stream";
import type { LinuxInstalledLaunch } from "../main/linux-installed-launch.js";
import { LINUX_RESTART_NONCE, LINUX_RESTART_VERSION, LinuxRestartError, readLinuxRestartReceipt } from "../main/linux-restart.js";
import { parseUpdateVersion } from "../services/update-policy.js";

interface OriginalChild {
  readonly pipe: Readable;
  /** Monotonic original exit time; stdio may remain open after this event. */
  readonly exited: Promise<number>;
  readonly closed: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
}
/** Host-only inert boundary; default production always launches the current packaged ELF. */
export interface LinuxSupervisorEffects {
  launch(argv: readonly string[], environment: NodeJS.ProcessEnv): OriginalChild;
  exec(executable: string, argv: readonly string[], environment: NodeJS.ProcessEnv): never;
}
interface Options {
  readonly launch: LinuxInstalledLaunch; readonly currentVersion: string; readonly argv: readonly string[];
  /** Caller owns authenticated artifact/version/backup admission; a frame grants no signature authority. */
  revalidateReplacement(version: string): Promise<void>;
}
const nativeEffects: LinuxSupervisorEffects = {
  launch(argv, environment) {
    if (process.platform !== "linux" || basename(process.execPath) !== "openwhisper") throw new LinuxRestartError("UNAVAILABLE");
    const child = spawn(process.execPath, argv, { shell: false, env: environment, stdio: ["inherit", "inherit", "inherit", "pipe"] });
    let failed = false;
    child.on("error", () => { failed = true; });
    let acceptExit!: (time: number) => void;
    const exited = new Promise<number>((accept) => { acceptExit = accept; });
    child.once("exit", () => { acceptExit(performance.now()); });
    const closed = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((accept) => {
      child.once("close", (code, signal) => {
        acceptExit(performance.now()); // Failed spawn can close without emitting exit.
        accept(Object.freeze({ code: failed ? 1 : code, signal }));
      });
    });
    const pipe = child.stdio[3];
    if (pipe instanceof Duplex) return { pipe, exited, closed };
    // Retain the original child's close even if its expected pipe was not acquired.
    const unavailable = new Readable({ read() {} });
    queueMicrotask(() => { unavailable.destroy(new LinuxRestartError("CHANNEL_FAILED")); });
    return { pipe: unavailable, exited, closed };
  },
  exec(executable, argv, environment) {
    if (process.platform !== "linux" || basename(process.execPath) !== "openwhisper" || typeof process.execve !== "function") throw new LinuxRestartError("UNAVAILABLE");
    return process.execve(executable, argv, environment);
  },
};
const cleanEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", LINUX_RESTART_NONCE, LINUX_RESTART_VERSION]) delete environment[key];
  return environment;
};
function argumentsOnly(argv: readonly string[]): void {
  if (argv.length > 32 || argv.some((value) => typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4096) ||
      argv.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) > 16 * 1024) throw new LinuxRestartError("INVALID_REQUEST");
}
/** Call before admission/profile setup. Valid and invalid control argv retain the existing early CLI parser. */
export function bypassLinuxControl(argv: readonly string[], effects: LinuxSupervisorEffects = nativeEffects): boolean {
  argumentsOnly(argv); if (!argv.includes("--control")) return false;
  return execLinuxGui(argv, effects);
}
/** Direct fixed-ELF GUI path for uninstalled packages; grants no supervision or restart authority. */
export function execLinuxGui(argv: readonly string[], effects: LinuxSupervisorEffects = nativeEffects): never {
  argumentsOnly(argv);
  try { effects.exec(process.execPath, [process.execPath, ...argv], cleanEnvironment()); }
  catch { throw new LinuxRestartError("EXEC_FAILED"); }
}
function capture(launch: LinuxInstalledLaunch): Readonly<{ kind: "debian" | "appimage"; executable: string; arguments: readonly string[] }> {
  const path = (value: string): boolean => isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\p{Cc}]/u.test(value);
  if (launch.kind === "debian") {
    if (launch.executable !== "/opt/openwhisper/openwhisper" || launch.arguments.length !== 0) throw new LinuxRestartError("INVALID_REQUEST");
  } else if (launch.kind === "appimage") {
    const home = homedir();
    if (!path(home) || launch.executable !== join(home, ".local/lib/whisperfree/openwhisper-launch") || launch.arguments.length !== 1 ||
        launch.arguments[0] !== join(home, ".local/lib/whisperfree/OpenWhisper.AppImage")) throw new LinuxRestartError("INVALID_REQUEST");
    try { launch.assertUnchanged(); } catch { throw new LinuxRestartError("INVALID_REQUEST"); }
  } else throw new LinuxRestartError("INVALID_REQUEST");
  // The future Debian companion must boot the next supervisor generation; the bare ELF remains the GUI/control child.
  return Object.freeze({ kind: launch.kind, executable: launch.kind === "debian" ? "/opt/openwhisper/openwhisper-launch" : launch.executable,
    arguments: Object.freeze([...launch.arguments]) });
}
function afterClose<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise((accept, reject) => {
    const deadline = performance.now() + 5000;
    const timer = setTimeout(() => reject(new LinuxRestartError("CHANNEL_FAILED")), 5000);
    void Promise.resolve().then(operation).then((value) => {
      clearTimeout(timer);
      if (performance.now() >= deadline) reject(new LinuxRestartError("CHANNEL_FAILED")); else accept(value);
    }, () => { clearTimeout(timer); reject(new LinuxRestartError("CHANNEL_FAILED")); });
  });
}

/** Supervises one GUI child; the caller retains artifact authentication, installation and backup ownership. */
export async function runLinuxSupervisor(options: Options, effects: LinuxSupervisorEffects = nativeEffects): Promise<number> {
  if (bypassLinuxControl(options.argv, effects)) throw new LinuxRestartError("EXEC_FAILED");
  const currentVersion = options.currentVersion, revalidateReplacement = options.revalidateReplacement;
  try { parseUpdateVersion(currentVersion); } catch { throw new LinuxRestartError("INVALID_REQUEST"); }
  const target = capture(options.launch), argv = Object.freeze([...options.argv]), nonce = randomBytes(32).toString("hex"), initialEnvironment = Object.freeze(cleanEnvironment());
  const child = effects.launch(argv, { ...initialEnvironment, [LINUX_RESTART_NONCE]: nonce, [LINUX_RESTART_VERSION]: currentVersion });
  const reading = readLinuxRestartReceipt(child.pipe, currentVersion, nonce); void reading.catch(() => {});
  let deadline: number | undefined, timer: ReturnType<typeof setTimeout> | undefined, closedObserved = false, expired = false;
  void child.exited.then((time) => {
    deadline = time + 5000;
    if (closedObserved) return;
    timer = setTimeout(() => { expired = true; child.pipe.destroy(); }, Math.max(0, deadline - performance.now()));
  });
  let closed: Awaited<OriginalChild["closed"]>;
  try { closed = await child.closed; }
  catch { child.pipe.destroy(); throw new LinuxRestartError("CHANNEL_FAILED"); }
  finally { closedObserved = true; clearTimeout(timer); }
  try {
    if (expired || (deadline !== undefined && performance.now() >= deadline)) throw new LinuxRestartError("CHANNEL_FAILED");
    const receipt = await afterClose(() => reading);
    if (closed.code !== 0 || closed.signal !== null) return closed.code ?? 1;
    if (!receipt) return 0;
    try { await afterClose(() => revalidateReplacement(receipt.installedVersion)); } catch { throw new LinuxRestartError("REVALIDATION_FAILED"); }
    const environment = { ...initialEnvironment };
    if (target.kind === "appimage") for (const key of ["APPIMAGE", "APPDIR", "ARGV0", "TARGET_APPIMAGE", "NO_CLEANUP", "APPIMAGE_EXTRACT_AND_RUN", "TMPDIR"]) delete environment[key];
    try { effects.exec(target.executable, [target.executable, ...target.arguments, ...argv], environment); }
    catch { throw new LinuxRestartError("EXEC_FAILED"); }
  } finally { child.pipe.destroy(); }
}

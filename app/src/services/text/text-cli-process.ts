import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export const MAX_TEXT_CLI_STDOUT_BYTES = 1024 * 1024;
const MAX_TEXT_CLI_TIMEOUT_MS = 120_000;
export const MAX_TEXT_CLI_STDIN_BYTES = 384 * 1024;
const MAX_TEXT_CLI_LINE_BYTES = 64 * 1024;
const MAX_DIALOGUE_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_DIALOGUE_IDLE_MS = 30 * 60_000;

export type TextCliProcessErrorCode = "UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "FAILED" | "INVALID_RESPONSE";
export class TextCliProcessError extends Error {
  constructor(readonly code: TextCliProcessErrorCode) { super(code); this.name = "TextCliProcessError"; }
}

export interface TextCliDialogueControl {
  write(input: string): void;
  waitForInput(): void;
  beginRequest(): void;
  finishRequest(): void;
}

export interface TextCliProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxStdoutBytes?: number;
  /** Keep stdin open for a bounded JSONL control dialogue; omitted for one-shot calls. */
  readonly onLine?: (line: string) => { readonly write?: string; readonly end?: boolean } | undefined;
  readonly keepStdinOpen?: boolean;
  /** A prepared dialogue can wait for user input without consuming its inference deadline. */
  readonly onControl?: (control: TextCliDialogueControl) => void;
  readonly startupTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly collectStdout?: boolean;
}

export function safeTextCliEnvironment(environment: NodeJS.ProcessEnv = process.env, executable?: string): NodeJS.ProcessEnv {
  const keys = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "CODEX_HOME"];
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) if (environment[key] !== undefined) result[key] = environment[key];
  const home = environment["HOME"] ?? homedir();
  const paths = [
    ...(environment["PATH"] ?? "").split(delimiter).filter((directory) => isAbsolute(directory)),
    ...(executable === undefined ? [] : [dirname(executable)]), dirname(process.execPath),
    join(home, ".local/bin"), join(home, ".claude/local"), join(home, ".npm-global/bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
  ];
  result["PATH"] = [...new Set(paths)].join(delimiter);
  return result;
}

async function createPrivateWorkDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "openwhisper-text-"));
  try {
    const resolved = await realpath(path), metadata = await stat(resolved);
    if (!isAbsolute(resolved) || !metadata.isDirectory() || metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o777) !== 0o700 || dirname(resolved) !== await realpath(tmpdir())) throw new Error();
    return resolved;
  } catch {
    await rm(path, { recursive: true, force: true });
    throw new TextCliProcessError("UNAVAILABLE");
  }
}

/** Run one fixed-argv CLI in an owned empty directory and retire its whole process group. */
export async function runTextCliProcess(options: TextCliProcessOptions): Promise<Buffer> {
  if (!isAbsolute(options.executable) || options.args.some((argument) => argument.includes("\0")) ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > MAX_TEXT_CLI_TIMEOUT_MS ||
      !Number.isSafeInteger(options.maxStdoutBytes ?? MAX_TEXT_CLI_STDOUT_BYTES) ||
      (options.maxStdoutBytes ?? MAX_TEXT_CLI_STDOUT_BYTES) < 1 ||
      (options.maxStdoutBytes ?? MAX_TEXT_CLI_STDOUT_BYTES) > (options.onControl ? MAX_DIALOGUE_STDOUT_BYTES : MAX_TEXT_CLI_STDOUT_BYTES) ||
      !Number.isInteger(options.maxLineBytes ?? MAX_TEXT_CLI_LINE_BYTES) ||
      (options.maxLineBytes ?? MAX_TEXT_CLI_LINE_BYTES) < 1 ||
      (options.maxLineBytes ?? MAX_TEXT_CLI_LINE_BYTES) > MAX_TEXT_CLI_STDOUT_BYTES ||
      options.startupTimeoutMs !== undefined && (!options.onControl || !Number.isInteger(options.startupTimeoutMs) ||
        options.startupTimeoutMs < 100 || options.startupTimeoutMs > MAX_TEXT_CLI_TIMEOUT_MS) ||
      options.idleTimeoutMs !== undefined && (!options.onControl || !Number.isInteger(options.idleTimeoutMs) ||
        options.idleTimeoutMs < 100 || options.idleTimeoutMs > MAX_DIALOGUE_IDLE_MS) ||
      options.onControl !== undefined && (options.keepStdinOpen !== true || !options.onLine || options.idleTimeoutMs === undefined) ||
      options.collectStdout === false && !options.onLine ||
      Buffer.byteLength(options.input, "utf8") > MAX_TEXT_CLI_STDIN_BYTES ||
      options.onLine !== undefined && options.keepStdinOpen !== true) {
    throw new TextCliProcessError("UNAVAILABLE");
  }
  if (options.signal.aborted) throw new TextCliProcessError("CANCELLED");
  const cwd = await createPrivateWorkDirectory();
  try {
    if (options.signal.aborted) throw new TextCliProcessError("CANCELLED");
    return await new Promise<Buffer>((resolveResult, reject) => {
      let settled = false, stdoutBytes = 0, stdinBytes = Buffer.byteLength(options.input, "utf8"), stdinEnded = false;
      let exitError: TextCliProcessError | undefined, killTimer: NodeJS.Timeout | undefined;
      let terminationRequested = false, childClosed = false;
      let phase: "startup" | "idle" | "request" | "complete" = options.onControl ? "startup" : "request";
      let timer: NodeJS.Timeout | undefined;
      const maxLineBytes = options.maxLineBytes ?? MAX_TEXT_CLI_LINE_BYTES;
      const stdout: Buffer[] = [];
      let lineBuffer = Buffer.alloc(0);
      const child = spawn(options.executable, [...options.args], {
        cwd, env: safeTextCliEnvironment(process.env, options.executable), shell: false, windowsHide: true, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const signalGroup = (signal: NodeJS.Signals): void => {
        if (process.platform === "win32" || child.pid === undefined) {
          if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        } else {
          try { process.kill(-child.pid, signal); }
          catch { if (child.exitCode === null && child.signalCode === null) child.kill(signal); }
        }
      };
      const terminate = (): void => {
        if (settled) return;
        if (!terminationRequested) { terminationRequested = true; clearTimeout(timer); }
        signalGroup("SIGTERM");
        if (killTimer) return;
        killTimer = setTimeout(() => {
          killTimer = undefined;
          signalGroup("SIGKILL");
          if (childClosed) finish(exitError, collectedOutput());
        }, 1500);
      };
      const finish = (error?: TextCliProcessError, value?: Buffer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolveResult(value ?? Buffer.alloc(0));
      };
      const collectedOutput = (): Buffer => options.collectStdout === false ? Buffer.alloc(0) : Buffer.concat(stdout, stdoutBytes);
      const abort = (): void => { exitError ??= new TextCliProcessError("CANCELLED"); terminate(); };
      const failProtocol = (): void => { exitError ??= new TextCliProcessError("INVALID_RESPONSE"); terminate(); };
      const armTimeout = (timeoutMs: number): void => {
        clearTimeout(timer);
        timer = setTimeout(() => { exitError ??= new TextCliProcessError("TIMEOUT"); terminate(); }, timeoutMs);
      };
      const writeInput = (input: string): void => {
        const bytes = Buffer.byteLength(input, "utf8");
        if (settled || childClosed || terminationRequested || exitError || stdinEnded || options.signal.aborted || input.includes("\0") ||
            (stdinBytes += bytes) > MAX_TEXT_CLI_STDIN_BYTES) {
          failProtocol(); throw new TextCliProcessError("INVALID_RESPONSE");
        }
        child.stdin.write(input);
      };
      const control: TextCliDialogueControl = {
        write: writeInput,
        waitForInput: () => {
          if (phase !== "startup" || settled || childClosed || terminationRequested || exitError || stdinEnded || options.signal.aborted || options.idleTimeoutMs === undefined) {
            failProtocol(); throw new TextCliProcessError("INVALID_RESPONSE");
          }
          phase = "idle"; armTimeout(options.idleTimeoutMs);
        },
        beginRequest: () => {
          if (phase !== "idle" || settled || childClosed || terminationRequested || exitError || stdinEnded || options.signal.aborted) {
            failProtocol(); throw new TextCliProcessError("INVALID_RESPONSE");
          }
          phase = "request"; armTimeout(options.timeoutMs);
        },
        finishRequest: () => {
          if (phase !== "request" || settled || childClosed || terminationRequested || exitError || stdinEnded || options.signal.aborted) {
            failProtocol(); throw new TextCliProcessError("INVALID_RESPONSE");
          }
          phase = "complete"; stdinEnded = true; child.stdin.end();
          clearTimeout(timer);
          // A completed protocol response does not spend the remaining inference deadline on teardown.
          timer = setTimeout(terminate, 500);
        },
      };
      const dispatchLine = (line: Buffer): void => {
        if (!options.onLine || exitError) return;
        if (line.byteLength > maxLineBytes) { failProtocol(); return; }
        try {
          const action = options.onLine(new TextDecoder("utf-8", { fatal: true }).decode(line));
          if (action?.write !== undefined) {
            writeInput(action.write);
          }
          if (action?.end && !stdinEnded) { stdinEnded = true; child.stdin.end(); }
        } catch { failProtocol(); }
      };
      const collectLines = (chunk: Buffer): void => {
        if (!options.onLine || exitError) return;
        lineBuffer = Buffer.concat([lineBuffer, chunk]);
        if (lineBuffer.byteLength > maxLineBytes && !lineBuffer.includes(0x0a)) { failProtocol(); return; }
        let newline = lineBuffer.indexOf(0x0a);
        while (newline >= 0 && !exitError) {
          const line = lineBuffer.subarray(0, newline);
          dispatchLine(line.byteLength > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line);
          lineBuffer = lineBuffer.subarray(newline + 1);
          if (lineBuffer.byteLength > maxLineBytes && !lineBuffer.includes(0x0a)) { failProtocol(); return; }
          newline = lineBuffer.indexOf(0x0a);
        }
      };
      armTimeout(options.startupTimeoutMs ?? options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (exitError) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > (options.maxStdoutBytes ?? MAX_TEXT_CLI_STDOUT_BYTES)) {
          exitError ??= new TextCliProcessError("INVALID_RESPONSE"); terminate(); return;
        }
        if (options.collectStdout !== false) stdout.push(chunk);
        collectLines(chunk);
      });
      child.stderr.on("data", () => {});
      child.on("error", () => finish(new TextCliProcessError("UNAVAILABLE")));
      child.on("close", (code) => {
        childClosed = true;
        if (code !== 0 && !(phase === "complete" && terminationRequested)) exitError ??= new TextCliProcessError("FAILED");
        if (options.onControl && !terminationRequested && process.platform !== "win32" && child.pid !== undefined) {
          // The leader can exit before an inherited, detached-stdio helper in its owned group.
          try { process.kill(-child.pid, 0); terminate(); } catch { /* The owned group has already exited. */ }
        }
        if (!exitError && options.onLine && lineBuffer.byteLength > 0) exitError = new TextCliProcessError("INVALID_RESPONSE");
        if (terminationRequested && killTimer) return;
        if (exitError) {
          finish(exitError); return;
        }
        finish(undefined, collectedOutput());
      });
      child.stdin.on("error", () => {});
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) { abort(); return; }
      if (options.keepStdinOpen) child.stdin.write(options.input);
      else { stdinEnded = true; child.stdin.end(options.input); }
      try { options.onControl?.(control); } catch { failProtocol(); }
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

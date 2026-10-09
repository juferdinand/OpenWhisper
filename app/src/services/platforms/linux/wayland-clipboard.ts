import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class WaylandClipboardError extends Error {
  constructor(readonly code: "BUSY" | "CLOSED" | "WRITE_FAILED" | "READ_FAILED" | "TEARDOWN_FAILED") {
    super(`Wayland clipboard: ${code}.`);
  }
}
export interface WaylandClipboardOwner {
  write(text: string): Promise<void>;
  close(): Promise<void>;
  readonly isClosed: boolean;
}
export interface WaylandClipboardEffects {
  launch(): WaylandClipboardOwner;
  read(maximumBytes: number): Promise<string>;
}

// Only fixed installed clipboard tools are executed. Text stays in stdin/stdout,
// never shell arguments, diagnostic output or a detached background process.
function command(executable: "/usr/bin/wl-copy" | "/usr/bin/wl-paste", args: string[], input: boolean) {
  const child = spawn(executable, args, { shell: false, stdio: [input ? "pipe" : "ignore", "pipe", "ignore"] });
  let isClosed = false, failed = false, code: number | null = null;
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => { failed = true; });
    child.once("close", (exitCode) => { isClosed = true; code = exitCode; resolve(); });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      if (isClosed) { resolve(); return; }
      try { child.kill("SIGTERM"); } catch { /* Original close remains required. */ }
      const force = setTimeout(() => { if (!isClosed) try { child.kill("SIGKILL"); } catch {} }, 250);
      const deadline = setTimeout(() => reject(new WaylandClipboardError("TEARDOWN_FAILED")), 2000);
      void closed.then(() => { clearTimeout(force); clearTimeout(deadline); resolve(); });
    });
    return closing;
  };
  return { child, closed, close, get isClosed() { return isClosed; }, get failed() { return failed; }, get code() { return code; } };
}
function foregroundOwner(): WaylandClipboardOwner {
  const owner = command("/usr/bin/wl-copy", ["--foreground", "--type", "text/plain;charset=utf-8"], true);
  // wl-copy's foreground mode retains the original process until replacement/Quit.
  owner.child.stdout?.resume();
  return {
    get isClosed() { return owner.isClosed; }, close: owner.close,
    write(text) {
      return new Promise<void>((resolve, reject) => {
        const stdin = owner.child.stdin;
        const failure = () => finish(new WaylandClipboardError("WRITE_FAILED"));
        const timer = setTimeout(failure, 1500);
        const finish = (error?: WaylandClipboardError) => {
          clearTimeout(timer); stdin?.off("error", failure);
          if (error || owner.isClosed || owner.failed) reject(error ?? new WaylandClipboardError("WRITE_FAILED"));
          else resolve();
        };
        if (!stdin) { failure(); return; }
        stdin.once("error", failure);
        void owner.closed.then(failure);
        stdin.end(text, () => finish());
      });
    },
  };
}
async function readSelection(maximumBytes: number): Promise<string> {
  const owner = command("/usr/bin/wl-paste", ["--no-newline"], false);
  const blocks: Buffer[] = []; let bytes = 0, invalid = false;
  const stop = () => { invalid = true; void owner.close().catch(() => {}); };
  owner.child.stdout?.on("data", (block: Buffer) => {
    bytes += block.length;
    if (bytes > maximumBytes) { blocks.length = 0; stop(); }
    else if (!invalid) blocks.push(block);
  });
  const timer = setTimeout(stop, 1500);
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([owner.closed, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new WaylandClipboardError("TEARDOWN_FAILED")), 3750);
    })]);
    if (invalid || owner.failed || owner.code !== 0) throw new WaylandClipboardError("READ_FAILED");
    return Buffer.concat(blocks).toString("utf8");
  } finally { clearTimeout(timer); if (deadline) clearTimeout(deadline); }
}

/** Cross-client Wayland confirmation, independent of keyboard/paste permission. */
export class WaylandClipboard {
  private owner: { process: WaylandClipboardOwner; retirement?: Promise<void> } | undefined;
  private operation: Promise<void> | undefined;
  private shutdown: Promise<void> | undefined;
  private closed = false;
  private failed = false;
  private maximumBytes = 1024;
  constructor(private readonly effects: WaylandClipboardEffects = { launch: foregroundOwner, read: readSelection }) {}
  private async retire(): Promise<void> {
    const owner = this.owner; if (!owner) return;
    owner.retirement ??= Promise.resolve().then(() => owner.process.close());
    try { await owner.retirement; }
    catch { this.failed = true; throw new WaylandClipboardError("TEARDOWN_FAILED"); }
    if (this.owner === owner) this.owner = undefined;
  }
  writeText(text: string): Promise<void> {
    if (this.failed || this.closed) return Promise.reject(new WaylandClipboardError(this.failed ? "TEARDOWN_FAILED" : "CLOSED"));
    if (this.operation) return Promise.reject(new WaylandClipboardError("BUSY"));
    const operation = (async () => {
      try {
        await this.retire();
        const owner = this.effects.launch(); this.owner = { process: owner };
        this.maximumBytes = Math.max(1024, Buffer.byteLength(text, "utf8") + 16);
        await owner.write(text);
        const deadline = performance.now() + 2000;
        while (!owner.isClosed && performance.now() < deadline) {
          try { if (await this.effects.read(this.maximumBytes) === text && !owner.isClosed) return; }
          catch (error: unknown) {
            if (error instanceof WaylandClipboardError && error.code === "TEARDOWN_FAILED") { this.failed = true; throw error; }
          }
          await delay(20);
        }
        throw new WaylandClipboardError("WRITE_FAILED");
      } catch {
        await this.retire(); throw new WaylandClipboardError(this.failed ? "TEARDOWN_FAILED" : "WRITE_FAILED");
      }
    })().finally(() => { if (this.operation === operation) this.operation = undefined; });
    this.operation = operation; return operation;
  }
  async readText(): Promise<string> {
    if (this.closed || this.failed) throw new WaylandClipboardError(this.failed ? "TEARDOWN_FAILED" : "CLOSED");
    try { return await this.effects.read(this.maximumBytes); }
    catch (error: unknown) {
      if (error instanceof WaylandClipboardError && error.code === "TEARDOWN_FAILED") this.failed = true;
      throw new WaylandClipboardError(this.failed ? "TEARDOWN_FAILED" : "READ_FAILED");
    }
  }
  close(): Promise<void> {
    this.closed = true;
    this.shutdown ??= (async () => {
      try { await this.operation; } catch { /* Original failure is preserved by the caller. */ }
      await this.retire();
      if (this.failed) throw new WaylandClipboardError("TEARDOWN_FAILED");
    })();
    return this.shutdown;
  }
}

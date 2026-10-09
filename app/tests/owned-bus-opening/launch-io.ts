import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function hash(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024 * 1024) throw new Error("Frozen file is not bounded regular input.");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
export async function tree(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Frozen payload cannot contain a symlink.");
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await tree(join(directory, entry.name), relative));
    else if (entry.isFile()) result[relative] = await hash(join(directory, entry.name));
    else throw new Error("Frozen payload cannot contain special files.");
    if (Object.keys(result).length > 2048) throw new Error("Frozen payload exceeds its file bound.");
  }
  return result;
}
export interface CommandRecord { command: string; args: string[]; code: number; expired: boolean; overflow: boolean; seconds: number }
export class Commands {
  readonly records: CommandRecord[] = [];
  private sequence = 0;
  constructor(private readonly output: string) {}
  async run(command: "docker" | "unzip", args: string[], bound = 60_000, allowFailure = false): Promise<Readonly<{ stdout: string; stderr: string; code: number }>> {
    const start = performance.now(); const sequence = ++this.sequence;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "", combined = "", expired = false, overflow = false;
    let force: NodeJS.Timeout | undefined;
    const halt = (): void => { child.kill("SIGTERM"); force ??= setTimeout(() => { child.kill("SIGKILL"); }, 1000); };
    child.stdout.on("data", (bytes: Buffer) => {
      if (Buffer.byteLength(stdout) + bytes.length > 4 * 1024 * 1024 || Buffer.byteLength(combined) + bytes.length > 8 * 1024 * 1024) { overflow = true; halt(); return; }
      stdout += bytes.toString(); combined += bytes.toString();
    });
    child.stderr.on("data", (bytes: Buffer) => {
      if (Buffer.byteLength(combined) + bytes.length > 8 * 1024 * 1024) { overflow = true; halt(); return; }
      stderr += bytes.toString(); combined += bytes.toString();
    });
    const timer = setTimeout(() => { expired = true; halt(); }, bound);
    let code = 1;
    try {
      code = await new Promise<number>((accept, _reject) => {
        child.once("error", () => accept(1)); child.once("close", (value) => accept(expired || overflow ? 1 : value ?? 1));
      });
    } finally {
      clearTimeout(timer); if (force) clearTimeout(force);
      const record = { command, args, code, expired, overflow, seconds: (performance.now() - start) / 1000 };
      this.records.push(record);
      await writeFile(join(this.output, `${String(sequence).padStart(3, "0")}-${command}.log`), combined, { mode: 0o600 });
    }
    if (code !== 0 && !allowFailure) throw new Error("Owned fixture command failed; inspect retained categorical evidence.");
    return { stdout: stdout.trim(), stderr: stderr.trim(), code };
  }
}

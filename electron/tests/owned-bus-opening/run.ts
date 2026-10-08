import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "./execute.js";
import { prepare } from "./prepare.js";

export function parseArguments(args: readonly string[]): Readonly<{ mode: "prepare"; output: string; headers: string; seccomp: string }> |
  Readonly<{ mode: "execute"; directory: string }> {
  if (args.length === 7 && args[0] === "--prepare" && args[1] === "--output" && args[2] && args[3] === "--headers" && args[4] && args[5] === "--seccomp" && args[6]) {
    return { mode: "prepare", output: resolve(args[2]), headers: resolve(args[4]), seccomp: resolve(args[6]) };
  }
  if (args.length === 3 && args[0] === "--execute" && args[1] === "--package" && args[2]) return { mode: "execute", directory: resolve(args[2]) };
  throw new Error("Usage: run.ts --prepare --output NEW --headers PINNED_ARCHIVE --seccomp RETAINED_PROFILE; or --execute --package FROZEN_DIRECTORY");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "prepare") await prepare(options.output, options.headers, options.seccomp);
  else await execute(options.directory);
}

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeRemaining } from "./execute-remaining.js";
import { prepareRemaining } from "./prepare-remaining.js";

export function parseRemainingArguments(args: readonly string[]):
  Readonly<{ mode: "prepare"; output: string; headers: string; seccomp: string; original: string }> |
  Readonly<{ mode: "execute"; directory: string }> {
  if (args.length === 9 && args[0] === "--prepare" && args[1] === "--output" && args[2] && args[3] === "--headers" && args[4] &&
      args[5] === "--seccomp" && args[6] && args[7] === "--retained" && args[8]) return {
    mode: "prepare", output: resolve(args[2]), headers: resolve(args[4]), seccomp: resolve(args[6]), original: resolve(args[8]),
  };
  if (args.length === 3 && args[0] === "--execute" && args[1] === "--package" && args[2]) return { mode: "execute", directory: resolve(args[2]) };
  throw new Error("Use explicit remaining-profile --prepare inputs or --execute reviewed package.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseRemainingArguments(process.argv.slice(2));
  if (options.mode === "prepare") await prepareRemaining(options.output, options.headers, options.seccomp, options.original);
  else await executeRemaining(options.directory);
}

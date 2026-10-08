import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeLegacy } from "./execute-legacy.js";
import { prepareLegacy } from "./prepare-legacy.js";

export function parseLegacyArguments(args: readonly string[]):
  Readonly<{ mode: "prepare"; output: string; headers: string; seccomp: string; nativeOriginal: string; serviceOriginal: string }> |
  Readonly<{ mode: "execute"; directory: string }> {
  if (args.length === 11 && args[0] === "--prepare" && args[1] === "--output" && args[2] && args[3] === "--headers" && args[4] &&
      args[5] === "--seccomp" && args[6] && args[7] === "--retained" && args[8] && args[9] === "--service" && args[10]) return {
    mode: "prepare", output: resolve(args[2]), headers: resolve(args[4]), seccomp: resolve(args[6]),
    nativeOriginal: resolve(args[8]), serviceOriginal: resolve(args[10]),
  };
  if (args.length === 3 && args[0] === "--execute" && args[1] === "--package" && args[2]) return { mode: "execute", directory: resolve(args[2]) };
  throw new Error("Use explicit legacy-only --prepare with both retained artifacts, or --execute reviewed package.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseLegacyArguments(process.argv.slice(2));
  if (options.mode === "prepare") await prepareLegacy(options.output, options.headers, options.seccomp, options.nativeOriginal, options.serviceOriginal);
  else await executeLegacy(options.directory);
}

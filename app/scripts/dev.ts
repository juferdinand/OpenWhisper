import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApplication } from "./build.js";
import { installedElectronExecutable, pinnedRuntimeEnvironment } from "./runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = await installedElectronExecutable(root);
const args = process.argv.slice(2), recording = args.includes("--recording");
if (args.filter((value) => value === "--recording").length > 1) throw new Error("Only one recording build flag is allowed.");
await buildApplication({ recording });
const child = spawn(executable, [root, "--dev", ...args.filter((value) => value !== "--recording")], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: pinnedRuntimeEnvironment(process.env),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { child.kill(signal); });
}
child.once("error", () => { process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });

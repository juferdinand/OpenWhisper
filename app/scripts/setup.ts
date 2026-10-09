import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedRuntimeEnvironment } from "./runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = pinnedRuntimeEnvironment(process.env);
delete env["npm_config_platform"];
delete env["npm_config_arch"];
env["electron_config_cache"] = join(root, "node_modules/.cache/electron");
const result = spawnSync(process.execPath, [join(root, "node_modules/electron/install.js")], {
  cwd: root, env, stdio: "inherit", shell: false,
});
if (result.error || result.status !== 0) throw new Error("Pinned Electron installation failed.");

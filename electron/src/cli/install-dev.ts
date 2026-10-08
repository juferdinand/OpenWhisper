import { homedir } from "node:os";
import { installDevelopmentPackage } from "../services/development-installation.js";

const arguments_ = process.argv.slice(2), values = new Map<string, string>();
const allowed = new Set(["--source", "--installation-root", "--profile", "--desktop-file"]);
for (let index = 0; index < arguments_.length; index += 2) {
  const key = arguments_[index], value = arguments_[index + 1];
  if (!key || !allowed.has(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Usage: install-dev.js --source /standalone/Dev --installation-root /fresh/install --profile /fresh/private/profile [--desktop-file /fresh/io.github.whisperfree.dev.desktop]");
  values.set(key, value);
}
const source = values.get("--source"), installationRoot = values.get("--installation-root"), profile = values.get("--profile");
if (!source || !installationRoot || !profile) throw new Error("Explicit source, fresh installation root and fresh profile are required.");
const desktopFile = values.get("--desktop-file");
// Electron patches fs even in RUN_AS_NODE mode. Copy/hash raw .asar archive bytes.
const hadNoAsar = Object.hasOwn(process, "noAsar"), previousNoAsar: unknown = Reflect.get(process, "noAsar");
if (!Reflect.set(process, "noAsar", true)) throw new Error("Raw archive filesystem access is required for Dev installation.");
try {
  console.log(JSON.stringify(await installDevelopmentPackage({ source, installationRoot, profile, home: homedir(),
    ...(desktopFile ? { desktopFile } : {}) })));
} finally {
  if (hadNoAsar) Reflect.set(process, "noAsar", previousNoAsar);
  else Reflect.deleteProperty(process, "noAsar");
}

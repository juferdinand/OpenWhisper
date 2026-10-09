import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";

/** Resolve an installed pinned binary without executing Electron's auto-installing entry point. */
export async function installedElectronExecutable(root: string): Promise<string> {
  const metadata: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expected = z.object({ devDependencies: z.object({ electron: z.string().regex(/^\d+\.\d+\.\d+$/) }) }).parse(metadata).devDependencies.electron;
  const packageRoot = join(root, "node_modules/electron");
  const distribution = join(packageRoot, "dist");
  const platformPath = process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "linux" ? "electron" : undefined;
  if (!platformPath) throw new Error("This development host supports macOS and Linux.");
  try {
    if ((await lstat(distribution)).isSymbolicLink()) throw new Error("Unsafe runtime directory.");
    const version = (await readFile(join(distribution, "version"), "utf8")).trim().replace(/^v/, "");
    const selected = (await readFile(join(packageRoot, "path.txt"), "utf8")).trim();
    if (version !== expected || selected !== platformPath) throw new Error("Runtime version mismatch.");
    const executable = join(distribution, platformPath);
    const stats = await lstat(executable);
    const within = relative(await realpath(distribution), await realpath(executable));
    if (stats.isSymbolicLink() || !stats.isFile() || within === ".." || within.startsWith(`..${sep}`)) {
      throw new Error("Unsafe runtime executable.");
    }
    await access(executable, constants.X_OK);
    return executable;
  } catch { throw new Error("Pinned Electron is unavailable. Run npm run setup first."); }
}

export function pinnedRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (lower.startsWith("electron_") || lower.startsWith("npm_config_electron_") ||
        lower.startsWith("npm_package_config_electron_") || key === "NODE_OPTIONS" || key === "NODE_PATH") {
      delete env[key];
    }
  }
  return env;
}

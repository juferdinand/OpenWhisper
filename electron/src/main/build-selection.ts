import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { buildIdentitySchema, type BuildIdentity } from "../contracts/build-identity.js";

export interface ApplicationBuildSelectionOptions {
  readonly build: unknown; readonly argv: readonly string[]; readonly platform: string; readonly architecture: string;
  readonly packaged: boolean; readonly executable: string; readonly appPath: string;
  readonly resourcesPath: string; readonly distribution: string; readonly projectVersion: string; readonly packageVersion: string;
}
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
function fixedPath(path: string): boolean { return isAbsolute(path) && path === resolve(path) && !/[\u0000-\u001f\u007f]/u.test(path); }
function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((value) => value === flag || value.startsWith(`${flag}=`));
}

/** The host supplies canonical runtime paths. This consistency gate performs no filesystem effects and proves no signing authenticity. */
export function selectApplicationBuild(options: ApplicationBuildSelectionOptions): BuildIdentity {
  const identity = buildIdentitySchema.parse(options.build);
  if ((options.platform !== "linux" && options.platform !== "darwin") ||
      (options.architecture !== "x64" && options.architecture !== "arm64") ||
      !version.test(options.projectVersion) || options.projectVersion !== options.packageVersion ||
      ![options.executable, options.appPath, options.resourcesPath, options.distribution].every(fixedPath) ||
      options.distribution !== join(options.appPath, "dist")) throw new Error("Application build inputs are inconsistent.");
  if (identity.kind === "development") {
    if (hasFlag(options.argv, "--stable") || hasFlag(options.argv, "--production")) throw new Error("A Dev build cannot open stable storage.");
  } else if (options.platform !== "linux" || !options.packaged ||
      ["--dev", "--dev-profile", "--control"].some((flag) => hasFlag(options.argv, flag))) {
    throw new Error("The stable build requires its packaged Linux GUI identity.");
  }
  if (options.packaged) {
    const executable = options.platform === "darwin" ? identity.productName : identity.kind === "stable" ? "openwhisper" : "openwhisper-dev";
    const resources = options.platform === "darwin" ? resolve(dirname(options.executable), "../Resources") : join(dirname(options.executable), "resources");
    if (basename(options.executable) !== executable || options.resourcesPath !== resources ||
        options.appPath !== join(resources, "app")) throw new Error("The packaged application identity differs from its build.");
  } else if (basename(options.executable) !== (options.platform === "darwin" ? "Electron" : "electron")) {
    throw new Error("Development source startup requires the raw Electron runtime.");
  }
  return identity;
}

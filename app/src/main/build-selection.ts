import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { buildIdentitySchema, type BuildIdentity } from "../contracts/application/build-identity.js";
import { parseLaunchArguments } from "../cli/arguments.js";

export interface ApplicationBuildSelectionOptions {
  readonly build: unknown; readonly argv: readonly string[]; readonly platform: string; readonly architecture: string;
  readonly packaged: boolean; readonly executable: string; readonly appPath: string;
  readonly resourcesPath: string; readonly distribution: string; readonly projectVersion: string; readonly packageVersion: string;
  readonly purpose?: "gui" | "control";
}
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
function fixedPath(path: string): boolean { return isAbsolute(path) && path === resolve(path) && !/[\u0000-\u001f\u007f]/u.test(path); }
function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((value) => value === flag || value.startsWith(`${flag}=`));
}

/** Check captured identity against fields read from the actual bundle; signature authenticity is a separate host gate. */
export function validateMacBundleMetadata(build: unknown, projectVersion: string, metadata: unknown): void {
  const identity = buildIdentitySchema.parse(build);
  const expected = { CFBundleIdentifier: identity.appId, CFBundleExecutable: identity.productName,
    CFBundleName: identity.productName, CFBundleDisplayName: identity.productName,
    CFBundleVersion: projectVersion, CFBundleShortVersionString: projectVersion };
  if (!version.test(projectVersion) || typeof metadata !== "object" || metadata === null || Array.isArray(metadata) ||
      Object.entries(expected).some(([key, value]) => !Object.hasOwn(metadata, key) || Reflect.get(metadata, key) !== value)) {
    throw new Error("The Mac bundle metadata differs from its captured build.");
  }
}

/** The host supplies canonical runtime paths. This consistency gate performs no filesystem effects and proves no signing authenticity. */
export function selectApplicationBuild(options: ApplicationBuildSelectionOptions): BuildIdentity {
  const identity = buildIdentitySchema.parse(options.build);
  if (options.purpose !== undefined && options.purpose !== "gui" && options.purpose !== "control") throw new Error("Invalid application launch purpose.");
  if (options.purpose === "control" && (options.platform !== "linux" || parseLaunchArguments(options.argv,
    options.packaged ? { kind: "packaged", executable: options.executable } :
      { kind: "development", executable: options.executable, application: options.appPath }).kind !== "control")) {
    throw new Error("Command control requires its exact Linux launch arguments.");
  }
  if ((options.platform !== "linux" && options.platform !== "darwin") ||
      (options.architecture !== "x64" && options.architecture !== "arm64") ||
      !version.test(options.projectVersion) || options.projectVersion !== options.packageVersion ||
      ![options.executable, options.appPath, options.resourcesPath, options.distribution].every(fixedPath) ||
      options.distribution !== join(options.appPath, "dist")) throw new Error("Application build inputs are inconsistent.");
  if (identity.kind === "development") {
    if (hasFlag(options.argv, "--stable") || hasFlag(options.argv, "--production")) throw new Error("A Dev build cannot open stable storage.");
  } else if (!options.packaged ||
      ["--dev", "--dev-profile", ...(options.purpose === "control" ? [] : ["--control"])].some((flag) => hasFlag(options.argv, flag))) {
    throw new Error("The stable build requires its packaged GUI identity.");
  }
  if (options.packaged) {
    const executable = options.platform === "darwin" ? identity.productName : identity.kind === "stable" ? "openwhisper" : "openwhisper-dev";
    const resources = options.platform === "darwin" ? resolve(dirname(options.executable), "../Resources") : join(dirname(options.executable), "resources");
    const contents = dirname(dirname(options.executable));
    if ((options.platform === "darwin" && (basename(dirname(options.executable)) !== "MacOS" ||
        basename(contents) !== "Contents" || basename(dirname(contents)) !== `${identity.productName}.app`)) ||
        basename(options.executable) !== executable || options.resourcesPath !== resources ||
        options.appPath !== join(resources, "app")) throw new Error("The packaged application identity differs from its build.");
  } else if (basename(options.executable) !== (options.platform === "darwin" ? "Electron" : "electron")) {
    throw new Error("Development source startup requires the raw Electron runtime.");
  }
  return identity;
}

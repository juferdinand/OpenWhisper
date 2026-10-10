import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { buildIdentitySchema } from "../contracts/application/build-identity.js";
import type { HostProfile } from "../services/settings/host-profile.js";

function fixedPath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && value.length <= 4096 && !/[\p{Cc}]/u.test(value);
}

/** Admit login startup only for the explicit private profile inside the packaged Linux Dev layout. */
export function admitLinuxDevelopmentAutostart(input: {
  readonly build: unknown;
  readonly platform: string;
  readonly packaged: boolean;
  /** Canonical paths supplied by the main process after realpath. */
  readonly executable: string;
  readonly resourcesPath: string;
  readonly appPath: string;
  readonly argv: readonly string[];
  readonly profile: HostProfile;
}): Readonly<{ executable: string; profileRoot: string; launchArguments: readonly ["--dev-profile", string] }> | undefined {
  const build = buildIdentitySchema.safeParse(input.build), profile = input.profile;
  if (!build.success || build.data.kind !== "development" || input.platform !== "linux" || input.packaged !== true ||
      profile.appId !== "io.github.whisperfree.dev" || profile.flags.autostart !== false || profile.flags.stableUpdater !== false ||
      !fixedPath(input.executable) || !fixedPath(input.resourcesPath) || !fixedPath(input.appPath) ||
      basename(input.executable) !== "openwhisper-dev" || dirname(input.resourcesPath) !== dirname(input.executable) ||
      input.resourcesPath !== join(dirname(input.executable), "resources") || input.appPath !== join(input.resourcesPath, "app")) return undefined;

  const root = dirname(profile.roots.config);
  if (!fixedPath(root) || profile.roots.config !== join(root, "config") || profile.roots.data !== join(root, "data") ||
      profile.roots.cache !== join(root, "cache") || input.argv.length !== 3 || input.argv[0] !== input.executable ||
      input.argv[1] !== "--dev-profile" || input.argv[2] !== root) return undefined;
  return Object.freeze({ executable: input.executable, profileRoot: root, launchArguments: Object.freeze(["--dev-profile", root] as const) });
}

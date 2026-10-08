import { lstatSync, mkdirSync } from "node:fs";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/profiles.js";
import { FixtureError, suiteSchema } from "./contract.js";

export const HOME = "/home/tester/retirement-home";
export const PROFILE = `${HOME}/dev-profile`;
const forbiddenEnvironmentKeys = ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE", "ELECTRON_OVERRIDE_DIST_PATH", "LD_PRELOAD",
  "LD_LIBRARY_PATH", "DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS", "PULSE_SERVER", "PIPEWIRE_REMOTE", "WAYLAND_DISPLAY"] as const;
type ForbiddenEnvironmentKey = typeof forbiddenEnvironmentKeys[number];
class ForbiddenEnvironmentError extends FixtureError {
  constructor(readonly key: ForbiddenEnvironmentKey) { super(); }
}
type BootstrapRuntimeIdentity = Readonly<{ processType: string | null; electronVersion: string | null; executable: string }>;
export function assertNoForbiddenEnvironment(environment: Readonly<NodeJS.ProcessEnv>, runtime?: BootstrapRuntimeIdentity): void {
  for (const key of forbiddenEnvironmentKeys) {
    // Chromium 152 content/app/content_main.cc disables D-Bus autolaunch during browser startup.
    // Only that exact runtime-owned sentinel is allowed; inherited service addresses remain errors.
    if (key === "DBUS_SESSION_BUS_ADDRESS" && environment[key] === "disabled:" && runtime?.processType === "browser" &&
      runtime.electronVersion === "44.7.0" && runtime.executable === "/owned-runtime/electron/electron") continue;
    if (Object.hasOwn(environment, key)) throw new ForbiddenEnvironmentError(key);
  }
}
/** Fixed key names only: never include environment values or arbitrary error text. */
export function bootstrapFailureMetadata(error: unknown):
  { category: "FORBIDDEN_ENVIRONMENT_KEY"; key: ForbiddenEnvironmentKey } | { category: "BOOTSTRAP_FAILED" } {
  if (error instanceof ForbiddenEnvironmentError) return { category: "FORBIDDEN_ENVIRONMENT_KEY", key: error.key };
  return { category: "BOOTSTRAP_FAILED" };
}
export function prepareOwnedEnvironment() {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000 ||
    process.env.OPENWHISPER_OWNED_RETIREMENT_TEST !== "1" || process.env.HOME !== HOME ||
    process.env.XDG_CONFIG_HOME !== `${HOME}/config` || process.env.XDG_DATA_HOME !== `${HOME}/data` ||
    process.env.XDG_CACHE_HOME !== `${HOME}/cache` || process.env.TMPDIR !== `${HOME}/tmp`) throw new FixtureError();
  // Runtime identity comes only from this process, never fixture input or child replies.
  assertNoForbiddenEnvironment(process.env, { processType: "type" in process && typeof process.type === "string" ? process.type : null,
    electronVersion: process.versions.electron ?? null, executable: process.execPath });
  const suite = suiteSchema.parse(process.env.OPENWHISPER_RETIREMENT_SUITE);
  for (const path of [HOME, `${HOME}/tmp`, `${HOME}/runtime`]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 1000 || (stat.mode & 0o7777) !== 0o700) throw new FixtureError();
  }
  const profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ home: HOME, configHome: `${HOME}/config`,
    dataHome: `${HOME}/data`, cacheHome: `${HOME}/cache`, explicitRoot: PROFILE }));
  return { profile, suite };
}

import { lstatSync, mkdirSync } from "node:fs";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/profiles.js";
import { SPEECH_EXCLUDED_ENVIRONMENT } from "../../src/main/linux-speech-host.js";
import { assertNoForbiddenEnvironment } from "../owned-retirement/bootstrap.js";
import { HOME, PROFILE, RECORDING_ENVIRONMENT_KEY } from "./contracts.js";

/** Before ready, with no inherited desktop/audio/credential environment. */
export function prepareEnvironment() {
  if (process.type !== "browser" || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000 ||
    process.versions.electron !== "44.7.0" || process.execPath !== "/owned-runtime/electron/electron" ||
    process.env[RECORDING_ENVIRONMENT_KEY] !== "1" || process.env.HOME !== HOME || process.env.TMPDIR !== `${HOME}/tmp` ||
    process.env.XDG_CONFIG_HOME !== `${HOME}/config` || process.env.XDG_DATA_HOME !== `${HOME}/data` ||
    process.env.XDG_CACHE_HOME !== `${HOME}/cache` || process.env.XDG_RUNTIME_DIR !== `${HOME}/runtime` ||
    !/^:\d+$/u.test(process.env.DISPLAY ?? "")) throw new Error("BOOTSTRAP_FAILED");
  assertNoForbiddenEnvironment(process.env, { processType: process.type, electronVersion: process.versions.electron, executable: process.execPath });
  for (const name of SPEECH_EXCLUDED_ENVIRONMENT) if (Object.hasOwn(process.env, name)) throw new Error("BOOTSTRAP_FAILED");
  for (const path of [HOME, `${HOME}/tmp`, `${HOME}/runtime`]) {
    mkdirSync(path, { recursive: true, mode: 0o700 }); const value = lstatSync(path);
    if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== 1000 || (value.mode & 0o7777) !== 0o700) throw new Error("BOOTSTRAP_FAILED");
  }
  return prepareDevelopmentProfile(resolveDevelopmentProfile({ home: HOME, configHome: `${HOME}/config`, dataHome: `${HOME}/data`, cacheHome: `${HOME}/cache`, explicitRoot: PROFILE }));
}

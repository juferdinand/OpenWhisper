import { lstatSync, mkdirSync } from "node:fs";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/settings/profiles.js";
import { assertNoForbiddenEnvironment } from "../owned-retirement/bootstrap.js";
import { SPEECH_EXCLUDED_ENVIRONMENT } from "../../src/main/linux-speech-host.js";
import { HOME, PROFILE_ROOT, FixtureError, profileSchema } from "./contract.js";

export function prepareEnvironment() {
  if (process.type !== "browser" || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000 ||
      process.versions.electron !== "44.7.0" || process.execPath !== "/owned-runtime/electron/electron" ||
      process.env.OPENWHISPER_OWNED_SUPERVISOR_FALLBACK !== "1" || !profileSchema.safeParse(process.env.OPENWHISPER_FALLBACK_PROFILE).success ||
      process.env.HOME !== HOME || process.env.TMPDIR !== `${HOME}/tmp` || process.env.XDG_CONFIG_HOME !== `${HOME}/config` ||
      process.env.XDG_DATA_HOME !== `${HOME}/data` || process.env.XDG_CACHE_HOME !== `${HOME}/cache` || process.env.XDG_RUNTIME_DIR !== `${HOME}/runtime`) throw new FixtureError();
  assertNoForbiddenEnvironment(process.env, { processType: process.type, electronVersion: process.versions.electron, executable: process.execPath });
  for (const key of Object.keys(process.env)) if (SPEECH_EXCLUDED_ENVIRONMENT.includes(key) || /^(?:VK_|GGML_VK_|LD_)/u.test(key)) throw new FixtureError();
  for (const path of [HOME, `${HOME}/tmp`, `${HOME}/runtime`]) {
    mkdirSync(path, { mode: 0o700, recursive: true }); const status = lstatSync(path);
    if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== 1000 || (status.mode & 0o7777) !== 0o700) throw new FixtureError();
  }
  return prepareDevelopmentProfile(resolveDevelopmentProfile({ home: HOME, configHome: `${HOME}/config`, dataHome: `${HOME}/data`, cacheHome: `${HOME}/cache`, explicitRoot: PROFILE_ROOT }));
}

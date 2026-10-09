import { prepareDevelopmentProfile, type DevelopmentProfile } from "./profiles.js";
import { prepareStableProfile, type StableProfile } from "./stable-profile.js";

export type HostProfile = DevelopmentProfile | StableProfile;

/** Host-only dispatch preserves each resolver's in-process provenance and filesystem policy. */
export function prepareHostProfile(profile: HostProfile): HostProfile {
  return profile.appId === "io.github.whisperfree" ? prepareStableProfile(profile) : prepareDevelopmentProfile(profile);
}

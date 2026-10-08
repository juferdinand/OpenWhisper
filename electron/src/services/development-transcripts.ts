import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { prepareDevelopmentProfile, type DevelopmentProfile } from "./profiles.js";

/** Preserve complete output outside the bounded UI preview, in the isolated private profile. */
export async function saveDevelopmentTranscript(profile: DevelopmentProfile, text: string): Promise<void> {
  prepareDevelopmentProfile(profile);
  const path = join(profile.paths.transcripts, `${randomUUID()}.txt`), temporary = `${path}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(text, "utf8"); await file.sync(); await file.close(); file = undefined;
    prepareDevelopmentProfile(profile);
    await rename(temporary, path);
    const directory = await open(profile.paths.transcripts, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close(); prepareDevelopmentProfile(profile); await rm(temporary, { force: true });
  }
}

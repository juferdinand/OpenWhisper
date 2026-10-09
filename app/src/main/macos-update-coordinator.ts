import type { BuildIdentity } from "../contracts/application/build-identity.js";
import { readUpdateFeed } from "../services/update/common/update-feed.js";
import { downloadUpdateCandidate, UpdateDownloadError } from "../services/update/common/update-download.js";
import { cleanupMacUpdateArchiveDownload, extractVerifiedMacUpdateArchive } from "../services/update/macos/macos-update-archive.js";
import { prepareMacosUpdateInstall, type PreparedMacosUpdateInstall } from "../services/update/macos/macos-update-install.js";
import { projectMacosUpdateRelease, type MacosUpdateCandidate } from "../services/update/common/update-policy.js";
import type { OwnedUpdateDownload } from "../services/update/common/update-staging.js";
import type { ExtractedMacUpdate } from "../services/update/macos/macos-update-archive.js";
import type { MacosUpdateAdmission } from "./macos-update-admission.js";

type Failure = "UNAVAILABLE" | "BUSY" | "CANCELLED" | "CLEANUP_FAILED" | "ROLLBACK_FAILED";
export class MacosUpdateCoordinatorError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "MacosUpdateCoordinatorError"; }
}
const fail = (code: Failure): never => { throw new MacosUpdateCoordinatorError(code); };
/** Trusted effects for owned tests only; no renderer or package input supplies implementations. */
export interface MacosUpdateCoordinatorEffects {
  read: typeof readUpdateFeed;
  download: typeof downloadUpdateCandidate;
  extract: typeof extractVerifiedMacUpdateArchive;
  prepare: typeof prepareMacosUpdateInstall;
  cleanup: typeof cleanupMacUpdateArchiveDownload;
}

/** The caller has already admitted the running persistent publisher and owns UI/native lifetime. */
export function createMacosUpdateCoordinator(input: Readonly<{ admission: MacosUpdateAdmission; identity: BuildIdentity;
  currentVersion: string; cacheDirectory: string }>, effects: Partial<MacosUpdateCoordinatorEffects> = {}) {
  const { currentVersion, cacheDirectory } = input;
  const identity = Object.freeze({ ...input.identity }), admission = Object.freeze({ ...input.admission });
  if (identity.kind !== "stable" || admission.repository !== "juferdinand/OpenWhisper") fail("UNAVAILABLE");
  const io: MacosUpdateCoordinatorEffects = { read: readUpdateFeed, download: downloadUpdateCandidate,
    extract: extractVerifiedMacUpdateArchive, prepare: prepareMacosUpdateInstall, cleanup: cleanupMacUpdateArchiveDownload, ...effects };
  let candidate: MacosUpdateCandidate | undefined, busy = false;
  let failedDownloadCleanup: (() => Promise<void>) | undefined, cleanupTask: Promise<void> | undefined;
  let failedOwnersSettled: (() => boolean) | undefined;
  const active = (signal: AbortSignal): void => { if (signal.aborted) fail("CANCELLED"); };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (busy) fail("BUSY"); busy = true;
    try { if (failedDownloadCleanup) fail("CLEANUP_FAILED"); return await operation(); } finally { busy = false; }
  };
  const check = (signal: AbortSignal): Promise<MacosUpdateCandidate | undefined> => run(async () => {
    candidate = undefined; active(signal);
    const found = await io.read({ package: "macos", repository: admission.repository, currentVersion, signal });
    active(signal);
    if (found) {
      if (found.package !== "macos" || found.repository !== admission.repository) fail("UNAVAILABLE");
      // Copy through the existing exact source/version projection; retain no mutable feed object.
      candidate = projectMacosUpdateRelease({ repository: admission.repository, currentVersion,
        release: { tag_name: `v${found.version}`, html_url: found.pageURL, body: found.notes, draft: false, prerelease: false,
          assets: [{ name: found.assetName, browser_download_url: found.assetURL }] } });
    }
    return candidate;
  });
  const prepareInstall = (signal: AbortSignal): Promise<Readonly<PreparedMacosUpdateInstall>> => run(async () => {
    active(signal); const selected = candidate; candidate = undefined;
    if (!selected) return fail("UNAVAILABLE");
    let download: Readonly<OwnedUpdateDownload> | undefined, extracted: Readonly<ExtractedMacUpdate> | undefined;
    let prepared: Readonly<PreparedMacosUpdateInstall> | undefined, failed = false, failure: unknown;
    try {
      download = await io.download({ candidate: selected, repository: admission.repository, currentVersion, cacheDirectory, signal }); active(signal);
      extracted = await io.extract({ download, build: identity, expectedVersion: selected.version, currentVersion }); active(signal);
      prepared = await io.prepare({ download, extracted, build: identity, currentBundle: admission.bundle,
        currentVersion, expectedVersion: selected.version }); active(signal);
    } catch (error: unknown) {
      if (!download && error instanceof UpdateDownloadError && error.cleanup) {
        failedDownloadCleanup = error.cleanup; failedOwnersSettled = error.ownersSettled;
      }
      failed = true; failure = error;
    }
    // The copied transaction is independent of these originals. No original descriptor survives handoff.
    if (download) {
      try { await io.cleanup(extracted, download); }
      catch {
        const originalDownload = download, originalExtraction = extracted;
        failedDownloadCleanup = () => io.cleanup(originalExtraction, originalDownload);
        failedOwnersSettled = originalDownload.ownersSettled;
        failed = true; failure = new MacosUpdateCoordinatorError("CLEANUP_FAILED");
      }
    }
    if (signal.aborted && !failed) { failed = true; failure = new MacosUpdateCoordinatorError("CANCELLED"); }
    if (failed) {
      if (prepared) {
        try { await prepared.discard(); }
        catch { throw new MacosUpdateCoordinatorError("CLEANUP_FAILED"); }
      }
      throw failure;
    }
    return prepared!;
  });
  const finalize = (): Promise<void> => {
    if (cleanupTask) return cleanupTask;
    const original = failedDownloadCleanup;
    if (!original) return Promise.resolve();
    const task = Promise.resolve().then(original).then(() => {
      if (failedDownloadCleanup === original) { failedDownloadCleanup = undefined; failedOwnersSettled = undefined; }
    });
    cleanupTask = task;
    void task.then(() => { if (cleanupTask === task) cleanupTask = undefined; },
      () => { if (cleanupTask === task) cleanupTask = undefined; });
    return task;
  };
  const settleForQuit = async (): Promise<void> => {
    try { await finalize(); }
    catch (error: unknown) {
      let settled = false;
      try { settled = failedDownloadCleanup !== undefined && failedOwnersSettled?.() === true; } catch { /* Unknown owner facts refuse Quit settlement. */ }
      if (!settled) throw error;
      // Only uncertain filesystem children remain; preserve them without trapping ordinary Quit.
    }
  };
  return Object.freeze({ check, prepareInstall, finalize, settleForQuit });
}

/** Exactly one same-session handoff, after the caller's original native owners have retired.
 * A queued relaunch has no successor acknowledgment; the predecessor remains retained after success. */
export async function handoffMacosUpdate(prepared: Readonly<PreparedMacosUpdateInstall>, effects: Readonly<{
  retire(): Promise<void>; relaunch(): void;
}>): Promise<void> {
  let installed = false;
  try {
    await effects.retire();
    await prepared.install(); installed = true;
    prepared.assertForRelaunch(); effects.relaunch();
  } catch (error: unknown) {
    if (installed) {
      try { await prepared.rollback(); }
      catch { throw new MacosUpdateCoordinatorError("ROLLBACK_FAILED"); }
    }
    // Refuses unknown/failed transactions rather than deleting uncertain backups or foreign children.
    try { await prepared.discard(); }
    catch { throw new MacosUpdateCoordinatorError("CLEANUP_FAILED"); }
    throw error;
  }
}

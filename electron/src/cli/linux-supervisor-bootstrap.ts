import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { APPLICATION_BUILD } from "../main/application-build.js";
import { selectApplicationBuild } from "../main/build-selection.js";
import { admitLinuxInstalledLaunch, ensureLinuxAppImageLauncher, type LinuxInstalledLaunch } from "../main/linux-installed-launch.js";
import { LinuxRestartError } from "../main/linux-restart.js";
import { readCurrentAppImageSignature, readUpdateFeed } from "../services/update-feed.js";
import { downloadUpdateCandidate, UpdateDownloadError } from "../services/update-download.js";
import { prepareDebianUpdate, type PreparedDebianUpdate } from "../services/linux-debian-update.js";
import { assertCanonicalInstalledDebianVersion, prepareDebianInstalledAudit } from "../services/linux-debian-installed.js";
import { admitSignedAppImageLaunch, prepareAppImageUpdate, repairSignedAppImageLaunch,
  type AppImageExecContinuation, type PreparedAppImageUpdate } from "../services/linux-appimage-update.js";
import { resolveStableProfile, validateStableProfile } from "../services/stable-profile.js";
import type { LinuxUpdateCandidate } from "../services/update-policy.js";
import type { OwnedUpdateDownload } from "../services/update-staging.js";
import { bypassLinuxControl, execLinuxGui, runLinuxSupervisor, type LinuxSupervisorEffects, type LinuxSupervisorUpdates } from "./linux-supervisor.js";
export { linuxSupervisorLauncher } from "./linux-supervisor.js";

interface BootstrapContext { readonly version: string; readonly launch: LinuxInstalledLaunch | undefined; readonly updates?: LinuxSupervisorUpdates }
type PrepareBootstrap = (argv: readonly string[]) => Promise<BootstrapContext>;

/** All executable/source authority stays in this parent, never in a GUI frame or preference. */
function debianUpdates(currentVersion: string): LinuxSupervisorUpdates {
  const profile = resolveStableProfile({ platform: "linux", home: homedir(),
    ...(process.env.XDG_CONFIG_HOME ? { configHome: process.env.XDG_CONFIG_HOME } : {}),
    ...(process.env.XDG_DATA_HOME ? { dataHome: process.env.XDG_DATA_HOME } : {}),
    ...(process.env.XDG_CACHE_HOME ? { cacheHome: process.env.XDG_CACHE_HOME } : {}) });
  let candidate: LinuxUpdateCandidate | undefined, download: Readonly<OwnedUpdateDownload> | undefined;
  let prepared: Readonly<PreparedDebianUpdate> | undefined, audit: Awaited<ReturnType<typeof prepareDebianInstalledAudit>> | undefined;
  let failedCleanup: (() => Promise<void>) | undefined, installationStarted = false;
  const discardPrepared = async (): Promise<void> => {
    // A failed privileged transaction may have changed the installed tree. Keep its source for explicit recovery.
    if (installationStarted) return;
    await failedCleanup?.(); failedCleanup = undefined;
    await download?.cleanup(); download = undefined; prepared = undefined; audit = undefined;
  };
  return Object.freeze({
    async action(kind: "check" | "install", signal: AbortSignal) {
      if (installationStarted) throw new LinuxRestartError("INVALID_REQUEST");
      validateStableProfile(profile);
      const active = (): void => { if (signal.aborted) throw new LinuxRestartError("INVALID_REQUEST"); };
      active();
      if (kind === "check") {
        await discardPrepared(); candidate = undefined;
        const result = await readUpdateFeed({ package: "deb", currentVersion, signal }); active();
        if (!result) return { status: "idle" } as const;
        if (result.package !== "deb") throw new LinuxRestartError("INVALID_REQUEST");
        candidate = result; return { status: "available", updateVersion: result.version } as const;
      }
      const selected = candidate;
      if (!selected || download || prepared || failedCleanup) throw new LinuxRestartError("INVALID_REQUEST");
      try {
        download = await downloadUpdateCandidate({ candidate: selected, currentVersion, cacheDirectory: profile.paths.cache, signal }); active();
        prepared = await prepareDebianUpdate({ download, signature: selected.signature, currentVersion, expectedVersion: selected.version }); active();
        audit = await prepareDebianInstalledAudit({ download, signature: selected.signature, expectedVersion: selected.version, signal }); active();
        return { status: "prepared", updateVersion: selected.version } as const;
      } catch (error: unknown) {
        if (error instanceof UpdateDownloadError) failedCleanup = error.cleanup;
        await discardPrepared(); throw error;
      }
    },
    async installPrepared(version: string) {
      if (installationStarted || !candidate || !download || !prepared || !audit ||
          version !== candidate.version || version !== prepared.version) throw new LinuxRestartError("INVALID_REQUEST");
      installationStarted = true;
      await prepared.install();
      await audit.assertInstalled();
      await download.assertUnchanged();
      // All long hashing, original child joins and staged source closure finish before the synchronous final exec check.
      await download.cleanup(); download = undefined;
      return Object.freeze({ assertForExec: audit.assertForExec });
    }, discardPrepared,
  });
}

/** Trusted host seams only; none of these callbacks or inputs are supplied by channel frames. */
interface AppImageUpdateDependencies {
  home: typeof homedir;
  admit: typeof admitSignedAppImageLaunch;
  repair: typeof repairSignedAppImageLaunch;
  signature: typeof readCurrentAppImageSignature;
  feed: typeof readUpdateFeed;
  download: typeof downloadUpdateCandidate;
  prepare: typeof prepareAppImageUpdate;
}
const appImageDependencies: AppImageUpdateDependencies = { home: homedir, admit: admitSignedAppImageLaunch, repair: repairSignedAppImageLaunch,
  signature: readCurrentAppImageSignature, feed: readUpdateFeed, download: downloadUpdateCandidate, prepare: prepareAppImageUpdate };

/** An optional check channel is not installation authority. Only the signed current pair can prepare a successor. */
export function appImageUpdates(currentVersion: string, launch: Extract<LinuxInstalledLaunch, { kind: "appimage" }>,
  dependencies: AppImageUpdateDependencies = appImageDependencies): LinuxSupervisorUpdates {
  dependencies = Object.freeze({ ...dependencies });
  launch = Object.freeze({ ...launch, arguments: Object.freeze([launch.arguments[0]] as const) });
  const home = dependencies.home(), profile = resolveStableProfile({ platform: "linux", home,
    ...(process.env.XDG_CONFIG_HOME ? { configHome: process.env.XDG_CONFIG_HOME } : {}),
    ...(process.env.XDG_DATA_HOME ? { dataHome: process.env.XDG_DATA_HOME } : {}),
    ...(process.env.XDG_CACHE_HOME ? { cacheHome: process.env.XDG_CACHE_HOME } : {}) });
  let current: Awaited<ReturnType<typeof admitSignedAppImageLaunch>> | undefined;
  let candidate: LinuxUpdateCandidate | undefined, download: Readonly<OwnedUpdateDownload> | undefined;
  let prepared: Readonly<PreparedAppImageUpdate> | undefined, continuation: Readonly<AppImageExecContinuation> | undefined;
  let failedCleanup: (() => Promise<void>) | undefined, installationStarted = false;
  const discardPrepared = async (): Promise<void> => {
    if (installationStarted) return; // Keep uncertain installed state and original recovery evidence.
    await prepared?.discard(); prepared = undefined;
    await failedCleanup?.(); failedCleanup = undefined;
    await download?.cleanup(); download = undefined;
  };
  return Object.freeze({
    async action(kind: "check" | "install", signal: AbortSignal) {
      if (installationStarted) throw new LinuxRestartError("INVALID_REQUEST");
      validateStableProfile(profile);
      const active = (): void => { if (signal.aborted) throw new LinuxRestartError("INVALID_REQUEST"); };
      active();
      if (kind === "check") {
        await discardPrepared(); candidate = undefined; current = undefined;
        try { current = await dependencies.admit({ home, version: currentVersion, launch }); }
        catch {
          active(); const signature = await dependencies.signature({ currentVersion, signal }); active();
          current = await dependencies.repair({ home, version: currentVersion, launch, signature });
        }
        active(); current.assertUnchanged();
        const result = await dependencies.feed({ package: "appimage", currentVersion, signal }); active(); current.assertUnchanged();
        if (!result) return { status: "idle" } as const;
        if (result.package !== "appimage") throw new LinuxRestartError("INVALID_REQUEST");
        candidate = result; return { status: "available", updateVersion: result.version } as const;
      }
      const selected = candidate;
      if (!selected || !current || download || prepared || failedCleanup) throw new LinuxRestartError("INVALID_REQUEST");
      current.assertUnchanged();
      try {
        download = await dependencies.download({ candidate: selected, currentVersion, cacheDirectory: profile.paths.cache, signal });
        active(); current.assertUnchanged();
        prepared = await dependencies.prepare({ download, signature: selected.signature, expectedVersion: selected.version,
          currentVersion, home, launch }); active(); current.assertUnchanged();
        return { status: "prepared", updateVersion: selected.version } as const;
      } catch (error: unknown) {
        if (error instanceof UpdateDownloadError) failedCleanup = error.cleanup;
        await discardPrepared(); throw error;
      }
    },
    async installPrepared(version: string) {
      if (installationStarted || !current || !candidate || !download || !prepared ||
          version !== candidate.version || version !== prepared.version) throw new LinuxRestartError("INVALID_REQUEST");
      current.assertUnchanged(); installationStarted = true;
      let installed = false;
      try {
        await prepared.install(); installed = true;
        continuation = await prepared.prepareExecContinuation();
        await continuation.assertInstalledForExec(); await download.assertUnchanged();
        await download.cleanup(); download = undefined;
        return Object.freeze({ assertForExec: continuation.assertForExec, rollbackBeforeExec: continuation.rollbackBeforeExec });
      } catch (error: unknown) {
        // Failed install owns its rollback. After successful replacement, restore only the same transaction's originals.
        if (continuation) await continuation.rollbackBeforeExec();
        else if (installed) await prepared.rollback();
        throw error;
      }
    }, discardPrepared,
  });
}

/** Fixed stable entry only. The parent never imports Electron main, migrates a profile or opens audio. */
async function preparePackagedSupervisor(argv: readonly string[]): Promise<BootstrapContext> {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === undefined || process.getuid() === 0 ||
      basename(process.execPath) !== "openwhisper") throw new LinuxRestartError("UNAVAILABLE");
  const executable = await realpath(process.execPath), resourcesPath = join(dirname(executable), "resources");
  const appPath = join(resourcesPath, "app"), distribution = join(appPath, "dist");
  if (await realpath(resourcesPath) !== resourcesPath || await realpath(appPath) !== appPath ||
      await realpath(distribution) !== distribution ||
      fileURLToPath(import.meta.url) !== join(distribution, "cli/linux-supervisor-bootstrap.js")) throw new LinuxRestartError("UNAVAILABLE");
  const version = (await readFile(join(distribution, "resources/VERSION"), "utf8")).trim();
  const metadata: unknown = JSON.parse(await readFile(join(appPath, "package.json"), "utf8"));
  const identity = selectApplicationBuild({ build: APPLICATION_BUILD, argv: [executable, ...argv],
    platform: process.platform, architecture: process.arch, packaged: true, executable, appPath, resourcesPath, distribution,
    projectVersion: version, packageVersion: z.object({ version: z.string() }).parse(metadata).version });
  if (identity.kind !== "stable") throw new LinuxRestartError("UNAVAILABLE");
  const installedInput = { build: identity, packaged: true, executable, appPath, resourcesPath,
    home: homedir(), environment: process.env, pid: process.pid };
  let launch = await admitLinuxInstalledLaunch(installedInput);
  if (!launch && process.env.APPIMAGE) {
    try { await ensureLinuxAppImageLauncher(installedInput); launch = await admitLinuxInstalledLaunch(installedInput); }
    catch { /* A local missing-launcher repair is optional and never opens a network connection. */ }
  }
  let updates: LinuxSupervisorUpdates | undefined;
  if (launch?.kind === "debian") {
    // Stable preview packages retain ~dev dpkg versions and must not acquire the release update capability.
    try { await assertCanonicalInstalledDebianVersion(version); updates = debianUpdates(version); }
    catch { /* Optional update admission must not prevent ordinary dictation. */ }
  }
  if (launch?.kind === "appimage") {
    try { updates = appImageUpdates(version, launch); }
    catch { /* Optional update admission must not prevent ordinary dictation. */ }
  }
  return Object.freeze({ version, launch, ...(updates ? { updates } : {}) });
}

/** The seams are host-owned tests, never IPC or user preferences. Unadmitted launches keep their ordinary V1 path. */
export async function bootstrapLinuxSupervisor(argv: readonly string[], prepare: PrepareBootstrap = preparePackagedSupervisor,
  effects?: LinuxSupervisorEffects): Promise<number> {
  if (bypassLinuxControl(argv, effects)) throw new LinuxRestartError("EXEC_FAILED");
  const context = await prepare(argv);
  // A downloaded image can still run normally. An unadmitted location has no permanent restart target.
  if (!context.launch) return execLinuxGui(argv, effects);
  return runLinuxSupervisor({ launch: context.launch, currentVersion: context.version, argv,
    ...(context.updates ? { updates: context.updates } : {}),
    revalidateReplacement: async () => { throw new LinuxRestartError("REVALIDATION_FAILED"); } }, effects);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await bootstrapLinuxSupervisor(process.argv.slice(2)); }
  catch { process.stderr.write("OpenWhisper could not complete its Linux launch.\n"); process.exitCode = 1; }
}

import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { APPLICATION_BUILD } from "../main/application-build.js";
import { selectApplicationBuild } from "../main/build-selection.js";
import { admitLinuxInstalledLaunch, type LinuxInstalledLaunch } from "../main/linux-installed-launch.js";
import { LinuxRestartError } from "../main/linux-restart.js";
import { bypassLinuxControl, execLinuxGui, runLinuxSupervisor, type LinuxSupervisorEffects } from "./linux-supervisor.js";

interface BootstrapContext { readonly version: string; readonly launch: LinuxInstalledLaunch | undefined }
type PrepareBootstrap = (argv: readonly string[]) => Promise<BootstrapContext>;

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
  const launch = await admitLinuxInstalledLaunch({ build: identity, packaged: true, executable, appPath, resourcesPath,
    home: homedir(), environment: process.env, pid: process.pid });
  return Object.freeze({ version, launch });
}

/** The seams are host-owned tests, never IPC or user preferences. Installation authority remains disabled. */
export async function bootstrapLinuxSupervisor(argv: readonly string[], prepare: PrepareBootstrap = preparePackagedSupervisor,
  effects?: LinuxSupervisorEffects): Promise<number> {
  if (bypassLinuxControl(argv, effects)) throw new LinuxRestartError("EXEC_FAILED");
  const context = await prepare(argv);
  // A downloaded image can still run normally. An unadmitted location has no permanent restart target.
  if (!context.launch) return execLinuxGui(argv, effects);
  return runLinuxSupervisor({ launch: context.launch, currentVersion: context.version, argv,
    revalidateReplacement: async () => { throw new LinuxRestartError("REVALIDATION_FAILED"); } }, effects);
}

/** Exact shell entries for packaged Stable only; quotes preserve each original application argument. */
export function linuxSupervisorLauncher(kind: "debian" | "appimage"): string {
  const environment = ["unset NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE ELECTRON_NO_ASAR", "ELECTRON_RUN_AS_NODE=1", "export ELECTRON_RUN_AS_NODE"];
  if (kind === "debian") return ["#!/bin/sh", "set -eu", ...environment,
    'exec /opt/openwhisper/openwhisper /opt/openwhisper/resources/app/dist/cli/linux-supervisor-bootstrap.js "$@"', ""].join("\n");
  return ["#!/bin/sh", "set -eu", ...environment, 'bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'exec "$bundle/usr/lib/openwhisper/openwhisper" "$bundle/usr/lib/openwhisper/resources/app/dist/cli/linux-supervisor-bootstrap.js" "$@"', ""].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await bootstrapLinuxSupervisor(process.argv.slice(2)); }
  catch { process.stderr.write("OpenWhisper could not complete its Linux launch.\n"); process.exitCode = 1; }
}

import { spawn } from "node:child_process";
import { join } from "node:path";
import { verifyOwnedLinuxUpdateFile } from "./linux-update-file.js";
import { isNewerUpdateVersion, parseUpdateVersion } from "../common/update-policy.js";
import { inspectOwnedUpdateFile, type OwnedUpdateDownload } from "../common/update-staging.js";

type Failure = "INVALID_INPUT" | "METADATA_FAILED" | "INVALID_PACKAGE" | "SOURCE_CHANGED" | "INSTALL_CANCELLED" | "INSTALL_FAILED";
export class LinuxDebianUpdateError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "LinuxDebianUpdateError"; }
}
const fail = (code: Failure): never => { throw new LinuxDebianUpdateError(code); };
const artifactName = "OpenWhisper-Linux-amd64.deb";
const metadataFormat = "${Package}\\n${Version}\\n${Architecture}\\n";

/** Fixed dpkg-deb output only; these fields alone do not authenticate a package. */
export function validateDebianUpdateMetadata(output: unknown, expectedVersion: unknown): void {
  try { parseUpdateVersion(expectedVersion); } catch { return fail("INVALID_INPUT"); }
  if (typeof output !== "string" || output !== `io-github-whisperfree\n${String(expectedVersion)}\namd64\n`) fail("INVALID_PACKAGE");
}

function readMetadata(descriptor: number): Promise<string> {
  return new Promise((accept, reject) => {
    let failed = false, output = Buffer.alloc(0);
    const child = spawn("/usr/bin/dpkg-deb", [`--showformat=${metadataFormat}`, "--show", "/proc/self/fd/3"], {
      shell: false, detached: true, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore", descriptor],
    });
    const stop = (): void => {
      failed = true;
      // Only the owned, unprivileged metadata process group is terminated.
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Await original close even if already gone. */ } }
    };
    const timer = setTimeout(stop, 10_000);
    child.on("error", () => { failed = true; });
    child.stdout?.on("error", stop);
    child.stdout?.on("data", (bytes: Buffer) => {
      if (bytes.length > 4096 - output.length) stop(); else output = Buffer.concat([output, bytes]);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failed || code !== 0 || signal !== null) { reject(new LinuxDebianUpdateError("METADATA_FAILED")); return; }
      try { accept(new TextDecoder("utf-8", { fatal: true }).decode(output)); }
      catch { reject(new LinuxDebianUpdateError("METADATA_FAILED")); }
    });
  });
}

function installPackage(path: string): Promise<number> {
  const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XAUTHORITY", "XDG_SESSION_ID"]) {
    const value = process.env[key]; if (value !== undefined) environment[key] = value;
  }
  return new Promise((accept, reject) => {
    let failed = false;
    const child = spawn("/usr/bin/pkexec", ["/usr/bin/dpkg", "--install", path], {
      shell: false, env: environment, stdio: "ignore",
    });
    child.on("error", () => { failed = true; });
    // Never kill a privileged package transaction or remove its source while it runs.
    // Polkit owns authentication; a dismissed dialog returns 126, without fallback.
    child.once("close", (code, signal) => {
      if (failed || code === null || signal !== null) reject(new LinuxDebianUpdateError("INSTALL_FAILED"));
      else accept(code);
    });
  });
}

/** Host-test effects only. Production uses fixed system programs and no shell or package diagnostics. */
export interface DebianUpdateEffects {
  metadata(originalDescriptor: number): Promise<string>;
  install(privatePackagePath: string): Promise<number>;
}
export interface PreparedDebianUpdate {
  readonly version: string;
  readonly bytes: number;
  /** One original transaction. Success does not establish application retirement, restart or rollback. */
  install(): Promise<void>;
  assertUnchanged(): Promise<void>;
}

/** Borrow a settled private download until its original metadata/install child closes.
 * The caller keeps cleanup ownership and captures the permanent launch target before installation.
 * Signature/version admission is repeated here; an earlier observation is not installation authority. */
export async function prepareDebianUpdate(input: {
  readonly download: OwnedUpdateDownload; readonly signature: unknown;
  readonly expectedVersion: string; readonly currentVersion: string;
}, effects: Partial<DebianUpdateEffects> = {}): Promise<Readonly<PreparedDebianUpdate>> {
  const { download, expectedVersion, currentVersion } = input;
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === undefined || process.getuid() === 0 ||
      download.artifactName !== artifactName || !isNewerUpdateVersion(expectedVersion, currentVersion)) return fail("INVALID_INPUT");
  const io: DebianUpdateEffects = { metadata: readMetadata, install: installPackage, ...effects };
  const original = await inspectOwnedUpdateFile(download);
  const assertUnchanged = async (): Promise<void> => {
    try { await original.assertUnchanged(); await download.assertUnchanged(); }
    catch { fail("SOURCE_CHANGED"); }
  };
  await verifyOwnedLinuxUpdateFile({ ...download, artifactName, signature: input.signature, version: expectedVersion });
  await assertUnchanged();
  let metadata: string;
  try { metadata = await io.metadata(download.file.fd); }
  catch (error: unknown) { if (error instanceof LinuxDebianUpdateError) throw error; return fail("METADATA_FAILED"); }
  await assertUnchanged();
  validateDebianUpdateMetadata(metadata, expectedVersion);
  let installing: Promise<void> | undefined;
  const install = (): Promise<void> => installing ??= (async () => {
    await assertUnchanged();
    let code: number;
    try { code = await io.install(join(download.stageDirectory, artifactName)); }
    catch { return fail("INSTALL_FAILED"); }
    await assertUnchanged();
    if (code === 126) return fail("INSTALL_CANCELLED");
    if (code !== 0) return fail("INSTALL_FAILED");
  })();
  return Object.freeze({ version: expectedVersion, bytes: original.bytes, install, assertUnchanged });
}

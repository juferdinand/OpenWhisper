import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macosUpdatePublisherArguments } from "../src/main/macos-update-admission.js";
import { packageMacUniversal, verifyMacUniversalCopy } from "./package-macos-universal.js";
import { digestMacPreviewFile } from "./package-macos-preview.js";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tool(command: string, args: readonly string[], cwd?: string): void {
  const result = spawnSync(command, [...args], { ...(cwd ? { cwd } : {}), encoding: "utf8", stdio: "inherit", timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Mac release packaging tool failed: ${command} (${result.status ?? result.signal ?? "unknown"}).`);
}

export async function packageMacRelease(arm64AppPath: string, x64AppPath: string, output: string): Promise<{
  readonly application: string; readonly archive: string; readonly archiveSha256: string; readonly diskImage: string; readonly diskImageSha256: string;
}> {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64") || process.getuid?.() === 0) {
    throw new Error("Mac release packaging requires a non-root Darwin host.");
  }
  const identity = process.env["SIGN_IDENTITY"];
  if (typeof identity !== "string" || !/^[a-f0-9]{40}$/iu.test(identity)) throw new Error("Mac release packaging requires the configured persistent signing identity.");
  const packaged = await packageMacUniversal({ arm64AppPath, x64AppPath, output, signingMode: "persistent-validation",
    enableUpdates: true, constructionMode: "release" });
  const fingerprint = identity.toLowerCase();
  tool("/usr/bin/codesign", macosUpdatePublisherArguments(packaged.directory, fingerprint));
  const diskImage = join(output, "OpenWhisper-macOS.dmg"), temporary = await mkdtemp(join(resolve(output), ".dmg-stage-"));
  const mount = join(temporary, "mount"), installGuide = resolve(defaultRoot, "resources/Install.txt");
  let mounted = false;
  try {
    const imageRoot = join(temporary, "image"); await mkdir(imageRoot, { mode: 0o700 }); await mkdir(mount, { mode: 0o700 });
    tool("/usr/bin/ditto", [packaged.directory, join(imageRoot, "OpenWhisper.app")]);
    await symlink("/Applications", join(imageRoot, "Applications"));
    await cp(installGuide, join(imageRoot, "Install.txt"));
    tool("/usr/bin/hdiutil", ["create", "-quiet", "-volname", "OpenWhisper", "-srcfolder", imageRoot,
      "-fs", "HFS+", "-format", "UDZO", "-ov", diskImage]);
    tool("/usr/bin/codesign", ["--force", "--timestamp=none", "--sign", identity, diskImage]);
    tool("/usr/bin/hdiutil", ["verify", diskImage]);
    tool("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", diskImage]);
    tool("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, diskImage]); mounted = true;
    const shortcut = join(mount, "Applications"), mountedGuide = join(mount, "Install.txt");
    if (!(await lstat(shortcut)).isSymbolicLink() || await readlink(shortcut) !== "/Applications" ||
        !(await lstat(mountedGuide)).isFile() || !Buffer.from(await readFile(mountedGuide)).equals(await readFile(installGuide))) {
      throw new Error("Mac release disk image is missing its exact installer guide or Applications shortcut.");
    }
    const mountedApp = join(mount, "OpenWhisper.app");
    tool("/usr/bin/codesign", macosUpdatePublisherArguments(mountedApp, fingerprint));
    await verifyMacUniversalCopy(packaged.directory, mountedApp);
    return { application: packaged.directory, archive: packaged.archive, archiveSha256: packaged.sha256, diskImage,
      diskImageSha256: (await digestMacPreviewFile(diskImage)).sha256 };
  } finally {
    if (mounted) tool("/usr/bin/hdiutil", ["detach", mount, "-quiet"]);
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--arm64-app" || args[2] !== "--x64-app" || args[4] !== "--output" ||
      !args[1] || !args[3] || !args[5]) {
    throw new Error("Usage: package-macos-release.ts --arm64-app /owned/OpenWhisper.app --x64-app /owned/OpenWhisper.app --output /fresh/output");
  }
  console.log(JSON.stringify(await packageMacRelease(args[1], args[3], args[5])));
}

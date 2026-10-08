import { app, utilityProcess, webContents } from "electron";
import type { UtilityProcess } from "electron";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { envelopeSchema, progressSchema } from "./contracts.js";
import { z } from "zod";

const root = process.argv[2], entry = process.argv[3], binding = process.argv[4];
if (process.platform !== "darwin" || process.getuid?.() === 0 || process.env["GITHUB_ACTIONS"] !== "true"
  || !root || !entry || !binding || ![root, entry, binding].every((path) => isAbsolute(path) && !path.includes("\0"))) process.exit(1);
const metadata = await lstat(root);
if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o700
  || await realpath(root) !== resolve(root) || entry !== join(root, "entry.mjs") || !binding.endsWith("/dist/native/openwhisper_macos_capture.node")) process.exit(1);
for (const name of ["user-data", "session-data", "cache"]) await mkdir(join(root, name), { mode: 0o700 });
app.setPath("userData", join(root, "user-data")); app.setPath("sessionData", join(root, "session-data")); app.setPath("cache", join(root, "cache"));
app.disableHardwareAcceleration();
await app.whenReady();
// No BrowserWindow, renderer, input node, device inventory or permission request is created.
let utility: UtilityProcess | undefined;
let resultSeen = false, helperExitObserved = false, disposal: Promise<void> | undefined;
const phases: string[] = [];
let timer: NodeJS.Timeout | undefined;
try {
  // CI loads a locally compiled development addon. This fixture-only Plugin helper
  // does not change production helper signing, entitlements or permission policy.
  utility = utilityProcess.fork(entry, [binding], { serviceName: "OpenWhisper Owned Mac PCM Test", stdio: "ignore", allowLoadingUnsignedLibraries: true });
  const child = utility;
  disposal = new Promise<void>((accept) => { child.once("exit", () => { helperExitObserved = true; accept(); }); });
  const message = await new Promise<unknown>((accept, reject) => {
    timer = setTimeout(() => { reject(new Error("SYNTHETIC_CAPTURE_TIMEOUT")); }, 120_000);
    child.once("exit", () => { if (!resultSeen) reject(new Error("SYNTHETIC_CAPTURE_EXIT")); });
    child.on("message", (input: unknown) => {
      const progress = progressSchema.safeParse(input);
      if (progress.success && !resultSeen) { phases.push(progress.data.phase); return; }
      const result = envelopeSchema.safeParse(input);
      if (!result.success || resultSeen) { reject(new Error("SYNTHETIC_CAPTURE_FRAME")); return; }
      resultSeen = true; accept(result.data);
    });
  });
  await writeFile(join(root, "result.json"), JSON.stringify(message, null, 2), { flag: "wx", mode: 0o600 });
  if (envelopeSchema.parse(message).fixture !== "macos-capture-result") process.exitCode = 1;
} catch {
  await writeFile(join(root, "failure.json"), JSON.stringify({ code: "SYNTHETIC_CAPTURE_FAILED" }), { mode: 0o600 });
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  if (utility) utility.kill();
  if (disposal) {
    let deadline: NodeJS.Timeout | undefined;
    try { await Promise.race([disposal, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { reject(new Error("SYNTHETIC_CAPTURE_DISPOSAL")); }, 8000);
    })]); } catch { process.exitCode = 1; } finally { if (deadline) clearTimeout(deadline); }
  }
  // Only retain categorical answers from Node's actual loaded-object inventory.
  let inventory: unknown;
  try {
    if (process.report) { process.report.excludeEnv = true; Reflect.set(process.report, "excludeNetwork", true); }
    inventory = process.report?.getReport();
  } catch { inventory = undefined; }
  const report = z.object({ sharedObjects: z.array(z.string()) }).safeParse(inventory);
  if (!report.success) process.exitCode = 1;
  await writeFile(join(root, "lifecycle.json"), JSON.stringify({ resultSeen, helperExitObserved, actualOSRetirementVerified: false,
    mainLoadedCapture: report.success ? report.data.sharedObjects.some((path) => path.includes("openwhisper_macos_capture.node")) : true,
    loadedInventoryVerified: report.success,
    rendererCreated: webContents.getAllWebContents().length !== 0, realCaptureSelected: false }), { mode: 0o600 });
  await writeFile(join(root, "phases.json"), JSON.stringify(phases), { mode: 0o600 });
  app.exit(process.exitCode === 1 ? 1 : 0);
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createLinuxProcfsReadProvider, parseLinuxProcStat } from "../../src/services/platform-lifecycle/process-retirement.js";
import { boundedJson, describe } from "../owned-supervisor/files.js";
import { mainIdentitySchema, validateResult, FixtureError, NODE_SHA256, profileSchema, preflightSchema, MAX_METADATA_BYTES, HOME, waitForOriginalCommandClose, type Profile } from "./contract.js";

const LIMIT = 1024 * 1024;
/** Transient output is reduced to closed facts; device descriptions never persist. */
export function summarizeVulkanOutput(output: Uint8Array, stderrBytes: number) {
  assert.ok(output.byteLength > 0 && output.byteLength <= LIMIT && Number.isInteger(stderrBytes) && stderrBytes >= 0 && stderrBytes <= LIMIT);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(output), types = [...text.matchAll(/^\s*deviceType\s*=\s*(\S+)\s*$/gmu)].map((match) => match[1]);
  const cpuDevices = types.filter((type) => type === "PHYSICAL_DEVICE_TYPE_CPU" || type === "VK_PHYSICAL_DEVICE_TYPE_CPU").length, nonCpuDevices = types.length - cpuDevices;
  return preflightSchema.parse({ version: 1, profile: "loader-present", status: "PASS", cpuDevices, nonCpuDevices,
    stdoutBytes: output.byteLength, stdoutSha256: createHash("sha256").update(output).digest("hex"), stderrBytes, code: 0 });
}
export function classifyMainRetirement(original: unknown, observed: unknown): "absence" | "different-birth" | "reserved" {
  const expected = mainIdentitySchema.parse(original); if (observed === null) return "absence";
  const current = parseLinuxProcStat(observed); if (current.pid !== expected.pid) throw new FixtureError();
  return current.startTicks.toString() === expected.startTicks ? "reserved" : "different-birth";
}
async function assertRuntime(): Promise<Profile> {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000 || process.execPath !== "/opt/node/bin/node" ||
      process.versions.node !== "24.21.0" || process.env.OPENWHISPER_OWNED_SUPERVISOR_FALLBACK !== "1" || process.env.HOME !== HOME ||
      Object.keys(process.env).some((key) => !["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "PATH", "LANG", "OPENWHISPER_OWNED_SUPERVISOR_FALLBACK", "OPENWHISPER_FALLBACK_PROFILE"].includes(key)) || (await describe(process.execPath)).sha256 !== NODE_SHA256) throw new FixtureError();
  return profileSchema.parse(process.env.OPENWHISPER_FALLBACK_PROFILE);
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw new FixtureError(); }
  throw new FixtureError();
}
export async function environmentPreflight(profile: Profile): Promise<void> {
  assert.equal(await assertRuntime(), profile);
  if (profile === "loader-absent") {
    // Fixed common linker aliases only; actual lazy-load failure is separate proof.
    for (const path of ["/usr/lib/x86_64-linux-gnu/libvulkan.so", "/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/lib/x86_64-linux-gnu/libvulkan.so", "/lib/x86_64-linux-gnu/libvulkan.so.1"]) await absent(path);
    await absent("/owned-runtime/electron/libvulkan.so.1");
    await writeFile("/evidence/environment.json", JSON.stringify(preflightSchema.parse({ version: 1, profile, status: "PASS", checkedSystemPaths: 4, existingSystemPaths: 0, bundledLoaderPresent: false })), { mode: 0o600 }); return;
  }
  const origin = performance.now(), end = origin + 8000, child = spawn("/usr/bin/vulkaninfo", ["--summary"], { shell: false, stdio: ["ignore", "pipe", "pipe"],
    env: { HOME, XDG_RUNTIME_DIR: `${HOME}/runtime`, TMPDIR: `${HOME}/tmp`, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  const chunks: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0, expired = false, overflow = false, stopped = false, force: NodeJS.Timeout | undefined;
  const stop = (): void => { if (stopped) return; stopped = true; child.kill("SIGTERM"); force = setTimeout(() => { child.kill("SIGKILL"); }, 2000); };
  child.stdout.on("data", (bytes: Buffer) => { stdoutBytes += bytes.length; if (stdoutBytes > LIMIT) { overflow = true; stop(); } else chunks.push(bytes); });
  child.stderr.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > LIMIT) { overflow = true; stop(); } });
  const timer = setTimeout(() => { expired = true; stop(); }, Math.max(0, end - performance.now()));
  const completion = await waitForOriginalCommandClose(child, end, () => ({ expired, overflow })).finally(() => { clearTimeout(timer); clearTimeout(force); });
  assert.equal(completion.code, 0);
  await writeFile("/evidence/environment.json", JSON.stringify(summarizeVulkanOutput(Buffer.concat(chunks, stdoutBytes), stderrBytes)), { mode: 0o600 });
}
export async function verifyOriginalMainRetired(): Promise<void> {
  const profile = await assertRuntime(), result = validateResult(await boundedJson("/evidence/result.json", MAX_METADATA_BYTES)); assert.equal(result.profile, profile);
  const reader = createLinuxProcfsReadProvider(), signal = AbortSignal.timeout(8000), deadline = performance.now() + 8000; await reader.verify(signal);
  for (;;) {
    const retiredBy = classifyMainRetirement(result.main, await reader.read(result.main.pid, "stat", 4096, signal));
    if (performance.now() >= deadline || signal.aborted) throw new FixtureError();
    if (retiredBy !== "reserved") {
      await writeFile("/evidence/main-retirement.json", JSON.stringify({ status: "PASS", original: result.main, retiredBy,
        scope: "Read-only original main birth retirement after CLI completion; no admission/signal." }), { mode: 0o600 }); return;
    }
    await delay(20, undefined, { signal });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = Promise.resolve().then(() => {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === "--environment-preflight") return environmentPreflight(profileSchema.parse(args[1]));
    if (args.length === 1 && args[0] === "--verify-main-retired") return verifyOriginalMainRetired();
    throw new FixtureError();
  });
  void operation.catch(() => { process.stderr.write("Owned fallback verification failed.\n"); process.exitCode = 1; });
}

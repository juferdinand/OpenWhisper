import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Commands, hash, tree } from "./launch-io.js";
import { EXECUTION_MS, frozenCore, HEADER_SHA, IMAGE, PARENT_CLEANUP_MS, RUNTIME_ARCHIVE_SHA,
  RUNTIME_SHA, sameHashes, SECCOMP_SHA, UTILITY_CLEANUP_MS, validateContainer } from "./launch-contracts.js";
import { diagnosticCommandPlan, diagnosticPackageSchema, RETAINED_SHA, validateRetainedProvenance } from "./retained-contracts.js";

/** No native compilation or fallback; separate explicit approval is required. */
export async function executeRetained(directory: string): Promise<void> {
  if (process.env.OPENWHISPER_OWNED_BUS_DIAGNOSTIC_EXECUTE !== "1" || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000) {
    throw new Error("Explicit ordinary-user diagnostic execution required.");
  }
  const manifest = diagnosticPackageSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  sameHashes(await tree(join(directory, "source")), manifest.source); sameHashes(await tree(join(directory, "payload")), manifest.payload);
  for (const [name, expected] of Object.entries(frozenCore)) if (manifest.source[name] !== expected) throw new Error("Reviewed source differs.");
  validateRetainedProvenance({ native: await hash(join(directory, "payload/dist/native/openwhisper_linux_bus.node")),
    manifest: await hash(join(directory, "retained/original-manifest.json")), provenance: await hash(join(directory, "retained/native-provenance.json")) },
    JSON.parse(await readFile(join(directory, "retained/native-provenance.json"), "utf8")));
  if (await hash(join(directory, "seccomp.json")) !== SECCOMP_SHA || await hash(join(directory, "payload/headers.tar.gz")) !== HEADER_SHA ||
      await hash(join(directory, "payload/runtime/electron")) !== RUNTIME_SHA || await hash(join(directory, "electron-v44.7.0-linux-x64.zip")) !== RUNTIME_ARCHIVE_SHA) throw new Error("Pinned input differs.");
  const artifacts = join(directory, "artifacts"); await mkdir(artifacts, { mode: 0o700 });
  const commands = new Commands(artifacts), container = `openwhisper-owned-opening-diagnostic-${randomUUID()}`;
  const docker = async (args: string[], bound?: number, allowFailure = false) => commands.run("docker", args, bound, allowFailure);
  const owned = async (args: readonly string[], bound?: number) => docker(["exec", "--user", "1000:1000", container, "env", "-i",
    "PATH=/opt/node/bin:/usr/bin:/bin", "HOME=/owned-app", "LANG=C.UTF-8", ...args], bound);
  let created = false, started = false, success = false, removalConfirmed = false, category = "PRE_START_FAILED";
  try {
    const image = z.array(z.object({ Id: z.literal(IMAGE), Architecture: z.literal("amd64"), Os: z.literal("linux"),
      Config: z.object({ User: z.literal("1000:1000") }) })).length(1).parse(JSON.parse((await docker(["image", "inspect", IMAGE])).stdout));
    await writeFile(join(artifacts, "image-inspect.json"), JSON.stringify(image, null, 2), { mode: 0o600 });
    await docker(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
      "--security-opt", `seccomp=${join(directory, "seccomp.json")}`, "--ulimit", "core=0", "--pids-limit", "256", "--memory", "3g", "--shm-size", "256m", "--entrypoint", "/bin/sleep", IMAGE, "1800"]); created = true;
    await docker(["cp", "--archive", `${join(directory, "payload")}/.`, `${container}:/owned-app/`]);
    const copied = join(artifacts, "copied-before-start"); await mkdir(copied, { mode: 0o700 });
    await docker(["cp", "--archive", `${container}:/owned-app/.`, copied]); sameHashes(await tree(copied), manifest.payload);
    const inspected = (await docker(["inspect", container])).stdout;
    await writeFile(join(artifacts, "container-inspect-before-start.json"), inspected, { mode: 0o600 });
    validateContainer(JSON.parse(inspected), await readFile(join(directory, "seccomp.json"), "utf8"));
    await docker(["start", container]); started = true; category = "RETAINED_ARTIFACT_FAILED";
    const plan = diagnosticCommandPlan(); const before = plan[0], test = plan[1], after = plan[2];
    if (!before || !test || !after) throw new Error("Incomplete fixed diagnostic plan.");
    if ((await owned(before)).stdout.split(/\s+/u)[0] !== RETAINED_SHA) throw new Error("Retained ELF changed before diagnostic.");
    category = "OWNED_DIAGNOSTIC_FAILED";
    await owned(test, EXECUTION_MS + UTILITY_CLEANUP_MS + PARENT_CLEANUP_MS + 20_000);
    await docker(["cp", `${container}:/evidence/.`, artifacts]);
    z.object({ result: z.literal("PASS") }).parse(JSON.parse(await readFile(join(artifacts, "opening-driver-final.json"), "utf8")));
    if ((await owned(after)).stdout.split(/\s+/u)[0] !== RETAINED_SHA) throw new Error("Retained ELF changed during diagnostic.");
    success = true; category = "PASS";
  } catch { /* Fixed categories plus bounded fixture metadata, never native payloads. */ }
  finally {
    if (started) {
      const collected = await docker(["cp", `${container}:/evidence/.`, artifacts], 10_000, true);
      if (collected.code !== 0) { success = false; category = "OWNED_EVIDENCE_COLLECTION_FAILED"; }
    }
    if (created) {
      const removed = await docker(["rm", "--force", container], 20_000, true);
      const remaining = await docker(["ps", "--all", "--filter", `name=^${container}$`, "--format", "{{.ID}}"], 10_000, true);
      removalConfirmed = removed.code === 0 && remaining.code === 0 && remaining.stdout === "";
    } else removalConfirmed = true;
    if (!removalConfirmed) { success = false; category = "OWNED_CONTAINER_CLEANUP_FAILED"; }
    await writeFile(join(artifacts, "launcher-result.json"), JSON.stringify({ result: success ? "PASS" : "FAIL", category,
      created, started, removalConfirmed, nativeBuilt: false, retained: manifest.retained, commands: commands.records,
      scope: "Opening-only owned categorical diagnostic using unchanged frozen ELF; cleanup/old19 profiles not executed." }, null, 2), { mode: 0o600 });
  }
  if (!success) throw new Error("Owned diagnostic refused; frozen categorical evidence retained.");
}

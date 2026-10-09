import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { Commands, hash, tree } from "./launch-io.js";
import { EXECUTION_MS, foreignSchema, frozenCore, HEADER_SHA, IMAGE, PARENT_CLEANUP_MS, RUNTIME_ARCHIVE_SHA,
  RUNTIME_SHA, sameHashes, SECCOMP_SHA, UTILITY_CLEANUP_MS, validateContainer } from "./launch-contracts.js";
import { foreignCommand, SERVICE_SOURCE_SHA, validateForeignReply } from "./remaining-contracts.js";
import { validateRetainedProvenance } from "./retained-contracts.js";
import { legacyCommandPlan, legacyPackageSchema, serviceProofHashes, validateArtifactHashOutput, validateServiceReuse } from "./legacy-retained-contracts.js";

/** One legacy diagnostic; both binaries and all original compile proofs reused. */
export async function executeLegacy(directory: string): Promise<void> {
  if (process.env.OPENWHISPER_OWNED_BUS_LEGACY_EXECUTE !== "1" || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000) throw new Error("Explicit ordinary-user legacy diagnostic required.");
  const manifest = legacyPackageSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  sameHashes(await tree(join(directory, "source")), manifest.source); sameHashes(await tree(join(directory, "payload")), manifest.payload);
  for (const [name, expected] of Object.entries(frozenCore)) if (manifest.source[name] !== expected) throw new Error("Reviewed source differs.");
  validateRetainedProvenance({ native: await hash(join(directory, "payload/dist/native/openwhisper_linux_bus.node")),
    manifest: await hash(join(directory, "retained/original-manifest.json")), provenance: await hash(join(directory, "retained/native-provenance.json")) }, JSON.parse(await readFile(join(directory, "retained/native-provenance.json"), "utf8")));
  const proofs = join(directory, "retained-service"), metadata: Record<string, string> = {};
  for (const name of Object.keys(serviceProofHashes)) metadata[name] = await readFile(join(proofs, name), "utf8");
  validateServiceReuse({ binary: await hash(join(directory, "payload/tests/owned-bus/service")), manifest: await hash(join(proofs, "original-manifest.json")),
    provenance: await hash(join(proofs, "service-provenance.json")), source: await hash(join(directory, "payload/tests/owned-bus/service.cpp")) },
    await tree(proofs), JSON.parse(metadata["service-provenance.json"] ?? ""), JSON.parse(metadata["original-manifest.json"] ?? ""), metadata);
  if (await hash(join(directory, "seccomp.json")) !== SECCOMP_SHA || await hash(join(directory, "payload/headers.tar.gz")) !== HEADER_SHA ||
      await hash(join(directory, "payload/runtime/electron")) !== RUNTIME_SHA || await hash(join(directory, "electron-v44.7.0-linux-x64.zip")) !== RUNTIME_ARCHIVE_SHA) throw new Error("Pinned input differs.");
  const artifacts = join(directory, "artifacts"); await mkdir(artifacts, { mode: 0o700 });
  const commands = new Commands(artifacts), container = `openwhisper-owned-legacy-${randomUUID()}`;
  const docker = async (args: string[], bound?: number, allowFailure = false) => commands.run("docker", args, bound, allowFailure);
  const owned = async (args: readonly string[], bound?: number) => docker(["exec", "--user", "1000:1000", container, "env", "-i", "PATH=/opt/node/bin:/usr/bin:/bin", "HOME=/owned-app", "LANG=C.UTF-8", ...args], bound);
  const plan = legacyCommandPlan(), before = plan[0], test = plan[1], after = plan[2];
  if (!before || !test || !after) throw new Error("Incomplete fixed legacy plan.");
  let created = false, started = false, success = false, removalConfirmed = false, category = "PRE_START_FAILED", operationFailure: string | null = null;
  try {
    const image = z.array(z.object({ Id: z.literal(IMAGE), Architecture: z.literal("amd64"), Os: z.literal("linux"), Config: z.object({ User: z.literal("1000:1000") }) })).length(1).parse(JSON.parse((await docker(["image", "inspect", IMAGE])).stdout));
    await writeFile(join(artifacts, "image-inspect.json"), JSON.stringify(image, null, 2), { mode: 0o600 });
    await docker(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", `seccomp=${join(directory, "seccomp.json")}`, "--ulimit", "core=0", "--pids-limit", "256", "--memory", "3g", "--shm-size", "256m", "--entrypoint", "/bin/sleep", IMAGE, "1800"]); created = true;
    await docker(["cp", "--archive", `${join(directory, "payload")}/.`, `${container}:/owned-app/`]);
    const copied = join(artifacts, "copied-before-start"); await mkdir(copied, { mode: 0o700 });
    await docker(["cp", "--archive", `${container}:/owned-app/.`, copied]); sameHashes(await tree(copied), manifest.payload);
    const inspected = (await docker(["inspect", container])).stdout; await writeFile(join(artifacts, "container-inspect-before-start.json"), inspected, { mode: 0o600 });
    validateContainer(JSON.parse(inspected), await readFile(join(directory, "seccomp.json"), "utf8"));
    await docker(["start", container]); started = true; category = "RETAINED_ARTIFACT_FAILED";
    validateArtifactHashOutput((await owned(before)).stdout); category = "LEGACY_PROFILE_FAILED";
    const stopForeign = new AbortController();
    const profile = owned(test, EXECUTION_MS + UTILITY_CLEANUP_MS + PARENT_CLEANUP_MS + 20_000).finally(() => { stopForeign.abort(); });
    const foreign = (async () => {
      const deadline = performance.now() + 35_000; let marker: z.infer<typeof foreignSchema> | undefined;
      while (!marker) {
        if (stopForeign.signal.aborted || performance.now() >= deadline) throw new Error("Owned foreign readiness refused.");
        const attempted = await docker(["exec", "--user", "1000:1000", container, "cat", "/evidence/foreign-ready.json"], 2000, true);
        if (performance.now() >= deadline || stopForeign.signal.aborted) throw new Error("Owned foreign readiness expired.");
        if (attempted.code === 0) marker = foreignSchema.parse(JSON.parse(attempted.stdout)); else await pause(100);
      }
      const response = await docker(["exec", "--user", "1001:1001", container, "env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", ...foreignCommand(marker)], Math.min(5000, deadline - performance.now()));
      validateForeignReply(response);
      if (performance.now() >= deadline || stopForeign.signal.aborted) throw new Error("Foreign denial completed outside original lifetime.");
      const current = foreignSchema.parse(JSON.parse((await docker(["exec", "--user", "1000:1000", container, "cat", "/evidence/foreign-ready.json"], 2000)).stdout));
      if (current.address !== marker.address || current.owner !== marker.owner || performance.now() >= deadline || stopForeign.signal.aborted) throw new Error("Original foreign endpoint changed.");
      await owned(["touch", "/evidence/foreign-checked"], deadline - performance.now());
      if (performance.now() >= deadline || stopForeign.signal.aborted) throw new Error("Foreign completion marker exceeded original lifetime.");
      await writeFile(join(artifacts, "foreign-uid-result.json"), JSON.stringify({ result: "PASS", uid: 1001, marker, reply: response, noAutoStart: true, methodTimeoutMs: 3000, sourceHash: SERVICE_SOURCE_SHA }, null, 2), { mode: 0o600 });
    })();
    const settled = await Promise.allSettled([profile, foreign]);
    if (settled.some((value) => value.status === "rejected")) throw new Error("Owned legacy diagnostic refused.");
    await docker(["cp", `${container}:/evidence/.`, artifacts]);
    z.object({ result: z.literal("PASS") }).parse(JSON.parse(await readFile(join(artifacts, "legacy-driver-final.json"), "utf8")));
    validateArtifactHashOutput((await owned(after)).stdout); success = true; category = "PASS";
  } catch { operationFailure = category; }
  finally {
    if (started) {
      const collected = await docker(["cp", `${container}:/evidence/.`, artifacts], 10_000, true);
      if (collected.code !== 0) { success = false; category = "OWNED_EVIDENCE_COLLECTION_FAILED"; }
      const final = await docker(["exec", "--user", "1000:1000", container, ...after], 5000, true);
      try { if (final.code !== 0) throw new Error("Hash command failed."); validateArtifactHashOutput(final.stdout); }
      catch { success = false; category = "RETAINED_ARTIFACT_FAILED"; }
    }
    if (created) {
      const removed = await docker(["rm", "--force", container], 20_000, true);
      const remaining = await docker(["ps", "--all", "--filter", `name=^${container}$`, "--format", "{{.ID}}"], 10_000, true);
      removalConfirmed = removed.code === 0 && remaining.code === 0 && remaining.stdout === "";
    } else removalConfirmed = true;
    if (!removalConfirmed) { success = false; category = "OWNED_CONTAINER_CLEANUP_FAILED"; }
    await writeFile(join(artifacts, "launcher-result.json"), JSON.stringify({ result: success ? "PASS" : "FAIL", category, operationFailure, created, started, removalConfirmed,
      nativeBuilt: false, serviceBuilt: false, retained: manifest.retained, service: manifest.service, commands: commands.records,
      scope: "One owned legacy diagnostic with both original binaries reused; no new compile, cleanup/opening profile, desktop, capture, CLI or universal descendant full-reap claim." }, null, 2), { mode: 0o600 });
  }
  if (!success) throw new Error("Owned legacy diagnostic refused; frozen categorical evidence retained.");
}

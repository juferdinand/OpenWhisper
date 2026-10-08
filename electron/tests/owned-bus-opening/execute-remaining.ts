import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { Commands, hash, tree } from "./launch-io.js";
import { EXECUTION_MS, foreignSchema, frozenCore, HEADER_SHA, IMAGE, PARENT_CLEANUP_MS, RUNTIME_ARCHIVE_SHA,
  RUNTIME_SHA, sameHashes, SECCOMP_SHA, UTILITY_CLEANUP_MS, validateContainer } from "./launch-contracts.js";
import { foreignCommand, remainingPackageSchema, runRemainingProfiles, SERVICE_BINARY, serviceCompileArguments,
  SERVICE_SOURCE, SERVICE_SOURCE_SHA, validateForeignReply, validateServiceMetadata } from "./remaining-contracts.js";
import { RETAINED_SHA, validateRetainedProvenance } from "./retained-contracts.js";

/** Explicit remaining-profile approval; never rebuilds the retained addon. */
export async function executeRemaining(directory: string): Promise<void> {
  if (process.env.OPENWHISPER_OWNED_BUS_REMAINING_EXECUTE !== "1" || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000) {
    throw new Error("Explicit ordinary-user remaining-profile execution required.");
  }
  const manifest = remainingPackageSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  sameHashes(await tree(join(directory, "source")), manifest.source); sameHashes(await tree(join(directory, "payload")), manifest.payload);
  for (const [name, expected] of Object.entries(frozenCore)) if (manifest.source[name] !== expected) throw new Error("Reviewed source differs.");
  validateRetainedProvenance({ native: await hash(join(directory, "payload/dist/native/openwhisper_linux_bus.node")),
    manifest: await hash(join(directory, "retained/original-manifest.json")), provenance: await hash(join(directory, "retained/native-provenance.json")) },
    JSON.parse(await readFile(join(directory, "retained/native-provenance.json"), "utf8")));
  if (await hash(join(directory, "seccomp.json")) !== SECCOMP_SHA || await hash(join(directory, "payload/headers.tar.gz")) !== HEADER_SHA ||
      await hash(join(directory, "payload/runtime/electron")) !== RUNTIME_SHA || await hash(join(directory, "electron-v44.7.0-linux-x64.zip")) !== RUNTIME_ARCHIVE_SHA ||
      await hash(join(directory, "payload/tests/owned-bus/service.cpp")) !== SERVICE_SOURCE_SHA) throw new Error("Pinned input differs.");
  const artifacts = join(directory, "artifacts"); await mkdir(artifacts, { mode: 0o700 });
  const commands = new Commands(artifacts), container = `openwhisper-owned-remaining-${randomUUID()}`;
  const docker = async (args: string[], bound?: number, allowFailure = false) => commands.run("docker", args, bound, allowFailure);
  const owned = async (args: readonly string[], bound?: number) => docker(["exec", "--user", "1000:1000", container, "env", "-i",
    "PATH=/opt/node/bin:/usr/bin:/bin", "HOME=/owned-app", "LANG=C.UTF-8", ...args], bound);
  const checkNative = async (): Promise<void> => {
    if ((await owned(["sha256sum", "/owned-app/dist/native/openwhisper_linux_bus.node"])).stdout.split(/\s+/u)[0] !== RETAINED_SHA) throw new Error("Retained ELF differs.");
  };
  let created = false, started = false, success = false, removalConfirmed = false, serviceBuilt = false, category = "PRE_START_FAILED";
  let operationFailure: string | null = null;
  const completed: string[] = [];
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
    await checkNative(); category = "SERVICE_BUILD_FAILED";
    if ((await owned(["sha256sum", SERVICE_SOURCE])).stdout.split(/\s+/u)[0] !== SERVICE_SOURCE_SHA) throw new Error("Test service input differs.");
    const flags = (await owned(["/usr/bin/pkg-config", "--cflags", "--libs", "gio-2.0", "gio-unix-2.0"])).stdout;
    const compile = serviceCompileArguments(flags);
    // Only this one fixed source is compiled. No CMake/header/addon target exists.
    await owned(compile, 60_000); serviceBuilt = true;
    await docker(["cp", `${container}:${SERVICE_BINARY}`, join(artifacts, "owned-test-service")]);
    const serviceHash = await hash(join(artifacts, "owned-test-service"));
    const metadata: Record<string, string> = {};
    for (const [file, args] of Object.entries({ "compiler.txt": ["/usr/bin/c++", "--version"],
      "compiler-binary.sha256": ["sha256sum", "/usr/bin/c++"], "gio-version.txt": ["/usr/bin/pkg-config", "--modversion", "gio-2.0"],
      "service-elf-header.txt": ["readelf", "--file-header", SERVICE_BINARY], "service-elf-versions.txt": ["readelf", "--version-info", SERVICE_BINARY],
      "service-elf-dynamic.txt": ["readelf", "--dynamic", SERVICE_BINARY], "service-elf-notes.txt": ["readelf", "--notes", SERVICE_BINARY],
      "service-elf-symbols.txt": ["nm", "-D", SERVICE_BINARY] })) {
      const text = (await owned(args)).stdout; metadata[file] = text; await writeFile(join(artifacts, file), text, { mode: 0o600 });
    }
    const abi = validateServiceMetadata(metadata);
    for (const [from, to] of [["/etc/openwhisper-test-packages.txt", "distro-packages.txt"], ["/usr/share/doc/libglib2.0-0/copyright", "installed-gio-copyright"]]) {
      if (!from || !to) throw new Error("Invalid fixed metadata path."); await docker(["cp", `${container}:${from}`, join(artifacts, to)]);
    }
    await writeFile(join(artifacts, "service-provenance.json"), JSON.stringify({ serviceHash, sourceHash: SERVICE_SOURCE_SHA,
      compileArgv: compile, manifest, abi, nativeHash: RETAINED_SHA, nativeBuilt: false,
      scope: "New test service only, fixed Ubuntu22 image/compiler/GIO as UID1000; unchanged retained Node-API addon." }, null, 2), { mode: 0o600 });
    await checkNative();
    await runRemainingProfiles(async (profile) => {
      category = profile === "cleanup" ? "CLEANUP_PROFILE_FAILED" : "LEGACY_PROFILE_FAILED";
      const stopForeign = new AbortController();
      const test = owned(["OPENWHISPER_OWNED_BUS_OPENING_DRIVER=1", "/opt/node/bin/node", "/owned-app/driver.mjs", profile],
        EXECUTION_MS + UTILITY_CLEANUP_MS + PARENT_CLEANUP_MS + 20_000).finally(() => { stopForeign.abort(); });
      const foreign = profile !== "legacy" ? Promise.resolve() : (async () => {
        const deadline = performance.now() + 35_000; let marker: z.infer<typeof foreignSchema> | undefined;
        while (!marker) {
          if (stopForeign.signal.aborted || performance.now() >= deadline) throw new Error("Owned foreign readiness refused.");
          const attempt = await docker(["exec", "--user", "1000:1000", container, "cat", "/evidence/foreign-ready.json"], 2000, true);
          if (performance.now() >= deadline || stopForeign.signal.aborted) throw new Error("Owned foreign readiness expired.");
          if (attempt.code === 0) marker = foreignSchema.parse(JSON.parse(attempt.stdout)); else await pause(100);
        }
        const response = await docker(["exec", "--user", "1001:1001", container, "env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8",
          ...foreignCommand(marker)], Math.min(5000, deadline - performance.now()));
        validateForeignReply(response);
        if (performance.now() >= deadline || stopForeign.signal.aborted) throw new Error("Foreign denial completed outside original lifetime.");
        const current = foreignSchema.parse(JSON.parse((await docker(["exec", "--user", "1000:1000", container, "cat", "/evidence/foreign-ready.json"], 2000)).stdout));
        if (current.address !== marker.address || current.owner !== marker.owner || performance.now() >= deadline || stopForeign.signal.aborted) throw new Error("Original foreign endpoint changed.");
        await owned(["touch", "/evidence/foreign-checked"], deadline - performance.now());
        if (performance.now() >= deadline || stopForeign.signal.aborted) throw new Error("Foreign completion marker exceeded original lifetime.");
        await writeFile(join(artifacts, "foreign-uid-result.json"), JSON.stringify({ result: "PASS", uid: 1001, marker,
          reply: response, noAutoStart: true, methodTimeoutMs: 3000, sourceHash: SERVICE_SOURCE_SHA }, null, 2), { mode: 0o600 });
      })();
      const settled = await Promise.allSettled([test, foreign]);
      if (settled.some((value) => value.status === "rejected")) throw new Error("Owned remaining profile refused.");
      await docker(["cp", `${container}:/evidence/.`, artifacts]);
      z.object({ result: z.literal("PASS") }).parse(JSON.parse(await readFile(join(artifacts, `${profile}-driver-final.json`), "utf8")));
      await checkNative(); completed.push(profile);
    });
    success = true; category = "PASS";
  } catch { operationFailure = category; /* Fixed stages, never arbitrary exception payloads. */ }
  finally {
    if (started) {
      const collected = await docker(["cp", `${container}:/evidence/.`, artifacts], 10_000, true);
      if (collected.code !== 0) { success = false; category = "OWNED_EVIDENCE_COLLECTION_FAILED"; }
      const finalNative = await docker(["exec", "--user", "1000:1000", container, "sha256sum", "/owned-app/dist/native/openwhisper_linux_bus.node"], 5000, true);
      if (finalNative.code !== 0 || finalNative.stdout.split(/\s+/u)[0] !== RETAINED_SHA) { success = false; category = "RETAINED_ARTIFACT_FAILED"; }
    }
    if (created) {
      const removed = await docker(["rm", "--force", container], 20_000, true);
      const remaining = await docker(["ps", "--all", "--filter", `name=^${container}$`, "--format", "{{.ID}}"], 10_000, true);
      removalConfirmed = removed.code === 0 && remaining.code === 0 && remaining.stdout === "";
    } else removalConfirmed = true;
    if (!removalConfirmed) { success = false; category = "OWNED_CONTAINER_CLEANUP_FAILED"; }
    await writeFile(join(artifacts, "launcher-result.json"), JSON.stringify({ result: success ? "PASS" : "FAIL", category,
      operationFailure, created, started, removalConfirmed, nativeBuilt: false, serviceBuilt, retained: manifest.retained, completed, commands: commands.records,
      scope: "Owned cleanup plus unchanged19 transport gates with retained addon and separate new test service; utility non-running and outer containment, no universal descendant full-reap or desktop/capture/CLI claim." }, null, 2), { mode: 0o600 });
  }
  if (!success) throw new Error("Owned remaining acceptance refused; frozen categorical evidence retained.");
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { Commands, hash, tree } from "./launch-io.js";
import { baselineAbi, EXECUTION_MS, foreignSchema, frozenCore, HEADER_SHA, IMAGE, packageSchema, PARENT_CLEANUP_MS,
  RUNTIME_ARCHIVE_SHA, RUNTIME_SHA, sameHashes, SECCOMP_SHA, UTILITY_CLEANUP_MS, validateContainer } from "./launch-contracts.js";

/** Execution is explicit and must follow separate review of this frozen package. */
export async function execute(directory: string): Promise<void> {
  if (process.env.OPENWHISPER_OWNED_BUS_OPENING_EXECUTE !== "1" || process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000) {
    throw new Error("Explicit ordinary-user owned execution required.");
  }
  const manifest = packageSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  sameHashes(await tree(join(directory, "source")), manifest.source);
  sameHashes(await tree(join(directory, "payload")), manifest.payload);
  for (const [name, expected] of Object.entries(frozenCore)) if (manifest.source[name] !== expected) throw new Error("Package differs from reviewed source.");
  if (await hash(join(directory, "seccomp.json")) !== SECCOMP_SHA || await hash(join(directory, "payload/headers.tar.gz")) !== HEADER_SHA ||
      await hash(join(directory, "payload/runtime/electron")) !== RUNTIME_SHA || await hash(join(directory, "electron-v44.7.0-linux-x64.zip")) !== RUNTIME_ARCHIVE_SHA) throw new Error("Pinned package input changed.");
  const artifacts = join(directory, "artifacts"); await mkdir(artifacts, { mode: 0o700 });
  const commands = new Commands(artifacts), container = `openwhisper-owned-opening-${randomUUID()}`;
  const docker = async (args: string[], bound?: number, allowFailure = false) => commands.run("docker", args, bound, allowFailure);
  const owned = async (args: string[], bound?: number) => docker(["exec", "--user", "1000:1000", container, "env", "-i", "PATH=/opt/node/bin:/usr/bin:/bin", "HOME=/owned-app", "LANG=C.UTF-8", ...args], bound);
  let created = false, started = false, success = false, removalConfirmed = false;
  let category = "PRE_START_FAILED";
  try {
    const image = z.array(z.object({ Id: z.literal(IMAGE), Architecture: z.literal("amd64"), Os: z.literal("linux"),
      Config: z.object({ User: z.literal("1000:1000") }) })).length(1).parse(JSON.parse((await docker(["image", "inspect", IMAGE])).stdout));
    await writeFile(join(artifacts, "image-inspect.json"), JSON.stringify(image, null, 2), { mode: 0o600 });
    await docker(["create", "--name", container, "--init", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
      "--security-opt", `seccomp=${join(directory, "seccomp.json")}`, "--ulimit", "core=0", "--pids-limit", "256", "--memory", "3g", "--shm-size", "256m", "--entrypoint", "/bin/sleep", IMAGE, "1800"]);
    created = true;
    await docker(["cp", "--archive", `${join(directory, "payload")}/.`, `${container}:/owned-app/`]);
    const copied = join(artifacts, "copied-before-start"); await mkdir(copied, { mode: 0o700 });
    await docker(["cp", "--archive", `${container}:/owned-app/.`, copied]);
    sameHashes(await tree(copied), manifest.payload);
    const inspected = (await docker(["inspect", container])).stdout;
    await writeFile(join(artifacts, "container-inspect-before-start.json"), inspected, { mode: 0o600 });
    validateContainer(JSON.parse(inspected), await readFile(join(directory, "seccomp.json"), "utf8"));
    // No native compiler, daemon, socket or Electron runs before all these guards.
    await docker(["start", container]); started = true; category = "NATIVE_BUILD_FAILED";
    await owned(["mkdir", "-p", "/owned-app/vendor/node-headers", "/owned-app/dist/native"]);
    await owned(["tar", "-xzf", "/owned-app/headers.tar.gz", "--strip-components=1", "--no-same-owner", "-C", "/owned-app/vendor/node-headers"]);
    await owned(["cmake", "-S", "/owned-app/native-linux-bus", "-B", "/owned-app/native-linux-bus/build", "-G", "Ninja",
      "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "-DNODE_HEADERS=/owned-app/vendor/node-headers/include/node"], 300_000);
    await owned(["cmake", "--build", "/owned-app/native-linux-bus/build", "--parallel", "4"], 300_000);
    await owned(["cp", "/owned-app/native-linux-bus/build/openwhisper_linux_bus.node", "/owned-app/dist/native/openwhisper_linux_bus.node"]);
    const flags = (await owned(["pkg-config", "--cflags", "--libs", "gio-2.0", "gio-unix-2.0"])).stdout.split(/\s+/u);
    await owned(["c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "/owned-app/tests/owned-bus/service.cpp", "-o", "/owned-app/tests/owned-bus/service", ...flags], 300_000);
    for (const file of ["openwhisper_linux_bus.node", "CMakeCache.txt", "compile_commands.json", "build.ninja"]) {
      await docker(["cp", `${container}:/owned-app/native-linux-bus/build/${file}`, join(artifacts, file)]);
    }
    const nativeHash = await hash(join(artifacts, "openwhisper_linux_bus.node"));
    const metadata: Record<string, string> = {};
    for (const [file, args] of Object.entries({ "compiler.txt": ["c++", "--version"], "node-build-runtime.txt": ["/opt/node/bin/node", "--version"],
      "elf-header.txt": ["readelf", "--file-header", "/owned-app/dist/native/openwhisper_linux_bus.node"],
      "elf-versions.txt": ["readelf", "--version-info", "/owned-app/dist/native/openwhisper_linux_bus.node"],
      "elf-dynamic.txt": ["readelf", "--dynamic", "/owned-app/dist/native/openwhisper_linux_bus.node"],
      "elf-notes.txt": ["readelf", "--notes", "/owned-app/dist/native/openwhisper_linux_bus.node"],
      "elf-symbols.txt": ["nm", "-D", "/owned-app/dist/native/openwhisper_linux_bus.node"],
      "header-files.sha256": ["sha256sum", "/owned-app/vendor/node-headers/include/node/node_api.h", "/owned-app/vendor/node-headers/include/node/node_api_types.h",
        "/owned-app/vendor/node-headers/include/node/js_native_api.h", "/owned-app/vendor/node-headers/include/node/js_native_api_types.h"],
      "node-build-binary.sha256": ["sha256sum", "/opt/node/bin/node"],
      "gio-version.txt": ["pkg-config", "--modversion", "gio-2.0"] })) {
      const text = (await owned(args)).stdout; await writeFile(join(artifacts, file), text, { mode: 0o600 }); metadata[file] = text;
    }
    if (!metadata["elf-header.txt"]?.includes("ELF64") || !metadata["elf-header.txt"]?.includes("Advanced Micro Devices X86-64") ||
        !metadata["elf-symbols.txt"]?.includes("napi_register_module_v1") || metadata["node-build-runtime.txt"] !== "v24.21.0") throw new Error("Native baseline artifact failed mechanical checks.");
    const abi = baselineAbi(metadata["elf-versions.txt"] ?? "");
    const compile = z.array(z.object({ command: z.string() }).passthrough()).length(2)
      .parse(JSON.parse(await readFile(join(artifacts, "compile_commands.json"), "utf8")));
    for (const entry of compile) for (const flag of ["-DNAPI_VERSION=8", "-Wall", "-Wextra", "-Werror"]) {
      if (!entry.command.split(/\s+/u).includes(flag)) throw new Error("Required native compile flag missing.");
    }
    for (const [from, to] of [["/etc/openwhisper-test-packages.txt", "distro-packages.txt"], ["/usr/share/doc/libglib2.0-0/copyright", "installed-gio-copyright"]]) {
      if (!from || !to) throw new Error("Invalid fixed metadata copy."); await docker(["cp", `${container}:${from}`, join(artifacts, to)]);
    }
    await writeFile(join(artifacts, "native-provenance.json"), JSON.stringify({ nativeHash, manifest, compilerFlags: "Release; C++17; NAPI_VERSION=8; -Wall -Wextra -Werror",
      pkgConfigFlags: flags, abi, scope: "Built inside pinned Ubuntu22 image as UID1000; not a relabeled host/old ELF." }, null, 2), { mode: 0o600 });
    category = "OWNED_PROFILE_FAILED";
    for (const profile of ["opening", "cleanup", "legacy"] as const) {
      const test = owned(["OPENWHISPER_OWNED_BUS_OPENING_DRIVER=1", "/opt/node/bin/node", "/owned-app/driver.mjs", profile],
        EXECUTION_MS + UTILITY_CLEANUP_MS + PARENT_CLEANUP_MS + 20_000);
      const foreign = profile !== "legacy" ? Promise.resolve() : (async () => {
        const end = performance.now() + 35_000; let ready: z.infer<typeof foreignSchema> | undefined;
        while (!ready) {
          const attempted = await docker(["exec", "--user", "1000:1000", container, "cat", "/evidence/foreign-ready.json"], 2000, true);
          if (attempted.code === 0) ready = foreignSchema.parse(JSON.parse(attempted.stdout));
          else { if (performance.now() >= end) throw new Error("Owned foreign-UID readiness failed."); await pause(100); }
        }
        const response = await docker(["exec", "--user", "1001:1001", container, "env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "dbus-send",
          `--bus=${ready.address}`, "--type=method_call", "--print-reply", "--reply-timeout=1500", `--dest=${ready.owner}`,
          "/io/github/whisperfree/dev/Control", "io.github.whisperfree.Control1.Status"], 5000, true);
        if (response.code === 0 || !`${response.stdout}\n${response.stderr}`.includes("io.github.whisperfree.Error.Denied")) throw new Error("Foreign UID was not categorically denied.");
        await owned(["touch", "/evidence/foreign-checked"]);
      })();
      const settled = await Promise.allSettled([test, foreign]);
      for (const value of settled) if (value.status === "rejected") throw value.reason;
      await docker(["cp", `${container}:/evidence/.`, artifacts]);
      z.object({ result: z.literal("PASS") }).parse(JSON.parse(await readFile(join(artifacts, `${profile}-driver-final.json`), "utf8")));
    }
    const after = (await owned(["sha256sum", "/owned-app/dist/native/openwhisper_linux_bus.node"])).stdout.split(/\s+/u)[0];
    if (after !== nativeHash) throw new Error("Native artifact changed during acceptance.");
    success = true; category = "PASS";
  } catch { /* Logs/artifacts retain the exact failed phase, never native payloads. */ }
  finally {
    if (started) {
      const collection = await docker(["cp", `${container}:/evidence/.`, artifacts], 10_000, true);
      if (collection.code !== 0) { success = false; category = "OWNED_EVIDENCE_COLLECTION_FAILED"; }
    }
    if (created) {
      const removed = await docker(["rm", "--force", container], 20_000, true);
      const remaining = await docker(["ps", "--all", "--filter", `name=^${container}$`, "--format", "{{.ID}}"], 10_000, true);
      removalConfirmed = removed.code === 0 && remaining.code === 0 && remaining.stdout === "";
    } else removalConfirmed = true;
    if (!removalConfirmed) { success = false; category = "OWNED_CONTAINER_CLEANUP_FAILED"; }
    await writeFile(join(artifacts, "launcher-result.json"), JSON.stringify({ result: success ? "PASS" : "FAIL", category, created, started,
      removalConfirmed, commands: commands.records, scope: "Owned new opening/cleanup plus unchanged old19 transport gates against exact new ELF; no desktop, capture or CLI integration." }, null, 2), { mode: 0o600 });
  }
  if (!success) throw new Error("Owned opening acceptance failed; frozen evidence retained.");
}

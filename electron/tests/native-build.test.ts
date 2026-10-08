import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildNativeSpeech, nativeBuildManifestSchema, nativeBuildPlan } from "../scripts/build-native.js";
import { shaderSourcesSchema, validateNativeArchive, vulkanHeadersSchema } from "../scripts/native-dependencies.js";

test("native backend profiles have distinct outputs and keep CPU as the explicit default", () => {
  const linux = { platform: "linux", architecture: "x64" }, mac = { platform: "darwin", architecture: "arm64" };
  const cpu = nativeBuildPlan({}, linux), vulkan = nativeBuildPlan({ backend: "vulkan" }, linux), metal = nativeBuildPlan({ backend: "metal" }, mac);
  assert.equal(cpu.backend, "cpu");
  assert.equal(new Set([cpu.output, vulkan.output, metal.output]).size, 3);
  assert.deepEqual(metal.flags, ["-DOPENWHISPER_BACKEND=metal", "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0", "-DCMAKE_OSX_ARCHITECTURES=arm64"]);
  assert.ok(nativeBuildPlan({ backend: "cpu" }, { platform: "darwin", architecture: "x64" }).flags.includes("-DCMAKE_OSX_ARCHITECTURES=x86_64"));
});

test("invalid backend, platform, architecture or extra options are refused before fetch or build", async (context) => {
  const network = context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network"); });
  for (const input of [{ backend: "cuda" }, { backend: "vulkan", command: "arbitrary" }, { backend: "metal" }]) {
    // The test host is Linux; no valid Vulkan/CPU build is invoked by this pure guard test.
    if (process.platform === "linux") await assert.rejects(buildNativeSpeech(input));
    else assert.throws(() => nativeBuildPlan(input, { platform: "linux", architecture: "x64" }));
  }
  assert.throws(() => nativeBuildPlan({ backend: "vulkan" }, { platform: "darwin", architecture: "arm64" }));
  assert.throws(() => nativeBuildPlan({}, { platform: "win32", architecture: "x64" }));
  assert.throws(() => nativeBuildPlan({}, { platform: "linux", architecture: "ia32" }));
  assert.equal(network.mock.calls.length, 0);
});

test("native dependency manifests are byte-exact retained Linux pins and reject changed repositories", async () => {
  for (const [filename, schema] of [["vulkan-headers.json", vulkanHeadersSchema], ["shaderc-source.json", shaderSourcesSchema]] as const) {
    const own = await readFile(fileURLToPath(new URL(`../native/${filename}`, import.meta.url)));
    const legacy = await readFile(fileURLToPath(new URL(`../../linux/native/${filename}`, import.meta.url)));
    assert.deepEqual(own, legacy); assert.ok(schema.safeParse(JSON.parse(own.toString())).success);
  }
  const raw: unknown = JSON.parse(await readFile(fileURLToPath(new URL("../native/shaderc-source.json", import.meta.url)), "utf8"));
  const sources = shaderSourcesSchema.parse(raw);
  assert.equal(shaderSourcesSchema.safeParse({ ...sources, shaderc: { ...sources.shaderc, repository: "unreviewed/compiler" } }).success, false);
});

test("source archive guards refuse traversal, links, devices, duplicate roots and malformed inventories", () => {
  validateNativeArchive(["source/", "source/include/header.h"], ["drwxr-xr-x root 0", "-rw-r--r-- root 128"]);
  for (const [names, types] of [
    [["/absolute"], ["-rw"]], [["source/../outside"], ["-rw"]], [["source/./ambiguous"], ["-rw"]],
    [["source\\outside"], ["-rw"]], [["source/link"], ["lrw"]], [["source/hardlink"], ["hrw"]],
    [["source/device"], ["crw"]], [["source/", "another/"], ["drw", "drw"]],
    [["source/file", "source/file"], ["-rw", "-rw"]], [["source/file\nname"], ["-rw"]],
    [["source/file"], []], [[], []],
  ] as const) assert.throws(() => validateNativeArchive(names, types), /archive/);
});

test("compiled backend manifests reject contradictory profile claims and missing portable CPU", () => {
  const hash = "a".repeat(64);
  const cpu = { version: 1, backend: "cpu", platform: "linux", architecture: "x64", fingerprint: hash,
    bindingSha256: hash, cmakeCacheSha256: hash, sourceHashes: { "native/CMakeLists.txt": hash },
    speech: { repository: "ggml-org/whisper.cpp", tag: "b5130", revision: "b".repeat(40), sha256: hash },
    headers: { version: "24.21.0", sha256: hash, source: "https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt", napiVersion: 8 },
    toolchainFingerprint: null, compiledCpu: true, portableCpu: true, metalEmbedded: false, deploymentTarget: null,
    cmakeVersion: "owned cmake", compilerVersion: "owned compiler",
    scope: "Compiled backend profile only; runtime device/initialization/execution requires separate acceptance" };
  assert.ok(nativeBuildManifestSchema.safeParse(cpu).success);
  for (const patch of [{ backend: "vulkan" }, { backend: "metal" }, { compiledCpu: false }, { portableCpu: false },
    { metalEmbedded: true }, { deploymentTarget: "14.0" }, { toolchainFingerprint: hash }, { bindingSha256: "invalid" }, { extra: true }]) {
    assert.equal(nativeBuildManifestSchema.safeParse({ ...cpu, ...patch }).success, false);
  }
  assert.ok(nativeBuildManifestSchema.safeParse({ ...cpu, backend: "vulkan", toolchainFingerprint: hash }).success);
  assert.ok(nativeBuildManifestSchema.safeParse({ ...cpu, backend: "metal", platform: "darwin", metalEmbedded: true, deploymentTarget: "14.0" }).success);
});

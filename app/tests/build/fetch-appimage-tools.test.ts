import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assembleMacValidationPair, supportsMacValidationPair, validateMacValidationPairPaths } from "../../scripts/build.js";
import { fetchAppImageTools, readAppImageToolPins } from "../../scripts/fetch-appimage-tools.js";

test("AppImage tool fetch writes only exact pinned bytes with executable permissions", async () => {
  const pins = await readAppImageToolPins();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-appimage-tools-")));
  const output = join(directory, "tools");
  const calls: string[] = [];
  try {
    // Use tiny, independently pinned test inputs rather than downloading the production tools.
    const fixturePins = {
      ...pins,
      appimagetool: { ...pins.appimagetool, bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
      runtime: { ...pins.runtime, bytes: 2, sha256: "769a4e6d0003189c7e96c5d9b7e810a0d11c3a12832527ec94b0f86d277f51ca" },
    };
    const fixtureRequest: typeof fetch = async (input) => {
      calls.push(String(input));
      const bytes = String(input) === fixturePins.appimagetool.url ? Buffer.from("abc") : Buffer.from("xy");
      const response = new Response(bytes) as Response & { url: string };
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    };
    await fetchAppImageTools(output, fixturePins, fixtureRequest);
    assert.deepEqual(calls, [fixturePins.appimagetool.url, fixturePins.runtime.url]);
    assert.equal((await readFile(join(output, "appimagetool-x86_64.AppImage"))).toString(), "abc");
    assert.equal((await readFile(join(output, "runtime-x86_64"))).toString(), "xy");
    assert.equal((await stat(join(output, "appimagetool-x86_64.AppImage"))).mode & 0o777, 0o755);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AppImage tool fetch rejects bytes that do not match the pinned checksum", async () => {
  const pins = await readAppImageToolPins();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-appimage-tools-invalid-")));
  const output = join(directory, "tools");
  const fixturePins = { ...pins, appimagetool: { ...pins.appimagetool, bytes: 1, sha256: "0".repeat(64) } };
  try {
    await assert.rejects(fetchAppImageTools(output, fixturePins, async (input) => {
      const response = new Response(Buffer.from("x")) as Response & { url: string };
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    }), /checksum or size mismatch/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AppImage tool output rejects a symlinked parent before creating files or requesting bytes", async () => {
  const pins = await readAppImageToolPins();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-appimage-symlink-")));
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const alias = join(directory, "checkout");
  await symlink(repository, alias);
  const output = join(alias, "app", "scripts", "untrusted-tools");
  let requested = false;
  try {
    await assert.rejects(fetchAppImageTools(output, pins, async () => {
      requested = true;
      throw new Error("Network must not be reached.");
    }), /canonical parent/u);
    assert.equal(requested, false);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AppImage downloads reject HTTPS downgrades and redirect loops before following them", async () => {
  const pins = await readAppImageToolPins();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-appimage-redirect-")));
  const output = join(directory, "tools");
  let requests = 0;
  try {
    await assert.rejects(fetchAppImageTools(output, pins, async (_input, init) => {
      requests += 1;
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "http://downgrade.invalid/tool" } });
    }), /redirect must remain HTTPS/u);
    assert.equal(requests, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }

  const loopDirectory = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-appimage-loop-")));
  requests = 0;
  try {
    await assert.rejects(fetchAppImageTools(join(loopDirectory, "tools"), pins, async (input, init) => {
      requests += 1;
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: String(input) } });
    }), /redirect is invalid/u);
    assert.equal(requests, 1);
  } finally { await rm(loopDirectory, { recursive: true, force: true }); }
});

test("AppImage downloads reject HTTP errors and bodies larger than the pin", async () => {
  const pins = await readAppImageToolPins();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-appimage-response-")));
  try {
    const errorOutput = join(directory, "http-error");
    await assert.rejects(fetchAppImageTools(errorOutput, pins, async () => new Response(null, { status: 404 })),
      /download failed/u);
    await assert.rejects(lstat(errorOutput), { code: "ENOENT" });
    const tinyPins = { ...pins, appimagetool: { ...pins.appimagetool, bytes: 1, sha256: "0".repeat(64) } };
    await assert.rejects(fetchAppImageTools(join(directory, "oversized"), tinyPins, async (input) => {
      const response = new Response(Buffer.from("too many bytes"));
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    }), /exceeds its expected size/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CI and release workflows share the pinned downloader and CI retains extractor provenance", async () => {
  const repository = new URL("../../../", import.meta.url);
  const ci = await readFile(new URL(".github/workflows/ci.yml", repository), "utf8");
  const release = await readFile(new URL(".github/workflows/electron-linux-build.yml", repository), "utf8");
  for (const workflow of [ci, release]) {
    assert.ok(workflow.includes('scripts/fetch-appimage-tools.ts --output "$tools"'));
    assert.doesNotMatch(workflow, /curl.*appimagetool|appimage-tools\.json.*\.url/u);
  }
  assert.match(ci, /unsquashfs -version/u);
  assert.match(ci, /sha256sum "\$\(command -v unsquashfs\)"/u);
});

test("Mac validation pair builds common inputs once and asserts distinct Dev and Stable package outputs", async () => {
  const events: string[] = [];
  const outputs: string[] = [];
  const results: Array<[string, string]> = [];
  await assembleMacValidationPair({ devOutput: "/tmp/mac-dev", stableOutput: "/tmp/mac-stable",
    devResult: "/tmp/mac-dev.json", stableResult: "/tmp/mac-stable.json" }, {
    freshDevBuild: async () => { events.push("fresh recording build"); },
    assertIdentity: async (variant) => { events.push(`identity:${variant}`); },
    writeStableIdentity: async () => { events.push("write stable identity"); },
    package: async (variant, output) => { events.push(`package:${variant}`); outputs.push(output); return variant; },
    writeResult: async (path, value) => { results.push([path, value]); },
  });
  assert.deepEqual(events, ["fresh recording build", "identity:development", "package:development", "write stable identity", "identity:stable", "package:stable"]);
  assert.deepEqual(outputs, ["/tmp/mac-dev", "/tmp/mac-stable"]);
  assert.deepEqual(results, [["/tmp/mac-dev.json", "development"], ["/tmp/mac-stable.json", "stable"]]);
});

test("Mac validation pair refuses unsupported hosts and output collisions before building", async () => {
  assert.equal(supportsMacValidationPair("linux", "x64", false), false);
  assert.equal(supportsMacValidationPair("darwin", "arm64", true), false);
  let built = false;
  await assert.rejects(assembleMacValidationPair({ devOutput: "/tmp/same", stableOutput: "/tmp/same",
    devResult: "/tmp/dev.json", stableResult: "/tmp/stable.json" }, {
    freshDevBuild: async () => { built = true; }, assertIdentity: async () => {}, writeStableIdentity: async () => {},
    package: async () => "package", writeResult: async () => {},
  }), /distinct absolute paths/u);
  assert.equal(built, false);
});

test("Mac validation paths require fresh canonical parents outside the source and each other", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-pair-paths-")));
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const outputs = join(directory, "outputs");
  await mkdir(outputs);
  const valid = { devOutput: join(outputs, "dev"), stableOutput: join(outputs, "stable"),
    devResult: join(outputs, "dev.json"), stableResult: join(outputs, "stable.json") };
  try {
    await validateMacValidationPairPaths(valid, sourceRoot);
    await assert.rejects(validateMacValidationPairPaths({ ...valid, devOutput: join(sourceRoot, "dist", "candidate") }, sourceRoot),
      /canonical parents outside the source tree/u);
    await assert.rejects(validateMacValidationPairPaths({ ...valid, devResult: join(outputs, "dev", "result.json") }, sourceRoot),
      /distinct absolute paths without overlap/u);
    const alias = join(directory, "source-alias");
    await symlink(sourceRoot, alias);
    await assert.rejects(validateMacValidationPairPaths({ ...valid, devOutput: join(alias, "external-output") }, sourceRoot),
      /canonical parents outside the source tree/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("signed Linux CI configures the official registry mirror before containers and preserves the pinned image", async () => {
  const ci = await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parse(ci) as { jobs: { linux_signed_candidate: { steps: Array<{ name?: string; run?: string; uses?: string }> } } };
  const steps = workflow.jobs.linux_signed_candidate.steps;
  const mirrorStep = steps.find((step) => step.name === "Configure the official Docker Hub pull-through mirror for this isolated job");
  assert.ok(mirrorStep?.run);
  const run = mirrorStep.run;
  const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
  const signedSecret = steps.findIndex((step) => step.name === "Sign only the admitted canonical candidate with the existing key");
  const ownedContainer = steps.findIndex((step) => step.name === "Install and audit only inside the original disposable Ubuntu namespace");
  assert.equal(steps.indexOf(mirrorStep), 0);
  assert.ok(steps.indexOf(mirrorStep) < checkout && checkout < signedSecret && checkout < ownedContainer);
  assert.ok(run.includes("/etc/docker/daemon.json"));
  assert.ok(run.includes("https://mirror.gcr.io"));
  assert.ok(run.includes("sudo systemctl restart docker"));
  assert.ok(run.includes("docker info --format"));
  assert.ok(run.includes("falls back to Docker Hub when its cache misses"));
  const dockerCreate = workflow.jobs.linux_signed_candidate.steps[ownedContainer]?.run ?? "";
  assert.ok(dockerCreate.includes("ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401"));
  assert.ok(!ci.slice(0, ci.indexOf("  linux_signed_candidate:")).includes("mirror.gcr.io"));

  const jqLine = run.split("\n").map((line) => line.trimStart()).find((line) => line.startsWith('sudo jq --arg mirror "$mirror" '));
  const validationLine = run.split("\n").map((line) => line.trimStart()).find((line) => line.startsWith("sudo jq -e '"));
  assert.ok(jqLine && validationLine);
  const filterFromLine = (line: string, prefix: string): string => {
    const end = line.indexOf("' \"$config\"", prefix.length);
    assert.ok(end > prefix.length);
    return line.slice(prefix.length, end);
  };
  const mergeFilter = filterFromLine(jqLine, 'sudo jq --arg mirror "$mirror" \'');
  const validationFilter = filterFromLine(validationLine, "sudo jq -e '");
  const existing = { debug: true, "data-root": "/var/lib/docker-data", "registry-mirrors": ["https://existing.example"] };
  const merged = JSON.parse(execFileSync("jq", ["--arg", "mirror", "https://mirror.gcr.io", mergeFilter], {
    input: JSON.stringify(existing), encoding: "utf8",
  })) as typeof existing;
  assert.deepEqual(merged, { ...existing, "registry-mirrors": [...existing["registry-mirrors"], "https://mirror.gcr.io"] });
  const alreadyConfigured = { ...existing, "registry-mirrors": [...existing["registry-mirrors"], "https://mirror.gcr.io"] };
  const mergedAgain = JSON.parse(execFileSync("jq", ["--arg", "mirror", "https://mirror.gcr.io", mergeFilter], {
    input: JSON.stringify(alreadyConfigured), encoding: "utf8",
  })) as typeof alreadyConfigured;
  assert.deepEqual(mergedAgain, alreadyConfigured);
  assert.throws(() => execFileSync("jq", ["-e", validationFilter], { input: '{"registry-mirrors":false}', encoding: "utf8" }));
  assert.throws(() => execFileSync("jq", ["-e", validationFilter], { input: '{"registry-mirrors":["https://valid.example",{}]}', encoding: "utf8" }));
});

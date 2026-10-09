import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { developmentRecordingDescriptorSchema } from "../src/main/development-recording-descriptor.js";
import { SPEECH_ENTRY_FILES } from "../src/services/speech-entry-graph.js";
import { captureSignedMacDescriptor, insideOutMacCodePaths, inspectMacBinary, inspectMacMinimumOS, macHelperBundleIdentifier, macPackageConstructionMode,
  macPreviewCodesignArguments, macPreviewPlistValues, macPreviewSigningPolicy, macPreviewUpdatePolicy, stageMacPreview } from "../scripts/package-macos-preview.js";
import { buildIdentitySchema } from "../src/contracts/build-identity.js";
const nobleSource = new URL("../node_modules/@noble/hashes/", import.meta.url);

async function fixture(kind: "development" | "stable" = "development", architecture: "arm64" | "x64" = "arm64") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-mac-package-"))), root = join(base, "source/electron");
  const write = async (path: string, value: string): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value);
  };
  const metadata = JSON.stringify({ name: "openwhisper-electron", version: "0.3.0", main: "dist/main/index.js", type: "module",
    dependencies: { koffi: "3.3.2", zod: "4.6.5", "@noble/hashes": "2.4.0" }, devDependencies: { electron: "44.7.0" } });
  await write("package.json", metadata);
  const koffi = `@koromix/koffi-darwin-${architecture}`;
  await write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {
    "node_modules/koffi": { version: "3.3.2" }, "node_modules/zod": { version: "4.6.5" },
    "node_modules/@noble/hashes": { version: "2.4.0" },
    [`node_modules/${koffi}`]: { version: "3.3.2" },
  } }));
  await mkdir(join(root, "node_modules/@noble"), { recursive: true });
  await cp(nobleSource, join(root, "node_modules/@noble/hashes"), { recursive: true });
  await write("node_modules/koffi/package.json", JSON.stringify({ name: "koffi", version: "3.3.2",
    optionalDependencies: { [koffi]: "3.3.2", "@koromix/koffi-linux-x64": "3.3.2" } }));
  await write(`node_modules/${koffi}/package.json`, JSON.stringify({ name: koffi, version: "3.3.2" }));
  await write(`node_modules/${koffi}/koffi.node`, "inert Koffi native fixture");
  await write("node_modules/zod/package.json", JSON.stringify({ name: "zod", version: "4.6.5" }));
  await write("node_modules/zod/index.js", "inert dependency fixture");
  for (const path of SPEECH_ENTRY_FILES.filter((path) => path !== "package.json")) await write(path, "inert speech graph fixture");
  const captured = async (path: string) => {
    const value = await readFile(join(root, path)); return { bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") };
  };
  for (const path of ["dist/native/capture/openwhisper_macos_capture.node", "dist/native/openwhisper_macos_capture.node",
    "dist/native/openwhisper_macos_retirement.node", "dist/native/speech/cpu/openwhisper_speech.node"]) await write(path, "inert native fixture");
  await write("dist/workers/macos-capture-entry.js", "inert capture fixture");
  const recording = developmentRecordingDescriptorSchema.parse({ version: 1, platform: "darwin", architecture,
    capture: await captured("dist/native/capture/openwhisper_macos_capture.node"), captureEntry: await captured("dist/workers/macos-capture-entry.js"),
    retirement: await captured("dist/native/openwhisper_macos_retirement.node"),
    speech: { version: 1, platform: "darwin", architecture, napiVersion: 8, speechRevision: "927cfce34f31707e17f2bff35c349632fb9e2c3a",
      speechSourceSha256: "41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde", entries: [{ backend: "cpu", ...await captured("dist/native/speech/cpu/openwhisper_speech.node") }] },
    speechEntryGraph: { version: 1, zodVersion: "4.6.5", entries: await Promise.all([...SPEECH_ENTRY_FILES, "node_modules/zod/package.json", "node_modules/zod/index.js"].map(async (path) => ({ path, ...await captured(path) }))) },
  });
  await write("dist/main/development-recording-build.js", `export const DEVELOPMENT_RECORDING_BUILD = ${JSON.stringify(recording)};\n`);
  await write("dist/main/index.js", "inert app fixture");
  const identity = buildIdentitySchema.parse(kind === "stable" ? { version: 1, kind, appId: "io.github.whisperfree", productName: "OpenWhisper" }
    : { version: 1, kind, appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" });
  await write("dist/main/application-build.js", `export const APPLICATION_BUILD = ${JSON.stringify(identity)};`);
  const source = '{"commit":"0123456789abcdef0123456789abcdef01234567","modified":true}';
  await write("dist/resources/development-build.json", source); await write("dist/resources/VERSION", "0.3.0\n");
  await write("dist/ui/fonts/LICENSE.txt", "fixture font license");
  await write("dist/native/macos-retirement-probe-notices/LICENSE", "excluded probe");
  await write("dist/native/openwhisper_macos_retirement_probe.node", "excluded probe");
  await write("node_modules/electron/path.txt", "Electron.app/Contents/MacOS/Electron");
  await write("node_modules/electron/dist/version", "44.7.0");
  const runtime = "node_modules/electron/dist/Electron.app";
  await write(`${runtime}/Contents/MacOS/Electron`, "inert runtime fixture");
  await write(`${runtime}/Contents/Info.plist`, "original outer plist");
  await write(`${runtime}/Contents/Resources/default_app.asar`, "original default app");
  await write(`${runtime}/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`, "inert framework fixture");
  await symlink("A", join(root, runtime, "Contents/Frameworks/Electron Framework.framework/Versions/Current"));
  await symlink("Versions/Current/Electron Framework", join(root, runtime, "Contents/Frameworks/Electron Framework.framework/Electron Framework"));
  for (const path of ["node_modules/electron/dist/LICENSE", "node_modules/electron/dist/LICENSES.chromium.html", "../LICENSE",
    "vendor/whisper.cpp/LICENSE", "native/build-cpu/build-manifest.json", "resources/AppIcon.icns",
    ...["LICENSE-MIT", "LICENSE-APACHE-2.0", "LICENSE.spdx"].map((name) => `../shared/ui/node_modules/@tauri-apps/api/${name}`)]) await write(path, "fixture original notice/icon");
  return { base, root, runtime, source, metadata, recording, identity, koffi, output: join(base, "preview") };
}

test("Mac preview copies exact captured inputs, architecture dependency, icon/notices and relative framework links without probes", async () => {
  const input = await fixture();
  try {
    const result = await stageMacPreview({ root: input.root, output: input.output, architecture: "arm64" });
    assert.equal(await readFile(join(result.application, "package.json"), "utf8"), input.metadata);
    assert.equal(await readFile(join(result.directory, "Contents/MacOS/OpenWhisper Dev"), "utf8"), "inert runtime fixture");
    await assert.rejects(lstat(join(result.directory, "Contents/MacOS/Electron")), { code: "ENOENT" });
    assert.equal(await readFile(join(input.root, input.runtime, "Contents/MacOS/Electron"), "utf8"), "inert runtime fixture");
    assert.equal(await readFile(join(result.application, "dist/resources/development-build.json"), "utf8"), input.source);
    assert.equal(await readlink(join(result.directory, "Contents/Frameworks/Electron Framework.framework/Versions/Current")), "A");
    assert.equal(await readFile(join(result.application, "node_modules/@koromix/koffi-darwin-arm64/koffi.node"), "utf8"), "inert Koffi native fixture");
    assert.equal(await readFile(join(result.directory, "Contents/Resources/AppIcon.icns"), "utf8"), "fixture original notice/icon");
    assert.equal(await readFile(join(result.directory, "Contents/Resources/notices/LICENSES.chromium.html"), "utf8"), "fixture original notice/icon");
    const license = await readFile(new URL("LICENSE", nobleSource));
    assert.equal(createHash("sha256").update(license).digest("hex"), "4f221aee6e072336700c408c68ab3b96a3fc09f6aebe6f48f1bd99e5ef13faec");
    assert.deepEqual(await readFile(join(result.directory, "Contents/Resources/notices/noble-hashes-LICENSE")), license);
    assert.deepEqual(await readFile(join(result.application, "node_modules/@noble/hashes/LICENSE")), license);
    assert.deepEqual(await readFile(join(result.application, "node_modules/@noble/hashes/blake2.js")), await readFile(new URL("blake2.js", nobleSource)));
    await assert.rejects(lstat(join(result.application, "dist/native/openwhisper_macos_retirement_probe.node")), { code: "ENOENT" });
    await assert.rejects(lstat(join(result.application, "node_modules/electron")), { code: "ENOENT" });
    await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "arm64" }), /fresh absolute output/);
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("Mac preview refuses a missing noble license before creating package output", async () => {
  const input = await fixture();
  try {
    await rm(join(input.root, "node_modules/@noble/hashes/LICENSE"));
    await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "arm64" }), { code: "ENOENT" });
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("each thin stable Mac validation package uses its captured identity and preserves original producer inputs", async () => {
  for (const architecture of ["arm64", "x64"] as const) {
    const input = await fixture("stable", architecture);
    try {
      const staged = await stageMacPreview({ root: input.root, output: input.output, architecture });
      assert.equal(staged.directory, join(input.output, "OpenWhisper.app"));
      assert.deepEqual(staged.identity, input.identity);
      assert.deepEqual(staged.recording, input.recording);
      assert.equal(await readFile(join(staged.directory, "Contents/MacOS/OpenWhisper"), "utf8"), "inert runtime fixture");
      assert.equal(await readFile(join(input.root, input.runtime, "Contents/MacOS/Electron"), "utf8"), "inert runtime fixture");
      for (const path of ["package.json", "package-lock.json", "dist/main/application-build.js", "dist/main/development-recording-build.js", "dist/resources/development-build.json"]) {
        assert.deepEqual(await readFile(join(staged.application, path)), await readFile(join(input.root, path)));
      }
      assert.equal(await readFile(join(staged.application, `node_modules/${input.koffi}/koffi.node`), "utf8"), "inert Koffi native fixture");
      assert.deepEqual(await readFile(join(staged.directory, "Contents/Resources/notices/speech-cpu-unsigned-build.json")),
        await readFile(join(input.root, "native/build-cpu/build-manifest.json")));
      assert.match(await readFile(join(staged.directory, "Contents/Resources/notices/README.txt"), "utf8"), /^OpenWhisper\. Per-architecture, non-hardened ad-hoc validation signing/u);
    } finally { await rm(input.base, { recursive: true, force: true }); }
  }
});

test("persistent validation stages only clean thin stable captures while preserving unsigned source and notices", async () => {
  const previous = process.env["SIGN_IDENTITY"], fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
  process.env["SIGN_IDENTITY"] = fingerprint;
  try {
    for (const architecture of ["arm64", "x64"] as const) {
      const input = await fixture("stable", architecture);
      try {
        const source = { commit: "0123456789abcdef0123456789abcdef01234567", modified: false };
        await writeFile(join(input.root, "dist/resources/development-build.json"), JSON.stringify(source));
        const staged = await stageMacPreview({ root: input.root, output: input.output, architecture, signingMode: "persistent-validation" });
        assert.deepEqual(staged.source, source); assert.equal(staged.signing.mode, "persistent-validation");
        assert.equal(staged.signing.identity, fingerprint); assert.ok(Object.isFrozen(staged.signing));
        assert.deepEqual(macPreviewCodesignArguments(staged.signing, staged.directory), ["--force", "--sign", fingerprint, "--timestamp=none", staged.directory]);
        assert.equal(staged.directory, join(input.output, "OpenWhisper.app"));
        assert.deepEqual(await readFile(join(staged.application, "dist/resources/development-build.json")), await readFile(join(input.root, "dist/resources/development-build.json")));
        assert.deepEqual(await readFile(join(staged.directory, "Contents/Resources/notices/speech-cpu-unsigned-build.json")), await readFile(join(input.root, "native/build-cpu/build-manifest.json")));
        assert.match(await readFile(join(staged.directory, "Contents/Resources/notices/README.txt"), "utf8"), /^OpenWhisper\. Per-architecture, non-hardened persistent certificate validation signing; no notarization or stable update channel/u);
        assert.deepEqual(staged.recording, input.recording);
      } finally { await rm(input.base, { recursive: true, force: true }); }
    }
  } finally { if (previous === undefined) delete process.env["SIGN_IDENTITY"]; else process.env["SIGN_IDENTITY"] = previous; }
});

test("persistent policy rejects Dev, source or modified provenance, noncanonical versions and fingerprint fallback", () => {
  const stable = buildIdentitySchema.parse({ version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" });
  const dev = buildIdentitySchema.parse({ version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" });
  const source = { commit: "0123456789abcdef0123456789abcdef01234567", modified: false }, fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
  for (const identity of [undefined, "", "-", "WhisperFree Dev", `${fingerprint}\n`, ` ${fingerprint}`, fingerprint.slice(1), `${fingerprint}0`, "g".repeat(40)]) {
    assert.throws(() => macPreviewSigningPolicy("persistent-validation", stable, "0.3.0", source, identity), /exact certificate fingerprint/u);
  }
  for (const provenance of [{ ...source, commit: "source" }, { ...source, modified: true }, { ...source, commit: `${source.commit}\n` }]) {
    assert.throws(() => macPreviewSigningPolicy("persistent-validation", stable, "0.3.0", provenance, fingerprint), /clean committed stable/u);
  }
  assert.throws(() => macPreviewSigningPolicy("persistent-validation", dev, "0.3.0", source, fingerprint), /clean committed stable/u);
  for (const version of ["03.0.0", "0.3.0\n", "18446744073709551616.0.0", "0.3.0-dev"]) {
    assert.throws(() => macPreviewSigningPolicy("persistent-validation", stable, version, source, fingerprint));
  }
  for (const certificate of [fingerprint, fingerprint.toLowerCase()]) {
    assert.equal(macPreviewSigningPolicy("persistent-validation", stable, "0.3.0", source, certificate).identity, certificate);
  }
  const defaultPolicy = macPreviewSigningPolicy("ad-hoc", dev, "0.3.0", { ...source, modified: true }, fingerprint);
  assert.equal(defaultPolicy.identity, "-");
  assert.deepEqual(macPreviewCodesignArguments(defaultPolicy, "/private/fixture/app.node"), ["--force", "--sign", "-", "--timestamp=none", "/private/fixture/app.node"]);
  assert.throws(() => macPreviewCodesignArguments({ ...defaultPolicy, identity: fingerprint }, "/private/fixture/app.node"));
  assert.throws(() => macPreviewCodesignArguments({ ...defaultPolicy, mode: "persistent-validation" }, "/private/fixture/app.node"));
});

test("release construction is explicit and requires stable persistent signing plus compiled update policy", () => {
  const stable = buildIdentitySchema.parse({ version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" });
  const dev = buildIdentitySchema.parse({ version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" });
  const signing = { mode: "persistent-validation" as const, identity: "0123456789abcdef0123456789abcdef01234567", description: "fixture" };
  const update = { version: 1 as const, repository: "juferdinand/OpenWhisper" as const,
    certificateFingerprint: signing.identity };
  assert.equal(macPackageConstructionMode(undefined, stable, signing, null), "validation");
  assert.equal(macPackageConstructionMode("release", stable, signing, update), "release");
  assert.throws(() => macPackageConstructionMode("release", stable, signing, null), /updater policy enabled/u);
  assert.throws(() => macPackageConstructionMode("release", dev, signing, update), /updater policy enabled/u);
  assert.throws(() => macPackageConstructionMode("release", stable, { ...signing, mode: "ad-hoc" }, update), /updater policy enabled/u);
});

test("only an explicit persistent stable packaging choice emits a fixed updater policy without mutating source", async () => {
  const previous = process.env["SIGN_IDENTITY"], fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
  process.env["SIGN_IDENTITY"] = fingerprint;
  try {
    for (const enableUpdates of [false, true]) {
      const input = await fixture("stable");
      try {
        await writeFile(join(input.root, "dist/resources/development-build.json"), JSON.stringify({ commit: fingerprint.toLowerCase(), modified: false }));
        const original = "export const APPLICATION_MACOS_UPDATE_BUILD = null;\n";
        await writeFile(join(input.root, "dist/main/macos-update-build.js"), original);
        const result = await stageMacPreview({ root: input.root, output: input.output, architecture: "arm64", signingMode: "persistent-validation", enableUpdates });
        const policy = result.updatePolicy;
        assert.deepEqual(policy, enableUpdates ? { version: 1, repository: "juferdinand/OpenWhisper", certificateFingerprint: fingerprint.toLowerCase() } : null);
        const module = await readFile(join(result.application, "dist/main/macos-update-build.js"), "utf8");
        assert.match(module, enableUpdates ? /"repository":\s*"juferdinand\/OpenWhisper"/u : /APPLICATION_MACOS_UPDATE_BUILD\s*=\s*null/u);
        assert.equal(await readFile(join(input.root, "dist/main/macos-update-build.js"), "utf8"), original);
      } finally { await rm(input.base, { recursive: true, force: true }); }
    }
    const dev = buildIdentitySchema.parse({ version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" });
    const stable = buildIdentitySchema.parse({ version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" });
    const signing = { mode: "persistent-validation" as const, identity: fingerprint, description: "owned fixture" };
    assert.equal(macPreviewUpdatePolicy(undefined, stable, signing), null);
    assert.throws(() => macPreviewUpdatePolicy(true, dev, signing));
    assert.throws(() => macPreviewUpdatePolicy(true, stable, { ...signing, mode: "ad-hoc", identity: "-" }));
    const input = await fixture("stable");
    try {
      await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "arm64", enableUpdates: true }));
      await assert.rejects(lstat(input.output), { code: "ENOENT" });
    } finally { await rm(input.base, { recursive: true, force: true }); }
  } finally { if (previous === undefined) delete process.env["SIGN_IDENTITY"]; else process.env["SIGN_IDENTITY"] = previous; }
});

test("persistent stage admission refuses missing fingerprint and modified or Dev captures before output creation", async () => {
  const previous = process.env["SIGN_IDENTITY"], fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
  try {
    for (const kind of ["stable", "development"] as const) {
      const input = await fixture(kind);
      try {
        process.env["SIGN_IDENTITY"] = fingerprint;
        await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "arm64", signingMode: "persistent-validation" }), /clean committed stable/u);
        await assert.rejects(lstat(input.output), { code: "ENOENT" });
        if (kind === "stable") {
          await writeFile(join(input.root, "dist/resources/development-build.json"), '{"commit":"0123456789abcdef0123456789abcdef01234567","modified":false}');
          delete process.env["SIGN_IDENTITY"];
          await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "arm64", signingMode: "persistent-validation" }), /exact certificate fingerprint/u);
          await assert.rejects(lstat(input.output), { code: "ENOENT" });
        }
      } finally { await rm(input.base, { recursive: true, force: true }); }
    }
  } finally { if (previous === undefined) delete process.env["SIGN_IDENTITY"]; else process.env["SIGN_IDENTITY"] = previous; }
});

test("Mac preview refuses mixed captured identities before creating output", async () => {
  const input = await fixture();
  try {
    await writeFile(join(input.root, "dist/main/application-build.js"),
      'export const APPLICATION_BUILD = {"version":1,"kind":"stable","appId":"io.github.whisperfree.dev","productName":"OpenWhisper"};');
    await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "arm64" }));
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("Mac plist and retained helper names use matching fixed Dev or stable identity", () => {
  for (const kind of ["development", "stable"] as const) {
    const identity = buildIdentitySchema.parse(kind === "stable" ? { version: 1, kind, appId: "io.github.whisperfree", productName: "OpenWhisper" }
      : { version: 1, kind, appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" });
    assert.deepEqual(macPreviewPlistValues(identity, "0.3.0"), { CFBundleIdentifier: identity.appId, CFBundleExecutable: identity.productName,
      CFBundleName: identity.productName, CFBundleDisplayName: identity.productName, CFBundleVersion: "0.3.0", CFBundleShortVersionString: "0.3.0",
      CFBundleIconFile: "AppIcon", LSMinimumSystemVersion: "14.0", NSMicrophoneUsageDescription: `${identity.productName} needs microphone access to record your voice. Everything stays on your Mac.` });
    for (const [name, suffix] of [["Electron Helper.app", "electron-helper-app"], ["Electron Helper (Renderer).app", "electron-helper-renderer-app"]]) {
      assert.equal(macHelperBundleIdentifier(identity, name!), `${identity.appId}.helper.${suffix}`);
    }
    assert.throws(() => macPreviewPlistValues(identity, "03.0.0"));
  }
});

test("Mac preview rejects escaped framework links, wrong architecture and stale native capture before staging", async () => {
  const input = await fixture();
  try {
    await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "x64" }), /architecture differs/);
    const link = join(input.root, input.runtime, "Contents/escape"); await symlink("../../../../../package.json", link);
    await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "arm64" }), /symlink/);
    await rm(link);
    await writeFile(join(input.root, "dist/native/openwhisper_macos_retirement.node"), "changed native");
    await assert.rejects(stageMacPreview({ root: input.root, output: input.output, architecture: "arm64" }), /Captured native input changed/);
    await assert.rejects(lstat(input.output), { code: "ENOENT" });
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("build-time Mac signing finalization updates native admission while retaining source graph and rejecting changed JavaScript", async () => {
  const input = await fixture();
  try {
    const staged = await stageMacPreview({ root: input.root, output: input.output, architecture: "arm64" });
    for (const path of ["dist/native/capture/openwhisper_macos_capture.node", "dist/native/openwhisper_macos_capture.node",
      "dist/native/openwhisper_macos_retirement.node", "dist/native/speech/cpu/openwhisper_speech.node"]) await writeFile(join(staged.application, path), "signed fixture bytes");
    const signed = await captureSignedMacDescriptor(staged.application, input.recording);
    assert.notEqual(signed.capture.sha256, input.recording.capture.sha256);
    assert.deepEqual(signed.speechEntryGraph, input.recording.speechEntryGraph);
    assert.equal(await readFile(join(input.root, "dist/main/development-recording-build.js"), "utf8"), `export const DEVELOPMENT_RECORDING_BUILD = ${JSON.stringify(input.recording)};\n`);
    await writeFile(join(staged.application, "dist/workers/speech-entry.js"), "changed graph");
    await assert.rejects(captureSignedMacDescriptor(staged.application, signed), /Captured recording input changed/);
  } finally { await rm(input.base, { recursive: true, force: true }); }
});

test("Mac binary inventory rejects architecture and hardened or entitlement policy changes", () => {
  const bytes = Buffer.alloc(112); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x100000c, 4); bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(0x1d, 32); bytes.writeUInt32LE(16, 36); bytes.writeUInt32LE(64, 40); bytes.writeUInt32LE(48, 44);
  bytes.writeUInt32BE(0xfade0cc0, 64); bytes.writeUInt32BE(48, 68); bytes.writeUInt32BE(1, 72);
  bytes.writeUInt32BE(0, 76); bytes.writeUInt32BE(20, 80); bytes.writeUInt32BE(0x20002, 96);
  assert.equal(inspectMacBinary(bytes, "arm64"), true);
  assert.throws(() => inspectMacBinary(bytes, "x64"), /architecture/);
  bytes.writeUInt32BE(0x10000, 96); assert.throws(() => inspectMacBinary(bytes, "arm64"), /hardened/);
  bytes.writeUInt32BE(5, 76); assert.throws(() => inspectMacBinary(bytes, "arm64"), /entitlements/);
});

test("Mac deployment inspection ignores actual pinned Koffi and CI linker versions, SDK and source version fields", () => {
  // Values measured from locked Koffi3.3.2 and run37827484622 capture/retirement Mach-O artifacts.
  for (const [minimum, sdk, linker] of [["11.0", "11.3", "711.0"], ["14.0", "15.5", "1167.5"]]) {
    const output = `Load command 8\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${minimum}\n      sdk ${sdk}\n   ntools 1\n     tool 3\n  version ${linker}\nLoad command 9\n      cmd LC_SOURCE_VERSION\n  cmdsize 16\n  version 2053.120.3\n`;
    assert.equal(inspectMacMinimumOS(output, "dist/native/capture/openwhisper_macos_capture.node"), `${minimum}.0`);
  }
  assert.equal(inspectMacMinimumOS("cmd LC_VERSION_MIN_MACOSX\nversion 10.15\nsdk 26.0\ncmd LC_SOURCE_VERSION\nversion 2053.120.3\n", "koffi.node"), "10.15.0");
});

test("Mac deployment inspection preserves the baseline and names unsupported or missing measured floors", () => {
  for (const version of ["14.0.1", "14.1", "15.0"]) {
    assert.throws(() => inspectMacMinimumOS(`cmd LC_BUILD_VERSION\nminos ${version}\nsdk 26.0\n`, "dist/native/speech/cpu/openwhisper_speech.node"),
      new RegExp(`dist/native/speech/cpu/openwhisper_speech.node.*measured macOS ${version.replaceAll(".", "\\.")}.*14\\.0\\.0`, "u"));
  }
  assert.throws(() => inspectMacMinimumOS("cmd LC_SOURCE_VERSION\nversion 14.0\n", "koffi.node"), /koffi\.node.*no measured macOS deployment floor/u);
});

test("unsigned Intel runtime signs Crashpad, dylibs and ShipIt before enclosing framework executables", () => {
  const root = "/private/preview/OpenWhisper Dev.app/Contents/Frameworks";
  const electron = `${root}/Electron Framework.framework/Versions/A/Electron Framework`;
  const crashpad = `${root}/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler`;
  const ffmpeg = `${root}/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`;
  const squirrel = `${root}/Squirrel.framework/Versions/A/Squirrel`;
  const shipIt = `${root}/Squirrel.framework/Versions/A/Resources/ShipIt`;
  const main = "/private/preview/OpenWhisper Dev.app/Contents/MacOS/OpenWhisper Dev";
  // Lexicographic inventory starts with the framework executable that previously failed codesign.
  const input = [electron, crashpad, ffmpeg, squirrel, shipIt, main], original = [...input];
  const signing = insideOutMacCodePaths(input);
  for (const [nested, enclosing] of [[crashpad, electron], [ffmpeg, electron], [shipIt, squirrel], [electron, main]]) {
    assert.ok(signing.indexOf(nested!) < signing.indexOf(enclosing!));
  }
  assert.deepEqual(input, original);
  assert.equal(new Set(signing).size, input.length);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateCore, candidatePackageSchema, candidateProfileSchema, asyncRequestSchema, candidateBuildPlan,
  validateCandidateArtifactHashes, validateCandidateNativeInputHashes } from "./candidate-contracts.js";
import { parseCandidateArguments } from "./candidate-run.js";
import { HEADER_SHA, IMAGE, RUNTIME_SHA, SECCOMP_SHA } from "../owned-bus-opening/launch-contracts.js";
import { LEGACY_BASE_SHA, SERVICE_MANIFEST_SHA, SERVICE_SHA, serviceProofHashes } from "../owned-bus-opening/legacy-retained-contracts.js";
import { SERVICE_SOURCE_SHA } from "../owned-bus-opening/remaining-contracts.js";
import { RETAINED_SHA } from "../owned-bus-opening/retained-contracts.js";

const manifest = { version: 1, image: IMAGE, runtime: RUNTIME_SHA, header: HEADER_SHA, seccomp: SECCOMP_SHA,
  source: candidateCore, payload: {}, node: "24.21.0", electron: "44.7.0", napi: 8, mode: "candidate-async-native-build",
  service: { binary: SERVICE_SHA, manifest: SERVICE_MANIFEST_SHA, provenance: serviceProofHashes["service-provenance.json"], source: SERVICE_SOURCE_SHA },
  legacyBase: LEGACY_BASE_SHA, profiles: ["opening", "cleanup", "async", "legacy"] };

test("candidate mode cannot silently select retained-native execution or alter the first-failure profile sequence", () => {
  candidatePackageSchema.parse(manifest);
  for (const patch of [{ mode: "retained-legacy-diagnostic" }, { profiles: ["legacy"] },
    { profiles: ["opening", "cleanup", "legacy", "async"] }, { legacyBase: "0".repeat(64) },
    { service: { ...manifest.service, binary: RETAINED_SHA } }, { service: { ...manifest.service, source: "0".repeat(64) } }])
    assert.equal(candidatePackageSchema.safeParse({ ...manifest, ...patch }).success, false);
  assert.equal(candidateProfileSchema.safeParse("desktop").success, false);
});
test("candidate artifact proof requires the actual new addon and original fixed service in exact owned destinations", () => {
  const native = "1".repeat(64), line = `${native}  /owned-app/dist/native/openwhisper_linux_bus.node\n${SERVICE_SHA}  /owned-app/tests/owned-bus/service`;
  validateCandidateArtifactHashes(line, native);
  for (const input of [line.replace(native, RETAINED_SHA), line.replace(SERVICE_SHA, native), line.replace("/owned-app/", "/host/"), `${line}\nextra`])
    assert.throws(() => validateCandidateArtifactHashes(input, native));
  assert.throws(() => validateCandidateArtifactHashes(line.replace(native, RETAINED_SHA), RETAINED_SHA));
});
test("candidate compiled-input proof refuses a stale codec source rather than reusing the prior artifact scope", () => {
  const line = ["CMakeLists.txt", "binding.cpp", "codec.cpp", "codec.hpp"].map((name) => `${candidateCore[`native/linux-bus/${name}`]}  /owned-app/native-linux-bus/${name}`).join("\n");
  validateCandidateNativeInputHashes(line);
  assert.throws(() => validateCandidateNativeInputHashes(line.replace(candidateCore["native/linux-bus/codec.cpp"] ?? "", "76fc603ba5908ae76c897c10e58061da105fd03f3e698284aa1b8b37b11d0f64")));
  assert.throws(() => validateCandidateNativeInputHashes(`${line}\nextra`));
});
test("candidate native build remains one configure and one explicit addon build without service or dependency compile fallback", () => {
  const plan = candidateBuildPlan(); assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((args) => args[0]), ["cmake", "cmake"]);
  assert.equal(plan.some((args) => args.some((arg) => arg.includes("service.cpp") || arg.includes("http") || arg === "c++")), false);
  assert.deepEqual(plan[0]?.filter((arg) => arg.startsWith("-DCMAKE_CXX_")),
    ["-DCMAKE_CXX_STANDARD=17", "-DCMAKE_CXX_STANDARD_REQUIRED=ON", "-DCMAKE_CXX_EXTENSIONS=OFF"]);
  assert.ok(plan[0]?.includes("-DNODE_HEADERS=/owned-app/vendor/node-headers/include/node"));
});
test("candidate argv is a closed explicit source-prepare or reviewed execution operation", () => {
  assert.equal(parseCandidateArguments(["--prepare", "--output", "/new", "--headers", "/pin", "--seccomp", "/profile", "--service-original", "/original"]).mode, "prepare");
  assert.deepEqual(parseCandidateArguments(["--execute", "--package", "/frozen"]), { mode: "execute", directory: "/frozen" });
  for (const args of [[], ["--execute", "--package", "/frozen", "--retry"], ["--prepare", "--output", "/new"],
    ["--execute", "--package", "/frozen", "--native-original", "/old"]]) assert.throws(() => parseCandidateArguments(args));
});
test("async utility request rejects cleanup or extra native/resource path authority", () => {
  const request = { version: 1, id: "19518137-123a-49a2-9d12-d148680563cb", command: "run", address: "unix:path=/tmp/openwhisper-owned-bus" };
  asyncRequestSchema.parse(request);
  for (const patch of [{ command: "cleanup" }, { binding: "/host/native.node" }, { address: "unix:path=/run/user/1000/bus" },
    { id: "not-a-uuid" }, { noAutoStart: false }]) assert.equal(asyncRequestSchema.safeParse({ ...request, ...patch }).success, false);
});

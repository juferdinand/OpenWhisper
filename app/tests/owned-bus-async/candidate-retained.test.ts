import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatePackageSchema } from "./candidate-contracts.js";
import { retainedCandidateSchema, candidateNativeSha, nativeProofHashes, traversalModes, validateTraversalModes, validateRetainedArtifact } from "./candidate-retained.js";
import { parseRetainedCandidateArgs } from "./candidate-retained-run.js";
import { IMAGE, HEADER_SHA, RUNTIME_SHA, SECCOMP_SHA } from "../owned-bus-opening/launch-contracts.js";
import { LEGACY_BASE_SHA, SERVICE_SHA, SERVICE_MANIFEST_SHA, serviceProofHashes } from "../owned-bus-opening/legacy-retained-contracts.js";
import { SERVICE_SOURCE_SHA } from "../owned-bus-opening/remaining-contracts.js";

test("retained candidate is disjoint from build mode and cannot add profiles or replace accepted binaries", () => {
  const manifest = { version: 1, image: IMAGE, runtime: RUNTIME_SHA, header: HEADER_SHA, seccomp: SECCOMP_SHA, source: {}, payload: {},
    node: "24.21.0", electron: "44.7.0", napi: 8, mode: "retained-async-candidate-legacy", profiles: ["legacy"], legacyBase: LEGACY_BASE_SHA,
    service: { binary: SERVICE_SHA, manifest: SERVICE_MANIFEST_SHA, provenance: serviceProofHashes["service-provenance.json"], source: SERVICE_SOURCE_SHA },
    retained: { native: candidateNativeSha, manifest: nativeProofHashes["original-manifest.json"], provenance: nativeProofHashes["native-provenance.json"] } };
  retainedCandidateSchema.parse(manifest); assert.equal(candidatePackageSchema.safeParse(manifest).success, false);
  for (const patch of [{ profiles: ["opening", "legacy"] }, { mode: "candidate-async-native-build" },
    { retained: { ...manifest.retained, native: "0".repeat(64) } }, { retained: { ...manifest.retained, provenance: "0".repeat(64) } }])
    assert.equal(retainedCandidateSchema.safeParse({ ...manifest, ...patch }).success, false);
});
test("foreign traversal guard requires only three0701 ancestors and preserves private siblings and fixed service modes", () => {
  const facts = traversalModes.map((entry) => ({ ...entry, uid: 1000 })); validateTraversalModes(facts);
  for (const [index, entry] of facts.entries()) for (const patch of [{ mode: entry.mode === 0o700 ? 0o755 : 0o700 },
    { mode: entry.mode === 0o701 ? 0o755 : 0o701 }, { mode: 0o777 }, { uid: 1001 }, { kind: "symlink" }, { path: "../host" }]) {
    const altered = facts.map((value, current) => current === index ? { ...value, ...patch } : value);
    assert.throws(() => validateTraversalModes(altered));
  }
  assert.throws(() => validateTraversalModes(facts.slice(1)));
  assert.throws(() => validateTraversalModes([...facts, { path: "extra", uid: 1000, kind: "directory", mode: 0o701 }]));
});
test("retained artifact receipt cannot accept old addon or altered fixed service and argv has no compile or profile option", () => {
  const line = `${candidateNativeSha}  /owned-app/dist/native/openwhisper_linux_bus.node\n${SERVICE_SHA}  /owned-app/tests/owned-bus/service`;
  validateRetainedArtifact(line); assert.throws(() => validateRetainedArtifact(line.replace(candidateNativeSha, "0".repeat(64))));
  assert.throws(() => validateRetainedArtifact(line.replace(SERVICE_SHA, "0".repeat(64))));
  assert.deepEqual(parseRetainedCandidateArgs(["--execute", "--package", "/fixed"]), { mode: "execute", directory: "/fixed" });
  assert.equal(parseRetainedCandidateArgs(["--prepare", "--output", "/new", "--headers", "/pin", "--seccomp", "/fixed", "--native-original", "/original", "--service-original", "/service"]).mode, "prepare");
  for (const args of [[], ["--execute", "--package", "/fixed", "--compile"], ["--execute", "--package", "/fixed", "--profile", "opening"]])
    assert.throws(() => parseRetainedCandidateArgs(args));
});

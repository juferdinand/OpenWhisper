import assert from "node:assert/strict";
import { test } from "node:test";
import { admitMacosUpdates, macosUpdatePublisherArguments } from "../src/main/macos-update-admission.js";
import { buildIdentitySchema } from "../src/contracts/build-identity.js";

const stable = buildIdentitySchema.parse({ version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" });
const development = buildIdentitySchema.parse({ version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" });
const fingerprint = "0123456789abcdef0123456789abcdef01234567";
const policy = { version: 1, repository: "juferdinand/OpenWhisper", certificateFingerprint: fingerprint };
const bundle = "/Applications/OpenWhisper.app", executable = `${bundle}/Contents/MacOS/OpenWhisper`;
function fixture() {
  const calls: string[] = [];
  const input = { policy: policy as unknown, identity: stable, packaged: true, currentVersion: "0.3.0", executable };
  const effects = { platform: "darwin", uid: 501 as number | undefined, canonical: (path: string) => path,
    writableParent: (path: string) => { calls.push(`parent:${path}`); },
    verifyPublisher: (path: string, certificate: string) => { calls.push(`publisher:${path}:${certificate}`); },
    verifyRunningBundle: (path: string) => { calls.push(`self:${path}`); } };
  return { calls, input, effects };
}

test("Mac update capability requires the fixed compiled publisher and actual running bundle in order", () => {
  const value = fixture(), result = admitMacosUpdates(value.input, value.effects);
  assert.deepEqual(result, { repository: "juferdinand/OpenWhisper", bundle, executable });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(value.calls, ["parent:/Applications", `publisher:${bundle}:${fingerprint}`, `self:${bundle}`]);
  assert.deepEqual(macosUpdatePublisherArguments(bundle, fingerprint), ["--verify", "--deep", "--strict", "--all-architectures",
    "--test-requirement", `certificate leaf = H\"${fingerprint}\"`, bundle]);
  assert.throws(() => macosUpdatePublisherArguments(bundle, "-"));
});
test("ordinary, Dev and ad-hoc build inputs never acquire the Mac update capability", () => {
  for (const changes of [{ policy: null }, { policy: { ...policy, repository: "other/OpenWhisper" } },
    { policy: { ...policy, certificateFingerprint: "-" } }, { policy: { ...policy, extra: true } },
    { identity: development }, { packaged: false }, { currentVersion: "0.3.0-dev" }]) {
    const value = fixture(); assert.equal(admitMacosUpdates({ ...value.input, ...changes }, value.effects), undefined);
    assert.deepEqual(value.calls, []);
  }
  for (const changes of [{ platform: "linux" }, { uid: 0 }, { uid: undefined }]) {
    const value = fixture(); assert.equal(admitMacosUpdates(value.input, { ...value.effects, ...changes }), undefined);
    assert.deepEqual(value.calls, []);
  }
});
test("publisher, current-process, canonical-path and installation access refusal stay optional", () => {
  for (const step of ["canonical", "writableParent", "verifyPublisher", "verifyRunningBundle"] as const) {
    const value = fixture(); value.effects[step] = () => { throw new Error("owned refusal"); };
    assert.equal(admitMacosUpdates(value.input, value.effects), undefined);
  }
  const value = fixture(); value.effects.canonical = () => "/foreign";
  assert.equal(admitMacosUpdates(value.input, value.effects), undefined); assert.deepEqual(value.calls, []);
  for (const path of ["relative", "/Applications/OpenWhisper Dev.app/Contents/MacOS/OpenWhisper", `${executable}/../OpenWhisper`, `${executable}\n`]) {
    const current = fixture(); assert.equal(admitMacosUpdates({ ...current.input, executable: path }, current.effects), undefined);
    assert.deepEqual(current.calls, []);
  }
});

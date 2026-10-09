import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { test } from "node:test";
import { linuxReleaseUpdatePolicyDescriptor } from "../../scripts/package-linux-release.js";
import { LINUX_UPDATE_PUBLIC_KEY } from "../../src/services/update/linux/linux-update-signature.js";
import { LINUX_UPDATE_FEED_URL } from "../../src/services/update/common/update-policy.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("release constructor accepts the emitted workflow update-policy descriptor", async () => {
  const [emittedSignature, emittedPolicy] = await Promise.all([
    build({ entryPoints: [join(appRoot, "src/services/update/linux/linux-update-signature.ts")],
      bundle: true, write: false, platform: "node", format: "esm", target: "node24", sourcemap: false }),
    build({ entryPoints: [join(appRoot, "src/services/update/common/update-policy.ts")],
      bundle: true, write: false, platform: "node", format: "esm", target: "node24", sourcemap: false }),
  ]);
  const signatureText = emittedSignature.outputFiles[0]?.text, policyText = emittedPolicy.outputFiles[0]?.text;
  assert.ok(signatureText);
  assert.ok(policyText);
  const [signatureModule, policyModule] = await Promise.all([
    import(`data:text/javascript;base64,${Buffer.from(signatureText).toString("base64")}`) as Promise<Readonly<Record<string, unknown>>>,
    import(`data:text/javascript;base64,${Buffer.from(policyText).toString("base64")}`) as Promise<Readonly<Record<string, unknown>>>,
  ]);
  const descriptor = linuxReleaseUpdatePolicyDescriptor(signatureModule, policyModule, signatureText);
  assert.deepEqual(descriptor, {
    publicKey: LINUX_UPDATE_PUBLIC_KEY,
    feedURL: LINUX_UPDATE_FEED_URL,
    requireSignedVersion: true,
  });
  assert.throws(() => linuxReleaseUpdatePolicyDescriptor(signatureModule, {
    ...policyModule, LINUX_UPDATE_FEED_URL: "https://attacker.invalid/latest.json",
  }, signatureText), { message: "LINUX_RELEASE_UPDATE_POLICY_MISMATCH" });
  assert.throws(() => linuxReleaseUpdatePolicyDescriptor({
    ...signatureModule, LINUX_UPDATE_PUBLIC_KEY: "different-key",
  }, policyModule, signatureText), { message: "LINUX_RELEASE_UPDATE_POLICY_MISMATCH" });
  assert.throws(() => linuxReleaseUpdatePolicyDescriptor({
    ...signatureModule, verifyLinuxUpdateStream: undefined,
  }, policyModule, signatureText), { message: "LINUX_RELEASE_UPDATE_POLICY_MISMATCH" });
  assert.throws(() => linuxReleaseUpdatePolicyDescriptor(signatureModule, policyModule,
    signatureText.replaceAll("SIGNED_VERSION_MISMATCH", "")), { message: "LINUX_RELEASE_UPDATE_POLICY_MISMATCH" });
});

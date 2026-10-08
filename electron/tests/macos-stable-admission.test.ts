import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { macosLoginFact, macosMigrationContext, verifyMacApplicationBundle } from "../src/main/macos-stable-admission.js";
import { StableMigrationError } from "../src/contracts/stable-migration.js";

const catalog: unknown = JSON.parse(readFileSync(new URL("../../shared/models.json", import.meta.url), "utf8"));
const facts = { languages: ["de-DE"], architecture: "arm64", physicalMemory: 8 * 1_073_741_824, loginStatus: "not-registered", catalog };

test("Mac login facts distinguish requested pending and disabled while unknown state refuses", () => {
  assert.deepEqual(macosLoginFact("enabled"), { status: "enabled", requested: true, pending: false });
  assert.deepEqual(macosLoginFact("requires-approval"), { status: "requires-approval", requested: true, pending: true });
  assert.deepEqual(macosLoginFact("not-registered"), { status: "not-registered", requested: false, pending: false });
  for (const status of ["not-found", "", undefined, null, false]) assert.throws(() => macosLoginFact(status),
    (error: unknown) => error instanceof StableMigrationError && error.code === "LOGIN_STATE_UNKNOWN");
});

test("native Mac recommendation defaults retain compile architecture memory rounding and language policy", () => {
  assert.equal(macosMigrationContext(facts).defaults.recommendedModel, "parakeet-v3-q8");
  assert.equal(macosMigrationContext({ ...facts, physicalMemory: 7.49 * 1_073_741_824 }).defaults.recommendedModel, "parakeet-v3-q4");
  assert.equal(macosMigrationContext({ ...facts, physicalMemory: 7.51 * 1_073_741_824 }).defaults.recommendedModel, "parakeet-v3-q8");
  const intel = macosMigrationContext({ ...facts, architecture: "x64", languages: ["ja-JP"] });
  assert.equal(intel.defaults.appleSilicon, false); assert.equal(intel.defaults.recommendedModel, "base");
  assert.equal(intel.systemLanguage, "ja-JP");
  const pending = macosMigrationContext({ ...facts, loginStatus: "requires-approval" });
  assert.equal(pending.loginStatus, "requires-approval"); assert.equal(pending.defaults.launchAtLogin, true);
});

test("invalid Mac hardware and language facts cannot create a migration context", () => {
  for (const overrides of [{ physicalMemory: NaN }, { physicalMemory: 0 }, { architecture: "ia32" },
    { languages: ["x".repeat(129)] }]) assert.throws(() => macosMigrationContext({ ...facts, ...overrides }));
});

test("portable bundle admission refuses before invoking any Mac system tool", { skip: process.platform === "darwin" }, () => {
  assert.throws(() => verifyMacApplicationBundle({ version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" },
    "0.3.0", "/never-read/OpenWhisper.app/Contents/MacOS/OpenWhisper"), /requires Darwin/);
});

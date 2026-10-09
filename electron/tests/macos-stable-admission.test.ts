import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MacBundleAdmissionError, macBundleToolFailure, readMacBundleFailure, macosLoginFact, macosMigrationContext, verifyMacApplicationBundle } from "../src/main/macos-stable-admission.js";
import { StableMigrationError } from "../src/contracts/stable-migration.js";
import { legacyMacosMigrationContextSchema } from "../src/services/legacy-macos-data.js";

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

test("Mac migration preserves all known login states without admitting absent service control", () => {
  for (const [loginStatus, launchAtLogin] of [["enabled", true], ["requires-approval", true], ["not-registered", false], ["not-found", false]] as const) {
    const context = macosMigrationContext({ ...facts, loginStatus });
    assert.equal(context.loginStatus, loginStatus); assert.equal(context.defaults.launchAtLogin, launchAtLogin);
    assert.deepEqual(legacyMacosMigrationContextSchema.parse(context), context);
    assert.equal(legacyMacosMigrationContextSchema.safeParse({ ...context, defaults: { ...context.defaults, launchAtLogin: !launchAtLogin } }).success, false);
  }
  for (const loginStatus of ["", "unavailable", "future-status", undefined, null, false]) {
    assert.throws(() => macosMigrationContext({ ...facts, loginStatus }),
      (error: unknown) => error instanceof StableMigrationError && error.code === "LOGIN_STATE_UNKNOWN");
  }
  assert.throws(() => macosLoginFact("not-found"),
    (error: unknown) => error instanceof StableMigrationError && error.code === "LOGIN_STATE_UNKNOWN");
});

test("invalid Mac hardware and language facts cannot create a migration context", () => {
  for (const overrides of [{ physicalMemory: NaN }, { physicalMemory: 0 }, { architecture: "ia32" },
    { languages: ["x".repeat(129)] }]) assert.throws(() => macosMigrationContext({ ...facts, ...overrides }));
});

test("portable bundle admission refuses before invoking any Mac system tool", { skip: process.platform === "darwin" }, () => {
  assert.throws(() => verifyMacApplicationBundle({ version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" },
    "0.3.0", "/never-read/OpenWhisper.app/Contents/MacOS/OpenWhisper"), /requires Darwin/);
});


test("Mac bundle tool failures distinguish timeouts output limits exit and signal without tool contents", () => {
  const privateText = "/Users/owned/private bundle transcript device stderr";
  for (const tool of ["signature", "metadata"] as const) {
    assert.equal(macBundleToolFailure(tool, { status: 0, signal: null }, 1), undefined);
    const cases = [
      { reason: "timeout", error: Object.assign(new Error(privateText), { code: "ETIMEDOUT" }), status: null, signal: "SIGTERM" },
      { reason: "output-limit", error: Object.assign(new Error(privateText), { code: "ENOBUFS" }), status: null, signal: "SIGTERM" },
      { reason: "spawn", error: Object.assign(new Error(privateText), { code: privateText }), status: null, signal: null },
      { reason: "exit", error: undefined, status: 2, signal: null },
      { reason: "signal", error: undefined, status: null, signal: "SIGKILL" },
    ] as const;
    for (const result of cases) {
      const failure = macBundleToolFailure(tool, result, 10_001.9);
      assert.ok(failure instanceof MacBundleAdmissionError);
      assert.deepEqual(readMacBundleFailure(failure), { code: `${tool}-${result.reason}`, status: result.status,
        signal: result.signal, elapsedMs: 10_001 });
      assert.ok(Object.isFrozen(failure.observation)); assert.ok(!JSON.stringify(failure.observation).includes(privateText));
    }
  }
});

test("Mac bundle observations cap durations and refuse arbitrary metadata and altered error fields", () => {
  const privateText = "/Users/owned/private-path raw exception output";
  const error = new Error(privateText); Object.defineProperty(error, "code", { get() { throw new Error(privateText); } });
  const failure = macBundleToolFailure("signature", { error, status: privateText, signal: privateText }, 30_000);
  assert.ok(failure); assert.deepEqual(readMacBundleFailure(failure),
    { code: "signature-spawn", status: null, signal: "other", elapsedMs: 20_000 });
  for (const elapsedMs of [-1, Infinity, NaN]) assert.equal(macBundleToolFailure("metadata", { status: 1, signal: null }, elapsedMs)?.observation.elapsedMs, 0);
  for (const code of ["metadata-json", "metadata-mismatch"] as const) {
    const observed = { code, status: 0, signal: null, elapsedMs: 1 };
    assert.deepEqual(readMacBundleFailure(new MacBundleAdmissionError(observed)), observed);
    for (const changes of [{ code: privateText }, { status: 256 }, { signal: privateText }, { elapsedMs: 20_001 }, { stderr: privateText }]) {
      assert.throws(() => new MacBundleAdmissionError({ ...observed, ...changes }));
    }
  }
  assert.equal(readMacBundleFailure({ observation: failure.observation }), undefined);
  Object.defineProperty(failure, "observation", { get() { throw new Error(privateText); } });
  assert.equal(readMacBundleFailure(failure), undefined);
});

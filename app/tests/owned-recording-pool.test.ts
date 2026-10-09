import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseExecutionArguments, executeReviewedRecordingPool } from "./owned-recording-pool/run.js";

const enabled = process.env["OPENWHISPER_EXECUTE_OWNED_RECORDING_POOL"] === "1";
/** Ordinary test runs have no build/container/Electron/native effects. */
test("owned synthetic recording uses the real inventory factory and continuing normal speech pool", { skip: !enabled, timeout: 480_000 }, async () => {
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64"); assert.notEqual(process.getuid?.(), 0);
  const output = process.env["OPENWHISPER_RECORDING_POOL_OUTPUT"], build = process.env["OPENWHISPER_RECORDING_POOL_BUILD"],
    input = process.env["OPENWHISPER_RECORDING_POOL_INPUT_SHA256"], seccomp = process.env["OPENWHISPER_RECORDING_POOL_SECCOMP"];
  assert.ok(output && build && input && seccomp); assert.equal(resolve(output), output); assert.equal(resolve(build), build);
  const args = ["--output", output, "--build", build, "--input-sha256", input, "--seccomp", seccomp, "--execute-reviewed-owned-recording-pool"];
  parseExecutionArguments(args); await executeReviewedRecordingPool(args);
});

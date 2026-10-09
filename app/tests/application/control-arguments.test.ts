import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_USAGE, parseLaunchArguments, type TrustedArgumentLayout } from "../../src/cli/arguments.js";

const packaged: TrustedArgumentLayout = Object.freeze({ kind: "packaged", executable: "/owned/OpenWhisper" });
const development: TrustedArgumentLayout = Object.freeze({ kind: "development", executable: "/owned/electron", application: "/owned/app" });

test("control arguments accept only the exact five commands with the trusted prefix", () => {
  for (const command of ["start", "stop", "toggle", "cancel", "status"]) {
    assert.deepEqual(parseLaunchArguments([packaged.executable, "--control", command], packaged), { kind: "control", command });
    assert.deepEqual(parseLaunchArguments([development.executable, development.application, "--control", command], development), { kind: "control", command });
  }
  assert.equal(CONTROL_USAGE, "Usage: openwhisper-desktop --control start|stop|toggle|cancel|status");
  assert.equal(Object.isFrozen(parseLaunchArguments([packaged.executable, "--control", "start"], packaged)), true);
  for (const args of [[], ["--control"], ["--control", "Start"], ["--control", " start"], ["--control", "start; unsafe"],
    ["--control=status" , "--control"], ["--control", "status", "extra"], ["--dev-profile", "/owned", "--control", "status"],
    ["--control", "--control"], ["prefix", "--control", "status"]]) {
    // Empty application arguments are an ordinary GUI launch.
    assert.equal(parseLaunchArguments([packaged.executable, ...args], packaged).kind, args.length === 0 ? "gui" : "invalid");
  }
});

test("argument bounds reject malformed text and never guess a development entry", () => {
  for (const input of [null, {}, "--control status", [], [packaged.executable, 4], [packaged.executable, "\0"],
    [packaged.executable, "\ud800"], [packaged.executable, "\udc00"], [packaged.executable, "é".repeat(4097)],
    [packaged.executable, ...Array.from({ length: 32 }, () => "x")],
    [packaged.executable, ...Array.from({ length: 4 }, () => "x".repeat(8192))]]) {
    assert.equal(parseLaunchArguments(input, packaged).kind, "invalid");
  }
  assert.equal(parseLaunchArguments([packaged.executable, "é".repeat(4096)], packaged).kind, "gui");
  assert.equal(parseLaunchArguments([packaged.executable, "Café 東京 🙂"], packaged).kind, "gui");
  assert.equal(parseLaunchArguments(["/wrong/executable", "--control", "status"], packaged).kind, "invalid");
  assert.equal(parseLaunchArguments([development.executable, "/wrong/app", "--control", "status"], development).kind, "invalid");
  assert.equal(parseLaunchArguments([development.executable, "--control", "status"], development).kind, "invalid");
  assert.equal(parseLaunchArguments([development.executable, development.application, "--dev-profile", "/owned/profile"], development).kind, "gui");
  assert.equal(parseLaunchArguments([packaged.executable, "--control=status"], packaged).kind, "gui");
});

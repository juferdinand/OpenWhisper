import assert from "node:assert/strict";
import test from "node:test";
import { routeControlStartup } from "../src/main/control-startup.js";
import { ControlClientError } from "../src/platforms/linux/shared/control-client.js";

const build = { version: 1, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" };
const layout = { kind: "packaged" as const, executable: "/owned/openwhisper" };
test("early GUI invalid and unsupported-host routing does not prepare a bus or application", async () => {
  let prepares = 0, opens = 0;
  const prepare = async () => { prepares++; return { uid: 1000, factory: async () => { opens++; throw new Error("Must not open."); } }; };
  assert.equal(await routeControlStartup({ argv: [layout.executable], layout, platform: "linux", build, prepare }), undefined);
  assert.equal(await routeControlStartup({ argv: [layout.executable, "--inspect=0", "--remote-debugging-port=0", "/owned/app", "--dev"],
    layout: { kind: "development", executable: layout.executable, application: "/owned/app" }, platform: "linux", build, prepare }), undefined);
  for (const args of [["--control"], ["--control", "status", "extra"], ["--dev", "--control", "start"]]) {
    const result = await routeControlStartup({ argv: [layout.executable, ...args], layout, platform: "linux", build, prepare });
    assert.equal(result?.exitCode, 2); assert.equal(result?.stdout, "");
  }
  assert.equal((await routeControlStartup({ argv: [layout.executable, "--inspect=0", "/owned/app", "--control", "status"],
    layout: { kind: "development", executable: layout.executable, application: "/owned/app" }, platform: "linux", build, prepare }))?.exitCode, 2);
  const unsupported = await routeControlStartup({ argv: [layout.executable, "--control", "status"], layout, platform: "darwin", build, prepare });
  assert.equal(unsupported?.exitCode, 1); assert.equal(prepares, 0); assert.equal(opens, 0);
});

test("valid early control uses the captured identity and returns categorical failure without GUI startup", async () => {
  let prepares = 0, opens = 0;
  const result = await routeControlStartup({ argv: [layout.executable, "--control", "status"], layout, platform: "linux", build,
    prepare: async (identity) => {
      prepares++; assert.deepEqual(identity, build);
      return { uid: 1000, factory: async () => { opens++; throw new ControlClientError("NOT_RUNNING"); } };
    } });
  assert.deepEqual(result, { exitCode: 1, stdout: "", stderr: "OpenWhisper is not running in this session. Open the app first.\n" });
  assert.equal(prepares, 1); assert.equal(opens, 1);
});

test("invalid captured control identity fails categorically before package or native preparation", async () => {
  const result = await routeControlStartup({ argv: [layout.executable, "--control", "status"], layout, platform: "linux",
    build: { ...build, appId: "io.github.whisperfree.dev" }, prepare: async () => { throw Error("Preparation must not execute."); } });
  assert.deepEqual(result, { exitCode: 1, stdout: "", stderr: "The command control build identity is unavailable.\n" });
});

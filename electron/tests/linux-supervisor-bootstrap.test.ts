import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootstrapLinuxSupervisor, linuxSupervisorLauncher } from "../src/cli/linux-supervisor-bootstrap.js";
import type { LinuxSupervisorEffects } from "../src/cli/linux-supervisor.js";

test("valid and invalid control arguments bypass parent admission and preserve the existing early GUI parser", async () => {
  for (const argv of [["--control", "status"], ["--control", "unknown"], ["--control"]]) {
    let preparations = 0, executions = 0;
    const effects: LinuxSupervisorEffects = {
      launch() { throw new Error("Control must not create a GUI child or receipt pipe."); },
      exec(executable, received, environment): never {
        executions++; assert.equal(executable, process.execPath); assert.deepEqual(received, [process.execPath, ...argv]);
        assert.equal(environment["ELECTRON_RUN_AS_NODE"], undefined); throw new Error("Owned inert exec boundary");
      },
    };
    await assert.rejects(bootstrapLinuxSupervisor(argv, async () => { preparations++; throw new Error("No admission or profile reads allowed."); }, effects), { code: "EXEC_FAILED" });
    assert.equal(preparations, 0); assert.equal(executions, 1);
  }
});

test("an uninstalled image keeps ordinary GUI startup without a fabricated permanent target or restart authority", async () => {
  const argv = ["literal value", ""], effects: LinuxSupervisorEffects = {
    launch() { throw new Error("Unadmitted images must not acquire a restart channel."); },
    exec(executable, received, environment): never {
      assert.equal(executable, process.execPath); assert.deepEqual(received, [process.execPath, ...argv]);
      assert.equal(environment["OPENWHISPER_RESTART_NONCE"], undefined); throw new Error("Owned inert exec boundary");
    },
  };
  await assert.rejects(bootstrapLinuxSupervisor(argv, async (received) => {
    assert.deepEqual(received, argv); return { version: "0.3.0", launch: undefined };
  }, effects), { code: "EXEC_FAILED" });
});

test("both fixed shell bootstraps clear Node injection and preserve literal application arguments", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "openwhisper-supervisor-entry-"));
  try {
    const unexpected = join(root, "unexpected-execution"), argv = ["--control", "status", "", "two words", "*", "a\\b", "line\nbreak",
      `$(touch ${unexpected})`, `\`touch ${unexpected}\``];
    for (const kind of ["debian", "appimage"] as const) {
      const bundle = join(root, "image with spaces"), entry = join(bundle, kind === "debian" ? "openwhisper-launch" : "AppRun");
      await mkdir(bundle, { recursive: true }); await writeFile(entry, linuxSupervisorLauncher(kind), { mode: 0o755 });
      // Read the actual shell entry, but intercept its sole exec before any Electron or app launch.
      const child = spawnSync("/bin/sh", ["-c", 'capture() { printf "%s\\000" "$ELECTRON_RUN_AS_NODE" "${NODE_OPTIONS+x}${NODE_PATH+x}${NODE_V8_COVERAGE+x}${ELECTRON_NO_ASAR+x}" "$@"; return 23; }; alias exec=capture; . "$0"', entry, ...argv],
        { env: { ...process.env, NODE_OPTIONS: "inert injection", NODE_PATH: "/inert", NODE_V8_COVERAGE: "/inert", ELECTRON_NO_ASAR: "1", ELECTRON_RUN_AS_NODE: "0" },
          shell: false, encoding: "utf8", timeout: 1_000, maxBuffer: 16 * 1024 });
      assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 23); assert.equal(child.stderr, "");
      const payload = kind === "debian" ? "/opt/openwhisper" : join(bundle, "usr/lib/openwhisper");
      assert.deepEqual(child.stdout.split("\0"), ["1", "", join(payload, "openwhisper"),
        join(payload, "resources/app/dist/cli/linux-supervisor-bootstrap.js"), ...argv, ""]);
    }
    await assert.rejects(lstat(unexpected), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

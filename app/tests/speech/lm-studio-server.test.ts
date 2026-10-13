import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalTextConnectionScanner, resolveLmStudioCli, startLmStudioServer } from "../../src/services/text/connections.js";

async function fakeHome(script?: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-lm-studio-")));
  if (script !== undefined) {
    await mkdir(join(home, ".lmstudio/bin"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".lmstudio/bin/lms"), script, { mode: 0o700 });
  }
  return home;
}

test("an installed LM Studio with its server off is reported as server_stopped, not as not running", async () => {
  const installed = await fakeHome("#!/bin/sh\nexit 0\n"), absent = await fakeHome();
  try {
    // Port 9 (discard) never answers HTTP, so the local server counts as off.
    const scan = (home: string) => new LocalTextConnectionScanner({ HOME: home, PATH: "" }, { lm_studio: 9, ollama: 9 }).scan();
    assert.equal((await scan(installed)).find((entry) => entry.provider === "lm_studio")?.reason, "server_stopped");
    assert.equal((await scan(absent)).find((entry) => entry.provider === "lm_studio")?.reason, "not_running");
  } finally { await rm(installed, { recursive: true, force: true }); await rm(absent, { recursive: true, force: true }); }
});

test("starting the LM Studio server runs only the fixed CLI with server start and reports failures", async () => {
  const marker = await fakeHome();
  const home = await fakeHome(`#!/bin/sh\nprintf '%s ' "$@" > "${join(marker, "args")}"\nexit 0\n`);
  const failing = await fakeHome("#!/bin/sh\nexit 3\n");
  const unsafe = await fakeHome("#!/bin/sh\nexit 0\n");
  try {
    await startLmStudioServer(home);
    assert.equal((await readFile(join(marker, "args"), "utf8")).trim(), "server start");
    await assert.rejects(startLmStudioServer(failing), /could not start/u);
    await assert.rejects(startLmStudioServer(await fakeHome()), /not installed/u);
    await chmod(join(unsafe, ".lmstudio/bin/lms"), 0o777);
    assert.equal(await resolveLmStudioCli(unsafe), undefined);
  } finally {
    for (const path of [marker, home, failing, unsafe]) await rm(path, { recursive: true, force: true });
  }
});

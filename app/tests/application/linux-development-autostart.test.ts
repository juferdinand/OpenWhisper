import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitLinuxDevelopmentAutostart } from "../../src/main/linux-development-autostart.js";
import { resolveDevelopmentProfile } from "../../src/services/settings/profiles.js";

const build = { version: 1, kind: "development", appId: "io.github.whisperfree.dev", productName: "OpenWhisper Dev" };

test("only a packaged Linux Dev executable launched with its explicit isolated profile is admitted", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-dev-autostart-")));
  try {
    const root = join(home, ".local/dev/openwhisper-private"), profile = resolveDevelopmentProfile({ home, explicitRoot: root });
    const executable = join(home, ".local/opt/openwhisper-dev-e69a337/OpenWhisper-Dev-Linux-x64/openwhisper-dev");
    const resourcesPath = join(executable, "../resources");
    const application = join(resourcesPath, "app");
    const input = { build, platform: "linux", packaged: true, executable, resourcesPath, appPath: application,
      argv: [executable, "--dev-profile", root], profile };
    assert.deepEqual(admitLinuxDevelopmentAutostart(input), {
      executable, profileRoot: root, launchArguments: ["--dev-profile", root],
    });
    for (const change of [
      { platform: "darwin" }, { packaged: false }, { executable: executable.replace("openwhisper-dev", "electron") },
      { appPath: join(resourcesPath, "other-app") }, { argv: [executable] },
      { argv: [executable, "--dev-profile", join(root, "other")] }, { argv: [executable, "--dev-profile", root, "--control"] },
      { build: { ...build, kind: "stable", appId: "io.github.whisperfree", productName: "OpenWhisper" } },
    ]) assert.equal(admitLinuxDevelopmentAutostart({ ...input, ...change }), undefined);

    const sourceProfile = resolveDevelopmentProfile({ home });
    assert.equal(admitLinuxDevelopmentAutostart({ ...input, profile: sourceProfile,
      argv: [executable, "--dev-profile", join(home, ".config")] }), undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

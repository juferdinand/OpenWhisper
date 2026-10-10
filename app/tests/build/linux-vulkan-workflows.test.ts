import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

test("Linux CI and release build dependencies include the Vulkan loader development library", async () => {
  const workflows = [
    { file: "../../../.github/workflows/ci.yml", job: "electron", linuxOnly: true },
    { file: "../../../.github/workflows/electron-linux-build.yml", job: "electron-linux", linuxOnly: false },
  ] as const;
  for (const item of workflows) {
    const source = await readFile(new URL(item.file, import.meta.url), "utf8");
    const workflow = parse(source) as { jobs: Record<string, { steps: Array<{ if?: string; run?: string }> }> };
    const install = workflow.jobs[item.job]?.steps.find((step) => step.run?.includes("apt-get install"));
    assert.ok(install, `${item.job} must install system build dependencies.`);
    if (item.linuxOnly) assert.equal(install.if, "runner.os == 'Linux'");
    assert.ok(install.run?.split(/\s+/u).includes("libvulkan-dev"), `${item.job} must install libvulkan-dev.`);
  }
});

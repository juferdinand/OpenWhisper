import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const catalog = JSON.parse(
  readFileSync(resolve("../shared/models.json"), "utf8"),
).models;

async function start(page: Page, platform: "linux" | "macos") {
  await page.addInitScript(
    ({ platform, models }) => {
      const host = window as any;
      host.calls = [];
      const state: any = {
        platform,
        version: "0.1.2",
        status: "idle",
        message: "Ready to dictate",
        transcript: "",
        history: [],
        preferences: {
          model: "base",
          language: "en",
          microphone: "",
          vocabulary: "",
          snippets: [],
          output: "clipboard",
          hold_to_record: false,
          gpu: false,
          keep_history: true,
          restore_clipboard: true,
          play_sounds: true,
          show_idle_overlay: false,
          launch_at_login: false,
          auto_check_updates: true,
        },
        models,
        installed: ["base"],
        microphones: ["default"],
        session: platform === "linux" ? "Wayland" : "macOS",
        desktop: "Test machine",
        clipboard_available: true,
        shortcut_portal: true,
        paste_portal: true,
        shortcut: null,
        paste_ready: false,
        gpu_available: false,
        download: null,
        progress: 0,
        elapsed: 0,
        model_directory: "/test/models",
        macos: {
          microphone_allowed: false,
          recording_shortcut: false,
          shortcut_hint: "Press a key",
          editor: "TextEdit",
          recommended: ["base"],
          updates_configured: true,
          update_status: "Not checked yet.",
          can_install_update: false,
          update_busy: false,
        },
      };
      const callbacks = new Map<number, Function>();
      let callbackId = 0,
        stateListener = 0;
      const publish = () => {
        const snapshot = JSON.parse(JSON.stringify(state));
        window.dispatchEvent(
          new CustomEvent("whisperfree:state", { detail: snapshot }),
        );
        callbacks.get(stateListener)?.({
          event: "state",
          id: 1,
          payload: snapshot,
        });
      };
      const invoke = async (command: string, args: any = {}) => {
        if (command === "plugin:event|listen") {
          if (args.event === "state") stateListener = args.handler;
          return 1;
        }
        host.calls.push({ command, args });
        if (command === "get_state") return JSON.parse(JSON.stringify(state));
        if (command === "save_settings") state.preferences = args.preferences;
        if (command === "enable_shortcut")
          state.macos.recording_shortcut = true;
        if (command === "cancel_shortcut")
          state.macos.recording_shortcut = false;
        if (command === "clear_history") state.history = [];
        publish();
        return null;
      };
      host.testState = state;
      host.publishState = publish;
      if (platform === "macos")
        host.webkit = {
          messageHandlers: {
            whisperfree: {
              postMessage: ({ command, args }: any) => invoke(command, args),
            },
          },
        };
      else
        host.__TAURI_INTERNALS__ = {
          invoke,
          transformCallback: (callback: Function) => {
            callbacks.set(++callbackId, callback);
            return callbackId;
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
        };
    },
    { platform, models: catalog },
  );
  await page.goto(pathToFileURL(resolve("dist/index.html")).href);
  await expect(
    page.getByRole("heading", { name: "Recording", exact: true }),
  ).toBeVisible();
}

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: signed-file-compatible bundle, shared navigation and branding`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await start(page, platform);
    await expect(page.locator("nav button")).toHaveText([
      "Setup",
      "General",
      "Models",
      "Snippets",
      "History",
      "About",
    ]);
    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "WhisperFree", exact: true }),
    ).toBeVisible();
    expect(
      await page
        .locator(".about-brand img")
        .evaluate(
          (image: HTMLImageElement) =>
            image.complete && image.naturalWidth === 256,
        ),
    ).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() =>
        Array.from(document.fonts).some(
          (font) =>
            font.family === "WhisperFree Inter" && font.status === "loaded",
        ),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `test-results/${platform}-about.png` });
  });

  test(`${platform}: vocabulary survives recording updates and snippets remain plain text`, async ({
    page,
  }) => {
    await start(page, platform);
    await page
      .getByRole("textbox", { name: "Custom vocabulary", exact: true })
      .fill("WhisperFree, Kubernetes");
    await page.evaluate(() => {
      const w = window as any;
      w.testState.elapsed = 2;
      w.publishState();
    });
    await expect(
      page.getByRole("textbox", { name: "Custom vocabulary", exact: true }),
    ).toHaveValue("WhisperFree, Kubernetes");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Snippets", exact: true }).click();
    await page
      .getByRole("button", { name: "Add snippet", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "When I say", exact: true })
      .fill("my signature");
    await page
      .getByRole("textbox", { name: "Insert", exact: true })
      .fill('<img src=x onerror="alert(1)"> $1');
    await page
      .getByRole("button", { name: "Save snippets", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Insert", exact: true }),
    ).toHaveValue('<img src=x onerror="alert(1)"> $1');
    await expect(page.locator("#snippets img")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as any).testState.preferences.vocabulary,
      ),
    ).toBe("WhisperFree, Kubernetes");
  });
}

test("macOS retains native trigger capture, model import, and update actions", async ({
  page,
}) => {
  await start(page, "macos");
  await page
    .getByRole("button", { name: "Set trigger …", exact: true })
    .click();
  await expect(page.getByText("Press a key", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Play start and stop sounds")).toBeChecked();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page
    .getByRole("button", { name: "Import a model …", exact: true })
    .click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  const commands = await page.evaluate(() =>
    (window as any).calls.map((c: any) => c.command),
  );
  expect(commands).toEqual(
    expect.arrayContaining([
      "enable_shortcut",
      "cancel_shortcut",
      "import_model",
      "check_updates",
    ]),
  );
});

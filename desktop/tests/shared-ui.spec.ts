import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const catalog = JSON.parse(
  readFileSync(resolve("../shared/models.json"), "utf8"),
).models;

async function start(page: Page, platform: "linux" | "macos", overlay = false, fresh = false) {
  let savedPreferences: unknown = null;
  await page.exposeBinding("loadTestPreferences", () => savedPreferences);
  await page.exposeBinding("saveTestPreferences", (_, preferences) => { savedPreferences = preferences; });
  await page.addInitScript(
    ({ platform, models, overlay, fresh }) => {
      const host = window as any;
      host.__WHISPERFREE_OVERLAY__ = platform === "macos" && overlay;
      host.calls = [];
      const state: any = {
        platform,
        updates: { configured: true, status: "idle", version: null, progress: 0, error: null, package: platform === "linux" ? "appimage" : "macos" },
        version: "0.1.2",
        status: "idle",
        message: "Ready to dictate",
        transcript: "",
        history: [],
        preferences: {
          ui_language: "en",
          setup_completed: !fresh,
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
        if (command === "get_state") {
          const saved = await host.loadTestPreferences();
          if (saved) state.preferences = saved;
          return JSON.parse(JSON.stringify(state));
        }
        if (command === "save_settings") state.preferences = args.preferences;
        if (command === "complete_setup") state.preferences.setup_completed = true;
        if (command === "save_settings" || command === "complete_setup") await host.saveTestPreferences(state.preferences);
        if (command === "check_updates") Object.assign(state.updates, { status: "available", version: "0.2.2" });
        if (command === "install_update") state.updates.status = "downloading";
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
    { platform, models: catalog, overlay, fresh },
  );
  await page.goto(
    pathToFileURL(resolve("dist/index.html")).href +
      (overlay && platform === "linux" ? "?overlay" : ""),
  );
  if (overlay) {
    await expect(page.locator("#record")).toBeVisible();
    return;
  }
  await expect(
    page.getByRole("heading", { name: fresh ? "Get started in six steps" : "Recording", exact: true }),
  ).toBeVisible();
}

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: floating recorder shows a long-running timer and stop/cancel actions`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 340, height: 64 });
    await start(page, platform, true);
    await expect(page.locator("aside")).toHaveCount(0);
    await page.evaluate(() => {
      const w = window as any;
      Object.assign(w.testState, {
        status: "recording",
        elapsed: 126,
        level: 0.5,
      });
      w.publishState();
    });
    await expect(page.locator("#record-label")).toHaveText("Recording · 2:06");
    await expect(
      page.getByRole("button", { name: "Discard recording" }),
    ).toBeInViewport();
    await page.screenshot({
      path: `test-results/${platform}-recording-overlay.png`,
      omitBackground: true,
    });
    await page.locator("#record").click();
    await page.getByRole("button", { name: "Discard recording" }).click();
    expect(
      await page.evaluate(() =>
        (window as any).calls.map((c: any) => c.command),
      ),
    ).toEqual(expect.arrayContaining(["toggle_recording", "cancel_recording"]));
  });

  test(`${platform}: signed-file-compatible bundle, shared navigation and branding`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await start(page, platform);
    await expect(page.locator("nav button")).toHaveText([
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

for (const platform of ["linux", "macos"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${platform}: all ${theme} views fit the normal and minimum window`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await start(page, platform);
      for (const width of [960, 800]) {
        await page.setViewportSize({
          width,
          height: width === 960 ? 680 : 560,
        });
        for (const tab of [
          "General",
          "Models",
          "Snippets",
          "History",
          "About",
        ]) {
          await page.getByRole("button", { name: tab, exact: true }).click();
          await expect(page.locator("nav .selected")).toHaveText(tab);
          expect(
            await page
              .locator("main")
              .evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          await expect(
            page.getByRole("button", { name: "Start dictation", exact: true }),
          ).toBeInViewport();
          if (width === 960)
            await page.screenshot({
              path: `test-results/${platform}-${theme}-${tab.toLowerCase()}.png`,
            });
        }
      }
    });
  }
}

test("both native adapters render an identical navigation and recording bar", async ({
  browser,
}) => {
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  await Promise.all(
    pages.map(async (page, index) => {
      await page.setViewportSize({ width: 960, height: 680 });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await start(page, index === 0 ? "linux" : "macos");
      await page.evaluate(() => document.fonts.ready);
    }),
  );
  for (const selector of ["aside", "#record-control", ".page-header"]) {
    const images = await Promise.all(
      pages.map((page) => page.locator(selector).screenshot()),
    );
    expect(images[0].equals(images[1]), selector).toBe(true);
  }
  await Promise.all(pages.map((page) => page.close()));
});

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

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: interface language persists without changing recognition language or user text`, async ({ page }) => {
    await start(page, platform);
    await page.evaluate(() => {
      const w = window as any;
      w.testState.history = ["Recording", "<script>private text</script>"];
      w.publishState();
    });
    await page.getByRole("button", { name: "Deutsch", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("heading", { name: "Aufnahme", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Diktat starten", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Verlauf", exact: true }).click();
    await expect(page.locator(".history-row p")).toHaveText(["Recording", "<script>private text</script>"]);
    expect(await page.evaluate(() => (window as any).testState.preferences.language)).toBe("en");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(page.getByRole("button", { name: "Einrichtung", exact: true })).toHaveCount(0);
    await page.locator('[data-ui-language="en"]').click();
    await expect(page.getByRole("heading", { name: "Recording", exact: true })).toBeVisible();
  });
  test(`${platform}: setup is shown for a fresh installation and stays hidden after completion and restart`, async ({ page }) => {
    await start(page, platform, false, true);
    await expect(page.getByRole("button", { name: "Setup", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finish setup", exact: true }).click();
    await expect(page.getByRole("button", { name: "Setup", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Setup", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Recording", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  });
  test(`${platform}: update controls show availability and prevent recording during installation`, async ({ page }) => {
    await start(page, platform);
    await page.getByRole("button", { name: "About", exact: true }).click();
    await page.getByRole("button", { name: "Check now", exact: true }).click();
    await expect(page.getByText("Version 0.2.2 is available.")).toBeVisible();
    await page.evaluate(() => { const w = window as any; w.testState.status = "transcribing"; w.publishState(); });
    await expect(page.getByRole("button", { name: "Download & install", exact: true })).toBeDisabled();
    await page.evaluate(() => { const w = window as any; w.testState.status = "idle"; w.publishState(); });
    await page.getByRole("button", { name: "Download & install", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start dictation", exact: true })).toBeDisabled();
    await expect(page.getByText("Downloading update: 0%")).toBeVisible();
  });
  test(`${platform}: German views fit the minimum window and translate the floating timer`, async ({ page }) => {
    await start(page, platform, false, true);
    await page.setViewportSize({ width: 800, height: 560 });
    await page.locator('[data-ui-language="de"]').click();
    for (const title of ["Einrichtung", "Allgemein", "Modelle", "Textbausteine", "Verlauf", "Über"]) {
      await page.getByRole("button", { name: title, exact: true }).click();
      expect(await page.locator("main").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      await expect(page.getByRole("button", { name: "Diktat starten", exact: true })).toBeInViewport();
    }
    await page.evaluate(() => { const w = window as any; w.testState.status = "recording"; w.testState.elapsed = 126; w.publishState(); });
    await expect(page.locator("#record-label")).toHaveText("Aufnahme · 2:06");
    await expect(page.getByRole("button", { name: "Aufnahme verwerfen" })).toBeVisible();
    await page.screenshot({ path: `test-results/${platform}-german.png` });
  });
}

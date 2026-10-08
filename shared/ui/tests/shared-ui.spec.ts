import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppState } from "../../../electron/src/contracts/ui.js";

const catalog = JSON.parse(
  readFileSync(resolve("../models.json"), "utf8"),
).models;

test("Linux keyboard-only setup suppresses button defaults and restores normal input after Cancel", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const host = window as unknown as { testState: AppState; publishState(): void };
    host.testState.native_shortcuts = true; host.testState.native_mouse = false; host.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Set trigger …", exact: true }).click();
  await expect(page.getByText("Press and release a keyboard key. Escape cancels.", { exact: true })).toBeVisible();
  const cancel = page.getByRole("button", { name: "Cancel", exact: true }); await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(cancel).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { calls: { command: string }[] }).calls.at(-1)?.command)).toBe("enable_shortcut");
  await cancel.click(); await expect(cancel).toHaveCount(0);
});

test("pending desktop consent exposes Cancel and keeps the trigger setup separate from direct input capture", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const host = window as any; host.testState.shortcut_configuring = true; host.publishState();
  });
  await expect(page.getByText("Choose a shortcut in your desktop’s dialog.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1).command)).toBe("cancel_shortcut");
  await page.evaluate(() => {
    const host = window as any; host.testState.preferences.ui_language = "de"; host.publishState();
  });
  await expect(page.getByText("Wähle eine Tastenkombination im Dialog deines Desktops.", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const host = window as any; host.testState.shortcut_configuring = false;
    host.testState.message = "Shortcut setup was cancelled. Window recording remains usable."; host.publishState();
  });
  await expect(page.locator("#status")).toHaveText("Die Einrichtung des Tastenkürzels wurde abgebrochen. Die Aufnahme über das Fenster bleibt verfügbar.");
});

test("an omitted large transcript preview still exposes complete Copy in both interface languages", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.status = "done";
    host.testState.transcript_preview_omitted = true;
    host.testState.transcript = "";
    host.publishState();
  });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByText("The complete transcript is available with Copy; its preview is too large.")).toBeVisible();
  await page.locator("#copy-latest").click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1).command)).toBe("copy_transcript");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.preferences.ui_language = "de"; host.publishState();
  });
  await expect(page.getByText("Das vollständige Transkript ist über Kopieren verfügbar; seine Vorschau ist zu groß.")).toBeVisible();
  await expect(page.locator("#copy-latest")).toHaveText("Kopieren");
});

test("saved Linux recordings can be retried or discarded without starting capture", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.status = "error";
    host.testState.recovery_available = true;
    host.testState.message = "An unfinished recording is saved. Retry transcription or discard it.";
    host.publishState();
  });
  await expect(page.getByRole("button", { name: "Start dictation", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry transcription", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1).command)).toBe("retry_transcription");
  await page.getByRole("button", { name: "Discard saved recording", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).calls.at(-1).command)).toBe("discard_recovery");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.preferences.ui_language = "de";
    host.publishState();
  });
  await expect(page.getByRole("button", { name: "Erneut transkribieren", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gesicherte Aufnahme verwerfen", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 800, height: 560 });
  await expect(page.getByRole("button", { name: "Erneut transkribieren", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/linux-recovery.png" });
  await page.evaluate(() => {
    const host = window as any;
    host.testState.updates.status = "available";
    host.publishState();
  });
  await page.getByRole("button", { name: "Über", exact: true }).click();
  await expect(page.getByRole("button", { name: "Laden & installieren", exact: true })).toBeDisabled();
});

async function start(page: Page, platform: "linux" | "macos", overlay = false, fresh = false) {
  let savedPreferences: unknown = null;
  await page.exposeBinding("loadTestPreferences", () => savedPreferences);
  await page.exposeBinding("saveTestPreferences", (_, preferences) => { savedPreferences = preferences; });
  await page.addInitScript(
    ({ platform, models, overlay, fresh }) => {
      const host = window as any;
      host.__OPENWHISPER_OVERLAY__ = platform === "macos" && overlay;
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
        overlay_available: true,
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
        },
      };
      const callbacks = new Map<number, Function>();
      let callbackId = 0,
        stateListener = 0;
      const publish = () => {
        const snapshot = JSON.parse(JSON.stringify(state));
        window.dispatchEvent(
          new CustomEvent("openwhisper:state", { detail: snapshot }),
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
        if (command === "enable_paste" && host.rejectPortal) {
          await new Promise(resolve => setTimeout(resolve, host.portalDelay ?? 0));
          throw new Error("Permission request cancelled");
        }
        if (command === "get_state") {
          const saved = await host.loadTestPreferences();
          if (saved) state.preferences = saved;
          return JSON.parse(JSON.stringify(state));
        }
        if (command === "save_preferences") {
          if (host.saveDelay) await new Promise(resolve => setTimeout(resolve, host.saveDelay));
          if (host.rejectSave) throw new Error("Could not save settings");
          Object.assign(state.preferences, args.changes);
        }
        if (command === "save_settings") state.preferences = args.preferences;
        if (command === "complete_setup") state.preferences.setup_completed = true;
        if (command === "save_settings" || command === "save_preferences" || command === "complete_setup") await host.saveTestPreferences(state.preferences);
        if (command === "check_updates") Object.assign(state.updates, { status: "available", version: "0.2.2" });
        if (command === "install_update") state.updates.status = "downloading";
        if (command === "enable_shortcut") {
          if (platform === "macos") state.macos.recording_shortcut = true;
          else if (state.native_shortcuts) state.recording_shortcut = true;
        }
        if (command === "cancel_shortcut") {
          state.macos.recording_shortcut = false;
          state.recording_shortcut = false;
        }
        if (command === "clear_shortcut") {
          if (state.native_x11) state.preferences.x11_trigger = null;
          else state.preferences.native_trigger = null;
          state.shortcut = null;
        }
        if (command === "enable_paste") state.paste_ready = true;
        if (command === "disable_paste") state.paste_ready = false;
        if (command === "clear_history") state.history = [];
        publish();
        return command === "save_preferences" ? JSON.parse(JSON.stringify(state)) : null;
      };
      host.testState = state;
      host.publishState = publish;
      if (platform === "macos")
        host.webkit = {
          messageHandlers: {
            openwhisper: {
              // WKScriptMessage replies need not preserve the dictionary order used by events.
              postMessage: async ({ command, args }: any) => JSON.parse(JSON.stringify(
                await invoke(command, args), (_, value) => value && typeof value === "object" && !Array.isArray(value)
                  ? Object.fromEntries(Object.entries(value).reverse()) : value,
              )),
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
      page.getByRole("heading", { name: "OpenWhisper", exact: true }),
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
            font.family === "OpenWhisper Inter" && font.status === "loaded",
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

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: login and idle overlay switches remain independent through delayed saves and restart`, async ({ page }) => {
    await start(page, platform);
    await page.setViewportSize({ width: 800, height: 560 });
    const login = page.getByRole("checkbox", { name: "Launch at login", exact: true });
    const overlay = page.getByRole("checkbox", { name: "Show overlay when idle", exact: true });
    await login.scrollIntoViewIfNeeded();
    const before = await login.boundingBox();
    await login.evaluate((input) => { (window as any).originalLoginSwitch = input; });
    await page.evaluate(() => { (window as any).saveDelay = 200; });
    await login.click();
    await overlay.click();
    await expect.poll(() => page.evaluate(() => (window as any).testState.preferences.launch_at_login)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).testState.preferences.show_idle_overlay)).toBe(true);
    await expect(login).toBeChecked();
    await expect(overlay).toBeChecked();
    // Native hosts publish another snapshot after completing the command reply.
    await page.evaluate(() => (window as any).publishState());
    expect(await page.evaluate(() => (window as any).originalLoginSwitch.isConnected)).toBe(true);
    const after = await login.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    await login.click();
    await expect.poll(() => page.evaluate(() => (window as any).testState.preferences.launch_at_login)).toBe(false);
    await expect(overlay).toBeChecked();
    await page.reload();
    await expect(login).not.toBeChecked();
    await expect(overlay).toBeChecked();
    const changes = await page.evaluate(() => (window as any).calls.filter((c: any) => c.command === "save_preferences"));
    expect(changes.every((c: any) => Object.keys(c.args.changes).length === 1)).toBe(true);
  });
  test(`${platform}: failed saves restore a switch without changing the neighboring setting`, async ({ page }) => {
    await start(page, platform);
    await page.evaluate(() => { (window as any).rejectSave = true; });
    const login = page.getByRole("checkbox", { name: "Launch at login", exact: true });
    await login.click();
    await expect(page.getByRole("alert")).toContainText("Could not save settings");
    await expect(login).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Show overlay when idle", exact: true })).not.toBeChecked();
  });
}

test("Linux exposes the detected GPU and keeps the CPU choice independent of autostart", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, { gpu_supported: true, gpu_available: true, gpu_device: "NVIDIA GeForce RTX 3060" });
    w.publishState();
  });
  const gpu = page.getByRole("checkbox", { name: "Use GPU acceleration when available" });
  await gpu.check();
  await expect(page.getByText("GPU · NVIDIA GeForce RTX 3060", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Launch at login", exact: true })).not.toBeChecked();
  await page.reload();
  await expect(gpu).toBeChecked();
  await expect(page.getByText("No compatible GPU detected.", { exact: false })).not.toBeVisible();
});

test("macOS shows pending login approval without changing the idle overlay", async ({ page }) => {
  await start(page, "macos");
  await page.setViewportSize({ width: 800, height: 560 });
  await page.evaluate(() => {
    const w = window as any;
    w.testState.preferences.launch_at_login = true;
    w.testState.macos.launch_at_login_pending = true;
    w.publishState();
  });
  await expect(page.getByRole("checkbox", { name: "Launch at login", exact: true })).toBeChecked();
  await expect(page.getByText("Allow OpenWhisper in System Settings to finish enabling launch at login.")).toBeVisible();
  expect(await page.locator("main").evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.getByRole("checkbox", { name: "Launch at login", exact: true }).uncheck();
  await expect(page.getByRole("checkbox", { name: "Show overlay when idle", exact: true })).not.toBeChecked();
});


test("Linux: native trigger capture blocks recording, cancels, and shows saved mouse bindings", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, { native_shortcuts: true, native_mouse: true, native_middle_mouse: true });
    w.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByText("Choose a single key, shortcut, or mouse button.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Set trigger …", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Press and release" })).toBeVisible();
  await expect(page.locator("#record")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#record")).toBeEnabled();
  await page.evaluate(() => {
    const w = window as any;
    w.testState.preferences.native_trigger = { kind: "mouse", button: 8 };
    w.testState.shortcut = "Mouse back button";
    w.publishState();
  });
  await expect(page.getByRole("button", { name: "Mouse back button", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Recording mode" })).toBeEnabled();
  await page.setViewportSize({ width: 800, height: 560 });
  await page.evaluate(() => { const w = window as any; w.testState.preferences.ui_language = "de"; w.publishState(); });
  await expect(page.getByRole("button", { name: "Zurück-Maustaste", exact: true })).toBeVisible();
  expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/linux-native-triggers-german.png" });
  await page.evaluate(() => { const w = window as any; w.testState.preferences.ui_language = "en"; w.publishState(); });
  await page.getByRole("button", { name: "Remove trigger", exact: true }).click();
  await expect(page.getByRole("button", { name: "Set trigger …", exact: true })).toBeVisible();
});

test("Linux X11 fallback exposes explicit keyboard setup and session paste without portals", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, { session: "X11", native_shortcuts: true, native_x11: true, native_paste: true, shortcut_portal: false, paste_portal: false });
    w.testState.preferences.native_trigger = { kind: "key", key: 0x01000021 };
    w.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByText("Choose a regular keyboard key or shortcut.", { exact: false })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Recording mode" })).toBeEnabled();
  await expect(page.getByText("Automatic X11 paste", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set trigger …", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Press and release a keyboard key" })).toBeVisible();
  await expect(page.locator("#record")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#record")).toBeEnabled();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
  await expect(page.getByText("Native X11 triggers", { exact: true })).toBeVisible();
  await expect(page.getByText("Native X11 paste", { exact: true })).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(2);
});

test("Linux X11 trigger removal and German help preserve the inactive KDE profile", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, { session: "X11", native_shortcuts: true, native_x11: true, native_paste: true, shortcut_portal: false, paste_portal: false, shortcut: "F8" });
    Object.assign(w.testState.preferences, { ui_language: "de", x11_trigger: { keycode: 74, keysym: 65477, modifiers: 0, group: 0 }, native_trigger: { kind: "key", key: 0x01000021 } });
    w.publishState();
  });
  await page.getByRole("button", { name: "Allgemein", exact: true }).click();
  await expect(page.getByText("Automatisches Einfügen unter X11", { exact: true })).toBeVisible();
  await expect(page.getByText("Wähle eine normale Taste", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Auslöser entfernen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Auslöser festlegen …", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testState.preferences.native_trigger.key)).toBe(0x01000021);
  expect(await page.evaluate(() => (window as any).testState.preferences.x11_trigger)).toBeNull();
});

test("Linux: modifier-only triggers explain toggle mode and disable push to talk", async ({ page }) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, { native_shortcuts: true, shortcut: "Ctrl" });
    w.testState.preferences.native_trigger = { kind: "key", key: 0x01000021 };
    w.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Recording mode" })).toBeDisabled();
  await expect(page.getByText("Modifier-only triggers use toggle mode.", { exact: false })).toBeVisible();
});

test("Linux clipboard delivery failures fully translate while retaining raw dictation", async ({ page }) => {
  await start(page, "linux");
  await page.getByRole("button", { name: "Deutsch", exact: true }).click();
  const german = JSON.parse(readFileSync(resolve("../locales/de.json"), "utf8"));
  const messages = [
    "Clipboard delivery could not be confirmed. Copy from the transcript or try again",
    "Clipboard delivery timed out. Copy from the transcript or try again",
    "Clipboard unavailable. Install wl-clipboard (Wayland) or xclip (X11)",
  ].map((message) => message + ". Your recording is retained. Retry transcription or discard it.");
  for (const message of messages) {
    await page.evaluate((message) => {
      const host = window as any;
      host.testState.status = "done";
      host.testState.message = message;
      host.testState.recovery_available = true;
      host.testState.transcript = "Clipboard delivery timed out";
      host.testState.history = ["Clipboard delivery timed out"];
      host.publishState();
    }, message);
    await expect(page.locator("#status")).toHaveText(german[message]);
    await expect(page.getByRole("button", { name: "Erneut transkribieren", exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Verlauf", exact: true }).click();
  await expect(page.locator(".history-row p")).toHaveText("Clipboard delivery timed out");
  expect(await page.evaluate(() => (window as any).testState.transcript)).toBe("Clipboard delivery timed out");
});

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: cancelled permission can be retried without a host state event`, async ({ page }) => {
    await start(page, platform);
    await page.evaluate(() => {
      const host = window as any;
      host.rejectPortal = true;
      host.portalDelay = 500;
    });
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Set trigger …", exact: true })).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("Permission request cancelled");
    await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Set trigger …", exact: true })).toBeEnabled();
    await page.evaluate(() => { (window as any).rejectPortal = false; });
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).calls.filter((call: any) => call.command === "enable_paste").length)).toBe(2);
    if (platform === "linux") {
      await expect(page.getByRole("button", { name: "Revoke", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(page.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
    } else {
      await expect(page.locator('[data-portal="disable_paste"]')).toBeEnabled();
    }
  });
}

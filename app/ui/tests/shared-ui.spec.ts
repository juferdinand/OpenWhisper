import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopBridge } from "../../src/contracts/ui/bridge.js";
import type {
  AppState,
  CommandName,
  EventName,
} from "../../src/contracts/ui/state.js";

const catalog = JSON.parse(
  readFileSync(resolve("../data/models.json"), "utf8"),
).models;
declare global {
  interface Window {
    openwhisper?: DesktopBridge;
    testState: AppState;
    publishState(): void;
    publishTelemetry(payload: {
      generation: number;
      elapsed: number;
      level: number;
    }): void;
    publishNavigate(tab: string): void;
    calls: { command: string; args?: unknown }[];
  }
}

test("pending keyboard permission exposes translated Cancel and sends only revocation", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    window.testState.paste_ready = false;
    window.testState.paste_configuring = true;
    window.publishState();
  });
  await expect(page.locator('[data-portal="disable_paste"]')).toHaveText(
    "Cancel",
  );
  await page.evaluate(() => {
    window.testState.preferences.ui_language = "de";
    window.publishState();
  });
  await expect(page.locator('[data-portal="disable_paste"]')).toHaveText(
    "Abbrechen",
  );
  await page.locator('[data-portal="disable_paste"]').click();
  await expect
    .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
    .toBe("disable_paste");
  await expect(page.locator('[data-portal="enable_paste"]')).toHaveText(
    "Erlauben",
  );
});

test("Linux overlay availability distinguishes unsupported protocol from missing runtime and translates both", async ({
  page,
}) => {
  await start(page, "linux");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.evaluate(() => {
    window.testState.overlay_available = false;
    window.testState.overlay_unavailable_reason = "unsupported";
    window.publishState();
  });
  const unsupported =
    "This Wayland compositor does not support layer-shell recording controls. Use the main window controls.";
  await expect(page.getByText(unsupported, { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.testState.preferences.ui_language = "de";
    window.publishState();
  });
  await expect(
    page.getByText(
      "Dieser Wayland-Compositor unterstützt keine layer-shell-Aufnahmeanzeige. Verwende die Bedienelemente im Hauptfenster.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    window.testState.preferences.ui_language = "en";
    window.testState.overlay_unavailable_reason = "runtime";
    window.publishState();
  });
  await expect(
    page.getByText("Floating controls could not start.", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.testState.preferences.ui_language = "de";
    window.publishState();
  });
  await expect(
    page.getByText(
      "Die schwebenden Bedienelemente konnten nicht gestartet werden.",
      { exact: false },
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    window.testState.overlay_unavailable_reason = undefined;
    window.publishState();
  });
  await expect(
    page.getByText(
      "Die schwebenden Bedienelemente sind nicht verfügbar. Verwende die Bedienelemente im Hauptfenster.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("Linux recognition mode names devices and distinguishes selection, discovery, and GPU fallback", async ({
  page,
}) => {
  await start(page, "linux");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.evaluate(() => {
    Object.assign(window.testState, {
      gpu_supported: true,
      gpu_checked: false,
      gpu_available: false,
      gpu_fallback: false,
      cpu_device: "AMD Ryzen 7 5700G",
    });
    window.publishState();
  });
  const cpu = page.locator('input[name="gpu-mode"][value="false"]');
  const gpu = page.locator('input[name="gpu-mode"][value="true"]');
  await expect(cpu).toBeChecked();
  await expect(
    page.getByText("AMD Ryzen 7 5700G", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("CPU selected: AMD Ryzen 7 5700G", {
      exact: true,
    }),
  ).toBeVisible();
  await gpu.check();
  await expect(gpu).toBeChecked();
  await expect(
    page.getByText("Checking GPU hardware …", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.testState.gpu_device = "NVIDIA GeForce RTX 3060";
    window.testState.gpu_checked = true;
    window.testState.gpu_available = true;
    window.publishState();
  });
  await expect(
    page.getByText(
      "GPU selected. Vulkan device detected: NVIDIA GeForce RTX 3060",
      { exact: true },
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    window.testState.gpu_fallback = true;
    window.publishState();
  });
  await expect(
    page.getByText(
      "GPU recognition failed; this recording used the CPU: AMD Ryzen 7 5700G",
      { exact: true },
    ),
  ).toBeVisible();
  await cpu.check();
  await expect(
    page.getByText("CPU selected: AMD Ryzen 7 5700G", { exact: true }),
  ).toBeVisible();
});

test("missing selected model gives a direct model download path and translates unavailable reasons", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    Object.assign(window.testState, {
      recording_available: false,
      recording_unavailable_reason: "model",
      installed: [],
    });
    window.publishState();
  });
  await expect(page.locator("#status-title")).toHaveText("Choose a model");
  await expect(page.locator("#status")).toHaveText(
    "Choose a speech model before recording.",
  );
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toBeDisabled();
  await page.locator("#vocabulary").fill("Unsaved vocabulary");
  await page.locator("#record-unavailable-action").click();
  await expect(page.locator("#notice")).toHaveText(
    "Save or discard your changes before switching tabs or language.",
  );
  await expect(page.locator("#vocabulary")).toHaveValue("Unsaved vocabulary");
  await page.locator("[data-discard]").click();
  await page.locator("#record-unavailable-action").click();
  await expect(
    page.getByRole("button", { name: "Models", exact: true }),
  ).toHaveClass(/selected/);
  await expect(page.locator('[data-download="base"]')).toHaveText("Download");

  await page.evaluate(() => {
    window.testState.recording_unavailable_reason = "permission";
    window.testState.preferences.ui_language = "de";
    window.publishState();
  });
  await expect(page.locator("#status-title")).toHaveText(
    "Aufnahme nicht verfügbar",
  );
  await expect(page.locator("#status")).toHaveText(
    "Mikrofonzugriff ist erforderlich. Prüfe die Berechtigungen in den allgemeinen Einstellungen.",
  );
  await expect(page.locator("#record-unavailable-action")).toHaveText(
    "Einstellungen öffnen",
  );
  await page.locator("#record-unavailable-action").click();
  await expect(
    page.getByRole("button", { name: "Allgemein", exact: true }),
  ).toHaveClass(/selected/);
});

test("Linux keyboard-only setup suppresses button defaults and restores normal input after Cancel", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const host = window as unknown as {
      testState: AppState;
      publishState(): void;
    };
    host.testState.native_shortcuts = true;
    host.testState.native_mouse = false;
    host.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page
    .getByRole("button", { name: "Set trigger …", exact: true })
    .click();
  await expect(
    page.getByText("Press and release a keyboard key. Escape cancels.", {
      exact: true,
    }),
  ).toBeVisible();
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(cancel).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { calls: { command: string }[] }).calls.at(-1)
          ?.command,
    ),
  ).toBe("enable_shortcut");
  await cancel.click();
  await expect(cancel).toHaveCount(0);
});

test("pending desktop consent exposes Cancel and keeps the trigger setup separate from direct input capture", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.shortcut_configuring = true;
    host.publishState();
  });
  await expect(
    page.getByText("Choose a shortcut in your desktop’s dialog.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.at(-1).command))
    .toBe("cancel_shortcut");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.preferences.ui_language = "de";
    host.publishState();
  });
  await expect(
    page.getByText("Wähle eine Tastenkombination im Dialog deines Desktops.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    const host = window as any;
    host.testState.shortcut_configuring = false;
    host.testState.message =
      "Shortcut setup was cancelled. Window recording remains usable.";
    host.publishState();
  });
  await expect(page.locator("#status")).toHaveText(
    "Die Einrichtung des Tastenkürzels wurde abgebrochen. Die Aufnahme über das Fenster bleibt verfügbar.",
  );
});

test("an omitted large transcript preview still exposes complete Copy in both interface languages", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.status = "done";
    host.testState.transcript_preview_omitted = true;
    host.testState.transcript = "";
    host.publishState();
  });
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(
    page.getByText(
      "The complete transcript is available with Copy; its preview is too large.",
    ),
  ).toBeVisible();
  await page.locator("#copy-latest").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.at(-1).command))
    .toBe("copy_transcript");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.preferences.ui_language = "de";
    host.publishState();
  });
  await expect(
    page.getByText(
      "Das vollständige Transkript ist über Kopieren verfügbar; seine Vorschau ist zu groß.",
    ),
  ).toBeVisible();
  await expect(page.locator("#copy-latest")).toHaveText("Kopieren");
});

test("saved Linux recordings can be retried or discarded without starting capture", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.status = "error";
    host.testState.recovery_available = true;
    host.testState.recording_available = false;
    host.testState.recording_unavailable_reason = "audio";
    host.testState.message =
      "An unfinished recording is saved. Retry transcription or discard it.";
    host.publishState();
  });
  await expect(
    page.getByRole("button", { name: "Start dictation", exact: true }),
  ).toHaveCount(0);
  const retry = page.getByRole("button", {
    name: "Retry transcription",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.at(-1).command))
    .toBe("retry_transcription");
  await page
    .getByRole("button", { name: "Discard saved recording", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.at(-1).command))
    .toBe("discard_recovery");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.preferences.ui_language = "de";
    host.publishState();
  });
  await expect(
    page.getByRole("button", { name: "Erneut transkribieren", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Gesicherte Aufnahme verwerfen",
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 800, height: 560 });
  await expect(
    page.getByRole("button", { name: "Erneut transkribieren", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: "test-results/linux-recovery.png" });
  await page.evaluate(() => {
    const host = window as any;
    host.testState.updates.status = "available";
    host.publishState();
  });
  await page.getByRole("button", { name: "Über", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Laden & installieren", exact: true }),
  ).toBeDisabled();
});

async function start(
  page: Page,
  platform: "linux" | "macos",
  overlay = false,
  fresh = false,
  initialStateRace = false,
) {
  let savedPreferences: unknown = null;
  await page.exposeBinding("loadTestPreferences", () => savedPreferences);
  await page.exposeBinding("saveTestPreferences", (_, preferences) => {
    savedPreferences = preferences;
  });
  await page.addInitScript(
    ({ platform, models, overlay, fresh, initialStateRace }) => {
      const host = window as any;
      host.__OPENWHISPER_OVERLAY__ = platform === "macos" && overlay;
      host.calls = [];
      const state: any = {
        platform,
        updates: {
          configured: true,
          status: "idle",
          version: null,
          progress: 0,
          error: null,
          package: platform === "linux" ? "appimage" : "macos",
        },
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
        recording_generation: 7,
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
      const callbacks = new Map<string, Set<(value: unknown) => void>>();
      const publish = () => {
        const snapshot = JSON.parse(JSON.stringify(state));
        for (const callback of callbacks.get("state") ?? []) callback(snapshot);
      };
      const publishTelemetry = (payload: unknown) => {
        for (const callback of callbacks.get("recording_telemetry") ?? [])
          callback(payload);
      };
      const publishNavigate = (tab: string) => {
        for (const callback of callbacks.get("navigate") ?? []) callback(tab);
      };
      const invoke = async (command: string, args: any = {}) => {
        host.calls.push({ command, args });
        if (command === "enable_paste" && host.rejectPortal) {
          await new Promise((resolve) =>
            setTimeout(resolve, host.portalDelay ?? 0),
          );
          throw new Error("Permission request cancelled");
        }
        if (command === "get_state") {
          const saved = await host.loadTestPreferences();
          if (saved) state.preferences = saved;
          const initial = JSON.parse(JSON.stringify(state));
          if (initialStateRace) {
            state.status = "recording";
            state.recording_generation = 8;
            state.elapsed = 4;
            state.level = 0.5;
            publish();
            publishTelemetry({ generation: 8, elapsed: 5, level: 0.7 });
          }
          return initial;
        }
        if (command === "save_preferences") {
          if (host.saveDelay)
            await new Promise((resolve) => setTimeout(resolve, host.saveDelay));
          if (host.rejectSave) throw new Error("Could not save settings");
          Object.assign(state.preferences, args.changes);
        }
        if (command === "save_settings") state.preferences = args.preferences;
        if (command === "complete_setup")
          state.preferences.setup_completed = true;
        if (
          command === "save_settings" ||
          command === "save_preferences" ||
          command === "complete_setup"
        )
          await host.saveTestPreferences(state.preferences);
        if (command === "check_updates")
          Object.assign(state.updates, {
            status: "available",
            version: "0.2.2",
          });
        if (command === "install_update") state.updates.status = "downloading";
        if (command === "download_model") {
          state.download = args.id;
          state.progress = 0;
        }
        if (command === "cancel_download") {
          state.download = null;
          state.progress = 0;
        }
        if (command === "enable_shortcut") {
          if (platform === "macos") state.macos.recording_shortcut = true;
          else if (state.native_shortcuts) state.recording_shortcut = true;
        }
        if (command === "cancel_shortcut") {
          state.macos.recording_shortcut = false;
          state.recording_shortcut = false;
        }
        if (command === "clear_shortcut") {
          if (platform === "macos" && state.macos.shortcut_toggle_only)
            state.preferences.macos_shortcut = null;
          else if (state.native_x11) state.preferences.x11_trigger = null;
          else state.preferences.native_trigger = null;
          state.shortcut = null;
        }
        if (command === "enable_paste") state.paste_ready = true;
        if (command === "disable_paste") {
          state.paste_ready = false;
          state.paste_configuring = false;
        }
        if (command === "clear_history") state.history = [];
        publish();
        return command === "save_preferences"
          ? JSON.parse(JSON.stringify(state))
          : null;
      };
      host.testState = state;
      host.publishState = publish;
      host.publishTelemetry = publishTelemetry;
      host.publishNavigate = publishNavigate;
      host.openwhisper = {
        async invoke(command: CommandName, args: unknown) {
          const result = await invoke(command, args);
          if (platform !== "macos") return result;
          // Serialized bridge records must validate independently of property order.
          return JSON.parse(
            JSON.stringify(result, (_key, value) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).reverse())
                : value,
            ),
          );
        },
        subscribe(name: EventName, callback: (value: unknown) => void) {
          const listeners = callbacks.get(name) ?? new Set();
          listeners.add(callback);
          callbacks.set(name, listeners);
          return () => {
            listeners.delete(callback);
          };
        },
      };
    },
    { platform, models: catalog, overlay, fresh, initialStateRace },
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
    page.getByRole("heading", {
      name: fresh ? "Speak. OpenWhisper writes with you." : "Recording",
      exact: true,
    }),
  ).toBeVisible();
}

test("recording telemetry follows the newest full state and ignores stale generations and final updates", async ({
  page,
}) => {
  await start(page, "linux", false, false, true);
  await expect(page.locator("#record-label")).toHaveText("Recording · 0:05");
  expect(
    await page
      .locator("#record-control")
      .evaluate((element) =>
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--voice-level"),
        ),
      ),
  ).toBeCloseTo(0.76);

  await page.evaluate(() => {
    const host = window as any;
    host.publishTelemetry({ generation: 7, elapsed: 99, level: 1 });
  });
  await expect(page.locator("#record-label")).toHaveText("Recording · 0:05");
  expect(
    await page
      .locator("#record-control")
      .evaluate((element) =>
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--voice-level"),
        ),
      ),
  ).toBeCloseTo(0.76);

  await page.evaluate(() => {
    const host = window as any;
    host.testState.status = "done";
    host.testState.level = 0;
    host.publishState();
    host.publishTelemetry({ generation: 8, elapsed: 6, level: 1 });
  });
  await expect(page.locator("#record-label")).toHaveText("Start dictation");
  expect(
    await page
      .locator("#record-control")
      .evaluate((element) =>
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--voice-level"),
        ),
      ),
  ).toBeCloseTo(0.2);
});

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: floating recorder keeps translated timers and actions separate from status copy`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 340, height: 64 });
    await start(page, platform, true, true);
    await expect(page.locator("aside")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => window.testState.preferences.setup_completed),
      )
      .toBe(false);
    for (const language of ["en", "de"] as const) {
      for (const elapsed of [14, 126, 36_617]) {
        await page.evaluate(
          ({ language, elapsed }) => {
            Object.assign(window.testState, {
              status: "recording",
              elapsed,
              level: 0.5,
            });
            window.testState.preferences.ui_language = language;
            window.publishState();
          },
          { language, elapsed },
        );
        expect(
          await page.evaluate(() => ({
            html: getComputedStyle(document.documentElement).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
          })),
        ).toEqual({
          html: "rgba(0, 0, 0, 0)",
          body: "rgba(0, 0, 0, 0)",
        });
        const time = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
        await expect(page.locator("#record-label")).toHaveText(
          `${language === "en" ? "Recording" : "Aufnahme"} · ${time}`,
        );
        await expect(page.locator(".record-copy")).toBeHidden();
        await expect(page.locator("#record-unavailable-action")).toBeHidden();
        await expect(page.locator("#record")).toBeInViewport();
        await expect(page.locator("#cancel")).toBeInViewport();
        const geometry = await page
          .locator("#record-control")
          .evaluate((control) => {
            const bars = control
              .querySelector(".audio-mark")!
              .getBoundingClientRect();
            const label = control.querySelector("#record-label")!;
            const text = label.getBoundingClientRect();
            const record = control
              .querySelector("#record")!
              .getBoundingClientRect();
            const cancel = control
              .querySelector("#cancel")!
              .getBoundingClientRect();
            return {
              barsEnd: bars.right,
              textStart: text.left,
              textEnd: text.right,
              cancelStart: cancel.left,
              recordEnd: record.right,
              textFits: label.scrollWidth <= label.clientWidth,
            };
          });
        expect(geometry.barsEnd).toBeLessThanOrEqual(geometry.textStart);
        expect(geometry.textEnd).toBeLessThanOrEqual(geometry.cancelStart);
        expect(geometry.recordEnd).toBeLessThanOrEqual(geometry.cancelStart);
        expect(geometry.textFits).toBe(true);
      }
      await page.screenshot({
        path: `test-results/${platform}-${language}-recording-overlay.png`,
        omitBackground: true,
      });
    }
    await page.locator("#record").click();
    await page.locator("#cancel").click();
    expect(
      await page.evaluate(() =>
        (window as any).calls.map((c: any) => c.command),
      ),
    ).toEqual(expect.arrayContaining(["toggle_recording", "cancel_recording"]));
    await page.evaluate(() => {
      window.testState.status = "idle";
      window.testState.recording_available = false;
      window.testState.recording_unavailable_reason = "model";
      window.publishState();
    });
    await expect(page.locator("#record-unavailable-action")).toBeHidden();
    await expect(page.locator("#cancel")).toBeHidden();
    await expect(page.locator("#record")).toBeDisabled();
    await expect(page.locator("[data-window-action]")).toHaveCount(0);
    await page.evaluate(() => {
      Object.assign(window.testState, {
        status: "error",
        recovery_available: true,
        recording_available: false,
        recording_unavailable_reason: "audio",
        message:
          "An unfinished recording is saved. Retry transcription or discard it.",
      });
      window.publishState();
    });
    await expect(page.locator("#record-label")).toHaveText(
      "Erneut transkribieren",
    );
    await expect(page.locator("#record")).toBeEnabled();
    await expect(page.locator("#cancel")).toBeInViewport();
    await expect(page.locator("#record")).toBeInViewport();
    expect(
      await page.evaluate(() => ({
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
      })),
    ).toEqual({
      html: "rgba(0, 0, 0, 0)",
      body: "rgba(0, 0, 0, 0)",
    });
  });

  test(`${platform}: signed-file-compatible bundle, shared navigation and branding`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await start(page, platform);
    await expect(page.locator("[data-window-action]")).toHaveCount(3);
    for (const action of ["minimize", "maximize", "close"] as const) {
      await page.locator(`[data-window-action="${action}"]`).click();
      await expect
        .poll(() => page.evaluate(() => window.calls.at(-1)))
        .toEqual({ command: "window_action", args: { action } });
    }
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

test("Linux and macOS UI fixtures render an identical navigation and recording bar", async ({
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
  test(`${platform}: interface language persists without changing recognition language or user text`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.evaluate(() => {
      const w = window as any;
      w.testState.history = ["Recording", "<script>private text</script>"];
      w.publishState();
    });
    await page.getByRole("button", { name: "Deutsch", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("heading", { name: "Aufnahme", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Diktat starten", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Verlauf", exact: true }).click();
    await expect(page.locator(".history-row p")).toHaveText([
      "Recording",
      "<script>private text</script>",
    ]);
    expect(
      await page.evaluate(() => (window as any).testState.preferences.language),
    ).toBe("en");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("button", { name: "Einrichtung", exact: true }),
    ).toHaveCount(0);
    await page.locator('[data-ui-language="en"]').click();
    await expect(
      page.getByRole("heading", { name: "Recording", exact: true }),
    ).toBeVisible();
  });
  test(`${platform}: setup is shown for a fresh installation and stays hidden after completion and restart`, async ({
    page,
  }) => {
    const microphoneHeading =
      platform === "macos" ? "Allow microphone access" : "Choose a microphone";
    const longMicrophoneId = `alsa_input.usb-${"0123456789abcdef".repeat(7)}`;
    const longFriendlyName = `Studio microphone ${"for broadcast and dictation ".repeat(6)}`;
    const unlabeledMicrophoneId = `alsa_input.pci-${"fedcba9876543210".repeat(7)}`;
    await start(page, platform, false, true);
    await expect(page.locator("nav button[data-tab]")).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Speak. OpenWhisper writes with you.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "English", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Deutsch", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("heading", {
        name: "Sprich. OpenWhisper schreibt mit.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Englisch", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Englisch", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByRole("heading", {
        name: "Speak. OpenWhisper writes with you.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Models" })).toHaveCount(0);
    await expect(page.locator(".model-row")).toHaveCount(0);
    await expect(page.locator("#record-control")).toBeHidden();
    const initialCommands = await page.evaluate(() =>
      window.calls.map((call) => call.command),
    );
    expect(initialCommands).not.toContain("toggle_recording");
    expect(initialCommands).not.toContain("retry_transcription");
    expect(initialCommands).not.toContain("enable_paste");
    expect(initialCommands).not.toContain("enable_shortcut");
    expect(initialCommands).not.toContain("allow_microphone");
    await page.setViewportSize({ width: 960, height: 680 });
    await page.screenshot({
      path: `test-results/${platform}-setup-welcome.png`,
    });

    await page.setViewportSize({ width: 740, height: 560 });
    await page.screenshot({
      path: `test-results/${platform}-setup-welcome-minimum.png`,
    });
    await page.evaluate(() => {
      Object.assign(window.testState, {
        status: "error",
        recovery_available: true,
        recording_available: false,
        recording_unavailable_reason: "audio",
        message:
          "An unfinished recording is saved. Retry transcription or discard it.",
      });
      window.publishState();
    });
    await expect(
      page.getByRole("button", { name: "Retry transcription", exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("button", {
        name: "Discard saved recording",
        exact: true,
      }),
    ).toBeInViewport();
    expect(
      await page.locator("#record-control").evaluate((element) => {
        const { left, right } = element.getBoundingClientRect();
        return { left, right, width: window.innerWidth };
      }),
    ).toEqual({ left: 0, right: 740, width: 740 });
    await page.evaluate(() => {
      Object.assign(window.testState, {
        status: "idle",
        recovery_available: false,
        recording_unavailable_reason: undefined,
      });
      window.publishState();
    });
    await expect(page.locator("#record-control")).toBeHidden();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Step 1 of 6", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Download a speech model" }),
    ).toBeVisible();
    expect(
      await page
        .locator("main")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
    const modelFamilies = page.locator("details[data-model-family]");
    await expect(modelFamilies).toHaveCount(2);
    await expect(modelFamilies.nth(0)).toHaveJSProperty("open", false);
    await expect(modelFamilies.nth(1)).toHaveJSProperty("open", false);
    for (const viewport of [
      { width: 740, height: 560 },
      { width: 980, height: 740 },
    ]) {
      await page.setViewportSize(viewport);
      const card = page.locator(".setup-card");
      const top = await card.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      const summary = modelFamilies.nth(0).locator("summary");
      await summary.click();
      await expect(modelFamilies.nth(0)).toHaveJSProperty("open", true);
      expect(
        await card.evaluate((element) => element.getBoundingClientRect().top),
      ).toBeCloseTo(top, 0);
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeInViewport();
      await summary.click();
      await expect(modelFamilies.nth(0)).toHaveJSProperty("open", false);
      expect(
        await card.evaluate((element) => element.getBoundingClientRect().top),
      ).toBeCloseTo(top, 0);
    }
    await page.setViewportSize({ width: 740, height: 560 });
    await page.locator('[data-model-family="whisper"] > summary').click();
    await expect(
      page.locator('[data-model-family="whisper"]'),
    ).toHaveJSProperty("open", true);
    await page.locator('[data-model-family="parakeet"] > summary').click();
    await expect(
      page.locator('[data-model-family="parakeet"]'),
    ).toHaveJSProperty("open", true);
    await expect(page.locator(".setup-model-family .model-row")).toHaveCount(9);
    await page.evaluate(() => {
      window.testState.recommended_models = ["small", "parakeet-v3-q4"];
      window.publishState();
    });
    const whisperFamily = page.locator('[data-model-family="whisper"]');
    const parakeetFamily = page.locator('[data-model-family="parakeet"]');
    await expect(whisperFamily).toHaveJSProperty("open", true);
    await expect(parakeetFamily).toHaveJSProperty("open", true);
    await expect(
      whisperFamily
        .locator(".model-row")
        .filter({ hasText: "Whisper Small" })
        .getByText("Starting recommendation"),
    ).toBeVisible();
    await expect(
      whisperFamily
        .locator(".model-row")
        .filter({ hasText: "Whisper Base" })
        .getByText("Starting recommendation"),
    ).toHaveCount(0);
    await expect(
      parakeetFamily
        .locator(".model-row")
        .filter({ hasText: "Parakeet TDT v3 (compact)" })
        .getByText("Starting recommendation"),
    ).toBeVisible();
    await parakeetFamily.locator("summary").click();
    await expect(parakeetFamily).toHaveJSProperty("open", false);
    await expect(whisperFamily).toHaveJSProperty("open", true);
    await expect(page.locator("#record-control")).toBeHidden();
    await page.screenshot({
      path: `test-results/${platform}-setup-model-minimum.png`,
    });
    await page.setViewportSize({ width: 960, height: 680 });
    await page.screenshot({
      path: `test-results/${platform}-setup-model.png`,
    });
    await page.setViewportSize({ width: 740, height: 560 });

    await page.evaluate(() => {
      const w = window as any;
      w.testState.installed = [];
      w.publishState();
    });
    const baseModel = page
      .locator(".model-row")
      .filter({ hasText: "Whisper Base" });
    await baseModel.getByRole("button", { name: "Download" }).click();
    await expect(baseModel.getByRole("progressbar")).toBeVisible();
    await expect(whisperFamily).toHaveJSProperty("open", true);
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("download_model");
    await page.evaluate(() => {
      window.testState.progress = 0.42;
      window.publishState();
    });
    await expect(baseModel.getByRole("progressbar")).toHaveJSProperty(
      "value",
      0.42,
    );
    await baseModel.getByRole("button", { name: "Cancel" }).click();
    await expect(
      baseModel.getByRole("button", { name: "Download" }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("cancel_download");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: microphoneHeading }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByText("Step 1 of 6", { exact: true })).toBeVisible();
    await expect(whisperFamily).toHaveJSProperty("open", true);

    await page.evaluate(() => {
      const w = window as any;
      w.testState.installed = ["base", "small"];
      w.publishState();
    });
    const smallModel = page
      .locator(".model-row")
      .filter({ hasText: "Whisper Small" });
    await smallModel.getByRole("button", { name: "Use", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.model))
      .toBe("small");
    await expect(smallModel.getByText("Active", { exact: true })).toBeVisible();
    await expect(page.getByText("Step 1 of 6", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: microphoneHeading }),
    ).toBeVisible();

    if (platform === "linux") {
      await page.evaluate(
        ({ longMicrophoneId, longFriendlyName, unlabeledMicrophoneId }) => {
          const state = window.testState as any;
          state.microphones = [
            "Built-in microphone",
            "USB microphone",
            longMicrophoneId,
            unlabeledMicrophoneId,
          ];
          state.microphone_labels = [
            { id: longMicrophoneId, name: longFriendlyName },
          ];
          window.publishState();
        },
        { longMicrophoneId, longFriendlyName, unlabeledMicrophoneId },
      );
      const microphone = page.getByRole("combobox", { name: "Microphone" });
      await microphone.selectOption(longMicrophoneId);
      await expect(microphone.locator("option:checked")).toHaveText(
        longFriendlyName,
      );
      await expect
        .poll(() =>
          page.evaluate(() => window.testState.preferences.microphone),
        )
        .toBe(longMicrophoneId);
      await microphone.selectOption(unlabeledMicrophoneId);
      await expect(microphone.locator("option:checked")).toHaveText(
        unlabeledMicrophoneId,
      );
      await microphone.selectOption(longMicrophoneId);
      expect(
        await page.evaluate(() => {
          const card = document.querySelector<HTMLElement>(".setup-card")!;
          const body = document.querySelector<HTMLElement>(".setup-card-body")!;
          const content = document.querySelector<HTMLElement>(
            ".setup-panel-content",
          )!;
          const main = document.querySelector<HTMLElement>("main")!;
          const documentElement = document.documentElement;
          return [card, body, content, main, documentElement].map(
            (element) => element.scrollWidth <= element.clientWidth,
          );
        }),
      ).toEqual([true, true, true, true, true]);
      await page
        .getByRole("combobox", { name: "Microphone" })
        .selectOption(longMicrophoneId);
      await expect
        .poll(() =>
          page.evaluate(() => window.testState.preferences.microphone),
        )
        .toBe(longMicrophoneId);
    }

    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Choose a language" }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("de");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: microphoneHeading }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Language", exact: true }),
    ).toHaveValue("de");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Where should the text go?" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Copy to clipboard only" }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (platform === "linux") {
      await page.evaluate(() => {
        window.testState.paste_configuring = true;
        window.testState.paste_ready = false;
        window.publishState();
      });
      await expect(
        page.getByRole("button", { name: "Back", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeDisabled();
      await page
        .locator(".setup-panel-content")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.testState.paste_configuring))
        .toBe(false);
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Allow", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Allow", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.testState.paste_ready))
        .toBe(true);
      await page.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.testState.paste_ready))
        .toBe(false);
      await page.evaluate(() => {
        window.testState.paste_portal = false;
        window.testState.native_paste = false;
        window.testState.paste_ready = false;
        window.publishState();
      });
      await expect(
        page.getByText(
          "Your desktop does not expose this portal. Clipboard output remains available.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Allow", exact: true }),
      ).toBeDisabled();
    }
    if (platform === "macos") {
      expect(
        await page.evaluate(() => window.calls.map((call) => call.command)),
      ).not.toContain("allow_microphone");
    }
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Set a trigger and try it" }),
    ).toBeVisible();
    await page.evaluate(() => {
      const state = window.testState;
      if (state.platform === "macos") state.macos.recording_shortcut = true;
      else state.recording_shortcut = true;
      window.publishState();
    });
    await expect(
      page.getByRole("button", { name: "Back", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Finish setup", exact: true }),
    ).toBeDisabled();
    await page
      .locator(".setup-panel-content")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            !window.testState.recording_shortcut &&
            !window.testState.macos.recording_shortcut,
        ),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Finish setup", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() => window.calls.map((call) => call.command)),
    ).not.toContain("enable_shortcut");

    await page.evaluate(() => {
      window.publishNavigate("models");
    });
    await expect(
      page.getByRole("heading", { name: "Set a trigger and try it" }),
    ).toBeVisible();
    await expect(page.locator("nav button[data-tab]")).toHaveCount(0);

    await page
      .getByRole("button", { name: "Finish setup", exact: true })
      .click();
    await expect(page.locator("nav button[data-tab]")).toHaveCount(5);
    await page.locator('[data-ui-language="de"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("button", { name: "Einrichtung", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Allgemein" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Berechtigungen", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.testState.preferences.setup_completed),
      )
      .toBe(true);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Einrichtung", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Aufnahme", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Erlauben", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.model))
      .toBe("small");
    if (platform === "linux") {
      expect(
        await page.evaluate(() => window.testState.preferences.microphone),
      ).toBe(longMicrophoneId);
      await page.evaluate(
        ({ longMicrophoneId, longFriendlyName, unlabeledMicrophoneId }) => {
          window.testState.microphones = [
            "Built-in microphone",
            "USB microphone",
            longMicrophoneId,
            unlabeledMicrophoneId,
          ];
          window.testState.microphone_labels = [
            { id: longMicrophoneId, name: longFriendlyName },
          ];
          window.publishState();
        },
        { longMicrophoneId, longFriendlyName, unlabeledMicrophoneId },
      );
      await expect(
        page.getByRole("combobox", { name: "Mikrofon" }),
      ).toHaveValue(longMicrophoneId);
      await expect(
        page
          .getByRole("combobox", { name: "Mikrofon" })
          .locator("option:checked"),
      ).toHaveText(longFriendlyName);
    }
  });
  test(`${platform}: update controls show availability and prevent recording during installation`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.getByRole("button", { name: "About", exact: true }).click();
    await page.getByRole("button", { name: "Check now", exact: true }).click();
    await expect(page.getByText("Version 0.2.2 is available.")).toBeVisible();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.status = "transcribing";
      w.publishState();
    });
    await expect(
      page.getByRole("button", { name: "Download & install", exact: true }),
    ).toBeDisabled();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.status = "idle";
      w.publishState();
    });
    await page
      .getByRole("button", { name: "Download & install", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Start dictation", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText("Downloading update: 0%")).toBeVisible();
  });
  test(`${platform}: German views fit the minimum window and translate the floating timer`, async ({
    page,
  }) => {
    await start(page, platform, false, true);
    await page.setViewportSize({ width: 740, height: 560 });
    await page.getByRole("button", { name: "Deutsch", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("heading", {
        name: "Sprich. OpenWhisper schreibt mit.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Deutsch", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("nav button[data-tab]")).toHaveCount(0);
    expect(
      await page
        .locator("main")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/${platform}-setup-welcome-de.png`,
    });
    await page.setViewportSize({ width: 960, height: 680 });
    await page.screenshot({
      path: `test-results/${platform}-setup-welcome-de-wide.png`,
    });
    await page.setViewportSize({ width: 740, height: 560 });
    await page.getByRole("button", { name: "Weiter", exact: true }).click();
    const titles = [
      "Sprachmodell herunterladen",
      platform === "macos" ? "Mikrofonzugriff erlauben" : "Mikrofon wählen",
      "Sprache wählen",
      "Wo soll der Text erscheinen?",
      null,
      "Auslöser festlegen und ausprobieren",
    ];
    for (const [index, title] of titles.entries()) {
      await expect(
        page.getByText(`Schritt ${index + 1} von 6`, { exact: true }),
      ).toBeVisible();
      if (title) {
        await expect(
          page.getByRole("heading", { name: title, exact: true }),
        ).toBeVisible();
      } else {
        await expect(page.locator("main h1, main h2").first()).toBeVisible();
      }
      expect(
        await page
          .locator("main")
          .evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBe(true);
      if (index === 0) {
        await page.screenshot({
          path: `test-results/${platform}-setup-model-de-minimum.png`,
        });
        await page.setViewportSize({ width: 960, height: 680 });
        await page.screenshot({
          path: `test-results/${platform}-setup-model-de.png`,
        });
        await page.setViewportSize({ width: 740, height: 560 });
      }
      await page
        .getByRole("button", {
          name: index === 5 ? "Einrichtung abschließen" : "Weiter",
          exact: true,
        })
        .click();
    }
    await expect(page.locator("nav button[data-tab]")).toHaveCount(5);
    await expect(
      page.getByRole("heading", { name: "Aufnahme", exact: true }),
    ).toBeVisible();
    for (const title of [
      "Allgemein",
      "Modelle",
      "Textbausteine",
      "Verlauf",
      "Über",
    ]) {
      await page.getByRole("button", { name: title, exact: true }).click();
      expect(
        await page
          .locator("main")
          .evaluate((e) => e.scrollWidth <= e.clientWidth),
      ).toBe(true);
      await expect(
        page.getByRole("button", { name: "Diktat starten", exact: true }),
      ).toBeInViewport();
    }
    await page.evaluate(() => {
      const w = window as any;
      w.testState.status = "recording";
      w.testState.elapsed = 126;
      w.publishState();
    });
    await expect(page.locator("#record-label")).toHaveText("Aufnahme · 2:06");
    await expect(
      page.getByRole("button", { name: "Aufnahme verwerfen" }),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/${platform}-german.png` });
  });
}

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: unavailable login capability preserves the saved preference`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.evaluate(() => {
      const host = window as Window & {
        testState: {
          launch_at_login_available?: boolean;
          preferences: { launch_at_login?: boolean };
        };
        publishState(): void;
      };
      host.testState.preferences.launch_at_login = true;
      host.testState.launch_at_login_available = false;
      host.publishState();
    });
    const login = page.getByRole("checkbox", {
      name: "Launch at login",
      exact: true,
    });
    await expect(login).toBeChecked();
    await expect(login).toBeDisabled();
    await page.evaluate(() => {
      const host = window as Window & {
        testState: { launch_at_login_available?: boolean };
        publishState(): void;
      };
      host.testState.launch_at_login_available = true;
      host.publishState();
    });
    await expect(login).toBeEnabled();
    await expect(login).toBeChecked();
  });
  test(`${platform}: login and idle overlay switches remain independent through delayed saves and restart`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.setViewportSize({ width: 800, height: 560 });
    const login = page.getByRole("checkbox", {
      name: "Launch at login",
      exact: true,
    });
    const overlay = page.getByRole("checkbox", {
      name: "Show overlay when idle",
      exact: true,
    });
    await login.scrollIntoViewIfNeeded();
    const before = await login.boundingBox();
    await login.evaluate((input) => {
      (window as any).originalLoginSwitch = input;
    });
    await page.evaluate(() => {
      (window as any).saveDelay = 200;
    });
    await login.click();
    await overlay.click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).testState.preferences.launch_at_login,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).testState.preferences.show_idle_overlay,
        ),
      )
      .toBe(true);
    await expect(login).toBeChecked();
    await expect(overlay).toBeChecked();
    // Native hosts publish another snapshot after completing the command reply.
    await page.evaluate(() => (window as any).publishState());
    expect(
      await page.evaluate(
        () => (window as any).originalLoginSwitch.isConnected,
      ),
    ).toBe(true);
    const after = await login.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 0);
    await login.click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).testState.preferences.launch_at_login,
        ),
      )
      .toBe(false);
    await expect(overlay).toBeChecked();
    await page.reload();
    await expect(login).not.toBeChecked();
    await expect(overlay).toBeChecked();
    const changes = await page.evaluate(() =>
      (window as any).calls.filter(
        (c: any) => c.command === "save_preferences",
      ),
    );
    expect(
      changes.every((c: any) => Object.keys(c.args.changes).length === 1),
    ).toBe(true);
  });
  test(`${platform}: failed saves restore a switch without changing the neighboring setting`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.evaluate(() => {
      (window as any).rejectSave = true;
    });
    const login = page.getByRole("checkbox", {
      name: "Launch at login",
      exact: true,
    });
    await login.click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not save settings",
    );
    await expect(login).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", {
        name: "Show overlay when idle",
        exact: true,
      }),
    ).not.toBeChecked();
  });
}

test("Linux recognition mode selection remains independent of launch-at-login", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, {
      gpu_supported: true,
      gpu_available: true,
      gpu_device: "NVIDIA GeForce RTX 3060",
    });
    w.publishState();
  });
  const gpu = page.locator('input[name="gpu-mode"][value="true"]');
  await gpu.check();
  await expect(
    page.getByText(
      "GPU selected. Vulkan device detected: NVIDIA GeForce RTX 3060",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Launch at login", exact: true }),
  ).not.toBeChecked();
  await page.evaluate(() => {
    window.testState.launch_at_login_available = false;
    window.publishState();
  });
  await expect(
    page.getByRole("checkbox", { name: "Launch at login", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Launch at login is unavailable in this installation.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(gpu).toBeChecked();
  await expect(
    page.getByText("No compatible GPU detected.", { exact: false }),
  ).not.toBeVisible();
});

test("Mac Dev controls expose native Accessibility setup and preserve separate trigger profiles", async ({
  page,
}) => {
  await start(page, "macos");
  await page.evaluate(() => {
    const host = window as unknown as {
      testState: import("../../src/contracts/ui/state.js").AppState;
      publishState(): void;
    };
    if (!host.testState.macos) throw new Error("Missing Mac capabilities");
    host.testState.macos.shortcut_toggle_only = true;
    host.testState.macos.clipboard_restore_available = false;
    host.testState.preferences.output = "paste";
    host.testState.native_shortcuts = true;
    host.testState.shortcut_portal = false;
    host.testState.native_paste = true;
    host.testState.paste_portal = false;
    host.testState.shortcut = "Command+Shift+Space";
    host.testState.preferences.macos_shortcut = "Command+Shift+Space";
    host.testState.preferences.native_trigger = { kind: "mouse", button: 8 };
    host.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByLabel("Recording mode")).toBeDisabled();
  await expect(page.getByLabel("Recording mode")).toHaveValue("false");
  await expect(
    page.getByText(
      "Regular keyboard shortcuts use toggle mode in this build.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator('[data-portal="enable_paste"]')).toBeEnabled();
  await expect(
    page.getByRole("checkbox", {
      name: "Restore the previous clipboard afterward",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Command+Shift+Space", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove trigger", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Set trigger …", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => {
      const host = window as unknown as {
        testState: import("../../src/contracts/ui/state.js").AppState;
      };
      return {
        mac: host.testState.preferences.macos_shortcut,
        linux: host.testState.preferences.native_trigger,
      };
    }),
  ).toEqual({ mac: null, linux: { kind: "mouse", button: 8 } });
});

test("macOS shows pending login approval without changing the idle overlay", async ({
  page,
}) => {
  await start(page, "macos");
  await page.setViewportSize({ width: 800, height: 560 });
  await page.evaluate(() => {
    const w = window as any;
    w.testState.preferences.launch_at_login = true;
    w.testState.macos.launch_at_login_pending = true;
    w.publishState();
  });
  await expect(
    page.getByRole("checkbox", { name: "Launch at login", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByText(
      "Allow OpenWhisper in System Settings to finish enabling launch at login.",
    ),
  ).toBeVisible();
  expect(
    await page.locator("main").evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await page
    .getByRole("checkbox", { name: "Launch at login", exact: true })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: "Show overlay when idle", exact: true }),
  ).not.toBeChecked();
});

test("Linux: native trigger capture blocks recording, cancels, and shows saved mouse bindings", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, {
      native_shortcuts: true,
      native_mouse: true,
      native_middle_mouse: true,
    });
    w.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(
    page.getByText("Choose a single key, shortcut, or mouse button.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Set trigger …", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Press and release" }),
  ).toBeVisible();
  await expect(page.locator("#record")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#record")).toBeEnabled();
  await page.evaluate(() => {
    const w = window as any;
    w.testState.preferences.native_trigger = { kind: "mouse", button: 8 };
    w.testState.shortcut = "Mouse back button";
    w.publishState();
  });
  await expect(
    page.getByRole("button", { name: "Mouse back button", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Recording mode" }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 800, height: 560 });
  await page.evaluate(() => {
    const w = window as any;
    w.testState.preferences.ui_language = "de";
    w.publishState();
  });
  await expect(
    page.getByRole("button", { name: "Zurück-Maustaste", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator("main")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/linux-native-triggers-german.png",
  });
  await page.evaluate(() => {
    const w = window as any;
    w.testState.preferences.ui_language = "en";
    w.publishState();
  });
  await page
    .getByRole("button", { name: "Remove trigger", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Set trigger …", exact: true }),
  ).toBeVisible();
});

test("Linux mouse setup commits matching middle, back and forward releases only during setup", async ({
  page,
  context,
}) => {
  await start(page, "linux");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.evaluate(() => {
    Object.assign(window.testState, {
      native_shortcuts: true,
      native_mouse: true,
      native_middle_mouse: true,
    });
    window.publishState();
  });
  const input = await context.newCDPSession(page);
  for (const [button, mask, expected] of [
    ["middle", 4, 2],
    ["back", 8, 8],
    ["forward", 16, 9],
  ] as const) {
    await page
      .getByRole("button", { name: "Set trigger …", exact: true })
      .click();
    const before = await page.evaluate(
      () =>
        window.calls.filter((call) => call.command === "capture_mouse_trigger")
          .length,
    );
    await input.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 500,
      y: 300,
      button,
      buttons: mask,
      clickCount: 1,
    });
    expect(
      await page.evaluate(
        () =>
          window.calls.filter(
            (call) => call.command === "capture_mouse_trigger",
          ).length,
      ),
    ).toBe(before);
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 500,
      y: 300,
      button,
      buttons: 0,
      clickCount: 1,
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.calls
              .filter((call) => call.command === "capture_mouse_trigger")
              .at(-1)?.args,
        ),
      )
      .toEqual({ button: expected });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  const before = await page.evaluate(
    () =>
      window.calls.filter((call) => call.command === "capture_mouse_trigger")
        .length,
  );
  await page.mouse.click(500, 300, { button: "middle" });
  expect(
    await page.evaluate(
      () =>
        window.calls.filter((call) => call.command === "capture_mouse_trigger")
          .length,
    ),
  ).toBe(before);
});

test("Linux X11 fallback exposes explicit keyboard setup and session paste without portals", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, {
      session: "X11",
      native_shortcuts: true,
      native_x11: true,
      native_paste: true,
      shortcut_portal: false,
      paste_portal: false,
    });
    w.testState.preferences.native_trigger = { kind: "key", key: 0x01000021 };
    w.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(
    page.getByText("Choose a regular keyboard key or shortcut.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Recording mode" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Automatic X11 paste", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Set trigger …", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Press and release a keyboard key" }),
  ).toBeVisible();
  await expect(page.locator("#record")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#record")).toBeEnabled();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Allow", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("Native X11 triggers", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Native X11 paste", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(2);
});

test("Linux X11 trigger removal and German help preserve the inactive KDE profile", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, {
      session: "X11",
      native_shortcuts: true,
      native_x11: true,
      native_paste: true,
      shortcut_portal: false,
      paste_portal: false,
      shortcut: "F8",
    });
    Object.assign(w.testState.preferences, {
      ui_language: "de",
      x11_trigger: { keycode: 74, keysym: 65477, modifiers: 0, group: 0 },
      native_trigger: { kind: "mouse", button: 8 },
    });
    w.publishState();
  });
  await page.getByRole("button", { name: "Allgemein", exact: true }).click();
  await expect(
    page.getByText("Automatisches Einfügen unter X11", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Wähle eine normale Taste", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "F8", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Auslöser entfernen", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Auslöser festlegen …", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).testState.preferences.native_trigger,
    ),
  ).toEqual({ kind: "mouse", button: 8 });
  expect(
    await page.evaluate(
      () => (window as any).testState.preferences.x11_trigger,
    ),
  ).toBeNull();
});

test("Linux: modifier-only triggers explain toggle mode and disable push to talk", async ({
  page,
}) => {
  await start(page, "linux");
  await page.evaluate(() => {
    const w = window as any;
    Object.assign(w.testState, { native_shortcuts: true, shortcut: "Ctrl" });
    w.testState.preferences.native_trigger = { kind: "key", key: 0x01000021 };
    w.publishState();
  });
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Recording mode" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Modifier-only triggers use toggle mode.", { exact: false }),
  ).toBeVisible();
});

test("Linux clipboard delivery failures fully translate while retaining raw dictation", async ({
  page,
}) => {
  await start(page, "linux");
  await page.getByRole("button", { name: "Deutsch", exact: true }).click();
  const german = JSON.parse(readFileSync(resolve("locales/de.json"), "utf8"));
  const messages = [
    "Clipboard delivery could not be confirmed. Copy from the transcript or try again",
    "Clipboard delivery timed out. Copy from the transcript or try again",
    "Clipboard unavailable. Install wl-clipboard (Wayland) or xclip (X11)",
  ].map(
    (message) =>
      message +
      ". Your recording is retained. Retry transcription or discard it.",
  );
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
    await expect(
      page.getByRole("button", { name: "Erneut transkribieren", exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Verlauf", exact: true }).click();
  await expect(page.locator(".history-row p")).toHaveText(
    "Clipboard delivery timed out",
  );
  expect(await page.evaluate(() => (window as any).testState.transcript)).toBe(
    "Clipboard delivery timed out",
  );
});

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: cancelled permission can be retried without a host state event`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.evaluate(() => {
      const host = window as any;
      host.rejectPortal = true;
      host.portalDelay = 500;
    });
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Allow", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Set trigger …", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText(
      "Permission request cancelled",
    );
    await expect(
      page.getByRole("button", { name: "Allow", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Set trigger …", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => {
      (window as any).rejectPortal = false;
    });
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).calls.filter(
              (call: any) => call.command === "enable_paste",
            ).length,
        ),
      )
      .toBe(2);
    if (platform === "linux") {
      await expect(
        page.getByRole("button", { name: "Revoke", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Allow", exact: true }),
      ).toBeEnabled();
    } else {
      await expect(page.locator('[data-portal="disable_paste"]')).toBeEnabled();
    }
  });
}

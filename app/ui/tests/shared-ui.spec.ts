import { test, expect, Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
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
const recordingPolishScreenshots = resolve(
  "../../.local/validation/ui-redesign-setup/recording-polish",
);
mkdirSync(recordingPolishScreenshots, { recursive: true });
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
  await selectSettingsTab(page, "recording");
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

test("Insert requests permission only on intent and persists once after an intervening state refresh", async ({
  page,
}) => {
  await start(page, "linux", false, false, false, null);
  const insert = page.locator('#record-control [data-output="paste"]');
  const enableRequests = () =>
    page.evaluate(
      () =>
        window.calls.filter((call) => call.command === "enable_paste").length,
    );
  const insertPreferenceWrites = () =>
    page.evaluate(
      () =>
        window.calls.filter(
          (call) =>
            call.command === "save_preferences" &&
            (call.args as { changes?: { output?: string } } | undefined)
              ?.changes?.output === "paste",
        ).length,
    );

  await expect(insert).toHaveAttribute("aria-pressed", "false");
  expect(await enableRequests()).toBe(0);
  await page.evaluate(() => {
    Object.assign(window.testState, {
      paste_portal: false,
      native_paste: false,
    });
    window.publishState();
  });
  await insert.click();
  await expect(page.locator("#notice")).toContainText(
    "Your desktop does not expose this portal. Clipboard output remains available.",
  );
  expect(await enableRequests()).toBe(0);
  await expect(insert).toHaveAttribute("aria-pressed", "false");

  await page.evaluate(() => {
    Object.assign(window.testState, {
      paste_portal: true,
      status: "recording",
    });
    window.publishState();
  });
  await expect(insert).toBeDisabled();
  expect(await enableRequests()).toBe(0);
  await page.evaluate(() => {
    Object.assign(window.testState, {
      status: "error",
      recovery_available: true,
    });
    window.publishState();
  });
  await expect(insert).toBeDisabled();
  expect(await enableRequests()).toBe(0);

  await page.evaluate(() => {
    const host = window as any;
    Object.assign(host.testState, {
      status: "idle",
      recovery_available: false,
    });
    host.rejectPortal = true;
    host.publishState();
  });
  await insert.click();
  await expect(page.locator("#notice")).toContainText(
    "Permission request cancelled",
  );
  expect(await enableRequests()).toBe(1);
  expect(await insertPreferenceWrites()).toBe(0);
  await expect
    .poll(() => page.evaluate(() => window.testState.preferences.output))
    .toBe("clipboard");
  await expect(insert).toHaveAttribute("aria-pressed", "false");

  await page.evaluate(() => {
    const host = window as any;
    host.rejectPortal = false;
    host.deferPasteRequest = true;
  });
  await insert.click();
  await expect.poll(enableRequests).toBe(2);
  await page.evaluate(() => {
    // This unrelated steady-state event can arrive before portal setup starts.
    window.testState.elapsed += 1;
    window.publishState();
  });
  await page.evaluate(() => {
    window.testState.paste_configuring = true;
    window.publishState();
  });
  await expect(insert).toBeDisabled();
  await page.evaluate(() => {
    window.testState.paste_ready = true;
    window.testState.paste_configuring = false;
    window.publishState();
    (window as any).resolvePasteRequest();
  });
  await expect
    .poll(() => page.evaluate(() => window.testState.preferences.output))
    .toBe("paste");
  expect(await insertPreferenceWrites()).toBe(1);
  await expect(insert).toHaveAttribute("aria-pressed", "true");

  await page.evaluate(() => {
    window.testState.preferences.output = "clipboard";
    window.publishState();
  });
  await selectSettingsTab(page, "recording");
  await page
    .locator(
      '#settings-recording-output input[data-pref="output"][value="paste"]',
    )
    .check();
  await expect
    .poll(() => page.evaluate(() => window.testState.preferences.output))
    .toBe("paste");
  expect(await insertPreferenceWrites()).toBe(2);
  expect(await enableRequests()).toBe(2);
});

test("Mac Insert opens Accessibility settings, then saves only after the user retries", async ({
  page,
}) => {
  await start(page, "macos");
  await closeSettings(page);
  await page.evaluate(() => {
    (window as any).autoGrantPaste = false;
  });
  const insert = page.locator('#record-control [data-output="paste"]');
  await insert.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.calls.filter((call) => call.command === "enable_paste").length,
      ),
    )
    .toBe(1);
  await expect(page.locator("#notice")).toContainText(
    "Allow keyboard access in System Settings, then select Insert again.",
  );
  await expect(insert).toHaveAttribute("aria-pressed", "false");
  expect(
    await page.evaluate(
      () =>
        window.calls.filter(
          (call) =>
            call.command === "save_preferences" &&
            (call.args as { changes?: { output?: string } } | undefined)
              ?.changes?.output === "paste",
        ).length,
    ),
  ).toBe(0);

  await page.evaluate(() => {
    window.testState.paste_ready = true;
    window.publishState();
  });
  await insert.click();
  await expect
    .poll(() => page.evaluate(() => window.testState.preferences.output))
    .toBe("paste");
  expect(
    await page.evaluate(
      () =>
        window.calls.filter(
          (call) =>
            call.command === "save_preferences" &&
            (call.args as { changes?: { output?: string } } | undefined)
              ?.changes?.output === "paste",
        ).length,
    ),
  ).toBe(1);
  await expect(insert).toHaveAttribute("aria-pressed", "true");
});

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: visible product copy uses Recording wording in English and German`, async ({
    page,
  }) => {
    const assertVisibleCopy = async () => {
      const visibleText = await page.locator("body").innerText();
      expect(visibleText).not.toMatch(
        /\b(dictation|dictate|diktat|diktieren|wörterbuch)\b/iu,
      );
    };

    await start(page, platform, false, false, false, null);
    await assertVisibleCopy();
    await openSettings(page);
    await selectSettingsTab(page, "general");
    await page.locator('[data-ui-language="de"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await closeSettings(page);
    await assertVisibleCopy();
  });
}

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: setup uses Recording wording in English and German`, async ({
    page,
  }) => {
    await start(page, platform, false, true);
    const assertVisibleCopy = async () => {
      const visibleText = await page.locator("body").innerText();
      expect(visibleText).not.toMatch(
        /\b(dictation|dictate|diktat|diktieren|wörterbuch)\b/iu,
      );
    };
    await assertVisibleCopy();
    await page.getByRole("button", { name: "Deutsch", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await assertVisibleCopy();
  });
}

test("Linux overlay availability distinguishes unsupported protocol from missing runtime and translates both", async ({
  page,
}) => {
  await start(page, "linux");
  await selectSettingsTab(page, "recording");
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
  await selectSettingsTab(page, "general");
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
  await start(page, "linux", false, false, false, null);
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
  await expect(page.locator("#record")).toBeDisabled();
  await openSettings(page);
  await selectSettingsTab(page, "text");
  await page.locator("#new-vocabulary-spelling").fill("Unsaved vocabulary");
  await page.locator("#vocabulary-add-form").press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
    .toEqual([{ spelling: "Unsaved vocabulary", misheard: [] }]);
  await page.locator('.settings-dialog-nav [data-tab="history"]').click();
  await closeSettings(page);
  await page.locator("#record-unavailable-action").click();
  await expect(page.locator("dialog#model-drawer")).toBeVisible();
  await expect(page.locator('[data-download="base"]')).toHaveText("Download");
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    window.testState.recording_unavailable_reason = "permission";
    window.testState.preferences.ui_language = "de";
    window.publishState();
  });
  await expect(page.locator("#status-title")).toHaveText(
    "Aufnahme nicht verfügbar",
  );
  await expect(page.locator("#status")).toHaveText(
    "Mikrofonzugriff ist erforderlich. Prüfe die Einstellungen unter „Aufnahme“.",
  );
  await expect(page.locator("#record-unavailable-action")).toHaveText(
    "Einstellungen öffnen",
  );
  await page.locator("#record-unavailable-action").click();
  await expect(
    page.locator('.settings-dialog-nav [data-tab="recording"]'),
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
  await selectSettingsTab(page, "recording");
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
  await selectSettingsTab(page, "recording");
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
  await closeSettings(page);
  await expect(
    page
      .locator(".dictation-transcript-body")
      .getByText(
        "The complete transcript is available with Copy; its preview is too large.",
      ),
  ).toBeVisible();
  await page.locator("#copy-dictation").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.at(-1).command))
    .toBe("copy_transcript");
  await page.evaluate(() => {
    const host = window as any;
    host.testState.preferences.ui_language = "de";
    host.publishState();
  });
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(
    page
      .locator(".dictation-transcript-body")
      .getByText(
        "Das vollständige Transkript ist über Kopieren verfügbar; seine Vorschau ist zu groß.",
      ),
  ).toBeVisible();
  await expect(page.locator("#copy-dictation")).toHaveText("Kopieren");
  await page.locator("#copy-dictation").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).calls.at(-1).command))
    .toBe("copy_transcript");
});

test("workspace command failure keeps the global notice visible above the workspace", async ({
  page,
}) => {
  await start(page, "linux", false, false, false, null);
  await page.evaluate(() => {
    window.testState.status = "done";
    window.testState.transcript =
      "Synthetic transcript for error notice coverage.";
    (window as any).rejectCommand = "copy_transcript";
    (window as any).rejectCommandMessage = "Synthetic host failure";
    window.publishState();
  });
  await page.locator("#copy-dictation").click();
  const notice = page.locator("#notice");
  await expect(notice).toHaveText("Error: Synthetic host failure");
  const geometry = await notice.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const workspace = document
      .querySelector("#dictation-workspace")!
      .getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      workspaceTop: workspace.top,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      hitNotice: element.contains(document.elementFromPoint(centerX, centerY)),
      zIndex: Number.parseInt(getComputedStyle(element).zIndex, 10),
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.workspaceTop + 80);
  expect(geometry.hitNotice).toBe(true);
  expect(geometry.zIndex).toBeGreaterThan(0);
  await page.screenshot({
    path: "test-results/linux-global-command-error.png",
  });
});

test("saved Linux recordings can be retried or discarded without starting capture", async ({
  page,
}) => {
  await start(page, "linux", false, false, false, null);
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
  await expect(page.locator("#record-label")).toHaveText("Retry transcription");
  const retry = page.locator("#record");
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
  await expect(page.locator("#record-label")).toHaveText(
    "Erneut transkribieren",
  );
  await expect(
    page.getByRole("button", {
      name: "Gesicherte Aufnahme verwerfen",
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 800, height: 560 });
  await expect(page.locator("#record-label")).toBeInViewport();
  await page.screenshot({ path: "test-results/linux-recovery.png" });
  await page.evaluate(() => {
    const host = window as any;
    host.testState.updates.status = "ready";
    host.testState.updates.progress = 1;
    host.testState.updates.version = "0.2.2";
    host.publishState();
  });
  await selectSettingsTab(page, "about");
  await closeSettings(page);
  const update = page.locator("#header-update");
  await expect(update).toBeVisible();
  await expect(update).toBeEnabled();
  await update.click();
  await expect(page.locator("#update-dialog")).toBeVisible();
  await expect(page.locator("#update-main-action")).toBeDisabled();
  await expect(page.locator("#update-dialog-hint")).toContainText(
    "gespeicherte Aufnahme",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#update-dialog")).toBeHidden();
  await expect(update).toBeFocused();
});

async function start(
  page: Page,
  platform: "linux" | "macos",
  overlay = false,
  fresh = false,
  initialStateRace = false,
  initialTab: AppState["initial_tab"] | null = "general",
  updatesConfigured = true,
  development = false,
) {
  let savedPreferences: unknown = null;
  await page.exposeBinding("loadTestPreferences", () => savedPreferences);
  await page.exposeBinding("saveTestPreferences", (_, preferences) => {
    savedPreferences = preferences;
  });
  await page.addInitScript(
    ({
      platform,
      models,
      overlay,
      fresh,
      initialStateRace,
      initialTab,
      updatesConfigured,
      development,
    }) => {
      const host = window as any;
      host.__OPENWHISPER_OVERLAY__ = platform === "macos" && overlay;
      host.calls = [];
      const state: any = {
        platform,
        profile: development ? "development" : undefined,
        updates: {
          configured: updatesConfigured,
          status: "idle",
          version: null,
          progress: 0,
          error: null,
          package: platform === "linux" ? "appimage" : "macos",
        },
        initial_tab: initialTab ?? undefined,
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
          vocabulary: [],
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
        recommended_models: ["base", "parakeet-v3-q4"],
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
          updates_configured: updatesConfigured,
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
        if (host.rejectCommand === command)
          throw new Error(
            host.rejectCommandMessage ?? "Synthetic host failure",
          );
        if (command === "enable_paste" && host.rejectPortal) {
          await new Promise((resolve) =>
            setTimeout(resolve, host.portalDelay ?? 0),
          );
          throw new Error("Permission request cancelled");
        }
        if (command === "enable_paste" && host.deferPasteRequest) {
          await new Promise<void>((resolve) => {
            host.resolvePasteRequest = resolve;
          });
        }
        if (command === "get_state") {
          const saved = await host.loadTestPreferences();
          if (saved) {
            state.preferences = saved;
            state.recommended_models = saved.gpu
              ? ["large-v3-turbo-q5_0", "parakeet-v3-q8"]
              : ["base", "parakeet-v3-q4"];
          }
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
          if (Object.hasOwn(args.changes, "gpu"))
            state.recommended_models = args.changes.gpu
              ? ["large-v3-turbo-q5_0", "parakeet-v3-q8"]
              : ["base", "parakeet-v3-q4"];
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
        if (
          command === "check_updates" &&
          (state.profile === "development" || !state.updates.configured)
        )
          throw new Error("Updates are not configured in this fixture.");
        if (command === "check_updates")
          Object.assign(state.updates, {
            status: "available",
            version: "0.2.2",
            details: {
              highlights: ["Improved keyboard access"],
              size: 1234,
            },
          });
        if (command === "download_update") state.updates.status = "downloading";
        if (command === "install_update") state.updates.status = "installing";
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
        if (command === "enable_paste" && host.autoGrantPaste !== false)
          state.paste_ready = true;
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
    {
      platform,
      models: catalog,
      overlay,
      fresh,
      initialStateRace,
      initialTab,
      updatesConfigured,
      development,
    },
  );
  await page.goto(
    pathToFileURL(resolve("dist/index.html")).href +
      (overlay && platform === "linux" ? "?overlay" : ""),
  );
  if (overlay) {
    await expect(page.locator("#record")).toBeVisible();
    return;
  }
  if (fresh) {
    await expect(
      page.getByRole("heading", {
        name: "Speak. OpenWhisper writes with you.",
        exact: true,
      }),
    ).toBeVisible();
  } else if (initialTab === null) {
    await expect(page.locator("main#dictation-content")).toBeVisible();
    await expect(page.locator("dialog#settings-dialog")).toBeHidden();
  } else {
    await expect(page.locator("dialog#settings-dialog")).toBeVisible();
    await expect(
      page.locator('.settings-dialog-nav [data-tab="general"]'),
    ).toHaveClass(/selected/);
    await expect(page.locator(".settings-content")).toBeVisible();
  }
}

async function waveformPixels(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0 || canvas.height === 0)
      throw new Error("Waveform canvas is not drawable.");
    const { data, width, height } = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const columns = Array<number>(width).fill(0);
    const center = height / 2;
    let paintedPixels = 0;
    let peakDistance = 0;
    let signature = 2166136261;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3]!;
      signature = Math.imul(signature ^ alpha, 16777619) >>> 0;
      if (alpha < 16) continue;
      paintedPixels++;
      const pixel = index / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const distance = Math.abs(y + 0.5 - center);
      if (distance > 2) {
        columns[x]! += alpha * distance;
        peakDistance = Math.max(peakDistance, distance);
      }
    }
    let peakX = -1;
    let peakStrength = 0;
    for (let x = 0; x < columns.length; x++) {
      if (columns[x]! > peakStrength) {
        peakX = x;
        peakStrength = columns[x]!;
      }
    }
    const rect = canvas.getBoundingClientRect();
    return {
      width,
      height,
      cssWidth: rect.width,
      cssHeight: rect.height,
      pixelRatio: rect.width ? width / rect.width : 0,
      cssPeakRight:
        peakX >= 0 && rect.width
          ? rect.width - peakX / (width / rect.width)
          : -1,
      paintedPixels,
      peakX,
      peakRight: peakX >= 0 ? width - peakX : -1,
      peakStrength,
      peakDistance,
      signature,
    };
  });
}

async function blockMicrophoneInput(page: Page) {
  await page.addInitScript(() => {
    (window as any).__syntheticMicrophoneRequests = 0;
    const mediaDevices = navigator.mediaDevices ?? {};
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: () => {
        (window as any).__syntheticMicrophoneRequests++;
        return Promise.reject(
          new Error("Microphone access is disabled in tests."),
        );
      },
    });
    if (!navigator.mediaDevices)
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: mediaDevices,
      });
  });
}

async function openSettings(page: Page) {
  const dialog = page.locator("dialog#settings-dialog");
  if (
    !(await dialog.evaluate((element) => (element as HTMLDialogElement).open))
  )
    await page.locator("#open-settings").click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeSettings(page: Page, escape = false) {
  const dialog = page.locator("dialog#settings-dialog");
  await expect(dialog).toBeVisible();
  if (escape) await page.keyboard.press("Escape");
  else await page.locator("#close-settings").click();
  await expect(dialog).toBeHidden();
}

async function selectSettingsTab(page: Page, tab: string) {
  await openSettings(page);
  const aliases: Record<string, string> = {
    snippets: "text",
    "text processing": "text",
    "recording & shortcuts": "recording",
  };
  const view = aliases[tab.toLowerCase()] ?? tab;
  const button = page.locator(`.settings-dialog-nav [data-tab="${view}"]`);
  await button.click();
  await expect(button).toHaveClass(/selected/);
  await expect(button).toHaveAttribute("aria-current", "page");
  await expect(
    page.locator('.settings-dialog-nav [aria-current="page"]'),
  ).toHaveCount(1);
  return button;
}

async function setWorkspaceLanguage(page: Page, language: "en" | "de") {
  await openSettings(page);
  await selectSettingsTab(page, "general");
  await page.locator(`[data-ui-language="${language}"]`).click();
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await closeSettings(page);
}

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: settings Escape restores its opener and preserves a focused dirty editor`, async ({
    page,
  }) => {
    await start(page, platform, false, false, false, null);
    const opener = page.locator("#open-settings");
    await opener.focus();
    await opener.click();
    const dialog = page.locator("dialog#settings-dialog");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await openSettings(page);
    await selectSettingsTab(page, "text");
    await page.evaluate(() => {
      window.testState.preferences.vocabulary = [
        { spelling: "Existing", misheard: [] },
      ];
      window.publishState();
    });
    const vocabulary = page.locator("[data-vocabulary-spelling]").first();
    await vocabulary.fill("Unsaved focused vocabulary");
    await page.evaluate(() => {
      window.testState.elapsed = 3;
      window.publishState();
    });
    await expect(dialog).toBeVisible();
    await expect(vocabulary).toBeFocused();
    await expect(vocabulary).toHaveValue("Unsaved focused vocabulary");
    await expect(page.locator("#vocabulary-save-status")).toHaveText("Saved", {
      timeout: 2_000,
    });
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual([{ spelling: "Unsaved focused vocabulary", misheard: [] }]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });
}

test("recording telemetry follows the newest full state and ignores stale generations and final updates", async ({
  page,
}) => {
  await start(page, "linux", false, false, true);
  await expect(page.locator("#record-label")).toHaveText("Recording · 0:05");

  await page.evaluate(() => {
    const host = window as any;
    host.publishTelemetry({ generation: 7, elapsed: 99, level: 1 });
  });
  await expect(page.locator("#record-label")).toHaveText("Recording · 0:05");

  await page.evaluate(() => {
    const host = window as any;
    host.testState.status = "done";
    host.testState.level = 0;
    host.publishState();
    host.publishTelemetry({ generation: 8, elapsed: 6, level: 1 });
  });
  await expect(page.locator("#record-label")).toHaveText("Start recording");
});

test("waveform canvas ignores stale telemetry and stays static with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await blockMicrophoneInput(page);
  await start(page, "linux", false, false, false, null);
  const canvas = page.locator(
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  await expect(canvas).toBeVisible();
  const idle = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );

  await page.evaluate(() => {
    Object.assign(window.testState, {
      status: "recording",
      recording_generation: 7,
      elapsed: 1,
      level: 0,
    });
    window.publishState();
    window.publishTelemetry({ generation: 7, elapsed: 1, level: 0.85 });
  });
  await page.clock.runFor(100);
  const firstPeak = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  expect(firstPeak.paintedPixels).toBeGreaterThan(0);
  expect(firstPeak.signature).not.toBe(idle.signature);
  expect(firstPeak.peakDistance).toBeGreaterThan(idle.peakDistance);

  await page.evaluate(() => {
    window.publishTelemetry({ generation: 6, elapsed: 99, level: 1 });
  });
  await page.clock.runFor(200);
  const afterStale = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  expect(afterStale.signature).toBe(firstPeak.signature);

  await page.evaluate(() => {
    window.publishTelemetry({ generation: 7, elapsed: 2, level: 0.2 });
  });
  await page.clock.runFor(80);
  const withHistory = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  await page.screenshot({
    path: resolve(
      recordingPolishScreenshots,
      "waveform-reduced-motion-history.png",
    ),
  });
  await page.evaluate(() => {
    (window as any).__recordingWaveformCanvas = document.querySelector(
      '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
    );
  });
  await page.locator("#toggle-history").click();
  await expect(page.locator("#toggle-history")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.clock.runFor(300);
  const afterHistoryToggle = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).__recordingWaveformCanvas ===
        document.querySelector(
          '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
        ),
    ),
  ).toBe(true);
  expect(afterHistoryToggle.peakDistance).toBe(withHistory.peakDistance);
  expect(afterHistoryToggle.paintedPixels).toBeGreaterThan(0);
  await page.clock.runFor(600);
  const expiredEnvelope = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  expect(expiredEnvelope.paintedPixels).toBe(0);
  expect(expiredEnvelope.peakDistance).toBe(0);
  await expect(page.locator("#record-label")).toHaveText("Recording · 0:02");

  await page.evaluate(() => {
    window.publishTelemetry({ generation: 7, elapsed: 3, level: 0.7 });
  });
  await page.clock.runFor(100);
  const recovered = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  expect(recovered.paintedPixels).toBeGreaterThan(0);
  expect(recovered.peakDistance).toBeGreaterThan(idle.peakDistance);

  await page.evaluate(() => {
    window.testState.status = "transcribing";
    window.publishState();
  });
  await page.clock.runFor(200);
  const stopped = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  await page.clock.runFor(200);
  const stoppedAgain = await waveformPixels(
    page,
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]',
  );
  expect(stoppedAgain.signature).toBe(stopped.signature);
  expect(
    await page.evaluate(() => (window as any).__syntheticMicrophoneRequests),
  ).toBe(0);
});

test("recording canvas moves accepted historical peaks left without changing their height", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install();
  await blockMicrophoneInput(page);
  await start(page, "linux", false, false, false, null);
  const selector =
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]';
  await page.evaluate(() => {
    Object.assign(window.testState, {
      status: "recording",
      recording_generation: 7,
      elapsed: 1,
      level: 0,
    });
    window.publishState();
    window.publishTelemetry({ generation: 7, elapsed: 1, level: 0.9 });
  });
  await page.clock.runFor(100);
  await page.evaluate(() => {
    window.publishTelemetry({ generation: 7, elapsed: 2, level: 0 });
  });
  await page.clock.runFor(100);
  const before = await waveformPixels(page, selector);
  expect(before.paintedPixels).toBeGreaterThan(0);
  await page.screenshot({
    path: resolve(recordingPolishScreenshots, "waveform-scroll-before.png"),
  });

  await page.clock.runFor(200);
  const after = await waveformPixels(page, selector);
  await page.screenshot({
    path: resolve(recordingPolishScreenshots, "waveform-scroll-after.png"),
  });
  expect(after.peakX).toBeLessThan(before.peakX);
  expect(
    Math.abs(after.peakDistance - before.peakDistance),
  ).toBeLessThanOrEqual(2);
  expect(after.cssWidth).toBeGreaterThan(0);
  expect(after.pixelRatio).toBeGreaterThanOrEqual(1);

  await page.setViewportSize({ width: 980, height: 740 });
  await page.evaluate(() => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    window.dispatchEvent(new Event("resize"));
  });
  await page.clock.runFor(100);
  const highDensity = await waveformPixels(page, selector);
  expect(highDensity.cssWidth).toBeGreaterThan(0);
  expect(highDensity.pixelRatio).toBeGreaterThanOrEqual(1.9);
  expect(highDensity.pixelRatio).toBeLessThanOrEqual(2.1);
  expect(highDensity.paintedPixels).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => (window as any).__syntheticMicrophoneRequests),
  ).toBe(0);
});

test("main and overlay waveforms share telemetry timing and level mapping", async ({
  page,
}) => {
  const overlayPage = await page.context().newPage();
  const fixedTime = new Date("2026-10-11T12:00:00.000Z");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await overlayPage.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: fixedTime });
  await page.clock.pauseAt(fixedTime);
  await blockMicrophoneInput(page);
  await blockMicrophoneInput(overlayPage);
  await page.setViewportSize({ width: 1280, height: 800 });
  await overlayPage.setViewportSize({ width: 476, height: 68 });
  await start(page, "linux", false, false, false, null);
  await start(overlayPage, "linux", true, false, false, null);

  const mainSelector =
    '.dictation-waveform canvas.live-waveform[data-waveform="main"]';
  const overlaySelector =
    '.audio-mark canvas.live-waveform[data-waveform="overlay"]';
  const publishPulse = async (target: Page, elapsed: number, level: number) => {
    await target.evaluate(
      ({ elapsed, level }) => {
        Object.assign(window.testState, {
          status: "recording",
          recording_generation: 41,
          elapsed,
          level: 0,
        });
        window.publishState();
        window.publishTelemetry({ generation: 41, elapsed, level });
      },
      { elapsed, level },
    );
  };
  const advanceContext = async (duration: number) => {
    await page.clock.runFor(duration);
  };
  const assertParity = async () => {
    const main = await waveformPixels(page, mainSelector);
    const overlay = await waveformPixels(overlayPage, overlaySelector);
    const normalizedHeight = (waveform: typeof main) => {
      const halfHeight = waveform.peakDistance / waveform.pixelRatio;
      return (2 * halfHeight - 4) / (waveform.cssHeight * 0.94 - 4);
    };
    expect(main.paintedPixels).toBeGreaterThan(0);
    expect(overlay.paintedPixels).toBeGreaterThan(0);
    expect(
      Math.abs(main.cssPeakRight - overlay.cssPeakRight),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(normalizedHeight(main) - normalizedHeight(overlay)),
    ).toBeLessThanOrEqual(0.12);
    return { main, overlay };
  };

  await publishPulse(page, 0, 0.86);
  await publishPulse(overlayPage, 0, 0.86);
  await advanceContext(200);
  await publishPulse(page, 1, 0.35);
  await publishPulse(overlayPage, 1, 0.35);
  await advanceContext(200);
  const at400ms = await assertParity();
  await publishPulse(page, 2, 0.35);
  await publishPulse(overlayPage, 2, 0.35);
  await advanceContext(200);
  const at600ms = await assertParity();

  const mainTravel = at600ms.main.cssPeakRight - at400ms.main.cssPeakRight;
  const overlayTravel =
    at600ms.overlay.cssPeakRight - at400ms.overlay.cssPeakRight;
  expect(mainTravel).toBeCloseTo(12.8, 0);
  expect(overlayTravel).toBeCloseTo(12.8, 0);
  expect(Math.abs(mainTravel - overlayTravel)).toBeLessThanOrEqual(2);
  expect(
    await page.evaluate(() => (window as any).__syntheticMicrophoneRequests),
  ).toBe(0);
  expect(
    await overlayPage.evaluate(
      () => (window as any).__syntheticMicrophoneRequests,
    ),
  ).toBe(0);
});

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: completed setup opens Recording and keeps transcript actions on the existing bridge`, async ({
    page,
  }) => {
    await start(page, platform, false, false, false, null);
    await expect(page.locator(".workspace-frame")).toBeVisible();
    await expect(page.locator("#app > aside")).toHaveCount(0);
    await expect(page.locator("aside#dictation-history")).toBeVisible();
    await expect(page.locator("main#dictation-content")).toBeVisible();
    await expect(page.locator("header.window-titlebar")).toBeVisible();
    await expect(page.locator("#open-settings")).toBeVisible();
    await page.locator("#open-settings").click();
    await expect(page.locator("dialog#settings-dialog")).toBeVisible();
    await expect(page.locator(".settings-dialog-nav [data-tab]")).toHaveText([
      "General",
      "Recording & shortcuts",
      "Text processing",
      "History",
      "About",
    ]);
    await closeSettings(page);
    await expect(page.locator("#dictation-timer")).toHaveText("0:00");
    await expect(
      page.locator("#open-model-drawer .model-pill-status"),
    ).toBeVisible();
    await expect(
      page.locator("#open-model-drawer .model-pill-chevron"),
    ).toBeVisible();
    await expect(page.locator(".dictation-feature-card")).toHaveCount(3);
    await expect(page.locator(".dictation-feature-heading strong")).toHaveText([
      "Recognition",
      "Vocabulary",
      "Snippets",
    ]);
    await expect(page.locator(".record-output-label")).toHaveText("Output");
    await expect(page.locator(".record-output [data-output]")).toHaveCount(
      platform === "macos" ? 3 : 2,
    );
    const insertOutput = page.locator('.record-output [data-output="paste"]');
    await insertOutput.click();
    await expect(insertOutput).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.output))
      .toBe("paste");
    await expect(page.locator(".dictation-history-title")).toContainText(
      "History",
    );
    await expect(page.locator(".dictation-history-count")).toHaveText(/^\d+$/);
    await expect(page.locator(".dictation-history-footer")).toBeVisible();
    await expect(page.locator("#copy-dictation")).toBeHidden();
    await expect(
      page.locator(".dictation-feature-description").first(),
    ).toContainText("Whisper Base");
    await page.evaluate(() => document.fonts.ready);
    const workspaceFonts = await page.evaluate(() => {
      const transcript = getComputedStyle(
        document.querySelector(
          ".dictation-transcript-body .transcript, .dictation-transcript-body .dictation-empty p",
        )!,
      );
      const timer = getComputedStyle(
        document.querySelector("#dictation-timer")!,
      );
      return {
        body: getComputedStyle(document.body).fontFamily,
        transcript: transcript.fontFamily,
        transcriptSize: transcript.fontSize,
        timer: timer.fontFamily,
        loadedFamilies: Array.from(document.fonts)
          .filter((font) => font.status === "loaded")
          .map((font) => font.family),
        loadedInstrumentSans: document.fonts.check(
          '14px "OpenWhisper Instrument Sans"',
        ),
        loadedNewsreader: document.fonts.check('22px "OpenWhisper Newsreader"'),
      };
    });
    expect(workspaceFonts.body).toContain("Instrument Sans");
    expect(workspaceFonts.transcript).toContain("Newsreader");
    expect(workspaceFonts.transcriptSize).toBe("22px");
    expect(workspaceFonts.timer).toContain("Instrument Sans");
    expect(workspaceFonts.loadedInstrumentSans).toBe(true);
    expect(workspaceFonts.loadedNewsreader).toBe(true);
    expect(workspaceFonts.loadedFamilies).toContain(
      "OpenWhisper Instrument Sans",
    );
    expect(workspaceFonts.loadedFamilies).toContain("OpenWhisper Newsreader");

    await selectSettingsTab(page, "general");
    for (const section of ["Recognition", "System"])
      await expect(
        page.locator("#content").getByRole("heading", { name: section }),
      ).toBeVisible();
    const systemStatusTypography = await page
      .locator("#content .settings-system-status")
      .evaluateAll((statuses) => {
        const bodyFont = getComputedStyle(document.body).fontFamily;
        return statuses
          .map((status) => ({
            fontFamily: getComputedStyle(status).fontFamily,
            classes: Array.from(status.classList),
          }))
          .map(({ fontFamily, classes }) => ({
            sameFont: fontFamily === bodyFont,
            neutral:
              !classes.includes("success") && !classes.includes("warning"),
          }));
      });
    expect(systemStatusTypography.length).toBeGreaterThan(0);
    expect(systemStatusTypography.every((status) => status.sameFont)).toBe(
      true,
    );
    expect(systemStatusTypography.every((status) => status.neutral)).toBe(true);
    await expect(
      page.getByText("Launch at login", { exact: true }),
    ).toBeVisible();
    await selectSettingsTab(page, "recording");
    await expect(page.locator("#settings-recording-primary")).toBeVisible();
    await expect(page.locator("#settings-recording-output")).toBeVisible();
    await expect(page.locator("#settings-recording-language")).toBeVisible();
    await expect(page.locator("#settings-recording-microphone")).toBeVisible();
    await expect(page.locator("#settings-recording-permissions")).toBeVisible();
    await expect(page.locator("#settings-recording-primary")).toContainText(
      "Push to talk",
    );
    await expect(page.locator("#settings-recording-microphone")).toContainText(
      platform === "macos" ? "Microphone access" : "Microphone",
    );
    await expect(
      page.locator("#settings-recording-output .settings-output-segment"),
    ).toBeVisible();
    await selectSettingsTab(page, "text");
    await expect(page.locator("#settings-vocabulary")).toBeVisible();
    await closeSettings(page);
    if (platform === "linux") {
      await page.evaluate(() => {
        Object.assign(window.testState, {
          cpu_device: "AMD Ryzen 7 5700G",
          gpu_device: "NVIDIA GeForce RTX 3060",
          gpu_available: true,
          gpu_checked: true,
          gpu_supported: true,
        });
        window.testState.preferences.gpu = true;
        window.publishState();
      });
      await expect(page.locator("#open-model-drawer")).toHaveAttribute(
        "title",
        "Vulkan GPU selected: NVIDIA GeForce RTX 3060",
      );
      await page.evaluate(() => {
        window.testState.preferences.gpu = false;
        window.publishState();
      });
      await expect(page.locator("#open-model-drawer")).toHaveAttribute(
        "title",
        "CPU selected; Vulkan GPU available: NVIDIA GeForce RTX 3060",
      );
    } else {
      await expect(page.locator("#open-model-drawer")).toHaveAttribute(
        "title",
        "Native speech engine",
      );
    }
    await expect(page.locator(".dictation-empty")).toContainText(
      "Press Record or the shortcut. Your text will appear here.",
    );
    await page.locator("#record").click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("toggle_recording");
    await page.evaluate(() => {
      window.testState.status = "recording";
      window.publishState();
    });
    await expect(insertOutput).toBeDisabled();

    await page.locator(".dictation-change-model").click();
    const modelDialog = page.locator("dialog#model-drawer");
    await expect(modelDialog).toBeVisible();
    await expect(
      modelDialog.getByRole("heading", {
        name: "Speech model for recording",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      modelDialog.locator(".model-drawer-body .model-row"),
    ).toHaveCount(
      catalog.filter((model: { family: string }) => model.family === "whisper")
        .length,
    );
    await expect(modelDialog.locator(".model-drawer-footer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modelDialog).toBeHidden();
    await expect(page.locator(".dictation-change-model")).toBeFocused();
    await page
      .locator(".dictation-feature-card")
      .filter({ hasText: "Recognition" })
      .click();
    await expect(page.locator("dialog#model-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      window.testState.status = "recording";
      window.publishState();
    });
    await expect(page.locator(".dictation-empty")).toContainText(
      "Press Record or the shortcut. Your text will appear here.",
    );

    const hostileTranscript =
      '<img src=x onerror="window.compromised=true"> final';
    await page.evaluate((transcript) => {
      Object.assign(window.testState, {
        status: "recording",
        transcript,
        elapsed: 73,
        level: 0.4,
        recording_generation: 9,
      });
      window.publishState();
    }, hostileTranscript);
    await expect(page.locator(".dictation-transcript .transcript")).toHaveText(
      hostileTranscript,
    );
    await expect(page.locator(".dictation-transcript img")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).compromised),
    ).toBeUndefined();
    await expect(page.locator("#dictation-timer")).toHaveText("1:13");
    const copy = page.locator("#copy-dictation");
    await copy.focus();
    await page.evaluate(() => {
      window.publishTelemetry({ generation: 9, elapsed: 74, level: 0.65 });
      window.publishTelemetry({ generation: 8, elapsed: 99, level: 1 });
    });
    await expect(page.locator("#dictation-timer")).toHaveText("1:14");
    const waveformSelector =
      '.dictation-waveform canvas.live-waveform[data-waveform="main"]';
    await expect(page.locator(waveformSelector)).toBeVisible();
    await expect
      .poll(
        async () =>
          (await waveformPixels(page, waveformSelector)).paintedPixels,
      )
      .toBeGreaterThan(0);
    expect(await copy.evaluate((button) => button.isConnected)).toBe(true);
    await expect(copy).toBeFocused();
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("copy_transcript");

    await page.evaluate(() => {
      window.testState.status = "transcribing";
      window.publishState();
    });
    await expect(page.locator("#record")).toBeDisabled();
    await expect(page.locator("#status-title")).toHaveText(
      "Finding your words",
    );
    await expect(copy).toBeFocused();
    await expect(page.locator(".dictation-transcript .transcript")).toHaveText(
      hostileTranscript,
    );
    await page.evaluate(() => {
      Object.assign(window.testState, {
        status: "recording",
        elapsed: 75,
        transcript: "Previous final transcript stays visible while recording.",
      });
      window.publishState();
    });
    await expect(page.locator(".dictation-transcript .transcript")).toHaveText(
      "Previous final transcript stays visible while recording.",
    );
    await page.locator("#cancel").click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("cancel_recording");
    await page.evaluate(() => {
      Object.assign(window.testState, {
        status: "error",
        recovery_available: true,
        message:
          "An unfinished recording is saved. Retry transcription or discard it.",
      });
      window.publishState();
    });
    await page.locator("#record").click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("retry_transcription");
    await page.locator("#cancel").click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("discard_recovery");

    const retainedTranscript = "Synthetic retained preview across generations.";
    await page.evaluate((transcript) => {
      Object.assign(window.testState, {
        status: "done",
        recovery_available: false,
        transcript,
        transcript_preview_omitted: false,
        recording_generation: 10,
        history: [transcript],
      });
      window.publishState();
    }, retainedTranscript);
    await expect(page.locator(".dictation-transcript .transcript")).toHaveText(
      retainedTranscript,
    );
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-workspace-restored-result.png`,
      ),
    });
    const callsBeforeDiscard = await page.evaluate(() => window.calls.length);
    await page.locator("#discard-result").click();
    await expect(page.locator(".dictation-transcript .transcript")).toHaveCount(
      0,
    );
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-discarded-preview.png`,
      ),
    });
    expect(await page.evaluate(() => window.calls.length)).toBe(
      callsBeforeDiscard,
    );
    await expect(
      page.locator(
        '#dictation-history .history-entry[data-history-select="0"]',
      ),
    ).toHaveText(retainedTranscript);

    for (const status of ["recording", "transcribing"] as const) {
      await page.evaluate(
        ({ transcript, status }) => {
          Object.assign(window.testState, {
            status,
            transcript,
            recording_generation: 11,
          });
          window.publishState();
        },
        { transcript: retainedTranscript, status },
      );
      await expect(
        page.locator(".dictation-transcript .transcript"),
      ).toHaveCount(0);
      await expect(page.locator("#copy-dictation")).toBeHidden();
    }
    await page.evaluate((transcript) => {
      Object.assign(window.testState, {
        status: "done",
        transcript,
        recording_generation: 11,
      });
      window.publishState();
    }, retainedTranscript);
    await expect(page.locator(".dictation-transcript .transcript")).toHaveText(
      retainedTranscript,
    );
    await page
      .locator('#dictation-history .history-entry[data-history-select="0"]')
      .click();
    await page.locator("#copy-dictation").click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)))
      .toEqual({ command: "copy_history", args: { index: 0 } });
    expect(await page.evaluate(() => window.testState.history)).toEqual([
      retainedTranscript,
    ]);

    await page.evaluate(() => {
      Object.assign(window.testState, {
        status: "idle",
        recovery_available: false,
        transcript: "",
        transcript_preview_omitted: true,
      });
      window.publishState();
    });
    await expect(page.locator("#copy-dictation")).toBeEnabled();
    await expect(
      page.locator(".dictation-transcript .transcript"),
    ).toContainText(
      "The complete transcript is available with Copy; its preview is too large.",
    );
    await page.locator("#copy-dictation").click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("copy_transcript");

    await page.evaluate(() => {
      window.testState.recording_available = false;
      window.testState.recording_unavailable_reason = "model";
      window.publishState();
    });
    await expect(page.locator("#status-title")).toHaveText("Choose a model");
    await page.evaluate(() => {
      window.testState.recovery_available = true;
      window.publishState();
    });
    await expect(page.locator("#status-title")).toHaveText(
      "Something needs attention",
    );
    await page.evaluate(() => {
      Object.assign(window.testState, {
        recovery_available: false,
        recording_available: false,
        recording_unavailable_reason: "model",
        transcript_preview_omitted: false,
        installed: [],
      });
      window.publishState();
    });
    await page.locator("#record-unavailable-action").click();
    await expect(page.locator("dialog#model-drawer")).toBeVisible();
    await expect(page.locator('[data-download="base"]')).toHaveText("Download");
    await page.keyboard.press("Escape");
  });

  test(`${platform}: Recording stays usable at minimum and large window sizes in English and German`, async ({
    page,
  }) => {
    await start(page, platform, false, false, false, null, false, true);
    await page.evaluate(() => {
      window.testState.profile = "development";
      window.testState.development_build = "reference-test";
      window.testState.preferences.auto_check_updates = false;
      window.publishState();
    });
    await expect(page.locator("#header-update")).toBeHidden();
    const longTranscript = "Synthetic long transcript. ".repeat(900);
    await page.evaluate((transcript) => {
      Object.assign(window.testState, {
        status: "error",
        transcript,
        transcript_preview_omitted: false,
        recovery_available: true,
        recording_available: false,
        recording_unavailable_reason: "audio",
        message:
          "An unfinished recording is saved. Retry transcription or discard it.",
      });
      window.publishState();
    }, longTranscript);
    for (const language of ["en", "de"] as const) {
      if (language === "de") {
        await setWorkspaceLanguage(page, "de");
      }
      for (const viewport of [
        { width: 740, height: 560 },
        { width: 980, height: 740 },
        { width: 1280, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        if (language === "de" && viewport.width === 740) {
          await expect(page.locator(".window-dev-badge")).toHaveText("Dev");
          const windowActionsRight = await page
            .locator(".window-actions")
            .evaluate((element) => element.getBoundingClientRect().right);
          expect(
            windowActionsRight,
            JSON.stringify({
              platform,
              language,
              viewport,
              windowActionsRight,
            }),
          ).toBeLessThanOrEqual(viewport.width);
        }
        if (language === "en")
          await page.screenshot({
            path: `test-results/${platform}-dictation-${viewport.width}x${viewport.height}.png`,
          });
        await expect(page.locator("#copy-dictation")).toBeInViewport();
        await expect(page.locator("#record")).toBeInViewport();
        await expect(page.locator("#cancel")).toBeInViewport();
        await expect(page.locator(".record-output")).toBeVisible();
        await expect(page.locator(".record-output [data-output]")).toHaveCount(
          platform === "macos" ? 3 : 2,
        );
        for (const output of await page
          .locator(".record-output [data-output]")
          .all())
          await expect(output).toBeInViewport();
        await expect(page.locator("#record-label")).toBeInViewport();
        await expect(page.locator("main#dictation-content")).toBeVisible();
        expect(
          await page
            .locator("main")
            .evaluate((main) => main.scrollWidth <= main.clientWidth),
        ).toBe(true);
        const geometry = await page.evaluate(() => {
          const transcript = document
            .querySelector(".dictation-transcript")!
            .getBoundingClientRect();
          const body = document
            .querySelector(".dictation-transcript-body")!
            .getBoundingClientRect();
          const record = document
            .querySelector("#record-control")!
            .getBoundingClientRect();
          const recordButton = document
            .querySelector("#record")!
            .getBoundingClientRect();
          const cancelButton = document
            .querySelector("#cancel")!
            .getBoundingClientRect();
          const output = document
            .querySelector(".record-output")!
            .getBoundingClientRect();
          const recordLabel = document
            .querySelector("#record-label")!
            .getBoundingClientRect();
          const featureCards = document
            .querySelector(".dictation-feature-cards")!
            .getBoundingClientRect();
          const transcriptBody = document.querySelector(
            ".dictation-transcript-body",
          )!;
          return {
            transcriptBottom: transcript.bottom,
            featureCardsBottom: featureCards.bottom,
            recordTop: record.top,
            bodyScrolls:
              transcriptBody.scrollHeight > transcriptBody.clientHeight,
            bodyBottom: body.bottom,
            recordBottom: record.bottom,
            recordLabelTop: recordLabel.top,
            recordLabelBottom: recordLabel.bottom,
            recordLabelLeft: recordLabel.left,
            recordLabelRight: recordLabel.right,
            recordCenterOffset: Math.abs(
              recordButton.left +
                recordButton.width / 2 -
                (record.left + record.width / 2),
            ),
            recordAspect: recordButton.width / recordButton.height,
            cancelLeftOfRecord: cancelButton.right <= recordButton.left,
            outputLeft: output.left,
            recordButtonRight: recordButton.right,
            outputRightOfRecord: output.left >= recordButton.right,
          };
        });
        expect(geometry.transcriptBottom).toBeLessThanOrEqual(
          geometry.recordTop + 1,
        );
        expect(geometry.bodyScrolls).toBe(true);
        expect(
          geometry.bodyBottom,
          JSON.stringify({ language, viewport, ...geometry }),
        ).toBeLessThanOrEqual(geometry.transcriptBottom + 1);
        expect(geometry.recordBottom).toBeLessThanOrEqual(viewport.height);
        expect(geometry.recordLabelTop).toBeGreaterThanOrEqual(
          geometry.featureCardsBottom - 1,
        );
        expect(geometry.recordLabelBottom).toBeLessThanOrEqual(viewport.height);
        expect(geometry.recordLabelLeft).toBeGreaterThanOrEqual(0);
        expect(geometry.recordLabelRight).toBeLessThanOrEqual(viewport.width);
        expect(geometry.recordCenterOffset).toBeLessThanOrEqual(2);
        expect(geometry.recordAspect).toBeGreaterThanOrEqual(0.85);
        expect(geometry.recordAspect).toBeLessThanOrEqual(1.15);
        expect(geometry.cancelLeftOfRecord).toBe(true);
        expect(
          geometry.outputRightOfRecord,
          JSON.stringify({ platform, language, viewport, ...geometry }),
        ).toBe(true);
        await expect(page.locator(".dictation-transcript-body")).toContainText(
          "Synthetic long transcript.",
        );
      }
      if (language === "en") {
        await page.setViewportSize({ width: 740, height: 560 });
        await page.evaluate(() => {
          const notice = document.querySelector<HTMLElement>("#notice")!;
          notice.textContent =
            "Synthetic command error notice for layout coverage.";
          notice.hidden = false;
        });
        await expect(page.locator("#notice")).toBeVisible();
        const geometry = await page.evaluate(() => {
          const transcript = document
            .querySelector(".dictation-transcript")!
            .getBoundingClientRect();
          const record = document
            .querySelector("#record-control")!
            .getBoundingClientRect();
          const main = document.querySelector("main")!;
          return {
            transcriptBottom: transcript.bottom,
            bodyBottom: document
              .querySelector(".dictation-transcript-body")!
              .getBoundingClientRect().bottom,
            recordTop: record.top,
            mainScrollWidth: main.scrollWidth,
            mainClientWidth: main.clientWidth,
          };
        });
        expect(geometry.transcriptBottom).toBeLessThanOrEqual(
          geometry.recordTop + 1,
        );
        expect(geometry.bodyBottom).toBeLessThanOrEqual(
          geometry.transcriptBottom + 1,
        );
        expect(geometry.mainScrollWidth).toBeLessThanOrEqual(
          geometry.mainClientWidth,
        );
        await expect(page.locator("#copy-dictation")).toBeInViewport();
        await expect(page.locator("#record")).toBeInViewport();
        await expect(page.locator("#cancel")).toBeInViewport();
        await page.evaluate(() => {
          document.querySelector<HTMLElement>("#notice")!.hidden = true;
        });
      }
    }
  });
}

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: floating recorder keeps the waveform and timer visible at narrow and reference widths`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 340, height: 64 });
    await blockMicrophoneInput(page);
    await start(page, platform, true, true);
    await expect(page.locator("aside")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => window.testState.preferences.setup_completed),
      )
      .toBe(false);
    let generation = 10;
    const overlayCanvasSelector =
      '.audio-mark canvas.live-waveform[data-waveform="overlay"]';
    for (const language of ["en", "de"] as const) {
      for (const elapsed of [14, 126, 36_617]) {
        const currentGeneration = generation++;
        await page.evaluate(
          ({ language, elapsed, currentGeneration }) => {
            Object.assign(window.testState, {
              status: "recording",
              elapsed,
              level: 0.5,
              recording_generation: currentGeneration,
            });
            window.testState.preferences.ui_language = language;
            window.publishState();
            window.publishTelemetry({
              generation: currentGeneration,
              elapsed,
              level: 0.55,
            });
          },
          { language, elapsed, currentGeneration },
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
        await expect(page.locator("#record-label")).toHaveText(time);
        await expect(page.locator(".record-copy")).toBeHidden();
        await expect(page.locator("#record-unavailable-action")).toBeHidden();
        await expect(page.locator("#record")).toBeInViewport();
        await expect(page.locator("#cancel")).toBeInViewport();
        const waveform = page.locator(overlayCanvasSelector);
        await expect(waveform).toBeVisible();
        await page.locator("#record").focus();
        await expect
          .poll(
            async () =>
              (await waveformPixels(page, overlayCanvasSelector)).paintedPixels,
          )
          .toBeGreaterThan(0);
        const geometry = await page
          .locator("#record-control")
          .evaluate((control) => {
            const actions = control.querySelector(".record-actions")!;
            const actionsRect = actions.getBoundingClientRect();
            const canvas = control.querySelector<HTMLCanvasElement>(
              'canvas.live-waveform[data-waveform="overlay"]',
            )!;
            const originalPointerEvents = canvas.style.pointerEvents;
            canvas.style.pointerEvents = "auto";
            const waveformRect = canvas.getBoundingClientRect();
            const waveformHit = document.elementFromPoint(
              waveformRect.left + waveformRect.width / 2,
              waveformRect.top + waveformRect.height / 2,
            );
            const context = canvas.getContext("2d")!;
            const pixels = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            let paintedPixels = 0;
            for (let index = 3; index < pixels.length; index += 4)
              if (pixels[index]! > 16) paintedPixels++;
            canvas.style.pointerEvents = originalPointerEvents;
            const label = control.querySelector("#record-label")!;
            const text = label.getBoundingClientRect();
            const record = control
              .querySelector("#record")!
              .getBoundingClientRect();
            const cancel = control
              .querySelector("#cancel")!
              .getBoundingClientRect();
            return {
              capsule: {
                left: actionsRect.left,
                right: actionsRect.right,
                top: actionsRect.top,
                bottom: actionsRect.bottom,
              },
              waveform: {
                left: waveformRect.left,
                right: waveformRect.right,
                top: waveformRect.top,
                bottom: waveformRect.bottom,
                width: waveformRect.width,
                height: waveformRect.height,
                visible:
                  getComputedStyle(canvas).visibility === "visible" &&
                  getComputedStyle(canvas).display !== "none",
                paintedPixels,
                unobscured: waveformHit === canvas,
                inside:
                  waveformRect.left >= actionsRect.left &&
                  waveformRect.right <= actionsRect.right &&
                  waveformRect.top >= actionsRect.top &&
                  waveformRect.bottom <= actionsRect.bottom,
              },
              textStart: text.left,
              textEnd: text.right,
              cancelLeft: cancel.left,
              cancelRight: cancel.right,
              recordLeft: record.left,
              recordRight: record.right,
              stopRightInset: actionsRect.right - record.right,
              textFits: label.scrollWidth <= label.clientWidth,
            };
          });
        await page.screenshot({
          path: `test-results/${platform}-${language}-recording-overlay.png`,
          omitBackground: true,
        });
        await page.screenshot({
          path: resolve(
            recordingPolishScreenshots,
            `${platform}-${language}-overlay-canvas-340.png`,
          ),
          omitBackground: true,
        });
        expect(geometry.waveform.width).toBeGreaterThan(0);
        expect(geometry.waveform.height).toBeGreaterThan(0);
        expect(geometry.waveform.inside).toBe(true);
        expect(geometry.waveform.visible).toBe(true);
        expect(geometry.waveform.paintedPixels).toBeGreaterThan(0);
        expect(geometry.waveform.unobscured).toBe(true);
        expect(geometry.waveform.right).toBeLessThanOrEqual(geometry.textStart);
        expect(geometry.textEnd).toBeLessThanOrEqual(geometry.cancelLeft);
        expect(geometry.cancelRight).toBeLessThanOrEqual(geometry.recordLeft);
        expect(geometry.stopRightInset).toBeGreaterThanOrEqual(8);
        expect(geometry.stopRightInset).toBeLessThanOrEqual(10);
        expect(geometry.textFits).toBe(true);
        await expect(page.locator("#record")).toBeFocused();
      }
    }
    await page.setViewportSize({ width: 476, height: 68 });
    await page.evaluate(() => {
      window.publishTelemetry({
        generation: window.testState.recording_generation,
        elapsed: window.testState.elapsed + 1,
        level: 0.75,
      });
    });
    const referenceCapsule = await page.evaluate(() => {
      const capsule = document
        .querySelector(".record-actions")!
        .getBoundingClientRect();
      const canvas = document.querySelector<HTMLCanvasElement>(
        'canvas.live-waveform[data-waveform="overlay"]',
      )!;
      const originalPointerEvents = canvas.style.pointerEvents;
      canvas.style.pointerEvents = "auto";
      const waveform = canvas.getBoundingClientRect();
      const hit = document.elementFromPoint(
        waveform.left + waveform.width / 2,
        waveform.top + waveform.height / 2,
      );
      canvas.style.pointerEvents = originalPointerEvents;
      const stop = document.querySelector("#record")!.getBoundingClientRect();
      return {
        capsuleWidth: capsule.width,
        capsuleHeight: capsule.height,
        stopRightInset: capsule.right - stop.right,
        waveform: {
          width: waveform.width,
          height: waveform.height,
          inside:
            waveform.left >= capsule.left &&
            waveform.right <= capsule.right &&
            waveform.top >= capsule.top &&
            waveform.bottom <= capsule.bottom,
          hit: hit === canvas,
        },
      };
    });
    expect(referenceCapsule.capsuleWidth).toBeCloseTo(460, 0);
    expect(referenceCapsule.capsuleHeight).toBeCloseTo(52, 0);
    expect(referenceCapsule.stopRightInset).toBeGreaterThanOrEqual(8);
    expect(referenceCapsule.stopRightInset).toBeLessThanOrEqual(10);
    expect(referenceCapsule.waveform.width).toBeGreaterThan(0);
    expect(referenceCapsule.waveform.height).toBeGreaterThan(0);
    expect(referenceCapsule.waveform.inside).toBe(true);
    expect(referenceCapsule.waveform.hit).toBe(true);
    await page.screenshot({
      path: `test-results/${platform}-recording-overlay-reference-width.png`,
      omitBackground: true,
    });
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-overlay-canvas-reference-width.png`,
      ),
      omitBackground: true,
    });
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

  test(`${platform}: model chooser patches progress, cancels downloads, and exposes management actions`, async ({
    page,
  }) => {
    await start(page, platform, false, false, false, null);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(".dictation-change-model").click();
    const dialog = page.locator("dialog#model-drawer");
    const body = page.locator("#model-drawer .model-drawer-body");
    await expect(dialog).toBeVisible();
    const drawerGeometry = await page.evaluate(() => {
      const drawer = document
        .querySelector("#model-drawer")!
        .getBoundingClientRect();
      const titlebar = document
        .querySelector(".window-titlebar")!
        .getBoundingClientRect();
      return {
        left: drawer.left,
        right: drawer.right,
        top: drawer.top,
        bottom: drawer.bottom,
        titlebarBottom: titlebar.bottom,
      };
    });
    expect(drawerGeometry.left).toBeGreaterThanOrEqual(760);
    expect(drawerGeometry.right).toBeLessThanOrEqual(1280);
    expect(drawerGeometry.right - drawerGeometry.left).toBeGreaterThanOrEqual(
      430,
    );
    expect(drawerGeometry.right - drawerGeometry.left).toBeLessThanOrEqual(500);
    expect(drawerGeometry.top).toBeGreaterThanOrEqual(
      drawerGeometry.titlebarBottom,
    );
    expect(drawerGeometry.bottom).toBeLessThanOrEqual(800);
    await page.screenshot({
      path: `test-results/${platform}-model-drawer.png`,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.setViewportSize({ width: 740, height: 560 });
    await page.locator(".dictation-change-model").click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveJSProperty("open", true);
    await expect(page.locator("#close-model-drawer")).toBeFocused();
    const whisperModels = catalog.filter(
      (model: { family: string }) => model.family === "whisper",
    );
    const parakeetModels = catalog.filter(
      (model: { family: string }) => model.family === "parakeet",
    );
    await expect(body.locator(".model-row")).toHaveCount(whisperModels.length);
    const firstModel = body.locator(".model-row").first();
    await expect(firstModel.locator(".model-title-row strong")).toBeVisible();
    await expect(firstModel.locator(".model-size")).toBeVisible();
    const whisperTab = dialog.locator('[data-drawer-family="whisper"]');
    const parakeetTab = dialog.locator('[data-drawer-family="parakeet"]');
    await expect(whisperTab).toHaveAttribute("aria-pressed", "true");
    await parakeetTab.click();
    await expect(body.locator(".model-row")).toHaveCount(parakeetModels.length);
    await expect(
      body.locator('[data-model-id="parakeet-v3-q8"]'),
    ).toBeVisible();
    await whisperTab.click();
    await expect(body.locator(".model-row")).toHaveCount(whisperModels.length);
    expect(
      await body.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    ).toBeGreaterThan(0);
    await expect(
      page.locator("#model-drawer .model-drawer-footer"),
    ).toBeInViewport();
    await expect(
      page.locator("#model-drawer .model-drawer-body"),
    ).toBeVisible();
    await page.locator("#close-model-drawer").click();
    await expect(dialog).toBeHidden();
    await expect(body.locator(".model-row")).toHaveCount(0);
    await setWorkspaceLanguage(page, "de");
    await page.locator(".dictation-change-model").click();
    await expect(
      dialog.getByRole("heading", {
        name: "Sprachmodell für die Aufnahme",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#close-model-drawer")).toBeFocused();
    for (const viewport of [
      { width: 740, height: 560 },
      { width: 980, height: 740 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(dialog).toBeVisible();
      await expect(
        page.locator("#model-drawer .model-drawer-footer"),
      ).toBeInViewport();
    }
    await page.setViewportSize({ width: 740, height: 560 });

    for (let index = 0; index < 12; index++) await page.keyboard.press("Tab");
    const focusedAfterTab = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return {
        inside: !!document.querySelector("#model-drawer")?.contains(active),
        open: document.querySelector<HTMLDialogElement>("#model-drawer")?.open,
        modal: document.querySelector("#model-drawer")?.matches(":modal"),
        tag: active?.tagName,
        id: active?.id,
        label: active?.getAttribute("aria-label"),
        text: active?.textContent?.trim().slice(0, 60),
      };
    });
    expect(focusedAfterTab.inside, JSON.stringify(focusedAfterTab)).toBe(true);

    await page.evaluate(() => {
      window.testState.installed = ["base", "tiny"];
      (window as any).rejectSave = true;
      window.publishState();
    });
    const tinyRow = page
      .locator("#model-drawer .model-row")
      .filter({ has: page.locator('[data-select="tiny"]') });
    const useTiny = tinyRow.locator(
      'button[data-select="tiny"]:not(.model-radio)',
    );
    await useTiny.click();
    await expect(page.locator("#model-drawer-notice")).toBeVisible();
    await expect(page.locator("#model-drawer-notice")).toContainText(
      "Could not save settings",
    );
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.testState.preferences.model)).toBe(
      "base",
    );
    await page.evaluate(() => {
      (window as any).rejectSave = false;
    });
    await useTiny.click();
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.model))
      .toBe("tiny");
    await expect(dialog).toBeVisible();
    const selectionFocus = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return {
        inside: !!document.querySelector("#model-drawer")?.contains(active),
        tag: active?.tagName,
        id: active?.id,
        label: active?.getAttribute("aria-label"),
        text: active?.textContent?.trim().slice(0, 60),
      };
    });
    expect(
      selectionFocus,
      JSON.stringify(selectionFocus).slice(0, 300),
    ).toMatchObject({
      inside: true,
    });

    await page.locator('[data-download="small"]').click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("download_model");
    const cancel = page.locator("#model-drawer [data-cancel-download]");
    await expect(cancel).toBeVisible();
    await cancel.focus();
    const cancelElement = await cancel.elementHandle();
    const progress = page.locator("#model-drawer progress");
    await page.evaluate(() => {
      window.testState.progress = 0.37;
      window.publishState();
    });
    await expect(progress).toHaveJSProperty("value", 0.37);
    await expect(dialog).toBeVisible();
    await expect(cancel).toBeFocused();
    expect(
      await cancelElement?.evaluate((element) => element.isConnected),
    ).toBe(true);
    await parakeetTab.click();
    await expect(body.locator(".model-row")).toHaveCount(parakeetModels.length);
    await whisperTab.click();
    await expect(progress).toHaveJSProperty("value", 0.37);
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("cancel_download");

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".dictation-change-model")).toBeFocused();
    await page.locator(".dictation-change-model").click();
    await page.evaluate(() => {
      window.testState.transcript =
        "Background changed while the chooser was open.";
      window.publishState();
    });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".dictation-change-model")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".dictation-change-model")).toBeFocused();
    await setWorkspaceLanguage(page, "en");
    await page.locator(".dictation-change-model").click();
    await expect(
      page.locator('#model-drawer [data-model-command="show_models_folder"]'),
    ).toBeVisible();
    await page
      .locator('#model-drawer [data-model-command="show_models_folder"]')
      .click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("show_models_folder");
    if (platform === "macos") {
      await expect(
        page.locator('#model-drawer [data-delete="base"]'),
      ).toBeVisible();
      await expect(
        page.locator('#model-drawer [data-model-command="import_model"]'),
      ).toBeVisible();
      await page
        .locator('#model-drawer [data-model-command="import_model"]')
        .click();
      await expect
        .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
        .toBe("import_model");
      await page.locator('#model-drawer [data-delete="base"]').click();
      await expect
        .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
        .toBe("delete_model");
    } else {
      await expect(
        page.locator('#model-drawer [data-model-command="import_model"]'),
      ).toHaveCount(0);
      await expect(page.locator("#model-drawer [data-delete]")).toHaveCount(0);
    }
  });

  test(`${platform}: History rail copies full text and clears only history through host commands`, async ({
    page,
  }) => {
    await start(page, platform, false, false, false, null);
    const longEntry = `Synthetic history entry <img src=x onerror="window.historyCompromised=true"><script>window.historyCompromised=true</script> ${"long text ".repeat(900)}`;
    const entries = Array.from(
      { length: 14 },
      (_, index) => `History entry ${index}`,
    );
    entries[1] = longEntry;
    await page.evaluate((longEntry) => {
      window.testState.history = Array.from(
        { length: 14 },
        (_, index) => `History entry ${index}`,
      );
      window.testState.history[1] = longEntry;
      window.testState.transcript = longEntry;
      window.testState.transcript_preview_omitted = false;
      window.publishState();
    }, longEntry);
    const toggle = page.locator("#toggle-history");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toHaveAttribute(
      "aria-controls",
      "dictation-history-list",
    );
    const history = page.locator(".dictation-history#dictation-history");
    const rail = page.locator("aside#dictation-history");
    await expect(rail).toBeVisible();
    for (const language of ["en", "de"] as const) {
      if (language === "de") {
        await setWorkspaceLanguage(page, "de");
      }
      for (const viewport of [
        { width: 740, height: 560 },
        { width: 980, height: 740 },
        { width: 1280, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await expect(rail).toBeVisible();
        await expect(history.locator("#dictation-history-list")).toBeHidden();
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(history).toBeVisible();
        const historyEntries = history.locator(
          ".history-entry[data-history-select]",
        );
        await expect(historyEntries).toHaveCount(entries.length);
        await expect(historyEntries.nth(1)).toHaveText(longEntry);
        const historyBytes = entries.reduce(
          (total, entry) => total + new TextEncoder().encode(entry).byteLength,
          0,
        );
        const byteDisplay =
          historyBytes < 1024
            ? `${historyBytes} B`
            : `${new Intl.NumberFormat(language === "en" ? "en-US" : "de-DE", {
                maximumFractionDigits: 1,
              }).format(historyBytes / 1024)} KB`;
        await openSettings(page);
        await selectSettingsTab(page, "history");
        await expect(page.locator(".history-storage-stats")).toContainText(
          byteDisplay,
        );
        await expect(page.locator(".history-storage-stats")).toContainText(
          language === "en" ? "14 recordings" : "14 Aufnahmen",
        );
        await expect(page.locator(".history-storage-stats")).toHaveAttribute(
          "title",
          language === "en"
            ? "Separate transcript files are not included."
            : "Separate Transkriptdateien sind nicht enthalten.",
        );
        await closeSettings(page);
        const longTextGeometry = await historyEntries
          .nth(1)
          .locator(".history-entry-text")
          .evaluate((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              lineClamp: Number.parseInt(
                style.getPropertyValue("-webkit-line-clamp"),
                10,
              ),
              lineHeight: Number.parseFloat(style.lineHeight),
              height: rect.height,
            };
          });
        expect(longTextGeometry.lineClamp).toBe(2);
        expect(longTextGeometry.height).toBeLessThanOrEqual(
          longTextGeometry.lineHeight * 2 + 1,
        );
        expect(
          await page.evaluate(() => (window as any).historyCompromised),
        ).toBe(undefined);
        await expect(history.locator("time")).toHaveCount(0);
        await expect(history.locator("[data-copy]")).toHaveCount(0);
        const clearRailHistory = rail.locator("[data-clear-history]");
        await expect(page.locator("#copy-dictation")).toBeVisible();
        await expect(page.locator("#record")).toBeInViewport();
        const transcriptGeometry = await page.evaluate(() => {
          const card = document.querySelector(".dictation-transcript")!;
          const header = card.querySelector(".dictation-transcript-heading")!;
          const body = card.querySelector(".dictation-transcript-body")!;
          const copy = card.querySelector("#copy-dictation")!;
          const cardRect = card.getBoundingClientRect();
          const copyRect = copy.getBoundingClientRect();
          const rail = document
            .querySelector("aside#dictation-history")!
            .getBoundingClientRect();
          const main = document
            .querySelector("main#dictation-content")!
            .getBoundingClientRect();
          return {
            copyInsideCard:
              copyRect.left >= cardRect.left &&
              copyRect.right <= cardRect.right,
            headerBeforeBody:
              header.getBoundingClientRect().bottom <=
              body.getBoundingClientRect().bottom,
            railAfterCanvas: rail.left >= main.right - 1,
            railInsideViewport: rail.right <= window.innerWidth + 1,
          };
        });
        expect(transcriptGeometry.copyInsideCard).toBe(true);
        expect(transcriptGeometry.headerBeforeBody).toBe(true);
        expect(transcriptGeometry.railAfterCanvas).toBe(true);
        expect(transcriptGeometry.railInsideViewport).toBe(true);
        const selectedHistoryEntry = history.locator(
          '.history-entry[aria-pressed="true"]',
        );
        if (await selectedHistoryEntry.count())
          await selectedHistoryEntry.click();
        await page.locator("#copy-dictation").click();
        await expect
          .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
          .toBe("copy_transcript");
        if (viewport.width === 740) {
          await page.screenshot({
            path: `test-results/${platform}-history-${language}.png`,
          });
          await historyEntries.nth(1).click();
          await expect(
            page.locator(".dictation-transcript-body .transcript"),
          ).toHaveText(longEntry);
          await page.locator("#copy-dictation").click();
          await expect
            .poll(() => page.evaluate(() => window.calls.at(-1)))
            .toEqual({ command: "copy_history", args: { index: 1 } });
        }
        await historyEntries.nth(13).scrollIntoViewIfNeeded();
        await expect(historyEntries.nth(13)).toBeInViewport();
        await historyEntries.nth(13).click();
        await expect(
          page.locator(".dictation-transcript-body .transcript"),
        ).toHaveText("History entry 13");
        await page.locator("#copy-dictation").click();
        await expect
          .poll(() => page.evaluate(() => window.calls.at(-1)))
          .toEqual({ command: "copy_history", args: { index: 13 } });
        expect(
          await page.evaluate(() => {
            const main = document.querySelector("main")!;
            return main.scrollWidth <= main.clientWidth;
          }),
        ).toBe(true);
      }
    }
    const clearRailHistory = rail.locator("[data-clear-history]");
    await clearRailHistory.scrollIntoViewIfNeeded();
    await expect(clearRailHistory).toBeInViewport();
    await clearRailHistory.click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("clear_history");
    await expect(history.locator(".history-row")).toHaveCount(0);
    await expect(history).toContainText("Noch keine Aufnahmen im Verlauf.");
    await expect(page.locator(".dictation-transcript .transcript")).toHaveText(
      longEntry,
    );
    await expect(page.locator("#copy-dictation")).toBeVisible();
    await openSettings(page);
    await selectSettingsTab(page, "history");
    await expect(page.locator(".history-storage-stats")).toContainText("0");
    await expect(page.locator("#clear-history")).toBeDisabled();
    await expect(page.locator(".history-storage-stats")).toContainText(
      /0 (recordings|Aufnahmen)/u,
    );
  });

  test(`${platform}: Text processing adds structured vocabulary entries and saves them automatically`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.setViewportSize({ width: 1280, height: 800 });
    const trustedUrl = page.url();
    await page.screenshot({ path: `test-results/${platform}-settings.png` });
    const textTab = page.locator('.settings-dialog-nav [data-tab="text"]');
    await textTab.focus();
    await page.keyboard.press("Enter");
    await expect(textTab).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#settings-vocabulary")).toBeVisible();
    const spelling = page.locator("#new-vocabulary-spelling");
    const misheard = page.locator("#new-vocabulary-misheard");
    await spelling.scrollIntoViewIfNeeded();
    await spelling.focus();
    await expect(spelling).toBeFocused();
    await expect(spelling).toBeInViewport();
    await spelling.fill("OpenWhisper");
    await misheard.fill("Open Whispur, OpenWhisper");
    await page.locator("#vocabulary-add-form").press("Enter");
    await expect(page.locator("#vocabulary-save-status")).toHaveText("Saved");
    const expectedVocabulary = [
      { spelling: "OpenWhisper", misheard: ["Open Whispur", "OpenWhisper"] },
    ];
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)))
      .toEqual({
        command: "save_preferences",
        args: { changes: { vocabulary: expectedVocabulary } },
      });
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual(expectedVocabulary);
    await selectSettingsTab(page, "history");
    await selectSettingsTab(page, "text");
    await expect(
      page.locator("[data-vocabulary-spelling]").first(),
    ).toHaveValue("OpenWhisper");
    await expect(page.locator(".vocabulary-chip")).toHaveCount(2);
    expect(page.url()).toBe(trustedUrl);
  });

  test(`${platform}: vocabulary rejects a correction already assigned to another spelling`, async ({
    page,
  }) => {
    await start(page, platform);
    await selectSettingsTab(page, "text");
    const spelling = page.locator("#new-vocabulary-spelling");
    const misheard = page.locator("#new-vocabulary-misheard");
    await spelling.fill("OpenWhisper");
    await misheard.fill("Open-Whispur");
    await page.locator("#vocabulary-add-form").press("Enter");
    const saved = [{ spelling: "OpenWhisper", misheard: ["Open-Whispur"] }];
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual(saved);

    await spelling.fill("Another spelling");
    await misheard.fill("open whispur");
    await page.locator("#vocabulary-add-form").press("Enter");
    await expect(page.locator("#vocabulary-save-status")).toHaveText(
      "A misheard form can belong to only one spelling.",
    );
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual(saved);
  });

  test(`${platform}: selected live transcript text can be saved as a vocabulary correction`, async ({
    page,
  }) => {
    await start(page, platform, false, false, false, null);
    await page.evaluate(() => {
      window.testState.transcript = "I use Open Whispur every day.";
      window.publishState();
    });
    const transcript = page.locator(".dictation-transcript-body .transcript");
    await expect(transcript).toHaveText("I use Open Whispur every day.");
    await transcript.evaluate((element) => {
      const text = element.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE)
        throw new Error("Synthetic transcript text is missing.");
      const start = text.textContent!.indexOf("Open Whispur");
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + "Open Whispur".length);
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 90,
          clientY: 90,
        }),
      );
    });
    await page.getByRole("menuitem", { name: "Add to vocabulary" }).click();
    const dialog = page.locator("#vocabulary-correction-dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("#corrected-vocabulary-spelling").fill("OpenWhisper");
    await dialog.getByRole("button", { name: "Add correction" }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual([{ spelling: "OpenWhisper", misheard: ["Open Whispur"] }]);
  });

  test(`${platform}: signed-file-compatible bundle, shared navigation and branding`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await start(page, platform);
    await closeSettings(page);
    await expect(page.locator("[data-window-action]")).toHaveCount(3);
    for (const action of ["minimize", "maximize", "close"] as const) {
      await page.locator(`[data-window-action="${action}"]`).click();
      await expect
        .poll(() => page.evaluate(() => window.calls.at(-1)))
        .toEqual({ command: "window_action", args: { action } });
    }
    await openSettings(page);
    await expect(page.locator(".settings-dialog-nav button")).toHaveText([
      "General",
      "Recording & shortcuts",
      "Text processing",
      "History",
      "About",
    ]);
    await selectSettingsTab(page, "about");
    await expect(page.locator("#page-title")).toHaveText("About");
    await expect(page.locator("#content .about-copy > p")).toContainText(
      "Local speech recognition",
    );
    const aboutIcon = page.locator(".about-brand img");
    await expect(aboutIcon).toHaveAttribute(
      "src",
      "./branding/icon-bordered.svg",
    );
    await expect
      .poll(() =>
        aboutIcon.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(512);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() =>
        Array.from(document.fonts).some(
          (font) =>
            font.family === "OpenWhisper Instrument Sans" &&
            font.status === "loaded",
        ),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `test-results/${platform}-about.png` });
  });

  test(`${platform}: vocabulary autosaves edits and merges duplicates while snippet drafts stay independent`, async ({
    page,
  }) => {
    await start(page, platform);
    await selectSettingsTab(page, "text");
    const newSpelling = page.locator("#new-vocabulary-spelling");
    const newMisheard = page.locator("#new-vocabulary-misheard");
    const trigger = page.getByRole("textbox", {
      name: "When I say",
      exact: true,
    });
    const expansion = page.getByRole("textbox", {
      name: "Insert",
      exact: true,
    });
    await newSpelling.fill("WhisperFree");
    await newMisheard.fill("Whisper Free");
    await page.locator("#vocabulary-add-form").press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual([{ spelling: "WhisperFree", misheard: ["Whisper Free"] }]);
    await newSpelling.fill("whisperfree");
    await newMisheard.fill("Whisper-Free");
    await page.locator("#vocabulary-add-form").press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual([
        { spelling: "WhisperFree", misheard: ["Whisper Free", "Whisper-Free"] },
      ]);
    await newSpelling.fill("Another term");
    await newMisheard.fill("Another recognized form");
    await page.locator("#vocabulary-add-form").press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual([
        { spelling: "WhisperFree", misheard: ["Whisper Free", "Whisper-Free"] },
        { spelling: "Another term", misheard: ["Another recognized form"] },
      ]);
    const duplicateSpelling = page.locator("[data-vocabulary-spelling]").nth(1);
    await duplicateSpelling.fill("whisperfree");
    await duplicateSpelling.press("Tab");
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual([
        {
          spelling: "WhisperFree",
          misheard: ["Whisper Free", "Whisper-Free", "Another recognized form"],
        },
      ]);
    await page
      .getByRole("button", { name: "Remove correction Whisper Free" })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.calls.filter((call) => call.command === "save_preferences")
              .length,
        ),
      )
      .toBe(5);
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.vocabulary))
      .toEqual([
        {
          spelling: "WhisperFree",
          misheard: ["Whisper-Free", "Another recognized form"],
        },
      ]);
    await page
      .getByRole("button", { name: "Add snippet", exact: true })
      .click();
    await trigger.fill("my signature");
    await expansion.fill('<img src=x onerror="alert(1)"> $1');
    await page.evaluate(() => {
      const w = window as any;
      w.testState.elapsed = 2;
      w.publishState();
    });
    await expect(expansion).toHaveValue('<img src=x onerror="alert(1)"> $1');
    await page.locator("[data-discard-snippets]").click();
    await expect(expansion).toHaveCount(0);
    await expect(
      page.locator("[data-vocabulary-spelling]").first(),
    ).toHaveValue("WhisperFree");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog#settings-dialog")).toBeHidden();
    await openSettings(page);
    await selectSettingsTab(page, "text");
    await page
      .getByRole("button", { name: "Add snippet", exact: true })
      .click();
    await trigger.fill("my signature");
    await expansion.fill('<img src=x onerror="alert(1)"> $1');
    await page.locator("#snippet-actions button[type=submit]").click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).testState.preferences.snippets),
      )
      .toEqual([
        {
          id: expect.any(String),
          trigger: "my signature",
          expansion: '<img src=x onerror="alert(1)"> $1',
          enabled: true,
        },
      ]);
    await expect(page.locator("#snippets img")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).testState.preferences.vocabulary),
      )
      .toEqual([
        {
          spelling: "WhisperFree",
          misheard: ["Whisper-Free", "Another recognized form"],
        },
      ]);
    expect(
      await page.evaluate(
        () => (window as any).testState.preferences.snippets[0].expansion,
      ),
    ).toBe('<img src=x onerror="alert(1)"> $1');
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
          "Recording & shortcuts",
          "Text processing",
          "History",
          "About",
        ]) {
          await selectSettingsTab(page, tab.toLowerCase());
          await expect(
            page.locator(".settings-dialog-nav .selected"),
          ).toHaveText(tab);
          expect(
            await page
              .locator("main")
              .evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          await expect(page.locator("#close-settings")).toBeInViewport();
          if (width === 960)
            await page.screenshot({
              path: `test-results/${platform}-${theme}-${tab.toLowerCase()}.png`,
            });
        }
      }
      for (const language of ["en", "de"] as const) {
        if (language === "de") {
          await page.evaluate(() => {
            window.testState.preferences.ui_language = "de";
            window.publishState();
          });
          await expect(page.locator("html")).toHaveAttribute("lang", "de");
        }
        await selectSettingsTab(page, "general");
        await page.locator(".settings-dialog-scroll").evaluate((element) => {
          element.scrollTop = 0;
        });
        for (const viewport of [
          { width: 740, height: 560 },
          { width: 980, height: 740 },
          { width: 1280, height: 800 },
        ]) {
          await page.setViewportSize(viewport);
          const geometry = await page
            .locator("#settings-dialog")
            .evaluate((dialog) => {
              const rect = dialog.getBoundingClientRect();
              return {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
              };
            });
          expect(geometry.left).toBeGreaterThanOrEqual(0);
          expect(geometry.top).toBeGreaterThanOrEqual(0);
          expect(geometry.right).toBeLessThanOrEqual(viewport.width);
          expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
          await expect(page.locator(".settings-dialog-nav")).toBeVisible();
          await expect(page.locator("#close-settings")).toBeInViewport();
          if (language === "en" && viewport.width === 1280)
            await page.screenshot({
              path: `test-results/${platform}-settings.png`,
            });
        }
      }
    });
  }
}

test("workspace and General match the reference proportions in English and German", async ({
  page,
}) => {
  const platform = "linux";
  await start(page, "linux", false, false, false, null);
  await page.setViewportSize({ width: 1280, height: 800 });
  const longTranscript =
    "The review team approved the updated local dictation workflow and will share the final notes with the engineering group. ".repeat(
      8,
    );
  const secondTranscript =
    "Please move the planning session to Thursday morning and send the agenda to everyone attending.";
  await page.evaluate(
    ({ longTranscript, secondTranscript }) => {
      Object.assign(window.testState, {
        status: "idle",
        elapsed: 0,
        transcript: "",
        history: [longTranscript, secondTranscript],
        installed: ["base"],
        recording_available: true,
        recording_unavailable_reason: undefined,
        recovery_available: false,
      });
      window.testState.preferences.model = "base";
      window.testState.preferences.ui_language = "en";
      window.publishState();
    },
    { longTranscript, secondTranscript },
  );

  const screenshotFolder = resolve(
    "../../.local/validation/ui-redesign-setup/reference-parity",
  );
  mkdirSync(screenshotFolder, { recursive: true });
  const measureWorkspace = async () =>
    page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect();
      const titlebar = rect("header.window-titlebar");
      const activeTab = rect(".window-active-tab[aria-current='page']");
      const rail = rect("aside#dictation-history");
      const main = rect("main#dictation-content");
      const transcript = rect(".dictation-transcript");
      const record = rect("#record");
      return {
        titlebarHeight: titlebar.height,
        activeTabCount: document.querySelectorAll(
          ".window-active-tab[aria-current='page']",
        ).length,
        activeTabWidth: activeTab.width,
        activeTabHeight: activeTab.height,
        activeTabBottom: activeTab.bottom,
        titlebarBottom: titlebar.bottom,
        railWidth: rail.width,
        railAfterCanvas: rail.left >= main.right - 1,
        transcriptInsetLeft: transcript.left - main.left,
        transcriptInsetRight: main.right - transcript.right,
        recordCenterOffset: Math.abs(
          record.left + record.width / 2 - (main.left + main.width / 2),
        ),
      };
    });
  const assertWorkspace = async (language: "en" | "de") => {
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(
      page.locator(".window-titlebar-tabs .window-active-tab"),
    ).toHaveCount(1);
    await expect(
      page.locator(".window-active-tab .window-tab-title"),
    ).toHaveText(language === "en" ? "Recording" : "Aufnahme");
    await expect(page.locator(".window-tab-subtitle")).toHaveText(
      "Whisper Base",
    );
    const geometry = await measureWorkspace();
    expect(geometry.titlebarHeight).toBeCloseTo(46, 0);
    expect(geometry.activeTabCount).toBe(1);
    expect(geometry.activeTabWidth).toBeGreaterThanOrEqual(150);
    expect(geometry.activeTabHeight).toBeCloseTo(36, 0);
    expect(
      Math.abs(geometry.activeTabBottom - geometry.titlebarBottom),
    ).toBeLessThanOrEqual(1);
    expect(geometry.railWidth).toBeCloseTo(290, 0);
    expect(geometry.railAfterCanvas).toBe(true);
    expect(geometry.transcriptInsetLeft).toBeCloseTo(40, 0);
    expect(geometry.transcriptInsetRight).toBeCloseTo(40, 0);
    expect(geometry.recordCenterOffset).toBeLessThanOrEqual(2);
    await expect(page.locator("#dictation-history time")).toHaveCount(0);
    const entry = page.locator(
      '#dictation-history .history-entry[data-history-select="0"]',
    );
    await expect(entry).toBeVisible();
    await expect(entry).toHaveText(longTranscript);
    const entryGeometry = await entry.evaluate((element) => {
      const text = element.querySelector(".history-entry-text")!;
      const buttonStyle = getComputedStyle(element);
      const textStyle = getComputedStyle(text);
      return {
        fontSize: Number.parseFloat(textStyle.fontSize),
        lineHeight: Number.parseFloat(textStyle.lineHeight),
        paddingTop: Number.parseFloat(buttonStyle.paddingTop),
        paddingBottom: Number.parseFloat(buttonStyle.paddingBottom),
        lineClamp: Number.parseInt(
          textStyle.getPropertyValue("-webkit-line-clamp"),
          10,
        ),
        entryHeight: element.getBoundingClientRect().height,
        textHeight: text.getBoundingClientRect().height,
      };
    });
    expect(entryGeometry.fontSize).toBeCloseTo(13.5, 1);
    expect(entryGeometry.lineHeight).toBeCloseTo(18.9, 1);
    expect(entryGeometry.lineClamp).toBe(2);
    expect(entryGeometry.entryHeight).toBeGreaterThanOrEqual(
      2 * entryGeometry.lineHeight +
        entryGeometry.paddingTop +
        entryGeometry.paddingBottom -
        1,
    );
    expect(entryGeometry.entryHeight).toBeLessThanOrEqual(64);
    expect(entryGeometry.textHeight).toBeCloseTo(
      2 * entryGeometry.lineHeight,
      0,
    );
    if ((await entry.getAttribute("aria-pressed")) !== "true")
      await entry.click();
    await expect(entry).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator(".dictation-transcript-body .transcript"),
    ).toHaveText(longTranscript);
    const copy = page.locator("#copy-dictation");
    await expect(copy).toBeVisible();
    await expect(copy).toHaveText(language === "en" ? "Copy" : "Kopieren");
    const copyGeometry = await page.evaluate(() => {
      const copy = document
        .querySelector("#copy-dictation")!
        .getBoundingClientRect();
      const panel = document
        .querySelector(".dictation-transcript")!
        .getBoundingClientRect();
      return copy.left >= panel.left && copy.right <= panel.right;
    });
    expect(copyGeometry).toBe(true);
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)))
      .toEqual({ command: "copy_history", args: { index: 0 } });
  };

  await assertWorkspace("en");
  await page.screenshot({
    path: resolve(screenshotFolder, "workspace-en.png"),
  });
  await openSettings(page);
  await selectSettingsTab(page, "general");
  const assertGeneral = async (language: "en" | "de") => {
    const dialog = page.locator("dialog#settings-dialog");
    const geometry = await page.evaluate(() => {
      const dialog = document
        .querySelector("#settings-dialog")!
        .getBoundingClientRect();
      const nav = document
        .querySelector(".settings-dialog-nav")!
        .getBoundingClientRect();
      const cards = Array.from(
        document.querySelectorAll<HTMLElement>(".compute-mode label"),
      ).map((card) => card.getBoundingClientRect().height);
      const caption = document
        .querySelector("#recognition-backend")!
        .getBoundingClientRect();
      const manage = document
        .querySelector("#manage-models")!
        .getBoundingClientRect();
      return {
        width: dialog.width,
        height: dialog.height,
        right: dialog.right,
        navWidth: nav.width,
        cardHeights: cards,
        captionCenter: caption.top + caption.height / 2,
        manageCenter: manage.top + manage.height / 2,
        captionLeft: caption.left,
        captionRight: caption.right,
        manageLeft: manage.left,
        manageRight: manage.right,
      };
    });
    expect(geometry.width).toBeCloseTo(880, 0);
    expect(geometry.height).toBeCloseTo(600, 0);
    expect(geometry.navWidth).toBeCloseTo(235, 0);
    expect(geometry.cardHeights).toHaveLength(2);
    for (const height of geometry.cardHeights) {
      expect(height).toBeGreaterThanOrEqual(59);
      expect(height).toBeLessThanOrEqual(61);
    }
    expect(
      Math.abs(geometry.captionCenter - geometry.manageCenter),
    ).toBeLessThanOrEqual(2);
    expect(geometry.captionRight).toBeLessThan(geometry.manageLeft);
    expect(geometry.manageRight).toBeLessThanOrEqual(geometry.right);
    await expect(dialog.locator("#manage-models")).toBeVisible();
    await expect(dialog.locator("#recognition-backend")).toBeVisible();
    const name = language === "en" ? "general-en.png" : "general-de.png";
    await page.screenshot({ path: resolve(screenshotFolder, name) });
  };
  const captureSettingsViews = async (language: "en" | "de") => {
    for (const [tab, name] of [
      ["recording", "recording"],
      ["text", "text-processing"],
      ["history", "history"],
    ] as const) {
      await selectSettingsTab(page, tab);
      if (tab === "recording") {
        await expect(page.locator("#settings-recording-primary")).toBeVisible();
        await expect(page.locator("#settings-recording-output")).toBeVisible();
        await expect(
          page.locator("#settings-recording-language"),
        ).toBeVisible();
        await expect(
          page.locator("#settings-recording-microphone"),
        ).toBeVisible();
        await expect(
          page.locator("#settings-recording-permissions"),
        ).toBeVisible();
        await expect(page.locator(".trigger-options-content")).toHaveCount(0);
        await expect(
          page.locator(
            '#settings-recording-primary [data-portal="clear_shortcut"]',
          ),
        ).toHaveCount(0);
        await expect(
          page.locator(
            '#settings-recording-primary [data-portal="desktop_shortcut"]',
          ),
        ).toHaveCount(0);
      }
      if (tab === "text")
        await expect(
          page.locator("#snippet-form .text-processing-description"),
        ).toHaveText(
          language === "en"
            ? "Say a trigger word to insert its saved text. Matching ignores letter case, hyphens, and trailing punctuation."
            : "Sage ein Auslösewort, um den gespeicherten Text einzufügen. Beim Abgleich werden Groß- und Kleinschreibung, Bindestriche und Satzzeichen am Ende ignoriert.",
        );
      if (tab === "history") {
        await expect(page.locator("#settings-history-controls")).toBeVisible();
        await expect(page.locator("#content .history-row")).toHaveCount(0);
        const historyBytes = [longTranscript, secondTranscript].reduce(
          (total, text) => total + new TextEncoder().encode(text).byteLength,
          0,
        );
        const historySize =
          historyBytes < 1024
            ? `${historyBytes} B`
            : `${new Intl.NumberFormat(language === "en" ? "en-US" : "de-DE", {
                maximumFractionDigits: 1,
              }).format(historyBytes / 1024)} KB`;
        await expect(page.locator(".history-storage-stats")).toContainText(
          historySize,
        );
        await expect(page.locator("#clear-history")).toHaveText(
          language === "en" ? "Delete all" : "Alles löschen",
        );
        await expect(
          page.locator('[data-command="show_transcripts_folder"]'),
        ).toBeVisible();
      }
      await page.screenshot({
        path: resolve(screenshotFolder, `${name}-${language}.png`),
      });
    }
  };
  await assertGeneral("en");
  await captureSettingsViews("en");

  await selectSettingsTab(page, "general");
  await page.locator('[data-ui-language="de"]').click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await closeSettings(page);
  await assertWorkspace("de");
  await page.screenshot({
    path: resolve(screenshotFolder, "workspace-de.png"),
  });
  await openSettings(page);
  await selectSettingsTab(page, "general");
  await assertGeneral("de");
  await captureSettingsViews("de");
});

test("Linux and macOS share the titlebar and recording controls while retaining platform mode labels", async ({
  browser,
}) => {
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  await Promise.all(
    pages.map(async (page, index) => {
      await page.setViewportSize({ width: 960, height: 680 });
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await start(
        page,
        index === 0 ? "linux" : "macos",
        false,
        false,
        false,
        null,
      );
      await page.evaluate(() => document.fonts.ready);
    }),
  );
  for (const selector of [
    ".window-titlebar",
    ".dictation-title",
    ".record-center",
  ]) {
    const images = await Promise.all(
      pages.map((page) => page.locator(selector).screenshot()),
    );
    expect(images[0].equals(images[1]), selector).toBe(true);
  }
  await expect(pages[0].locator(".model-pill-mode")).toHaveText("CPU");
  await expect(pages[1].locator(".model-pill-mode")).toHaveText("Native");
  await Promise.all(pages.map((page) => page.close()));
});

test("macOS retains native trigger capture, model import, and update actions", async ({
  page,
}) => {
  await start(page, "macos");
  await expect(page.locator(".recognition-mode-footer")).toBeVisible();
  const recognitionInsets = await page
    .locator(".recognition-mode-footer")
    .evaluate((footer) => {
      const card = footer.parentElement!.getBoundingClientRect();
      const content = footer.getBoundingClientRect();
      return [
        content.left - card.left,
        card.right - content.right,
        content.top - card.top,
        card.bottom - content.bottom,
      ];
    });
  for (const inset of recognitionInsets)
    expect(inset).toBeGreaterThanOrEqual(10);
  await selectSettingsTab(page, "recording");
  await page
    .getByRole("button", { name: "Set trigger …", exact: true })
    .click();
  await expect(page.getByText("Press a key", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Play start and stop sounds")).toBeChecked();
  await closeSettings(page);
  await page.locator(".dictation-change-model").click();
  await expect(page.locator("dialog#model-drawer")).toBeVisible();
  await page
    .getByRole("button", { name: "Import a model …", exact: true })
    .click();
  await expect(page.locator("dialog#model-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await selectSettingsTab(page, "about");
  await expect(page.locator("#about-update-action")).toHaveText(
    "Check for updates",
  );
  await page.locator("#about-update-action").click();
  await expect
    .poll(() => page.evaluate(() => window.testState.updates.status))
    .toBe("available");
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
  test(`${platform}: unavailable recording status remains readable at minimum window size in English and German`, async ({
    page,
  }) => {
    await start(page, platform, false, false, false, null);
    await page.setViewportSize({ width: 740, height: 560 });
    for (const language of ["en", "de"] as const) {
      await page.evaluate((uiLanguage) => {
        Object.assign(window.testState, {
          status: "idle",
          message:
            uiLanguage === "de"
              ? "Mikrofonzugriff ist erforderlich. Prüfe die Einstellungen unter „Aufnahme“."
              : "Recording is unavailable. Restart the recording service and try again.",
          recording_available: false,
          recording_unavailable_reason: "audio",
          recovery_available: false,
          preferences: {
            ...window.testState.preferences,
            ui_language: uiLanguage,
          },
        });
        window.publishState();
      }, language);
      const status = page.locator(".record-status");
      const action = page.locator("#record-unavailable-action");
      await expect(status).toBeVisible();
      await expect(page.locator("#status-title")).toHaveText(
        language === "de"
          ? "Aufnahme nicht verfügbar"
          : "Recording is unavailable",
      );
      await expect(page.locator("#status")).toContainText(
        language === "de"
          ? "Audioeingang verfügbar"
          : "audio input is available",
      );
      await expect(action).toBeVisible();
      await expect(action).toBeInViewport();
      const geometry = await page.evaluate(() => {
        const rect = (selector: string) => {
          const { left, right, top, bottom } = document
            .querySelector(selector)!
            .getBoundingClientRect();
          return { left, right, top, bottom };
        };
        return {
          status: rect(".record-status"),
          discard: rect("#discard-result"),
          center: rect(".record-center"),
          output: rect(".record-output"),
          title: rect("#status-title"),
          message: rect("#status"),
          action: rect("#record-unavailable-action"),
          footer: rect("#record-control"),
          viewportWidth: document.documentElement.clientWidth,
        };
      });
      expect(geometry.status.left).toBeGreaterThanOrEqual(
        geometry.discard.right,
      );
      expect(geometry.status.right).toBeLessThanOrEqual(geometry.center.left);
      expect(geometry.status.right).toBeLessThanOrEqual(geometry.viewportWidth);
      expect(
        geometry.output.left,
        JSON.stringify({ platform, language, geometry }),
      ).toBeGreaterThanOrEqual(geometry.center.right);
      const actionBox = await action.boundingBox();
      expect(actionBox).not.toBeNull();
      expect(actionBox!.x).toBeGreaterThanOrEqual(geometry.status.left);
      expect(
        actionBox!.x + actionBox!.width,
        JSON.stringify({ geometry, actionBox }),
      ).toBeLessThanOrEqual(geometry.status.right);
      expect(geometry.title.bottom).toBeLessThanOrEqual(
        geometry.message.top + 1,
      );
      expect(geometry.message.bottom).toBeLessThanOrEqual(
        geometry.action.top + 1,
      );
      expect(
        geometry.action.bottom,
        JSON.stringify({ platform, language, geometry }),
      ).toBeLessThanOrEqual(geometry.footer.bottom);
      const titleLineHeight = await page
        .locator("#status-title")
        .evaluate(
          (element) =>
            Number.parseFloat(getComputedStyle(element).fontSize) * 1.5,
        );
      expect(geometry.title.bottom - geometry.title.top).toBeLessThanOrEqual(
        titleLineHeight * 1.5,
      );
      await action.click();
      await expect(
        page.locator('.settings-dialog-nav [data-tab="recording"]'),
      ).toHaveClass(/selected/);
      await closeSettings(page);
    }
  });

  test(`${platform}: interface language persists without changing recognition language or user text`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.evaluate(() => {
      const w = window as any;
      w.testState.history = [
        "Diktat / Dictation",
        "<script>private text</script>",
      ];
      w.publishState();
    });
    await page.getByRole("button", { name: "Deutsch", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("heading", { name: "Allgemein", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Aufnahme starten", exact: true }),
    ).toBeVisible();
    await selectSettingsTab(page, "history");
    await expect(
      page.locator("#dictation-history .history-entry[data-history-select]"),
    ).toHaveText(["Diktat / Dictation", "<script>private text</script>"]);
    await expect(page.locator("#settings-history-controls")).toBeVisible();
    await expect(page.locator("#content .history-row")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).testState.preferences.language),
    ).toBe("en");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("button", { name: "Einrichtung", exact: true }),
    ).toHaveCount(0);
    await openSettings(page);
    await selectSettingsTab(page, "general");
    await page.locator('[data-ui-language="en"]').click();
    await expect(
      page.getByRole("heading", { name: "Recording", exact: true }),
    ).toBeVisible();
  });
  test(`${platform}: setup is shown for a fresh installation and stays hidden after completion and restart`, async ({
    page,
    context,
  }) => {
    const microphoneHeading =
      platform === "macos" ? "Allow microphone access" : "Choose a microphone";
    const longMicrophoneId = `alsa_input.usb-${"0123456789abcdef".repeat(7)}`;
    const longFriendlyName = `Studio microphone ${"for broadcast and dictation ".repeat(6)}`;
    const unlabeledMicrophoneId = `alsa_input.pci-${"fedcba9876543210".repeat(7)}`;
    await start(page, platform, false, true, false, null);
    await expect(page.locator(".settings-dialog-nav [data-tab]")).toHaveCount(
      0,
    );
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
    await expect(page.locator("#record-label")).toHaveText(
      "Retry transcription",
    );
    await expect(page.locator("#record")).toBeInViewport();
    await expect(
      page.getByRole("button", {
        name: "Discard saved recording",
        exact: true,
      }),
    ).toBeInViewport();
    const setupFooterGeometry = await page
      .locator("#record-control")
      .evaluate((element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left,
          right,
          top,
          bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          computedRight: style.right,
          rootClasses: document.documentElement.className,
        };
      });
    expect(setupFooterGeometry.left).toBe(0);
    expect(setupFooterGeometry.right, JSON.stringify(setupFooterGeometry)).toBe(
      setupFooterGeometry.viewportWidth,
    );
    expect(setupFooterGeometry.bottom).toBe(setupFooterGeometry.viewportHeight);
    await page.evaluate(() => {
      Object.assign(window.testState, {
        status: "idle",
        recovery_available: false,
        recording_unavailable_reason: undefined,
      });
      window.publishState();
    });
    await expect(page.locator("#record-control")).toBeHidden();
    const cpuDevice =
      platform === "macos"
        ? "Synthetic macOS test CPU"
        : "Synthetic Linux test CPU";
    const gpuDevice = "Synthetic Vulkan test GPU";
    await page.evaluate(
      ({ cpuDevice, platform }) => {
        Object.assign(window.testState, {
          cpu_device: cpuDevice,
          gpu_device: null,
          gpu_supported: false,
          gpu_checked: platform === "macos",
          gpu_available: false,
          gpu_fallback: false,
          recommended_models: ["base", "parakeet-v3-q4"],
        });
        window.publishState();
      },
      { cpuDevice, platform },
    );
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Step 1 of 7", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Choose recognition hardware" }),
    ).toBeVisible();
    const cpuMode = page.locator('input[name="gpu-mode"][value="false"]');
    const gpuMode = page.locator('input[name="gpu-mode"][value="true"]');
    await expect(cpuMode).toBeChecked();
    await expect(gpuMode).toBeDisabled();
    await expect(page.getByText(cpuDevice, { exact: true })).toBeVisible();
    if (platform === "macos") {
      await expect(
        page.getByText(
          `GPU recognition is unavailable in this build. CPU remains available: ${cpuDevice}`,
          { exact: true },
        ),
      ).toBeVisible();
    } else {
      await page.evaluate(
        ({ cpuDevice, gpuDevice }) => {
          Object.assign(window.testState, {
            cpu_device: cpuDevice,
            gpu_device: gpuDevice,
            gpu_supported: true,
            gpu_checked: false,
            gpu_available: false,
          });
          window.publishState();
        },
        { cpuDevice, gpuDevice },
      );
      await expect(gpuMode).toBeDisabled();
      await expect(
        page.getByText("Checking GPU hardware …", { exact: true }),
      ).toBeVisible();
      await page.evaluate(() => window.publishState());
      await expect(
        page.getByText("Checking GPU hardware …", { exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        window.testState.gpu_checked = true;
        window.publishState();
      });
      await expect(
        page.getByText(
          `No compatible GPU was detected. Recognition uses the CPU: ${cpuDevice}`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(gpuMode).toBeDisabled();
      await page.evaluate(() => window.publishState());
      await expect(
        page.getByText(
          `No compatible GPU was detected. Recognition uses the CPU: ${cpuDevice}`,
          { exact: true },
        ),
      ).toBeVisible();
      await page.evaluate(
        ({ gpuDevice }) => {
          window.testState.gpu_available = true;
          window.testState.gpu_device = gpuDevice;
          window.publishState();
        },
        { gpuDevice },
      );
      await expect(gpuMode).toBeEnabled();
      await expect(
        page.getByText(`CPU selected; Vulkan GPU available: ${gpuDevice}`, {
          exact: true,
        }),
      ).toBeVisible();

      await page.evaluate(() => {
        const host = window as any;
        host.rejectSave = true;
        host.saveDelay = 50;
      });
      await gpuMode.check();
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Back", exact: true }),
      ).toBeDisabled();
      await expect(cpuMode).toBeChecked();
      await expect(gpuMode).not.toBeChecked();
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByText("Step 1 of 7", { exact: true }),
      ).toBeVisible();

      await page.evaluate(() => {
        const host = window as any;
        host.rejectSave = false;
        host.saveDelay = 180;
      });
      await gpuMode.check();
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByText("Step 1 of 7", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.testState.preferences.gpu))
        .toBe(true);
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByText(`GPU selected. Vulkan device detected: ${gpuDevice}`, {
          exact: true,
        }),
      ).toBeVisible();
    }
    await page.setViewportSize({ width: 740, height: 560 });
    await page.screenshot({
      path: `test-results/${platform}-setup-hardware-minimum.png`,
    });
    await page.setViewportSize({ width: 960, height: 680 });
    await page.screenshot({
      path: `test-results/${platform}-setup-hardware.png`,
    });
    await page.setViewportSize({ width: 740, height: 560 });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Step 2 of 7", { exact: true })).toBeVisible();
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
      await expect(page.locator("#record")).toHaveAttribute(
        "aria-label",
        "Start recording",
      );
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
    const whisperFamily = page.locator('[data-model-family="whisper"]');
    const parakeetFamily = page.locator('[data-model-family="parakeet"]');
    await expect(whisperFamily).toHaveJSProperty("open", true);
    await expect(parakeetFamily).toHaveJSProperty("open", true);
    const recommendedWhisperId =
      platform === "linux" ? "large-v3-turbo-q5_0" : "base";
    const otherWhisperId = platform === "linux" ? "base" : "small";
    const recommendedParakeetId =
      platform === "linux" ? "parakeet-v3-q8" : "parakeet-v3-q4";
    await expect(
      whisperFamily
        .locator(".model-row")
        .filter({
          has: page.locator(`[data-select="${recommendedWhisperId}"]`),
        })
        .getByText("Starting recommendation"),
    ).toBeVisible();
    await expect(
      whisperFamily
        .locator(".model-row")
        .filter({ has: page.locator(`[data-select="${otherWhisperId}"]`) })
        .getByText("Starting recommendation"),
    ).toHaveCount(0);
    await expect(
      parakeetFamily
        .locator(".model-row")
        .filter({
          has: page.locator(`[data-select="${recommendedParakeetId}"]`),
        })
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
    const setupContinue = page.getByRole("button", {
      name: "Continue",
      exact: true,
    });
    await expect(setupContinue).toBeDisabled();
    await expect(page.locator(".setup-model-required")).toHaveText(
      "Download and select a model to continue.",
    );
    await expect(
      page.getByRole("button", { name: "Back", exact: true }),
    ).toBeEnabled();
    await setupContinue.evaluate((button) => {
      (button as HTMLButtonElement).disabled = false;
      (button as HTMLButtonElement).click();
    });
    await expect(page.getByText("Step 2 of 7", { exact: true })).toBeVisible();
    await setupContinue.evaluate((button) => {
      (button as HTMLButtonElement).disabled = true;
    });
    await baseModel.getByRole("button", { name: "Download" }).click();
    await expect(baseModel.getByRole("progressbar")).toBeVisible();
    await expect(whisperFamily).toHaveJSProperty("open", true);
    await expect(setupContinue).toBeDisabled();
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
    await expect(setupContinue).toBeDisabled();
    await expect(page.locator(".setup-model-required")).toHaveText(
      "Download and select a model to continue.",
    );

    await baseModel.getByRole("button", { name: "Download" }).click();
    await expect(baseModel.getByRole("progressbar")).toBeVisible();
    await page.evaluate(() => {
      window.testState.download = null;
      window.testState.progress = 0;
      window.testState.message = "Model download failed";
      window.publishState();
    });
    await expect(
      baseModel.getByRole("button", { name: "Download" }),
    ).toBeVisible();
    await expect(setupContinue).toBeDisabled();

    await page.evaluate(() => {
      window.testState.installed = ["small"];
      window.publishState();
    });
    await expect(setupContinue).toBeDisabled();
    await expect(page.locator(".setup-model-required")).toBeVisible();

    await baseModel.getByRole("button", { name: "Download" }).click();
    await expect(baseModel.getByRole("progressbar")).toBeVisible();
    await page.evaluate(() => {
      window.testState.download = null;
      window.testState.progress = 1;
      window.testState.installed = ["base", "small"];
      window.publishState();
    });
    await expect(baseModel.getByText("Active", { exact: true })).toBeVisible();
    await expect(setupContinue).toBeEnabled();
    await setupContinue.click();
    await expect(
      page.getByRole("heading", { name: microphoneHeading }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByText("Step 2 of 7", { exact: true })).toBeVisible();
    await expect(whisperFamily).toHaveJSProperty("open", true);
    await expect(baseModel.getByText("Active", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByText("Step 1 of 7", { exact: true })).toBeVisible();
    if (platform === "linux") {
      await expect(gpuMode).toBeChecked();
      await expect(cpuMode).not.toBeChecked();
      await expect
        .poll(() => page.evaluate(() => window.testState.preferences.gpu))
        .toBe(true);
    } else {
      await expect(cpuMode).toBeChecked();
      await expect(gpuMode).toBeDisabled();
    }
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Step 2 of 7", { exact: true })).toBeVisible();
    await expect(baseModel.getByText("Active", { exact: true })).toBeVisible();

    const smallModel = page
      .locator(".model-row")
      .filter({ hasText: "Whisper Small" });
    await smallModel.getByRole("button", { name: "Use", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.model))
      .toBe("small");
    await expect(smallModel.getByText("Active", { exact: true })).toBeVisible();
    await expect(page.getByText("Step 2 of 7", { exact: true })).toBeVisible();
    await expect(setupContinue).toBeEnabled();
    await baseModel.getByRole("button", { name: "Use", exact: true }).click();
    await expect(baseModel.getByText("Active", { exact: true })).toBeVisible();
    await setupContinue.click();
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
      // Restore the synthetic permission capability for the later successful
      // Insert choice; the unsupported branch above remains independently covered.
      await page.evaluate(() => {
        window.testState.paste_portal = true;
        window.testState.paste_ready = false;
        window.testState.paste_configuring = false;
        window.publishState();
      });
      await expect(
        page.getByRole("button", { name: "Allow", exact: true }),
      ).toBeEnabled();
    }
    if (platform === "macos") {
      expect(
        await page.evaluate(() => window.calls.map((call) => call.command)),
      ).not.toContain("allow_microphone");
    }
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "How do you start the recording?" }),
    ).toBeVisible();
    const setupKeycap = page.locator(".setup-trigger-button");
    await expect(setupKeycap).toBeVisible();
    await expect(setupKeycap.locator(".setup-trigger-key")).toBeVisible();
    const setupOutput = page.locator(".setup-trigger-output");
    await expect(setupOutput).toBeVisible();
    await expect(
      setupOutput.locator('input[name="settings-output"]'),
    ).toHaveCount(platform === "macos" ? 3 : 2);
    const pasteOutput = setupOutput.locator('input[value="paste"]');
    const pasteRequestsBeforeChoice = await page.evaluate(
      () =>
        window.calls.filter((call) => call.command === "enable_paste").length,
    );
    await pasteOutput.focus();
    await page.keyboard.press("Space");
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.output))
      .toBe("paste");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.calls.filter((call) => call.command === "enable_paste")
              .length,
        ),
      )
      .toBe(pasteRequestsBeforeChoice + 1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.calls.filter(
              (call) =>
                call.command === "save_preferences" &&
                (call.args as { changes?: { output?: string } } | undefined)
                  ?.changes?.output === "paste",
            ).length,
        ),
      )
      .toBe(1);
    await page.evaluate(() => {
      window.testState.native_shortcuts = true;
      window.testState.native_mouse = window.testState.platform === "linux";
      window.publishState();
    });
    await setupKeycap.click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)?.command))
      .toBe("enable_shortcut");
    if (platform === "linux") {
      const input = await context.newCDPSession(page);
      await input.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 500,
        y: 300,
        button: "back",
        buttons: 8,
        clickCount: 1,
      });
      await input.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 500,
        y: 300,
        button: "back",
        buttons: 0,
        clickCount: 1,
      });
      await expect
        .poll(() => page.evaluate(() => window.calls.at(-1)))
        .toEqual({ command: "capture_mouse_trigger", args: { button: 8 } });
    }
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
    ).toContain("enable_shortcut");

    await page.evaluate(() => {
      window.testState.installed = [];
      window.publishState();
    });
    const finishSetup = page.getByRole("button", {
      name: "Finish setup",
      exact: true,
    });
    await expect(finishSetup).toBeDisabled();
    await expect(page.locator(".setup-model-required")).toBeVisible();
    await finishSetup.evaluate((button) => {
      (button as HTMLButtonElement).disabled = false;
      (button as HTMLButtonElement).click();
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.testState.preferences.setup_completed),
      )
      .toBe(false);
    expect(
      await page.evaluate(() => window.calls.map((call) => call.command)),
    ).not.toContain("complete_setup");
    await page.evaluate(() => {
      window.testState.installed = ["base"];
      window.publishState();
    });
    await expect(finishSetup).toBeEnabled();

    await page.evaluate(() => {
      window.publishNavigate("models");
    });
    await expect(
      page.getByRole("heading", { name: "How do you start the recording?" }),
    ).toBeVisible();
    await expect(page.locator(".settings-dialog-nav [data-tab]")).toHaveCount(
      0,
    );

    await page
      .getByRole("button", { name: "Finish setup", exact: true })
      .click();
    await expect(page.locator("dialog#settings-dialog")).toBeHidden();
    await expect(page.locator(".settings-dialog-nav [data-tab]")).toHaveCount(
      5,
    );
    await openSettings(page);
    await selectSettingsTab(page, "general");
    await page.locator('[data-ui-language="de"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    if (
      await page
        .locator("dialog#settings-dialog")
        .evaluate((dialog) => (dialog as HTMLDialogElement).open)
    )
      await closeSettings(page);
    await expect(
      page.getByRole("button", { name: "Einrichtung", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Aufnahme", exact: true }),
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
    await selectSettingsTab(page, "recording");
    await expect(
      page.getByRole("button", { name: "Erlauben", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.model))
      .toBe("base");
    await expect
      .poll(() => page.evaluate(() => window.testState.preferences.gpu))
      .toBe(platform === "linux");
    expect(
      await page.evaluate(() => window.calls.map((call) => call.command)),
    ).not.toContain("download_model");
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
  test(`${platform}: update can download, verify, wait, and install explicitly`, async ({
    page,
  }) => {
    await start(page, platform);
    await closeSettings(page);
    const update = page.locator("#header-update");
    const dialog = page.locator("#update-dialog");
    const action = page.locator("#update-main-action");
    const later = page.locator("#update-later");
    await page.evaluate(() => {
      Object.assign(window.testState.updates, {
        status: "available",
        version: "0.2.2",
        progress: 0,
        error: null,
        details: {
          highlights: [
            "Improved keyboard access",
            "Fixed desktop startup handling",
            "<img src=x onerror=window.__ownedUpdateXss=1>",
            "Updated translations",
            "Reduced memory use",
          ],
          localized_highlights: {
            en: [
              "Improved keyboard access",
              "Fixed desktop startup handling",
              "<img src=x onerror=window.__ownedUpdateXss=1>",
              "Updated translations",
              "Reduced memory use",
            ],
            de: ["Verbesserte Tastaturbedienung", "Korrigierter Desktop-Start"],
          },
          size: 1234,
        },
      });
      window.publishState();
    });
    await expect(update).toBeVisible();
    await expect(update).toBeEnabled();
    const commandRequests = (name: string) =>
      page.evaluate(
        (command) =>
          window.calls.filter((call) => call.command === command).length,
        name,
      );
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-header-update-available.png`,
      ),
    });
    await update.click();
    await expect(dialog).toBeVisible();
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-update-details-en.png`,
      ),
    });
    await expect(action).toHaveText("Download");
    await expect(action).toBeFocused();
    await expect(page.locator("#update-dialog-version")).toHaveText(
      "Version 0.2.2",
    );
    await expect(page.locator("#update-dialog-installed")).toContainText(
      "1.2 KB",
    );
    await expect(page.locator("#update-dialog-highlights li")).toHaveCount(5);
    await expect(
      page.locator("#update-dialog-highlights li").nth(2),
    ).toHaveText("<img src=x onerror=window.__ownedUpdateXss=1>");
    await expect(
      page.locator("#update-dialog-highlights").locator("img,script,svg"),
    ).toHaveCount(0);
    expect(await commandRequests("download_update")).toBe(0);
    expect(await commandRequests("install_update")).toBe(0);

    await later.click();
    await expect(dialog).toBeHidden();
    await expect(update).toBeFocused();
    await update.click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(update).toBeFocused();

    await update.click();
    await later.focus();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.updates.status = "current";
      w.publishState();
    });
    await expect(page.locator("#update-dialog-status")).toHaveText(
      "Up to date",
    );
    await expect(action).toBeHidden();
    await expect(later).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("#open-settings")).toBeFocused();
    await page.evaluate(() => {
      window.testState.updates.status = "available";
      window.publishState();
    });
    await update.click();
    await expect(dialog).toBeVisible();
    await later.focus();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.updates.status = "checking";
      w.testState.updates.version = "0.2.2";
      w.publishState();
    });
    await expect(page.locator("#update-dialog-status")).toContainText(
      "Checking",
    );
    await expect(action).toBeHidden();
    await expect(later).toBeFocused();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.updates.status = "ready";
      w.testState.updates.version = "0.2.2";
      w.testState.updates.progress = 0;
      w.publishState();
    });
    await expect(action).toHaveText("Restart now");
    await expect(action).toBeEnabled();
    await expect(later).toBeFocused();

    await page.evaluate(() => {
      const w = window as any;
      w.testState.status = "recording";
      w.publishState();
    });
    await expect(action).toBeDisabled();
    await expect(page.locator("#update-dialog-hint")).toHaveText(
      "Finish the current recording before installing an update.",
    );
    await page.evaluate(() => {
      const w = window as any;
      w.testState.status = "idle";
      w.publishState();
    });
    await expect(action).toBeEnabled();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.status = "transcribing";
      w.publishState();
    });
    await expect(action).toBeDisabled();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.status = "idle";
      w.testState.recovery_available = true;
      w.publishState();
    });
    await expect(action).toBeDisabled();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.recovery_available = false;
      w.testState.download = "base";
      w.publishState();
    });
    await expect(action).toBeDisabled();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.download = null;
      w.testState.shortcut_configuring = true;
      w.publishState();
    });
    await expect(action).toBeDisabled();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.shortcut_configuring = false;
      w.testState.paste_configuring = true;
      w.publishState();
    });
    await expect(action).toBeDisabled();
    await expect(later).toBeFocused();
    expect(await commandRequests("install_update")).toBe(0);

    await page.evaluate(() => {
      const w = window as any;
      w.testState.updates.status = "downloading";
      w.testState.updates.progress = 0.42;
      w.testState.updates.download = { received: 420 };
      w.testState.paste_configuring = false;
      w.publishState();
    });
    await expect(action).toBeHidden();
    await expect(page.locator("#update-dialog-progress")).toBeVisible();
    await expect(page.locator("#update-progress-bar")).not.toHaveAttribute(
      "value",
      /.+/,
    );
    await expect(page.locator("#update-progress-label")).toHaveText(
      "Downloaded 420 B",
    );
    await page.evaluate(() => {
      window.testState.updates.download = { received: 420, total: 1000 };
      window.publishState();
    });
    await expect(page.locator("#update-progress-label")).toHaveText(
      "Downloaded 420 B of 1,000 B",
    );
    await expect(page.locator("#update-progress-bar")).toHaveAttribute(
      "max",
      "1000",
    );
    await expect(page.locator("#update-progress-bar")).toHaveAttribute(
      "value",
      "420",
    );
    await expect(later).toBeFocused();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.updates.status = "verifying";
      w.testState.updates.download = { received: 1000, total: 1000 };
      w.publishState();
    });
    await expect(action).toBeHidden();
    await expect(page.locator("#update-dialog-status")).toContainText(
      "Verifying",
    );
    await expect(page.locator("#update-progress-bar")).not.toHaveAttribute(
      "value",
      /.+/,
    );
    await expect(page.locator("#update-progress-label")).toHaveText(
      "Verifying update …",
    );
    await page.evaluate(() => {
      window.testState.updates.status = "ready";
      window.publishState();
    });
    await expect(action).toHaveText("Restart now");
    await expect(action).toBeEnabled();
    await later.click();
    await expect(dialog).toBeHidden();
    await expect(update).toBeVisible();
    await update.click();
    await expect(dialog).toBeVisible();
    await expect(action).toHaveText("Restart now");
    await action.click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)))
      .toEqual({
        command: "install_update",
        args: {},
      });
    await page.evaluate(() => {
      window.testState.updates.status = "installing";
      window.publishState();
    });
    await expect(action).toBeHidden();
    await expect(page.locator("#update-dialog-status")).toContainText(
      "Installing",
    );
    await expect(page.locator("#update-dialog-version")).toHaveText(
      "Version 0.2.2",
    );
    await expect(page.locator("#update-dialog-highlights li")).toHaveCount(5);
    await expect(page.locator("#update-dialog-installed")).toContainText(
      "1.2 KB",
    );
    await expect(later).toBeFocused();
    await page.evaluate(() => {
      const w = window as any;
      w.testState.updates.status = "error";
      w.testState.updates.version = "0.2.2";
      w.testState.updates.error = "Network unavailable";
      w.testState.updates.progress = 0;
      w.testState.updates.download = undefined;
      w.publishState();
    });
    await expect(action).toHaveText("Download");
    await expect(page.locator("#update-dialog-message")).toContainText(
      "Network unavailable",
    );
    await expect(page.locator("#update-dialog-version")).toHaveText(
      "Version 0.2.2",
    );
    await expect(page.locator("#update-dialog-highlights li")).toHaveCount(5);
    await expect(page.locator("#update-dialog-installed")).toContainText(
      "1.2 KB",
    );
    await expect(page.locator("#update-release-link")).toBeVisible();
    await expect(later).toBeFocused();
    expect(await commandRequests("install_update")).toBe(1);
    await page.locator("#update-release-link").click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)))
      .toEqual({
        command: "open_project_link",
        args: { target: "release" },
      });

    await page.evaluate(() => {
      const w = window as any;
      w.testState.updates.status = "available";
      w.testState.updates.error = null;
      w.testState.status = "idle";
      w.publishState();
    });
    await expect(action).toBeEnabled();
    await later.focus();
    await action.click();
    await expect
      .poll(() => page.evaluate(() => window.testState.updates.status))
      .toBe("downloading");
    await expect(later).toBeFocused();
    expect(await commandRequests("download_update")).toBe(1);
    await expect(page.locator("#record")).toBeDisabled();
    await expect(action).toBeHidden();
  });

  test(`${platform}: German ready action fits a narrow update dialog`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await start(page, platform);
    await closeSettings(page);
    await page.evaluate(() => {
      window.testState.preferences.ui_language = "de";
      Object.assign(window.testState.updates, {
        status: "ready",
        version: "0.2.2",
        details: {
          highlights: ["English fallback"],
          localized_highlights: { de: ["Verbesserte Tastaturbedienung"] },
        },
      });
      window.publishState();
    });
    await page.locator("#header-update").click();
    await expect(page.locator("#update-main-action")).toHaveText(
      "Jetzt neu starten",
    );
    await expect(page.locator("#update-dialog-highlights li")).toHaveText(
      "Verbesserte Tastaturbedienung",
    );
    const widths = await page.locator("#update-dialog").evaluate((dialog) => {
      const shell = dialog.querySelector(".update-dialog-shell")!;
      const footer = dialog.querySelector(".update-dialog-footer")!;
      return [
        shell.scrollWidth <= shell.clientWidth,
        footer.scrollWidth <= footer.clientWidth,
      ];
    });
    expect(widths).toEqual([true, true]);
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-update-ready-de-narrow.png`,
      ),
    });
  });

  test(`${platform}: About update details, fixed project links, and localized overflow`, async ({
    page,
  }) => {
    await start(page, platform, false, false, false, null);
    const trustedUrl = page.url();
    await openSettings(page);
    await expect(
      page.locator('#content [data-pref="auto_check_updates"]'),
    ).toHaveCount(0);
    await selectSettingsTab(page, "about");
    const aboutScroll = page.locator(
      "#settings-dialog .settings-dialog-scroll",
    );
    const autoUpdates = page.locator(
      '#about-updates [data-pref="auto_check_updates"]',
    );
    const updateAction = page.locator("#about-update-action");
    await expect(updateAction).toHaveText("Check for updates");
    await expect(autoUpdates).toBeChecked();
    await autoUpdates.uncheck();
    await expect
      .poll(() =>
        page.evaluate(() => window.testState.preferences.auto_check_updates),
      )
      .toBe(false);
    await autoUpdates.check();
    await expect
      .poll(() =>
        page.evaluate(() => window.testState.preferences.auto_check_updates),
      )
      .toBe(true);

    const aboutBounds = async () =>
      aboutScroll.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
        dialog: (() => {
          const rect = document
            .querySelector("#settings-dialog")!
            .getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom,
          };
        })(),
      }));

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 900, height: 650 },
    ]) {
      await page.setViewportSize(viewport);
      const metrics = await aboutBounds();
      console.info(
        `[about-layout] ${platform} ${viewport.width}x${viewport.height} ${JSON.stringify(metrics)}`,
      );
      expect(metrics.dialog.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(metrics.dialog.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(metrics.scrollHeight).toBeLessThanOrEqual(
        metrics.clientHeight + 1,
      );
      await page.screenshot({
        path: resolve(
          recordingPolishScreenshots,
          `${platform}-about-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
    await page.setViewportSize({ width: 740, height: 560 });
    const minimumMetrics = await aboutBounds();
    console.info(
      `[about-layout] ${platform} 740x560 ${JSON.stringify(minimumMetrics)}`,
    );
    expect(minimumMetrics.overflowY).toMatch(/auto|scroll/u);
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-about-740x560.png`,
      ),
    });
    await page
      .locator('#about-updates [data-pref="auto_check_updates"]')
      .scrollIntoViewIfNeeded();
    await expect(updateAction).toHaveText("Check for updates");

    await page.locator('[data-project-link="repository"]').click();
    await page.locator('[data-project-link="issues"]').click();
    await page.locator('[data-project-link="license"]').click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.calls
            .filter((call) => call.command === "open_project_link")
            .map((call) => (call.args as { target?: string }).target),
        ),
      )
      .toEqual(["repository", "issues", "license"]);
    expect(page.url()).toBe(trustedUrl);

    await updateAction.click();
    await expect
      .poll(() => page.evaluate(() => window.testState.updates.status))
      .toBe("available");
    await expect(updateAction).toHaveText("Details");
    await updateAction.click();
    const dialog = page.locator("#update-dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator("#update-main-action")).toHaveText("Download");
    await page.locator("#update-release-link").click();
    await expect
      .poll(() => page.evaluate(() => window.calls.at(-1)))
      .toEqual({
        command: "open_project_link",
        args: { target: "release" },
      });
    await page.locator("#update-later").click();
    await expect(dialog).toBeHidden();
    await expect(updateAction).toBeFocused();

    await page.evaluate(() => {
      window.testState.updates.details = { highlights: [] };
      window.publishState();
    });
    await updateAction.click();
    await expect(page.locator("#update-dialog-highlights li")).toHaveText(
      "No release notes are available for this version.",
    );
    await expect(page.locator("#update-dialog-installed")).not.toContainText(
      "Download size:",
    );
    await page.locator("#update-later").click();

    await page.evaluate(() => {
      window.testState.updates.details = {
        highlights: [
          "Improved keyboard access",
          "Fixed desktop startup handling",
          "Updated translations",
          "Reduced memory use",
          "Refined settings",
        ],
        size: 1234,
      };
      window.publishState();
    });
    await selectSettingsTab(page, "general");
    await page.locator('[data-ui-language="de"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await selectSettingsTab(page, "about");
    await page.setViewportSize({ width: 900, height: 650 });
    const germanMetrics = await aboutBounds();
    console.info(
      `[about-layout] ${platform} de 900x650 ${JSON.stringify(germanMetrics)}`,
    );
    expect(germanMetrics.scrollHeight).toBeLessThanOrEqual(
      germanMetrics.clientHeight + 1,
    );
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-about-de-900x650.png`,
      ),
    });
    await expect(autoUpdates).toBeChecked();
    await expect(updateAction).toHaveText("Details");
    await updateAction.click();
    await expect(dialog).toBeVisible();
    await expect(page.locator("#update-main-action")).toHaveText(
      "Herunterladen",
    );
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-update-details-de.png`,
      ),
    });
    await expect(page.locator("#update-dialog-highlights li")).toHaveCount(5);
    await expect(page.locator("#update-dialog-installed")).toContainText(
      "1,2 KB",
    );
    await page.locator("#update-later").click();
    await expect(dialog).toBeHidden();
    await expect(updateAction).toBeFocused();

    await page.evaluate(() => {
      window.testState.updates.details = { highlights: [] };
      window.publishState();
    });
    await updateAction.click();
    await expect(page.locator("#update-dialog-highlights li")).toHaveText(
      "Für diese Version gibt es keine Versionshinweise.",
    );
    await expect(page.locator("#update-dialog-installed")).not.toContainText(
      "Downloadgröße:",
    );
    await page.locator("#update-later").click();
    await page.evaluate(() => {
      window.testState.profile = "development";
      window.testState.development_build = "fixture-build";
      window.testState.updates.configured = false;
      window.testState.updates.status = "idle";
      window.testState.updates.version = null;
      window.testState.updates.details = undefined;
      window.publishState();
    });
    await expect(page.locator("#about-update-status")).toContainText(
      "nicht eingerichtet",
    );
    await expect(updateAction).toBeHidden();
    await page.screenshot({
      path: resolve(
        recordingPolishScreenshots,
        `${platform}-about-dev-updates-unconfigured.png`,
      ),
    });
  });

  test(`${platform}: update downloads remain available but restart preserves dirty text and native capture`, async ({
    page,
  }) => {
    await start(page, platform);
    await page.evaluate(() => {
      Object.assign(window.testState.updates, {
        status: "available",
        version: "0.2.2",
        details: { highlights: ["Fixture release note"] },
      });
      window.publishState();
    });
    await closeSettings(page);
    const dialog = page.locator("#update-dialog");
    const action = page.locator("#update-main-action");
    await page.locator("#header-update").click();
    await expect(dialog).toBeVisible();

    await page.evaluate(() => {
      window.testState.shortcut_configuring = true;
      window.publishState();
    });
    await expect(action).toBeEnabled();
    await expect(action).toHaveText("Download");
    await expect(page.locator("#update-dialog-hint")).toHaveText(
      "Ready to download this update.",
    );
    await page.evaluate(() => {
      window.testState.updates.status = "ready";
      window.publishState();
    });
    await expect(action).toBeDisabled();
    await expect(page.locator("#update-dialog-hint")).toContainText(
      "permission or shortcut setup",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.calls.filter((call) => call.command === "install_update")
              .length,
        ),
      )
      .toBe(0);
    await page.locator("#update-later").click();
    await page.evaluate(() => {
      window.testState.shortcut_configuring = false;
      window.publishState();
    });

    await selectSettingsTab(page, "text");
    await page.locator("#add-snippet").click();
    const trigger = page.locator('.snippet-row [name="trigger"]');
    const expansion = page.locator('.snippet-row [name="expansion"]');
    await trigger.fill("unsaved update guard");
    await expansion.fill("Synthetic draft");
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("#header-update")?.click();
    });
    await expect(dialog).toBeVisible();
    await expect(action).toBeDisabled();
    await expect(page.locator("#update-dialog-hint")).toContainText(
      "Save or discard your changes",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.calls.filter((call) => call.command === "install_update")
              .length,
        ),
      )
      .toBe(0);
    await page.locator("#update-later").click();
    await expect(trigger).toHaveValue("unsaved update guard");
    await page.locator("[data-discard-snippets]").click();
    await expect(page.locator(".snippet-row")).toHaveCount(0);
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
    await expect(page.locator(".settings-dialog-nav [data-tab]")).toHaveCount(
      0,
    );
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
      "Erkennungshardware auswählen",
      "Sprachmodell herunterladen",
      platform === "macos" ? "Mikrofonzugriff erlauben" : "Mikrofon wählen",
      "Sprache wählen",
      "Wo soll der Text erscheinen?",
      null,
      "Wie startest du die Aufnahme?",
    ];
    for (const [index, title] of titles.entries()) {
      await expect(
        page.getByText(`Schritt ${index + 1} von 7`, { exact: true }),
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
      if (index === 1) {
        await page.screenshot({
          path: `test-results/${platform}-setup-model-de-minimum.png`,
        });
        await page.setViewportSize({ width: 960, height: 680 });
        await page.screenshot({
          path: `test-results/${platform}-setup-model-de.png`,
        });
        await page.setViewportSize({ width: 740, height: 560 });
      }
      if (index === 6) {
        await page.screenshot({
          path: resolve(
            recordingPolishScreenshots,
            `${platform}-setup-keycap-de-740x560.png`,
          ),
        });
        await page.setViewportSize({ width: 980, height: 740 });
        await page.screenshot({
          path: resolve(
            recordingPolishScreenshots,
            `${platform}-setup-keycap-de-980x740.png`,
          ),
        });
        await page.setViewportSize({ width: 740, height: 560 });
      }
      await page
        .getByRole("button", {
          name: index === 6 ? "Einrichtung abschließen" : "Weiter",
          exact: true,
        })
        .click();
    }
    await expect(page.locator("dialog#settings-dialog")).toBeHidden();
    await expect(page.locator(".settings-dialog-nav [data-tab]")).toHaveCount(
      5,
    );
    await expect(
      page.getByRole("heading", { name: "Aufnahme", exact: true }),
    ).toBeVisible();
    for (const title of [
      "Allgemein",
      "Aufnahme & Tasten",
      "Textverarbeitung",
      "Verlauf",
      "Über",
    ]) {
      const tab = {
        Allgemein: "general",
        "Aufnahme & Tasten": "recording",
        Textverarbeitung: "text",
        Verlauf: "history",
        Über: "about",
      }[title];
      await selectSettingsTab(page, tab);
      const settingsWidth = await page
        .locator(".settings-content")
        .evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          child: Array.from(element.children).map((child) => {
            const rect = child.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
          }),
        }));
      expect(
        settingsWidth.scrollWidth,
        JSON.stringify({ platform, title, settingsWidth }),
      ).toBeLessThanOrEqual(settingsWidth.clientWidth);
      await expect(page.locator("#close-settings")).toBeInViewport();
    }
    await closeSettings(page);
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
    await expect(
      page.getByText("Launch at login is unavailable in this installation.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(login.locator("xpath=..")).toHaveAttribute(
      "title",
      "Launch at login is unavailable in this installation.",
    );
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
    await selectSettingsTab(page, "general");
    const login = page.getByRole("checkbox", {
      name: "Launch at login",
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
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).testState.preferences.launch_at_login,
        ),
      )
      .toBe(true);
    await expect(login).toBeChecked();
    await expect(login).toBeVisible();
    // Native hosts publish another snapshot after completing the command reply.
    await page.evaluate(() => (window as any).publishState());
    expect(
      await page.evaluate(
        () => (window as any).originalLoginSwitch.isConnected,
      ),
    ).toBe(true);
    const afterLoginSave = await login.boundingBox();
    expect(afterLoginSave!.y).toBeCloseTo(before!.y, 0);
    await selectSettingsTab(page, "recording");
    const overlay = page.locator('input[data-pref="show_idle_overlay"]');
    await overlay.click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).testState.preferences.show_idle_overlay,
        ),
      )
      .toBe(true);
    await expect(overlay).toBeChecked();
    await selectSettingsTab(page, "general");
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
    await selectSettingsTab(page, "recording");
    await expect(overlay).toBeChecked();
    await page.reload();
    await selectSettingsTab(page, "general");
    await expect(login).not.toBeChecked();
    await selectSettingsTab(page, "recording");
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
    await selectSettingsTab(page, "general");
    await login.click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not save settings",
    );
    await expect(login).not.toBeChecked();
    await selectSettingsTab(page, "recording");
    await expect(
      page.locator('input[data-pref="show_idle_overlay"]'),
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
  await expect(page.locator(".launch-at-login-row")).toHaveAttribute(
    "title",
    "Launch at login is unavailable in this installation.",
  );
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
  await selectSettingsTab(page, "recording");
  await expect(page.getByLabel("Recording mode")).toBeDisabled();
  await expect(page.getByLabel("Recording mode")).toHaveValue("false");
  await expect(
    page.getByText(
      "Regular keyboard shortcuts use toggle mode in this build.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Restore the previous clipboard afterward",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Command+Shift+Space", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('#settings-recording-primary [data-portal="clear_shortcut"]'),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '#settings-recording-primary [data-portal="desktop_shortcut"]',
    ),
  ).toHaveCount(0);
  await expect(page.locator('[data-portal="enable_paste"]')).toBeEnabled();
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
  ).toEqual({
    mac: "Command+Shift+Space",
    linux: { kind: "mouse", button: 8 },
  });
});

test("macOS shows pending login approval without changing the idle overlay", async ({
  page,
}) => {
  await start(page, "macos");
  await page.setViewportSize({ width: 800, height: 560 });
  await selectSettingsTab(page, "general");
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
  await selectSettingsTab(page, "recording");
  await expect(
    page.locator('input[data-pref="show_idle_overlay"]'),
  ).not.toBeChecked();
});

test("Linux: native trigger capture blocks recording and shows saved mouse bindings without inline removal controls", async ({
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
  await selectSettingsTab(page, "recording");
  await page
    .locator("#settings-recording-primary .settings-trigger-button")
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
  await expect(
    page.locator('#settings-recording-primary [data-portal="clear_shortcut"]'),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '#settings-recording-primary [data-portal="desktop_shortcut"]',
    ),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).testState.preferences.native_trigger,
    ),
  ).toEqual({ kind: "mouse", button: 8 });
});

test("Linux mouse setup commits matching middle, back and forward releases only during setup", async ({
  page,
  context,
}) => {
  await start(page, "linux");
  await selectSettingsTab(page, "recording");
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
  await selectSettingsTab(page, "recording");
  await expect(
    page.getByRole("combobox", { name: "Recording mode" }),
  ).toBeEnabled();
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
  await expect(
    page.getByText("Automatic X11 paste", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Revoke", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Allow", exact: true }),
  ).toBeEnabled();
  await selectSettingsTab(page, "general");
  await expect(
    page.getByText("Native X11 triggers", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Native X11 paste", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(2);
});

test("Linux X11 trigger settings preserve the inactive KDE profile without inline removal controls", async ({
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
  await selectSettingsTab(page, "recording");
  await expect(
    page.getByText("Automatisches Einfügen unter X11", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('#settings-recording-primary [data-portal="clear_shortcut"]'),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '#settings-recording-primary [data-portal="desktop_shortcut"]',
    ),
  ).toHaveCount(0);
  await expect(
    page.locator("#settings-recording-primary .settings-trigger-button"),
  ).toHaveText("F8");
  expect(
    await page.evaluate(
      () => (window as any).testState.preferences.native_trigger,
    ),
  ).toEqual({ kind: "mouse", button: 8 });
  expect(
    await page.evaluate(
      () => (window as any).testState.preferences.x11_trigger,
    ),
  ).toEqual({ keycode: 74, keysym: 65477, modifiers: 0, group: 0 });
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
  await selectSettingsTab(page, "recording");
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
    await expect(page.locator("#record-label")).toHaveText(
      "Erneut transkribieren",
    );
  }
  await selectSettingsTab(page, "history");
  await expect(
    page.locator('#dictation-history .history-entry[data-history-select="0"]'),
  ).toHaveText("Clipboard delivery timed out");
  expect(await page.evaluate(() => (window as any).testState.transcript)).toBe(
    "Clipboard delivery timed out",
  );
});

for (const platform of ["linux", "macos"] as const) {
  test(`${platform}: cancelled permission can be retried without a host state event`, async ({
    page,
  }) => {
    await start(page, platform);
    await selectSettingsTab(page, "recording");
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

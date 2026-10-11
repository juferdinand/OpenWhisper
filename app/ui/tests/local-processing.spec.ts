import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopBridge } from "../../src/contracts/ui/bridge.js";
import {
  appStateSchema,
  validateCommandInput,
  validateCommandName,
  type AppState,
  type CommandName,
  type EventName,
} from "../../src/contracts/ui/state.js";
import { defaultLocalProcessingProfile } from "../../src/contracts/speech/local-processing.js";

declare global {
  interface Window {
    openwhisper?: DesktopBridge;
    rendererFixtureInvoke?: (
      command: CommandName,
      args: unknown,
    ) => Promise<unknown>;
    rendererFixturePublish?: (state: unknown) => void;
  }
}

class RendererFixture {
  readonly calls: CommandName[] = [];
  readonly state: AppState = appStateSchema.parse({
    platform: "linux",
    version: "0.3.0",
    initial_tab: "general",
    status: "idle",
    message: "Synthetic ready state",
    transcript: "Synthetic dictation text",
    history: ["Synthetic previous dictation"],
    preferences: {
      ui_language: "en",
      setup_completed: true,
      model: "base",
      language: "en",
      microphone: "",
      vocabulary: "Existing vocabulary",
      snippets: [],
      output: "clipboard",
      hold_to_record: false,
      gpu: false,
      keep_history: true,
    },
    models: [
      {
        id: "base",
        title: "Whisper Base",
        family: "whisper",
        size: "148 MB",
        note: "Synthetic catalog metadata",
      },
    ],
    installed: ["base"],
    microphones: [],
    session: "Owned browser fixture",
    desktop: "Owned browser fixture",
    clipboard_available: false,
    shortcut_portal: false,
    paste_portal: false,
    shortcut: null,
    paste_ready: false,
    gpu_available: false,
    recovery_available: false,
    overlay_available: false,
    download: null,
    progress: 0,
    elapsed: 0,
    model_directory: "/owned-development-models",
    updates: {
      configured: false,
      status: "idle",
      version: null,
      progress: 0,
      error: null,
      package: "development",
    },
    profile: "development",
    recording_available: true,
    local_processing: {
      ...defaultLocalProcessingProfile(),
      model: "owned-fixture",
    },
  });

  constructor(private readonly page: Page) {}

  async start(): Promise<void> {
    await this.page.exposeBinding(
      "rendererFixtureInvoke",
      async (_source, name: unknown, args: unknown) => {
        const command = validateCommandName(name);
        validateCommandInput(command, args);
        this.calls.push(command);
        if (command === "get_state") return structuredClone(this.state);
        throw new Error("Unexpected renderer fixture command.");
      },
    );
    await this.page.addInitScript(() => {
      const listeners = new Map<EventName, Set<(value: unknown) => void>>();
      window.openwhisper = {
        invoke(command, args) {
          const invoke = window.rendererFixtureInvoke;
          if (!invoke) throw new Error("Missing owned renderer fixture.");
          return invoke(command, args);
        },
        subscribe(name, callback) {
          const current =
            listeners.get(name) ?? new Set<(value: unknown) => void>();
          current.add(callback);
          listeners.set(name, current);
          return () => current.delete(callback);
        },
      };
      window.rendererFixturePublish = (state) => {
        for (const callback of listeners.get("state") ?? [])
          callback(structuredClone(state));
      };
    });
    await this.page.goto(pathToFileURL(resolve("dist/index.html")).href);
    await expect(this.page.locator("html")).toHaveAttribute(
      "data-ready",
      "true",
    );
  }
}

test("renderer keeps optional local processing out of the ordinary dictation workflow", async ({
  page,
}) => {
  const fixture = new RendererFixture(page);
  await fixture.start();
  const savedProfile = structuredClone(fixture.state.local_processing);
  const dialog = page.locator("dialog#settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".settings-dialog-nav [data-tab]")).toHaveText([
    "General",
    "Recording & shortcuts",
    "Text processing",
    "History",
    "About",
  ]);

  for (const view of ["text", "recording", "history", "about"]) {
    await page.locator(`.settings-dialog-nav [data-tab="${view}"]`).click();
    await expect(page.locator("#processing-preview")).toHaveCount(0);
    await expect(page.locator('[id^="processing-"]')).toHaveCount(0);
    expect(fixture.state.local_processing).toEqual(savedProfile);
    expect(fixture.calls).toEqual(["get_state"]);
  }

  await page.locator("#close-settings").click();
  await page
    .locator(".dictation-feature-card")
    .filter({ hasText: "Snippets" })
    .click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-tab="text"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator('[id^="processing-"]')).toHaveCount(0);
  expect(fixture.state.local_processing).toEqual(savedProfile);
  expect(fixture.calls).toEqual(["get_state"]);
});

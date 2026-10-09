import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopBridge } from "../../../electron/src/contracts/bridge.js";
import {
  appStateSchema,
  validateCommandInput,
  validateCommandName,
  type AppState,
  type CommandName,
  type CommandOutput,
  type EventName,
  type UILanguage,
} from "../../../electron/src/contracts/ui.js";
import {
  applyLocalProcessingProfilePatch,
  defaultLocalProcessingProfile,
  type LocalProcessingProfilePatch,
} from "../../../electron/src/contracts/local-processing.js";

declare global {
  interface Window {
    openwhisper?: DesktopBridge;
    processingFixtureInvoke?: (
      command: CommandName,
      args: unknown,
    ) => Promise<unknown>;
    processingFixturePublish?: (state: unknown) => void;
  }
}

type PreviewResult = CommandOutput<"preview_local_processing">;
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(): void;
}
function deferred<T>(): Deferred<T> {
  let accept: ((value: T) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((success, failure) => {
    accept = success;
    reject = failure;
  });
  return {
    promise,
    resolve(value) {
      if (!accept) throw new Error("Missing fixture resolver.");
      accept(value);
    },
    reject() {
      if (!reject) throw new Error("Missing fixture rejection.");
      reject(new Error("private fixture detail"));
    },
  };
}

interface SaveRequest {
  readonly changes: LocalProcessingProfilePatch;
  readonly completion: Deferred<AppState>;
}
interface PreviewRequest {
  readonly requestId: string;
  readonly text: string;
  readonly completion: Deferred<unknown>;
}
interface CancelRequest {
  readonly requestId: string;
  readonly completion: Deferred<null>;
}

class ProcessingFixture {
  readonly calls: { readonly command: CommandName; readonly args: unknown }[] =
    [];
  readonly saves: SaveRequest[] = [];
  readonly previews: PreviewRequest[] = [];
  readonly cancels: CancelRequest[] = [];
  holdSaves = false;
  holdCancels = false;
  state: AppState;

  constructor(
    readonly page: Page,
    options: {
      platform?: "linux" | "macos";
      language?: UILanguage;
      legacy?: boolean;
      disabled?: boolean;
    } = {},
  ) {
    const platform = options.platform ?? "linux";
    this.state = appStateSchema.parse({
      platform,
      version: "0.2.5",
      initial_tab: "models",
      status: "idle",
      message: "Synthetic ready state",
      transcript: "Synthetic Wünsche.\n日本語 ⁦مرحبا⁩ 👩‍💻",
      history: ["Synthetic previous dictation"],
      preferences: {
        ui_language: options.language ?? "en",
        setup_completed: true,
        model: "base",
        language: "de",
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
      ...(platform === "macos"
        ? {
            macos: {
              microphone_allowed: false,
              recording_shortcut: false,
              shortcut_hint: "Synthetic shortcut",
              editor: "",
              recommended: [],
              updates_configured: false,
            },
          }
        : {}),
      ...(options.legacy
        ? {}
        : {
            profile: "development",
            recording_available: false,
            local_processing: {
              ...defaultLocalProcessingProfile(),
              enabled: !options.disabled,
              model: "owned-fixture",
            },
          }),
    });
  }

  async start(): Promise<void> {
    await this.page.exposeBinding(
      "processingFixtureInvoke",
      async (_source, name: unknown, input: unknown) => {
        const command = validateCommandName(name);
        const args = validateCommandInput(command, input);
        this.calls.push({ command, args: structuredClone(args) });
        switch (command) {
          case "get_state":
            return structuredClone(this.state);
          case "save_local_processing": {
            const { changes } = validateCommandInput(
              "save_local_processing",
              input,
            );
            const request: SaveRequest = {
              changes,
              completion: deferred<AppState>(),
            };
            this.saves.push(request);
            if (!this.holdSaves) await this.acceptSave(this.saves.length - 1);
            return request.completion.promise;
          }
          case "preview_local_processing": {
            const value = validateCommandInput(
              "preview_local_processing",
              input,
            );
            const request: PreviewRequest = {
              ...value,
              completion: deferred<unknown>(),
            };
            this.previews.push(request);
            return request.completion.promise;
          }
          case "cancel_local_processing": {
            const value = validateCommandInput(
              "cancel_local_processing",
              input,
            );
            const request: CancelRequest = {
              ...value,
              completion: deferred<null>(),
            };
            this.cancels.push(request);
            if (!this.holdCancels) request.completion.resolve(null);
            return request.completion.promise;
          }
          case "save_preferences": {
            const { changes } = validateCommandInput("save_preferences", input);
            this.state = appStateSchema.parse({
              ...this.state,
              preferences: { ...this.state.preferences, ...changes },
            });
            await this.publish();
            return structuredClone(this.state);
          }
          default:
            throw new Error("Unexpected fixture command.");
        }
      },
    );
    await this.page.addInitScript(() => {
      const listeners = new Map<EventName, Set<(value: unknown) => void>>();
      window.openwhisper = {
        invoke(command, args) {
          const invoke = window.processingFixtureInvoke;
          if (!invoke) throw new Error("Missing owned fixture binding.");
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
      window.processingFixturePublish = (state) => {
        for (const callback of listeners.get("state") ?? [])
          callback(structuredClone(state));
      };
    });
    await this.page.goto(pathToFileURL(resolve("dist/index.html")).href);
    await expect(this.page.locator("html")).toHaveAttribute(
      "data-ready",
      "true",
    );
    await expect(this.page.locator('nav [data-tab="models"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
  }

  async publish(): Promise<void> {
    const snapshot = appStateSchema.parse(this.state);
    await this.page.evaluate((state) => {
      const publish = window.processingFixturePublish;
      if (!publish) throw new Error("Missing owned fixture publisher.");
      publish(state);
    }, snapshot);
  }

  async setProfile(changes: LocalProcessingProfilePatch): Promise<void> {
    const profile = this.state.local_processing;
    if (!profile) throw new Error("Missing fixture profile.");
    this.state = appStateSchema.parse({
      ...this.state,
      local_processing: applyLocalProcessingProfilePatch(profile, changes),
    });
    await this.publish();
  }

  async acceptSave(index: number): Promise<void> {
    const request = this.saves[index];
    if (!request) throw new Error("Missing fixture save.");
    await this.setProfile(request.changes);
    request.completion.resolve(structuredClone(this.state));
  }
  rejectSave(index: number): void {
    const request = this.saves[index];
    if (!request) throw new Error("Missing fixture save.");
    request.completion.reject();
  }
  resolvePreview(index: number, output: unknown): void {
    const request = this.previews[index];
    if (!request) throw new Error("Missing fixture preview.");
    request.completion.resolve(output);
  }
  rejectCancel(index: number): void {
    const request = this.cancels[index];
    if (!request) throw new Error("Missing fixture cancellation.");
    request.completion.reject();
  }
}

async function start(
  page: Page,
  options: ConstructorParameters<typeof ProcessingFixture>[1] = {},
): Promise<ProcessingFixture> {
  const fixture = new ProcessingFixture(page, options);
  await fixture.start();
  return fixture;
}

test("manual preview is disabled by default until an explicit profile patch enables it", async ({
  page,
}) => {
  const fixture = await start(page, { disabled: true });
  await expect(page.locator("#processing-enabled")).not.toBeChecked();
  await page.locator("#processing-input").fill("Synthetic manual text");
  await expect(page.locator("#processing-send")).toBeDisabled();
  expect(fixture.previews).toHaveLength(0);
  await page.locator("#processing-enabled").check();
  await expect(page.locator("#processing-send")).toBeEnabled();
  expect(fixture.saves[0]?.changes).toEqual({ enabled: true });
});

for (const platform of ["linux", "macos"] as const) {
  test(`${platform} legacy snapshot has no manual model capability or preview commands`, async ({
    page,
  }) => {
    const fixture = await start(page, { platform, legacy: true });
    await expect(page.locator("#processing-preview")).toHaveCount(0);
    expect(fixture.calls.map((call) => call.command)).toEqual(["get_state"]);
  });
}

test("provider defaults save atomically and a rejected focused provider retains its node/focus", async ({
  page,
}) => {
  const fixture = await start(page);
  fixture.holdSaves = true;
  await page.locator("#processing-input").fill("Synthetic original");
  const provider = page.locator("#processing-provider");
  await provider.focus();
  const original = await provider.elementHandle();
  if (!original) throw new Error("Missing provider control.");
  await provider.selectOption("ollama");
  await expect.poll(() => fixture.saves.length).toBe(1);
  expect(fixture.saves[0]?.changes).toEqual({
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
  });
  await expect(page.locator("#processing-endpoint")).toHaveValue(
    "http://127.0.0.1:11434",
  );
  await expect(page.locator("#processing-send")).toBeDisabled();
  fixture.rejectSave(0);
  await expect(provider).toHaveValue("lm_studio");
  await expect(page.locator("#processing-endpoint")).toHaveValue(
    "http://127.0.0.1:1234/v1",
  );
  expect(
    await original.evaluate(
      (node) =>
        node === document.querySelector("#processing-provider") &&
        node === document.activeElement,
    ),
  ).toBe(true);
  await expect(page.locator("#processing-send")).toBeEnabled();
  await expect(page.locator("#notice")).toHaveText(
    "Invalid text processing profile",
  );
  await provider.selectOption("ollama");
  await expect.poll(() => fixture.saves.length).toBe(2);
  await fixture.acceptSave(1);
  await expect(page.locator("#processing-send")).toBeEnabled();
  expect(fixture.state.local_processing?.provider).toBe("ollama");
  expect(fixture.state.local_processing?.endpoint).toBe(
    "http://127.0.0.1:11434",
  );
});

test("a rejected focused numeric edit restores the confirmed value without replacing its node", async ({
  page,
}) => {
  const fixture = await start(page);
  fixture.holdSaves = true;
  await page.locator("#processing-input").fill("Synthetic original");
  const tokens = page.locator("#processing-max_tokens");
  await tokens.focus();
  const original = await tokens.elementHandle();
  if (!original) throw new Error("Missing token control.");
  await tokens.fill("512");
  await tokens.dispatchEvent("change");
  await expect.poll(() => fixture.saves.length).toBe(1);
  fixture.rejectSave(0);
  await expect(tokens).toHaveValue("1024");
  expect(
    await original.evaluate(
      (node) =>
        node === document.querySelector("#processing-max_tokens") &&
        node === document.activeElement,
    ),
  ).toBe(true);
  await expect(page.locator("#processing-send")).toBeEnabled();
});

test("a delayed rejected patch preserves newer queued fields and sends only each edited patch", async ({
  page,
}) => {
  const fixture = await start(page);
  fixture.holdSaves = true;
  await page.locator("#processing-input").fill("Synthetic original");
  const model = page.locator("#processing-model");
  await model.fill("first-model");
  await model.press("Tab");
  await expect.poll(() => fixture.saves.length).toBe(1);
  await model.fill("newer-model👩‍💻");
  await model.press("Tab");
  await expect(page.locator("#processing-send")).toBeDisabled();
  fixture.rejectSave(0);
  await expect.poll(() => fixture.saves.length).toBe(2);
  await expect(model).toHaveValue("newer-model👩‍💻");
  await expect(page.locator("#processing-destination")).toContainText(
    "newer-model👩‍💻",
  );
  expect(fixture.saves.map((save) => save.changes)).toEqual([
    { model: "first-model" },
    { model: "newer-model👩‍💻" },
  ]);
  await fixture.acceptSave(1);
  await expect(page.locator("#processing-send")).toBeEnabled();
  expect(fixture.state.local_processing?.model).toBe("newer-model👩‍💻");
});

test("failed earlier save cannot erase newer focused uncommitted text", async ({
  page,
}) => {
  const fixture = await start(page);
  fixture.holdSaves = true;
  const model = page.locator("#processing-model");
  await model.fill("submitted");
  await model.dispatchEvent("change");
  await expect.poll(() => fixture.saves.length).toBe(1);
  await model.fill("newer typing 日本語");
  fixture.rejectSave(0);
  await expect(page.locator("#notice")).toHaveText(
    "Invalid text processing profile",
  );
  await expect(model).toHaveValue("newer typing 日本語");
  expect(fixture.state.local_processing?.model).toBe("owned-fixture");
  expect(fixture.saves).toHaveLength(1);
});

test("cancelled late preview and delayed cancellation rejection never overwrite a newer completed preview", async ({
  page,
}) => {
  const fixture = await start(page);
  fixture.holdCancels = true;
  await page.locator("#processing-input").fill("Original Wünsche 日本語 👩‍💻");
  await page.locator("#processing-send").click();
  await expect.poll(() => fixture.previews.length).toBe(1);
  await expect(page.locator("#processing-input")).toHaveAttribute(
    "readonly",
    "",
  );
  await page.locator("#processing-cancel").click();
  await expect.poll(() => fixture.cancels.length).toBe(1);
  expect(fixture.cancels[0]?.requestId).toBe(fixture.previews[0]?.requestId);
  await expect(page.locator("#processing-input")).toHaveValue(
    "Original Wünsche 日本語 👩‍💻",
  );
  await page.locator("#processing-send").click();
  await expect.poll(() => fixture.previews.length).toBe(2);
  const latest: PreviewResult = { ok: true, text: "New result ⁦مرحبا⁩ 👩‍💻" };
  fixture.resolvePreview(1, latest);
  await expect(page.locator("#processing-result")).toHaveValue(latest.text);
  await expect(page.locator("#processing-feedback")).toHaveText(
    "Preview ready. Review it before using it.",
  );
  fixture.resolvePreview(0, { ok: true, text: "Old result must not publish" });
  fixture.rejectCancel(0);
  await expect(page.locator("#processing-result")).toHaveValue(latest.text);
  await expect(page.locator("#processing-feedback")).toHaveText(
    "Preview ready. Review it before using it.",
  );
  expect(fixture.previews[0]?.requestId).not.toBe(
    fixture.previews[1]?.requestId,
  );
  await expect(page.locator("#processing-send")).toBeEnabled();
});

const failures = [
  [
    "TIMEOUT",
    "Text processing timed out; your dictation is unchanged",
    "Zeitlimit für die Textverarbeitung erreicht; dein Diktat bleibt unverändert",
  ],
  [
    "CONNECTION_FAILED",
    "Could not connect to the selected local server; your dictation is unchanged",
    "Keine Verbindung zum gewählten lokalen Server; dein Diktat bleibt unverändert",
  ],
  [
    "HTTP_REJECTED",
    "The local server rejected the request; check its model and authentication settings",
    "Der lokale Server hat die Anfrage abgelehnt; prüfe seine Modell- und Authentifizierungseinstellungen",
  ],
  [
    "INVALID_RESPONSE",
    "The model returned an invalid or incomplete text response",
    "Das Modell hat eine ungültige oder unvollständige Textantwort geliefert",
  ],
] as const;
for (const language of ["en", "de"] as const) {
  test(`${language}: safe provider failures are localized without translating input or result text`, async ({
    page,
  }) => {
    const fixture = await start(page, { language });
    const original = "Wünsche 世界語 ⁦مرحبا⁩ 👩‍💻";
    await page.locator("#processing-input").fill(original);
    for (const [index, [code, english, german]] of failures.entries()) {
      await page.locator("#processing-send").click();
      await expect.poll(() => fixture.previews.length).toBe(index + 1);
      fixture.resolvePreview(index, { ok: false, code });
      await expect(page.locator("#processing-feedback")).toHaveText(
        language === "en" ? english : german,
      );
      await expect(page.locator("#processing-result")).toHaveValue("");
      await expect(page.locator("#processing-input")).toHaveValue(original);
    }
    const text = "Untranslated Wünsche 世界語 ⁦مرحبا⁩ 👩‍💻";
    await page.locator("#processing-send").click();
    await expect.poll(() => fixture.previews.length).toBe(failures.length + 1);
    fixture.resolvePreview(failures.length, { ok: true, text });
    await expect(page.locator("#processing-result")).toHaveValue(text);
    await expect(page.locator("#processing-feedback")).toHaveText(
      language === "en"
        ? "Preview ready. Review it before using it."
        : "Vorschau bereit. Prüfe sie vor der Verwendung.",
    );
    await expect(page.locator("#processing-send")).toHaveText(
      language === "en" ? "Send preview" : "Vorschau senden",
    );
  });
}

test("malformed IPC replies cannot expose private server messages or become preview text", async ({
  page,
}) => {
  const fixture = await start(page);
  await page.locator("#processing-input").fill("Synthetic original");
  const malformed = [
    {
      ok: true,
      text: "private fixture detail",
      arbitrary: "private fixture detail",
    },
    { ok: false, code: "HTTP_REJECTED", message: "private fixture detail" },
    { ok: false, code: "private fixture detail" },
  ];
  for (const [index, output] of malformed.entries()) {
    await page.locator("#processing-send").click();
    await expect.poll(() => fixture.previews.length).toBe(index + 1);
    fixture.resolvePreview(index, output);
    await expect(page.locator("#processing-feedback")).toHaveText(
      "Could not complete the preview; your dictation is unchanged",
    );
    await expect(page.locator("#processing-result")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText(
      "private fixture detail",
    );
  }
});

test("preview text survives navigation as plain text and never mutates ordinary dictation state", async ({
  page,
}) => {
  const fixture = await start(page);
  const ordinary = structuredClone({
    preferences: fixture.state.preferences,
    transcript: fixture.state.transcript,
    history: fixture.state.history,
    recovery: fixture.state.recovery_available,
  });
  const input =
    '</textarea><img id="injected-input" src="invalid" onerror="document.body.dataset.injected=1"> Wünsche 世界語 👩‍💻';
  await page.locator("#processing-input").fill(input);
  await page.locator('nav [data-tab="history"]').click();
  await page.locator('nav [data-tab="models"]').click();
  await expect(page.locator("#processing-input")).toHaveValue(input);
  await expect(page.locator("#injected-input")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-injected", "1");
  await page.locator("#processing-use-latest").click();
  await expect(page.locator("#processing-input")).toHaveValue(
    fixture.state.transcript,
  );
  await page.locator("#processing-send").click();
  await expect.poll(() => fixture.previews.length).toBe(1);
  expect(fixture.previews[0]?.text).toBe(ordinary.transcript);
  const output = '<script id="injected-output">alert(1)</script> Plain 日本語';
  fixture.resolvePreview(0, { ok: true, text: output });
  await expect(page.locator("#processing-result")).toHaveValue(output);
  await expect(page.locator("#injected-output")).toHaveCount(0);
  expect({
    preferences: fixture.state.preferences,
    transcript: fixture.state.transcript,
    history: fixture.state.history,
    recovery: fixture.state.recovery_available,
  }).toEqual(ordinary);
  expect(fixture.calls.map((call) => call.command)).toEqual([
    "get_state",
    "preview_local_processing",
  ]);
});

test("UTF-8 limit rejects oversize UI text intact and accepts exactly 64 KiB", async ({
  page,
}) => {
  const fixture = await start(page);
  const larger = "é".repeat(32769);
  await page.locator("#processing-input").fill(larger);
  await page.locator("#processing-send").click();
  await expect(page.locator("#processing-feedback")).toHaveText(
    "Preview text must contain between 1 byte and 64 KB; your dictation is unchanged",
  );
  await expect(page.locator("#processing-input")).toHaveValue(larger);
  expect(fixture.previews).toHaveLength(0);
  const exact = "é".repeat(32768);
  await page.locator("#processing-input").fill(exact);
  await page.locator("#processing-send").click();
  await expect.poll(() => fixture.previews.length).toBe(1);
  expect(fixture.previews[0]?.text).toBe(exact);
  fixture.resolvePreview(0, { ok: true, text: "Boundary preview ready." });
  await expect(page.locator("#processing-result")).toHaveValue(
    "Boundary preview ready.",
  );
  await expect(page.locator("#processing-input")).toHaveValue(exact);
});

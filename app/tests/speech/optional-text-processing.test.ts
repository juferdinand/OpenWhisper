import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultTextConnectionAvailability, defaultTextConnectionSettings, type TextConnectionAvailability,
  type TextConnectionSettings, type TextConversation,
} from "../../src/contracts/text/connections.js";
import type { TextProcessingStageEvent } from "../../src/contracts/text/processing.js";
import { OptionalTextProcessing } from "../../src/services/text/optional-text-processing.js";

const owner = (signal = new AbortController().signal) => ({ generation: 8, attempt: 2, signal });
const available = (...models: string[]): TextConnectionAvailability[] => defaultTextConnectionAvailability().map((entry) =>
  entry.provider === "ollama" ? { ...entry, detected: true, usable: models.length > 0, models, reason: models.length > 0 ? null : "no_models" }
    : entry.provider === "lm_studio" ? { ...entry, detected: true, usable: true, models: ["lm-local"], reason: null }
      : entry);

function configured(enabled: readonly string[]) {
  const defaults = defaultTextConnectionSettings();
  return { ...defaults, connections: defaults.connections.map((connection) => ({ ...connection,
    enabled: enabled.includes(connection.provider),
    ...(connection.provider === "ollama" ? { model: "qwen-local" }
      : connection.provider === "lm_studio" ? { model: "lm-local" } : {}),
  })) };
}

function availableCli(provider: "claude_code" | "codex"): TextConnectionAvailability[] {
  return defaultTextConnectionAvailability().map((entry) => entry.provider === provider
    ? { ...entry, detected: true, usable: true, models: [], reason: null } : entry);
}

function processor(options: {
  enabled?: readonly string[];
  settings?: TextConnectionSettings;
  availability?: TextConnectionAvailability[];
  scan?: () => Promise<unknown>;
  run?: (provider: string, signal: AbortSignal, model?: string) => Promise<string>;
  shuttingDown?: () => boolean;
  stage?: (event: TextProcessingStageEvent | null) => void;
} = {}) {
  const calls: string[] = [];
  const instance = new OptionalTextProcessing({
    settings: () => options.settings ?? configured(options.enabled ?? []),
    scan: options.scan ?? (async () => options.availability ?? available("qwen-local")),
    isShuttingDown: options.shuttingDown ?? (() => false),
    onStage: (event) => options.stage?.(event),
    runProvider: async (connection, _instruction, _text, signal) => {
      calls.push(connection.provider);
      return options.run ? options.run(connection.provider, signal, "model" in connection ? connection.model : undefined) : "processed text";
    },
  });
  return { instance, calls };
}

test("disabled connections preserve ordinary dictation without scanning or making a request", async () => {
  let scans = 0, requests = 0;
  const { instance } = processor({ scan: async () => { scans += 1; return available("qwen-local"); },
    run: async () => { requests += 1; return "unexpected"; } });
  assert.equal(await instance.process("recognized text", owner()), "recognized text");
  assert.equal(scans, 0);
  assert.equal(requests, 0);
  assert.equal(instance.snapshot().processing.status, "idle");
});

test("only the highest enabled provider is attempted", async () => {
  const { instance, calls } = processor({ enabled: ["ollama", "lm_studio"] });
  assert.equal(await instance.process("recognized text", owner()), "processed text");
  assert.deepEqual(calls, ["ollama"]);
});

test("CLI providers run with empty model catalogs and forward blank or explicit model selections", async () => {
  const defaults = defaultTextConnectionSettings();
  for (const provider of ["claude_code", "codex"] as const) {
    for (const model of ["", `${provider}-model`]) {
      const settings: TextConnectionSettings = { ...defaults, connections: defaults.connections.map((entry) =>
        entry.provider === provider ? { ...entry, enabled: true, model } : entry) };
      const forwarded: Array<string | undefined> = [];
      const { instance, calls } = processor({ settings, availability: availableCli(provider),
        run: async (_selected, _signal, selectedModel) => { forwarded.push(selectedModel); return "processed text"; } });
      assert.equal(await instance.process("recognized text", owner()), "processed text");
      assert.deepEqual(calls, [provider]);
      assert.deepEqual(forwarded, [model]);
    }
  }
});

test("local providers still refuse a selected model absent from the discovered catalog", async () => {
  const { instance, calls } = processor({ enabled: ["ollama"], availability: available("other-model") });
  assert.equal(await instance.process("recognized text", owner()), "recognized text");
  assert.deepEqual(calls, []);
  assert.deepEqual(instance.snapshot().processing, { status: "fallback", provider: "ollama", reason: "unavailable" });
});

test("conversation storage failure replaces stale completion and clears pending turn", async () => {
  const { instance } = processor({ enabled: ["ollama"] });
  const conversation: TextConversation = { id: "conversation-1", provider: "ollama", turns: [] };
  assert.equal(await instance.process("question", owner(), conversation), "processed text");
  assert.deepEqual(instance.snapshot().processing, { status: "complete", provider: "ollama", reason: null });

  instance.skipForStorageFailure(owner());

  assert.deepEqual(instance.snapshot().processing, { status: "fallback", provider: "ollama", reason: "failed" });
  assert.equal(instance.takeAcceptedConversationTurn(8, 2), undefined);
});

test("provider failure keeps deterministic text and never falls through to the next provider", async () => {
  const { instance, calls } = processor({ enabled: ["ollama", "lm_studio"], run: async () => { throw new Error("unavailable"); } });
  assert.equal(await instance.process("deterministic text", owner()), "deterministic text");
  assert.deepEqual(calls, ["ollama"]);
  assert.deepEqual(instance.snapshot().processing, { status: "fallback", provider: "ollama", reason: "failed" });
});

test("explicit model cancellation skips only the model and returns deterministic text", async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const stages: Array<TextProcessingStageEvent | null> = [];
  const { instance } = processor({ enabled: ["ollama"], stage: (event) => stages.push(event), run: async (_provider, signal) => {
    started();
    return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  const pending = instance.process("deterministic text", owner());
  await began;
  instance.cancel();
  assert.equal(await pending, "deterministic text");
  assert.deepEqual(instance.snapshot().processing, { status: "fallback", provider: "ollama", reason: "cancelled" });
  assert.equal(stages.at(-1)?.status, "skipped");
});

test("parent cancellation and shutdown abandon delivery and clear model status", async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const parent = new AbortController();
  const { instance } = processor({ enabled: ["ollama"], run: async (_provider, signal) => {
    started();
    return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  const pending = instance.process("deterministic text", owner(parent.signal));
  await began;
  parent.abort();
  assert.equal(await pending, undefined);
  assert.equal(instance.snapshot().processing.status, "idle");

  let shuttingDown = false;
  const next = processor({ enabled: ["ollama"], shuttingDown: () => shuttingDown,
    run: async (_provider, signal) => new Promise<string>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("closed")), { once: true })) });
  const closing = next.instance.process("deterministic text", owner());
  await new Promise<void>((resolve) => setImmediate(resolve));
  shuttingDown = true;
  next.instance.close();
  assert.equal(await closing, undefined);
  assert.equal(next.instance.snapshot().processing.status, "idle");
});

test("a superseded provider completion cannot deliver or overwrite the current result", async () => {
  let releaseOld!: (text: string) => void;
  let firstStarted!: () => void;
  const began = new Promise<void>((resolve) => { firstStarted = resolve; });
  const { instance } = processor({ enabled: ["ollama"], run: async (_provider, signal) => {
    if (!signal.aborted && !releaseOld) {
      firstStarted();
      return new Promise<string>((resolve) => { releaseOld = resolve; });
    }
    return "current result";
  } });
  const older = instance.process("older text", owner());
  await began;
  const current = await instance.process("current input", owner());
  assert.equal(current, "current result");
  releaseOld("stale result");
  assert.equal(await older, undefined);
  assert.deepEqual(instance.snapshot().processing, { status: "complete", provider: "ollama", reason: null });
});

test("a canceled old owner cannot clear a newer request's status or stage", async () => {
  let releaseOld!: (text: string) => void;
  let releaseCurrent!: (text: string) => void;
  let starts = 0;
  const stages: Array<TextProcessingStageEvent | null> = [];
  const parent = new AbortController();
  const { instance } = processor({ enabled: ["ollama"], stage: (event) => stages.push(event),
    run: async () => {
      starts += 1;
      return new Promise<string>((resolve) => {
        if (starts === 1) releaseOld = resolve;
        else releaseCurrent = resolve;
      });
    } });

  const oldRequest = instance.process("old input", owner(parent.signal));
  await new Promise<void>((resolve) => setImmediate(resolve));
  parent.abort();
  const currentRequest = instance.process("current input", owner());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(instance.snapshot().processing.status, "processing");
  const stageCount = stages.length;

  releaseOld("stale result");
  assert.equal(await oldRequest, undefined);
  assert.equal(instance.snapshot().processing.status, "processing");
  assert.equal(stages.length, stageCount);
  assert.equal(stages.at(-1)?.status, "progress");

  releaseCurrent("current result");
  assert.equal(await currentRequest, "current result");
  assert.deepEqual(instance.snapshot().processing, { status: "complete", provider: "ollama", reason: null });
});

test("saved enabled provider refreshes unavailable startup state before its first request", async () => {
  let scans = 0;
  const { instance, calls } = processor({ enabled: ["ollama"], availability: defaultTextConnectionAvailability(),
    scan: async () => { scans += 1; return available("qwen-local"); } });
  assert.equal(await instance.process("recognized text", owner()), "processed text");
  assert.equal(scans, 1);
  assert.deepEqual(calls, ["ollama"]);
});

test("conversation calls replay explicit prior turns and become eligible for commit only on success", async () => {
  const settings = { ...configured(["ollama"]), mode: "conversation" as const };
  let observedInstruction = "", observedContext: readonly { user: string; assistant: string }[] | undefined;
  const instance = new OptionalTextProcessing({
    settings: () => settings,
    scan: async () => available("qwen-local"),
    isShuttingDown: () => false,
    runProvider: async (_connection, instruction, _text, _signal, _requestId, context) => {
      observedInstruction = instruction;
      observedContext = context;
      return "assistant answer";
    },
  });
  const conversation: TextConversation = { id: "chat-id", provider: "ollama", turns: [{ user: "old question", assistant: "old answer" }] };
  assert.equal(await instance.process("new question", owner(), conversation), "assistant answer");
  assert.equal(observedInstruction, settings.conversationInstruction);
  assert.deepEqual(observedContext, conversation.turns);
  assert.deepEqual(instance.takeAcceptedConversationTurn(8, 2), { user: "new question", assistant: "assistant answer" });
  assert.equal(instance.takeAcceptedConversationTurn(8, 2), undefined);
});

test("conversation overflow keeps deterministic input and adds no turn", async () => {
  const settings: TextConnectionSettings = { ...configured(["ollama"]), mode: "conversation" };
  let requests = 0;
  const instance = new OptionalTextProcessing({ settings: () => settings,
    scan: async () => available("qwen-local"), isShuttingDown: () => false,
    runProvider: async () => { requests += 1; return "answer"; } });
  const conversation: TextConversation = { id: "chat-id", provider: "ollama", turns: [
    ...Array.from({ length: 3 }, () => ({ user: "u".repeat(43_650), assistant: "a".repeat(43_650) })),
  ] };
  const input = "q".repeat(1000);
  assert.equal(await instance.process(input, owner(), conversation), input);
  assert.equal(requests, 0);
  assert.deepEqual(instance.snapshot().processing, { status: "fallback", provider: "ollama", reason: "context_full" });
  assert.equal(instance.takeAcceptedConversationTurn(8, 2), undefined);
});

test("a completed answer that would exceed the context bound falls back without a turn", async () => {
  const settings: TextConnectionSettings = { ...configured(["ollama"]), mode: "conversation" };
  const instance = new OptionalTextProcessing({ settings: () => settings,
    scan: async () => available("qwen-local"), isShuttingDown: () => false,
    runProvider: async () => "a".repeat(64_000) });
  const conversation: TextConversation = { id: "chat-id", provider: "ollama", turns: [
    { user: "u".repeat(50_000), assistant: "a".repeat(50_000) },
    { user: "u".repeat(50_000), assistant: "a".repeat(50_000) },
  ] };
  const input = "q".repeat(64_000);
  assert.equal(await instance.process(input, owner(), conversation), input);
  assert.equal(instance.takeAcceptedConversationTurn(8, 2), undefined);
});

test("changed custom command scans do not reuse an in-flight availability snapshot", async () => {
  const base = defaultTextConnectionSettings();
  const make = (command: string): TextConnectionSettings => ({ ...base, connections: [...base.connections,
    { provider: "custom:123e4567-e89b-42d3-a456-426614174000", enabled: false, name: "test", command,
      args: ["{prompt}"], stdin: "", output: "text", responsePath: "" }] });
  const first = make("old-command"), second = make("new-command");
  let release!: () => void;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const scanned: string[] = [];
  const instance = new OptionalTextProcessing({ settings: () => first, scan: async (settings) => {
    scanned.push(settings.connections[4] && "command" in settings.connections[4] ? settings.connections[4].command : "missing");
    if (scanned.length === 1) await started;
    return available("qwen-local");
  }, isShuttingDown: () => false, runProvider: async (_connection, _instruction, text) => text });
  const oldScan = instance.scanConnections(first);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const newScan = instance.scanConnections(second);
  release();
  await Promise.all([oldScan, newScan]);
  assert.deepEqual(scanned, ["old-command", "new-command"]);
});

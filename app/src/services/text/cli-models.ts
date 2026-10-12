import { z } from "zod";
import { cliTextModelSchema, textModelOptionSchema, type TextModelOption } from "../../contracts/text/connections.js";
import { runTextCliProcess } from "./text-cli-process.js";

const MODEL_LIMIT = 128;
const MODEL_TIMEOUT_MS = 8_000;
const MODEL_OUTPUT_BYTES = 1024 * 1024;
const MAX_MODEL_PAGES = 8;
const requestRecord = z.record(z.string(), z.unknown());
const codexPageSchema = z.object({
  data: z.array(z.object({ id: z.string().max(1024), hidden: z.boolean() })).max(MODEL_LIMIT),
  nextCursor: z.string().max(1024).nullable().optional(),
});
const claudeModelsSchema = z.array(z.object({ value: z.string().max(1024), resolvedModel: z.string().max(1024).optional(),
  displayName: z.string().max(1024) })).max(MODEL_LIMIT);

interface ClaudeCatalogModel { readonly value: string; readonly displayName: string; readonly family: string }

// Active first-party Anthropic IDs checked 2026-10-12 against https://platform.claude.com/docs/en/about-claude/model-deprecations.
// Suggestions are not entitlement claims.
const activeClaudeModels: readonly ClaudeCatalogModel[] = [
  { value: "claude-opus-5-5", displayName: "Opus 5.5", family: "opus" },
  { value: "claude-opus-5", displayName: "Opus 5", family: "opus" },
  { value: "claude-opus-4-8", displayName: "Opus 4.8", family: "opus" },
  { value: "claude-opus-4-7", displayName: "Opus 4.7", family: "opus" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", family: "opus" },
  { value: "claude-opus-4-5-20251101", displayName: "Opus 4.5", family: "opus" },
  { value: "claude-fable-5-1", displayName: "Fable 5.1", family: "fable" },
  { value: "claude-fable-5", displayName: "Fable 5", family: "fable" },
  { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", family: "sonnet" },
  { value: "claude-sonnet-5", displayName: "Sonnet 5", family: "sonnet" },
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", family: "sonnet" },
  { value: "claude-haiku-5-5", displayName: "Haiku 5.5", family: "haiku" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", family: "haiku" },
];

export interface ClaudeModelDiscovery {
  readonly models: readonly string[];
  readonly model_options: readonly TextModelOption[];
}

function lineJson(line: string): Record<string, unknown> {
  return requestRecord.parse(JSON.parse(line));
}

/** Read model metadata through the installed Codex app-server without creating a thread or turn. */
export async function discoverCodexModels(executable: string): Promise<string[]> {
  const models = new Set<string>();
  const seenCursors = new Set<string>();
  let stage: "initialize" | "models" | "done" = "initialize";
  let completed = false;
  let expectedId = 1;
  let pages = 0;
  const initial = JSON.stringify({ id: expectedId, method: "initialize", params: {
    clientInfo: { name: "openwhisper", title: "OpenWhisper", version: "0" },
    capabilities: { experimentalApi: false },
  } }) + "\n";
  try {
    await runTextCliProcess({ executable, args: ["app-server", "--listen", "stdio://"], input: initial,
      signal: new AbortController().signal, timeoutMs: MODEL_TIMEOUT_MS, maxStdoutBytes: MODEL_OUTPUT_BYTES,
      keepStdinOpen: true, onLine: (line) => {
        const message = lineJson(line);
        if (message["id"] !== expectedId) return undefined;
        if (message["error"] !== undefined || !message["result"] || typeof message["result"] !== "object") {
          throw new Error("Codex metadata request failed.");
        }
        if (stage === "initialize") {
          stage = "models";
          pages = 0;
          expectedId += 1;
          const request = { id: expectedId, method: "model/list", params: { limit: MODEL_LIMIT, includeHidden: false } };
          return { write: `${JSON.stringify({ method: "initialized" })}\n${JSON.stringify(request)}\n` };
        }
        if (stage !== "models") throw new Error("Unexpected Codex metadata response.");
        const page = codexPageSchema.parse(message["result"]);
        pages += 1;
        for (const model of page.data) if (!model.hidden) {
          const parsed = cliTextModelSchema.safeParse(model.id);
          if (parsed.success) models.add(parsed.data);
        }
        const cursor = page.nextCursor;
        if (models.size >= MODEL_LIMIT || cursor === undefined || cursor === null) {
          stage = "done";
          completed = true;
          return { end: true };
        }
        if (pages >= MAX_MODEL_PAGES || seenCursors.has(cursor)) throw new Error("Invalid Codex model pagination.");
        seenCursors.add(cursor);
        expectedId += 1;
        const next = { id: expectedId, method: "model/list", params: {
          cursor, limit: MODEL_LIMIT - models.size, includeHidden: false,
        } };
        return { write: `${JSON.stringify(next)}\n` };
      },
    });
    if (!completed) return [];
    return [...models].slice(0, MODEL_LIMIT);
  } catch { return []; }
}

function discoverClaudeOptions(metadata: readonly z.infer<typeof claudeModelsSchema>[number][]): ClaudeModelDiscovery {
  const models = new Set<string>();
  const options = new Map<string, TextModelOption>();
  const validId = (value: string): string | undefined => {
    const parsed = cliTextModelSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  const catalogLabel = (value: string): string | undefined => activeClaudeModels.find((model) => model.value === value)?.displayName;
  const addOption = (value: string, displayName: string, source: TextModelOption["source"]): void => {
    const parsedValue = validId(value);
    if (!parsedValue) return;
    if (source === "cli") models.add(parsedValue);
    const label = displayName.length > 0 && new TextEncoder().encode(displayName).byteLength <= 256 &&
      displayName.trim() === displayName && !/[\u0000-\u001f\u007f-\u009f]/u.test(displayName) ? displayName : parsedValue;
    const parsed = textModelOptionSchema.safeParse({ value: parsedValue, display_name: label, source });
    if (!parsed.success) return;
    const existing = options.get(parsedValue);
    if (!existing || existing.source === "catalog" && source === "cli") options.set(parsedValue, parsed.data);
  };

  for (const entry of metadata) {
    const value = validId(entry.value);
    if (!value) continue;
    const resolvedModel = entry.resolvedModel === undefined ? undefined : validId(entry.resolvedModel);
    const baseLabel = entry.displayName.trim();
    const label = resolvedModel && value !== resolvedModel
      ? value.startsWith("claude-") ? `${baseLabel} (${value})` : `${baseLabel} (alias → ${resolvedModel})`
      : catalogLabel(value) ?? baseLabel;
    addOption(value, label, "cli");
    if (!resolvedModel) continue;
    addOption(resolvedModel, catalogLabel(resolvedModel) ?? resolvedModel, "cli");

    const latestIndex = activeClaudeModels.findIndex((model) => model.value === resolvedModel);
    if (latestIndex < 0) continue;
    const family = activeClaudeModels[latestIndex]!.family;
    for (const model of activeClaudeModels.slice(latestIndex).filter((candidate) => candidate.family === family)) {
      addOption(model.value, model.displayName, "catalog");
    }
  }

  return { models: [...models].slice(0, MODEL_LIMIT), model_options: [...options.values()].slice(0, MODEL_LIMIT) };
}

/** Read the installed Claude CLI's initialize metadata only; no user prompt or turn is sent. */
export async function discoverClaudeModels(executable: string): Promise<ClaudeModelDiscovery> {
  let discovery: ClaudeModelDiscovery | undefined;
  let completed = false;
  const requestId = "openwhisper-model-catalog";
  const initial = JSON.stringify({ type: "control_request", request_id: requestId,
    request: { subtype: "initialize" } }) + "\n";
  try {
    await runTextCliProcess({ executable,
      args: ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode",
        "--tools", "", "--no-session-persistence", "--permission-prompts", "none"],
      input: initial, signal: new AbortController().signal, timeoutMs: MODEL_TIMEOUT_MS, maxStdoutBytes: MODEL_OUTPUT_BYTES,
      keepStdinOpen: true, onLine: (line) => {
        const message = lineJson(line);
        if (message["type"] !== "control_response") return undefined;
        const response = message["response"];
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid Claude metadata response.");
        const control = response as Record<string, unknown>;
        if (control["request_id"] !== requestId || control["subtype"] !== "success") throw new Error("Claude metadata request failed.");
        const payload = control["response"];
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Claude metadata payload.");
        const parsed = claudeModelsSchema.safeParse((payload as Record<string, unknown>)["models"]);
        if (!parsed.success) throw new Error("Invalid Claude model catalog.");
        discovery = discoverClaudeOptions(parsed.data);
        completed = true;
        return { end: true };
      },
    });
    return completed ? discovery ?? { models: [], model_options: [] } : { models: [], model_options: [] };
  } catch {
    return { models: [], model_options: [] };
  }
}

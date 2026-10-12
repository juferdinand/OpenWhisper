import { z } from "zod";
import { cliTextModelSchema } from "../../contracts/text/connections.js";
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
const claudeModelsSchema = z.array(z.object({ value: z.string().max(1024), displayName: z.string().max(1024) })).max(MODEL_LIMIT);

function modelIds(values: readonly string[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    const parsed = cliTextModelSchema.safeParse(value);
    if (parsed.success) result.add(parsed.data);
    if (result.size >= MODEL_LIMIT) break;
  }
  return [...result];
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

/** Read the installed Claude CLI's initialize metadata only; no user prompt or turn is sent. */
export async function discoverClaudeModels(executable: string): Promise<string[]> {
  let models: string[] | undefined;
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
        models = modelIds(parsed.data.map(({ value }) => value));
        completed = true;
        return { end: true };
      },
    });
    return completed ? models ?? [] : [];
  } catch {
    return [];
  }
}

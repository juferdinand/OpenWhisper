import { z } from "zod";
import { localProcessingOutputSchema } from "../../contracts/speech/local-processing.js";
import { cliTextModelSchema, textReasoningEffortSchema } from "../../contracts/text/connections.js";
import { buildTextPrompt, TextPromptError, type TextConversationTurn } from "./text-prompt.js";
import { runTextCliProcess, TextCliProcessError } from "./text-cli-process.js";

const MAX_CLAUDE_TIMEOUT_MS = 120_000;
const claudeResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.literal("success"),
  is_error: z.literal(false),
  result: z.string().max(1024 * 1024),
});

export type ClaudeTextFailureCode = "UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "FAILED" | "INVALID_RESPONSE";
export class ClaudeTextError extends Error {
  constructor(readonly code: ClaudeTextFailureCode) { super(code); this.name = "ClaudeTextError"; }
}

export interface ClaudeTextOptions {
  readonly executable: string;
  readonly instruction: string;
  readonly text: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly context?: readonly TextConversationTurn[];
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

/** Fixed text-processing invocation using the user's Claude Code login with model-requested tools disabled. */
export async function runClaudeCodeText(options: ClaudeTextOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? MAX_CLAUDE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_CLAUDE_TIMEOUT_MS) {
    throw new ClaudeTextError("UNAVAILABLE");
  }
  try {
    const model = cliTextModelSchema.parse(options.model ?? "");
    const reasoningEffort = options.reasoning_effort === undefined ? undefined : textReasoningEffortSchema.parse(options.reasoning_effort);
    const input = buildTextPrompt(options.instruction, options.text, options.context);
    const stdout = await runTextCliProcess({ executable: options.executable,
      args: ["--print", ...(reasoningEffort ? ["--effort", reasoningEffort] : []), ...(model ? ["--model", model] : []),
        "--safe-mode", "--tools", "", "--no-session-persistence",
        "--input-format", "text", "--output-format", "json", "--permission-prompts", "none"],
      input, signal: options.signal, timeoutMs });
    const envelope: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
    return localProcessingOutputSchema.parse(claudeResultSchema.parse(envelope).result);
  } catch (error: unknown) {
    if (error instanceof ClaudeTextError) throw error;
    if (error instanceof TextCliProcessError) throw new ClaudeTextError(error.code);
    if (error instanceof TextPromptError || options.signal.aborted) throw new ClaudeTextError("INVALID_RESPONSE");
    throw new ClaudeTextError("INVALID_RESPONSE");
  }
}

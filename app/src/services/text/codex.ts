import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { localProcessingOutputSchema, MAX_LOCAL_PROCESSING_RESPONSE_BYTES } from "../../contracts/speech/local-processing.js";
import { cliTextModelSchema } from "../../contracts/text/connections.js";
import { buildTextPrompt, TextPromptError, type TextConversationTurn } from "./text-prompt.js";
import { MAX_TEXT_CLI_STDOUT_BYTES, runTextCliProcess, TextCliProcessError } from "./text-cli-process.js";

const MAX_CODEX_TIMEOUT_MS = 120_000;
const CAPABILITY_PROBE_TIMEOUT_MS = 4_000;
const CODEX_HELP_MAX_BYTES = 96 * 1024;
const codexEventSchema = z.record(z.string(), z.unknown());

export type CodexTextFailureCode = "UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "FAILED" | "INVALID_RESPONSE";
export class CodexTextError extends Error {
  constructor(readonly code: CodexTextFailureCode) { super(code); this.name = "CodexTextError"; }
}

export interface CodexTextOptions {
  readonly executable: string;
  readonly instruction: string;
  readonly text: string;
  readonly model?: string;
  readonly context?: readonly TextConversationTurn[];
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Accept only a completed Codex turn and its final assistant answer, never commentary or progress text. */
export function parseCodexJsonl(input: Buffer | string): string {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_CLI_STDOUT_BYTES) throw new CodexTextError("INVALID_RESPONSE");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.some((line) => line.trim().length === 0)) throw new CodexTextError("INVALID_RESPONSE");
  let completed = false, finalMessage: string | undefined;
  const unphasedMessages: string[] = [];
  try {
    for (const line of lines) {
      const event: unknown = JSON.parse(line);
      const parsed = codexEventSchema.parse(event);
      const type = parsed["type"];
      if (typeof type !== "string" || completed) throw new CodexTextError("INVALID_RESPONSE");
      if (type === "error" || type === "turn.failed" || type === "turn.cancelled" || type === "turn.interrupted" ||
          type === "item.failed" || type.endsWith(".failed")) throw new CodexTextError("FAILED");
      if (type === "turn.completed") {
        if (parsed["status"] !== undefined && parsed["status"] !== "completed") throw new CodexTextError("FAILED");
        const turn = parsed["turn"];
        if (isRecord(turn) && turn["status"] !== undefined && turn["status"] !== "completed") throw new CodexTextError("FAILED");
        completed = true;
        continue;
      }
      if (type !== "item.completed") continue;
      const item = parsed["item"];
      if (!isRecord(item) || item["type"] !== "agent_message") continue;
      if (typeof item["text"] !== "string") throw new CodexTextError("INVALID_RESPONSE");
      const phase = parsed["phase"] ?? item["phase"];
      if (phase === "final_answer") finalMessage = item["text"];
      else if (phase === undefined) unphasedMessages.push(item["text"]);
    }
  } catch (error: unknown) {
    if (error instanceof CodexTextError) throw error;
    throw new CodexTextError("INVALID_RESPONSE");
  }
  if (!completed) throw new CodexTextError("INVALID_RESPONSE");
  if (finalMessage === undefined && unphasedMessages.length === 1) finalMessage = unphasedMessages[0];
  if (finalMessage === undefined) throw new CodexTextError("INVALID_RESPONSE");
  try { return localProcessingOutputSchema.parse(finalMessage); }
  catch { throw new CodexTextError("INVALID_RESPONSE"); }
}

function supportsFlag(help: string, flag: string): boolean {
  return help.split(/[\s,\[\]()<>=]+/u).includes(flag);
}

/** Probe only fixed help commands; configured Codex model/login are never read or overridden. */
export async function checkCodexTextCapabilities(executable: string): Promise<boolean> {
  if (!isAbsolute(executable)) return false;
  const signal = new AbortController().signal;
  try {
    const probes = await Promise.allSettled([
      runTextCliProcess({ executable, args: ["--help"], input: "", signal,
        timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS, maxStdoutBytes: CODEX_HELP_MAX_BYTES }),
      runTextCliProcess({ executable, args: ["exec", "--help"], input: "", signal,
        timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS, maxStdoutBytes: CODEX_HELP_MAX_BYTES }),
    ]);
    if (probes.some((probe) => probe.status !== "fulfilled")) return false;
    const globalOutput = probes[0].status === "fulfilled" ? probes[0].value : Buffer.alloc(0);
    const execOutput = probes[1].status === "fulfilled" ? probes[1].value : Buffer.alloc(0);
    const globalHelp = new TextDecoder("utf-8", { fatal: true }).decode(globalOutput);
    const execHelp = new TextDecoder("utf-8", { fatal: true }).decode(execOutput);
    return supportsFlag(globalHelp, "-a") && supportsFlag(execHelp, "--json") && supportsFlag(execHelp, "--sandbox") &&
      supportsFlag(execHelp, "--skip-git-repo-check") && supportsFlag(execHelp, "--ephemeral") &&
      supportsFlag(execHelp, "--model") && (supportsFlag(execHelp, "--color") || supportsFlag(globalHelp, "--color"));
  } catch (error: unknown) {
    if (error instanceof TextCliProcessError || error instanceof TypeError) return false;
    return false;
  }
}

/** Text-only, read-only Codex CLI invocation using its configured login and model. */
export async function runCodexText(options: CodexTextOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? MAX_CODEX_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_CODEX_TIMEOUT_MS) {
    throw new CodexTextError("UNAVAILABLE");
  }
  try {
    const model = cliTextModelSchema.parse(options.model ?? "");
    const input = buildTextPrompt(options.instruction, options.text, options.context);
    const stdout = await runTextCliProcess({ executable: options.executable,
      args: ["-a", "never", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--json", "--color", "never",
        ...(model ? ["--model", model] : []), "-"],
      input, signal: options.signal, timeoutMs, maxStdoutBytes: MAX_LOCAL_PROCESSING_RESPONSE_BYTES });
    return parseCodexJsonl(stdout);
  } catch (error: unknown) {
    if (error instanceof CodexTextError) throw error;
    if (error instanceof TextCliProcessError) throw new CodexTextError(error.code);
    if (error instanceof TextPromptError || options.signal.aborted) throw new CodexTextError("INVALID_RESPONSE");
    throw new CodexTextError("INVALID_RESPONSE");
  }
}

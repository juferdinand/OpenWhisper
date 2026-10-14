import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { isAbsolute } from "node:path";
import { localProcessingOutputSchema } from "../../contracts/speech/local-processing.js";
import { customCliConnectionSchema, type CustomCliConnection } from "../../contracts/text/connections.js";
import { buildTextPrompt, TextPromptError, type TextConversationTurn } from "./text-prompt.js";
import { runTextCliProcess, TextCliProcessError } from "./text-cli-process.js";

const MAX_CUSTOM_ARGUMENT_BYTES = 120 * 1024;
const MAX_CUSTOM_ARGUMENTS_BYTES = 384 * 1024;
const MAX_CUSTOM_TIMEOUT_MS = 120_000;
const CUSTOM_CLI_TEST_TIMEOUT_MS = 15_000;

export type CustomCliTextFailureCode = "UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "FAILED" | "INVALID_RESPONSE";
export class CustomCliTextError extends Error {
  constructor(readonly code: CustomCliTextFailureCode) { super(code); this.name = "CustomCliTextError"; }
}

export interface CustomCliTextOptions {
  readonly executable: string;
  readonly connection: CustomCliConnection;
  readonly instruction: string;
  readonly text: string;
  readonly context?: readonly TextConversationTurn[];
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

function substitute(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(prompt|instruction|text)\}/gu, (_match, key: string) => values[key] ?? "");
}

function responseAtPath(value: unknown, path: string): string {
  if (path.length === 0 || path.length > 512) throw new CustomCliTextError("INVALID_RESPONSE");
  let current = value;
  for (const part of path.split(".")) {
    if (part.length === 0 || part === "__proto__" || part === "prototype" || part === "constructor" ||
        current === null || typeof current !== "object" || !Object.hasOwn(current, part)) {
      throw new CustomCliTextError("INVALID_RESPONSE");
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "string") throw new CustomCliTextError("INVALID_RESPONSE");
  try { return localProcessingOutputSchema.parse(current); }
  catch { throw new CustomCliTextError("INVALID_RESPONSE"); }
}

/** Execute a user-configured argv without a shell; template replacements remain literal data. */
export async function runCustomCliText(options: CustomCliTextOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? MAX_CUSTOM_TIMEOUT_MS;
  if (!isAbsolute(options.executable) || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_CUSTOM_TIMEOUT_MS) {
    throw new CustomCliTextError("UNAVAILABLE");
  }
  try {
    const connection = customCliConnectionSchema.parse(options.connection);
    const prompt = buildTextPrompt(options.instruction, options.text, options.context);
    const templates = [...connection.args, connection.stdin];
    if (!templates.some((template) => /\{(?:prompt|instruction|text)\}/u.test(template)) ||
        options.context !== undefined && !templates.some((template) => template.includes("{prompt}")) ||
        connection.output === "json" && connection.responsePath.length === 0 ||
        connection.output === "text" && connection.responsePath.length > 0) throw new CustomCliTextError("INVALID_RESPONSE");
    const values = { prompt, instruction: options.instruction, text: options.text };
    const args = connection.args.map((argument) => substitute(argument, values));
    const input = substitute(connection.stdin, values);
    let argumentBytes = 0;
    for (const argument of args) {
      const bytes = Buffer.byteLength(argument, "utf8");
      if (bytes > MAX_CUSTOM_ARGUMENT_BYTES || (argumentBytes += bytes) > MAX_CUSTOM_ARGUMENTS_BYTES) {
        throw new CustomCliTextError("INVALID_RESPONSE");
      }
    }
    const stdout = await runTextCliProcess({ executable: options.executable, args, input,
      signal: options.signal, timeoutMs });
    if (connection.output === "text") {
      try { return localProcessingOutputSchema.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)); }
      catch { throw new CustomCliTextError("INVALID_RESPONSE"); }
    }
    let response: unknown;
    try { response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)); }
    catch { throw new CustomCliTextError("INVALID_RESPONSE"); }
    return responseAtPath(response, connection.responsePath);
  } catch (error: unknown) {
    if (error instanceof CustomCliTextError) throw error;
    if (error instanceof TextCliProcessError) throw new CustomCliTextError(error.code);
    if (error instanceof TextPromptError || options.signal.aborted) throw new CustomCliTextError("INVALID_RESPONSE");
    throw new CustomCliTextError("INVALID_RESPONSE");
  }
}

/** Run a user-requested smoke test with synthetic text and report only its elapsed time. */
export async function testCustomCliConnection(options: {
  readonly executable: string;
  readonly connection: CustomCliConnection;
  readonly signal: AbortSignal;
}): Promise<number> {
  const started = performance.now();
  await runCustomCliText({
    ...options,
    instruction: "Return a short confirmation that this connection works.",
    text: "OpenWhisper CLI connection test.",
    timeoutMs: CUSTOM_CLI_TEST_TIMEOUT_MS,
  });
  return Math.max(0, Math.min(CUSTOM_CLI_TEST_TIMEOUT_MS, Math.round(performance.now() - started)));
}

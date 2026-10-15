import { Buffer } from "node:buffer";
import { z } from "zod";
import { localProcessingOutputSchema, MAX_LOCAL_PROCESSING_RESPONSE_BYTES } from "../../contracts/speech/local-processing.js";
import { cliTextModelSchema, textReasoningEffortSchema } from "../../contracts/text/connections.js";
import { CodexTextError, runCodexText, type CodexTextOptions } from "./codex.js";
import { buildTextPrompt, TextPromptError } from "./text-prompt.js";
import { MAX_TEXT_CLI_STDIN_BYTES, runTextCliProcess, TextCliProcessError, type TextCliDialogueControl } from "./text-cli-process.js";

const identifier = z.string().min(1).max(256);
const record = z.record(z.string(), z.unknown());
const threadReply = z.object({
  thread: z.object({ id: identifier, ephemeral: z.literal(true) }),
  model: cliTextModelSchema,
  approvalPolicy: z.literal("never"),
  sandbox: z.object({ type: z.literal("readOnly") }),
  reasoningEffort: textReasoningEffortSchema.nullable().optional(),
});
const turnOwner = z.object({ threadId: identifier, turnId: identifier });
const completedTurn = z.object({ threadId: identifier,
  turn: z.object({ id: identifier, status: z.literal("completed"), error: z.null().optional() }) });
const completedItem = turnOwner.extend({ item: record });

type CodexProfile = Pick<CodexTextOptions, "executable" | "model" | "reasoning_effort">;
type CodexInput = Pick<CodexTextOptions, "instruction" | "text" | "signal">;
export interface PreparedCodexText {
  /** Undefined means no turn was attempted; the ordinary CLI path can still be used. */
  run(input: CodexInput): Promise<string | undefined>;
  close(): Promise<void>;
}

function failure(error: unknown): CodexTextError {
  if (error instanceof CodexTextError) return error;
  if (error instanceof TextCliProcessError) return new CodexTextError(error.code);
  return new CodexTextError("INVALID_RESPONSE");
}

/** Starts no model turn. A fresh ephemeral thread owns exactly one later full-text revision. */
export async function prepareCodexText(profile: CodexProfile, signal: AbortSignal): Promise<PreparedCodexText> {
  let model: string, effort: z.infer<typeof textReasoningEffortSchema> | undefined;
  try {
    model = cliTextModelSchema.parse(profile.model ?? "");
    effort = profile.reasoning_effort === undefined ? undefined : textReasoningEffortSchema.parse(profile.reasoning_effort);
  } catch { throw new CodexTextError("INVALID_RESPONSE"); }
  const controller = new AbortController();
  let control: TextCliDialogueControl | undefined;
  let state: "initialize" | "thread" | "idle" | "running" | "complete" = "initialize";
  let threadId = "", turnId: string | undefined, used = false, alive = true;
  let result: string | undefined;
  const messages: Array<{ text: string; phase: unknown }> = [];
  let acceptReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((accept, reject) => { acceptReady = accept; rejectReady = reject; });
  const matchTurn = (id: string): void => {
    if (turnId !== undefined && turnId !== id) throw new CodexTextError("INVALID_RESPONSE");
    turnId = id;
  };
  const initial = JSON.stringify({ id: 1, method: "initialize", params: {
    clientInfo: { name: "openwhisper", title: "OpenWhisper", version: "0" },
    capabilities: { experimentalApi: false, optOutNotificationMethods: [
      "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded",
    ] },
  } }) + "\n";
  let sentBytes = Buffer.byteLength(initial);
  const lifetime = runTextCliProcess({ executable: profile.executable,
    args: ["app-server", "--listen", "stdio://", ...(effort ? ["--config", `model_reasoning_effort="${effort}"`] : [])],
    input: initial, signal: AbortSignal.any([signal, controller.signal]),
    timeoutMs: 120_000, startupTimeoutMs: 8_000, idleTimeoutMs: 30 * 60_000,
    maxStdoutBytes: 8 * 1024 * 1024, maxLineBytes: MAX_LOCAL_PROCESSING_RESPONSE_BYTES, collectStdout: false,
    keepStdinOpen: true, onControl: (value) => { control = value; }, onLine: (line) => {
      const message = record.parse(JSON.parse(line));
      if (message["error"] !== undefined || message["method"] !== undefined && message["id"] !== undefined) {
        throw new CodexTextError("FAILED");
      }
      const id = message["id"];
      if (id !== undefined) {
        if (id === 1 && state === "initialize") {
          record.parse(message["result"]);
          state = "thread";
          const write = `${JSON.stringify({ method: "initialized" })}\n${JSON.stringify({ id: 2, method: "thread/start", params: {
            ephemeral: true, approvalPolicy: "never", sandbox: "read-only", ...(model ? { model } : {}),
          } })}\n`;
          sentBytes += Buffer.byteLength(write);
          return { write };
        }
        if (id === 2 && state === "thread") {
          const reply = threadReply.parse(message["result"]);
          if (model && reply.model !== model || effort && reply.reasoningEffort !== effort) throw new CodexTextError("INVALID_RESPONSE");
          threadId = reply.thread.id;
          state = "idle"; control!.waitForInput(); acceptReady(); return undefined;
        }
        if (id === 3 && (state === "running" || state === "complete")) {
          const reply = z.object({ turn: z.object({ id: identifier }) }).parse(message["result"]);
          matchTurn(reply.turn.id); return undefined;
        }
        throw new CodexTextError("INVALID_RESPONSE");
      }
      const method = message["method"];
      if (typeof method !== "string") throw new CodexTextError("INVALID_RESPONSE");
      if (method === "error") throw new CodexTextError("FAILED");
      if (method === "turn/started" || method === "turn/completed" || method === "item/completed") {
        if (state !== "running") throw new CodexTextError("INVALID_RESPONSE");
        if (method === "turn/started") {
          const event = z.object({ threadId: identifier, turn: z.object({ id: identifier }) }).parse(message["params"]);
          if (event.threadId !== threadId) throw new CodexTextError("INVALID_RESPONSE");
          matchTurn(event.turn.id);
        } else if (method === "item/completed") {
          const event = completedItem.parse(message["params"]);
          if (event.threadId !== threadId) throw new CodexTextError("INVALID_RESPONSE");
          matchTurn(event.turnId);
          if (event.item["type"] === "agentMessage") {
            messages.push({ text: z.string().max(MAX_LOCAL_PROCESSING_RESPONSE_BYTES).parse(event.item["text"]), phase: event.item["phase"] });
            if (messages.length > 128) throw new CodexTextError("INVALID_RESPONSE");
          }
        } else {
          const event = completedTurn.parse(message["params"]);
          if (event.threadId !== threadId) throw new CodexTextError("INVALID_RESPONSE");
          matchTurn(event.turn.id);
          const finals = messages.filter((item) => item.phase === "final_answer");
          const unphased = messages.filter((item) => item.phase === undefined || item.phase === null);
          const answer = finals.length === 1 ? finals[0] : finals.length === 0 && unphased.length === 1 ? unphased[0] : undefined;
          result = localProcessingOutputSchema.parse(answer?.text);
          state = "complete"; control!.finishRequest(); return undefined;
        }
      }
      return undefined;
    },
  }).then(() => {
    if (state !== "complete" || result === undefined) throw new CodexTextError("INVALID_RESPONSE");
    return result;
  }).catch((error: unknown) => { const mapped = failure(error); rejectReady(mapped); throw mapped; })
    .finally(() => { alive = false; });
  // Standby failures are observed before a recording produces text or is cancelled.
  void lifetime.catch(() => {});
  await ready;
  return {
    run: async (input) => {
      if (used) throw new CodexTextError("UNAVAILABLE");
      used = true;
      const abort = (): void => { controller.abort(); };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        if (input.signal.aborted || signal.aborted) throw new CodexTextError("CANCELLED");
        if (!alive || state !== "idle") return undefined;
        const prompt = buildTextPrompt(input.instruction, input.text);
        const request = JSON.stringify({ id: 3, method: "turn/start", params: {
          threadId, input: [{ type: "text", text: prompt }], ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        } }) + "\n";
        if (sentBytes + Buffer.byteLength(request) > MAX_TEXT_CLI_STDIN_BYTES) return undefined;
        try { control!.beginRequest(); }
        catch { return undefined; }
        state = "running";
        // After this write is attempted, never send a second inference through the cold path.
        control!.write(request);
        return await lifetime;
      } catch (error: unknown) {
        controller.abort();
        throw error instanceof TextPromptError ? new CodexTextError("INVALID_RESPONSE") : failure(error);
      } finally { input.signal.removeEventListener("abort", abort); }
    },
    close: async () => { controller.abort(); await lifetime.catch(() => {}); },
  };
}

/** Keeps metadata-only preparation out of the foreground and retires every generation's owner. */
export class CodexTextPreparation {
  private current: { generation: number; key: string; controller: AbortController; ready?: PreparedCodexText } | undefined;
  private readonly owners = new Set<Promise<unknown>>();
  private readonly active = new Set<AbortController>();
  private closed = false;

  prepare(generation: number, profile: CodexProfile): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.retire();
    const owner = { generation, key: this.key(profile), controller: new AbortController() };
    this.current = owner;
    const task = prepareCodexText(profile, owner.controller.signal).then(async (ready) => {
      if (this.closed || this.current !== owner) await ready.close();
      else this.current.ready = ready;
    }).catch(() => {});
    this.track(task);
    return task;
  }

  async run(generation: number, options: CodexTextOptions): Promise<string> {
    if (this.closed || options.signal.aborted) throw new CodexTextError("CANCELLED");
    const owner = this.current?.generation === generation ? this.current : undefined;
    if (owner) this.current = undefined;
    const controller = new AbortController();
    this.active.add(controller);
    const input = { ...options, signal: AbortSignal.any([options.signal, controller.signal]) };
    const task = (async (): Promise<string> => {
      if (options.context !== undefined || options.timeoutMs !== undefined || !owner?.ready || owner.key !== this.key(options)) {
        owner?.controller.abort();
        if (owner?.ready) this.track(owner.ready.close());
        return runCodexText(input);
      }
      try {
        const result = await owner.ready.run(input);
        if (result !== undefined) return result;
        owner.controller.abort(); this.track(owner.ready.close());
        return runCodexText(input);
      } finally { this.track(owner.ready.close()); }
    })().finally(() => this.active.delete(controller));
    this.track(task); return task;
  }

  retire(): void {
    const owner = this.current; this.current = undefined;
    owner?.controller.abort();
    if (owner?.ready) this.track(owner.ready.close());
  }

  async close(): Promise<void> {
    this.closed = true; this.retire();
    for (const controller of this.active) controller.abort();
    await Promise.allSettled([...this.owners]);
  }

  private key(profile: CodexProfile): string { return JSON.stringify([profile.executable, profile.model ?? "", profile.reasoning_effort ?? ""]); }
  private track(task: Promise<unknown>): void {
    this.owners.add(task);
    void task.catch(() => {}).finally(() => this.owners.delete(task));
  }
}

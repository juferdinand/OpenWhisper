import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  defaultTextConnectionAvailability, idleTextConnectionProcessing,
  textConnectionAvailabilityListSchema, textConnectionsStateSchema, textConversationSchema,
  type ConversationTurn, type TextConnectionAvailability, type TextConnectionSettings, type TextConversation, type TextProvider,
} from "../../contracts/text/connections.js";
import type { TextProcessingStageEvent } from "../../contracts/text/processing.js";
import { compileTextRevisionPrompt } from "../../core/text/text-revision-prompt.js";
import { applyTextRevisionEdits, MIN_TEXT_REVISION_EDIT_BYTES } from "../../core/text/text-revision-edits.js";
import { LocalProcessingError } from "../speech/local-processing.js";
import { ensureTextProviderAvailability, safeAvailabilityFallback } from "./connections.js";

type TextConnection = TextConnectionSettings["connections"][number];
type ProcessingOwner = { readonly generation: number; readonly attempt: number; readonly signal: AbortSignal };
type ActiveProcessing = { readonly controller: AbortController; readonly owner: ProcessingOwner; readonly requestId: string; readonly provider: TextProvider };

export class TextProviderUnavailableError extends Error {
  constructor() { super("The selected text provider is unavailable."); this.name = "TextProviderUnavailableError"; }
}

type OptionalTextProcessingSnapshot = Pick<z.infer<typeof textConnectionsStateSchema>, "available" | "scanning" | "processing">;

export interface OptionalTextProcessingOptions {
  readonly settings: () => TextConnectionSettings;
  readonly scan: (settings: TextConnectionSettings) => Promise<unknown>;
  readonly runProvider: (connection: TextConnection, instruction: string, text: string, signal: AbortSignal,
    requestId: string, context?: readonly ConversationTurn[]) => Promise<string>;
  readonly warmProvider?: (connection: TextConnection, instruction: string) => void;
  readonly isShuttingDown: () => boolean;
  readonly onChange?: () => void;
  readonly onStage?: (event: TextProcessingStageEvent | null) => void;
}

/** Owns provider selection, availability refresh, cancellation and deterministic fallback policy. */
export class OptionalTextProcessing {
  private availability: TextConnectionAvailability[] = defaultTextConnectionAvailability();
  private scanning = false;
  private scanTask: Promise<void> | undefined;
  private scanSettingsKey: string | undefined;
  private processing = idleTextConnectionProcessing();
  private active: ActiveProcessing | undefined;
  private pendingConversationTurn: { readonly generation: number; readonly attempt: number; readonly turn: ConversationTurn } | undefined;
  private closed = false;

  constructor(private readonly options: OptionalTextProcessingOptions) {}

  snapshot(): OptionalTextProcessingSnapshot {
    return { available: [...this.availability], scanning: this.scanning, processing: this.processing };
  }

  get busy(): boolean { return this.active !== undefined; }

  async scanConnections(settings = this.options.settings()): Promise<void> {
    const key = JSON.stringify(settings.connections);
    if (this.scanTask) {
      const current = this.scanTask;
      if (this.scanSettingsKey === key) return current;
      await current;
      return this.scanConnections(settings);
    }
    this.scanning = true;
    this.scanSettingsKey = key;
    const task = Promise.resolve().then(async () => {
      try {
        this.availability = textConnectionAvailabilityListSchema.parse(await this.options.scan(settings));
      } catch { this.availability = safeAvailabilityFallback(); }
      finally {
        this.scanning = false;
        this.scanTask = undefined;
        this.scanSettingsKey = undefined;
        this.options.onChange?.();
      }
    });
    this.scanTask = task;
    this.options.onChange?.();
    return task;
  }

  resetStatus(): void {
    this.active?.controller.abort();
    this.active = undefined;
    this.pendingConversationTurn = undefined;
    this.processing = idleTextConnectionProcessing();
    this.options.onStage?.(null);
    this.options.onChange?.();
  }

  skipForStorageFailure(owner: ProcessingOwner): void {
    this.pendingConversationTurn = undefined;
    const selected = this.options.settings().connections.find((connection) => connection.enabled);
    if (selected) {
      this.processing = { status: "fallback", provider: selected.provider, reason: "failed" };
      this.emitStage(owner, "skipped");
    } else this.processing = idleTextConnectionProcessing();
    this.options.onChange?.();
  }

  /** Lets the selected model load while the user is still speaking; sends no dictated text. */
  prepare(): void {
    if (this.closed || this.options.isShuttingDown()) return;
    const settings = this.options.settings();
    const selected = settings.connections.find((connection) => connection.enabled);
    if (!selected) return;
    const instruction = settings.mode === "conversation" ? settings.conversationInstruction
      : settings.revision ? compileTextRevisionPrompt(settings.revision) : undefined;
    if (instruction !== undefined) this.options.warmProvider?.(selected, instruction);
  }

  async process(text: string, owner: ProcessingOwner, conversation?: TextConversation): Promise<string | undefined> {
    if (this.closed || this.options.isShuttingDown() || owner.signal.aborted) return undefined;
    const settings = this.options.settings();
    const conversationMode = settings.mode === "conversation";
    const selected = settings.connections.find((connection) => connection.enabled);
    if (!selected) {
      this.processing = idleTextConnectionProcessing();
      this.options.onChange?.();
      return text;
    }
    const editReply = !conversationMode && (selected.provider === "codex" || selected.provider === "claude_code") &&
      (text.length >= MIN_TEXT_REVISION_EDIT_BYTES || new TextEncoder().encode(text).byteLength >= MIN_TEXT_REVISION_EDIT_BYTES);
    const revisionInstruction = !conversationMode && settings.revision
      ? compileTextRevisionPrompt(settings.revision, editReply ? "edits" : "text") : undefined;
    if (!conversationMode && revisionInstruction === undefined) {
      this.active?.controller.abort();
      this.active = undefined;
      this.pendingConversationTurn = undefined;
      this.processing = idleTextConnectionProcessing();
      this.emitStage(owner, "skipped");
      this.options.onChange?.();
      return text;
    }

    this.active?.controller.abort();
    this.pendingConversationTurn = undefined;
    const active: ActiveProcessing = { controller: new AbortController(), owner, requestId: randomUUID(), provider: selected.provider };
    this.active = active;
    const signal = AbortSignal.any([owner.signal, active.controller.signal]);
    this.processing = { status: "processing", provider: selected.provider, reason: null };
    this.emitStage(owner, "progress");
    this.options.onChange?.();
    const turns = conversationMode ? conversation?.turns ?? [] : undefined;
    let availability = this.availability.find((entry) => entry.provider === selected.provider);
    try {
      if (!availability?.usable) {
        this.availability = await ensureTextProviderAvailability(selected.provider, this.availability, async () => {
          await this.scanConnections();
          return this.availability;
        });
        availability = this.availability.find((entry) => entry.provider === selected.provider);
      }
      if (this.parentCancelled(owner) || this.active !== active) return undefined;
      if (this.userCancelled(active)) return this.fallback(text, owner, selected.provider, "cancelled");
      if (!availability?.usable || (selected.provider === "ollama" || selected.provider === "lm_studio") &&
          (!selected.model || !availability.models.includes(selected.model))) {
        throw new TextProviderUnavailableError();
      }
      if (turns && !this.fitsConversation(conversation, selected.provider, { user: text, assistant: "pending" })) {
        return this.fallback(text, owner, selected.provider, "context_full");
      }
      const instruction = conversationMode ? settings.conversationInstruction : revisionInstruction!;
      const reply = await this.options.runProvider(selected, instruction, text, signal, active.requestId, turns);
      if (this.parentCancelled(owner) || this.active !== active) return undefined;
      if (this.userCancelled(active)) return this.fallback(text, owner, selected.provider, "cancelled");
      const result = editReply ? applyTextRevisionEdits(text, reply) : reply;
      if (turns && !this.fitsConversation(conversation, selected.provider, { user: text, assistant: result })) {
        return this.fallback(text, owner, selected.provider, "context_full");
      }
      this.processing = { status: "complete", provider: selected.provider, reason: null };
      if (turns) this.pendingConversationTurn = { generation: owner.generation, attempt: owner.attempt, turn: { user: text, assistant: result } };
      this.emitStage(owner, "completed", result);
      return result;
    } catch (error: unknown) {
      if (this.parentCancelled(owner) || this.active !== active) return undefined;
      if (this.userCancelled(active)) return this.fallback(text, owner, selected.provider, "cancelled");
      const timeoutWithoutReasoningControl = selected.provider === "lm_studio" &&
        availability?.models_without_reasoning_control?.includes(selected.model) === true &&
        error instanceof LocalProcessingError && error.code === "TIMEOUT";
      this.processing = { status: "fallback", provider: selected.provider,
        reason: timeoutWithoutReasoningControl ? "timeout_without_reasoning_control"
          : error instanceof TextProviderUnavailableError ? "unavailable" : "failed" };
      this.emitStage(owner, "skipped");
      return text;
    } finally {
      // An older request may settle after a newer request has taken ownership.
      // Only the request still recorded as active may clear status or stage state.
      if (this.active === active) {
        this.active = undefined;
        if (this.parentCancelled(owner)) {
          this.processing = idleTextConnectionProcessing();
          this.options.onStage?.(null);
        }
      }
      this.options.onChange?.();
    }
  }

  cancel(): void {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    this.fallback(undefined, active.owner, active.provider, "cancelled");
    this.options.onChange?.();
  }

  close(): void {
    this.closed = true;
    this.active?.controller.abort();
  }

  private parentCancelled(owner: ProcessingOwner): boolean {
    return this.closed || this.options.isShuttingDown() || owner.signal.aborted;
  }

  private userCancelled(active: ActiveProcessing): boolean {
    return active.controller.signal.aborted || this.active !== active;
  }

  takeAcceptedConversationTurn(generation: number, attempt: number): ConversationTurn | undefined {
    const pending = this.pendingConversationTurn;
    if (!pending || pending.generation !== generation || pending.attempt !== attempt) return undefined;
    this.pendingConversationTurn = undefined;
    return pending.turn;
  }

  discardConversationTurn(generation: number, attempt: number): void {
    if (this.pendingConversationTurn?.generation === generation && this.pendingConversationTurn.attempt === attempt) {
      this.pendingConversationTurn = undefined;
    }
  }

  private fitsConversation(conversation: TextConversation | undefined, provider: TextProvider, turn: ConversationTurn): boolean {
    return textConversationSchema.safeParse({ id: conversation?.id ?? "", provider, turns: [...(conversation?.turns ?? []), turn] }).success;
  }

  private fallback(text: string | undefined, owner: ProcessingOwner, provider: TextProvider,
    reason: "cancelled" | "context_full"): string | undefined {
    this.processing = { status: "fallback", provider, reason };
    this.emitStage(owner, "skipped");
    return text;
  }

  private emitStage(owner: ProcessingOwner, status: "progress" | "completed" | "skipped", text?: string): void {
    this.options.onStage?.({ generation: owner.generation, attempt: owner.attempt, stage: "model", status,
      ...(text === undefined ? {} : { text }) });
  }

  reportSnippetsStage(owner: ProcessingOwner, text: string): void {
    this.options.onStage?.({ generation: owner.generation, attempt: owner.attempt,
      stage: "snippets", status: "completed", text });
  }
}

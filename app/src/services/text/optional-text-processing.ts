import { randomUUID } from "node:crypto";
import {
  defaultTextConnectionAvailability, idleTextConnectionProcessing,
  textConnectionAvailabilityListSchema,
  type TextConnectionAvailability, type TextConnectionSettings, type TextProvider,
} from "../../contracts/text/connections.js";
import type { TextProcessingStageEvent } from "../../contracts/text/processing.js";
import { ensureTextProviderAvailability, safeAvailabilityFallback } from "./connections.js";

type TextConnection = TextConnectionSettings["connections"][number];
type ProcessingOwner = { readonly generation: number; readonly attempt: number; readonly signal: AbortSignal };
type ActiveProcessing = { readonly controller: AbortController; readonly owner: ProcessingOwner; readonly requestId: string; readonly provider: TextProvider };

export class TextProviderUnavailableError extends Error {
  constructor() { super("The selected text provider is unavailable."); this.name = "TextProviderUnavailableError"; }
}

export interface OptionalTextProcessingSnapshot {
  readonly availability: readonly TextConnectionAvailability[];
  readonly scanning: boolean;
  readonly processing: ReturnType<typeof idleTextConnectionProcessing>;
}

export interface OptionalTextProcessingOptions {
  readonly settings: () => TextConnectionSettings;
  readonly scan: () => Promise<unknown>;
  readonly runProvider: (connection: TextConnection, instruction: string, text: string, signal: AbortSignal,
    requestId: string) => Promise<string>;
  readonly isShuttingDown: () => boolean;
  readonly onChange?: () => void;
  readonly onStage?: (event: TextProcessingStageEvent | null) => void;
}

/** Owns provider selection, availability refresh, cancellation and deterministic fallback policy. */
export class OptionalTextProcessing {
  private availability: TextConnectionAvailability[] = defaultTextConnectionAvailability();
  private scanning = false;
  private scanTask: Promise<void> | undefined;
  private processing = idleTextConnectionProcessing();
  private active: ActiveProcessing | undefined;
  private closed = false;

  constructor(private readonly options: OptionalTextProcessingOptions) {}

  snapshot(): OptionalTextProcessingSnapshot {
    return { availability: [...this.availability], scanning: this.scanning, processing: this.processing };
  }

  get busy(): boolean { return this.active !== undefined; }

  async scanConnections(): Promise<void> {
    if (this.scanTask) return this.scanTask;
    this.scanning = true;
    const task = Promise.resolve().then(async () => {
      try {
        this.availability = textConnectionAvailabilityListSchema.parse(await this.options.scan());
      } catch { this.availability = safeAvailabilityFallback(); }
      finally {
        this.scanning = false;
        this.scanTask = undefined;
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
    this.processing = idleTextConnectionProcessing();
    this.options.onStage?.(null);
    this.options.onChange?.();
  }

  async process(text: string, owner: ProcessingOwner): Promise<string | undefined> {
    if (this.closed || this.options.isShuttingDown() || owner.signal.aborted) return undefined;
    const settings = this.options.settings();
    const selected = settings.connections.find((connection) => connection.enabled);
    if (!selected) {
      this.processing = idleTextConnectionProcessing();
      this.options.onChange?.();
      return text;
    }

    this.active?.controller.abort();
    const active: ActiveProcessing = { controller: new AbortController(), owner, requestId: randomUUID(), provider: selected.provider };
    this.active = active;
    const signal = AbortSignal.any([owner.signal, active.controller.signal]);
    this.processing = { status: "processing", provider: selected.provider, reason: null };
    this.emitStage(owner, "progress");
    this.options.onChange?.();
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
      if (!availability?.usable || selected.provider === "codex" ||
          (selected.provider === "ollama" || selected.provider === "lm_studio") &&
          (!selected.model || !availability.models.includes(selected.model))) {
        throw new TextProviderUnavailableError();
      }
      const result = await this.options.runProvider(selected, settings.instruction, text, signal, active.requestId);
      if (this.parentCancelled(owner) || this.active !== active) return undefined;
      if (this.userCancelled(active)) return this.fallback(text, owner, selected.provider, "cancelled");
      this.processing = { status: "complete", provider: selected.provider, reason: null };
      this.emitStage(owner, "completed", result);
      return result;
    } catch (error: unknown) {
      if (this.parentCancelled(owner) || this.active !== active) return undefined;
      if (this.userCancelled(active)) return this.fallback(text, owner, selected.provider, "cancelled");
      this.processing = { status: "fallback", provider: selected.provider,
        reason: error instanceof TextProviderUnavailableError ? "unavailable" : "failed" };
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

  private fallback(text: string | undefined, owner: ProcessingOwner, provider: TextProvider,
    reason: "cancelled"): string | undefined {
    this.processing = { status: "fallback", provider, reason };
    this.emitStage(owner, "skipped");
    return text;
  }

  private emitStage(owner: ProcessingOwner, status: "progress" | "completed" | "skipped", text?: string): void {
    this.options.onStage?.({ generation: owner.generation, attempt: owner.attempt, stage: "model", status,
      ...(text === undefined ? {} : { text }) });
  }
}

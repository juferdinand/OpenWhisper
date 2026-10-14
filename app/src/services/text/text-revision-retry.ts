import type { TextProvider } from "../../contracts/text/connections.js";
import type { Snippet } from "../../contracts/text/snippets.js";

export type TextRevisionRetryState =
  | { readonly status: "idle" }
  | { readonly status: "available" | "processing" | "failed"; readonly provider: TextProvider }
  | { readonly status: "complete"; readonly provider: TextProvider; readonly text: string };

export interface TextRevisionRetryContext {
  readonly generation: number;
  readonly attempt: number;
  readonly input: string;
  readonly snippets: readonly Snippet[];
  readonly provider: TextProvider;
  readonly settingsFingerprint: string;
}

/** Retains only the text-stage input and fences results by recording, settings and retry attempt. */
export class TextRevisionRetry {
  private retained: TextRevisionRetryContext | undefined;
  private state: TextRevisionRetryState = { status: "idle" };

  snapshot(): TextRevisionRetryState {
    return this.state;
  }

  offer(context: TextRevisionRetryContext): void {
    this.retained = { ...context, snippets: context.snippets.map((snippet) => ({ ...snippet })) };
    this.state = { status: "available", provider: context.provider };
  }

  matches(generation: number, settingsFingerprint: string): boolean {
    return this.retained?.generation === generation && this.retained.settingsFingerprint === settingsFingerprint;
  }

  begin(generation: number, settingsFingerprint: string): TextRevisionRetryContext | undefined {
    const retained = this.retained;
    if (!retained || !this.matches(generation, settingsFingerprint) ||
        (this.state.status !== "available" && this.state.status !== "failed") ||
        !Number.isSafeInteger(retained.attempt + 1)) {
      if (retained && !this.matches(generation, settingsFingerprint)) this.clear();
      return undefined;
    }
    this.retained = { ...retained, attempt: retained.attempt + 1 };
    this.state = { status: "processing", provider: retained.provider };
    return this.retained;
  }

  complete(generation: number, attempt: number, settingsFingerprint: string, text: string): boolean {
    const retained = this.retained;
    if (!retained || !this.matches(generation, settingsFingerprint) || retained.attempt !== attempt ||
        this.state.status !== "processing") return false;
    this.state = { status: "complete", provider: retained.provider, text };
    return true;
  }

  fail(generation: number, attempt: number, settingsFingerprint: string, cancelled = false): boolean {
    const retained = this.retained;
    if (!retained || !this.matches(generation, settingsFingerprint) || retained.attempt !== attempt ||
        this.state.status !== "processing") return false;
    this.state = { status: cancelled ? "available" : "failed", provider: retained.provider };
    return true;
  }

  result(generation: number, settingsFingerprint: string): string | undefined {
    if (this.state.status !== "complete" || !this.matches(generation, settingsFingerprint)) return undefined;
    return this.state.text;
  }

  clear(): void {
    this.retained = undefined;
    this.state = { status: "idle" };
  }
}

import type { DeliveryReceipt, WorkContext } from "../core/recording.js";

export interface ClipboardOutput {
  writeText(text: string): void | Promise<void>;
  readText(): string | Promise<string>;
  paste?(): Promise<boolean>;
}

/** A confirmed clipboard commit survives permission loss or an uncertain paste reply. */
export async function deliverClipboard(text: string, context: WorkContext, output: ClipboardOutput): Promise<DeliveryReceipt> {
  const ownership = { generation: context.generation, attempt: context.attempt };
  const failed = { ...ownership, outcome: "failed" as const, clipboardConfirmed: false as const };
  if (context.signal.aborted) return failed;
  try {
    await output.writeText(text);
    if (await output.readText() !== text) return failed;
  } catch { return failed; }
  // Clipboard is already committed. Cancellation and lost paste replies cannot
  // turn that into a failed/replayable delivery or cause a second paste.
  let accepted = false;
  if (!context.signal.aborted && output.paste) {
    try { accepted = await output.paste(); } catch { /* Keep the confirmed clipboard fallback. */ }
  }
  return { ...ownership, outcome: accepted ? "paste" : "clipboard", clipboardConfirmed: true };
}

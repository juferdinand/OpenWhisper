import { Buffer } from "node:buffer";
import { historyEntriesSchema, historyEntrySchema, MAX_HISTORY_ENTRIES, type HistoryEntry } from "../../contracts/ui/state.js";
import { PrivateStateStore } from "../settings/private-state.js";

const MAX_HISTORY_BYTES = 6 * 1024 * 1024;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

/** Stores only new, accepted dictations; old transcript-only arrays are not imported. */
export class DictationHistory {
  private constructor(private readonly state: PrivateStateStore<HistoryEntry[]>) {}

  static async open(path: string): Promise<DictationHistory> {
    const state = await PrivateStateStore.open(path, historyEntriesSchema, [], MAX_STORE_BYTES,
      { invalidContent: "preserve-and-default" });
    return new DictationHistory(state);
  }

  snapshot(): HistoryEntry[] { return this.state.snapshot(); }

  add(text: string, durationMs: number): Promise<HistoryEntry[]> {
    const entry = historyEntrySchema.parse({
      text,
      recorded_at: new Date().toISOString(),
      duration_ms: Math.floor(durationMs),
    });
    return this.state.update((current) => {
      const next = [entry, ...current].slice(0, MAX_HISTORY_ENTRIES);
      while (next.length > 1 && Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_HISTORY_BYTES) next.pop();
      return Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_STORE_BYTES ? current : next;
    });
  }

  clear(): Promise<HistoryEntry[]> { return this.state.update(() => []); }
}

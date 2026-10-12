import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { emptyTextConversation, textConnectionSettingsSchema, textConversationSchema,
  type ConversationTurn, type TextConnectionSettings, type TextConversation } from "../../contracts/text/connections.js";
import { PrivateStateStore } from "../settings/private-state.js";

const conversationStateSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), conversation: textConversationSchema });
type ConversationState = z.infer<typeof conversationStateSchema>;

export function textConversationFingerprint(input: unknown): string {
  const settings = textConnectionSettingsSchema.parse(input);
  const selected = settings.connections.find((connection) => connection.enabled);
  const identity = selected === undefined ? null : Object.fromEntries(Object.entries(selected)
    .filter(([key]) => key !== "name" && key !== "enabled"));
  return createHash("sha256").update(JSON.stringify({ selected: identity,
    instruction: settings.conversationInstruction })).digest("hex");
}

function freshConversation(settings: TextConnectionSettings): TextConversation {
  return { ...emptyTextConversation(), id: randomUUID(), provider: settings.connections.find((entry) => entry.enabled)?.provider ?? null };
}

/** Persists app-owned turns only after delivery has been accepted by the host. */
export class TextConversationStore {
  private constructor(private readonly state: PrivateStateStore<ConversationState>) {}

  static async open(path: string, settingsInput: unknown): Promise<TextConversationStore> {
    const settings = textConnectionSettingsSchema.parse(settingsInput);
    const fingerprint = textConversationFingerprint(settings);
    const state = await PrivateStateStore.open(path, conversationStateSchema,
      { fingerprint, conversation: freshConversation(settings) }, 1024 * 1024, { invalidContent: "preserve-and-default" });
    const store = new TextConversationStore(state);
    await store.syncSettings(settings);
    return store;
  }

  snapshot(): TextConversation { return this.state.snapshot().conversation; }

  snapshotFor(settingsInput: unknown): TextConversation | undefined {
    const state = this.state.snapshot();
    return state.fingerprint === textConversationFingerprint(settingsInput) ? state.conversation : undefined;
  }

  async syncSettings(settingsInput: unknown): Promise<void> {
    const settings = textConnectionSettingsSchema.parse(settingsInput);
    const fingerprint = textConversationFingerprint(settings);
    if (this.state.snapshot().fingerprint === fingerprint) return;
    await this.state.update(() => ({ fingerprint, conversation: freshConversation(settings) }));
  }

  async newConversation(settingsInput: unknown): Promise<TextConversation> {
    const settings = textConnectionSettingsSchema.parse(settingsInput);
    const fingerprint = textConversationFingerprint(settings);
    const result = await this.state.update(() => ({ fingerprint, conversation: freshConversation(settings) }));
    return result.conversation;
  }

  async commit(turn: ConversationTurn, settingsInput: unknown): Promise<TextConversation> {
    const settings = textConnectionSettingsSchema.parse(settingsInput);
    const fingerprint = textConversationFingerprint(settings);
    let committed: TextConversation | undefined;
    await this.state.update((current) => {
      if (current.fingerprint !== fingerprint) throw new Error("Conversation settings changed before delivery commit.");
      committed = textConversationSchema.parse({
        ...current.conversation,
        provider: settings.connections.find((entry) => entry.enabled)?.provider ?? null,
        turns: [...current.conversation.turns, turn],
      });
      return { fingerprint, conversation: committed };
    });
    if (!committed) throw new Error("Conversation turn was not committed.");
    return committed;
  }
}

import type { Snippet } from "../../contracts/ui/state.js";
import { cleanTranscript } from "./transcript-cleaner.js";
import { correctVocabulary, parseVocabulary } from "./vocabulary-corrector.js";

export type ExpansionSnippet = Pick<Snippet, "trigger" | "expansion" | "enabled">;
const alphanumeric = /^[\p{Alphabetic}\p{Number}]$/u;
const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pattern(trigger: string): RegExp | undefined {
  const words = trigger.split(/[\p{White_Space}\-]+/u).filter(Boolean).map(escapePattern);
  return words.length === 0 ? undefined : new RegExp(words.join("[\\p{White_Space}\\-]+"), "giu");
}

export function expandSnippets(text: string, snippets: readonly ExpansionSnippet[]): string {
  const active = snippets.filter((snippet) => snippet.enabled);
  const bare = text.replace(/^[\p{White_Space}\p{Punctuation}]+|[\p{White_Space}\p{Punctuation}]+$/gu, "");
  for (const snippet of active) {
    const regex = pattern(snippet.trigger);
    const match = regex?.exec(bare);
    if (match && match.index === 0 && match[0].length === bare.length) return snippet.expansion;
  }
  let result = text;
  for (const snippet of active) {
    const regex = pattern(snippet.trigger);
    if (!regex) continue;
    const original = result;
    // Match offsets are UTF-16 offsets; Unicode scalar boundaries are checked separately.
    result = original.replace(regex, (match: string, offset: number) => {
      // Two adjacent UTF-16 units include a supplementary scalar without scanning
      // the whole transcript again for each replacement.
      const before = Array.from(original.slice(Math.max(0, offset - 2), offset)).at(-1);
      const end = offset + match.length;
      const after = Array.from(original.slice(end, end + 2))[0];
      return (before !== undefined && alphanumeric.test(before)) ||
        (after !== undefined && alphanumeric.test(after)) ? match : snippet.expansion;
    });
  }
  return result;
}

/** The preserved delivery order is cleaner → vocabulary correction → snippets. */
export function processTranscript(text: string, vocabulary: string, snippets: readonly ExpansionSnippet[]): string {
  return expandSnippets(correctVocabulary(cleanTranscript(text), parseVocabulary(vocabulary)), snippets);
}

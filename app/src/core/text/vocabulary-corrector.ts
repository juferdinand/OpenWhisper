import { vocabularyMatchKey, type VocabEntry } from "../../contracts/ui/state.js";

const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;

/** Rust's deterministic NFKD/scalar-lowercase policy; compare keys only, never rewrite term text. */
export function normalizeVocabularyKey(text: string): string {
  return vocabularyMatchKey(text);
}

export function parseVocabulary(vocabulary: string): string[] {
  return vocabulary.split(/[,;\n\r]/u)
    .map((term) => term.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ""))
    .filter((term) => Array.from(normalizeVocabularyKey(term)).length >= 3);
}

export function vocabularyThreshold(length: number): number {
  return length < 5 ? 1 : length < 8 ? 0.84 : 0.8;
}

function entry<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Invalid vocabulary range.");
  return value;
}

export function vocabularySimilarity(left: string, right: string): number {
  const x = Array.from(left), y = Array.from(right);
  if (x.length === 0 || y.length === 0) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, index) => index);
  for (const [rowIndex, scalar] of x.entries()) {
    const current = [rowIndex + 1];
    for (const [column, other] of y.entries()) {
      current.push(Math.min(entry(previous, column + 1) + 1, entry(current, column) + 1,
        entry(previous, column) + (scalar === other ? 0 : 1)));
    }
    previous = current;
  }
  return 1 - entry(previous, y.length) / Math.max(x.length, y.length);
}

interface Word { readonly key: readonly string[]; readonly start: number; readonly end: number }
interface Match { readonly first: number; readonly last: number; readonly term: string; readonly score: number }
interface ExplicitAlias { readonly key: readonly string[]; readonly wordCount: number; readonly term: string }

function normalizeEntries(entries: readonly (string | VocabEntry)[]): VocabEntry[] {
  return entries.map((entry) => typeof entry === "string"
    ? { spelling: entry, misheard: [] }
    : entry);
}

function explicitAliases(entries: readonly VocabEntry[]): ExplicitAlias[] {
  const aliases: ExplicitAlias[] = [];
  for (const { spelling, misheard } of entries) {
    for (const alias of misheard) {
      const key = Array.from(normalizeVocabularyKey(alias));
      if (key.length === 0) continue;
      const wordCount = Math.max(1, Array.from(alias.matchAll(wordPattern)).length);
      aliases.push({ key, wordCount, term: spelling });
    }
  }
  return aliases;
}

function explicitMatches(words: readonly Word[], aliases: readonly ExplicitAlias[]): Match[] {
  const matches: Match[] = [];
  for (const alias of aliases) {
    for (let start = 0; start < words.length; start++) {
      let keyIndex = 0;
      const limit = Math.min(alias.wordCount, words.length - start);
      for (let length = 1; length <= limit; length++) {
        let matchesPrefix = true;
        for (const scalar of entry(words, start + length - 1).key) {
          if (alias.key[keyIndex] !== scalar) {
            matchesPrefix = false;
            break;
          }
          keyIndex++;
        }
        if (!matchesPrefix || keyIndex > alias.key.length) break;
        if (keyIndex === alias.key.length) {
          matches.push({ first: start, last: start + length - 1, term: alias.term, score: 2 });
          break;
        }
      }
    }
  }
  return matches;
}

function similarMatches(words: readonly Word[], entries: readonly VocabEntry[]): Match[] {
  const matches: Match[] = [];
  for (const { spelling: term, misheard } of entries) {
    if (misheard.length > 0) continue;
    const key = normalizeVocabularyKey(term);
    const threshold = vocabularyThreshold(Array.from(key).length);
    const termWordCount = Math.max(1, term.split(/[\p{White_Space}\-]+/u).filter(Boolean).length);
    const window = Math.min(3, termWordCount + 1);
    for (let start = 0; start < words.length; start++) {
      for (let length = 1; length <= Math.min(window, words.length - start); length++) {
        const candidate = words.slice(start, start + length).map((word) => word.key.join("")).join("");
        const score = vocabularySimilarity(candidate, key);
        if (score >= threshold) matches.push({ first: start, last: start + length - 1, term, score });
      }
    }
  }
  return matches;
}

export function correctVocabulary(text: string, input: readonly (string | VocabEntry)[]): string {
  if (input.length === 0) return text;
  const words: Word[] = Array.from(text.matchAll(wordPattern), (match) => ({
    key: Array.from(normalizeVocabularyKey(match[0])),
    start: match.index, end: match.index + match[0].length,
  }));
  if (words.length === 0) return text;
  const entries = normalizeEntries(input);
  const matches = [...explicitMatches(words, explicitAliases(entries)), ...similarMatches(words, entries)];
  // Stable sorting keeps the original term order when score and range length tie.
  matches.sort((left, right) => right.score - left.score ||
    (right.last - right.first) - (left.last - left.first));
  const used = new Set<number>();
  const chosen: Match[] = [];
  for (const match of matches) {
    let overlap = false;
    for (let index = match.first; index <= match.last; index++) if (used.has(index)) overlap = true;
    if (overlap) continue;
    chosen.push(match);
    for (let index = match.first; index <= match.last; index++) used.add(index);
  }
  let result = text;
  for (const match of chosen.sort((left, right) => right.first - left.first)) {
    const first = entry(words, match.first), last = entry(words, match.last);
    result = result.slice(0, first.start) + match.term + result.slice(last.end);
  }
  return result;
}

export function vocabularyPrompt(entries: readonly VocabEntry[]): string {
  return entries.map((entry) => entry.spelling).join(",");
}

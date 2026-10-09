// Port of both native TranscriptCleaner implementations. Unicode White_Space/Punctuation
// match Rust's character properties without ECMAScript trim's additional BOM removal.
const nonSpeech = /\[[^\]]*\]|\([^)]*(musik|music|applaus|applause|lacht|laughs|stille|silence|geräusch|noise)[^)]*\)|\*[^*]+\*/giu;
const hallucinations = /(Untertitel(ung)?[^.]*?(ZDF|Amara\.org|funk)[^.]*\.?)|(Subtitles by the Amara\.org community\.?)/giu;

export function cleanTranscript(raw: string): string {
  const text = raw.replace(nonSpeech, " ").replace(hallucinations, " ")
    .replace(/\p{White_Space}+/gu, " ").replace(/^ +| +$/gu, "");
  return /^[\p{Punctuation}\p{White_Space}]*$/u.test(text) ? "" : text;
}

export const TranscriptCleaner = Object.freeze({ clean: cleanTranscript });

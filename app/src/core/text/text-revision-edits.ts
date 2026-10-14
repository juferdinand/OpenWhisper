import { localProcessingOutputSchema, MAX_LOCAL_PROCESSING_TEXT_BYTES } from "../../contracts/speech/local-processing.js";
import { textRevisionEditsSchema } from "../../contracts/text/revision-edits.js";

// Short rewrites can be smaller than the edit envelope; retain their plain-text path.
export const MIN_TEXT_REVISION_EDIT_BYTES = 512;

export class TextRevisionEditsError extends Error {
  constructor() { super("The model returned invalid transcript edits."); this.name = "TextRevisionEditsError"; }
}

/** Apply an entire validated edit set atomically against the original, preserving every other byte. */
export function applyTextRevisionEdits(source: string, response: string): string {
  try {
    if (new TextEncoder().encode(response).byteLength > MAX_LOCAL_PROCESSING_TEXT_BYTES ||
        new TextEncoder().encode(source).byteLength > MAX_LOCAL_PROCESSING_TEXT_BYTES ||
        !localProcessingOutputSchema.safeParse(source).success) throw new TextRevisionEditsError();
    const edits = textRevisionEditsSchema.parse(JSON.parse(response));
    const ranges = edits.map(({ find, replace }) => {
      const start = source.indexOf(find);
      if (start < 0 || source.indexOf(find, start + 1) >= 0) throw new TextRevisionEditsError();
      return { start, end: start + find.length, replace };
    }).sort((left, right) => left.start - right.start);
    const parts: string[] = [];
    let cursor = 0;
    for (const range of ranges) {
      if (range.start < cursor) throw new TextRevisionEditsError();
      parts.push(source.slice(cursor, range.start), range.replace);
      cursor = range.end;
    }
    parts.push(source.slice(cursor));
    const result = parts.join("");
    if (new TextEncoder().encode(result).byteLength > MAX_LOCAL_PROCESSING_TEXT_BYTES ||
        !localProcessingOutputSchema.safeParse(result).success) throw new TextRevisionEditsError();
    return result;
  } catch { throw new TextRevisionEditsError(); }
}

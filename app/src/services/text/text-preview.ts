import { Buffer } from "node:buffer";

export function boundedTextPreview(value: string, maximumBytes: number): { readonly text: string; readonly omitted: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return { text: value, omitted: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = maximumBytes; length > maximumBytes - 4; length -= 1) {
    try { return { text: decoder.decode(bytes.subarray(0, length)), omitted: true }; }
    catch { /* Drop at most one partial UTF-8 scalar at the end of the preview. */ }
  }
  return { text: "", omitted: true };
}

import { z } from "zod";

const utf8 = (maximum: number) => z.string().max(maximum).refine(
  (value) => new TextEncoder().encode(value).byteLength <= maximum,
  { message: "Value exceeds the supported UTF-8 byte length" },
);

/** Shared snippet data used by settings, capture requests, and exact delivery snapshots. */
export const snippetSchema = z.strictObject({
  // Linux legacy snippets may have an empty generated ID; macOS persists empty drafts.
  id: utf8(128),
  trigger: utf8(128),
  expansion: utf8(8192),
  enabled: z.boolean(),
});
export type Snippet = z.infer<typeof snippetSchema>;

import { z } from "zod";
import { MAX_LOCAL_PROCESSING_TEXT_BYTES } from "../speech/local-processing.js";

const span = z.string().refine((value) => !/\p{Surrogate}/u.test(value) &&
  new TextEncoder().encode(value).byteLength <= MAX_LOCAL_PROCESSING_TEXT_BYTES);

/** A model proposes literal replacements; offsets and matching are owned by the application. */
export const textRevisionEditsSchema = z.array(z.strictObject({
  find: span.min(1),
  replace: span,
})).max(1024);

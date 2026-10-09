import { z } from "zod";

// Pinned whisper.cpp includes Cantonese's three-letter code alongside legacy two-letter codes.
// The selected model/engine still determines which requested language it can recognize.
export const speechLanguageSchema = z.string().regex(/^(?:auto|[a-z]{2}|yue)$/u);

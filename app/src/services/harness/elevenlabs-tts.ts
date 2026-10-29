import { Buffer } from "node:buffer";

export const DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const MAX_TTS_CHUNK_CHARACTERS = 4500;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type ElevenLabsTtsFailure = "TTS_AUTH_FAILED" | "TTS_RATE_LIMITED" | "TTS_VOICE_INVALID" |
  "TTS_NETWORK_FAILED" | "TTS_RESPONSE_INVALID" | "TTS_API_FAILED" | "TTS_CANCELLED";

export class ElevenLabsTtsError extends Error {
  constructor(readonly code: ElevenLabsTtsFailure) { super(code); this.name = "ElevenLabsTtsError"; }
}

export function splitSpeechText(input: string): string[] {
  const normalized = input
    .replace(/```[^\n]*\n[\s\S]*?```/gu, "A code block was omitted.")
    .replace(/```[\s\S]*$/gu, "A code block was omitted.")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let current = "";
  for (const word of normalized.split(" ")) {
    if (word.length > MAX_TTS_CHUNK_CHARACTERS) {
      if (current) { chunks.push(current); current = ""; }
      const characters = Array.from(word);
      for (let index = 0; index < characters.length; index += MAX_TTS_CHUNK_CHARACTERS) {
        chunks.push(characters.slice(index, index + MAX_TTS_CHUNK_CHARACTERS).join(""));
      }
      continue;
    }
    if (current && current.length + word.length + 1 > MAX_TTS_CHUNK_CHARACTERS) {
      chunks.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function synthesizeElevenLabsSpeech(text: string, voiceId: string, apiKey: string,
  signal: AbortSignal): Promise<Buffer> {
  let response: Response;
  try {
    const output = new URLSearchParams({ output_format: "mp3_44100_128" });
    response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?${output}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/mpeg", "xi-api-key": apiKey },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
      signal,
    });
  } catch {
    throw new ElevenLabsTtsError(signal.aborted ? "TTS_CANCELLED" : "TTS_NETWORK_FAILED");
  }

  if (response.status === 401 || response.status === 403) throw new ElevenLabsTtsError("TTS_AUTH_FAILED");
  if (response.status === 404 || response.status === 422) throw new ElevenLabsTtsError("TTS_VOICE_INVALID");
  if (response.status === 429) throw new ElevenLabsTtsError("TTS_RATE_LIMITED");
  if (!response.ok) throw new ElevenLabsTtsError("TTS_API_FAILED");
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio/")) {
    throw new ElevenLabsTtsError("TTS_RESPONSE_INVALID");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new ElevenLabsTtsError("TTS_RESPONSE_INVALID");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new ElevenLabsTtsError("TTS_CANCELLED");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length || total + value.length > MAX_AUDIO_BYTES) {
        void reader.cancel();
        throw new ElevenLabsTtsError("TTS_RESPONSE_INVALID");
      }
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch (error: unknown) {
    if (error instanceof ElevenLabsTtsError) throw error;
    throw new ElevenLabsTtsError(signal.aborted ? "TTS_CANCELLED" : "TTS_NETWORK_FAILED");
  }
  if (total === 0) throw new ElevenLabsTtsError("TTS_RESPONSE_INVALID");
  return Buffer.concat(chunks, total);
}

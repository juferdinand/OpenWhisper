import type { AppState } from "./state.js";

/** Content-free reason keys shared by the renderer, tray and shortcut notifications. */
export function recordingUnavailableTitle(state: Pick<AppState, "recording_unavailable_reason">): string {
  switch (state.recording_unavailable_reason) {
    case "permission": return "Microphone access is not allowed.";
    case "model": return "No speech model is installed or selected.";
    case "audio": return "No microphone is available. Check the selected microphone and audio service.";
    case "host": return "The recording service could not start. Restart OpenWhisper. Code: HOST_UNAVAILABLE.";
    default: return "Recording is unavailable. Check your settings and try again.";
  }
}

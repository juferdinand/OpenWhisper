import type { AudioQualityNotice } from "../../src/contracts/recording/audio-quality.js";
import { escapeHtml as esc } from "./escape-html";
import { t } from "./i18n";

const explanations: Record<AudioQualityNotice, string> = {
  very_quiet:
    "The recording is very quiet; recognition may be less accurate. Check the microphone level or distance.",
  clipping:
    "The recording may be clipped and recognition less accurate. Lower the microphone level.",
  background_noise:
    "Strong noise in this recording may reduce recognition accuracy. Try a quieter place or another microphone.",
  limited_bandwidth:
    "The recording appears to have a limited frequency range; recognition may be less accurate. Try another microphone.",
};

export function audioQualityMarkup(reason: AudioQualityNotice): string {
  return `<aside class="audio-quality-notice" role="status" aria-live="polite" aria-label="${esc(t("Check audio quality"))}"><div><p>${esc(t(explanations[reason]))}</p><button type="button" data-settings-view="recording" data-settings-section="settings-recording-microphone">${esc(t("Microphone settings"))}</button></div><button type="button" id="dismiss-audio-quality" class="audio-quality-dismiss" aria-label="${esc(t("Dismiss audio hint"))}">×</button></aside>`;
}
